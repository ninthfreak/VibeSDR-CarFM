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
      sendState(freq: number, mode: string, step: number, meter: string,
                level: number): void;
      sendFmdx(json: string): void;
      sendStations(json: string): void;
      sendDab(json: string): void;
      sendAircraft(json: string): void;
      sendLogo(b64: string): void;
      sendSettings(lutB64: string, smoothing: number, needle: string,
                   needleIntensity: number, sharpness: number, peakHold: boolean): void;
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

/** Frequency echoes: ≤1 per this, trailing edge always delivered. 4/sec keeps the
 *  wrist tracking a phone-side tune without ever building a WCSession backlog. */
const STATE_MS = 250;

/** FM-DX state echoes. RDS text changes constantly; 4/sec reads as live and stays
 *  well clear of the WCSession backlog the row feed taught us about. */
const FMDX_MS = 250;

/** ADS-B tables churn — a couple of dozen aircraft, re-sent every few seconds. One
 *  per second is plenty for a wrist and can never build a WCSession backlog. */
const AIR_MS = 1000;

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
  /** DAB: pick an audio service out of the multiplex. Not a tune — DAB is a list. */
  onDabSelect?(id: number): void;
}

class WatchProvider {
  private available = Platform.OS === 'ios' && !!Native;
  private reachable = false;
  private lastRowAt = 0;
  private lastStateAt = 0;
  private pendingState: { freq: number; mode: string; step: number } | null = null;
  /** Last state we were asked to send — so a meter update can reuse it rather than
   *  opening a stream of its own. */
  private lastState: { freq: number; mode: string; step: number } | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPalette = '';
  private snr = 0;
  /** The meter string the PHONE is drawing right now (e.g. "S9+10", "-72dB",
   *  "18db"). Mirrored verbatim — see setSignal. */
  private meter = '';
  private level = 0;
  private lastFmdxAt = 0;
  private pendingFmdx: string | null = null;
  private fmdxTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAir = '';
  private lastAirAt = 0;
  private airTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDab = '';
  private sentDab = '\u0000';
  private lastStations = '';
  private sentStations = '\u0000';
  private lastLogo = '';   // what we WANT the watch to have
  private sentLogo = '\u0000';  // what it actually has (sentinel: never sent)
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
  private peakHold = true;
  setSharpness(v: number) {
    if (v === this.sharpness) return;
    this.sharpness = v;
    this.lastPalette = '';   // force a settings resend
  }

  /** Peak hold, mirrored from the phone — the wrist must not decide this for itself.
   *  Rides the (rare) settings message; toggling it forces a resend. */
  setPeakHold(on: boolean) {
    if (on === this.peakHold) return;
    this.peakHold = on;
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
          case 'zoom': handlers.onZoomDelta(Number(e.delta ?? 0)); break;
          case 'ping':
            handlers.onHello(); this.flushLogo(); this.flushStations(); this.flushDab();
            break;
          case 'dab':  handlers.onDabSelect?.(Number(e.val ?? 0)); break;
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
    if (r) { this.flushLogo(); this.flushStations(); this.flushDab(); }   // watch arrived with nothing
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
  // ── FM-DX ────────────────────────────────────────────────────────────────
  //
  // A DIFFERENT SCREEN, not a variant of the waterfall: FM-DX has no spectrum at
  // all, so on this backend the STATION is the content. The watch routes on the
  // message it last received, so nothing here needs to know about screens.
  //
  // Throttled + trailing, like the frequency and the meter. RDS RadioText changes
  // constantly and WCSession queues rather than drops.

  /** The whole FM-DX state as JSON. A string, not 12 bridge args: this shape will
   *  keep growing (PTY, TA, AF...), and a JSON blob absorbs that without touching
   *  the native bridge or the .m signature every time. It's ~200 bytes at 4/sec. */
  sendFmdx(state: {
    freq: number; ps: string; rt: string; pi: string; sig: number;
    users: number; stereo: boolean; tx: string; meter: string; level: number;
    pty: string; city: string; dist: number; flag: string; rx: string;
  }) {
    if (!this.isActive) return;
    this.pendingFmdx = JSON.stringify(state);
    const wait = this.lastFmdxAt + FMDX_MS - Date.now();
    if (wait <= 0) { this.flushFmdx(); return; }
    if (!this.fmdxTimer) {
      this.fmdxTimer = setTimeout(() => { this.fmdxTimer = null; this.flushFmdx(); }, wait);
    }
  }

  private flushFmdx() {
    const j = this.pendingFmdx;
    if (!j || !this.isActive) return;
    this.pendingFmdx = null;
    this.lastFmdxAt = Date.now();
    Native!.sendFmdx(j);
  }

  /** OWRX ADS-B: the live aircraft table.
   *
   *  Like DAB, this is a LIST, not a continuum — the profile IS the content and there
   *  is nothing to tune. Unlike DAB it CHURNS (a 20-aircraft table, re-sent every few
   *  seconds), so it's throttled like the meter rather than sent on change: WCSession
   *  queues rather than drops, and a wedged downlink is the price of forgetting that. */
  sendAircraft(list: unknown[]) {
    if (!this.isActive) return;
    this.lastAir = JSON.stringify(list);
    const wait = this.lastAirAt + AIR_MS - Date.now();
    if (wait <= 0) { this.flushAir(); return; }
    if (!this.airTimer) {
      this.airTimer = setTimeout(() => { this.airTimer = null; this.flushAir(); }, wait);
    }
  }

  private flushAir() {
    if (!this.isActive || !this.lastAir) return;
    this.lastAirAt = Date.now();
    Native!.sendAircraft(this.lastAir);
  }

  /** The DAB multiplex: the ensemble, its services, and which one is playing.
   *
   *  DAB is a LIST, not a continuum — the services arrive as an id->name map from
   *  the ensemble, and you switch with setAudioServiceId(), never by tuning. So the
   *  watch gets a list and a selection, and the crown becomes a SELECTOR rather than
   *  a tuning control. Sent on change only (the list changes when the mux does). */
  sendDab(state: { ensemble: string; active: number;
                   list: { id: number; name: string }[] }) {
    if (!this.available) return;
    this.lastDab = JSON.stringify(state);
    this.flushDab();
  }

  private flushDab() {
    if (!this.isActive || this.lastDab === this.sentDab) return;
    this.sentDab = this.lastDab;
    Native!.sendDab(this.lastDab);
  }

  /** The dial's station memory — the SAME list the phone's dial draws, so the wrist
   *  is a mirror rather than a second implementation. Tiny and rarely changes (a new
   *  entry when RDS names a station you tuned), so it goes on change only, with the
   *  same want-vs-have tracking as the logo: the watch usually arrives AFTER the
   *  list was built, and a list marked sent before the watch was there is a list
   *  that never arrives. */
  sendStations(list: { freqHz: number; name: string }[]) {
    if (!this.available) return;
    this.lastStations = JSON.stringify(list);
    this.flushStations();
  }

  private flushStations() {
    if (!this.isActive || this.lastStations === this.sentStations) return;
    this.sentStations = this.lastStations;
    Native!.sendStations(this.lastStations);
  }

  /** The station logo, as bytes. The phone has ALREADY resolved it to a local file
   *  (stationLogoCache) and drawn it — so we ship the same image rather than making
   *  the watch fetch a URL it has no network path to. Only on change: it's tens of
   *  KB, and the station changes about as often as you tune. */
  sendLogo(b64: string) {
    if (!this.available) return;
    this.lastLogo = b64;
    this.flushLogo();
  }

  /** Send the logo only once the watch is actually THERE.
   *
   *  It used to mark the logo as sent before checking reachability — so a station
   *  that resolved before the watch connected (the normal case: the phone has been
   *  tuned for a while, you then raise your wrist) was recorded as delivered and
   *  never actually went out. The wrist showed a permanently empty background.
   *  Track what we WANT the watch to have separately from what it HAS, and flush
   *  whenever the link comes up. */
  private flushLogo() {
    if (!this.isActive || this.lastLogo === this.sentLogo) return;
    this.sentLogo = this.lastLogo;
    Native!.sendLogo(this.lastLogo);
  }

  /**
   * MIRROR THE PHONE'S METER — don't pick a metric on the watch.
   *
   * The wrist used to render SNR specifically, and OWRX / Kiwi / FM-DX have no SNR
   * to give (they send an absolute S-meter or dBf, with no noise reference), so
   * SDRScreen sent a hardcoded 0 and the watch showed a permanent "—" — while the
   * bar underneath moved perfectly well, which is what made it look like a display
   * bug rather than a missing metric. So the phone sends the STRING IT IS ALREADY
   * DRAWING, and the watch prints it.
   *
   * It rides the SAME throttled state message as the frequency. It had its own, and
   * that was a mistake: two dict streams at 4/sec each, on top of the 16/sec rows,
   * flooded WCSession — which QUEUES rather than drops — and the DOWNLINK WEDGED.
   * (The uplink still worked, because a message from the watch always wakes the
   * phone: the wrist could tune but had gone deaf.) ONE channel, one throttle.
   */
  setSignal(snr: number, level: number, meter: string) {
    this.snr = snr;
    this.level = level;
    if (meter === this.meter) return;
    this.meter = meter;
    // Ride the ONE state channel, at its ONE throttle — never open a second stream.
    if (this.lastState) {
      this.sendFreq(this.lastState.freq, this.lastState.mode, this.lastState.step);
    }
  }

  sendState(freq: number, mode: string, step: number) {
    if (!this.isActive) return;
    this.lastStateAt = Date.now();
    Native!.sendState(freq, mode, step, this.meter, this.level);
  }

  /**
   * The FREQUENCY echo — throttled, trailing-edge, exactly like
   * UberSDRClient._sendView.
   *
   * The watch used to read the frequency off the ROWS, on the reasoning that every
   * row already carries it, so a separate echo would be redundant traffic. That is
   * true right up until the link is busy — and then it is badly wrong. Rows are
   * fire-and-forget at ~16/sec, and WCSession QUEUES rather than drops: spin the
   * crown and rows pile up behind the tune commands. The watch then reads its
   * frequency out of a row that is SECONDS old, so the readout lurches backwards
   * and then walks forward again as the backlog drains. (Backpressuring the rows to
   * stop that was tried and reverted — it made the waterfall 1fps. The rows are
   * right to be lossy; they are pixels. The frequency is not pixels.)
   *
   * So the frequency gets its own channel: a small state message, sent at most
   * once per STATE_MS, with the final value ALWAYS delivered on the trailing edge.
   * Because it is throttled it can never build a backlog, and because it is
   * trailing-edge the last thing the watch hears is always the truth.
   */
  sendFreq(freq: number, mode: string, step: number) {
    if (!this.isActive) return;
    this.lastState = { freq, mode, step };
    this.pendingState = { freq, mode, step };
    const wait = this.lastStateAt + STATE_MS - Date.now();
    if (wait <= 0) { this.flushState(); return; }
    if (!this.stateTimer) {
      this.stateTimer = setTimeout(() => { this.stateTimer = null; this.flushState(); }, wait);
    }
  }

  private flushState() {
    const p = this.pendingState;
    if (!p) return;
    this.pendingState = null;
    this.sendState(p.freq, p.mode, p.step);   // carries the meter too
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
                           this.needle, this.needleIntensity, this.sharpness,
                           this.peakHold);
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
