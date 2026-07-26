// pipeline.ts — the orchestrator (HANDOFF_1.md's `route6` live call path):
//   flattenCheckerboard → trim → keyBackground → route → build candidates →
//   gate in routing order → pick first pass, else fall back to `plate`.
//
// The gate is used ONLY to catch a totally-unreadable result, never to RANK
// (the doc: the score "was wrong five separate times in review"). The real
// arbiter is the human, via the import-time picker — this returns EVERY built
// candidate so the picker can show them and default to `pick`.

import { type Raster } from './oklab';
import {
  flattenCheckerboard, trim, keyBackground, route, remap, halo, plateParams, gate,
  type Treatment, type Candidate, type CheckerInfo, type KeyInfo, type Bbox,
} from './stages';

export type AdaptResult = {
  bg: [number, number, number];
  checkerboard: CheckerInfo;
  bbox: Bbox;
  key: KeyInfo;
  coverage: number;
  /** Routing order the pipeline considered (excludes the plate floor). */
  order: Treatment[];
  /** Every built candidate, routed ones first then the plate floor — the set
   *  the picker renders as thumbnails. */
  candidates: Candidate[];
  /** Auto-pick: first routed candidate that passes the gate, else `plate`. */
  pick: Treatment;
  /** Per-treatment gate notes, for logs/telemetry. */
  gates: Record<string, string>;
};

function build(t: Treatment, keyed: Raster): Candidate {
  switch (t) {
    case 'remap': { const { raster } = remap(keyed); return { treatment: 'remap', raster }; }
    case 'halo': return { treatment: 'halo', raster: halo(keyed) };
    case 'as-is': return { treatment: 'as-is', raster: keyed };
    case 'plate': return { treatment: 'plate', raster: keyed, plate: plateParams() };
  }
}

/** Run the whole pipeline on a decoded sRGB raster for a given dark background.
 *  `bg` is unit sRGB [r,g,b] read from the theme token — never hardcoded. */
export function adaptLogoForDark(src: Raster, bg: [number, number, number]): AdaptResult {
  const { raster: r1, info: checkerboard } = flattenCheckerboard(src);
  const { raster: r2, bbox } = trim(r1);
  const { raster: keyed, info: key } = keyBackground(r2);
  const coverage = key.coverage;
  const order = route(coverage);

  const candidates: Candidate[] = order.map((t) => build(t, keyed));
  const gates: Record<string, string> = {};
  let pick: Treatment | null = null;
  for (const c of candidates) {
    const g = gate(c, bg);
    gates[c.treatment] = (g.pass ? 'PASS ' : 'fail ') + g.note;
    if (g.pass && !pick) pick = c.treatment;
  }

  const plate = build('plate', keyed);   // always available: the guaranteed floor
  candidates.push(plate);
  gates.plate = 'PASS ' + gate(plate, bg).note;
  if (!pick) pick = 'plate';

  return { bg, checkerboard, bbox, key, coverage, order, candidates, pick, gates };
}

/** Compact, raster-free summary for logs / override telemetry. */
export function summarize(r: AdaptResult): Record<string, unknown> {
  return {
    bg: r.bg.map((v) => Math.round(v * 255)),
    checkerboard: r.checkerboard.detected ? r.checkerboard.note : 'none',
    coverage: +r.coverage.toFixed(3),
    family: r.coverage > 0.8 ? 'opaque-tile' : 'isolated-ink',
    order: r.order,
    pick: r.pick,
    gates: r.gates,
  };
}
