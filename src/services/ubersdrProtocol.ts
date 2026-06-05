export const MODES = ['LSB', 'USB', 'CWL', 'CWU', 'AM', 'SAM', 'FM', 'NFM'] as const;
export type Mode = typeof MODES[number];

export const DEFAULT_MODE: Mode  = 'AM';
export const DEFAULT_FREQ_HZ     = 648000;
export const MIN_FREQ_HZ         = 10000;
export const MAX_FREQ_HZ         = 30000000;

export const STEPS_HZ = [10, 100, 500, 1000, 9000, 10000];
export const DEFAULT_STEP_IDX    = 3; // 1 kHz

export interface ConnectionResult {
  allowed: boolean;
  reason?: string;
  maxSessionTime?: number;
  passwordRequired?: boolean;
}

export interface FeatureSet {
  hasDigitalSpots: boolean;
  hasCWSpots: boolean;
  hasSTT: boolean;
  hasHFDL: boolean;
  hasNoiseFloor: boolean;
}

export const EMPTY_FEATURES: FeatureSet = {
  hasDigitalSpots: false,
  hasCWSpots:      false,
  hasSTT:          false,
  hasHFDL:         false,
  hasNoiseFloor:   false,
};

export async function checkConnection(
  baseUrl: string,
  password?: string,
): Promise<ConnectionResult> {
  const userSessionId = generateSessionId();
  const body: Record<string, string> = { user_session_id: userSessionId };
  if (password) body.password = password;

  const resp = await fetch(`${baseUrl}/connection`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(8000),
  });

  if (resp.status === 401 || resp.status === 403) {
    return { allowed: false, passwordRequired: true };
  }
  // 400 means the endpoint exists but rejected us (bad body / old server version).
  // Treat as allowed and let the WebView handle any auth UI.
  if (resp.status === 400 || resp.status === 405) {
    return { allowed: true };
  }
  if (!resp.ok) {
    return { allowed: false, reason: `HTTP ${resp.status}` };
  }

  try {
    return await resp.json();
  } catch {
    return { allowed: true };
  }
}

export async function fetchExtensions(baseUrl: string): Promise<FeatureSet> {
  try {
    const resp = await fetch(`${baseUrl}/api/extensions`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return EMPTY_FEATURES;
    const data = await resp.json();
    const list: string[] = Array.isArray(data) ? data : (data.extensions ?? []);
    return {
      hasDigitalSpots: list.includes('digital_spots'),
      hasCWSpots:      list.includes('cw_spots'),
      hasSTT:          list.includes('stt'),
      hasHFDL:         list.includes('hfdl'),
      hasNoiseFloor:   list.includes('noisefloor'),
    };
  } catch {
    return EMPTY_FEATURES;
  }
}

export function buildAudioWsUrl(
  baseUrl:        string,
  freqHz:         number,
  mode:           Mode,
  userSessionId:  string,
  password?:      string,
): string {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const bw     = modeBandwidth(mode);
  const params = new URLSearchParams({
    frequency:      String(freqHz),
    mode:           mode.toLowerCase(),
    format:         'opus',
    version:        '2',
    user_session_id: userSessionId,
    bandwidthLow:   String(bw.lo),
    bandwidthHigh:  String(bw.hi),
  });
  if (password) params.set('password', password);
  return `${wsBase}/ws?${params.toString()}`;
}

export function modeBandwidth(mode: Mode): { lo: number; hi: number } {
  switch (mode) {
    case 'AM':
    case 'SAM':  return { lo: -5000, hi: 5000 };
    case 'FM':   return { lo: -8000, hi: 8000 };
    case 'NFM':  return { lo: -6000, hi: 6000 };
    case 'LSB':
    case 'CWL':  return { lo: -3000, hi: -300 };
    case 'USB':
    case 'CWU':  return { lo: 300,   hi: 3000 };
  }
}

export function generateSessionId(): string {
  return 'vs-' + Math.random().toString(36).slice(2, 11) + '-' + Date.now().toString(36);
}

export function formatFreqDisplay(hz: number): string {
  if (hz >= 1000000) {
    return (hz / 1000000).toFixed(3).padStart(7, ' ') + ' MHz';
  }
  return (hz / 1000).toFixed(3).padStart(8, ' ') + ' kHz';
}
