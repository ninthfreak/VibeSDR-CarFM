// Station logo lookup for the FM-DX tuner (v7, plan §2d). Source: radio-browser.info
// — free, public-domain (CC0), HTTPS, no key. Matches on station NAME + country
// (radio-browser has no PI-code index), so hit rate depends on name quality;
// the tuner falls back to a monogram when this returns null.
//
// No backend, no fees. Results cached in-memory per (name|country) for the session.

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

// de1 is a stable radio-browser mirror; the `all.` host is round-robin DNS which
// some RN networking stacks resolve poorly, so we pin a mirror.
const HOST = 'https://de1.api.radio-browser.info';

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolve a station favicon URL by name (+ optional ISO country). Returns null
 *  when there's no confident match or on any error. HTTPS only. */
export async function lookupStationLogo(name: string, iso?: string): Promise<string | null> {
  const q = norm(name);
  if (!q || q.length < 3) return null;
  const key = `${q}|${iso ?? ''}`;
  if (cache.has(key)) return cache.get(key)!;
  if (inflight.has(key)) return inflight.get(key)!;

  const p = (async (): Promise<string | null> => {
    try {
      const params = new URLSearchParams({
        name: name, limit: '5', order: 'votes', reverse: 'true', hidebroken: 'true',
      });
      if (iso) params.set('countrycode', iso.toUpperCase());
      const res = await fetch(`${HOST}/json/stations/search?${params.toString()}`, {
        headers: { 'User-Agent': 'VibeSDR/7 (FM-DX tuner)' },
      });
      const rows: any[] = await res.json();
      // Prefer a station whose name reasonably matches and has an HTTPS favicon.
      for (const r of Array.isArray(rows) ? rows : []) {
        const fav = String(r?.favicon ?? '');
        if (fav.startsWith('https://') && norm(String(r?.name ?? '')).includes(q.split(' ')[0])) {
          return fav;
        }
      }
      // Otherwise first HTTPS favicon at all.
      for (const r of Array.isArray(rows) ? rows : []) {
        const fav = String(r?.favicon ?? '');
        if (fav.startsWith('https://')) return fav;
      }
      return null;
    } catch {
      return null;
    }
  })();

  inflight.set(key, p);
  const result = await p;
  inflight.delete(key);
  cache.set(key, result);
  return result;
}
