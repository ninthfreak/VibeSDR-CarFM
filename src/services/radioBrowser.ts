/**
 * Radio-Browser logo source (last-resort in the resolver chain). NETWORK ONLY —
 * the resolver (logoResolver.ts) owns persistence and the wanted-queue. Returns
 * favicon bytes + genre/homepage for a station, or null.
 *
 * Caveats (addendum §7): Radio-Browser catalogs user-contributed internet
 * streams, so US small-market coverage is poor and its geo/frequency are the
 * STREAM's — we only ever take logo/genre/homepage, matched fuzzily by callsign.
 * Polite: descriptive User-Agent, rate-limited, deduped.
 */

const USER_AGENT = 'CarFM-CarFM/1.0';
const MIN_REQUEST_INTERVAL_MS = 1000;
const MAX_LOGO_BYTES = 200 * 1024;
const FALLBACK_SERVER = 'https://de1.api.radio-browser.info';

let lastRequestAt = 0;
let serverBase: string | null = null;
const inFlight = new Map<string, Promise<RadioBrowserHit | null>>();

export interface RadioBrowserHit {
  bytes: Uint8Array;
  mime: string;
  genre: string | null;
  homepage: string | null;
  source: 'radio-browser';
}

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
    const names = ((await res.json()) as { name: string }[]).map((s) => s?.name).filter(Boolean);
    if (names.length) { serverBase = `https://${names[(Date.now() >> 4) % names.length]}`; return serverBase; }
  } catch { /* fall through */ }
  serverBase = FALLBACK_SERVER;
  return serverBase;
}

interface RbStation { name?: string; tags?: string; favicon?: string; homepage?: string; votes?: number; }

export function pickGenre(tags?: string): string | null {
  if (!tags) return null;
  const first = tags.split(',').map((t) => t.trim()).filter(Boolean)[0];
  if (!first || first.length > 24) return null;
  return first.replace(/\b\w/g, (c) => c.toUpperCase());
}

function mimeFor(url: string, header: string | null): string {
  if (header && header.startsWith('image/')) return header.split(';')[0];
  const ext = url.split('?')[0].match(/\.(png|jpe?g|gif|webp|ico|svg)$/i)?.[1]?.toLowerCase();
  return ext ? `image/${ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext}` : 'image/png';
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_LOGO_BYTES) return null;
    return { bytes: new Uint8Array(buf), mime: mimeFor(url, res.headers.get('content-type')) };
  } catch { return null; }
}

/** Fuzzy-search Radio-Browser and return the best station's favicon bytes. */
export async function fetchRadioBrowser(base: string, nameHint?: string): Promise<RadioBrowserHit | null> {
  const key = (base || '').toUpperCase();
  if (!key) return null;
  if (inFlight.has(key)) return inFlight.get(key)!;
  const task = (async (): Promise<RadioBrowserHit | null> => {
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
      if (!match?.favicon) return null;
      const img = await fetchBytes(match.favicon);
      if (!img) return null;
      return { bytes: img.bytes, mime: img.mime, genre: pickGenre(match.tags), homepage: match.homepage?.trim() || null, source: 'radio-browser' };
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}
