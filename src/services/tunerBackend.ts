/**
 * The tuner-source selection — which backend the user picked in Settings.
 *
 * WHY THIS FILE EXISTS. The picker has always written `@carfm/tuner_backend_v1`
 * and nothing has ever read it back: the key was set and read only inside
 * SettingsPanel, so every row was decorative. What actually decided the live
 * backend was a launch parameter plus the NWD availability probe. ANDROID §6.3
 * (bundle v1.13.0) makes the selection load-bearing, so it needs to live outside
 * the panel where the screen can subscribe to it.
 *
 * SCOPE, STATED PLAINLY. This drives PRESENTATION — which readout the face
 * shows, what the connection row says, whether the RTL-SDR diagnostics appear.
 * It does NOT re-bind the hardware: choosing RTL-SDR does not tear down a live
 * NWD service connection and open a dongle. That is a larger change and is not
 * what §6.3 asks for.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BACKEND_KEY = '@carfm/tuner_backend_v1';

export type TunerBackend = 'rtl' | 'nwd' | 'fyt' | 'auto';

/**
 * §6.3 v1.13.0: the built-in tuner is the default, not `auto`.
 *
 * It is also what the app actually runs on in the car, so defaulting anywhere
 * else meant the settings panel disagreed with the hardware on first launch.
 */
export const DEFAULT_BACKEND: TunerBackend = 'nwd';

const VALID: readonly string[] = ['rtl', 'nwd', 'fyt', 'auto'];

let current: TunerBackend = DEFAULT_BACKEND;
let loaded = false;
const listeners = new Set<() => void>();

/** The selection as last known. Synchronous, so a render can use it; it holds
 *  the default until the stored value arrives, which is one tick after launch. */
export function getTunerBackend(): TunerBackend { return current; }

export function subscribeTunerBackend(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

function publish(v: TunerBackend): void {
  if (current === v) return;
  current = v;
  listeners.forEach((l) => { try { l(); } catch { /* a bad listener must not stop the rest */ } });
}

/** Read the stored selection once at launch. Safe to call repeatedly. */
export async function loadTunerBackend(): Promise<TunerBackend> {
  if (loaded) return current;
  loaded = true;
  try {
    const v = await AsyncStorage.getItem(BACKEND_KEY);
    // 'rtltcp' is a retired id that may still be sitting in storage on an
    // upgraded install; it must not resolve to a row that no longer exists.
    if (v && VALID.includes(v)) publish(v as TunerBackend);
  } catch { /* storage unavailable → the default stands */ }
  return current;
}

export function setTunerBackend(v: TunerBackend): void {
  publish(v);
  AsyncStorage.setItem(BACKEND_KEY, v).catch(() => { /* best effort */ });
}

/**
 * Which signal readout the face should draw (§6.3).
 *
 * RTL-SDR shows its dB figure with the unit; the built-in tuner and Auto show
 * the unitless NWD level. FYT has no implementation, so it falls in with the
 * built-in group rather than promising a dB it cannot produce.
 */
export function readoutFor(v: TunerBackend): 'sdr' | 'nwd' {
  return v === 'rtl' ? 'sdr' : 'nwd';
}
