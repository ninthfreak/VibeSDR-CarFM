/**
 * OwrxAdapter — OpenWebRX / OpenWebRX+ behind the SDRBackend contract
 * (v3 brief §6). Single multiplexed WebSocket: JSON text control + binary FFT
 * (type 1) + binary audio (type 2/4). Verified against the OpenWebRX+ source in
 * reference/openwebrx-master (htdocs/openwebrx.js, lib/Demodulator.js).
 *
 * PHASE 2 MILESTONE 1 (this file): connect + handshake + config + waterfall, with
 * client-side view slicing, tune (offset within profile + auto profile-switch),
 * mode/bandwidth, profiles, and S-meter. AUDIO is intentionally NOT handled here —
 * per the brief the audio socket must move into the native engine so background
 * audio survives JS suspend (next phase). Type-2/4 frames are counted and ignored
 * for now; the waterfall is fully functional in TS.
 *
 * Architectural rule (brief §6.5): the FFT row always spans the WHOLE profile
 * (center_freq ± samp_rate/2). serverSideZoom=false → setView slices locally.
 */

import type { SDRMode, SDRStatus } from './UberSDRClient';
import type {
  SDRBackend, BackendCallbacks, BackendCapabilities, BackendKind, ProfileInfo,
} from './SDRBackend';
import { NativeModules } from 'react-native';
import { decodeOwrxFftFrame, OwrxAudioDecoder } from './imaAdpcm';

const Vibe = NativeModules.VibePowerModule as {
  startExternalAudio?: (rate: number) => void;
  pushExternalPcm?: (b64: string, rate: number) => void;
  stopExternalAudio?: () => void;
} | undefined;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Minimal Uint8Array → base64 (no dep; Hermes has no btoa). */
function bytesToBase64(b: Uint8Array): string {
  let out = '', i = 0;
  const n = b.length;
  for (; i + 2 < n; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  const rem = n - i;
  if (rem === 1) { const v = b[i] << 16; out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + '=='; }
  else if (rem === 2) { const v = (b[i] << 16) | (b[i + 1] << 8); out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='; }
  return out;
}

const OWRX_AUDIO_RATE = 12000;   // output_rate (type-2)
const OWRX_HD_RATE = 48000;      // hd_output_rate (type-4 — WFM/wide)

// Internal SDRMode → OWRX wire modulation. Gated on the server `modes` list at
// runtime; cwu/cwl collapse to 'cw' (offset convention handles the sideband).
const MODE_TO_WIRE: Record<SDRMode, string> = {
  usb: 'usb', lsb: 'lsb', am: 'am', sam: 'sam',
  fm: 'nfm', nfm: 'nfm', cwu: 'cw', cwl: 'cw',
};

const OWRX_CAPS: BackendCapabilities = {
  profiles:       true,
  serverSideZoom: false,    // FFT covers the whole profile; we slice client-side
  smeter:         'message',
  freqRange:      [0, 30_000_000],   // refined per profile from config
  chat:           false,
  serverNR:       false,
  // OWRX filters are wide for broadcast FM (server-controlled) and narrower for
  // SSB/CW; the UI clamps per mode. Generous default, WFM effectively server-side.
  maxBandwidth:   { default: 12000, fm: 96000, nfm: 12000 },
};

interface OwrxConfig {
  centerFreq: number;     // Hz, profile center
  sampRate: number;       // Hz, profile bandwidth (full FFT span)
  fftSize: number;
  fftCompression: 'none' | 'adpcm';
  audioCompression: 'none' | 'adpcm';
}

export class OwrxAdapter implements SDRBackend {
  readonly kind: BackendKind = 'owrx';
  // Per-instance copy so freqRange can be refined to the active profile window
  // (OWRX profiles are anywhere — HF to VHF/UHF — not the UberSDR 0–30 MHz range).
  readonly caps: BackendCapabilities = { ...OWRX_CAPS, freqRange: [0, 30_000_000] };
  readonly uuid: string;

  private ws: WebSocket | null = null;
  private cb: BackendCallbacks;
  private wsUrl: string;

  // server/profile state
  private cfg: OwrxConfig | null = null;
  private profiles: ProfileInfo[] = [];
  private modes: string[] | null = null;     // server-reported mode ids (gating)
  private serverModes: { id: string; name: string; digital: boolean; bandpass?: { low_cut: number; high_cut: number } }[] = [];
  private serverVersion = '';

  // tuned state (absolute Hz / internal model)
  private freq = 0;
  private mode: SDRMode = 'am';
  private bwLow = -4000;
  private bwHigh = 4000;

  // current view (client-side); defaults to whole profile on first config
  private viewCenter = 0;
  private viewBw = 0;
  private viewInit = false;

  // last full FFT row (full profile span) — re-sliced on local view changes
  private lastRow: Float32Array | null = null;

  private started = false;
  private audioStarted = false;
  private audioDec = new OwrxAudioDecoder();    // type-2 (output_rate, 12k)
  private hdAudioDec = new OwrxAudioDecoder();   // type-4 (hd_output_rate, 48k — WFM)

  constructor(baseUrl: string, uuid: string, callbacks: BackendCallbacks) {
    this.uuid = uuid;
    this.cb = callbacks;
    this.wsUrl = OwrxAdapter.toWsUrl(baseUrl);
  }

  /** http(s)://host:port[/path] → ws(s)://host:port/ws/ (trailing slash required;
   *  the StaticRoute is exactly "/ws/", a bare /ws 404s). */
  static toWsUrl(baseUrl: string): string {
    let u = baseUrl.trim().replace(/\/+$/, '');
    if (u.startsWith('https://'))      u = 'wss://' + u.slice('https://'.length);
    else if (u.startsWith('http://'))  u = 'ws://'  + u.slice('http://'.length);
    else if (!/^wss?:\/\//.test(u))    u = 'ws://'  + u;
    return u + '/ws/';
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  connect(frequency?: number, mode?: SDRMode): Promise<void> {
    if (frequency != null) this.freq = frequency;
    if (mode) this.mode = mode;
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try { ws = new WebSocket(this.wsUrl); }
      catch (e) { reject(e); return; }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        this.dbg('WS open ' + this.wsUrl);
        ws.send('SERVER DE CLIENT client=vibesdr type=receiver');
        // connectionproperties + start are sent on the CLIENT DE SERVER ack.
      };
      ws.onmessage = (e) => {
        try {
          if (typeof e.data === 'string') this.onText(e.data, () => { if (!settled) { settled = true; resolve(); } });
          else this.onBinary(new Uint8Array(e.data as ArrayBuffer));
        } catch (err: any) { this.dbg('msg err: ' + (err?.message ?? err)); }
      };
      ws.onerror = () => { this.dbg('WS error'); if (!settled) { settled = true; reject(new Error('OpenWebRX WebSocket error')); } };
      ws.onclose = (ev) => {
        this.dbg('WS close ' + ev.code);
        this.cb.onDisconnect();
        if (!settled) { settled = true; reject(new Error('OpenWebRX closed (' + ev.code + ')')); }
      };
    });
  }

  destroy(): void {
    this.started = false;
    if (this.audioStarted) { Vibe?.stopExternalAudio?.(); this.audioStarted = false; }
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  }

  // ── inbound: text/JSON ───────────────────────────────────────────────────
  private onText(data: string, onReady: () => void): void {
    if (data.startsWith('CLIENT DE SERVER')) {
      const params = Object.fromEntries(
        data.slice(17).split(' ').map((p) => { const a = p.split('='); return [a[0], a.slice(1).join('=')]; }),
      );
      this.serverVersion = params['version'] || '';
      this.dbg('server ack: ' + (params['server'] || '?') + ' ' + this.serverVersion);
      // Negotiate, then start the DSP.
      this.send({ type: 'connectionproperties', params: { output_rate: 12000, hd_output_rate: 48000 } });
      this.send({ type: 'dspcontrol', action: 'start' });
      this.cb.onConnect();
      onReady();
      return;
    }
    let json: any;
    try { json = JSON.parse(data); } catch { return; }
    switch (json.type) {
      case 'config':   this.onConfig(json.value || {}); break;
      case 'profiles': this.onProfiles(json.value || []); break;
      case 'modes': {
        const arr = (json.value || []) as any[];
        this.serverModes = arr.map((m) => ({
          id: m.modulation ?? m.id ?? String(m),
          name: m.name ?? String(m.modulation ?? m.id ?? m).toUpperCase(),
          digital: (m.type ?? 'analog') !== 'analog',
          bandpass: m.bandpass,
        }));
        this.modes = this.serverModes.map((m) => m.id);
        this.cb.onModes?.(this.serverModes.map((m) => ({ id: m.id, label: m.name, digital: m.digital })));
        // If the modes list lands after config (so the start_mod passband wasn't
        // known yet), apply it now and resend so the filter widens to match.
        if (this.started) {
          this.applyModeBandpass();
          this.sendDemod();
          this.cb.onStatus(this.getStatus());
        }
        break;
      }
      case 'smeter':   if (typeof json.value === 'number') this.cb.onSMeter?.(json.value); break;
      case 'sdr_error':
      case 'demodulator_error': this.cb.onError(String(json.value ?? 'OpenWebRX error')); break;
      case 'backoff': this.dbg('server backoff ' + json.value); break;
      default: this.dbg('unhandled msg type: ' + json.type);  // ignore-with-log = forward compat
    }
  }

  private onConfig(c: any): void {
    const profileSwitch = 'sdr_id' in c || 'profile_id' in c;
    if (!this.cfg) this.cfg = { centerFreq: 0, sampRate: 0, fftSize: 1024, fftCompression: 'none', audioCompression: 'none' };
    if ('center_freq' in c)       this.cfg.centerFreq = c.center_freq;
    if ('samp_rate' in c)         this.cfg.sampRate = c.samp_rate;
    if ('fft_size' in c)          this.cfg.fftSize = c.fft_size;
    if ('fft_compression' in c)   this.cfg.fftCompression = c.fft_compression;
    if ('audio_compression' in c) this.cfg.audioCompression = c.audio_compression;
    if ('start_mod' in c)         this.mode = (c.start_mod as SDRMode) || this.mode;
    if ('start_offset_freq' in c && this.cfg.centerFreq) this.freq = this.cfg.centerFreq + c.start_offset_freq;
    // Ensure we have a tuned frequency inside the profile before centring the view.
    if ((this.freq === 0 || Math.abs(this.freq - this.cfg.centerFreq) > this.cfg.sampRate / 2) && this.cfg.centerFreq) {
      this.freq = this.cfg.centerFreq;
    }

    // Centre the view on the VFO (a sensible default span), or re-centre on a switch.
    if (!this.viewInit || profileSwitch) {
      this.viewCenter = this.freq || this.cfg.centerFreq;
      this.viewBw = this.cfg.sampRate;
      this.viewInit = true;
      this.lastRow = null;   // clear stale waterfall on profile change
      if (profileSwitch) { this.audioDec.reset(); this.hdAudioDec.reset(); }   // ADPCM restarts per profile
    }

    // Refine the tunable range to the active profile window so the UI's clamps
    // (which read caps.freqRange) don't peg VHF/UHF tunes to a 30 MHz ceiling.
    if (this.cfg.sampRate) {
      this.caps.freqRange = [this.cfg.centerFreq - this.cfg.sampRate / 2, this.cfg.centerFreq + this.cfg.sampRate / 2];
      // Filter edge can be as wide as the profile IF allows — WFM (~±100 kHz),
      // DAB (~±0.8 MHz), ADSB (~±1 MHz) need far more than the UberSDR ±6 kHz.
      this.caps.maxBandwidth = { default: Math.max(6000, Math.floor(this.cfg.sampRate / 2)) };
    }
    this.dbg(`cfg cf=${this.cfg.centerFreq} sr=${this.cfg.sampRate} fft=${this.cfg.fftSize} freq=${this.freq} fftcomp=${this.cfg.fftCompression}`);
    // Profile's start_mod may be a wide mode (broadcast-FM profile → WFM): adopt
    // its server passband so the filter isn't stuck narrow until a manual re-tap.
    this.applyModeBandpass();
    // Send (or resend) the demod params now we know the profile window.
    this.started = true;
    this.sendDemod();
    this.cb.onStatus(this.getStatus());
  }

  private onProfiles(list: any[]): void {
    this.profiles = list.map((p) => ({ id: String(p.id ?? p), name: String(p.name ?? p.id ?? p) }));
    this.cb.onProfiles?.(this.profiles);
  }

  // ── inbound: binary frames ───────────────────────────────────────────────
  private onBinary(buf: Uint8Array): void {
    const type = buf[0];
    const payload = buf.subarray(1);
    switch (type) {
      case 1: this.onFft(payload); break;
      case 2: this.onAudio(payload, OWRX_AUDIO_RATE, this.audioDec); break;   // primary (12k)
      case 4: this.onAudio(payload, OWRX_HD_RATE, this.hdAudioDec); break;     // HD / WFM (48k)
      case 3: break;                                    // secondary FFT — ignored in v3
      default: this.dbg('unknown binary type ' + type);
    }
  }

  /** Decode an audio frame (ADPCM or raw s16 LE) and push the PCM to the native
   *  player at its rate. Foreground-first: socket+decode live here in JS, the
   *  native engine just plays — audio stops if JS suspends (native engine later).
   *  type-2 = output_rate (12k); type-4 = hd_output_rate (48k), used for WFM. */
  private onAudio(payload: Uint8Array, rate: number, dec: OwrxAudioDecoder): void {
    if (!this.audioStarted) { Vibe?.startExternalAudio?.(rate); this.audioStarted = true; }
    let pcm: Int16Array;
    if (this.cfg?.audioCompression === 'adpcm') {
      pcm = dec.decode(payload);
    } else {
      const m = payload.byteLength & ~1;
      pcm = new Int16Array(m / 2);
      const dv = new DataView(payload.buffer, payload.byteOffset, m);
      for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(i * 2, true);
    }
    if (!pcm.length) return;
    Vibe?.pushExternalPcm?.(bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), rate);
  }

  private onFft(payload: Uint8Array): void {
    if (!this.cfg) return;
    let row: Float32Array;
    if (this.cfg.fftCompression === 'adpcm') {
      row = decodeOwrxFftFrame(payload);
    } else {
      // f32 dB row, little-endian; copy into an aligned Float32Array
      row = new Float32Array(payload.byteLength / 4);
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let i = 0; i < row.length; i++) row[i] = dv.getFloat32(i * 4, true);
    }
    this.lastRow = row;
    this.emitSlice(row);
  }

  /** Slice the full-profile FFT row to the current view window and emit. The
   *  window is SHIFTED (not clamped) to stay inside the profile, so a VFO near a
   *  band edge keeps a full-width view and the marker simply moves toward the edge
   *  — clamping the edges instead pinned the VFO to the left edge and stuck it. */
  /** The shifted view window [lo,hi] in absolute Hz — shared by the waterfall
   *  slice and the status snapshot so the VFO overlay and waterfall agree. */
  private window(): { lo: number; hi: number } {
    const cf = this.cfg?.centerFreq ?? this.freq, sr = this.cfg?.sampRate ?? 0;
    if (!sr) return { lo: cf, hi: cf };
    const fullLo = cf - sr / 2, fullHi = cf + sr / 2;
    const bw = Math.min(this.viewBw || sr, sr);
    let lo = this.viewCenter - bw / 2, hi = this.viewCenter + bw / 2;
    if (lo < fullLo) { lo = fullLo; hi = fullLo + bw; }
    if (hi > fullHi) { hi = fullHi; lo = fullHi - bw; }
    return { lo, hi };
  }

  private emitSlice(full: Float32Array): void {
    if (!this.cfg || !this.cfg.sampRate) return;
    const cf = this.cfg.centerFreq, sr = this.cfg.sampRate;
    const fullLo = cf - sr / 2;
    const { lo, hi } = this.window();
    const n = full.length;
    const loIdx = Math.max(0, Math.min(n, Math.round(((lo - fullLo) / sr) * n)));
    const hiIdx = Math.max(loIdx, Math.min(n, Math.round(((hi - fullLo) / sr) * n)));
    const out = (loIdx === 0 && hiIdx === n) ? full : full.subarray(loIdx, hiIdx);
    this.cb.onSpectrum(out, this.statusForSlice(out.length, lo, hi));
  }

  private statusForSlice(binCount: number, viewLo: number, viewHi: number): SDRStatus {
    const bw = Math.max(1, viewHi - viewLo);
    return {
      frequency: this.freq, mode: this.mode,
      bandwidthLow: this.bwLow, bandwidthHigh: this.bwHigh,
      binCount, binBandwidth: bw / Math.max(1, binCount),
      centerHz: (viewLo + viewHi) / 2, bwHz: bw,
    };
  }

  // ── outbound: control plane ──────────────────────────────────────────────
  private send(obj: any): void { try { this.ws?.send(JSON.stringify(obj)); } catch {} }

  private sendDemod(): void {
    if (!this.started || !this.cfg) return;
    const offset = this.freq - this.cfg.centerFreq;
    // The mode may be a known SDRMode (mapped) or a server modulation passed
    // straight through (wfm, dmr, dab, …) selected from the gated picker.
    let mod = MODE_TO_WIRE[this.mode] ?? String(this.mode);
    if (this.modes && !this.modes.includes(mod)) {
      if (mod === 'sam') mod = 'am';                 // clamp per brief §4
      else if (mod === 'nfm' && this.modes.includes('fm')) mod = 'fm';
    }
    this.send({ type: 'dspcontrol', params: {
      offset_freq: Math.round(offset), mod, squelch_level: -150,
      low_cut: this.bwLow, high_cut: this.bwHigh,
    } });
  }

  tune(frequency: number, mode?: SDRMode): void {
    if (mode) this.mode = mode;
    if (!this.cfg) { this.freq = frequency; return; }
    const half = this.cfg.sampRate / 2;
    const offset = frequency - this.cfg.centerFreq;
    this.dbg(`tune in=${frequency} off=${Math.round(offset)} half=${half} ${Math.abs(offset) <= half ? 'IN' : 'OUT'}`);
    if (Math.abs(offset) <= half) {
      this.freq = frequency;
      this.viewCenter = frequency;        // VFO stays centred (UberSDR-like), view follows
      this.sendDemod();
      if (this.lastRow) this.emitSlice(this.lastRow);
      this.cb.onStatus(this.getStatus());
      return;
    }
    // Outside the current profile window — try to auto-switch to one that contains it.
    const target = this.profiles.find((p) => p.centerHz != null && p.bwHz != null &&
      Math.abs(frequency - (p.centerHz as number)) <= (p.bwHz as number) / 2);
    if (target) {
      this.freq = frequency;            // applied after the new config arrives
      this.viewCenter = frequency;
      this.selectProfile(target.id);
    } else {
      // clamp to the window edge (UI pulses the drum at band edge)
      this.freq = this.cfg.centerFreq + Math.sign(offset) * half;
      this.viewCenter = this.freq;
      this.sendDemod();
      if (this.lastRow) this.emitSlice(this.lastRow);
      this.cb.onStatus(this.getStatus());
    }
  }

  syncFrequency(frequency: number, mode?: SDRMode): void {
    this.freq = frequency; if (mode) this.mode = mode;
  }

  /** Adopt the server's default passband for the current demodulator, if known. */
  private applyModeBandpass(): void {
    const info = this.serverModes.find((m) => m.id === (this.mode as string));
    if (info?.bandpass) { this.bwLow = info.bandpass.low_cut; this.bwHigh = info.bandpass.high_cut; }
  }

  setMode(mode: SDRMode): void {
    this.mode = mode;
    this.applyModeBandpass();
    // The audio stream restarts on a mode change (e.g. NFM type-2 ↔ WFM type-4) —
    // reset both ADPCM decoders so stale state doesn't corrupt the new stream.
    this.audioDec.reset(); this.hdAudioDec.reset();
    this.sendDemod();
    this.cb.onStatus(this.getStatus());
  }

  setBandwidth(low: number, high: number): void {
    this.bwLow = low; this.bwHigh = high; this.sendDemod(); this.cb.onStatus(this.getStatus());
  }

  // ── view (client-side slicing) ───────────────────────────────────────────
  zoom(frequency: number, binBandwidth: number): void {
    // binBandwidth is Hz/bin for the requested view; reconstruct total view width.
    const fftBins = this.cfg?.fftSize ?? 1024;
    this.viewCenter = frequency;
    this.viewBw = Math.min(this.cfg?.sampRate ?? this.viewBw, binBandwidth * fftBins);
    if (this.lastRow) this.emitSlice(this.lastRow);
  }
  pan(frequency: number): void { this.viewCenter = frequency; if (this.lastRow) this.emitSlice(this.lastRow); }
  resetView(): void {
    if (this.cfg) { this.viewCenter = this.cfg.centerFreq; this.viewBw = this.cfg.sampRate; }
    if (this.lastRow) this.emitSlice(this.lastRow);
  }

  // OWRX pushes one row per FFT; no client rate control / pause needed.
  setRate(_divisor: number): void {}
  pauseSpectrum(): void {}
  resumeSpectrum(): void {}

  // ── profiles ─────────────────────────────────────────────────────────────
  getProfiles(): ProfileInfo[] { return this.profiles; }
  selectProfile(id: string): void { this.send({ type: 'selectprofile', params: { profile: id } }); }

  // ── status ───────────────────────────────────────────────────────────────
  getStatus(): SDRStatus {
    const sr = this.cfg?.sampRate ?? 0;
    const { lo, hi } = this.window();
    const bw = Math.max(1, hi - lo);
    const bins = this.cfg?.fftSize ? Math.round((bw / sr) * this.cfg.fftSize) : 0;
    return {
      frequency: this.freq, mode: this.mode,
      bandwidthLow: this.bwLow, bandwidthHigh: this.bwHigh,
      binCount: bins, binBandwidth: bw / Math.max(1, bins),
      centerHz: this.viewInit ? (lo + hi) / 2 : (this.cfg?.centerFreq ?? this.freq),
      bwHz: this.viewInit ? bw : sr,
    };
  }
  getView(): SDRStatus { return this.getStatus(); }

  private dbg(m: string): void { this.cb.onDbg?.('[owrx] ' + m); }
}
