// UberSDRClient.ts — native WebSocket client for UberSDR servers
//
// Audio WS is owned by native VibePowerModule (runs on background thread, survives JS suspension).
// JS only manages the spectrum WS for display.
//
// Binary SPEC frame format (from user_spectrum_websocket.go):
//   Header 22 bytes:
//     [0..3]  magic "SPEC"
//     [4]     version 0x01
//     [5]     flags: 0x01=full float32, 0x02=delta float32, 0x03=full uint8, 0x04=delta uint8
//     [6..13] timestamp uint64 LE (nanoseconds)
//     [14..21] frequency uint64 LE (Hz)
//   Body:
//     full:  binCount × float32 LE
//     delta: uint16 changeCount, then changeCount × {uint16 index, float32 value}
//   8-bit variants: same layout but values are uint8 (0..255 mapped to dBFS range)

import 'react-native-get-random-values'; // polyfill for crypto.getRandomValues
import { ungzip } from 'pako';
import { VibePowerModule } from '../components/AudioPlayer';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SDRMode = 'usb' | 'lsb' | 'am' | 'sam' | 'fm' | 'nfm' | 'cwu' | 'cwl';

/** Server-side mode bandwidth defaults (websocket.go, verbatim). */
export const MODE_BANDWIDTHS: Record<SDRMode, [number, number]> = {
  usb: [50, 2700],     lsb: [-2700, -50],
  am:  [-5000, 5000],  sam: [-5000, 5000],
  cwu: [-200, 200],    cwl: [-200, 200],
  fm:  [-8000, 8000],  nfm: [-5000, 5000],
};

export interface SDRStatus {
  frequency: number;    // Hz
  mode: SDRMode;
  bandwidthLow: number;  // Hz, negative = below carrier
  bandwidthHigh: number; // Hz, positive = above carrier
  binCount: number;
  binBandwidth: number;  // Hz per bin
  centerHz: number;      // center of spectrum display
  bwHz: number;          // total spectrum bandwidth
}

export interface SDRCallbacks {
  onSpectrum:   (bins: Float32Array, status: SDRStatus) => void;
  onStatus:     (status: SDRStatus) => void;
  onError:      (msg: string) => void;
  onConnect:    () => void;
  onDisconnect: () => void;
  onDbg?:       (msg: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SPEC_MAGIC    = 0x43455053; // "SPEC" in little-endian uint32
const FLAG_FULL_F32  = 0x01;
const FLAG_DELTA_F32 = 0x02;
const FLAG_FULL_U8   = 0x03;
const FLAG_DELTA_U8  = 0x04;

// binary8 encoding (user_spectrum_websocket.go sendBinary8Spectrum):
//   uint8 = clamp(dBFS, -256, 0) + 256  →  decode: dBFS = uint8 - 256
// (0 = -256 dB, 255 = -1 dB). The previous -160..0 linear mapping was WRONG
// and distorted every dB value entering the waterfall/auto-range/SNR pipeline.
const U8_DBFS_OFFSET = -256;

// ── Client class ──────────────────────────────────────────────────────────────

export class UberSDRClient {
  private baseUrl:   string;
  readonly uuid:     string; // shared with native audio WS
  private callbacks: SDRCallbacks;

  private spectrumWs:     WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private bins: Float32Array = new Float32Array(1024);
  private status: SDRStatus = {
    frequency:     14_074_000,
    mode:          'usb',
    bandwidthLow:  50,    // usb defaults — kept in sync via MODE_BANDWIDTHS
    bandwidthHigh: 2700,
    binCount:       1024,
    binBandwidth:   0,
    centerHz:       0,
    bwHz:           0,
  };

  constructor(baseUrl: string, uuid: string, callbacks: SDRCallbacks) {
    this.baseUrl   = baseUrl.replace(/\/+$/, '');
    this.uuid      = uuid;
    this.callbacks = callbacks;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect(frequency = 14_074_000, mode: SDRMode = 'usb') {
    this.destroyed = false;
    this.status.frequency = frequency;
    this.status.mode = mode;

    try {
      await this._checkConnection();
      // Native VibePowerModule opens the audio WS — give it 1s to register the
      // session on the server before the spectrum WS subscribes.
      setTimeout(() => {
        if (!this.destroyed) this._openSpectrumWs();
      }, 1000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onError('Connection check failed: ' + msg);
    }
  }

  /** Tune to a new frequency (and optionally mode). Sends to native audio WS + spectrum WS. */
  tune(frequency: number, mode?: SDRMode) {
    if (frequency) this.status.frequency = frequency;
    if (mode)      this.status.mode = mode;
    VibePowerModule?.sendTuneCommand(frequency, mode ?? this.status.mode);
    // Re-centre spectrum on new frequency so waterfall follows the VFO
    if (this.spectrumWs?.readyState === WebSocket.OPEN) {
      this.spectrumWs.send(JSON.stringify({
        type:         'zoom',
        frequency,
        binBandwidth: this.status.binBandwidth || 100,
      }));
    }
  }

  /** Update internal state only — used when native already sent the tune (e.g. lock screen skip). */
  syncFrequency(frequency: number, mode?: SDRMode) {
    if (frequency) this.status.frequency = frequency;
    if (mode)      this.status.mode = mode;
  }

  setMode(mode: SDRMode) {
    this.status.mode = mode;
    // Server applies these defaults on every mode change (websocket.go —
    // "These match the defaults in app.js setMode()"). It never reports
    // bandwidth back, so mirror the exact table to stay in sync.
    const bw = MODE_BANDWIDTHS[mode];
    if (bw) { this.status.bandwidthLow = bw[0]; this.status.bandwidthHigh = bw[1]; }
    VibePowerModule?.sendTuneCommand(this.status.frequency, mode);
  }

  setBandwidth(low: number, high: number) {
    this.status.bandwidthLow  = low;
    this.status.bandwidthHigh = high;
    VibePowerModule?.sendBandwidth(low, high);
  }

  // Frequency MUST be an integer — server unmarshals into uint64 and rejects
  // fractional JSON numbers. Centre clamp 10kHz–30MHz per server limits.
  // binBandwidth clamped so total span never exceeds the 30MHz HF range —
  // the server ladder passes large values through unchecked and a runaway
  // zoom-out wedges the session.
  zoom(frequency: number, binBandwidth: number) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    const f = Math.max(10_000, Math.min(30_000_000, Math.round(frequency)));
    const n  = this.status.binCount || 1024;
    const bb = Math.max(0.5, Math.min(binBandwidth, 30_000_000 / n));
    this.spectrumWs.send(JSON.stringify({ type: 'zoom', frequency: f, binBandwidth: bb }));
  }

  pan(frequency: number) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    const f = Math.max(10_000, Math.min(30_000_000, Math.round(frequency)));
    this.spectrumWs.send(JSON.stringify({ type: 'pan', frequency: f }));
  }

  resetView() {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'reset' }));
  }

  /**
   * SNR squelch (audio gate) — gates audio when SNR is below threshold.
   * minSnr ≤ -999 disables (open squelch). Sends set_audio_gate.
   */
  setAudioGate(minSnr: number) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'set_audio_gate', min_snr: minSnr }));
  }

  /**
   * FM/NFM squelch — gates by carrier SNR. squelchDb ≤ -999 = open.
   * Currently feature-flagged off in UberSDR server (FM_SQUELCH_ENABLED=false).
   */
  setSquelch(squelchDb: number) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'set_squelch', squelchOpen: squelchDb }));
  }

  /**
   * NR mode — cycles client-side NR. Mirrors toggleNR2Quick() in app.js.
   * 'off' | 'nr' (Wiener engine) | 'nr2' (RLMS engine).
   * Sent via spectrum WS using set_nr_mode.
   */
  setNRMode(mode: 'off' | 'nr' | 'nr2') {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'set_nr_mode', mode }));
  }

  /**
   * Noise blanker on/off. Mirrors toggleNBQuick() in app.js.
   */
  setNoiseBlanker(enabled: boolean) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'set_nb', enabled }));
  }

  /**
   * Server-side DSP (noise reduction insert).
   * enable=true: send set_dsp with filter name and params.
   * enable=false: send set_dsp disabled.
   */
  setDsp(enabled: boolean, filter?: string, params?: Record<string, number>) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    if (enabled && filter) {
      this.spectrumWs.send(JSON.stringify({ type: 'set_dsp', enabled: true, filter, params: params ?? {} }));
    } else {
      this.spectrumWs.send(JSON.stringify({ type: 'set_dsp', enabled: false }));
    }
  }

  /** Update server DSP params mid-stream without toggling on/off. */
  setDspParams(params: Record<string, number>) {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'set_dsp_params', params }));
  }

  getStatus(): SDRStatus { return { ...this.status }; }

  /** Stop spectrum display (app backgrounded). Native audio continues unaffected. */
  pauseSpectrum() {
    this.spectrumWs?.close();
    this.spectrumWs = null;
  }

  /** Resume spectrum display (app foregrounded). */
  resumeSpectrum() {
    if (!this.destroyed && !this.spectrumWs) {
      this._openSpectrumWs();
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.spectrumWs?.close();
    this.spectrumWs = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private dbg(msg: string) {
    console.warn('[UberSDR]', msg);
    this.callbacks.onDbg?.(msg);
  }

  private async _checkConnection() {
    this.dbg('POST /connection uuid=' + this.uuid.slice(0, 8));
    const resp = await fetch(`${this.baseUrl}/connection`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'User-Agent':     'VibeSDR/2.0 (iOS; React Native)',
        'X-Requested-With': 'VibeSDR',
      },
      body: JSON.stringify({ user_session_id: this.uuid }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 120)}`);
    }
    const json = await resp.json() as { allowed: boolean; reason?: string };
    this.dbg(`/connection → allowed=${json.allowed} reason=${json.reason ?? 'ok'}`);
    if (!json.allowed) throw new Error(json.reason ?? 'Server rejected connection');
  }

  private _wsUrl(path: string): string {
    const url = this.baseUrl.replace(/^http/, 'ws');
    return `${url}${path}`;
  }

  private _openSpectrumWs() {
    if (this.destroyed) return;

    const url = this._wsUrl(`/ws/user-spectrum?user_session_id=${this.uuid}&mode=binary8`);
    const ws  = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.spectrumWs = ws;

    let specMsgCount = 0;
    ws.onopen = () => {
      if (this.destroyed) { ws.close(); return; }
      this.dbg('Spectrum WS open');
      this.callbacks.onConnect();
      ws.send(JSON.stringify({
        type:         'zoom',
        frequency:    this.status.centerHz || this.status.frequency,
        binBandwidth: this.status.binBandwidth || 100,
      }));
    };

    ws.onmessage = (e) => {
      specMsgCount++;
      if (specMsgCount <= 3) {
        this.dbg(`SpecMsg#${specMsgCount} binary=${e.data instanceof ArrayBuffer} len=${e.data instanceof ArrayBuffer ? e.data.byteLength : (e.data as string).length}`);
      }
      if (e.data instanceof ArrayBuffer) {
        this._parseBinaryFrame(e.data);
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data) as Record<string, unknown>;
          this._handleSpectrumMessage(msg);
        } catch {}
      }
    };

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      else clearInterval(ping);
    }, 30_000);

    ws.onclose = (e) => {
      clearInterval(ping);
      this.dbg('Spectrum WS closed code=' + e.code);
      if (!this.destroyed) {
        this.callbacks.onDisconnect();
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => this.callbacks.onError('Spectrum WebSocket error');
  }

  private _parseBinaryFrame(buf: ArrayBuffer) {
    const view  = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // JSON control messages (type:"config" etc.) arrive as BINARY frames of
    // gzipped JSON (server writeJSONCompressed) — NOT text frames. The web
    // client does the same gzip-magic sniff before DecompressionStream.
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        const msg = JSON.parse(ungzip(bytes, { to: 'string' })) as Record<string, unknown>;
        this._handleSpectrumMessage(msg);
      } catch (e) {
        this.dbg('gzip JSON frame parse failed: ' + String(e));
      }
      return;
    }

    if (buf.byteLength < 22) { this.dbg('frame too short: ' + buf.byteLength); return; }

    const magic = view.getUint32(0, true);
    if (magic !== SPEC_MAGIC) {
      this.dbg('bad magic: 0x' + magic.toString(16) + ' expected 0x' + SPEC_MAGIC.toString(16) +
        ' bytes=' + Array.from(bytes.slice(0,4)).map(b=>b.toString(16)).join(','));
      return;
    }

    const flags     = bytes[5];
    const freqLo    = view.getUint32(14, true);
    const freqHi    = view.getUint32(18, true);
    const frequency = freqLo + freqHi * 0x100000000;

    const body = buf.slice(22);

    if (flags === FLAG_FULL_F32)  { this._applyFull(new Float32Array(body), frequency); }
    else if (flags === FLAG_DELTA_F32) { this._applyDeltaF32(body, frequency); }
    else if (flags === FLAG_FULL_U8)   { this._applyFullU8(new Uint8Array(body), frequency); }
    else if (flags === FLAG_DELTA_U8)  { this._applyDeltaU8(body, frequency); }
  }

  private _applyFull(floats: Float32Array, frequency: number) {
    if (floats.length !== this.bins.length) {
      this.bins = new Float32Array(floats.length);
      this.status.binCount = floats.length;
    }
    this.bins.set(floats);
    this._emitSpectrum(frequency);
  }

  private _applyDeltaF32(body: ArrayBuffer, frequency: number) {
    const view = new DataView(body);
    if (body.byteLength < 2) return;
    const changeCount = view.getUint16(0, true);
    let offset = 2;
    for (let i = 0; i < changeCount; i++) {
      if (offset + 6 > body.byteLength) break;
      const idx = view.getUint16(offset, true);
      const val = view.getFloat32(offset + 2, true);
      offset += 6;
      if (idx < this.bins.length) this.bins[idx] = val;
    }
    this._emitSpectrum(frequency);
  }

  private _applyFullU8(u8: Uint8Array, frequency: number) {
    if (u8.length !== this.bins.length) {
      this.bins = new Float32Array(u8.length);
      this.status.binCount = u8.length;
    }
    for (let i = 0; i < u8.length; i++) {
      this.bins[i] = u8[i] + U8_DBFS_OFFSET; // dBFS = uint8 - 256
    }
    this._emitSpectrum(frequency);
  }

  private _applyDeltaU8(body: ArrayBuffer, frequency: number) {
    const view  = new DataView(body);
    if (body.byteLength < 2) return;
    const changeCount = view.getUint16(0, true);
    let offset = 2;
    for (let i = 0; i < changeCount; i++) {
      if (offset + 3 > body.byteLength) break;
      const idx = view.getUint16(offset, true);
      const val = view.getUint8(offset + 2);
      offset += 3;
      if (idx < this.bins.length) this.bins[idx] = val + U8_DBFS_OFFSET; // dBFS = uint8 - 256
    }
    this._emitSpectrum(frequency);
  }

  private unwrapped: Float32Array = new Float32Array(0);

  private _emitSpectrum(frequency: number) {
    const s = this.status;
    s.centerHz = frequency;
    s.bwHz     = s.binBandwidth * s.binCount;

    // Unwrap FFT bin ordering from radiod (spectrum-display.js parity):
    // frames arrive as [positive freqs DC→+Nyquist, negative freqs −Nyquist→DC];
    // display needs [negative, positive]. Without this swap every signal is
    // drawn half the span away from its true frequency. this.bins stays in
    // WRAPPED order because delta-frame indices refer to wrapped positions.
    const n = this.bins.length;
    const half = n >> 1;
    if (this.unwrapped.length !== n) this.unwrapped = new Float32Array(n);
    const out = this.unwrapped;
    out.set(this.bins.subarray(half, half * 2), 0);
    out.set(this.bins.subarray(0, half), half);

    this.callbacks.onSpectrum(out, { ...s });
  }

  private _handleSpectrumMessage(msg: Record<string, unknown>) {
    // Server replies with type:"config" — sent on connect and after every
    // zoom/pan/reset/set_rate (sendStatus in user_spectrum_websocket.go):
    //   { type:"config", centerFreq, binCount, binBandwidth, totalBandwidth }
    // This is the ONLY way the client learns binBandwidth (binary frames carry
    // just the centre frequency) — without it bwHz stays 0 and the entire
    // frequency→pixel mapping (needle, band plan, gestures) is dead.
    if (msg.type === 'config') {
      if (typeof msg.centerFreq   === 'number') this.status.centerHz     = msg.centerFreq;
      if (typeof msg.binBandwidth === 'number') this.status.binBandwidth = msg.binBandwidth;
      if (typeof msg.binCount     === 'number') {
        this.status.binCount = msg.binCount;
        if (this.bins.length !== msg.binCount) this.bins = new Float32Array(msg.binCount);
      }
      this.status.bwHz = typeof msg.totalBandwidth === 'number'
        ? msg.totalBandwidth
        : this.status.binBandwidth * this.status.binCount;
      this.dbg(`config: ${this.status.binCount} bins @ ${this.status.binBandwidth} Hz ` +
               `centre ${this.status.centerHz} bw ${this.status.bwHz}`);
      this.callbacks.onStatus({ ...this.status });
    }
  }

  private _scheduleReconnect() {
    if (this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this._openSpectrumWs();
    }, 3000);
  }
}
