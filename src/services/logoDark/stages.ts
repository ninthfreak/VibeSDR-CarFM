// stages.ts — the five pipeline stages from HANDOFF_1.md, ported to operate on
// an sRGB Raster. Constants come from the DOCUMENT, not pipeline.py (the doc is
// explicit that its values win over the file's stale signatures — notably
// neutral chroma is 0.03, not the 0.045 in remap4's signature).
//
//   1 flattenCheckerboard  collapse a baked-in transparency checkerboard
//   2 trim                 crop uniform border padding
//   3 keyBackground        flood the border-connected background to alpha 0
//   4 route                coverage → which treatment family
//   5 remap / halo / plate / gate
//
// Design choices that matter for the rest of the app:
//   • remap/halo/as-is yield processed PIXELS (a Raster). `plate` is a container
//     style (grey rounded rect behind the ORIGINAL logo) rendered by RN, not
//     baked here — sharper vector corners, and the doc wants it dimmable per
//     theme. So a plate Candidate carries params, not a raster transform.
//   • remap REPORTS `sank` (pixels it deliberately darkened into the bg) so the
//     gate does not penalise it for working correctly (§5d).

import {
  type Raster, srgb8ToLab, srgbUnitToLab, labToSrgb8, chroma, labDist,
} from './oklab';
import { borderConnectedMask, connectedComponents } from './labeling';
import { boxBlur } from './blur';

export type Treatment = 'remap' | 'halo' | 'as-is' | 'plate';
export type PlateParams = { padFrac: number; radiusFrac: number; fill: [number, number, number] };
export type Candidate = {
  treatment: Treatment;
  /** Pixels to display (remap/halo/as-is). Absent for `plate`. */
  raster?: Raster;
  /** Rounded-plate params (plate only). */
  plate?: PlateParams;
};

const packRGB = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

// ── Stage 1: flattenCheckerboard ────────────────────────────────────────────
export type CheckerInfo = { detected: boolean; cell?: number; note: string };

/** Detect a baked-in editor checkerboard (two near-neutral colours in a
 *  periodic grid) and, if found, flatten colour B into colour A so stage 3 sees
 *  a uniform background. Returns a NEW raster when it acts; the same one else. */
export function flattenCheckerboard(img: Raster): { raster: Raster; info: CheckerInfo } {
  const n = img.w * img.h, px = img.rgba;
  // Count exact opaque colours.
  const counts = new Map<number, number>();
  let opaque = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (px[j + 3] < 128) continue;
    opaque++;
    const key = packRGB(px[j], px[j + 1], px[j + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (opaque === 0) return { raster: img, info: { detected: false, note: 'fully transparent' } };
  // Top two by frequency.
  let a = -1, b = -1, ca = 0, cb = 0;
  for (const [k, c] of counts) {
    if (c > ca) { b = a; cb = ca; a = k; ca = c; }
    else if (c > cb) { b = k; cb = c; }
  }
  if (b < 0) return { raster: img, info: { detected: false, note: 'single colour' } };

  const colA: [number, number, number] = [(a >> 16) & 255, (a >> 8) & 255, a & 255];
  const colB: [number, number, number] = [(b >> 16) & 255, (b >> 8) & 255, b & 255];
  const labA = srgb8ToLab(colA[0], colA[1], colA[2]);
  const labB = srgb8ToLab(colB[0], colB[1], colB[2]);

  // Both near-neutral, cover ≥40% together, ≥10% for B alone, |ΔL| ≥ 0.02.
  const chA = chroma(labA[1], labA[2]), chB = chroma(labB[1], labB[2]);
  const fail = (why: string): { raster: Raster; info: CheckerInfo } => ({ raster: img, info: { detected: false, note: why } });
  if (chA >= 0.05 || chB >= 0.05) return fail('colours not neutral');
  if ((ca + cb) / opaque < 0.40) return fail('top-2 cover <40%');
  if (cb / opaque < 0.10) return fail('2nd colour <10%');
  if (Math.abs(labA[0] - labB[0]) < 0.02) return fail('ΔL <0.02 (one flat bg)');

  // Periodicity: modal run-length of the B-mask along sampled rows AND columns,
  // ignoring runs <4px, must both exist and be EQUAL — the checkerboard signature.
  const isB = (i: number) => px[i * 4] === colB[0] && px[i * 4 + 1] === colB[1] && px[i * 4 + 2] === colB[2];
  const rowMode = modalRun(img.w, img.h, true, isB);
  const colMode = modalRun(img.w, img.h, false, isB);
  if (rowMode === 0 || colMode === 0 || rowMode !== colMode) return fail(`no matching period (row=${rowMode} col=${colMode})`);

  // Flatten: every pixel within 0.02 OKLab of B → colour A.
  const out = new Uint8ClampedArray(px);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (px[j + 3] < 128) continue;
    if (labDist(srgb8ToLab(px[j], px[j + 1], px[j + 2]), labB) <= 0.02) {
      out[j] = colA[0]; out[j + 1] = colA[1]; out[j + 2] = colA[2];
    }
  }
  return { raster: { w: img.w, h: img.h, rgba: out }, info: { detected: true, cell: rowMode, note: `${rowMode}px cell` } };
}

/** Modal run-length of a boolean predicate along rows (horizontal=true) or
 *  columns, sampling up to 64 lines, ignoring runs <4px. 0 if none. */
function modalRun(w: number, h: number, horizontal: boolean, pred: (i: number) => boolean): number {
  const lines = horizontal ? h : w, span = horizontal ? w : h;
  const step = Math.max(1, Math.floor(lines / 64));
  const hist = new Map<number, number>();
  for (let l = 0; l < lines; l += step) {
    let run = 0;
    for (let s = 0; s < span; s++) {
      const i = horizontal ? l * w + s : s * w + l;
      if (pred(i)) run++;
      else { if (run >= 4) hist.set(run, (hist.get(run) ?? 0) + 1); run = 0; }
    }
    if (run >= 4) hist.set(run, (hist.get(run) ?? 0) + 1);
  }
  let best = 0, bestC = 0;
  for (const [len, c] of hist) if (c > bestC) { best = len; bestC = c; }
  return best;
}

// ── Stage 2: trim ───────────────────────────────────────────────────────────
export type Bbox = { x0: number; y0: number; x1: number; y1: number };

/** Crop uniform border padding. Content = differs from the corner-median by
 *  >0.04 in any channel, OR is already (partially) transparent. */
export function trim(img: Raster): { raster: Raster; bbox: Bbox } {
  const { w, h, rgba: px } = img;
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const j = (y * w + x) * 4; return [px[j] / 255, px[j + 1] / 255, px[j + 2] / 255] as [number, number, number];
  });
  const med = [0, 1, 2].map((c) => { const s = corners.map((v) => v[c]).sort((a, b) => a - b); return (s[1] + s[2]) / 2; });

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      const transparent = px[j + 3] < 250;
      const diff = Math.max(Math.abs(px[j] / 255 - med[0]), Math.abs(px[j + 1] / 255 - med[1]), Math.abs(px[j + 2] / 255 - med[2]));
      if (transparent || diff > 0.04) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { raster: img, bbox: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 } };  // all uniform
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return { raster: img, bbox: { x0, y0, x1, y1 } };
  return { raster: crop(img, x0, y0, x1, y1), bbox: { x0, y0, x1, y1 } };
}

function crop(img: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = ((y + y0) * img.w + x0) * 4, dstRow = y * w * 4;
    out.set(img.rgba.subarray(srcRow, srcRow + w * 4), dstRow);
  }
  return { w, h, rgba: out };
}

// ── Stage 3: keyBackground (border-connected only) ──────────────────────────
export type KeyInfo = { keyed: boolean; coverage: number; bg: [number, number, number]; note: string };

/** Flood the border-connected background to alpha 0, feather, decontaminate.
 *  Returns a NEW raster (or the same if it aborts) plus coverage = opaque
 *  fraction afterwards (the routing input). */
export function keyBackground(img: Raster): { raster: Raster; info: KeyInfo } {
  const { w, h, rgba: px } = img, n = w * h;

  // Median border colour (sRGB unit, per channel).
  const bs: number[][] = [[], [], []];
  const addBorder = (x: number, y: number) => { const j = (y * w + x) * 4; bs[0].push(px[j] / 255); bs[1].push(px[j + 1] / 255); bs[2].push(px[j + 2] / 255); };
  for (let x = 0; x < w; x++) { addBorder(x, 0); addBorder(x, h - 1); }
  for (let y = 0; y < h; y++) { addBorder(0, y); addBorder(w - 1, y); }
  const bg = bs.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; }) as [number, number, number];
  const bgLab = srgbUnitToLab(bg[0], bg[1], bg[2]);

  // Need ≥3 of 4 corners within 0.05 OKLab of bg, else abort.
  const cornerOk = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].filter(([x, y]) => {
    const j = (y * w + x) * 4;
    return labDist(srgb8ToLab(px[j], px[j + 1], px[j + 2]), bgLab) <= 0.05;
  }).length;
  const coverageOf = (r: Raster) => { let o = 0; for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i] >= 128) o++; return o / (r.w * r.h); };
  if (cornerOk < 3) return { raster: img, info: { keyed: false, coverage: coverageOf(img), bg, note: 'corners disagree — left opaque' } };

  // Mask pixels within 0.10 of bg, keep only border-connected.
  const near = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (px[j + 3] < 128) { near[i] = 1; continue; }   // already transparent counts as bg
    if (labDist(srgb8ToLab(px[j], px[j + 1], px[j + 2]), bgLab) <= 0.10) near[i] = 1;
  }
  const bgMask = borderConnectedMask(near, w, h);
  let removed = 0; for (let i = 0; i < n; i++) removed += bgMask[i];
  const frac = removed / n;
  if (frac > 0.92 || frac < 0.02) {
    return { raster: img, info: { keyed: false, coverage: coverageOf(img), bg, note: `region ${(frac * 100) | 0}% out of [2,92]% — left opaque` } };
  }

  // Alpha 0 on the masked region, then feather + decontaminate.
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = bgMask[i] ? 0 : px[i * 4 + 3] / 255;
  const blurred = boxBlur(alpha, w, h, 1, 3);
  const out = new Uint8ClampedArray(px);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let a = (blurred[i] - 0.25) / 0.5;               // remap clamp((a-0.25)/0.5,0,1)
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    // Decontaminate partial-alpha pixels: rgb = (rgb - bg*(1-a)) / max(a,0.08).
    if (a > 0.001 && a < 0.999) {
      const d = Math.max(a, 0.08);
      for (let c = 0; c < 3; c++) {
        const v = (px[j + c] / 255 - bg[c] * (1 - a)) / d;
        out[j + c] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
      }
    }
    out[j + 3] = Math.round(a * 255);
  }
  const raster = { w, h, rgba: out };
  return { raster, info: { keyed: true, coverage: coverageOf(raster), bg, note: `keyed ${(frac * 100) | 0}% of pixels` } };
}

// ── Stage 4: route ──────────────────────────────────────────────────────────
export function route(coverage: number): Treatment[] {
  return coverage > 0.80 ? ['halo', 'as-is'] : ['remap', 'halo'];
}

// ── Stage 5a: remap ─────────────────────────────────────────────────────────
/** OKLCh lightness remap that keeps brand hue. Two steps (HANDOFF_2 §5a):
 *   1. CLEAR THE PAPER to transparency — light near-neutral ink (letter
 *      counters, ring gaps) fades to alpha 0 via a per-pixel lightness ramp, so
 *      the real dark surface shows through. NEVER darkened to black (that only
 *      works on a black theme). Chromatic ink is never in the ramp → 100% kept.
 *   2. LIFT the remaining dark ink; never darken anything (`L' = max(L', L)`).
 *  Large light-neutral components (a white wordmark) are `protect`ed and kept.
 *  Because paper becomes transparent, the output is background-independent. */
export function remap(img: Raster): { raster: Raster } {
  const { w, h, rgba: px } = img, n = w * h;
  const NEUTRAL_C = 0.03;    // the doc's value (NOT 0.045); "neutral" for the lift
  const SOFT_C = 0.048;      // only near-neutral pixels are eligible to be cleared
  const bboxArea = n;

  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const alpha = new Float32Array(n);
  const lightNeutral = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [Ll, aa, bb] = srgb8ToLab(px[j], px[j + 1], px[j + 2]);
    L[i] = Ll; A[i] = aa; B[i] = bb; alpha[i] = px[j + 3] / 255;
    const ink = alpha[i] > 0.5, c = chroma(aa, bb);
    if (ink && c < NEUTRAL_C && Ll > 0.72) lightNeutral[i] = 1;
  }
  const cc = connectedComponents(lightNeutral, w, h);
  const protectLabel = new Uint8Array(cc.count + 1);
  for (let id = 1; id <= cc.count; id++) if (cc.areas[id] >= 0.08 * bboxArea) protectLabel[id] = 1;

  // Paper colour = mean sRGB of the (unprotected) light-neutral pixels, for the
  // decontamination of partially-cleared edges. Fallback: white.
  let pr = 0, pg = 0, pb = 0, pc = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (lightNeutral[i] && !protectLabel[cc.labels[i]]) { pr += px[j] / 255; pg += px[j + 1] / 255; pb += px[j + 2] / 255; pc++; }
  }
  const paper: [number, number, number] = pc > 0 ? [pr / pc, pg / pc, pb / pc] : [1, 1, 1];

  // Step 1: per-pixel clearing coverage (no dilation) → new alpha.
  const newA = Float32Array.from(alpha);
  for (let i = 0; i < n; i++) {
    if (protectLabel[cc.labels[i]]) continue;
    if (alpha[i] > 0.5 && chroma(A[i], B[i]) < SOFT_C) {
      const cov = Math.min(1, Math.max(0, (L[i] - 0.55) / 0.30));   // 0 at L≤.55, 1 at L≥.85
      if (cov > 0) newA[i] = alpha[i] * (1 - cov);
    }
  }

  // Step 2: write final alpha; decontaminate cleared edges; lift remaining ink.
  const out = new Uint8ClampedArray(px);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = newA[i];
    out[j + 3] = Math.round(a * 255);
    if (protectLabel[cc.labels[i]]) continue;                        // protected: keep original L,C
    if (newA[i] < alpha[i] - 1e-6) {                                 // (partly) cleared paper
      if (a > 0.001) {
        const d = Math.max(a, 0.10);
        for (let c = 0; c < 3; c++) { const v = (px[j + c] / 255 - paper[c] * (1 - a)) / d; out[j + c] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255); }
      }
      continue;
    }
    if (a <= 0.5) continue;                                          // transparent (keyed) bg — leave
    const oldL = L[i], c = chroma(A[i], B[i]), neutral = c < NEUTRAL_C;
    let newL: number;
    if (neutral && oldL < 0.5) newL = 1 - oldL;                      // dark ink lifts
    else if (!neutral && oldL < 0.45) newL = Math.max(oldL, 0.62);
    else newL = oldL;
    newL = Math.max(newL, oldL);                                     // never darken
    let av = A[i], bv = B[i];
    if (newL > oldL) { av *= 0.85; bv *= 0.85; }                     // C' = C*0.85 when lightening
    newL = Math.min(newL, 0.92);
    const [r, g, bl] = labToSrgb8(newL, av, bv);
    out[j] = r; out[j + 1] = g; out[j + 2] = bl;
  }
  return { raster: { w, h, rgba: out } };
}

// ── Stage 5b: halo ──────────────────────────────────────────────────────────
/** Non-destructive light glow under the original ink. Colours untouched. */
export function halo(img: Raster): Raster {
  const { w, h, rgba: px } = img, n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3] / 255;
  const blurred = boxBlur(alpha, w, h, 2.5, 3);
  const GLOW: [number, number, number] = [0.92, 0.92, 0.92];
  const out = new Uint8ClampedArray(px);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const oa = alpha[i];
    let glow = blurred[i] * 1.2; glow = glow < 0 ? 0 : glow > 1 ? 1 : glow;
    glow *= (1 - oa);                                 // only where the ink isn't
    // Original ink OVER a light glow layer.
    const outA = oa + glow * (1 - oa);
    if (outA <= 0.0001) { out[j + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) {
      const orig = px[j + c] / 255;
      const v = (orig * oa + GLOW[c] * glow * (1 - oa)) / outA;
      out[j + c] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
    }
    out[j + 3] = Math.round(outA * 255);
  }
  return { w, h, rgba: out };
}

// ── Stage 5c: plate params (rendered by RN, not baked) ──────────────────────
export function plateParams(): PlateParams {
  return { padFrac: 0.09, radiusFrac: 0.14, fill: [0.90, 0.90, 0.90] };
}

// ── Stage 5d: gate (catastrophe check ONLY — never a ranker) ────────────────
/** Composite the candidate on `bg` and decide readable / unreadable. Excludes
 *  1px of eroded ink edge; cleared paper is already alpha 0 (auto-excluded). */
export function gate(cand: Candidate, bg: [number, number, number]): { pass: boolean; note: string } {
  if (cand.treatment === 'plate') return { pass: true, note: 'plate is the guaranteed floor' };
  const img = cand.raster;
  if (!img) return { pass: false, note: 'no raster' };
  const { w, h, rgba: px } = img, n = w * h;
  const bgLab = srgbUnitToLab(bg[0], bg[1], bg[2]);

  // Ink mask (alpha>0.5) eroded by 1px (4-neighbour).
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = px[i * 4 + 3] > 128 ? 1 : 0;
  const eroded = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!ink[i]) continue;
    if (x > 0 && !ink[i - 1]) continue; if (x < w - 1 && !ink[i + 1]) continue;
    if (y > 0 && !ink[i - w]) continue; if (y < h - 1 && !ink[i + w]) continue;
    eroded[i] = 1;
  }

  let neutralTot = 0, neutralPass = 0, chromTot = 0, chromPass = 0, inkTot = 0, blowout = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (!eroded[i]) continue;
    const a = px[j + 3] / 255;
    // Composite over bg (ink is mostly opaque; handle partial cleanly).
    const r = px[j] / 255 * a + bg[0] * (1 - a), g = px[j + 1] / 255 * a + bg[1] * (1 - a), bl = px[j + 2] / 255 * a + bg[2] * (1 - a);
    const [Lp, ap, bp] = srgbUnitToLab(r, g, bl);
    inkTot++;
    if (Lp > 0.95) blowout++;
    const readable = Math.abs(Lp - bgLab[0]) > 0.32;
    if (chroma(ap, bp) < 0.04) { neutralTot++; if (readable) neutralPass++; }
    else { chromTot++; if (readable) chromPass++; }
  }
  if (inkTot === 0) return { pass: false, note: 'no ink' };

  const groups: number[] = [];
  if (neutralTot >= 0.08 * inkTot) groups.push(neutralPass / neutralTot);
  if (chromTot >= 0.08 * inkTot) groups.push(chromPass / chromTot);
  const minGroup = groups.length ? Math.min(...groups) : 0;
  const blow = blowout / inkTot;
  const pass = minGroup >= 0.45 && blow < 0.45;
  return { pass, note: `minGroup=${minGroup.toFixed(2)} blowout=${blow.toFixed(2)}` };
}
