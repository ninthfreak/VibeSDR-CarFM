/**
 * Apple Watch remote-view provider.
 *
 * The watch is a thin client. This module owns the whole phone->watch view path:
 * raw dBFS bins in, a VFO-centred 128-byte row out over WCSession.
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
      sendRow(rowB64: string, freq: number, span: number, snr: number, level: number): void;
      sendState(freq: number, mode: string, step: number): void;
      sendSettings(lutB64: string, smoothing: number): void;
    }
  | undefined;

/** Watch waterfall width. Must match WaterfallBuffer.width on the watch. */
const WATCH_BINS = 128;

/** Row cadence. A dropped row is invisible on a scrolling waterfall; a backed-up
 *  queue is visible lag — so we throttle at source rather than buffer. */
const MIN_ROW_MS = 100; // ~10fps

/** Span = demod bandwidth x this. Lands a signal on ~13 of the 128 bins: wide
 *  enough to read as a blob rather than a 2-bin hairline, tight enough to leave
 *  room for its neighbours. */
const SPAN_MULT = 10;

/** Fallback span when a backend reports no usable filter width. */
const DEFAULT_SPAN_HZ = 125_000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** RN has no dependable global btoa; 128 bytes makes this trivial anyway. */
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
  onMode(mode: string): void;
  onStep(hz: number): void;
  /** Watch app opened/closed. Used to keep the spectrum WS alive while the phone
   *  is locked but the watch is actually looking at it. */
  onReachableChange(reachable: boolean): void;
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
          case 'mode': handlers.onMode(String(e.val ?? '')); break;
          case 'step': handlers.onStep(Number(e.val ?? 0)); break;
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

  sendState(freq: number, mode: string, step: number) {
    if (!this.isActive) return;
    Native!.sendState(freq, mode, step);
  }

  /**
   * One raw dBFS spectrum frame, straight off the client. Safe to call while the
   * phone is backgrounded — it does no Skia, worklet or React work.
   */
  onSpectrum(bins: Float32Array, ctx: WatchFrameCtx) {
    if (!this.isActive) return;

    const now = Date.now();
    if (now - this.lastRowAt < MIN_ROW_MS) return; // coalesce: newest wins
    this.lastRowAt = now;

    if (this.colormap !== this.lastPalette) {
      this.lastPalette = this.colormap;
      Native!.sendSettings(toBase64(getColorLUT(this.colormap)), 0.35);
    }

    if (!bins || bins.length < 2 || !ctx.bwHz) return;

    // Same pipeline the phone's own waterfall runs (auto-range, brightness,
    // contrast, gain) -> 0-255. Only runs when a watch is actually watching.
    const row = this.proc.process(bins, ctx.centerHz, ctx.bwHz).row;
    const n = row.length;

    // Span follows the demod bandwidth so the signal is always a readable blob.
    const bw = Math.abs((ctx.filterHigh ?? 0) - (ctx.filterLow ?? 0));
    const span = Math.min(ctx.bwHz, (bw > 0 ? bw : DEFAULT_SPAN_HZ / SPAN_MULT) * SPAN_MULT);

    const binHz    = ctx.bwHz / n;
    const centreBin = (ctx.tuneHz - ctx.centerHz) / binHz + n / 2;
    const halfBins  = span / binHz / 2;
    const start     = centreBin - halfBins;
    const step      = (halfBins * 2) / WATCH_BINS;

    // Peak-preserving decimation: a narrow carrier must survive the squeeze to
    // 128 columns. Averaging would bury a CW tone in its own noise floor.
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

    Native!.sendRow(toBase64(this.out), ctx.tuneHz, span, this.snr, this.level);
  }
}

export const watchProvider = new WatchProvider();
