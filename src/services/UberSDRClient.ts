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
import { eccPiToIso } from './rdsCountry';

// ── Types ─────────────────────────────────────────────────────────────────────

// 'wfm' = broadcast FM (stereo); local-hardware (RTL-SDR) only — UberSDR is HF.
export type SDRMode = 'usb' | 'lsb' | 'am' | 'sam' | 'fm' | 'nfm' | 'cwu' | 'cwl' | 'wfm';

/** Server-side mode bandwidth defaults (websocket.go, verbatim). */
export const MODE_BANDWIDTHS: Record<SDRMode, [number, number]> = {
  usb: [50, 2700],     lsb: [-2700, -50],
  am:  [-5000, 5000],  sam: [-5000, 5000],
  cwu: [-200, 200],    cwl: [-200, 200],
  fm:  [-6000, 6000],  nfm: [-5000, 5000],
  wfm: [-100000, 100000],
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
  /** Link quality: 0=down, 1=poor(red), 2=fluctuating(yellow), 3=good(green).
   *  Derived from frame inter-arrival jitter, stalls, ping RTT, reconnects. */
  onLink?:      (q: 0 | 1 | 2 | 3) => void;
  onDbg?:       (msg: string) => void;
  /** VibeServer: the serving device's supported tuner gains (tenths of dB), so a
   *  remote client can populate its gain slider (it can't query the HW natively). */
  onHwGains?:   (gains: number[]) => void;
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

// View-prediction tuning (anti-thrash — see view/getView below):
// coalesce zoom/pan sends to ≤1 per VIEW_SEND_MS (a fast drum gesture fires at
// 60–120Hz; every request triggers a config echo, so unthrottled gestures flood
// the link), and treat the view as "in flight" until VIEW_SETTLE_MS of send
// quiet, after which the server's acked state is adopted in one step.
const VIEW_SEND_MS   = 33;
const VIEW_SETTLE_MS = 300;

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

  // ── View prediction (anti-thrash) ───────────────────────────────────────
  // The server echoes a config after EVERY zoom/pan (sendStatus fires even for
  // no-ops). During a fast gesture many requests are in flight at once and the
  // echoes replay every intermediate state one RTT late — applied directly to
  // the UI they thrash the band plan/needle (the "multi-colour flash"), and
  // gestures that re-base on this stale acked state compute wrong targets, so
  // the view can land at an old zoom/tune. Fix: keep a *predicted* view that
  // updates synchronously on every send. Gestures read getView(), frames are
  // rendered under the predicted geometry while in flight, and the acked truth
  // (server snaps binBandwidth to a ladder, so its answer always wins) is
  // adopted in one clean step once sends go quiet.
  // Tunable frequency range (Hz). Default = UberSDR HF limits (10 kHz–30 MHz).
  // V4 local hardware widens this to the RTL-SDR's range.
  minHz = 10_000;
  maxHz = 30_000_000;
  // Max zoom-OUT span (Hz). 0 = use maxHz. Local hardware reports its full
  // device bandwidth via config.maxBandwidth so you can't zoom out past it.
  private maxSpanHz = 0;

  // VFO lock / waterfall panning (see SDRBackend.setFollowMode/panSpan).
  // followVfo=true reproduces today's behaviour: tune() recentres the view.
  private followVfo = true;
  // Local hardware only — set by the adapter from the device config. Drives the
  // movable Fs pan window in panSpan(). Default = the 2.4 MS/s RTL-SDR rate.
  isLocal = false;
  localSampleRate = 2_400_000;
  // VibeServer PIN: a pre-computed "&vs_nonce=&vs_auth=" suffix appended to the
  // spectrum WS URL so a PIN-protected server accepts the upgrade. Empty otherwise.
  authSuffix = '';

  private view = { centerHz: 0, binBandwidth: 0 };
  private pendingView: { frequency: number; binBandwidth: number } | null = null;
  private lastSendAt   = 0;
  private sendTimer:   ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string, uuid: string, callbacks: SDRCallbacks, password?: string) {
    this.baseUrl   = baseUrl.replace(/\/+$/, '');
    this.uuid      = uuid;
    this.callbacks = callbacks;
    this.password  = password ?? null;
  }

  /** Bypass password (rate-limit/ban bypass) — appended to every WS URL,
   *  exactly like the skin's window.bypassPassword. */
  private password: string | null = null;
  private _pwSuffix(): string {
    return this.password ? `&password=${encodeURIComponent(this.password)}` : '';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect(frequency = 14_074_000, mode: SDRMode = 'usb') {
    this.destroyed = false;
    this.status.frequency = frequency;
    this.status.mode = mode;
    // Mirror the server's per-mode bandwidth defaults for the CONNECT mode
    // too (setMode already does) — without this, connecting in a restored
    // non-USB mode kept the constructor's USB edges and the first emission
    // overwrote the screen's correct values (AM showing only one sideband).
    const cbw = MODE_BANDWIDTHS[mode];
    if (cbw) { this.status.bandwidthLow = cbw[0]; this.status.bandwidthHigh = cbw[1]; }

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
  tune(frequency: number, mode?: SDRMode, opts?: { recenter?: boolean }) {
    if (frequency) this.status.frequency = frequency;
    if (mode)      this.status.mode = mode;
    VibePowerModule?.sendTuneCommand(frequency, mode ?? this.status.mode);
    // Re-centre spectrum on new frequency so waterfall follows the VFO — only
    // when locked (followVfo) or a discrete jump forces it (opts.recenter).
    // Unlocked continuous tuning leaves the view put so the user can pan freely.
    // Goes through the coalesced view sender — a fast VFO drum spin fires per
    // step, and per-step recentres flood the link with config echoes. (Audio
    // tune above stays per-event via native, so tuning feel is unaffected.)
    if (this.followVfo || opts?.recenter) {
      const bb = this.view.binBandwidth || this.status.binBandwidth;
      if (bb) this.zoom(frequency, bb);
      else    this.pan(frequency); // no geometry known yet — let server keep its bin_bw
    }
  }

  /** Locked (true) = view follows the VFO. See SDRBackend.setFollowMode. */
  setFollowMode(follow: boolean) { this.followVfo = follow; }

  /** Real captured bandwidth (Hz) of the local device. The shim reports it as
   *  config.maxBandwidth → maxSpanHz, which tracks the ACTUAL sample rate /
   *  bandwidth mode. localSampleRate (from JS hw config) is only a fallback —
   *  it can lag the device, which made the pan wall land in the wrong place. */
  captureBandwidth(): number {
    return this.maxSpanHz > 0 ? this.maxSpanHz : this.localSampleRate;
  }

  /** Margin keeping the VFO inside the usable capture — MUST match the shim's
   *  viewDongleMargin(): above the 50 kHz auto-retune threshold AND clear of the
   *  RTL anti-alias rolloff (~10%, e.g. a 250 kHz mode is only ~192 kHz usable). */
  private localMargin(fs: number): number { return Math.max(fs * 0.10, 60_000); }

  /** Current display half-span (Hz). */
  private viewHalfSpan(): number {
    const bw = (this.view.binBandwidth || this.status.binBandwidth) * (this.status.binCount || 1);
    return (bw > 0 ? bw : this.status.bwHz) / 2;
  }

  /** The dongle / RF-centre frequency the shim is parked at, derived the same
   *  way the shim does (dongleForView): the dongle follows the view but is
   *  clamped so the VFO stays captured, then locks. Drives the RF-centre marker
   *  and the capture-window walls. (No protocol field — pure mirror.) */
  rfCenterHz(): number {
    if (!this.isLocal) return this.status.centerHz;
    const fs = this.captureBandwidth();
    const lim = fs / 2 - this.localMargin(fs);
    const vfo = this.status.frequency;
    return Math.max(vfo - lim, Math.min(vfo + lim, this.status.centerHz));
  }

  panSpan(): { loHz: number; hiHz: number; movable: boolean } {
    if (this.isLocal) {
      // The DISPLAY centre can roam across the whole captured band: the dongle
      // follows the view to VFO ± (Fs/2 − M), then locks, and the shim's crop
      // offset carries the view on to the capture edge (a further Fs/2 − cropHalf
      // beyond the dongle). So the reachable view centre = VFO ± (Fs − M − cropHalf).
      // Clamped directly (centre-bounds) — see SDRScreen.onWfPanDelta movable branch.
      const fs = this.captureBandwidth();
      const reach = Math.max(0, fs - this.localMargin(fs) - this.viewHalfSpan());
      const vfo = this.status.frequency;
      return { loHz: vfo - reach, hiHz: vfo + reach, movable: true };
    }
    return { loHz: this.minHz, hiHz: this.maxHz, movable: false }; // full HF range
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
    const f = Math.max(this.minHz, Math.min(this.maxHz, Math.round(frequency)));
    const n  = this.status.binCount || 1024;
    // Max-zoom floor: 6 kHz total span (3 kHz per sideband — one SSB
    // channel both sides). The server goes deeper but past this the
    // spectrum shows artefacts and looks frozen even though it isn't
    // (device-confirmed on both platforms 2026-06-12).
    const spanCap = this.maxSpanHz > 0 ? this.maxSpanHz : this.maxHz;
    const bb = Math.max(6_000 / n, Math.min(binBandwidth, spanCap / n));
    this.view.centerHz     = f;
    this.view.binBandwidth = bb;
    this._sendView(f, bb);
  }

  pan(frequency: number) {
    const f = Math.max(this.minHz, Math.min(this.maxHz, Math.round(frequency)));
    this.view.centerHz = f;
    this._sendView(f, this.view.binBandwidth || this.status.binBandwidth);
  }

  // ── VibeServer hardware controls (client drives the remote radio) ─────────
  // Sent over the spectrum WS control channel; the shim applies them server-side.
  private _sendCtl(obj: Record<string, unknown>) {
    const ws = this.spectrumWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  setHwGain(tenthDb: number, auto: boolean) {
    this._sendCtl(auto ? { type: 'gain', auto: true } : { type: 'gain', value: tenthDb });
  }
  setHwBiasT(on: boolean) { this._sendCtl({ type: 'biasT', on }); }
  setHwAgc(on: boolean)   { this._sendCtl({ type: 'agc', on }); }
  setHwPpm(ppm: number)   { this._sendCtl({ type: 'ppm', value: Math.round(ppm) }); }

  /** Coalesced view sender — keeps only the latest target, sends ≤1/VIEW_SEND_MS
   *  with the final state always delivered (trailing edge). */
  private _sendView(frequency: number, binBandwidth: number) {
    this.pendingView = { frequency, binBandwidth };
    const wait = this.lastSendAt + VIEW_SEND_MS - Date.now();
    if (wait <= 0) { this._flushView(); return; }
    if (!this.sendTimer) {
      this.sendTimer = setTimeout(() => { this.sendTimer = null; this._flushView(); }, wait);
    }
  }

  private _flushView() {
    const p = this.pendingView;
    if (!p) return;
    this.pendingView = null;
    // WS down (reconnecting): drop — onopen re-sends the predicted view.
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.lastSendAt = Date.now();
    // Server treats zoom and pan as one case; binBandwidth ≤ 0 = keep current.
    const msg: Record<string, unknown> = { type: 'zoom', frequency: p.frequency };
    if (p.binBandwidth > 0) msg.binBandwidth = p.binBandwidth;
    this.spectrumWs.send(JSON.stringify(msg));
    this._armSettle();
  }

  /** In flight = a send happened < VIEW_SETTLE_MS ago, or one is queued. */
  private _inFlight(): boolean {
    return this.settleTimer !== null || this.pendingView !== null;
  }

  private _armSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.destroyed) return;
      // Quiet — adopt the server's acked state (ladder-snapped) in one step.
      if (this.status.binBandwidth > 0) {
        this.view.centerHz     = this.status.centerHz;
        this.view.binBandwidth = this.status.binBandwidth;
      }
      this.callbacks.onStatus({ ...this.status });
    }, VIEW_SETTLE_MS);
  }

  resetView() {
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) return;
    this.spectrumWs.send(JSON.stringify({ type: 'reset' }));
  }

  /**
   * Poll-rate divisor (set_rate, 1–8): the server polls radiod at 1/N rate so
   * spectrum frames arrive at 1/N — the idle battery saver. Ignored on shared
   * channels (hardcoded ÷3 server-side). Zoom/pan can migrate the session
   * shared↔private, which RESETS the divisor — so it is re-sent whenever a
   * config reports a binBandwidth change and on reconnect (skin app.js
   * onConfig parity).
   */
  setRate(divisor: number) {
    this.rateDivisor = Math.max(1, Math.min(8, Math.round(divisor)));
    this.gapHist.length = 0; // legit frame-rate change — don't read as stalls
    if (this.spectrumWs?.readyState === WebSocket.OPEN) {
      this.spectrumWs.send(JSON.stringify({ type: 'set_rate', divisor: this.rateDivisor }));
    }
  }
  private rateDivisor   = 1;
  private lastRateBinBw = 0;

  // NOTE (2026-06-12): set_audio_gate / set_squelch / set_dsp / set_nr_mode
  // are AUDIO-WS message types — the spectrum WS this client owns doesn't
  // know them. They now go through VibePowerModule.sendAudioCommand (native
  // socket); client NR/NR2/NB run natively in VibeDSP.swift.

  getStatus(): SDRStatus { return { ...this.status }; }

  /** Geometry for gesture math: predicted while zoom/pan requests are in
   *  flight, server truth once settled. NEVER re-base a gesture on
   *  getStatus() — its centerHz/binBandwidth are one RTT stale during
   *  interaction, which is how fast gestures used to land on old states. */
  getView(): SDRStatus {
    const s = { ...this.status };
    if (this.view.binBandwidth > 0) {
      s.centerHz     = this.view.centerHz;
      s.binBandwidth = this.view.binBandwidth;
      s.bwHz         = this.view.binBandwidth * s.binCount;
    }
    return s;
  }

  /** Stop spectrum display (app backgrounded). Native audio continues
   *  unaffected. The paused flag is CRITICAL: without it the onclose handler
   *  auto-reconnects 3s later and the whole spectrum pipeline runs behind the
   *  locked screen forever (background audio keeps JS alive — measured ~50%
   *  CPU locked). */
  private pausedByApp = false;
  pauseSpectrum() {
    this.pausedByApp = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sendTimer)      { clearTimeout(this.sendTimer);      this.sendTimer = null; }
    if (this.settleTimer)    { clearTimeout(this.settleTimer);    this.settleTimer = null; }
    this.pendingView = null;
    this.spectrumWs?.close();
    this.spectrumWs = null;
  }

  /** Resume spectrum display (app foregrounded). Always opens a FRESH socket:
   *  after a deep suspension (e.g. another audio app reaped our session) the old
   *  spectrumWs can be a stale/half-open object that never fired onclose, so the
   *  previous `!this.spectrumWs` guard would skip the reopen and leave the
   *  waterfall frozen. Callers sequence this AFTER the native audio revive so the
   *  spectrum subscribes to a session that exists again (see SDRScreen AppState). */
  resumeSpectrum() {
    this.pausedByApp = false;
    if (this.destroyed) return;
    if (this.spectrumWs) { try { this.spectrumWs.close(); } catch { /* already dead */ } this.spectrumWs = null; }
    this._openSpectrumWs();
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sendTimer)      { clearTimeout(this.sendTimer);      this.sendTimer = null; }
    if (this.settleTimer)    { clearTimeout(this.settleTimer);    this.settleTimer = null; }
    this.pendingView = null;
    this.spectrumWs?.close();
    this.spectrumWs = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private dbg(msg: string) {
    if (__DEV__) console.warn('[UberSDR]', msg); // console is NOT free in release
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
      // password = bypass auth: rate-limited/blocked IPs get through with it
      // (server validates it in this body BEFORE any WS can open)
      body: JSON.stringify({
        user_session_id: this.uuid,
        ...(this.password ? { password: this.password } : {}),
      }),
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

    const url = this._wsUrl(`/ws/user-spectrum?user_session_id=${this.uuid}&mode=binary8${this._pwSuffix()}${this.authSuffix}`);
    const ws  = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.spectrumWs = ws;

    let specMsgCount = 0;
    ws.onopen = () => {
      if (this.destroyed) { ws.close(); return; }
      this.dbg('Spectrum WS open');
      this.callbacks.onConnect();
      // Restore the predicted view (falls back to acked, then tuned freq) —
      // gestures made while the WS was down land here instead of being lost.
      ws.send(JSON.stringify({
        type:         'zoom',
        frequency:    Math.round(this.view.centerHz || this.status.centerHz || this.status.frequency),
        binBandwidth: this.view.binBandwidth || this.status.binBandwidth || 100,
      }));
      // Fresh server session — re-assert the poll divisor if one is active.
      if (this.rateDivisor > 1) {
        ws.send(JSON.stringify({ type: 'set_rate', divisor: this.rateDivisor }));
      }
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

    // Ping doubles as the RTT probe for link quality (server excludes pings
    // from rate limiting, so 5s cadence is safe). One outstanding ping at a
    // time — pong handler computes RTT + jitter EMAs.
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.pingSentAt = Date.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      } else clearInterval(ping);
    }, 5_000);

    const qual = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) { clearInterval(qual); return; }
      this._evalLink();
    }, 1_000);

    ws.onclose = (e) => {
      clearInterval(ping);
      clearInterval(qual);
      this.dbg('Spectrum WS closed code=' + e.code);
      this.lastReconnectAt = Date.now();
      this.gapHist.length = 0;
      this._evalLink(); // → 0 (down) immediately
      if (!this.destroyed && !this.pausedByApp) {
        this.callbacks.onDisconnect();
        this._scheduleReconnect();
      }
    };

    // Transient socket errors are NOT user-facing: onclose follows and
    // _scheduleReconnect recovers silently (Android's socket stack fires
    // onerror on any hiccup — surfacing it alert-booted users to the
    // instance picker while the session was actually fine; the link bars
    // already show degradation).
    ws.onerror = () => this.dbg('Spectrum WS error (reconnect handles it)');
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

  // ── Link quality state ──────────────────────────────────────────────────
  private gapHist: number[] = [];   // recent frame inter-arrival gaps (ms)
  private lastFrameAt    = 0;
  private lastReconnectAt = 0;
  private pingSentAt     = 0;
  private rttAvg         = 0;       // EMA of ping RTT
  private rttJit         = 0;       // EMA of |rtt − rttAvg|
  private lastLink: -1 | 0 | 1 | 2 | 3 = -1;

  /** Score the link like a phone signal indicator. Stalls are judged against
   *  the MEDIAN gap, so legit rate changes (idle divisor) don't read as loss. */
  private _evalLink() {
    let q: 0 | 1 | 2 | 3;
    if (!this.spectrumWs || this.spectrumWs.readyState !== WebSocket.OPEN) {
      q = 0;
    } else {
      const now = Date.now();
      const h = this.gapHist;
      let med = 120;
      if (h.length >= 5) {
        const s = [...h].sort((a, b) => a - b);
        med = s[s.length >> 1];
      }
      let stalls = 0;
      for (let i = 0; i < h.length; i++) if (h[i] > med * 2.5 + 50) stalls++;
      const starving = this.lastFrameAt > 0 &&
        now - this.lastFrameAt > Math.max(2000, med * 4);
      if (now - this.lastReconnectAt < 8000 || stalls >= 3 || starving || this.rttJit > 250) {
        q = 1;
      } else if (stalls >= 1 || this.rttJit > 80 || this.rttAvg > 400) {
        q = 2;
      } else {
        q = 3;
      }
    }
    if (q !== this.lastLink) {
      this.lastLink = q;
      this.callbacks.onLink?.(q);
    }
  }

  private _emitSpectrum(frequency: number) {
    // Frame inter-arrival tracking for link quality
    const fNow = Date.now();
    if (this.lastFrameAt > 0) {
      this.gapHist.push(fNow - this.lastFrameAt);
      if (this.gapHist.length > 40) this.gapHist.shift();
    }
    this.lastFrameAt = fNow;
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

    // While zoom/pan is in flight, render frames under the PREDICTED geometry:
    // the view goes where the finger says instantly and stays put; data from
    // intermediate states is at most one RTT misplaced. Emitting each frame's
    // own (intermediate) geometry replays the whole transition as the echoes
    // arrive — that was the band-plan flash / view-reset glitch.
    const emit = { ...s };
    const v = this.view;
    if (this._inFlight() && v.binBandwidth > 0) {
      emit.centerHz     = v.centerHz;
      emit.binBandwidth = v.binBandwidth;
      emit.bwHz         = v.binBandwidth * s.binCount;
    } else if (v.binBandwidth > 0 &&
               (Math.abs(frequency - v.centerHz) > 1 ||
                Math.abs(s.binBandwidth - v.binBandwidth) > v.binBandwidth * 1e-6)) {
      // Deviant frame with no request in flight — same unsolicited-change
      // treatment as configs: keep showing the stable view, let the settle
      // timer adopt whatever geometry survives the confirm window.
      emit.centerHz     = v.centerHz;
      emit.binBandwidth = v.binBandwidth;
      emit.bwHz         = v.binBandwidth * s.binCount;
      this._armSettle();
    }
    this.callbacks.onSpectrum(out, emit);
  }

  private _handleSpectrumMessage(msg: Record<string, unknown>) {
    if (msg.type === 'pong') {
      if (this.pingSentAt > 0) {
        const rtt = Date.now() - this.pingSentAt;
        this.pingSentAt = 0;
        this.rttAvg += 0.3 * (rtt - this.rttAvg);
        this.rttJit += 0.3 * (Math.abs(rtt - this.rttAvg) - this.rttJit);
      }
      return;
    }
    // Server replies with type:"config" — sent on connect and after every
    // zoom/pan/reset/set_rate (sendStatus in user_spectrum_websocket.go):
    //   { type:"config", centerFreq, binCount, binBandwidth, totalBandwidth }
    // This is the ONLY way the client learns binBandwidth (binary frames carry
    // just the centre frequency) — without it bwHz stays 0 and the entire
    // frequency→pixel mapping (needle, band plan, gestures) is dead.
    // V4 local hardware: FM RDS + stereo → reuse the OWRX metadata display path.
    if (msg.type === 'rds') {
      const ps = typeof msg.ps === 'string' ? msg.ps.trim() : '';
      const rt = typeof msg.radiotext === 'string' ? msg.radiotext.trim() : '';
      const stereo = msg.stereo === true;
      // PI (hex) + ECC → station country (for the flag + logo lookup), same as
      // the FM-DX backend. The shim sends pi (int, -1 = none) and ecc (0 = none).
      const pi = typeof msg.pi === 'number' && msg.pi >= 0
        ? msg.pi.toString(16).toUpperCase().padStart(4, '0') : undefined;
      const ecc = typeof msg.ecc === 'number' && msg.ecc > 0 ? msg.ecc : undefined;
      (this.callbacks as any).onMetadata?.({
        stationName: ps || undefined,
        text: rt || undefined,
        badge: ps ? 'RDS' : undefined,
        stereo,
        pi,
        countryIso: eccPiToIso(ecc, pi) || undefined,
      });
      return;
    }
    if (msg.type === 'hwinfo') {
      // VibeServer sent the serving device's tuner gains → populate the slider.
      if (Array.isArray(msg.gains)) this.callbacks.onHwGains?.(msg.gains as number[]);
      return;
    }
    if (msg.type === 'config') {
      // Local hardware advertises its full span here → cap zoom-out to it.
      if (typeof msg.maxBandwidth === 'number') this.maxSpanHz = msg.maxBandwidth;
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
      // binBandwidth change ⇒ the session may have migrated shared↔private,
      // which resets the server-side poll divisor — re-assert ours.
      if (this.status.binBandwidth !== this.lastRateBinBw) {
        this.lastRateBinBw = this.status.binBandwidth;
        if (this.rateDivisor > 1 && this.spectrumWs?.readyState === WebSocket.OPEN) {
          this.spectrumWs.send(JSON.stringify({ type: 'set_rate', divisor: this.rateDivisor }));
        }
      }
      // In flight: echoes of intermediate requests. Internal state above must
      // track them (frames are ordered after their config on the same TCP
      // stream, so decode geometry stays consistent), but they must NOT drive
      // the UI — the settle timer adopts the final state once sends go quiet.
      if (this._inFlight()) return;
      // UNSOLICITED geometry change (no request of ours in flight): a session
      // resurrection/reconnect can briefly put the server back at full-span
      // defaults — emitting that directly flashes the band plan/ticks to
      // 0–30MHz for a frame (the idle flicker bug). This phone is the only
      // client of its session, so the server losing our geometry is always a
      // reset, never another user's tune: keep the UI pinned and RE-ASSERT our
      // view (idempotent if the server already has it). The settle timer then
      // adopts whatever the server finally acks.
      const v = this.view;
      // A remote local shim (VibeServer) recentres its capture when the VFO tunes
      // out of the captured band and pushes a fresh config — same span, new
      // centre. That is a LEGITIMATE follow, not a session reset, so adopt it
      // rather than re-asserting our stale centre (which would snap the waterfall
      // back). Distinguish it by binBandwidth being unchanged (a reset reverts to
      // full-span defaults, changing binBandwidth).
      const sameSpan = v.binBandwidth > 0 &&
        Math.abs(this.status.binBandwidth - v.binBandwidth) <= v.binBandwidth * 1e-6;
      if (this.isLocal && sameSpan && Math.abs(this.status.centerHz - v.centerHz) > 1) {
        this.view.centerHz     = this.status.centerHz;
        this.view.binBandwidth = this.status.binBandwidth;
        this.callbacks.onStatus({ ...this.status });
        return;
      }
      const unsolicitedChange = v.binBandwidth > 0 &&
        (Math.abs(this.status.centerHz - v.centerHz) > 1 ||
         Math.abs(this.status.binBandwidth - v.binBandwidth) > v.binBandwidth * 1e-6);
      if (unsolicitedChange) {
        this.dbg(`unsolicited config (centre ${this.status.centerHz} bb ${this.status.binBandwidth}) — re-asserting view`);
        this._sendView(Math.round(v.centerHz), v.binBandwidth);
        return;
      }
      this.view.centerHz     = this.status.centerHz;
      this.view.binBandwidth = this.status.binBandwidth;
      this.callbacks.onStatus({ ...this.status });
    }
  }

  private _scheduleReconnect() {
    if (this.destroyed || this.pausedByApp) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this._openSpectrumWs();
    }, 3000);
  }
}
