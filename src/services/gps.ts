// gps.ts — GPS fix / lock state for the CarFM GPS-lock indicator.
//
// The shared GPS engine (VibeStreamModule.startGps, acquired via
// services/gpsSession) watches GnssStatus and emits `VibeGpsFix { hasFix,
// providerEnabled, satellitesUsed, satellitesVisible }` as the lock changes. This
// module caches the latest state and exposes it as a boolean lock + counts.
//
// This is the DATA layer only — nothing draws it yet. The lock-indicator UI comes
// from a later Claude Design handoff; it can consume `useGpsFix()` / `hasGpsFix()`.
// Runs alongside services/motion.ts (both need FINE location + a live GPS engine).

import { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { acquireGps, releaseGps } from './gpsSession';

export type GpsFix = {
  /** A solid fix (>= 4 satellites used). The headline "GPS lock" boolean. */
  hasFix: boolean;
  /** The GPS provider is turned on at the OS level (location not disabled). */
  providerEnabled: boolean;
  /** Satellites currently contributing to the fix. */
  satellitesUsed: number;
  /** Satellites currently visible (in view), used or not. */
  satellitesVisible: number;
};

let state: GpsFix = { hasFix: false, providerEnabled: false, satellitesUsed: 0, satellitesVisible: 0 };
const listeners = new Set<(g: GpsFix) => void>();
let started = false;
let sub: { remove: () => void } | null = null;

const emitter = Platform.OS === 'android' && NativeModules.VibePowerModule
  ? new NativeEventEmitter(NativeModules.VibePowerModule) : null;

function apply(next: GpsFix): void {
  if (next.hasFix !== state.hasFix
      || next.providerEnabled !== state.providerEnabled
      || next.satellitesUsed !== state.satellitesUsed
      || next.satellitesVisible !== state.satellitesVisible) {
    state = next;
    listeners.forEach((l) => l(state));
  }
}

/** Begin GPS-lock monitoring (idempotent). Shares the one GPS engine (which also
 *  requests FINE location); this just subscribes to the fix events. */
export async function startGpsFix(): Promise<void> {
  if (started || !emitter) return;
  started = true;
  sub = emitter.addListener('VibeGpsFix', (e: Partial<GpsFix>) => {
    apply({
      hasFix: !!e.hasFix,
      providerEnabled: !!e.providerEnabled,
      satellitesUsed: typeof e.satellitesUsed === 'number' ? e.satellitesUsed : 0,
      satellitesVisible: typeof e.satellitesVisible === 'number' ? e.satellitesVisible : 0,
    });
  });
  await acquireGps();
}

export function stopGpsFix(): void {
  if (!started) return;
  started = false;
  sub?.remove();
  sub = null;
  releaseGps();
}

export function getGpsFix(): GpsFix { return state; }
/** The headline boolean for the lock indicator. */
export function hasGpsFix(): boolean { return state.hasFix; }

/** Subscribe to fix changes; fires immediately with the current value. */
export function subscribeGpsFix(cb: (g: GpsFix) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => { listeners.delete(cb); };
}

/** React hook for the (future) GPS-lock indicator. */
export function useGpsFix(): GpsFix {
  const [g, setG] = useState<GpsFix>(getGpsFix());
  useEffect(() => subscribeGpsFix(setG), []);
  return g;
}
