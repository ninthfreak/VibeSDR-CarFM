/**
 * Wikidata logo source: look up a US station item by callsign and read its logo
 * (property P154, a Wikimedia Commons image). Decent coverage for named stations
 * and better than Radio-Browser for small US markets. Keyless, no auth.
 *
 * Pure helpers (buildSparql / parseSparqlLogo) are unit-tested; wikidataLogo does
 * the network call.
 */

const UA = 'CarFM-CarFM/1.0 (https://github.com/ninthfreak/CarFM-CarFM)';

/** SPARQL: item whose "call sign" (P2317) matches, returning its logo (P154). */
export function buildSparql(callsign: string): string {
  const cs = callsign.toUpperCase().replace(/-.*$/, '').trim();
  const q = `SELECT ?logo WHERE { ?item wdt:P2317 "${cs}" . ?item wdt:P154 ?logo . } LIMIT 1`;
  return `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`;
}

export function parseSparqlLogo(json: unknown): string | null {
  const b = (json as { results?: { bindings?: { logo?: { value?: string } }[] } })
    ?.results?.bindings?.[0]?.logo?.value;
  return typeof b === 'string' && b ? b : null;
}

/** Returns a logo image URL (Commons Special:FilePath) or null. */
export async function wikidataLogo(callsign: string): Promise<{ url: string } | null> {
  try {
    const res = await fetch(buildSparql(callsign), {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    });
    if (!res.ok) return null;
    const url = parseSparqlLogo(await res.json());
    return url ? { url } : null;
  } catch {
    return null;
  }
}
