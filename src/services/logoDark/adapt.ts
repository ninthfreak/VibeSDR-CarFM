// adapt.ts — the app-facing entry point for dark-mode logo adaptation.
//
// Decodes an encoded logo (sRGB-guaranteed), runs the pure-maths pipeline for a
// given dark background, and encodes each treatment candidate back to a PNG so
// the import-time picker can show them. Returns null if the logo can't be
// decoded/processed (caller falls back to today's white-plate behaviour).
//
// Runs the heavy synchronous work after a macrotask yield so a spinner can paint
// first. The handoff wants this off the main thread; RN has no cheap worker for
// a one-shot like this, and "once at import behind a progress indicator, even 1s
// is acceptable", so a deferred synchronous pass on a capped ≤1024px buffer is
// the pragmatic choice. Measure before optimising (the doc's guidance too).

import { decodeToRaster, encodeRasterPng } from './skiaImage';
import { adaptLogoForDark, summarize } from './pipeline';
import type { Treatment, PlateParams } from './stages';

export type { Treatment, PlateParams };

/** All treatment slots the app persists. AUTO = "trust the pipeline's pick";
 *  CUSTOM is reserved for a future hand-edited variant. The pipeline itself only
 *  ever emits remap/halo/as-is/plate. */
export type TreatmentEnum = 'AUTO' | 'REMAP' | 'HALO' | 'AS_IS' | 'PLATE' | 'CUSTOM';

export function treatmentToEnum(t: Treatment): TreatmentEnum {
  switch (t) { case 'remap': return 'REMAP'; case 'halo': return 'HALO'; case 'as-is': return 'AS_IS'; case 'plate': return 'PLATE'; }
}

export type EncodedCandidate = { treatment: Treatment; pngBase64: string; plate?: PlateParams };
export type ProcessResult = {
  /** The pipeline's auto-pick (gate-passing, else plate). */
  pick: Treatment;
  /** Every built candidate as an encoded PNG (for the picker thumbnails). */
  candidates: EncodedCandidate[];
  /** Raster-free summary for logs / override telemetry. */
  summary: Record<string, unknown>;
};

/** `#RRGGBB` (or `#RGB`) → unit sRGB [r,g,b] in [0,1] — the pipeline's `bg`
 *  input. The background is ALWAYS read from the theme, never hardcoded. */
export function hexToUnitRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Decode → adapt → encode candidates for a dark background `bg` (unit sRGB).
 *  Never throws; resolves null on any failure. */
export function processLogoForDark(dataOrUri: string, bg: [number, number, number]): Promise<ProcessResult | null> {
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const src = decodeToRaster(dataOrUri);
        if (!src) { resolve(null); return; }
        const res = adaptLogoForDark(src, bg);
        const candidates: EncodedCandidate[] = [];
        for (const c of res.candidates) {
          if (!c.raster) continue;
          const png = encodeRasterPng(c.raster);
          if (png) candidates.push({ treatment: c.treatment, pngBase64: png, plate: c.plate });
        }
        if (!candidates.length) { resolve(null); return; }
        const pick = candidates.some((c) => c.treatment === res.pick) ? res.pick : candidates[0].treatment;
        resolve({ pick, candidates, summary: summarize(res) });
      } catch {
        resolve(null);
      }
    }, 0);
  });
}
