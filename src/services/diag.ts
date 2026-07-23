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

const KEY = '@carfm/diag_enabled';
// Big enough to hold a full drive's worth of change-gated tuner events (a short
// driveway test used ~50 lines; a commute with seeks + stereo flapping can run
// into the hundreds). Ring-buffered, kept in memory only while capturing.
const MAX = 2000;
const lines: string[] = [];
const listeners = new Set<() => void>();
let enabled = false;

// Restore the persisted toggle at import so capture starts before settings is opened.
AsyncStorage.getItem(KEY).then((v) => { enabled = v === '1'; }).catch(() => {});

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
}
export function diagLines(): readonly string[] { return lines; }
export function diagText(): string { return lines.join('\n'); }
export function clearDiag(): void { lines.length = 0; listeners.forEach((l) => l()); }
export function subscribeDiag(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
