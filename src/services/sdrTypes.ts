// Shared SDR types used across clients and UI
export type SDRMode = 'usb' | 'lsb' | 'am' | 'sam' | 'fm' | 'nfm' | 'cwu' | 'cwl';
export type Mode = SDRMode; // alias

export const MODES: SDRMode[] = ['usb', 'lsb', 'am', 'sam', 'fm', 'nfm', 'cwu', 'cwl'];
export const MODE_LABELS: Record<SDRMode, string> = {
  usb: 'USB', lsb: 'LSB', am: 'AM', sam: 'SAM',
  fm: 'FM', nfm: 'NFM', cwu: 'CWU', cwl: 'CWL',
};

export const STEPS = [10, 100, 500, 1000, 9000, 10000];
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
 *  page and sniffs for OpenWebRX / KiwiSDR markers; defaults to ubersdr. */
export async function detectServerType(url: string): Promise<ServerType> {
  const base = url.trim().replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
    const body = (await r.text()).toLowerCase();
    if (body.includes('openwebrx')) return 'owrx';
    if (body.includes('kiwisdr') || body.includes('kiwi sdr')) return 'kiwi';
  } catch {
    // unreachable / CORS — fall through to ubersdr default
  }
  return 'ubersdr';
}
