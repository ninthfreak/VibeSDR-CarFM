/**
 * Logo "prep on assign" (ANDROID §4.5) — pre-renders the derived versions of a
 * newly assigned station logo, from a COPY of the original, without ever
 * altering the original.
 *
 * WHY THIS EXISTS (and why logos looked small even at the right box size): a
 * web-sourced logo usually ships with baked-in margin — transparent or white
 * padding around the mark. Because every surface renders with `Fit`/contain, the
 * box scales the WHOLE IMAGE, whitespace included, so the visible mark ends up
 * occupying a fraction of a correctly-sized box. §4.5: "bounding-box crop the
 * surrounding transparent/white margin so the *visible mark* — not baked-in
 * whitespace — fills the box, and record the intrinsic aspect ratio."
 *
 * Storage contract (user requirement, 2026-07-30): `logos.img` holds the
 * ORIGINAL exactly as supplied and is never mutated. Everything derived —
 * the trimmed `display` rendition here, the dark-mode variants in `dark_logos` —
 * is computed from a copy and stored ALONGSIDE it, so any rendition can be
 * dropped and regenerated, and a later pipeline change never degrades a logo by
 * re-processing an already-processed image.
 */
import { decodeToRaster, encodeRasterPng } from './logoDark/skiaImage';
import { flattenCheckerboard } from './logoDark/stages';
import type { Raster } from './logoDark/oklab';
import { getLogoDataUri, saveLogoRendition, clearLogoRenditions } from './stationDb';
import { base64ToBytes } from './base64';

/** Trim ratio below which the crop is considered a no-op not worth storing. */
const MIN_GAIN = 0.02;
/** Alpha at or below this is empty space, not mark. */
const ALPHA_BG = 8;
/** Per-channel distance from the border colour that still counts as background. */
const BG_TOL = 0.04;

/**
 * Bounding box of the VISIBLE MARK: everything that is neither transparent nor
 * the uniform border colour.
 *
 * Deliberately NOT the dark pipeline's `trim`: that one counts a transparent
 * pixel as CONTENT (it must, because transparency is what its keying stage
 * operates on), so it will not crop the transparent padding that surrounds most
 * PNG logos — the single most common form of baked-in whitespace. §4.5 asks for
 * "the surrounding transparent/white margin" to go, so both cases are background
 * here.
 */
function markBounds(img: Raster): { x0: number; y0: number; x1: number; y1: number } | null {
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
  // fully-opaque badge yields no crop at all — which is the correct outcome.
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

function cropRaster(img: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y + y0) * img.w + x0) * 4;
    out.set(img.rgba.subarray(s, s + w * 4), y * w * 4);
  }
  return { w, h, rgba: out };
}

/**
 * Pre-render the derived renditions for a station from its stored original.
 * Best-effort: returns false (leaving the original as the display image) if the
 * image can't be decoded or nothing was worth cropping. Never throws.
 */
export async function prepareLogoRenditions(base: string): Promise<boolean> {
  try {
    const original = await getLogoDataUri(base);
    if (!original) return false;
    // Decode a COPY of the original — the stored blob is not touched.
    const raster = decodeToRaster(original);
    if (!raster) return false;
    // Flatten a baked-in editor checkerboard first, else it reads as content and
    // defeats the crop (same stage the dark pipeline runs for the same reason).
    const flat = flattenCheckerboard(raster).raster;
    const b = markBounds(flat);
    if (!b) return false;                                        // nothing visible — keep the original
    const cropped = cropRaster(flat, b.x0, b.y0, b.x1, b.y1);
    const gain = 1 - (cropped.w * cropped.h) / Math.max(1, flat.w * flat.h);
    if (cropped.w < 8 || cropped.h < 8) return false;           // degenerate crop — keep the original
    if (gain < MIN_GAIN) return false;                           // already tight; original IS the display image
    const b64 = encodeRasterPng(cropped);
    if (!b64) return false;
    await saveLogoRendition(base, 'display', base64ToBytes(b64), 'image/png', cropped.w, cropped.h);
    return true;
  } catch {
    return false;
  }
}

/** Drop and rebuild a station's renditions from the untouched original. */
export async function regenerateLogoRenditions(base: string): Promise<boolean> {
  await clearLogoRenditions(base);
  return prepareLogoRenditions(base);
}
