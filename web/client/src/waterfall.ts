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

  // Geometry of the last frame — used for click-to-tune and the axis.
  centerHz = 0;
  spanHz = 0;
  /** VFO marker position, Hz (drawn as the centre crosshair). */
  vfoHz = 0;
  /** Latest normalised spectrum trace + peak hold. */
  private spec: Float32Array | null = null;
  private peak: Float32Array | null = null;

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

  /** Feed one raw dBFS frame. */
  push(bins: Float32Array, centerHz: number, bwHz: number) {
    this.centerHz = centerHz;
    this.spanHz = bwHz;

    const frame = this.proc.process(bins, centerHz, bwHz);
    this.spec = frame.spec;
    this.peak = frame.peak;

    const W = this.wf.width;
    const H = this.wf.height;
    if (!W || !H || !this.rowImg) return;

    // Scroll down one pixel, then draw the new row at the top.
    this.wfCtx.drawImage(this.wf, 0, 1);

    const row = frame.row;
    const n = row.length;
    const img = this.rowImg.data;
    const lut = this.lut;

    for (let x = 0; x < W; x++) {
      // Peak-preserving downsample: take the max over this pixel's bin bucket.
      const b0 = Math.floor((x * n) / W);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / W));
      let v = 0;
      for (let b = b0; b < b1 && b < n; b++) if (row[b] > v) v = row[b];
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

    if (specH > 4 && this.spec) this._drawSpec(ctx, W, specH);
    this._drawVfo(ctx, W, H);
  }

  private _drawSpec(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const spec = this.spec!;
    const peak = this.peak;
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
      ctx.strokeStyle = 'rgba(255,245,200,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /** Vertical VFO crosshair at the tuned frequency. */
  private _drawVfo(ctx: CanvasRenderingContext2D, W: number, H: number) {
    if (!this.spanHz || !this.vfoHz) return;
    const x = this.hzToX(this.vfoHz, W);
    if (x < 0 || x > W) return;
    ctx.strokeStyle = 'rgba(255,229,102,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
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
