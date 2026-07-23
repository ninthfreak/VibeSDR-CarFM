// motion.ts — vehicle speed + is-moving state from GPS.
//
// One shared GPS engine (VibeStreamModule.startGps, acquired via
// services/gpsSession) emits `VibeSpeed` events at ~1 Hz — a car head unit's GPS
// is always powered, so this is cheap. This module turns those into a filtered
// speed + an `isMoving` boolean that features can gate on.
//
// Standstill / low-speed GPS noise is filtered out: below ~5 mph we report speed
// 0 and isMoving=false, with a little hysteresis so it doesn't flap around the
// threshold. Nothing consumes isMoving yet — it's wired and ready; the speed
// readout UI arrives in a later design handoff.

import { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { acquireGps, releaseGps } from './gpsSession';

const MS_TO_MPH = 2.2369362920544;
const MOVING_ON_MPH = 5;   // at/above this we're moving (below = standstill noise)
const MOVING_OFF_MPH = 3;  // hysteresis: only drop isMoving once we're clearly stopped

export type Motion = { speedMph: number; isMoving: boolean };

let state: Motion = { speedMph: 0, isMoving: false };
const listeners = new Set<(m: Motion) => void>();
let started = false;
let sub: { remove: () => void } | null = null;

const emitter = Platform.OS === 'android' && NativeModules.VibePowerModule
  ? new NativeEventEmitter(NativeModules.VibePowerModule) : null;

function apply(mps: number, hasSpeed: boolean): void {
  const raw = hasSpeed && mps > 0 ? mps * MS_TO_MPH : 0;
  // Hysteresis around the low-speed floor so idle GPS jitter can't toggle it.
  const moving = state.isMoving ? raw >= MOVING_OFF_MPH : raw >= MOVING_ON_MPH;
  const speedMph = moving ? Math.round(raw) : 0;   // standstill/low-speed → 0 (filtered)
  if (speedMph !== state.speedMph || moving !== state.isMoving) {
    state = { speedMph, isMoving: moving };
    listeners.forEach((l) => l(state));
  }
}

/** Begin GPS speed monitoring (idempotent). Shares the one GPS engine (which also
 *  requests FINE location); this just subscribes to the speed events. */
export async function startMotion(): Promise<void> {
  if (started || !emitter) return;
  started = true;
  sub = emitter.addListener('VibeSpeed', (e: { mps?: number; hasSpeed?: boolean }) => {
    apply(typeof e.mps === 'number' ? e.mps : -1, !!e.hasSpeed);
  });
  await acquireGps();
}

export function stopMotion(): void {
  if (!started) return;
  started = false;
  sub?.remove();
  sub = null;
  releaseGps();
}

export function getMotion(): Motion { return state; }
export function isMoving(): boolean { return state.isMoving; }

/** Subscribe to motion changes; fires immediately with the current value. */
export function subscribeMotion(cb: (m: Motion) => void): () => void {
  listeners.add(cb);
  cb(state);
  return () => { listeners.delete(cb); };
}

/** React hook for the (future) speed readout / is-moving-gated features. */
export function useMotion(): Motion {
  const [m, setM] = useState<Motion>(getMotion());
  useEffect(() => subscribeMotion(setM), []);
  return m;
}
