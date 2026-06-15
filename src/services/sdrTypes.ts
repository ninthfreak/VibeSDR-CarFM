// Shared SDR types used across clients and UI
export type SDRMode = 'usb' | 'lsb' | 'am' | 'sam' | 'fm' | 'nfm' | 'cwu' | 'cwl';
export type Mode = SDRMode; // alias

export const MODES: SDRMode[] = ['usb', 'lsb', 'am', 'sam', 'fm', 'nfm', 'cwu', 'cwl'];
export const MODE_LABELS: Record<SDRMode, string> = {
  usb: 'USB', lsb: 'LSB', am: 'AM', sam: 'SAM',
  fm: 'FM', nfm: 'NFM', cwu: 'CWU', cwl: 'CWL',
};

export const STEPS = [10, 100, 500, 1000, 9000, 10000];
// VHF/UHF tuning steps — 10 kHz is uselessly small for broadcast FM (100 kHz),
// NFM repeaters (12.5/25 kHz) and air/marine. Used above 30 MHz (e.g. OWRX VHF
// profiles). 12.5k/25k shown as "12.5k"/"25k" by formatStep.
export const STEPS_VHF = [1000, 5000, 12500, 25000, 50000, 100000];
export function stepsForFreq(hz: number): number[] {
  return hz >= 30_000_000 ? STEPS_VHF : STEPS;
}
export const STEP_LABELS: Record<number, string> = {
  10: '10Hz', 100: '100Hz', 500: '500Hz',
  1000: '1kHz', 9000: '9kHz', 10000: '10kHz',
};

export const MIN_HZ = 10_000;
export const MAX_HZ = 30_000_000;

export const MIN_FREQ_HZ = MIN_HZ;
export const MAX_FREQ_HZ = MAX_HZ;
export const STEPS_HZ    = STEPS;
export interface ConnectionResult {
  allowed: boolean;
  passwordRequired: boolean;
  reason?: string;
}
export async function checkConnection(_url: string, _password?: string): Promise<ConnectionResult> {
  // UberSDRClient handles the real /connection POST with a proper UUID session ID.
  // A pre-flight probe here causes 400s (server rejects non-UUID session IDs).
  // Optimistically allow — UberSDRClient will surface auth errors on connect.
  return { allowed: true, passwordRequired: false };
}

export type ServerType = 'ubersdr' | 'kiwi' | 'owrx';

/** Probe a manually-entered host to pick the backend (v3). Fetches the landing
 *  page and sniffs markers. Returns null when the host can't be reached (the
 *  caller keeps any previously-known type rather than guessing). */
export async function detectServerType(url: string): Promise<ServerType | null> {
  const base = url.trim().replace(/\/+$/, '')
    .replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
  // Manual AbortController + setTimeout — AbortSignal.timeout() isn't reliably
  // available in Android's Hermes runtime and throws before the fetch even runs,
  // which used to make detection fail → default to ubersdr → 404 on OWRX servers.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(base + '/', { signal: ctrl.signal });
    const body = (await r.text()).toLowerCase();
    // Order matters. UberSDR is checked FIRST and positively: it can enable a
    // KiwiSDR-emulation feature, so its page contains Kiwi markers — without this
    // an UberSDR-with-kiwi-emulation mis-detects as Kiwi. Then Kiwi (whose web UI
    // is built ON OpenWebRX, so it also contains "openwebrx" — must beat OWRX).
    if (body.includes('ubersdr')) return 'ubersdr';
    if (/kiwisdr|kiwi sdr|\/kiwi\/|kiwi_util|owrx_ws_open/.test(body)) return 'kiwi';
    if (body.includes('openwebrx')) return 'owrx';
    return 'ubersdr';            // reachable but unidentifiable → assume ubersdr
  } catch {
    return null;                // couldn't reach — caller keeps any known type
  } finally {
    clearTimeout(timer);
  }
}
