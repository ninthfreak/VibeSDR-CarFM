/**
 * waterfall.ts — canvas waterfall + spectrum trace (browser).
 *
 * This is the one load-bearing piece with no donor: the app renders its
 * waterfall in a Skia SkSL shader (WaterfallView.tsx), which doesn't port. The
 * DSP in front of it does, though — SignalProcessor and the palette LUTs are
 * imported from the app unchanged, so the picture matches the phone.
 *
 * Pipeline per frame:
 *   dBFS bins -> SignalProcessor (EMA, auto-range, peak hold) -> row: u8 0..255
 *             -> peak-preserving downsample to canvas width
 *             -> palette LUT -> ImageData row -> blit at top, scroll down
 *
 * Downsampling takes the MAX of each bucket, not the mean: at 4096 bins into
 * ~1200px a narrow carrier lands in one bin, and averaging would bury it in its
 * own noise floor. Peak-picking keeps it visible.
 */

import { SignalProcessor, type SignalProcessorSettings } from '../../../src/assets/signalProcessor';
import { getColorLUT } from '../../../src/assets/colormapUtils';

export interface WaterfallOpts {
  /** Fraction of the canvas given to the spectrum trace (0 = waterfall only). */
  specRatio?: number;
  palette?: string;
}

/** Spectrum share of the canvas. Never 1.0 — the waterfall must survive. */
function clampRatio(r: number): number {
  return Math.max(0, Math.min(0.8, r));
}

/** '#rrggbb' + alpha -> 'rgba(...)'. Mirrors the app's hexRgba(). */
function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Waterfall {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Off-screen waterfall image; blitted to the visible canvas each frame. */
  private wf: HTMLCanvasElement;
  private wfCtx: CanvasRenderingContext2D;

  private proc = new SignalProcessor();
  private lut: Uint8Array;
  private paletteName: string;

  private rowImg: ImageData | null = null;
  private specRatio: number;

  // ── Temporal line synthesis ────────────────────────────────────────────────
  // The waterfall scrolls at a FIXED rate regardless of how fast frames arrive:
  // between two received rows we synthesise the intermediate lines by blending
  // them. So a server throttled to 5fps still produces a smooth 20-rows/sec
  // waterfall instead of a chunky one — which is what makes the idle power
  // saving free rather than a trade.
  //
  // At 20fps in = 20 rows/sec out, exactly one row per frame and this is a no-op.
  private static readonly ROWS_PER_SEC = 20;
  private prevRow: Uint8Array | null = null;   // last received row
  private curRow: Uint8Array | null = null;    // newest received row
  private blendRow: Uint8Array | null = null;  // scratch for the synthesised line
  private lastArrival = 0;
  private emitStart = 0;
  private emitInterval = 0;   // ms between synthesised rows for this pair
  private emitTotal = 0;      // rows to synthesise between prev and cur
  private emitted = 0;

  // Geometry of the last frame — used for click-to-tune and the axis.
  centerHz = 0;
  spanHz = 0;
  /** Hook so the host can draw the dB axis over the spectrum region. */
  onDrawAxis: ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null = null;

  /** VFO marker position, Hz (the needle). */
  vfoHz = 0;
  /** Demod passband relative to the VFO, Hz — drives the acrylic sidebands.
   *  Negative low = below the carrier (SSB sits entirely on one side). */
  filterLow = 0;
  filterHigh = 0;

  /** Unlocked view only: the pan limits (beyond them is dead capture) and the RF
   *  centre — where the dongle actually is, vs where you're looking. Null = hide,
   *  which is what LOCK does. */
  wallLoHz: number | null = null;
  wallHiHz: number | null = null;
  rfCenterHz: number | null = null;

  /** VFO needle colour — also used for the peak-hold line, as in the app. */
  vfoColor = '#ff2020';
  /** 1–10 halo brightness (5 = the app's original look). */
  vfoIntensity = 5;
  /** 0–10 smoked-glass backing under the passband (0 = off). */
  vfoFrost = 0;
  /** Latest normalised spectrum trace + peak hold, and the previous pair — the
   *  trace is blended between them so it GLIDES between server frames instead of
   *  stepping. This matters more than the waterfall: slow waterfall rows just
   *  read as texture, but a live trace visibly jumps. */
  private spec: Float32Array | null = null;
  private peak: Float32Array | null = null;
  private prevSpec: Float32Array | null = null;
  private prevPeak: Float32Array | null = null;
  private drawSpec: Float32Array | null = null;
  private drawPeak: Float32Array | null = null;

  constructor(canvas: HTMLCanvasElement, opts: WaterfallOpts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.wf = document.createElement('canvas');
    this.wfCtx = this.wf.getContext('2d', { alpha: false })!;
    // Clamp here too: a bad value (e.g. a raw 0-60 slider position mistaken for a
    // fraction) would drive the waterfall height to zero and silently eat it.
    this.specRatio = clampRatio(opts.specRatio ?? 0.25);
    this.paletteName = opts.palette ?? 'gqrx';
    this.lut = getColorLUT(this.paletteName);
    this.resize();
  }

  setPalette(name: string) {
    this.paletteName = name;
    this.lut = getColorLUT(name);
    this.specGrad = null;   // gradient is built from the LUT — rebuild it
  }

  /** Vertical gradient sampled from the palette, so the spectrum trace is
   *  coloured by the same LUT as the waterfall: floor colour at the bottom,
   *  peak colour at the top. Cached — rebuilt only on palette/height change. */
  private specGrad: CanvasGradient | null = null;
  private specGradH = 0;

  private specGradient(ctx: CanvasRenderingContext2D, H: number): CanvasGradient {
    if (this.specGrad && this.specGradH === H) return this.specGrad;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    const lut = this.lut;
    const STOPS = 16;
    for (let i = 0; i <= STOPS; i++) {
      const t = i / STOPS;                 // 0 = top of trace (max signal)
      const o = Math.round((1 - t) * 255) << 2;
      g.addColorStop(t, `rgb(${lut[o]},${lut[o + 1]},${lut[o + 2]})`);
    }
    this.specGrad = g;
    this.specGradH = H;
    return g;
  }

  /** Palette colour at the top of the range — used for the trace outline. */
  private peakColour(): string {
    const o = 255 << 2;
    return `rgb(${this.lut[o]},${this.lut[o + 1]},${this.lut[o + 2]})`;
  }
  get palette() { return this.paletteName; }

  setSpecRatio(r: number) {
    this.specRatio = clampRatio(r);
    this.resize();
  }

  applySettings(patch: Partial<SignalProcessorSettings>) { this.proc.applySettings(patch); }
  getSettings(): SignalProcessorSettings { return this.proc.getSettings(); }
  getRange() { return this.proc.getRange(); }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    const wfH = Math.max(1, Math.round(h * (1 - this.specRatio)));

    // NB: do NOT early-out on canvas size alone. Changing the spectrum/waterfall
    // split leaves the canvas exactly the same size and only moves the boundary
    // inside it — an early-out here is what made the split slider do nothing.
    if (this.canvas.width === w && this.canvas.height === h
        && this.wf.height === wfH && this.wf.width === w) return;

    this.canvas.width = w;
    this.canvas.height = h;
    // Preserve history across a resize where we can — a re-layout shouldn't
    // wipe the waterfall.
    const old = this.wf.width && this.wf.height
      ? this.wfCtx.getImageData(0, 0, this.wf.width, this.wf.height) : null;
    this.wf.width = w;
    this.wf.height = wfH;
    this.wfCtx.fillStyle = '#000';
    this.wfCtx.fillRect(0, 0, w, wfH);
    if (old) {
      const tmp = document.createElement('canvas');
      tmp.width = old.width; tmp.height = old.height;
      tmp.getContext('2d')!.putImageData(old, 0, 0);
      this.wfCtx.drawImage(tmp, 0, 0, w, wfH);
    }
    this.rowImg = this.ctx.createImageData(w, 1);
  }

  /** Feed one raw dBFS frame. Rows are NOT drawn here — see tick(). */
  push(bins: Float32Array, centerHz: number, bwHz: number) {
    this.centerHz = centerHz;
    this.spanHz = bwHz;

    const frame = this.proc.process(bins, centerHz, bwHz);

    // Roll the trace: keep the OLD frame so draw() can blend towards the new one.
    if (!this.spec || this.spec.length !== frame.spec.length) {
      this.prevSpec = new Float32Array(frame.spec);
      this.prevPeak = new Float32Array(frame.peak);
      this.spec = new Float32Array(frame.spec);
      this.peak = new Float32Array(frame.peak);
      this.drawSpec = new Float32Array(frame.spec.length);
      this.drawPeak = new Float32Array(frame.peak.length);
    } else {
      this.prevSpec!.set(this.spec);
      this.prevPeak!.set(this.peak!);
      this.spec.set(frame.spec);
      this.peak!.set(frame.peak);
    }

    const now = performance.now();
    const row = frame.row;

    // Finish the previous pair before starting a new one, or a frame that arrives
    // slightly early silently eats its own lines and the waterfall stops scrolling.
    this.flushPending();

    // Roll cur -> prev, and copy in the new row (frame.row is a reused buffer).
    if (!this.curRow || this.curRow.length !== row.length) {
      this.prevRow = new Uint8Array(row);
      this.curRow = new Uint8Array(row);
      this.blendRow = new Uint8Array(row.length);
    } else {
      this.prevRow!.set(this.curRow);
      this.curRow.set(row);
    }

    // How many lines to synthesise before the next frame lands. Derived from the
    // OBSERVED arrival gap, so it adapts to whatever rate the server is running —
    // no need to be told, and it self-corrects across a throttle change.
    const gap = this.lastArrival ? now - this.lastArrival : 1000 / Waterfall.ROWS_PER_SEC;
    this.lastArrival = now;

    // Clamp: a stalled link mustn't queue up hundreds of lines to catch up on.
    const clamped = Math.max(20, Math.min(1000, gap));
    this.emitTotal = Math.max(1, Math.round(clamped / (1000 / Waterfall.ROWS_PER_SEC)));
    this.emitInterval = clamped / this.emitTotal;
    this.emitStart = now;
    this.emitted = 0;
  }

  /** Emit any waterfall lines now due. Call once per animation frame.
   *  At 20fps in this draws exactly one row per frame (emitTotal === 1) and the
   *  blending collapses to a straight copy of the newest row. */
  tick() {
    if (!this.curRow || !this.prevRow) return;
    const now = performance.now();
    let guard = 0;
    while (
      this.emitted < this.emitTotal &&
      // Row k is due at emitStart + k*interval, k starting at 0 — so the FIRST row
      // lands the moment the frame arrives. (Anchoring it a full interval later
      // meant that at 20fps the row became due exactly as the next frame reset the
      // counter, so it was never drawn and the waterfall crawled.)
      now >= this.emitStart + this.emitted * this.emitInterval &&
      guard++ < 8                       // never spend a whole frame catching up
    ) {
      this.emitted++;
      this.drawRow(this.emitted / this.emitTotal);
    }
  }

  /** Draw any rows still owed for the current pair. Called when a new frame
   *  arrives, so every pair contributes exactly emitTotal lines. */
  private flushPending() {
    let guard = 0;
    while (this.emitted < this.emitTotal && guard++ < 8) {
      this.emitted++;
      this.drawRow(this.emitted / this.emitTotal);
    }
  }

  /** Scroll down one line and draw the row blended t of the way from prev to cur. */
  private drawRow(t: number) {
    const W = this.wf.width;
    const H = this.wf.height;
    if (!W || !H || !this.rowImg) return;

    const prev = this.prevRow!;
    const cur = this.curRow!;
    const blend = this.blendRow!;
    const n = cur.length;

    if (t >= 1) {
      blend.set(cur);
    } else {
      const a = Math.round(t * 256);
      const b = 256 - a;
      for (let i = 0; i < n; i++) blend[i] = (prev[i] * b + cur[i] * a) >> 8;
    }

    this.wfCtx.drawImage(this.wf, 0, 1);   // scroll

    const img = this.rowImg.data;
    const lut = this.lut;
    for (let x = 0; x < W; x++) {
      // Peak-preserving downsample: take the max over this pixel's bin bucket.
      // Averaging would bury a narrow carrier in its own noise floor.
      const b0 = Math.floor((x * n) / W);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / W));
      let v = 0;
      for (let bi = b0; bi < b1 && bi < n; bi++) if (blend[bi] > v) v = blend[bi];
      const o = v << 2;
      const p = x << 2;
      img[p]     = lut[o];
      img[p + 1] = lut[o + 1];
      img[p + 2] = lut[o + 2];
      img[p + 3] = 255;
    }
    this.wfCtx.putImageData(this.rowImg, 0, 0);
  }

  /** Composite waterfall + spectrum trace + markers to the visible canvas. */
  draw() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W || !H) return;
    const ctx = this.ctx;
    const specH = H - this.wf.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, specH);
    ctx.drawImage(this.wf, 0, specH);

    if (specH > 4 && this.spec) {
      this._drawSpec(ctx, W, specH);
      this.onDrawAxis?.(ctx, W, specH);   // dB axis, drawn by main (owns the labels)
    }
    this._drawVfo(ctx, W, H);
  }

  /** Trace blended prev->cur by elapsed time. Runs at the display's refresh rate,
   *  NOT the server's frame rate, so at 5fps the trace glides instead of jumping.
   *  At 20fps the blend completes within a frame and it looks as it did before. */
  private interpolatedTrace(): { spec: Float32Array; peak: Float32Array } {
    const spec = this.spec!;
    const peak = this.peak!;
    const prevSpec = this.prevSpec;
    const prevPeak = this.prevPeak;
    const ds = this.drawSpec;
    const dp = this.drawPeak;
    if (!prevSpec || !prevPeak || !ds || !dp || !this.emitInterval) return { spec, peak };

    const span = this.emitInterval * this.emitTotal;   // observed gap between frames
    const t = Math.max(0, Math.min(1, (performance.now() - this.emitStart) / span));
    if (t >= 1) return { spec, peak };

    for (let i = 0; i < spec.length; i++) ds[i] = prevSpec[i] + (spec[i] - prevSpec[i]) * t;
    // Peak hold only rises — take the max, so an interpolated peak line never dips
    // below the peak it is meant to be holding.
    for (let i = 0; i < peak.length; i++) dp[i] = Math.max(prevPeak[i], peak[i]);
    return { spec: ds, peak: dp };
  }

  private _drawSpec(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const { spec, peak } = this.interpolatedTrace();
    const n = spec.length;

    // Trace, filled to the floor — same shape as the app's signal display.
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x < W; x++) {
      const b0 = Math.floor((x * n) / W);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / W));
      let v = 0;
      for (let b = b0; b < b1 && b < n; b++) if (spec[b] > v) v = spec[b];
      ctx.lineTo(x, H - v * H);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    // Filled from the palette LUT, like the app: the trace is shaded by the same
    // colours the waterfall uses, so a signal reads the same in both halves.
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = this.specGradient(ctx, H);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.peakColour();
    ctx.lineWidth = 1;
    ctx.stroke();

    if (peak) {
      ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const b0 = Math.floor((x * n) / W);
        const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / W));
        let v = 0;
        for (let b = b0; b < b1 && b < n; b++) if (peak[b] > v) v = peak[b];
        const y = H - v * H;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // Peak-hold line takes the VFO colour, matching the app (WaterfallView
      // peakPaint: needleColor at 0.85, blur 2).
      ctx.strokeStyle = rgba(this.vfoColor, 0.85);
      ctx.shadowColor = rgba(this.vfoColor, 0.85);
      ctx.shadowBlur = 2;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  /**
   * VFO needle + acrylic sidebands — ported 1:1 from the app's WaterfallView
   * (:798 geometry, :847 glow strips, :1007 acrylic gradients).
   *
   * The sidebands are the point: they show the PASSBAND sitting on the signal, so
   * bandwidth is something you see rather than a number you read.
   *
   * The app renders the halo with a Skia MaskFilter, which blurs the stroke
   * ITSELF — and its own comment notes that canvas shadowBlur instead glows
   * BEHIND a sharp stroke, which is the original v1 look it was imitating. We're
   * in canvas, so we get the v1 semantics for free: blurred halo + razor hairline.
   */
  private _drawVfo(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (!this.spanHz || !this.vfoHz) return;

    const nX = this.hzToX(this.vfoHz, W);
    let loX = this.hzToX(this.vfoHz + this.filterLow, W);
    let hiX = this.hzToX(this.vfoHz + this.filterHigh, W);

    // Keep the sidebands visible when zoomed out — a passband narrower than a few
    // pixels would otherwise vanish entirely.
    const minSb = (this.filterLow === 0 && this.filterHigh === 0) ? 20 : 4;
    if (nX - loX < minSb) loX = nX - minSb;
    if (hiX - nX < minSb) hiX = nX + minSb;
    const loXc = Math.max(0, loX);
    const hiXc = Math.min(W, hiX);

    const col = this.vfoColor;
    const k = this.vfoIntensity / 5;          // 5 = the app's original look
    const wk = Math.max(1, k);

    ctx.save();

    // Frosted backing: dims the waterfall across the passband so the needle keeps
    // contrast on bright palettes, whatever colour it is.
    if (this.vfoFrost > 0 && hiXc > loXc) {
      ctx.fillStyle = `rgba(0,0,0,${(this.vfoFrost / 10) * 0.72})`;
      ctx.fillRect(loXc, 0, hiXc - loXc, H);
    }

    // Acrylic sideband panels — 4-stop gradients rising toward the needle.
    if (nX > loXc) {
      const g = ctx.createLinearGradient(loXc, 0, nX, 0);
      g.addColorStop(0,    rgba(col, 0.03));
      g.addColorStop(0.15, rgba(col, 0.06));
      g.addColorStop(0.55, rgba(col, 0.14));
      g.addColorStop(1,    rgba(col, 0.28));
      ctx.fillStyle = g;
      ctx.fillRect(loXc, 0, nX - loXc, H);
    }
    if (hiXc > nX) {
      const g = ctx.createLinearGradient(nX, 0, hiXc, 0);
      g.addColorStop(0,    rgba(col, 0.28));
      g.addColorStop(0.45, rgba(col, 0.14));
      g.addColorStop(0.85, rgba(col, 0.06));
      g.addColorStop(1,    rgba(col, 0.03));
      ctx.fillStyle = g;
      ctx.fillRect(nX, 0, hiXc - nX, H);
    }

    // Sideband edges: soft glow + crisp acrylic line (both at 0.35).
    const edge = (x: number) => {
      if (x <= 0 || x >= W) return;
      ctx.strokeStyle = rgba(col, 0.35);
      ctx.lineWidth = Math.max(0.75, 0.75);
      ctx.shadowColor = rgba(col, 0.35);
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.stroke();          // razor line on top of the halo
    };
    edge(loX);
    edge(hiX);

    this._drawWalls(ctx, W, H);
    this._drawRfCentre(ctx, W, H);

    // LED needle: three glow layers (28/16/6) + a crisp core filament.
    if (nX >= 0 && nX <= W) {
      const layer = (alpha: number, blur: number, sw: number) => {
        ctx.strokeStyle = rgba(col, Math.min(1, alpha));
        ctx.lineWidth = sw;
        ctx.shadowColor = rgba(col, Math.min(1, alpha));
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(nX + 0.5, 0);
        ctx.lineTo(nX + 0.5, H);
        ctx.stroke();
      };
      layer(0.35 * k, 28, 1.5 * wk);   // outer halo
      layer(0.70 * k, 16, 0.8 * wk);   // mid glow
      layer(0.80 * k, 6,  0.8 * wk);   // filament glow
      ctx.shadowBlur = 0;
      ctx.strokeStyle = col;           // crisp core
      ctx.lineWidth = 0.75 * wk;
      ctx.beginPath();
      ctx.moveTo(nX + 0.5, 0);
      ctx.lineTo(nX + 0.5, H);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Pan boundary walls — solid edge + a dim veil over the unreachable zone.
   *  Only meaningful when the view is unlocked; LOCK keeps you centred anyway. */
  private _drawWalls(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.wallLoHz == null && this.wallHiHz == null) return;
    ctx.save();
    if (this.wallLoHz != null) {
      const x = this.hzToX(this.wallLoHz, W);
      if (x > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, Math.min(x, W), H);
        ctx.fillStyle = 'rgba(255,200,80,0.85)';
        ctx.fillRect(x - 0.75, 0, 1.5, H);
      }
    }
    if (this.wallHiHz != null) {
      const x = this.hzToX(this.wallHiHz, W);
      if (x < W) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(Math.max(0, x), 0, W - Math.max(0, x), H);
        ctx.fillStyle = 'rgba(255,200,80,0.85)';
        ctx.fillRect(x - 0.75, 0, 1.5, H);
      }
    }
    ctx.restore();
  }

  /** RF-centre marker — a thin dashed line where the DONGLE is tuned, which is
   *  not where you're looking once the view is unlocked. */
  private _drawRfCentre(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (this.rfCenterHz == null) return;
    const x = this.hzToX(this.rfCenterHz, W);
    if (x < 0 || x > W) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(120,200,255,0.75)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
    ctx.restore();
  }

  // ── Geometry helpers (shared with click-to-tune / drag-to-pan) ─────────────

  hzToX(hz: number, W = this.canvas.width): number {
    const lo = this.centerHz - this.spanHz / 2;
    return ((hz - lo) / this.spanHz) * W;
  }

  /** CSS pixel x -> Hz. */
  xToHz(cssX: number): number {
    const lo = this.centerHz - this.spanHz / 2;
    const frac = cssX / Math.max(1, this.canvas.clientWidth);
    return lo + frac * this.spanHz;
  }

  /** Hz per CSS pixel — for drag-to-pan. */
  hzPerPx(): number {
    return this.spanHz / Math.max(1, this.canvas.clientWidth);
  }
}
