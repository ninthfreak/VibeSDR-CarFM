// gpsSession.ts — the single shared GPS engine session.
//
// The native side runs ONE location stream + GnssStatus (VibeStreamModule.startGps)
// that emits BOTH VibeSpeed and VibeGpsFix. Both consumers — services/motion.ts
// (speed / is_moving) and services/gps.ts (GPS lock) — acquire this ref-counted
// session; the native engine starts on the first acquire and stops when the last
// releases. One deliberate GPS rate, no duplicate listeners, FINE-location
// permission requested in one place.

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

const native = Platform.OS === 'android'
  ? (NativeModules.VibePowerModule as { startGps?: () => void; stopGps?: () => void } | undefined)
  : undefined;

let refs = 0;

/** Acquire the shared GPS engine (idempotent per consumer). Requests FINE
 *  location on the first acquire; starts the native stream once. */
export async function acquireGps(): Promise<void> {
  refs += 1;
  const first = refs === 1;            // boolean guard so TS doesn't literal-narrow `refs`
  if (!first || !native) return;       // already running, or unsupported platform
  try {
    if (Platform.OS === 'android') {
      const g = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      if (g !== PermissionsAndroid.RESULTS.GRANTED) return;   // keep the ref; consumers just get no data
    }
  } catch { return; }
  if (refs <= 0) return;   // released during the permission await
  try { native.startGps?.(); } catch { /* keep ref; native may recover */ }
}

/** Release a hold on the shared GPS engine; stops the native stream when the
 *  last consumer releases. */
export function releaseGps(): void {
  if (refs === 0) return;
  refs--;
  if (refs === 0 && native) { try { native.stopGps?.(); } catch { /* ignore */ } }
}
