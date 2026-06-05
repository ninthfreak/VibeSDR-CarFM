export interface SDRInstance {
  name:          string;
  url:           string;
  location:      string;
  callsign:      string;
  users:         number;
  maxUsers:      number;
  online:        boolean;
  version:       string | null;
  latitude:      number | null;
  longitude:     number | null;
  distance:      number | null;   // km, populated when user location is known
  bestSnr:       number | null;   // best band-condition SNR across all bands
}

const BASE_URL = 'https://instances.ubersdr.org/api/instances?conditions=true';

// Minimum recommended version — instances older than this show a warning.
export const MIN_RECOMMENDED_VERSION = '0.1.51';

/** Semver-style comparison: returns true if `ver` is older than `min`. */
export function isVersionOld(ver: string | null): boolean {
  if (!ver) return false;
  const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(ver);
  const b = parse(MIN_RECOMMENDED_VERSION);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff < 0) return true;
    if (diff > 0) return false;
  }
  return false; // equal
}

// Module-level cache
let _cache:     SDRInstance[] | null = null;
let _cacheTime  = 0;
let _cacheLat:  number | null = null;
let _cacheLon:  number | null = null;
const CACHE_TTL_MS = 60_000;

export async function getUserLocation(): Promise<{ lat: number; lon: number } | null> {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      ()  => resolve(null),
      { timeout: 5000, maximumAge: 300_000 },
    );
  });
}

export async function fetchInstances(
  userLat?: number | null,
  userLon?: number | null,
): Promise<SDRInstance[]> {
  const lat = userLat ?? null;
  const lon = userLon ?? null;

  // Reuse cache if location unchanged and within TTL
  const sameLocation = lat === _cacheLat && lon === _cacheLon;
  if (_cache && Date.now() - _cacheTime < CACHE_TTL_MS && sameLocation) return _cache;

  let url = BASE_URL;
  if (lat != null && lon != null) url += `&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const items: any[] = data.instances ?? [];

  const result = items.map((item: any): SDRInstance => {
    let publicUrl: string = item.public_url ?? '';
    if (!publicUrl && item.host) {
      const tls    = item.tls ?? false;
      const port   = item.port ?? (tls ? 443 : 80);
      const scheme = tls ? 'https' : 'http';
      publicUrl    = port === (tls ? 443 : 80)
        ? `${scheme}://${item.host}`
        : `${scheme}://${item.host}:${port}`;
    }
    publicUrl = publicUrl.replace(/\/+$/, '');

    // Best SNR across all reported band conditions
    let bestSnr: number | null = null;
    const bc = item.band_conditions;
    if (bc && typeof bc === 'object') {
      for (const v of Object.values(bc)) {
        if (typeof v === 'number' && (bestSnr === null || v > bestSnr)) bestSnr = v;
      }
    }

    return {
      name:      item.name     || item.callsign || item.host || 'Unknown',
      url:       publicUrl,
      location:  item.location  ?? '',
      callsign:  item.callsign  ?? '',
      users:     item.available_clients ?? 0,
      maxUsers:  item.max_clients       ?? 0,
      online:    item.is_online         ?? true,
      version:   item.version           ?? null,
      latitude:  item.latitude          ?? null,
      longitude: item.longitude         ?? null,
      distance:  item.distance          ?? null,
      bestSnr,
    };
  });

  _cache     = result;
  _cacheTime = Date.now();
  _cacheLat  = lat;
  _cacheLon  = lon;
  return result;
}
