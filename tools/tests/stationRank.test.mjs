// rankNearby — the trim/score/sort/cap the Nearby list is built from.
//
// The ordering cases matter most: this is the half of nearbyStations that the
// Rust port (core/stations/src/nearby.rs) is diffed against, so anything that
// changes the order here has to change there too.
//
// Run: node tools/tests/stationRank.test.mjs

import { rankNearby } from '../../src/services/stationRank.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

const MADISON = [43.0731, -89.4012];
const row = (callsignBase, lat, lon, erpKw, stationClass = null) =>
  ({ callsignBase, lat, lon, erpKw, stationClass });

// ── the trim, the sort and the cap ───────────────────────────────────────────
{
  // Both sit inside a 100 km BOX around Madison; only one is in the circle.
  const out = rankNearby(...MADISON, 100, 50, [
    row('WNEA', 43.0731, -89.4012, 10),
    row('WFAR', 43.9, -90.6, 10),          // ~120 km, box corner
  ]);
  eq('a row outside the radius is trimmed', out.map((s) => s.callsignBase), ['WNEA']);
}
{
  // The ordering the score exists to produce: big and far beats tiny and near.
  const out = rankNearby(...MADISON, 200, 50, [
    row('WTNY', 43.10, -89.40, 0.25),
    row('WBIG', 43.80, -89.40, 100, 'C'),
  ]);
  eq('ranking is by receivability, not distance', out.map((s) => s.callsignBase), ['WBIG', 'WTNY']);
}
{
  const out = rankNearby(...MADISON, 200, 1, [
    row('WTNY', 43.08, -89.40, 0.25),
    row('WBIG', 43.20, -89.40, 100, 'C'),
  ]);
  eq('the cap applies after the sort, never hiding a better station',
    out.map((s) => s.callsignBase), ['WBIG']);
}
eq('an empty input is an empty list', rankNearby(...MADISON, 100, 10, []), []);

// ── equal scores keep their input order ──────────────────────────────────────
{
  // Identical position and ERP → identical score, so only sort stability decides.
  const same = ['A', 'B', 'C', 'D'].map((n) => row(n, 43.10, -89.40, 5));
  const out = rankNearby(...MADISON, 200, 50, same);
  eq('a stable sort keeps tied rows in input order',
    out.map((s) => s.callsignBase), ['A', 'B', 'C', 'D']);
}

// ── REGRESSION: a NaN score must rank last, not reorder the list ─────────────
//
// receivabilityScore propagates NaN (Math.max does), and the radius trim keeps a
// NaN-distance row because `NaN > r` is false — so NaN reaches the sort. The
// plain `b.score - a.score` comparator is inconsistent for those pairs, which
// leaves the order implementation-defined here and PANICS the Rust port, whose
// sort checks its comparator for a total order.
{
  const rows = [
    row('WGOOD', 43.10, -89.40, 100, 'C'),
    row('WNAN1', 43.11, -89.41, NaN),
    row('WMID', 43.12, -89.42, 10),
    row('WNAN2', 43.13, -89.43, NaN),
    row('WLOW', 43.14, -89.44, 0.25),
  ];
  const out = rankNearby(...MADISON, 200, 50, rows);
  eq('NaN scores sink to the tail, real scores stay ordered',
    out.map((s) => s.callsignBase), ['WGOOD', 'WMID', 'WLOW', 'WNAN1', 'WNAN2']);
  eq('every row still comes back', out.length, 5);
  eq('the sunk rows really are the NaN ones',
    out.slice(3).every((s) => Number.isNaN(s.score)), true);
}
{
  // Enough NaN rows, irregularly placed, to catch an unstable comparator.
  const nanAt = new Set([1, 2, 5, 8, 13, 21, 34, 55, 60, 61, 62, 70, 71, 90]);
  const rows = Array.from({ length: 100 }, (_, i) =>
    row(`W${String(i).padStart(3, '0')}`, 43.0 + (i % 11) * 0.01, -89.4 - (i % 7) * 0.01,
      nanAt.has(i) ? NaN : 1 + ((i * 37) % 97)));
  const out = rankNearby(...MADISON, 500, 1000, rows);
  const firstNan = out.findIndex((s) => Number.isNaN(s.score));
  eq('a hundred rows with scattered NaN still rank deterministically', firstNan, 86);
  eq('the real scores are in descending order',
    out.slice(0, 86).every((s, i, a) => i === 0 || a[i - 1].score >= s.score), true);
}

console.log(fails === 0 ? '\nstationRank: ALL PASS' : `\nstationRank: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
