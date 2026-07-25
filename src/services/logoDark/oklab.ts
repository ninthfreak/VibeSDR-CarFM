// oklab.ts — sRGB ⇄ OKLab/OKLCh colour maths for the dark-mode logo pipeline.
//
// Pure TypeScript, ZERO framework imports (no Skia, no RN) so the whole colour
// core is unit-testable in plain Node. Everything downstream (checkerboard
// detect, keying, remap, gate) reasons in OKLab, because that is the only space
// where "change lightness, keep the brand hue" is a straight-line operation.
//
// Reference: Björn Ottosson's OKLab (https://bottosson.github.io/posts/oklab/).
// The handoff (HANDOFF_1.md) works in OKLCh and states one hard rule — HUE IS
// NEVER MODIFIED. We honour that by operating on (L, a, b): scaling chroma is
// `a,b *= k` (direction, i.e. hue, is preserved), and chroma itself is hypot(a,b).
// We only ever touch L or the magnitude of (a,b), never their angle.

/** A decoded, straight-alpha, **sRGB** image. rgba is width*height*4 bytes,
 *  R,G,B,A order, 0..255, UN-premultiplied — the exact contract the Skia I/O
 *  layer produces (drawn onto an sRGB surface, read as RGBA_8888/Unpremul). */
export type Raster = { w: number; h: number; rgba: Uint8ClampedArray };

/** Per-pixel OKLab planes (length w*h each). L in [0,1]; a,b unbounded but
 *  small (|a|,|b| < ~0.4 for in-gamut sRGB). Alpha kept separately in `alpha`
 *  (0..1) so the colour maths never has to worry about it. */
export type LabPlanes = { w: number; h: number; L: Float32Array; a: Float32Array; b: Float32Array; alpha: Float32Array };

// ── sRGB gamma ⇄ linear (8-bit LUT for the hot path) ────────────────────────
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear (0..1) → 8-bit sRGB (0..255), rounded & clamped. */
export function linearToSrgb8(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  const v = Math.round(c * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ── linear sRGB ⇄ OKLab (Ottosson matrices) ─────────────────────────────────
function linearToLab(r: number, g: number, b: number): [number, number, number] {
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l = Math.cbrt(l_), m = Math.cbrt(m_), s = Math.cbrt(s_);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// ── scalar helpers (used by tests + single-colour work like checkerboard) ────
/** One 8-bit sRGB triple → OKLab. */
export function srgb8ToLab(r: number, g: number, b: number): [number, number, number] {
  return linearToLab(SRGB_TO_LINEAR[r], SRGB_TO_LINEAR[g], SRGB_TO_LINEAR[b]);
}

function unitToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** One sRGB triple in the **unit** range [0,1] → OKLab. Used for continuous
 *  colours the pipeline computes rather than reads (median backgrounds, the
 *  theme background colour). */
export function srgbUnitToLab(r: number, g: number, b: number): [number, number, number] {
  return linearToLab(unitToLinear(r), unitToLinear(g), unitToLinear(b));
}

/** Euclidean OKLab distance between two OKLab triples — the "within 0.0x"
 *  colour-match metric the handoff's keying/checkerboard thresholds use. */
export function labDist(a: [number, number, number], b: [number, number, number]): number {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** One OKLab triple → 8-bit sRGB (clamped; out-of-gamut is clipped per-channel). */
export function labToSrgb8(L: number, a: number, b: number): [number, number, number] {
  const [lr, lg, lb] = labToLinear(L, a, b);
  return [linearToSrgb8(lr), linearToSrgb8(lg), linearToSrgb8(lb)];
}

/** OKLCh chroma from (a,b). Hue is atan2(b,a); we rarely need the angle, only
 *  this magnitude, since the pipeline classifies "neutral" by low chroma. */
export function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

// ── bulk conversion (the hot path: whole-image, once) ───────────────────────
/** Decode an sRGB RGBA raster into OKLab planes + straight alpha (0..1). */
export function rasterToLab(img: Raster): LabPlanes {
  const n = img.w * img.h;
  const L = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n), alpha = new Float32Array(n);
  const px = img.rgba;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [Ll, aa, bb] = linearToLab(SRGB_TO_LINEAR[px[j]], SRGB_TO_LINEAR[px[j + 1]], SRGB_TO_LINEAR[px[j + 2]]);
    L[i] = Ll; a[i] = aa; b[i] = bb; alpha[i] = px[j + 3] / 255;
  }
  return { w: img.w, h: img.h, L, a, b, alpha };
}

/** Re-encode OKLab planes + alpha back into an sRGB RGBA raster. */
export function labToRaster(p: LabPlanes): Raster {
  const n = p.w * p.h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [lr, lg, lb] = labToLinear(p.L[i], p.a[i], p.b[i]);
    rgba[j] = linearToSrgb8(lr); rgba[j + 1] = linearToSrgb8(lg); rgba[j + 2] = linearToSrgb8(lb);
    rgba[j + 3] = Math.round(p.alpha[i] * 255);
  }
  return { w: p.w, h: p.h, rgba };
}
