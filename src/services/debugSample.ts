/**
 * Debug/testing mode — the pure parts: the rating vocabulary, the sample shape,
 * and the formatter.
 *
 * Split from debugMode.ts, which owns the persisted toggle and therefore pulls
 * in AsyncStorage. Everything here is dependency-free so it can be exercised in
 * Node — the log format is the whole deliverable of this feature and it needs a
 * test that runs.
 */

/**
 * What the driver hears. NOT a scale — four distinct experiences, each pointing
 * at a different physical cause, which is what makes the ratings worth
 * correlating rather than just averaging.
 *
 * The words are the ones the driver actually reaches for. An earlier draft
 * offered "hiss" and "flutter"; the response was that neither is heard on this
 * commute, but pops and crackles are, on WERN and WIBA specifically — both
 * strong locals. That is the interesting case: impulsive artefacts on a station
 * whose level reads 53-62 cannot be a weak-signal problem, so this vocabulary
 * is aimed straight at it.
 */
export type AudioRating = 'clean' | 'crackle' | 'breakup' | 'barely';

/**
 * How long a rating still describes the moment it was given, in seconds.
 *
 * A press is an observation about an instant, not a mode. The first build
 * carried the last rating onto every subsequent sample, so a single "clean" tap
 * coloured everything after it — 111 of 156 samples on 2026-08-05 read "clean",
 * which says nothing about the 110 moments the driver never actually judged.
 * One sample interval plus a little slack: the rating belongs to its own window
 * and the next.
 */
export const RATING_FRESH_S = 20;

export const RATING_LABELS: Record<AudioRating, string> = {
  clean:   'Clean',
  crackle: 'Pops / crackles',
  breakup: 'Breaking up',
  barely:  'Barely there',
};

/** The one-line explanation under each button, and the hypothesis each is
 *  testing. Kept next to the labels so the two never drift apart. */
export const RATING_HINTS: Record<AudioRating, string> = {
  clean:   'sounds right',
  crackle: 'short pops over otherwise good audio',
  breakup: 'dropping out, or another station cutting in',
  barely:  'can only just tell a station is there',
};

export interface DebugSample {
  /** Dial, MHz. */
  mhz: number | null;
  /** Measured level from NwdFmManager.seek, or null if the read was rejected. */
  level: number | null;
  bars: number | null;
  /** Position, and how good it is. */
  lat: number | null;
  lon: number | null;
  accM: number | null;
  speedMs: number | null;
  headingDeg: number | null;
  /** Age of the fix in seconds — a stale fix makes distance and bearing lies. */
  fixAgeS: number | null;
  /** What the DB expects: its receivability score and the inputs behind it, so a
   *  wrong prediction can be diagnosed by term rather than merely observed. */
  predScore: number | null;
  distKm: number | null;
  bearingDeg: number | null;
  erpKw: number | null;
  stationClass: string | null;
  dbCall: string | null;
  /** What the air says, which is what a level reading cannot see. */
  rdsGroupsPerSec: number | null;
  rdsErrPct: number | null;
  stereoFlips: number;
  rdsExpiries: number;
  /** Whether the sample is even valid: a reading taken seconds after a retune
   *  has not settled and should be dropped in analysis. */
  sinceTuneS: number | null;
  /** The driver's most recent verdict, and how long ago it was given. */
  rating: AudioRating | null;
  ratingAgeS: number | null;
}

const n = (v: number | null | undefined, dp = 0): string =>
  v == null || !Number.isFinite(v) ? '?' : v.toFixed(dp);

/**
 * One sample as a single greppable line. Fixed key=value pairs in a fixed order,
 * so a whole drive parses to CSV in one pass and a missing value reads as `?`
 * rather than shifting the columns.
 */
export function formatSample(s: DebugSample): string {
  return [
    'SMP',
    `f=${n(s.mhz, 1)}`,
    `lvl=${n(s.level)}`,
    `bars=${n(s.bars)}`,
    `lat=${n(s.lat, 5)}`,
    `lon=${n(s.lon, 5)}`,
    `acc=${n(s.accM)}`,
    `spd=${n(s.speedMs, 1)}`,
    `hdg=${n(s.headingDeg)}`,
    `fix=${n(s.fixAgeS)}s`,
    `pred=${n(s.predScore, 1)}`,
    `dist=${n(s.distKm, 1)}`,
    `brg=${n(s.bearingDeg)}`,
    `erp=${n(s.erpKw, 1)}`,
    `cls=${s.stationClass ?? '?'}`,
    `call=${s.dbCall ?? '?'}`,
    `rds=${n(s.rdsGroupsPerSec, 1)}/s`,
    `err=${n(s.rdsErrPct)}%`,
    `flips=${s.stereoFlips}`,
    `exp=${s.rdsExpiries}`,
    `tuned=${n(s.sinceTuneS)}s`,
    `rate=${s.rating ?? 'none'}${s.rating ? `@${n(s.ratingAgeS)}s` : ''}`,
  ].join(' ');
}

/** Initial bearing from one point to another, degrees clockwise from north.
 *  Terrain blocking is directional, so the same distance behaves differently on
 *  different approaches — distance alone cannot show that. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const d2r = Math.PI / 180;
  const φ1 = lat1 * d2r, φ2 = lat2 * d2r, Δλ = (lon2 - lon1) * d2r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / d2r + 360) % 360;
}
