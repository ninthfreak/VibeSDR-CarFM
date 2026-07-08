// FM-DX Webserver public directory (servers.fmdx.org). Backs the v7 FM-DX
// backend's server browser. Kept standalone (not folded into SDRInstance yet)
// so the Phase 0 spike can list + connect without touching the picker/connect
// flow. Schema verified 2026-07-08: GET returns { dataset: [ … ] }.
//
// NOTE: the endpoint is plain HTTP (https redirects to http). The app already
// permits cleartext for Kiwi/OWRX, so this fetch is fine on both platforms.

const FMDX_API = 'http://servers.fmdx.org/api/';

export interface FmdxServer {
  name:     string;
  url:      string;          // server root, e.g. http://host:port
  city:     string;
  country:  string;          // full name where available
  iso:      string;          // ISO country code (lowercase)
  tuner:    string;          // 'tef' | 'sdr' | 'xdr'
  bwLimit:  string;          // e.g. "65 - 108 MHz"
  audio:    string;          // e.g. "128k"
  lat:      number | null;
  lon:      number | null;
  distance: number | null;   // km from user, when located
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

/** Fetch the public FM-DX server list, active servers only, distance-sorted
 *  when a location is supplied (else alphabetical). */
export async function fetchFmdxServers(lat?: number, lon?: number): Promise<FmdxServer[]> {
  const res = await fetch(FMDX_API);
  const json = await res.json();
  const rows: any[] = Array.isArray(json?.dataset) ? json.dataset : [];
  const out: FmdxServer[] = [];
  for (const r of rows) {
    if (Number(r?.status) !== 1) continue;            // 1 = active, 2 = offline
    const url = String(r?.url ?? '').replace(/\/+$/, '');
    if (!url) continue;
    const coords = Array.isArray(r?.coords) ? r.coords : [];
    const slat = coords.length >= 2 ? Number(coords[0]) : NaN;
    const slon = coords.length >= 2 ? Number(coords[1]) : NaN;
    out.push({
      name:    String(r?.name ?? 'FM-DX').slice(0, 120),
      url,
      city:    String(r?.city ?? r?.countryName ?? ''),
      country: String(r?.countryName ?? ''),
      iso:     String(r?.country ?? '').toLowerCase(),
      tuner:   String(r?.tuner ?? '').toLowerCase(),
      bwLimit: String(r?.bwLimit ?? ''),
      audio:   String(r?.audioQuality ?? ''),
      lat: Number.isFinite(slat) ? slat : null,
      lon: Number.isFinite(slon) ? slon : null,
      distance: (lat != null && lon != null && Number.isFinite(slat) && Number.isFinite(slon))
        ? haversineKm(lat, lon, slat, slon) : null,
    });
  }
  if (lat != null && lon != null) {
    out.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  } else {
    out.sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}
