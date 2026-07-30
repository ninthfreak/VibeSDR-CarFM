/**
 * Logo "prep on assign" (ANDROID §4.5) — builds every derived rendition of a
 * newly assigned station logo from a COPY of the master, without ever altering
 * the master.
 *
 * Two jobs:
 *
 * 1. TRIM. A web logo usually ships with baked-in margin — transparent or white
 *    padding around the mark. Because every surface renders with `Fit`/contain,
 *    the box scales the WHOLE IMAGE, whitespace included, so the visible mark
 *    ends up occupying a fraction of a correctly-sized box. §4.5: "bounding-box
 *    crop the surrounding transparent/white margin so the *visible mark* — not
 *    baked-in whitespace — fills the box, and record the intrinsic aspect ratio."
 *
 * 2. PRE-RENDER THE SIZE LADDER. Screens decode a small PNG instead of a
 *    full-resolution one: an 18-tile preset strip is 18 × 128px rather than
 *    18 × 512px. Done once, at import, off the render path.
 *
 * Everything here writes into the station's folder (logoStore); `original.bin`
 * is only ever read.
 */
import { decodeToRaster, encodeRasterPng } from './logoDark/skiaImage';
import { flattenCheckerboard } from './logoDark/stages';
import type { Raster } from './logoDark/oklab';
import {
  readOriginalDataUri, putDerivedPng, setMeta, getMeta, hasOriginal,
  clearDerived, darkUri, SIZE_LADDER,
} from './logoStore';

/** Trim ratio below which the crop isn't worth a separate file. */
const MIN_GAIN = 0.02;
/** Alpha at or below this is empty space, not mark. */
const ALPHA_BG = 8;
/** Per-channel distance from the border colour that still counts as background. */
const BG_TOL = 0.04;

/**
 * Bounding box of the VISIBLE MARK: everything that is neither transparent nor
 * uniform paper margin.
 *
 * Deliberately NOT the dark pipeline's `trim`: that one counts a transparent
 * pixel as CONTENT (it must — transparency is what its keying stage operates
 * on), so it will not crop the transparent padding that surrounds most PNG
 * logos, the commonest form of baked-in whitespace.
 */
export function markBounds(img: Raster): { x0: number; y0: number; x1: number; y1: number } | null {
  const { w, h, rgba: px } = img;
  // Median colour of the OPAQUE border pixels (robust to one odd corner).
  const ch: number[][] = [[], [], []];
  let borderN = 0, borderOpaque = 0;
  const add = (x: number, y: number) => {
    const j = (y * w + x) * 4;
    borderN++;
    if (px[j + 3] <= ALPHA_BG) return;          // transparent frame → no colour vote
    borderOpaque++;
    ch[0].push(px[j] / 255); ch[1].push(px[j + 1] / 255); ch[2].push(px[j + 2] / 255);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  const med = ch.map((v) => (v.length ? v.slice().sort((a, b) => a - b)[v.length >> 1] : -1));

  // An OPAQUE border only counts as margin when it is PAPER — near-white or
  // near-black — which is what §4.5 means by "transparent/white margin". A
  // saturated border is the logo itself (a solid badge): treating that colour as
  // background would classify most of the badge as empty and crop the image down
  // to whatever sits ON the badge. Then only transparency marks background, so a
  // fully-opaque badge yields no crop at all — the correct outcome.
  const mostlyOpaqueBorder = borderOpaque > borderN * 0.5;
  const paper = med[0] >= 0
    && ((med[0] >= 0.9 && med[1] >= 0.9 && med[2] >= 0.9) || (med[0] <= 0.1 && med[1] <= 0.1 && med[2] <= 0.1));
  const colourIsBg = mostlyOpaqueBorder && paper;

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      if (px[j + 3] <= ALPHA_BG) continue;      // transparent margin
      if (colourIsBg
        && Math.abs(px[j] / 255 - med[0]) <= BG_TOL
        && Math.abs(px[j + 1] / 255 - med[1]) <= BG_TOL
        && Math.abs(px[j + 2] / 255 - med[2]) <= BG_TOL) continue;   // paper margin
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function cropRaster(img: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y + y0) * img.w + x0) * 4;
    out.set(img.rgba.subarray(s, s + w * 4), y * w * 4);
  }
  return { w, h, rgba: out };
}

/**
 * Area-average downscale to a longest edge of `maxEdge`. Skia's decode-time
 * scaler uses a single linear tap, which aliases badly on the big reductions the
 * ladder needs (512 → 128); averaging every source pixel in the footprint keeps
 * thin lettering readable. Alpha-weighted so transparent padding can't bleed
 * dark fringes into the mark. Returns the input unchanged if it already fits.
 */
export function resampleRaster(img: Raster, maxEdge: number): Raster {
  const scale = maxEdge / Math.max(img.w, img.h);
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.w * scale));
  const h = Math.max(1, Math.round(img.h * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.h, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.w, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, aw = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const j = (yy * img.w + xx) * 4, al = img.rgba[j + 3];
          r += img.rgba[j] * al; g += img.rgba[j + 1] * al; b += img.rgba[j + 2] * al;
          a += al; aw += al; n++;
        }
      }
      const j = (y * w + x) * 4;
      out[j] = aw ? r / aw : 0;
      out[j + 1] = aw ? g / aw : 0;
      out[j + 2] = aw ? b / aw : 0;
      out[j + 3] = n ? a / n : 0;
    }
  }
  return { w, h, rgba: out };
}

/**
 * Write the size ladder for one raster under the given file prefix.
 *
 * PROGRESSIVE: each step downscales the PREVIOUS (already smaller) output rather
 * than re-scanning the full master, so building 512/256/128 costs roughly one
 * master pass instead of three — this is pure-JS pixel work on the head unit's
 * JS thread, and it also gives a better result than one big jump.
 * Yields to the event loop between sizes so a multi-logo migration can't freeze
 * the UI for seconds at a stretch.
 */
async function writeLadder(base: string, raster: Raster, prefix: 'd' | 'k'): Promise<number[]> {
  const written: number[] = [];
  let cur = raster;
  for (const size of [...SIZE_LADDER].sort((a, b) => b - a)) {   // largest first
    if (Math.max(cur.w, cur.h) <= size) continue;                // already smaller
    cur = resampleRaster(cur, size);
    const b64 = encodeRasterPng(cur);
    if (!b64) continue;
    await putDerivedPng(base, `${prefix}-${size}.png`, b64);
    written.push(size);
    await new Promise((r) => setTimeout(r, 0));                  // let the UI breathe
  }
  return written.sort((a, b) => a - b);
}

/**
 * Build the display rendition + size ladder for a station from its master.
 * Best-effort: on any failure the master stays the display image. Never throws.
 */
export async function prepareLogoRenditions(base: string): Promise<boolean> {
  try {
    if (!(await hasOriginal(base))) return false;
    const original = await readOriginalDataUri(base);
    if (!original) return false;
    // Decode a COPY of the master — the stored file is only ever read.
    const raster = decodeToRaster(original);
    if (!raster) return false;
    // Flatten a baked-in editor checkerboard first, else it reads as content and
    // defeats the crop (same stage the dark pipeline runs, for the same reason).
    const flat = flattenCheckerboard(raster).raster;

    let display = flat;
    const b = markBounds(flat);
    if (b) {
      const cropped = cropRaster(flat, b.x0, b.y0, b.x1, b.y1);
      const gain = 1 - (cropped.w * cropped.h) / Math.max(1, flat.w * flat.h);
      if (cropped.w >= 8 && cropped.h >= 8 && gain >= MIN_GAIN) display = cropped;
    }

    const b64 = encodeRasterPng(display);
    if (!b64) return false;
    await putDerivedPng(base, 'display.png', b64);
    const sizes = await writeLadder(base, display, 'd');
    await setMeta(base, {
      w: display.w, h: display.h, aspect: display.w / display.h, sizes,
    });
    return true;
  } catch {
    return false;
  }
}

/** Pre-render the ladder for an already-stored dark master. */
export async function prepareDarkLadder(base: string): Promise<void> {
  try {
    const meta = await getMeta(base);
    if (!meta?.dark) return;
    const d = await darkUri(base);
    if (!d) return;
    const raster = decodeToRaster(await uriToDataUri(d.uri));
    if (!raster) return;
    const darkSizes = await writeLadder(base, raster, 'k');
    await setMeta(base, { darkSizes });
  } catch { /* best effort */ }
}

async function uriToDataUri(fileUri: string): Promise<string> {
  const FS = await import('expo-file-system/legacy');
  const b64 = await FS.readAsStringAsync(fileUri, { encoding: FS.EncodingType.Base64 });
  return `data:image/png;base64,${b64}`;
}

/** Drop and rebuild a station's renditions from the untouched master. */
export async function regenerateLogoRenditions(base: string): Promise<boolean> {
  await clearDerived(base);
  return prepareLogoRenditions(base);
}
