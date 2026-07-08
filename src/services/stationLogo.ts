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
      // byname/ is a substring match (search?name= over-filters and returns []).
      // Ordered by votes so the popular station wins a common-name query.
      const url = `${HOST}/json/stations/byname/${encodeURIComponent(name)}?limit=10&order=votes&reverse=true&hidebroken=true`;
      const res = await fetch(url, { headers: { 'User-Agent': 'VibeSDR/7 (FM-DX tuner)' } });
      const rows: any[] = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      // EXACT normalized-name match only, with an HTTPS favicon. radio-browser's
      // byname results are polluted with near-miss / foreign stations, so a loose
      // match shows the WRONG logo (worse than none). Exact match = confident or
      // nothing → monogram. Optional country tie-breaker when known.
      for (const r of list) {
        const fav = String(r?.favicon ?? '');
        if (!fav.startsWith('https://')) continue;
        if (norm(String(r?.name ?? '')) !== q) continue;
        if (iso && String(r?.countrycode ?? '').toUpperCase() !== iso.toUpperCase()) continue;
        return fav;
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
