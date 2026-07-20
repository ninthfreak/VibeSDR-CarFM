/**
 * Layered logo resolver. Walks sources in priority order and persists the first
 * hit into the station DB (addendum §7, revised to store logos in-DB):
 *
 *   DuckDuckGo image search (by freq + callsign)  ->  Wikidata (by callsign)
 *     ->  station-homepage favicon
 *
 * (Radio-Browser was removed — useless for much of the US; RadioDNS was dropped
 * earlier for sparse US coverage. The DuckDuckGo source is the logo-search
 * rework — see logoDuckDuckGo.ts for why and its scope.)
 *
 * A manually-assigned logo is never overwritten (saveLogo guards source='manual').
 * On total network failure the station is queued (markWanted) for a later sweep;
 * a clean "no source had it" is recorded as a miss so we don't retry constantly.
 */

import { saveLogo, logoFetchedAt, markWanted } from './stationDb';
import { wikidataLogo } from './logoWikidata';
import { siteFaviconLogo } from './logoSiteFavicon';
import { ddgStationLogo } from './logoDuckDuckGo';

/**
 * AUTOMATIC (background) logo resolution stays DISABLED (2026-07-17 device test:
 * auto-downloaded logos were completely wrong — text-matching sources happily
 * returned unrelated images). The logo-search rework (DuckDuckGo, freq+callsign)
 * is trustworthy enough for a USER-INITIATED tap but a wrong #1 hit is still
 * possible, so it must not run unattended. Therefore:
 *   - resolveLogo() is a no-op for BACKGROUND callers (sweeps, prefetch, encounter):
 *     returns false, fetches nothing, writes nothing; stations render monograms.
 *   - resolveLogo(st, { force: true }) — an explicit user tap — DOES run, hitting
 *     the DuckDuckGo source first, then Wikidata, then favicon.
 *   - MANUAL assignment is never touched: the in-app Commons search + the
 *     browser share-back flow (stationFinder) both save with source='manual'.
 * Flip this to true only once background auto-resolution is proven safe.
 */
export const AUTO_LOGO_RESOLUTION = false;

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGO_BYTES = 200 * 1024;

export interface LogoStation {
  base: string;
  callsign?: string;
  homepage?: string | null;
  name?: string | null;
  freqMhz?: number;          // FM dial frequency — part of the DuckDuckGo query
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
    const res = await fetch(url, { headers: { 'User-Agent': 'CarFM-CarFM/1.0' } });
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
export async function resolveLogo(st: LogoStation, opts?: { force?: boolean }): Promise<boolean> {
  // Background callers stay disabled; only an explicit user action (force) runs.
  if (!AUTO_LOGO_RESOLUTION && !opts?.force) return false;   // see note above
  const base = st.base.toUpperCase();
  const at = await logoFetchedAt(base);
  // A forced (user-initiated) resolve ignores the TTL — the user is asking now.
  if (!opts?.force && at != null && Date.now() - at < CACHE_TTL_MS) return false;

  const attempts: Array<() => Promise<SourceHit | null>> = [];
  const cs = st.callsign || st.base;
  if (cs) {
    attempts.push(async () => {
      const url = await ddgStationLogo(st.freqMhz, cs);
      return url ? { url, source: 'ddg' } : null;
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
