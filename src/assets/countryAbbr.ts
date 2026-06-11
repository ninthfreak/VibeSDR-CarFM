/**
 * Country name abbreviations for CW / Digital spot lists and maps.
 * Ported verbatim from skin v6.3.2 CABBR (initLsvSpots) — long cty.dat
 * country names crowd the narrow Country column, so well-known entities
 * get short forms and anything still >10 chars is ellipsised.
 */

export const CABBR: Record<string, string> = {
  'Federal Republic of Germany': 'Germany', 'Fed. Rep. of Germany': 'Germany',
  'United States': 'USA', 'United States of America': 'USA',
  'United Kingdom': 'UK', 'Great Britain': 'UK',
  'European Russia': 'EU Russia', 'Asiatic Russia': 'AS Russia',
  'Czech Republic': 'Czechia', 'Slovak Republic': 'Slovakia',
  'Bosnia-Herzegovina': 'Bosnia', 'North Macedonia': 'N.Macedonia',
  'Dominican Republic': 'Dom.Rep.', 'Trinidad & Tobago': 'T&T',
  'Papua New Guinea': 'PNG', 'New Zealand': 'N.Zealand',
  'South Africa': 'S.Africa', 'South Korea': 'S.Korea',
  'North Korea': 'N.Korea', 'Saudi Arabia': 'S.Arabia',
  'United Arab Emirates': 'UAE', 'Republic of Korea': 'S.Korea',
  "People's Rep. of China": 'China',
  'Hong Kong': 'Hong Kong', 'Puerto Rico': 'P.Rico',
  'Canary Islands': 'Canaries', 'Balearic Islands': 'Balearics',
  'Netherlands': 'Neth.', 'Switzerland': 'Swiss',
  'Austria': 'Austria', 'Belgium': 'Belgium', 'Portugal': 'Portugal',
  'Romania': 'Romania', 'Bulgaria': 'Bulgaria', 'Hungary': 'Hungary',
  'Slovenia': 'Slovenia', 'Croatia': 'Croatia', 'Serbia': 'Serbia',
  'Montenegro': 'Montenegro', 'Albania': 'Albania', 'Greece': 'Greece',
  'Finland': 'Finland', 'Sweden': 'Sweden', 'Norway': 'Norway',
  'Denmark': 'Denmark', 'Iceland': 'Iceland', 'Estonia': 'Estonia',
  'Latvia': 'Latvia', 'Lithuania': 'Lithuania', 'Poland': 'Poland',
  'Ukraine': 'Ukraine', 'Belarus': 'Belarus', 'Moldova': 'Moldova',
  'Kazakhstan': 'Kazakh.', 'Uzbekistan': 'Uzbek.', 'Azerbaijan': 'Azerbaij.',
  'Armenia': 'Armenia', 'Georgia': 'Georgia',
};

export function abbrCountry(country?: string): string {
  if (!country) return '';
  const s = country.trim();
  if (CABBR[s]) return CABBR[s];
  return s.length > 10 ? s.substring(0, 9) + '…' : s;
}
