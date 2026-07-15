/**
 * Layered logo resolver. Walks sources in priority order and persists the first
 * hit into the station DB (addendum §7, revised to store logos in-DB):
 *
 *   RadioDNS (PI/ECC-keyed, official)  ->  Wikidata (by callsign)
 *     ->  station-homepage favicon      ->  Radio-Browser (last resort)
 *
 * A manually-assigned logo is never overwritten (saveLogo guards source='manual').
 * On total network failure the station is queued (markWanted) for a later sweep;
 * a clean "no source had it" is recorded as a miss so we don't retry constantly.
 */

import { callsignToPi } from './piCallsign';
import { saveLogo, logoFetchedAt, markWanted } from './stationDb';
import { radioDnsLogo } from './logoRadioDns';
import { wikidataLogo } from './logoWikidata';
import { siteFaviconLogo } from './logoSiteFavicon';
import { fetchRadioBrowser } from './radioBrowser';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGO_BYTES = 200 * 1024;

export interface LogoStation {
  base: string;
  callsign?: string;
  freqHz?: number;
  piHex?: string;
  ecc?: number;
  homepage?: string | null;
  name?: string | null;
}

interface SourceHit {
  url?: string;
  bytes?: Uint8Array;
  mime?: string;
  genre?: string | null;
  homepage?: string | null;
  source: string;
}

export { base64ToBytes } from './base64';

/** Download an image URL to bytes, size-capped. */
export async function fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await fetch(url, { headers: { 'User-Agent': 'VibeSDR-CarFM/1.0' } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_LOGO_BYTES) return null;
    const ct = res.headers.get('content-type');
    const mime = ct && ct.startsWith('image/') ? ct.split(';')[0] : 'image/png';
    return { bytes: new Uint8Array(buf), mime };
  } catch { return null; }
}

/**
 * Resolve + store a logo for one station. Returns true if an image was stored.
 * Honors a 30-day TTL (hits and recorded misses) so it isn't chatty.
 */
export async function resolveLogo(st: LogoStation): Promise<boolean> {
  const base = st.base.toUpperCase();
  const at = await logoFetchedAt(base);
  if (at != null && Date.now() - at < CACHE_TTL_MS) return false;

  const piHex = st.piHex
    ?? (st.callsign ? callsignToPi(st.callsign)?.toString(16).padStart(4, '0') : undefined);

  const attempts: Array<() => Promise<SourceHit | null>> = [];
  if (piHex && st.freqHz) {
    attempts.push(async () => {
      const r = await radioDnsLogo(piHex, st.freqHz!, st.ecc);
      return r ? { url: r.url, source: 'radiodns' } : null;
    });
  }
  if (st.callsign) {
    attempts.push(async () => {
      const r = await wikidataLogo(st.callsign!);
      return r ? { url: r.url, source: 'wikidata' } : null;
    });
  }
  if (st.homepage) {
    attempts.push(async () => {
      const r = await siteFaviconLogo(st.homepage!);
      return r ? { url: r.url, source: 'favicon' } : null;
    });
  }
  attempts.push(() => fetchRadioBrowser(base, st.name ?? undefined));

  try {
    for (const attempt of attempts) {
      const hit = await attempt();
      if (!hit) continue;
      let { bytes, mime } = hit;
      if (!bytes && hit.url) {
        const img = await fetchImage(hit.url);
        if (img) { bytes = img.bytes; mime = img.mime; }
      }
      if (bytes) {
        await saveLogo(base, bytes, mime ?? 'image/png',
          hit.genre ?? null, hit.homepage ?? st.homepage ?? null, hit.source);
        return true;
      }
    }
    await saveLogo(base, null, null, null, st.homepage ?? null, 'none'); // recorded miss
    return false;
  } catch {
    await markWanted(base); // network failure -> retry on a later sweep
    return false;
  }
}
