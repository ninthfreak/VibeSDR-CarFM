/**
 * RadioDNS (hybrid radio) logo source via SPI / RadioEPG. Official broadcaster
 * logos keyed on the FM broadcast identity — PI + frequency + country (GCC) —
 * which the RDS decoder already gives us (PI + ECC).
 *
 * Two realities to keep in mind:
 *  - US adoption is sparse (it's broadcaster opt-in, strongest in Europe), so this
 *    is best-effort — it fills bigger stations and stays blank for small ones.
 *  - React Native can't do raw DNS, so resolution goes over DNS-over-HTTPS.
 *
 * VERIFY the FQDN construction, GCC derivation, and SI.xml element names against
 * ETSI TS 103 270 / TS 102 818 and a known RadioDNS-enabled station before
 * trusting live results — the pure helpers below are unit-tested for shape, not
 * against the real registry. Check whether YOUR stations even have RadioDNS at
 * fccdata.org (REC Networks shows a per-station indicator).
 */

const UA = 'VibeSDR-CarFM/1.0';

/** FM frequency field: MHz×100, zero-padded to 5 (95.8 MHz -> "09580"). VERIFY. */
export function fmFrequencyField(freqHz: number): string {
  return String(Math.round(freqHz / 1e4)).padStart(5, '0');
}

/** GCC = country-id nibble (top nibble of PI) + ECC byte, 3 hex chars. VERIFY. */
export function gccFromPiEcc(piHex: string, ecc: number): string {
  const countryId = piHex.toLowerCase()[0] ?? '0';
  return (countryId + ecc.toString(16).padStart(2, '0')).toLowerCase();
}

/** <freq>.<pi>.<gcc>.fm.radiodns.org — VERIFY component order against the spec. */
export function buildFmFqdn(piHex: string, freqHz: number, gcc: string): string {
  return `${fmFrequencyField(freqHz)}.${piHex.toLowerCase()}.${gcc.toLowerCase()}.fm.radiodns.org`;
}

/** Pick the largest raster logo URL from an SPI SI.xml document. VERIFY names. */
export function parseSpiLogo(xml: string): string | null {
  let best: { url: string; area: number } | null = null;
  for (const tag of xml.match(/<multimedia\b[^>]*>/gi) ?? []) {
    const url = tag.match(/url\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!url) continue;
    const w = parseInt(tag.match(/width\s*=\s*["'](\d+)["']/i)?.[1] ?? '0', 10) || 64;
    const h = parseInt(tag.match(/height\s*=\s*["'](\d+)["']/i)?.[1] ?? '0', 10) || 64;
    if (!best || w * h > best.area) best = { url, area: w * h };
  }
  return best?.url ?? null;
}

async function doh(name: string, type: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { Accept: 'application/dns-json' } });
    const j = await res.json() as { Answer?: { type: number; data: string }[] };
    // For CNAME prefer a CNAME (type 5) answer; for SRV take the first answer.
    return j?.Answer?.[j.Answer.length - 1]?.data ?? null;
  } catch { return null; }
}

/** Resolve the station's SPI logo URL, or null. Needs PI + frequency + ECC. */
export async function radioDnsLogo(
  piHex: string, freqHz: number, ecc?: number,
): Promise<{ url: string } | null> {
  try {
    if (!piHex || !ecc) return null;   // no country -> can't build GCC
    const fqdn = buildFmFqdn(piHex, freqHz, gccFromPiEcc(piHex, ecc));
    const authority = (await doh(fqdn, 'CNAME'))?.replace(/\.$/, '') || fqdn;
    const srv = await doh(`_radioepg._tcp.${authority}`, 'SRV');
    const [, , port, target] = (srv ?? '').trim().split(/\s+/);
    const host = target?.replace(/\.$/, '');
    if (!host) return null;
    const spiUrl = `http://${host}${port && port !== '80' ? `:${port}` : ''}/radiodns/spi/3.1/SI.xml`;
    const res = await fetch(spiUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const url = parseSpiLogo(await res.text());
    return url ? { url } : null;
  } catch {
    return null;
  }
}
