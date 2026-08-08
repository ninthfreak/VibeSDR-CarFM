/**
 * The pure half of the "stations near me" query — everything that happens to
 * rows AFTER SQL has prefiltered them to the bounding box.
 *
 * Split out of stationDb.nearbyStations so it can be reached without expo-sqlite.
 * That matters for two reasons: it is what the Rust port
 * (core/stations/src/nearby.rs) is diffed against by `npm run test:stations-diff`,
 * and it makes the ranking testable in plain node. stationDb still owns the SQL
 * and the bounding box; this owns the true-distance trim, the score, the order
 * and the cap.
 *
 * No imports beyond stationGeo, which is itself pure — keep it that way.
 */

import { haversineKm, receivabilityScore } from './stationGeo';

/** The fields ranking actually reads. Callers pass their own richer row type. */
export interface RankableRow {
  lat: number;
  lon: number;
  erpKw: number | null;
  stationClass: string | null;
}

export type Ranked<T> = T & { distanceKm: number; score: number };

/**
 * Rank rows already prefiltered to the bounding box, best first.
 *
 * The box is a superset of the circle, so the distance test here is what
 * actually enforces `radiusKm` — the corners are trimmed, not the SQL's job.
 * `limit` is applied AFTER the sort, so a cap never hides a better station.
 */
export function rankNearby<T extends RankableRow>(
  lat: number, lon: number, radiusKm: number, limit: number, rows: readonly T[],
): Array<Ranked<T>> {
  const out: Array<Ranked<T>> = [];
  for (const r of rows) {
    const distanceKm = haversineKm(lat, lon, r.lat, r.lon);
    if (distanceKm > radiusKm) continue;
    out.push({
      ...r,
      distanceKm,
      score: receivabilityScore({ erpKw: r.erpKw, stationClass: r.stationClass, distanceKm }),
    });
  }
  // Array#sort is stable (required since ES2019), as is the Rust port's
  // sort_by, so equal scores keep the order SQLite returned them in.
  //
  // A NaN SCORE RANKS LAST, EXPLICITLY. receivabilityScore propagates NaN (it
  // is Math.max, which does), and the trim above keeps a NaN-distance row
  // because `NaN > r` is false — so NaN really can reach this sort. The plain
  // `b.score - a.score` returns NaN for those pairs, which the spec coerces to
  // 0, making the comparator inconsistent: it reports NaN == 1 and NaN == 2
  // while 1 < 2. That leaves the resulting order implementation-defined here,
  // and it makes the Rust port's equivalent comparator PANIC outright (Rust
  // checks its sort comparators for a total order, in release too). Sinking NaN
  // to a single sentinel gives both languages the same total order; equal
  // sentinels keep the stable sort's input order.
  const key = (s: number): number => (Number.isNaN(s) ? -Infinity : s);
  out.sort((a, b) => {
    const x = key(a.score);
    const y = key(b.score);
    return x < y ? 1 : x > y ? -1 : 0;
  });
  return out.slice(0, limit);
}
