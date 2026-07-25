// skiaImage.ts — the ONLY Skia-touching module in the pipeline. Turns encoded
// logo bytes into a guaranteed-sRGB Raster and turns processed Rasters back into
// PNG bytes. Everything else (oklab/stages/pipeline) is pure maths on Rasters.
//
// The sRGB guarantee (the handoff's #1, silently-corrupting concern) is enforced
// structurally: we DRAW the decoded image onto an offscreen surface created with
// colorSpace "srgb", so Skia's colour management converts a P3/CMYK-tagged
// upload to sRGB during the draw. We then read RGBA_8888 / Unpremul out of that
// sRGB surface — so the buffer the algorithm sees is always sRGB, whatever the
// upload's profile was.

import { Skia, ColorType, AlphaType, ImageFormat, FilterMode, MipmapMode } from '@shopify/react-native-skia';
import type { Raster } from './oklab';

/** Strip a `data:*;base64,` prefix if present, returning bare base64. */
function bareBase64(s: string): string {
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}

/** Decode encoded logo data (raw base64 or a data URI) into a straight-alpha
 *  **sRGB** Raster, longest edge capped at `maxEdge` (logos never need more, and
 *  it bounds memory + runtime). Returns null if Skia can't decode it. */
export function decodeToRaster(dataOrUri: string, maxEdge = 1024): Raster | null {
  try {
    const data = Skia.Data.fromBase64(bareBase64(dataOrUri));
    const src = Skia.Image.MakeImageFromEncoded(data);
    if (!src) return null;
    const w0 = src.width(), h0 = src.height();
    if (w0 < 1 || h0 < 1) return null;

    const scale = Math.min(1, maxEdge / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));

    // Offscreen sRGB surface — the colour-management anchor. CPU-backed, so this
    // is safe to run off the UI thread with no GL context.
    const surface = Skia.Surface.MakeOffscreen(w, h, { colorSpace: 'srgb' });
    if (!surface) return null;
    const canvas = surface.getCanvas();
    canvas.drawImageRectOptions(
      src,
      Skia.XYWHRect(0, 0, w0, h0),
      Skia.XYWHRect(0, 0, w, h),
      FilterMode.Linear, MipmapMode.None,
    );
    const snap = surface.makeImageSnapshot();
    const px = snap.readPixels(0, 0, { width: w, height: h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
    if (!px) return null;
    return { w, h, rgba: new Uint8ClampedArray(px as Uint8Array) };
  } catch {
    return null;
  }
}

/** Encode a straight-alpha sRGB Raster to a PNG, returned as bare base64
 *  (no data-URI prefix). Null if Skia can't build the image. */
export function encodeRasterPng(r: Raster): string | null {
  try {
    const bytes = new Uint8Array(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength);
    const data = Skia.Data.fromBytes(bytes);
    const img = Skia.Image.MakeImage(
      { width: r.w, height: r.h, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
      data, r.w * 4,
    );
    if (!img) return null;
    return img.encodeToBase64(ImageFormat.PNG);
  } catch {
    return null;
  }
}
