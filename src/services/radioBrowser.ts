/**
 * Online logo/genre enrichment from the Radio-Browser API (addendum §7). This is
 * the NETWORK layer only — persistence is in stationDb.ts (logos live in the
 * station DB now). Strictly a nice-to-have over the offline FCC data:
 *   - Radio-Browser catalogs user-contributed internet streams, so coverage is
 *     spotty and its geo/frequency are the STREAM's, not the transmitter's — we
 *     only ever take genre/logo/homepage, never location/frequency.
 *   - Join is fuzzy: the FCC callsign must appear in the stream name.
 *   - Polite: descriptive User-Agent, rate-limited, deduped, results (incl.
 *     misses) cached in the DB so we don't re-hit for the same station.
 *   - Fully offline-degrading: on any network failure the station is added to the
 *     wanted queue (stationDb.markWanted) to be retried when data returns.
 */

import { logoFetchedAt, markWanted, saveLogo } from './stationDb';

const USER_AGENT = 'VibeSDR-CarFM/1.0';           // Radio-Browser asks for this
const MIN_REQUEST_INTERVAL_MS = 1000;             // be a good citizen
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;    // don't re-fetch within 30 days
const MAX_LOGO_BYTES = 200 * 1024;                // skip absurdly large favicons
const FALLBACK_SERVER = 'https://de1.api.radio-browser.info';

let lastRequestAt = 0;
let serverBase: string | null = null;
const inFlight = new Map<string, Promise<boolean>>();

async function throttle() {
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function resolveServer(): Promise<string> {
  if (serverBase) return serverBase;
  try {
    const res = await fetch('https://all.api.radio-browser.info/json/servers', {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const list = (await res.json()) as { name: string }[];
    const names = list.map((s) => s?.name).filter(Boolean);
    if (names.length) { serverBase = `https://${names[(Date.now() >> 4) % names.length]}`; return serverBase; }
  } catch { /* fall through */ }
  serverBase = FALLBACK_SERVER;
  return serverBase;
}

interface RbStation { name?: string; tags?: string; favicon?: string; homepage?: string; votes?: number; }

function pickGenre(tags?: string): string | null {
  if (!tags) return null;
  const first = tags.split(',').map((t) => t.trim()).filter(Boolean)[0];
  if (!first || first.length > 24) return null;   // some entries are whole sentences
  return first.replace(/\b\w/g, (c) => c.toUpperCase());
}

function mimeFor(url: string, header: string | null): string {
  if (header && header.startsWith('image/')) return header.split(';')[0];
  const ext = url.split('?')[0].match(/\.(png|jpe?g|gif|webp|ico|svg)$/i)?.[1]?.toLowerCase();
  return ext ? `image/${ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext}` : 'image/png';
}

async function fetchLogoBytes(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO_BYTES) return null;
    return { bytes: new Uint8Array(buf), mime: mimeFor(url, res.headers.get('content-type')) };
  } catch { return null; }
}

/**
 * Fetch + persist logo/genre/homepage for a station into the DB. Returns true if
 * a logo image was stored. Rate-limited, deduped, TTL-skipped; never throws. On
 * network failure the station is queued (markWanted) for a later sweep.
 */
export async function enrichStation(base: string, nameHint?: string): Promise<boolean> {
  const key = (base || '').toUpperCase();
  if (!key) return false;

  const fetchedAt = await logoFetchedAt(key);           // hit OR recorded miss
  if (fetchedAt != null && Date.now() - fetchedAt < CACHE_TTL_MS) return false;

  if (inFlight.has(key)) return inFlight.get(key)!;
  const task = (async (): Promise<boolean> => {
    try {
      await throttle();
      const server = await resolveServer();
      const url = `${server}/json/stations/search?name=${encodeURIComponent(key)}`
        + `&countrycode=US&limit=15&hidebroken=true&order=votes&reverse=true`;
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      const rows = (await res.json()) as RbStation[];

      const hint = (nameHint ?? '').toUpperCase();
      const match = rows
        .filter((r) => (r.name ?? '').toUpperCase().includes(key)
          || (hint && (r.name ?? '').toUpperCase().includes(hint)))
        .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0))[0];

      if (!match) {
        await saveLogo(key, null, null, null, null, 'radio-browser'); // record miss
        return false;
      }
      const logo = match.favicon ? await fetchLogoBytes(match.favicon) : null;
      await saveLogo(key, logo?.bytes ?? null, logo?.mime ?? null,
        pickGenre(match.tags), match.homepage?.trim() || null, 'radio-browser');
      return !!logo;
    } catch {
      await markWanted(key);   // offline / failed — retry later
      return false;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}
