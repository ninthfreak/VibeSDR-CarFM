// KiwiAdapter — native KiwiSDR backend (v3b3). Two WebSockets to
// ws(s)://host:port/ws/kiwi/<ts>/{SND,W/F}. Mirrors the shipped OWRX approach:
// everything (control, waterfall, audio decode) lives in TS, and decoded PCM is
// pushed to the native player via pushExternalPcm so background audio works the
// same as OWRX. No native Kiwi engine, no Kiwi server-side extensions (deferred —
// VibeSDR has its own decoders).
//
// Protocol distilled from the reference KiwiSDR web client (openwebrx.js /
// audio.js / kiwi_util.js) + v3 brief §4–5:
//  - Control plane: space-separated `SET key=val …` text commands.
//  - SND frame:  [0..2]="SND" [3]=flags [4..7]=seq LE [8..9]=smeter u16 BE
//                payload @10 (mono): IMA-ADPCM (kiwi) if COMPRESSED else s16 BE.
//                dBm = smeter/10 − 127.
//  - W/F frame:  4-byte tag, u32[1]=x_bin, u32[2]=(zoom&0xffff)|(flags<<16),
//                u32[3]=seq, bins (u8) @16; ADPCM (kiwi) if COMPRESSED then drop
//                first 10. Relative level → frameSink auto-ranges.
//  - Server-side zoom 0..14: span = 30 MHz / 2^z, centred on cf (kHz).
//  - Keepalive: `SET keepalive` ~1 Hz on BOTH sockets or the server kicks us.

import type { SDRMode, SDRStatus } from './UberSDRClient';
import type {
  SDRBackend, BackendCallbacks, BackendCapabilities, BackendKind,
} from './SDRBackend';
import { NativeModules } from 'react-native';
import { ImaAdpcmDecoder, decodeKiwiWaterfallFrame } from './imaAdpcm';

const Vibe = NativeModules.VibePowerModule as {
  startExternalAudio?: (rate: number) => void;
  pushExternalPcm?: (b64: string, rate: number) => void;
  stopExternalAudio?: () => void;
} | undefined;

const KIWI_FULL_BW = 30_000_000;   // zoom 0 span (Hz) — Kiwi's nominal 0–30 MHz
const KIWI_MAX_ZOOM = 14;
const WF_BINS = 1024;              // Kiwi waterfall is a fixed 1024-bin row

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function bytesToBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const a0 = b[i], a1 = b[i + 1], a2 = b[i + 2];
    const e0 = a0 >> 2, e1 = ((a0 & 3) << 4) | (a1 >> 4);
    const e2 = i + 1 < b.length ? (((a1 & 15) << 2) | (a2 >> 6)) : 64;
    const e3 = i + 2 < b.length ? (a2 & 63) : 64;
    out += B64[e0] + B64[e1] + (e2 === 64 ? '=' : B64[e2]) + (e3 === 64 ? '=' : B64[e3]);
  }
  return out;
}

// SND flags (audio.js)
const SND_COMPRESSED    = 0x0010;
const SND_LITTLE_ENDIAN = 0x0080;
const SND_STEREO        = 0x0008;
// W/F flags (openwebrx.js `wf`)
const WF_COMPRESSED = 1;

/** Internal SDRMode → Kiwi wire mode + default passband (Hz). cwu/cwl ride cw. */
const KIWI_MODE: Record<SDRMode, { mod: string; lo: number; hi: number }> = {
  usb: { mod: 'usb',  lo:   300, hi:  2700 },
  lsb: { mod: 'lsb',  lo: -2700, hi:  -300 },
  am:  { mod: 'am',   lo: -4900, hi:  4900 },
  sam: { mod: 'sam',  lo: -4900, hi:  4900 },
  fm:  { mod: 'nbfm', lo: -6000, hi:  6000 },
  nfm: { mod: 'nbfm', lo: -6000, hi:  6000 },
  cwu: { mod: 'cw',   lo:   300, hi:   700 },
  cwl: { mod: 'cw',   lo:  -700, hi:  -300 },
};

const KIWI_CAPS: Omit<BackendCapabilities, 'freqRange'> = {
  profiles: false,
  serverSideZoom: true,
  smeter: 'header',
  zoomSteps: KIWI_MAX_ZOOM + 1,   // 0..14 → 15 discrete levels
  chat: false,
  serverNR: false,
  maxBandwidth: { default: 6000, am: 9800, sam: 9800, fm: 12000, nfm: 12000 },
};

export class KiwiAdapter implements SDRBackend {
  readonly kind: BackendKind = 'kiwi';
  readonly caps: BackendCapabilities = { ...KIWI_CAPS, freqRange: [0, KIWI_FULL_BW] };
  readonly uuid: string;

  private cb: BackendCallbacks;
  private wsBase: string;
  private password: string;
  private ts = Date.now();

  private sndWs: WebSocket | null = null;
  private wfWs: WebSocket | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;

  // RX / tuning state
  private rxBw = KIWI_FULL_BW;           // MSG bandwidth (usually 30 MHz)
  private trueAudioRate = 12000;         // MSG sample_rate (fractional)
  private freq = 9_600_000;              // tuned Hz
  private mode: SDRMode = 'am';
  private bwLow = -4900;
  private bwHigh = 4900;

  // View (server-side zoom)
  private viewCenter = KIWI_FULL_BW / 2;
  private viewBw = KIWI_FULL_BW;
  private viewInit = false;

  private audioStarted = false;
  private audioDec = new ImaAdpcmDecoder('kiwi', -32768, 32767);
  private started = false;
  private sndReady = false;
  private wfReady = false;

  constructor(baseUrl: string, uuid: string, callbacks: BackendCallbacks, password?: string) {
    this.uuid = uuid;
    this.cb = callbacks;
    this.password = password ?? '';
    this.wsBase = KiwiAdapter.toWsBase(baseUrl);
  }

  /** http(s)/ws(s)://host:port[/…] → ws(s)://host:port (no trailing path). */
  static toWsBase(baseUrl: string): string {
    let u = baseUrl.trim().replace(/\/+$/, '');
    if (u.startsWith('https://'))      u = 'wss://' + u.slice(8);
    else if (u.startsWith('http://'))  u = 'ws://'  + u.slice(7);
    else if (!/^wss?:\/\//.test(u))    u = 'ws://'  + u;
    return u.replace(/\/ws(\/.*)?$/, '');
  }

  private url(stream: 'SND' | 'W/F'): string {
    return `${this.wsBase}/ws/kiwi/${this.ts}/${stream}`;
  }

  // ── connect ────────────────────────────────────────────────────────────────
  connect(frequency?: number, mode?: SDRMode): Promise<void> {
    if (frequency) this.freq = frequency;
    if (mode) { this.mode = mode; const p = KIWI_MODE[mode]; this.bwLow = p.lo; this.bwHigh = p.hi; }
    this.started = true;
    this.viewInit = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const fail = (e: any) => { if (!settled) { settled = true; reject(e); } };

      try {
        this.sndWs = new WebSocket(this.url('SND'));
        this.wfWs  = new WebSocket(this.url('W/F'));
      } catch (e) { fail(e); return; }

      this.sndWs.binaryType = 'arraybuffer';
      this.wfWs.binaryType  = 'arraybuffer';

      // ── SND socket ──
      this.sndWs.onopen = () => {
        this.dbg('SND open');
        this.sndSend(`SET auth t=kiwi p=${this.password}`);
        this.sndSend('SERVER DE CLIENT vibesdr SND');
        // The reference client sends the RX params (which START the audio
        // stream) in its init right after auth — NOT gated on any later MSG.
        // A short tick lets the server process auth first.
        setTimeout(() => { if (this.started) this.sendRxParams(); }, 150);
      };
      this.sndWs.onmessage = (e) => {
        try {
          if (typeof e.data === 'string') this.onText(e.data, 'SND');
          else this.onSndBinary(new Uint8Array(e.data as ArrayBuffer));
        } catch (err: any) { this.dbg('SND msg err: ' + (err?.message ?? err)); }
      };
      this.sndWs.onerror = () => { this.dbg('SND error'); fail(new Error('KiwiSDR SND socket error')); };
      this.sndWs.onclose = () => { this.dbg('SND close'); this.onSocketDrop(); fail(new Error('KiwiSDR SND closed')); };

      // ── W/F socket ──
      this.wfWs.onopen = () => {
        this.dbg('WF open');
        this.wfSend(`SET auth t=kiwi p=${this.password}`);
        this.wfSend('SERVER DE CLIENT vibesdr W/F');
        this.wfSend('SET send_dB=1');
        this.wfSend('SET wf_comp=1');
        this.wfSend('SET wf_speed=4');
        this.wfSend('SET maxdb=-10 mindb=-110');
        this.sendZoom();              // initial full-span view
      };
      this.wfWs.onmessage = (e) => {
        try {
          if (typeof e.data === 'string') this.onText(e.data, 'W/F');
          else this.onWfBinary(new Uint8Array(e.data as ArrayBuffer));
        } catch (err: any) { this.dbg('WF msg err: ' + (err?.message ?? err)); }
      };
      this.wfWs.onerror = () => { this.dbg('WF error'); };
      this.wfWs.onclose = () => { this.dbg('WF close'); this.onSocketDrop(); };

      // Keepalive on BOTH sockets (Kiwi kicks idle clients).
      this.keepalive = setInterval(() => {
        this.sndSend('SET keepalive');
        this.wfSend('SET keepalive');
      }, 1000);

      // Resolve once audio params are away (we're effectively connected); guard
      // with a timeout so a silent server still rejects.
      const t = setTimeout(() => fail(new Error('KiwiSDR handshake timed out')), 12000);
      this._onConnected = () => { clearTimeout(t); this.cb.onConnect(); done(); };
    });
  }

  private _onConnected: (() => void) | null = null;

  // ── text (MSG) ───────────────────────────────────────────────────────────
  private onText(data: string, stream: 'SND' | 'W/F'): void {
    if (!data.startsWith('MSG')) return;            // CLI / other — ignore
    const body = data.slice(4);                     // skip "MSG "
    for (const tok of body.split(' ')) {
      const eq = tok.indexOf('=');
      if (eq < 0) continue;
      const key = tok.slice(0, eq), val = tok.slice(eq + 1);
      this.onMsg(key, val, stream);
    }
  }

  private onMsg(key: string, val: string, stream: 'SND' | 'W/F'): void {
    switch (key) {
      case 'audio_rate': {
        const r = parseInt(val, 10) || 12000;
        this.sndSend(`SET AR OK in=${r} out=44100`);
        // audio_rate is a server MSG → auth has been processed; (re)assert the
        // RX params here too so audio starts even if the 150 ms tick raced auth.
        if (stream === 'SND') this.sendRxParams();
        break;
      }
      case 'sample_rate': {
        const f = parseFloat(val);
        if (Number.isFinite(f) && f > 1000) this.trueAudioRate = f;
        break;
      }
      case 'bandwidth': {
        const bw = parseFloat(val);
        if (Number.isFinite(bw) && bw > 1000) {
          this.rxBw = bw;
          (this.caps as any).freqRange = [0, bw];
          if (!this.viewInit) { this.viewCenter = bw / 2; this.viewBw = bw; }
        }
        break;
      }
      case 'wf_setup':
        if (!this.wfReady) { this.wfReady = true; this.sendZoom(); }
        break;
      case 'audio_adpcm_state': {
        const [idx, prev] = val.split(',').map(Number);
        if (Number.isFinite(idx) && Number.isFinite(prev)) this.audioDec.setState(idx, prev);
        break;
      }
      case 'badp':
        this.cb.onError('KiwiSDR auth/slot error (badp=' + val + ')');
        break;
      case 'redirect':
        this.dbg('redirect ' + val);   // proxy.kiwisdr.com hop — TODO follow if needed
        break;
    }
  }

  /** Fire onConnect/resolve once, on the first real frame from either socket. */
  private maybeConnected(): void {
    if (this._onConnected) { const f = this._onConnected; this._onConnected = null; f(); }
  }

  /** Send the SND receive params once we know the true rate (per reference order). */
  private sendRxParams(): void {
    const m = KIWI_MODE[this.mode];
    this.sndSend(`SET mod=${m.mod} low_cut=${Math.round(this.bwLow)} high_cut=${Math.round(this.bwHigh)} freq=${(this.freq / 1000).toFixed(3)}`);
    this.sndSend('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
    this.sndSend('SET compression=1');
    this.sndSend('SET ident_user=VibeSDR');
    this.cb.onStatus(this.getStatus());
  }

  // ── audio (SND binary) ─────────────────────────────────────────────────────
  private onSndBinary(buf: Uint8Array): void {
    if (buf.length < 10 || buf[0] !== 0x53 /*S*/ || buf[1] !== 0x4e /*N*/ || buf[2] !== 0x44 /*D*/) return;
    const flags = buf[3];
    const smeter = (buf[8] << 8) | buf[9];                 // BE u16
    const dbm = smeter / 10 - 127;
    this.cb.onSMeter?.(dbm);
    this.cb.onLink?.(3);
    this.maybeConnected();

    const offset = (flags & SND_STEREO) ? 20 : 10;
    const payload = buf.subarray(offset);
    if (!payload.length) return;

    let pcm: Int16Array;
    if (flags & SND_COMPRESSED) {
      pcm = this.audioDec.decode(payload);                 // persistent kiwi-flavour state
    } else {
      const little = !!(flags & SND_LITTLE_ENDIAN);
      const n = payload.length >> 1;
      pcm = new Int16Array(n);
      const dv = new DataView(payload.buffer, payload.byteOffset, n * 2);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, little);   // network = BE by default
    }
    if (!pcm.length) return;

    const rate = Math.round(this.trueAudioRate);
    if (!this.audioStarted) { Vibe?.startExternalAudio?.(rate); this.audioStarted = true; }
    Vibe?.pushExternalPcm?.(bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), rate);
  }

  // ── waterfall (W/F binary) ─────────────────────────────────────────────────
  private onWfBinary(buf: Uint8Array): void {
    if (buf.length < 16) return;
    // bytes 0..3 = tag; u32[1..3] @ offset 4 = x_bin, zoom|flags, seq
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const zoomFlags = dv.getUint32(8, true);
    const wfFlags = (zoomFlags >> 16) & 0xffff;
    let bins = buf.subarray(16);
    if (wfFlags & WF_COMPRESSED) bins = decodeKiwiWaterfallFrame(bins);
    const n = bins.length;
    if (n < 8) return;

    // u8 → dBm (bin − 255); relative level, the UI auto-ranges absolute scale.
    const row = new Float32Array(n);
    for (let i = 0; i < n; i++) row[i] = bins[i] - 255;

    if (!this.viewInit) { this.viewInit = true; }
    this.maybeConnected();
    this.cb.onSpectrum(row, this.statusForRow(n));
  }

  // ── view / zoom ────────────────────────────────────────────────────────────
  private zoomLevel(): number {
    const z = Math.round(Math.log2(KIWI_FULL_BW / Math.max(1, this.viewBw)));
    return Math.min(Math.max(z, 0), KIWI_MAX_ZOOM);
  }

  /** Snap viewBw to the quantised zoom span and push `SET zoom=z cf=<kHz>`. */
  private sendZoom(): void {
    const z = this.zoomLevel();
    this.viewBw = KIWI_FULL_BW / Math.pow(2, z);          // authoritative snap
    const cfKHz = (this.viewCenter / 1000).toFixed(3);
    this.wfSend(`SET zoom=${z} cf=${cfKHz}`);
    this.cb.onStatus(this.getStatus());
  }

  // ── SDRBackend surface ───────────────────────────────────────────────────
  tune(frequency: number, mode?: SDRMode): void {
    this.freq = Math.min(Math.max(frequency, 0), this.rxBw);
    if (mode && mode !== this.mode) { this.setMode(mode); return; }
    this.sndSend(`SET freq=${(this.freq / 1000).toFixed(3)}`);
    this.cb.onStatus(this.getStatus());
  }

  syncFrequency(frequency: number, mode?: SDRMode): void {
    this.freq = Math.min(Math.max(frequency, 0), this.rxBw);
    if (mode) this.mode = mode;
    this.cb.onStatus(this.getStatus());
  }

  setMode(mode: SDRMode): void {
    this.mode = mode;
    const p = KIWI_MODE[mode];
    this.bwLow = p.lo; this.bwHigh = p.hi;
    this.sndSend(`SET mod=${p.mod} low_cut=${Math.round(this.bwLow)} high_cut=${Math.round(this.bwHigh)} freq=${(this.freq / 1000).toFixed(3)}`);
    this.cb.onStatus(this.getStatus());
  }

  setBandwidth(low: number, high: number): void {
    this.bwLow = low; this.bwHigh = high;
    const p = KIWI_MODE[this.mode];
    this.sndSend(`SET mod=${p.mod} low_cut=${Math.round(low)} high_cut=${Math.round(high)} freq=${(this.freq / 1000).toFixed(3)}`);
    this.cb.onStatus(this.getStatus());
  }

  zoom(frequency: number, binBandwidth: number): void {
    this.viewCenter = frequency;
    this.viewBw = Math.max(1, binBandwidth * WF_BINS);
    this.sendZoom();
  }

  pan(frequency: number): void {
    this.viewCenter = frequency;
    this.sendZoom();
  }

  resetView(): void {
    this.viewCenter = this.rxBw / 2;
    this.viewBw = this.rxBw;
    this.sendZoom();
  }

  setRate(_divisor: number): void { /* Kiwi waterfall speed is server-fixed (wf_speed) */ }
  pauseSpectrum(): void { this.wfSend('SET wf_speed=0'); }
  resumeSpectrum(): void { this.wfSend('SET wf_speed=4'); }

  getStatus(): SDRStatus {
    return this.statusForRow(this.viewInit ? WF_BINS : 0);
  }
  getView(): SDRStatus { return this.getStatus(); }

  private statusForRow(bins: number): SDRStatus {
    const bw = this.viewInit ? this.viewBw : this.rxBw;
    return {
      frequency: this.freq, mode: this.mode,
      bandwidthLow: this.bwLow, bandwidthHigh: this.bwHigh,
      binCount: bins, binBandwidth: bw / Math.max(1, bins || WF_BINS),
      centerHz: this.viewInit ? this.viewCenter : this.rxBw / 2,
      bwHz: bw,
    };
  }

  // ── teardown ────────────────────────────────────────────────────────────
  destroy(): void {
    this.started = false;
    this.stopKeepalive();
    if (this.audioStarted) { Vibe?.stopExternalAudio?.(); this.audioStarted = false; }
    this.closeSocket('sndWs');
    this.closeSocket('wfWs');
  }

  /** Pause-disconnect: drop the sockets but keep the native audio session. */
  disconnectSocket(): void {
    this.started = false;
    this.stopKeepalive();
    this.closeSocket('sndWs');
    this.closeSocket('wfWs');
  }

  private closeSocket(which: 'sndWs' | 'wfWs'): void {
    const ws = this[which]; this[which] = null;
    if (ws) { try { ws.onclose = null; ws.onerror = null; ws.close(); } catch {} }
  }

  private stopKeepalive(): void {
    if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
  }

  private onSocketDrop(): void {
    if (!this.started) return;        // our own close()
    this.started = false;
    this.cb.onLink?.(0);
    this.cb.onDisconnect();
    this.cb.onServerLost?.();
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private sndSend(s: string): void { try { if (this.sndWs?.readyState === WebSocket.OPEN) this.sndWs.send(s); } catch {} }
  private wfSend(s: string): void { try { if (this.wfWs?.readyState === WebSocket.OPEN) this.wfWs.send(s); } catch {} }
  private dbg(m: string): void { this.cb.onDbg?.('[kiwi] ' + m); }
}
