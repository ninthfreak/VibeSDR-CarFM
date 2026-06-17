// Callsign prefix → country (DXCC-ish), for FT8/FT4 spots whose on-device decode
// gives us a callsign but no country. Output names match countryAbbr.ts (CABBR /
// abbrCountry) so the list/map render short forms (e.g. "Germany", not "Federal
// Republic of Germany"). Longest-prefix wins — good enough for the vast majority
// of FT8 traffic; exotic split calls (F/DL1ABC etc.) resolve by their home call.

const PREFIX: Record<string, string> = {
  // ── Europe ──
  G: 'England', M: 'England', '2E': 'England', GM: 'Scotland', MM: 'Scotland',
  GW: 'Wales', MW: 'Wales', GI: 'N.Ireland', GD: 'Isle of Man', GU: 'Guernsey', GJ: 'Jersey',
  EI: 'Ireland', EJ: 'Ireland',
  DL: 'Germany', DA: 'Germany', DB: 'Germany', DC: 'Germany', DD: 'Germany',
  DF: 'Germany', DG: 'Germany', DH: 'Germany', DJ: 'Germany', DK: 'Germany',
  DM: 'Germany', DO: 'Germany', DP: 'Germany', DR: 'Germany',
  F: 'France', TM: 'France', HB: 'Switzerland', HB0: 'Liechtenstein',
  OE: 'Austria', ON: 'Belgium', OO: 'Belgium', PA: 'Netherlands', PB: 'Netherlands',
  PC: 'Netherlands', PD: 'Netherlands', PE: 'Netherlands', PI: 'Netherlands',
  LX: 'Luxembourg', CT: 'Portugal', CR: 'Portugal', CQ: 'Portugal',
  EA: 'Spain', EB: 'Spain', EC: 'Spain', ED: 'Spain', EE: 'Spain', EF: 'Spain',
  EA6: 'Balearic Islands', EA8: 'Canary Islands', EA9: 'Ceuta & Melilla',
  I: 'Italy', IZ: 'Italy', IK: 'Italy', IW: 'Italy', IS0: 'Sardinia',
  SM: 'Sweden', SA: 'Sweden', SK: 'Sweden', SL: 'Sweden', '7S': 'Sweden', '8S': 'Sweden',
  LA: 'Norway', LB: 'Norway', LG: 'Norway', LN: 'Norway',
  OZ: 'Denmark', OU: 'Denmark', OV: 'Denmark', '5P': 'Denmark', '5Q': 'Denmark',
  OH: 'Finland', OF: 'Finland', OG: 'Finland', OI: 'Finland', OH0: 'Aland Islands',
  TF: 'Iceland', LY: 'Lithuania', YL: 'Latvia', ES: 'Estonia',
  SP: 'Poland', SQ: 'Poland', SO: 'Poland', SN: 'Poland', '3Z': 'Poland', HF: 'Poland',
  OK: 'Czechia', OL: 'Czechia', OM: 'Slovakia', HA: 'Hungary', HG: 'Hungary',
  YO: 'Romania', YP: 'Romania', YR: 'Romania', LZ: 'Bulgaria',
  S5: 'Slovenia', '9A': 'Croatia', E7: 'Bosnia-Herzegovina', YT: 'Serbia', YU: 'Serbia',
  '4O': 'Montenegro', Z3: 'North Macedonia', ZA: 'Albania',
  SV: 'Greece', SW: 'Greece', SY: 'Greece', SZ: 'Greece', SV5: 'Dodecanese', SV9: 'Crete',
  '5B': 'Cyprus', H2: 'Cyprus', '9H': 'Malta',
  UR: 'Ukraine', US: 'Ukraine', UT: 'Ukraine', UU: 'Ukraine', UX: 'Ukraine', UY: 'Ukraine', EM: 'Ukraine', EO: 'Ukraine',
  EU: 'Belarus', EV: 'Belarus', EW: 'Belarus', ER: 'Moldova',
  R: 'European Russia', U: 'European Russia', RA: 'European Russia', RK: 'European Russia',
  RN: 'European Russia', RU: 'European Russia', RV: 'European Russia', RW: 'European Russia',
  RX: 'European Russia', RZ: 'European Russia', UA: 'European Russia', UB: 'European Russia',
  RA9: 'Asiatic Russia', RA0: 'Asiatic Russia', UA9: 'Asiatic Russia', UA0: 'Asiatic Russia',
  '4U': 'United Nations',

  // ── North America ──
  K: 'United States', W: 'United States', N: 'United States', A: 'United States',
  KL: 'Alaska', AL: 'Alaska', NL: 'Alaska', WL: 'Alaska',
  KH6: 'Hawaii', KH7: 'Hawaii', NH6: 'Hawaii', WH6: 'Hawaii', KP4: 'Puerto Rico',
  VE: 'Canada', VA: 'Canada', VO: 'Canada', VY: 'Canada', CY: 'Canada',
  XE: 'Mexico', XF: 'Mexico', '4A': 'Mexico', '6D': 'Mexico',

  // ── Caribbean / Central / South America ──
  CO: 'Cuba', CM: 'Cuba', HI: 'Dominican Republic', HH: 'Haiti',
  J3: 'Grenada', J6: 'St. Lucia', J7: 'Dominica', J8: 'St. Vincent',
  '8P': 'Barbados', '9Y': 'Trinidad & Tobago', '9Z': 'Trinidad & Tobago',
  PJ: 'Curacao', P4: 'Aruba', FG: 'Guadeloupe', FM: 'Martinique', FY: 'Fr. Guiana',
  PY: 'Brazil', PP: 'Brazil', PT: 'Brazil', PU: 'Brazil', PR: 'Brazil', ZZ: 'Brazil',
  LU: 'Argentina', LW: 'Argentina', AY: 'Argentina', CE: 'Chile', CA: 'Chile', XQ: 'Chile',
  CX: 'Uruguay', CV: 'Uruguay', HK: 'Colombia', HJ: 'Colombia', YV: 'Venezuela', YY: 'Venezuela',
  OA: 'Peru', HC: 'Ecuador', CP: 'Bolivia', ZP: 'Paraguay',

  // ── Asia ──
  JA: 'Japan', JE: 'Japan', JF: 'Japan', JG: 'Japan', JH: 'Japan', JI: 'Japan',
  JJ: 'Japan', JK: 'Japan', JL: 'Japan', JM: 'Japan', JN: 'Japan', JO: 'Japan',
  JP: 'Japan', JQ: 'Japan', JR: 'Japan', JS: 'Japan', '7K': 'Japan', '7L': 'Japan', '8J': 'Japan',
  HL: 'South Korea', DS: 'South Korea', '6K': 'South Korea', '6L': 'South Korea',
  BY: 'China', BA: 'China', BD: 'China', BG: 'China', BH: 'China', BI: 'China',
  BV: 'Taiwan', BU: 'Taiwan', BX: 'Taiwan', BM: 'Taiwan',
  VR: 'Hong Kong', XX9: 'Macao',
  HS: 'Thailand', E2: 'Thailand', '9M': 'Malaysia', '9V': 'Singapore', '9W': 'Malaysia',
  YB: 'Indonesia', YC: 'Indonesia', YD: 'Indonesia', YE: 'Indonesia',
  DU: 'Philippines', DV: 'Philippines', DW: 'Philippines', DX: 'Philippines', '4F': 'Philippines',
  XV: 'Vietnam', '3W': 'Vietnam', VU: 'India', AT: 'India', '4S': 'Sri Lanka',
  S2: 'Bangladesh', AP: 'Pakistan', EP: 'Iran', YK: 'Syria', YI: 'Iraq',
  '4X': 'Israel', '4Z': 'Israel', JY: 'Jordan', OD: 'Lebanon', HZ: 'Saudi Arabia',
  A4: 'Oman', A6: 'United Arab Emirates', A7: 'Qatar', A9: 'Bahrain', '9K': 'Kuwait',
  YA: 'Afghanistan', EX: 'Kyrgyzstan', EY: 'Tajikistan', EZ: 'Turkmenistan',
  UN: 'Kazakhstan', UK: 'Uzbekistan', '4J': 'Azerbaijan', '4K': 'Azerbaijan',
  '4L': 'Georgia', EK: 'Armenia', TA: 'Turkey', TB: 'Turkey', TC: 'Turkey', YM: 'Turkey',

  // ── Africa ──
  ZS: 'South Africa', ZR: 'South Africa', ZT: 'South Africa', ZU: 'South Africa',
  '5N': 'Nigeria', '5Z': 'Kenya', '5H': 'Tanzania', '5R': 'Madagascar',
  CN: 'Morocco', '3V': 'Tunisia', '7X': 'Algeria', SU: 'Egypt', '5A': 'Libya',
  ST: 'Sudan', ET: 'Ethiopia', EL: 'Liberia', TY: 'Benin', TU: 'Ivory Coast',
  TR: 'Gabon', TJ: 'Cameroon', '9G': 'Ghana', '6W': 'Senegal', C5: 'Gambia',
  D2: 'Angola', V5: 'Namibia', A2: 'Botswana', '7Q': 'Malawi', Z2: 'Zimbabwe',
  '9J': 'Zambia', '3B8': 'Mauritius', '3B9': 'Rodrigues', FR: 'Reunion', D4: 'Cape Verde',
  IH9: 'Pantelleria', EA8B: 'Canary Islands',

  // ── Oceania ──
  VK: 'Australia', AX: 'Australia', VK9: 'Australia (ext)', ZL: 'New Zealand', ZM: 'New Zealand',
  '3D2': 'Fiji', KH8: 'American Samoa', '5W': 'Samoa', E5: 'Cook Islands',
  FK: 'New Caledonia', FO: 'Fr. Polynesia', YJ: 'Vanuatu', H4: 'Solomon Islands',
  P2: 'Papua New Guinea', T8: 'Palau', V6: 'Micronesia', V7: 'Marshall Islands', T3: 'Kiribati',
  KH2: 'Guam', KH0: 'Mariana Islands',
};

/** Best-effort country for an amateur callsign, or '' if unknown. */
export function countryForCallsign(call?: string | null): string {
  if (!call) return '';
  // Use the home call: for "F/DL1ABC" the operated-from prefix is before '/', but
  // FT8 spots are almost always bare calls; take the longest segment as the call.
  let c = String(call).trim().toUpperCase();
  if (c.includes('/')) {
    const parts = c.split('/').filter(p => p && p !== 'P' && p !== 'M' && p !== 'QRP');
    // Pick the longest part as the actual call (drops portable/qualifier tags).
    c = parts.sort((a, b) => b.length - a.length)[0] ?? c;
  }
  if (!/^[A-Z0-9]/.test(c)) return '';
  // Candidate prefix = leading letters + the first digit (e.g. DL1ABC → DL1).
  const m = /^([A-Z]+\d|[A-Z0-9]{1,3})/.exec(c);
  const head = m ? m[1] : c.slice(0, 3);
  // Longest-prefix match: DL1ABC → try DL1, DL, D.
  for (let len = Math.min(4, c.length); len >= 1; len--) {
    const key = c.slice(0, len);
    if (PREFIX[key]) return PREFIX[key];
  }
  // Also try the letters-only head (handles "DL1" key form above already, but
  // covers cases where the digit split differs).
  const letters = (/^[A-Z]+/.exec(head) ?? [''])[0];
  if (letters && PREFIX[letters]) return PREFIX[letters];
  return '';
}
