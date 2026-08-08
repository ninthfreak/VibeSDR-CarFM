// diag.ts — in-app diagnostics log (a head-unit substitute for `adb logcat`).
//
// The head unit isn't networked to a dev machine, so there's no logcat. When the
// user turns on "Tuner diagnostics" in settings, tuner events (bind, tune, the
// signal level, RDS/PS/RadioText, stereo, PTY/TA, audio-switch attempts, errors)
// are captured into a ring buffer that a settings panel can display + copy.
//
// Cheap when off: `diag()` no-ops unless enabled, so it's safe to sprinkle at
// every interesting event.

import AsyncStorage from '@react-native-async-storage/async-storage';

import { nwdSetRdsCapture } from './nwdRadio';

const KEY = '@carfm/diag_enabled';
const OVERLAY_KEY = '@carfm/diag_overlay';
const RDS_CAPTURE_KEY = '@carfm/rds_capture';
// Big enough to hold a full drive's worth of change-gated tuner events (a short
// driveway test used ~50 lines; a commute with seeks + stereo flapping can run
// into the hundreds). Ring-buffered, kept in memory only while capturing.
const MAX = 2000;
const lines: string[] = [];
const listeners = new Set<() => void>();
const prefListeners = new Set<() => void>();
let enabled = false;
let overlay = false;
let rdsCapture = false;

// Restore the persisted toggles at import so capture starts before settings is
// opened — and notify, because the read is async and lands after mount.
AsyncStorage.getItem(KEY).then((v) => {
  enabled = v === '1';
  prefListeners.forEach((l) => l());
}).catch(() => {});
AsyncStorage.getItem(OVERLAY_KEY).then((v) => {
  overlay = v === '1';
  prefListeners.forEach((l) => l());
}).catch(() => {});
// The raw capture lives in the native pump, so the restore has to PUSH — the
// module defaults to off and would otherwise ignore a choice made on a previous
// drive. This is the only place that pushes it, so the flag cannot drift from
// the stored preference.
AsyncStorage.getItem(RDS_CAPTURE_KEY).then((v) => {
  rdsCapture = v === '1';
  nwdSetRdsCapture(rdsCapture);
  prefListeners.forEach((l) => l());
}).catch(() => {});

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Append a line (no-op unless diagnostics are enabled). */
export function diag(line: string): void {
  if (!enabled) return;
  lines.push(`${stamp()}  ${line}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  listeners.forEach((l) => l());
}

export function isDiagEnabled(): boolean { return enabled; }
export function setDiagEnabled(on: boolean): void {
  enabled = on;
  AsyncStorage.setItem(KEY, on ? '1' : '0').catch(() => {});
  diag(on ? '— diagnostics on —' : '');   // marks the toggle point when turning on
  prefListeners.forEach((l) => l());      // the on-screen tail rides on this flag
}

/** Mirror the tail of the log onto the radio face itself. Separate from capture:
 *  the log is worth having on every drive, the overlay only when watching for
 *  something. Implies capture — the overlay shows nothing without it. */
export function isDiagOverlayEnabled(): boolean { return overlay && enabled; }
export function setDiagOverlayEnabled(on: boolean): void {
  overlay = on;
  AsyncStorage.setItem(OVERLAY_KEY, on ? '1' : '0').catch(() => {});
  prefListeners.forEach((l) => l());
}
/** Raw RDS group capture — every group the chip hands over, appended to
 *  carfm-rds-capture.txt in the app's documents directory.
 *
 *  Separate from the tuner log: that one records decoded EVENTS for a human to
 *  read, this one records the raw input so the decoders can be replayed against
 *  real air. The repo's entire real corpus is 27 groups, so a single drive with
 *  this on is worth more than any amount of synthesised test data. It writes to
 *  disk continuously, which is why it is opt-in and worth turning back off once
 *  a drive or two has been captured. */
export function isRdsCaptureEnabled(): boolean { return rdsCapture; }
export function setRdsCaptureEnabled(on: boolean): void {
  rdsCapture = on;
  AsyncStorage.setItem(RDS_CAPTURE_KEY, on ? '1' : '0').catch(() => {});
  nwdSetRdsCapture(on);
  diag(on ? '— raw RDS capture on —' : '— raw RDS capture off —');
  prefListeners.forEach((l) => l());
}

/** Fires when either diagnostics toggle changes, including the async restore at
 *  import — which lands after the first render, so subscribing is not optional. */
export function subscribeDiagPrefs(l: () => void): () => void {
  prefListeners.add(l);
  return () => { prefListeners.delete(l); };
}
export function diagLines(): readonly string[] { return lines; }
export function diagText(): string { return lines.join('\n'); }
export function clearDiag(): void { lines.length = 0; listeners.forEach((l) => l()); }
export function subscribeDiag(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
