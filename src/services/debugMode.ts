/**
 * Debug/testing mode — the reception dataset.
 *
 * The question this exists to answer: does the tuner's measured level, and does
 * the bundled FCC database's PREDICTION of receivability, agree with what a
 * person actually hears in the car? Nothing in the app has ever been able to
 * check that, and the level meter shipped on 2026-08-04 is unverified against a
 * human ear.
 *
 * So every 15 seconds it records one structured line: the measured level, the
 * position, what the database predicts for that station from that position, and
 * the reception-quality signals that a level reading cannot see. The driver
 * tags what they hear with one button press, and the rating rides along.
 *
 * The position comes from getDetailedLocation() rather than the app's existing
 * getUserLocation(). That is not because the latter fails — it works, and the
 * nearby-station search proves it on the road — but because it returns lat/lon
 * alone from the last-known cache. At highway speed this dataset needs the fix's
 * AGE above all: a position minutes old makes distance and bearing to a
 * transmitter fiction while the car keeps moving.
 *
 * DELIBERATELY QUIET. Normal diagnostics log every RDS field change, which on a
 * commute is hundreds of near-identical lines that bury the interesting ones.
 * Debug mode suppresses that chatter and keeps structured samples plus discrete
 * events — retune, rating, expiry, unexplained panel key.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@carfm/debug_mode_v1';

/** Sample cadence. Each sample COMMANDS the tuner for its level (see
 *  nwdSignalLevel), so this is the fastest rate that still leaves the chip
 *  alone between reads. */
export const DEBUG_SAMPLE_MS = 15_000;

let enabled = false;
const listeners = new Set<() => void>();

AsyncStorage.getItem(KEY).then((v) => {
  enabled = v === '1';
  listeners.forEach((l) => l());
}).catch(() => {});

export function isDebugMode(): boolean { return enabled; }
export function setDebugMode(on: boolean): void {
  enabled = on;
  AsyncStorage.setItem(KEY, on ? '1' : '0').catch(() => {});
  listeners.forEach((l) => l());
}
export function subscribeDebugMode(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export type { DebugSample, AudioRating } from './debugSample';
export { RATING_LABELS, RATING_HINTS, RATING_FRESH_S, formatSample,
  ratingBelongsHere, windowRates, SAMPLE_MIN_WINDOW_S, SAMPLE_MIN_GROUPS,
  bearingDeg } from './debugSample';
