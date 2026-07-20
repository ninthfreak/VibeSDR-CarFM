// DuckDuckGo image-search logo source (logo-search rework, 2026-07-20).
//
// WHY DDG: the earlier sources all failed for much of the US. Radio-Browser
// name-matched user-contributed internet streams (wrong/missing logos — removed).
// Wikidata has too few US stations in a uniform naming. The FM-DX PI server
// (tef.noobish.eu) had 0/7 of the test market's stations. A manual DuckDuckGo
// image search, by contrast, returned the correct station logo as the #1 result
// for all 7 test stations with no failures — as long as the query is
// "radio <freq> <lowercase-callsign> logo" (the callsign MUST be lower-case).
//
// SCOPE / ETHICS: this is a PERSONAL-USE app, not distributed. DDG has no public
// image API, so this drives the same unofficial `i.js` endpoint the web UI uses:
// fetch the search page for a one-time `vqd` token, then request the JSON image
// results. Requests carry an app-identifying source tag. Because a wrong #1 hit
// is still possible, this runs ONLY on an explicit user action (resolveLogo's
// `force` path) — never on background sweeps — and each station is cached by PI
// after the first hit, so the endpoint is touched at most once per station.

const UA = 'Mozilla/5.0 (Linux; Android) CarFM/1.0';
const APP_TAG = 'carfm';                 // DDG `t=` source tag (polite identification)

/** Build the proven query: `radio 88.7 wern logo` (callsign forced lower-case). */
export function stationLogoQuery(freqMhz: number | undefined, callsign: string): string {
  const cs = callsign.trim().toLowerCase();
  const f = typeof freqMhz === 'number' && isFinite(freqMhz) ? `${freqMhz.toFixed(1)} ` : '';
  return `radio ${f}${cs} logo`.replace(/\s+/g, ' ').trim();
}

/** Scrape the one-time `vqd` token DDG requires before the image endpoint. */
async function fetchVqd(query: string): Promise<string | null> {
  try {
    const u = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&t=${APP_TAG}`
      + '&iar=images&iax=images&ia=images';
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const body = await res.text();
    // The token's exact framing has shifted across DDG revisions; try the known
    // shapes in order of specificity.
    const m = body.match(/vqd=["']([^"'&]+)["']/)     // vqd="4-123..."
      || body.match(/vqd=([\d-]+)&/)                    // vqd=4-123...&
      || body.match(/&vqd=([^&"']+)/);                  // fallback
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

interface DdgRawResult { image?: string; thumbnail?: string; url?: string; width?: number; height?: number; title?: string; source?: string }

/** Registrable-ish host of a URL ("https://en.wikipedia.org/..." → "wikipedia.org").
 *  DDG's own `source` field is just the provider ("Bing"), not the image origin —
 *  derive the real domain from the result/page URL like the DDG UI does. */
function hostOf(u?: string): string {
  if (!u) return '';
  const h = u.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.replace(/^www\./i, '') ?? '';
  const parts = h.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : h;
}

/** One picker-ready image result: a full-size `image` and a `thumbnail` to show. */
export interface DdgImage { image: string; thumbnail: string; title: string; width?: number; height?: number; source?: string }

/**
 * Return up to `n` image results for a query. Two-step DDG flow:
 * page -> `vqd` token -> `i.js` JSON. Best-effort; any failure yields [] so
 * callers fall back to a monogram / empty state.
 */
export async function ddgImageResults(query: string, n = 4): Promise<DdgImage[]> {
  const vqd = await fetchVqd(query);
  if (!vqd) return [];
  try {
    const u = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}`
      + `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1&t=${APP_TAG}`;
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { results?: DdgRawResult[] };
    return (json.results ?? [])
      .filter((r) => typeof r.image === 'string' && /^https?:\/\//i.test(r.image!))
      .slice(0, n)
      .map((r) => ({
        image: r.image!,
        thumbnail: r.thumbnail && /^https?:\/\//i.test(r.thumbnail) ? r.thumbnail : r.image!,
        title: r.title ?? '',
        width: r.width, height: r.height,
        // Real origin domain (page URL, else image URL) — not DDG's "Bing" label.
        source: hostOf(r.url) || hostOf(r.image) || r.source || '',
      }));
  } catch {
    return [];
  }
}

/** Return just the top image-result URL for a query, or null. */
export async function ddgImageSearch(query: string): Promise<string | null> {
  return (await ddgImageResults(query, 1))[0]?.image ?? null;
}

/** Convenience: resolve a station logo URL from its frequency + callsign. */
export async function ddgStationLogo(freqMhz: number | undefined, callsign: string): Promise<string | null> {
  if (!callsign) return null;
  return ddgImageSearch(stationLogoQuery(freqMhz, callsign));
}

/** Convenience: the first `n` logo candidates for a station (the picker window). */
export async function ddgStationLogoResults(
  freqMhz: number | undefined, callsign: string, n = 4,
): Promise<DdgImage[]> {
  if (!callsign) return [];
  return ddgImageResults(stationLogoQuery(freqMhz, callsign), n);
}
