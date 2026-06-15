// Crash guard — OWRX (and other) servers are notoriously flaky; a server that
// restarts mid-session can push our JS into a state where a timer callback,
// unhandled promise rejection, or render throws. In a release build RN's
// default fatal handler calls abort() → the whole app dies (seen in the
// 2026-06-15 field crashes: RCTExceptionsManager.reportFatal → abort).
//
// Instead we install a global handler that LOGS the error (persisted so the
// next launch — or a USB pull — can read the exact message + stack) and
// RECOVERS to the instance picker rather than aborting. The companion
// CrashBoundary (components/CrashBoundary.tsx) does the same for render errors.

import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../../App';

const KEY = 'vibe.lastCrash';
let recovering = false;

export type CrashInfo = { ts: number; message: string; stack?: string; route?: string };

export async function getLastCrash(): Promise<CrashInfo | null> {
  try { const s = await AsyncStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export async function clearLastCrash(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

/** Persist + log a caught error. Exported so CrashBoundary can reuse it. */
export function recordCrash(error: any, route?: string): CrashInfo {
  const info: CrashInfo = {
    ts: Date.now(),
    message: String(error?.message ?? error),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined,
    route,
  };
  try { AsyncStorage.setItem(KEY, JSON.stringify(info)); } catch {}
  // NSLog via console so a live `idevicesyslog` capture also sees it.
  console.log('[CrashGuard]', route ?? '?', info.message, '\n', info.stack ?? '');
  return info;
}

export function installCrashGuard(navRef: NavigationContainerRef<RootStackParamList>): void {
  const EU = (globalThis as any).ErrorUtils;
  if (!EU?.setGlobalHandler) return;
  const prev = EU.getGlobalHandler?.();

  EU.setGlobalHandler((error: any, isFatal?: boolean) => {
    const route = navRef.isReady() ? navRef.getCurrentRoute()?.name : undefined;
    const info = recordCrash(error, route);

    // Non-fatal: just log (keep the dev redbox in __DEV__).
    if (!isFatal) { if (__DEV__ && prev) prev(error, isFatal); return; }

    // Fatal: recover instead of letting RN abort the process.
    if (!recovering) {
      recovering = true;
      try {
        if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'InstancePicker') {
          navRef.reset({ index: 0, routes: [{ name: 'InstancePicker' }] });
        }
      } catch {}
      setTimeout(() => {
        recovering = false;
        Alert.alert(
          'Server connection lost',
          'The SDR server stopped responding — SDR servers (OpenWebRX especially) '
          + 'restart from time to time. This is a server issue, not a problem with '
          + 'VibeSDR. You’ve been returned to the server list.\n\n(detail: '
          + info.message + ')',
        );
      }, 350);
    }

    // In dev, still surface the real error so genuine bugs aren't masked.
    if (__DEV__ && prev) prev(error, isFatal);
  });
}
