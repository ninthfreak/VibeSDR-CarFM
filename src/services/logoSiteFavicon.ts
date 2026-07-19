/**
 * Station-homepage logo source: fetch the site and pick the best icon
 * (apple-touch-icon > og:image > <link rel=icon> > /favicon.ico). A broad
 * fallback when a station has a website but isn't on Wikidata.
 *
 * pickIconUrl is pure and unit-tested; siteFaviconLogo does the fetch.
 */

const UA = 'CarFM-CarFM/1.0';

/** Choose the highest-value icon URL from a page's HTML, resolved absolute. */
export function pickIconUrl(html: string, baseUrl: string): string | null {
  const abs = (href: string): string | null => {
    try { return new URL(href, baseUrl).toString(); } catch { return null; }
  };
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  const hrefOf = (tag: string) => tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  const byRel = (re: RegExp): string | null => {
    for (const tag of linkTags) {
      const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/i)?.[1];
      if (rel && re.test(rel)) { const h = hrefOf(tag); if (h) { const u = abs(h); if (u) return u; } }
    }
    return null;
  };

  const apple = byRel(/apple-touch-icon/i);
  if (apple) return apple;

  const og = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i)?.[0]
    ?.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
  if (og) { const u = abs(og); if (u) return u; }

  const icon = byRel(/(^|\s)icon(\s|$)/i);
  if (icon) return icon;

  try { return new URL('/favicon.ico', baseUrl).toString(); } catch { return null; }
}

export async function siteFaviconLogo(homepage: string): Promise<{ url: string } | null> {
  try {
    const res = await fetch(homepage, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const url = pickIconUrl(await res.text(), homepage);
    return url ? { url } : null;
  } catch {
    return null;
  }
}
