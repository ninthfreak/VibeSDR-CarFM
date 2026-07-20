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

interface DdgImageResult { image?: string; thumbnail?: string; width?: number; height?: number; title?: string }

/**
 * Return the top image-result URL for a query, or null. Two-step DDG flow:
 * page -> `vqd` token -> `i.js` JSON. Best-effort; any failure yields null so
 * callers fall back to a monogram.
 */
export async function ddgImageSearch(query: string): Promise<string | null> {
  const vqd = await fetchVqd(query);
  if (!vqd) return null;
  try {
    const u = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}`
      + `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1&t=${APP_TAG}`;
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/', 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { results?: DdgImageResult[] };
    const top = json.results?.find((r) => typeof r.image === 'string' && /^https?:\/\//i.test(r.image!));
    return top?.image ?? null;
  } catch {
    return null;
  }
}

/** Convenience: resolve a station logo URL from its frequency + callsign. */
export async function ddgStationLogo(freqMhz: number | undefined, callsign: string): Promise<string | null> {
  if (!callsign) return null;
  return ddgImageSearch(stationLogoQuery(freqMhz, callsign));
}
