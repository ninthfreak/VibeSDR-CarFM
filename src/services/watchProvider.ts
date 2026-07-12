/**
 * Apple Watch remote-view provider.
 *
 * The watch is a thin client. This module owns the whole phone->watch view path:
 * raw dBFS bins in, a VFO-centred 256-byte row out over WCSession.
 *
 * IT RUNS OFF THE RAW SPECTRUM, NOT OFF THE WATERFALL COMPONENT. That is
 * deliberate and load-bearing: the PRIMARY use case is the phone locked in a
 * pocket, and on lock the app unmounts the Skia canvases and cancels every
 * animation driver, so anything hanging off WaterfallView is dead exactly when
 * the watch matters most. We therefore keep our own SignalProcessor, fed the same
 * settings the phone's renderer uses, so the wrist looks identical without
 * depending on a component that is deliberately torn down.
 *
 * Everything here must stay in the "safe to run while backgrounded" class: plain
 * JS plus one native bridge call. No Skia, no Reanimated/worklets, no per-frame
 * React state — those are what starved the audio DSP in the v6 regression.
 *
 * The palette travels as data: the phone's own 256-entry RGBA LUT, rather than
 * reimplementing 26 colour maps in Swift.
 *
 * Direction of truth: phone owns frequency/mode/step; the watch sends DELTAS and
 * mirrors whatever the phone echoes back.
 */
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { getColorLUT } from '../assets/colormapUtils';
import { SignalProcessor, type SignalProcessorSettings } from '../assets/signalProcessor';

const Native = NativeModules.VibeWatchModule as
  | {
      isReachable(): Promise<boolean>;
      sendRow(rowB64: string, freq: number, span: number, snr: number, level: number,
              lo: number, hi: number): void;
      sendState(freq: number, mode: string, step: number, volume: number): void;
      sendSettings(lutB64: string, smoothing: number, needle: string,
                   needleIntensity: number, sharpness: number): void;
    }
  | undefined;

/** Watch waterfall width. MUST MATCH WaterfallBuffer.width on the watch — the
 *  watch drops any row of the wrong length, so a mismatch is a blank waterfall.
 *
 *  256, not 128: the Ultra's screen is ~205pt wide, so 128 columns were being
 *  UPSCALED 1.6x before they even reached your eye — a self-inflicted blur that
 *  no amount of sharpening can undo. Above native width the image is downscaled
 *  instead, which is sharp. It costs 256 bytes a row (~1.3KB/s at 5fps). */
const WATCH_BINS = 256;

/** Row cadence: ~10fps of REAL data.
 *
 *  It was 5fps, on the theory that interpolation hides a low frame rate the way
 *  VibeServer's web client does. That conflated two different things:
 *  interpolation hides a low FRAME RATE, it cannot recover MISSING DATA. The
 *  synthesised in-between rows are linear blends of two real rows — they smooth
 *  the scroll but carry no information. At 5fps half the spectrum frames were
 *  simply discarded, and on SSB speech the energy genuinely changes on a ~100ms
 *  timescale: a syllable peeking up between two sampled frames was gone for good.
 *  The result looked fluid and read as mush.
 *
 *  (VibeServer gets away with 5fps because you're watching a broadcast signal
 *  that's essentially stationary. Hunting SSB conversations is the opposite case,
 *  and that is what the watch is FOR.)
 *
 *  MUST SIT WELL CLEAR OF BOTH SOURCE INTERVALS, not just under one.
 *
 *  It was 90ms — just under the ~100ms of the LOCKED feed (half-rate FFT). Any
 *  jitter (a frame landing 85ms after the last) failed the gate, so that row was
 *  dropped and the next one didn't arrive for 200ms. Locked, that gave an
 *  irregular ~8fps full of 200ms holes, which the jitter buffer and the trace's
 *  EMA then smoothed over — and it read exactly as "the averaging has been
 *  cranked right up". Awake (20fps source) a frame was always ready the instant
 *  the gate opened, so it was a rock-steady 10fps. Same gate, two behaviours.
 *
 *  At 60ms: the locked 100ms feed passes EVERY frame with room for jitter, and
 *  the awake 50ms feed still halves cleanly to ~10fps. */
const MIN_ROW_MS = 60;

/** Span = demod bandwidth x this. Lands a signal on ~25 of the 256 bins: wide
 *  enough to read as a blob rather than a 2-bin hairline, tight enough to leave
 *  room for its neighbours. */
const SPAN_MULT = 10;

/** Fallback span when a backend reports no usable filter width. */
const DEFAULT_SPAN_HZ = 125_000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RN has no dependable global btoa; a 256-byte row makes this trivial anyway. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < n ? B64[b2 & 63] : '=';
  }
  return out;
}

export interface WatchFrameCtx {
  centerHz:   number;
  bwHz:       number;
  tuneHz:     number;
  filterLow?: number;
  filterHigh?: number;
}

export interface WatchCommandHandlers {
  onTuneDelta(delta: number): void;
  /** Absolute tune from the watch numpad — the one non-delta command. */
  onTuneHz(hz: number): void;
  onMode(mode: string): void;
  onStep(hz: number): void;
  /** Crown in volume mode. Delta in detents; phone owns the 0..1 level. */
  onVolumeDelta(delta: number): void;
  /** Crown in zoom mode. Drives the REAL server zoom, so the watch gets finer
   *  bins rather than a magnified crop — the only thing that beats the
   *  bin-resolution ceiling. */
  onZoomDelta(delta: number): void;
  /** Watch app opened/closed. Used to keep the spectrum WS alive while the phone
   *  is locked but the watch is actually looking at it. */
  onReachableChange(reachable: boolean): void;
  /** The watch said hello (it pings on appear, on wake, and every 4s). Push the
   *  current state straight back, so its menu already knows the mode and step
   *  before the user opens it — state messages otherwise only fire when something
   *  CHANGES, which left the pickers blank for a couple of seconds. */
  onHello(): void;
}

class WatchProvider {
  private available = Platform.OS === 'ios' && !!Native;
  private reachable = false;
  private lastRowAt = 0;
  private lastPalette = '';
  private snr = 0;
  private level = 0;
  private out = new Uint8Array(WATCH_BINS);
  private emitter: NativeEventEmitter | null = null;
  private subs: { remove(): void }[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private proc = new SignalProcessor();
  private colormap = 'gqrx';
  private onReachable: ((r: boolean) => void) | null = null;

  /** When the phone's renderer last handed us a row.
   *
   *  This REPLACES a "phoneRendering" flag driven by AppState. A flag can desync
   *  — one resume path forgot to set it back to true, so the provider kept doing
   *  its own DSP while the phone was rendering, and both fought over the JS
   *  thread: the phone's waterfall went slow and jerky after every screen wake.
   *
   *  Recency can't desync. A row arriving from the renderer IS the proof that the
   *  renderer is alive; if none has arrived lately, the phone is asleep and we do
   *  our own DSP. Self-healing, no state machine. */
  private lastBorrowAt = 0;
  private get borrowing() { return Date.now() - this.lastBorrowAt < 1000; }

  /** The phone's acrylic-VFO settings, mirrored so the wrist needle is the same
   *  one the user configured — a hairline is invisible over a bright palette. */
  private needle = '#ffffff';
  private needleIntensity = 5;
  setNeedle(color: string, intensity: number) {
    if (color === this.needle && intensity === this.needleIntensity) return;
    this.needle = color;
    this.needleIntensity = intensity;
    this.lastPalette = '';   // force a settings resend
  }

  /** The phone applies sharpness in its SHADER, not in SignalProcessor — so the
   *  row we hand the watch is unsharpened and it must do its own. Mirror the
   *  setting so the two agree. */
  private sharpness = 0;
  setSharpness(v: number) {
    if (v === this.sharpness) return;
    this.sharpness = v;
    this.lastPalette = '';   // force a settings resend
  }

  /** True only when a watch app is actually in the foreground with a live link.
   *  Everything here no-ops otherwise, so a user with no watch pays nothing. */
  get isActive() { return this.available && this.reachable; }

  /** Mirror the phone renderer's own settings so the wrist looks the same. */
  setProcessorSettings(patch: Partial<SignalProcessorSettings>) {
    this.proc.applySettings(patch);
  }

  setColormap(name: string) { this.colormap = name; }

  /** Wire watch commands into the screen's existing tune/mode/step handlers. */
  attach(handlers: WatchCommandHandlers) {
    if (!this.available) return;
    this.detach();

    this.emitter = new NativeEventEmitter(NativeModules.VibeWatchModule);
    this.subs.push(
      this.emitter.addListener('VibeWatchCommand', (e: { cmd: string; delta?: number; val?: unknown }) => {
        switch (e.cmd) {
          case 'tune': handlers.onTuneDelta(Number(e.delta ?? 0)); break;
          case 'freq': handlers.onTuneHz(Number(e.val ?? 0)); break;
          case 'mode': handlers.onMode(String(e.val ?? '')); break;
          case 'step': handlers.onStep(Number(e.val ?? 0)); break;
          case 'vol':  handlers.onVolumeDelta(Number(e.delta ?? 0)); break;
          case 'zoom': handlers.onZoomDelta(Number(e.delta ?? 0)); break;
          case 'ping': handlers.onHello(); break;
        }
      }),
      this.emitter.addListener('VibeWatchState', (e: { reachable: boolean }) => {
        this.setReachable(!!e.reachable);
      }),
    );
    this.onReachable = handlers.onReachableChange;

    // Reachability flips when the watch app foregrounds/backgrounds, and the
    // delegate callback can be missed across an app relaunch — poll as a floor.
    // This is a plain timer with no React/Skia work, so it is safe to keep
    // running while the phone is locked (which is exactly when we need it: the
    // watch app is usually opened AFTER the phone is already in a pocket).
    void Native!.isReachable().then(r => this.setReachable(r)).catch(() => {});
    this.pollTimer = setInterval(() => {
      Native!.isReachable().then(r => this.setReachable(r)).catch(() => {});
    }, 2000);
  }

  private setReachable(r: boolean) {
    if (r === this.reachable) return;
    this.reachable = r;
    if (r) this.lastPalette = '';   // re-send palette on (re)connect
    this.onReachable?.(r);
  }

  detach() {
    this.subs.forEach(s => s.remove());
    this.subs = [];
    this.emitter = null;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.reachable = false;
  }

  /** Latest signal, mirrored from the meter bus. `level` is the already-smoothed,
   *  already-compressed 0..1 fill the phone's own meter draws — send it rather than
   *  the raw dB so the wrist bar and the phone bar move identically. */
  setSignal(snr: number, level: number) { this.snr = snr; this.level = level; }

  sendState(freq: number, mode: string, step: number, volume: number) {
    if (!this.isActive) return;
    Native!.sendState(freq, mode, step, volume);
  }

  /**
   * A row the phone's renderer ALREADY computed. Free to forward — no DSP — and
   * pixel-identical to what's on the phone screen. Used whenever the phone is
   * drawing (see `borrowing`).
   */
  pushProcessedRow(row: Uint8Array, ctx: WatchFrameCtx) {
    // Stamp BEFORE the isActive gate: this is how we know the renderer is alive,
    // and that must hold whether or not a watch is currently listening.
    this.lastBorrowAt = Date.now();
    if (!this.isActive) return;
    this.sendRow(row, ctx);
  }

  /**
   * One raw dBFS spectrum frame, straight off the client. This is the LOCKED-PHONE
   * path: the renderer is torn down, so there's no row to borrow and we must do
   * our own DSP. Safe to call while backgrounded — no Skia, worklet or React work.
   */
  onSpectrum(bins: Float32Array, ctx: WatchFrameCtx) {
    if (!this.isActive || this.borrowing) return;   // renderer is feeding us
    if (!bins || bins.length < 2 || !ctx.bwHz) return;

    // Cheap gate FIRST: don't pay for a 4096-bin pass on a frame we'd only drop.
    if (Date.now() - this.lastRowAt < MIN_ROW_MS) return;

    this.sendRow(this.proc.process(bins, ctx.centerHz, ctx.bwHz).row, ctx);
  }

  private sendRow(row: Uint8Array, ctx: WatchFrameCtx) {
    const now = Date.now();
    if (now - this.lastRowAt < MIN_ROW_MS) return; // coalesce: newest wins
    this.lastRowAt = now;

    if (this.colormap !== this.lastPalette) {
      this.lastPalette = this.colormap;
      Native!.sendSettings(toBase64(getColorLUT(this.colormap)), 0.35,
                           this.needle, this.needleIntensity, this.sharpness);
    }

    const n = row.length;
    if (n < 2 || !ctx.bwHz) return;

    const binHz = ctx.bwHz / n;

    // Span follows the demod bandwidth so the signal is always a readable blob.
    const bw = Math.abs((ctx.filterHigh ?? 0) - (ctx.filterLow ?? 0));
    const wanted = (bw > 0 ? bw : DEFAULT_SPAN_HZ / SPAN_MULT) * SPAN_MULT;

    // ...but NEVER crop below the source resolution. The watch can't be sharper
    // than the phone's bins: with the phone zoomed out each bin covers a lot of
    // Hz, so a narrow window may hold only ~20 real bins, and stretching those
    // across 256 columns just invents pixels — which is the blur, and no amount
    // of sharpening recovers detail that was never sampled. Better to show a
    // WIDER span that is genuinely sharp than a narrow one that is mush.
    const floorSpan = WATCH_BINS * binHz;
    const span = Math.min(ctx.bwHz, Math.max(wanted, floorSpan));

    const centreBin = (ctx.tuneHz - ctx.centerHz) / binHz + n / 2;
    const halfBins  = span / binHz / 2;
    const start     = centreBin - halfBins;
    const step      = (halfBins * 2) / WATCH_BINS;

    // Peak-preserving decimation: a narrow carrier must survive the squeeze to
    // 256 columns. Averaging would bury a CW tone in its own noise floor.
    for (let x = 0; x < WATCH_BINS; x++) {
      const s0 = start + x * step;
      const s1 = s0 + step;
      let i0 = Math.floor(s0);
      const i1 = Math.max(i0 + 1, Math.ceil(s1));
      let peak = 0;
      for (; i0 < i1; i0++) {
        // Clamp to the edges rather than wrapping — off-span reads as floor,
        // not as a phantom signal folded in from the far side of the band.
        const v = row[i0 < 0 ? 0 : i0 >= n ? n - 1 : i0];
        if (v > peak) peak = v;
      }
      this.out[x] = peak;
    }

    // Send the filter EDGES, not a width. The passband is only symmetric about
    // the carrier on AM/FM — LSB sits entirely below it, USB entirely above, CW
    // is offset — so a single bandwidth number would draw every mode as AM.
    Native!.sendRow(toBase64(this.out), ctx.tuneHz, span, this.snr, this.level,
                    ctx.filterLow ?? 0, ctx.filterHigh ?? 0);
  }
}

export const watchProvider = new WatchProvider();
