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

/**
 * Does a rating describe the station currently being sampled?
 *
 * A press is an observation about a moment AND about a station, and only the
 * first of those was ever enforced. On the drive of 2026-08-06 a hop across six
 * presets in ninety seconds filed seven verdicts against stations the driver had
 * already left — including a "clean" recorded against a frequency tuned zero
 * seconds earlier. Nothing in the resulting line marks it as wrong, so those rows
 * read as ordinary data and land directly on the reception-loss thresholds.
 *
 * Three conditions, all necessary:
 *  - there is a press at all;
 *  - it happened AFTER the current station was tuned, not before;
 *  - it happened on the same dial position being sampled now.
 *
 * The second and third are not redundant. Retuning away and back leaves the
 * frequency matching while the verdict belongs to an earlier visit, and a press
 * during a hop can match the tune order while naming a different station.
 */
export function ratingBelongsHere(a: {
  pressedAtMs: number | null;
  pressedMhz: number | null;
  tunedAtMs: number;
  currentMhz: number | null;
}): boolean {
  if (a.pressedAtMs == null) return false;
  if (a.pressedAtMs <= a.tunedAtMs) return false;
  return a.pressedMhz != null && a.pressedMhz === a.currentMhz;
}

/**
 * Shortest measurement window that can carry a per-second rate.
 *
 * The sampler used to divide by `max(1, elapsed)`, which does not protect a
 * rate — it fabricates one. Two samples landing a second apart (which happens at
 * every retune, since a settle read fires on top of the periodic watch) divided a
 * whole window's groups by 1 and published the result as a rate. The launch
 * sample was the worst case: `rds=50.0/s` on 2026-08-06, against an RDS ceiling
 * of about 11 groups per second. Physically impossible, and indistinguishable in
 * the log from a real reading.
 *
 * Five seconds is well under the 15s cadence, so an ordinary sample is never
 * affected; only the off-cadence ones are.
 */
export const SAMPLE_MIN_WINDOW_S = 5;

/**
 * Fewest groups a mismatch percentage may be quoted from.
 *
 * Same reasoning as the decoder's rolling figure: a station delivering half a
 * group per second produces a percentage from two or three outcomes, and 0% or
 * 100% from that is not a measurement. The 2026-08-06 drive has `rds=0.5/s
 * err=100%` rows that mean nothing beyond "almost nothing arrived".
 */
export const SAMPLE_MIN_GROUPS = 8;

/**
 * Per-window RDS figures, or null where the window cannot support them.
 *
 * Returning null is the point. An absent column reads as "not measured", which is
 * true; a fabricated one reads as data and silently poisons any average taken
 * over the log.
 */
export function windowRates(a: { groups: number; piMismatch: number; windowS: number }):
  { groupsPerSec: number | null; errPct: number | null } {
  const longEnough = Number.isFinite(a.windowS) && a.windowS >= SAMPLE_MIN_WINDOW_S;
  return {
    groupsPerSec: longEnough ? a.groups / a.windowS : null,
    errPct: a.groups >= SAMPLE_MIN_GROUPS ? (100 * a.piMismatch) / a.groups : null,
  };
}
