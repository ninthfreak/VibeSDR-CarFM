// Shared RDS country/flag helpers — used by the FM-DX tuner AND the local
// RTL-SDR / network WFM station display. The logo lookup (stationLogo.ts) is
// already backend-agnostic; this centralises the country resolution + flag.

/** ISO-3166 alpha-2 → flag emoji (regional indicator symbols). '' if invalid. */
export function isoToFlag(iso?: string): string {
  if (!iso || iso.length !== 2 || !/^[A-Za-z]{2}$/.test(iso)) return '';
  const base = 0x1F1E6, up = iso.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65, base + up.charCodeAt(1) - 65);
}

/** True for a real 2-letter ISO code (excludes RDS 'UN'/'XX' unknowns). */
export function validIso(iso?: string): boolean {
  const c = iso?.trim().toUpperCase();
  return !!c && /^[A-Z]{2}$/.test(c) && c !== 'UN' && c !== 'XX';
}

// FMLIST/ITU broadcasting country symbol → ISO alpha-2 (FM-DX transmitter DB).
export const ITU_TO_ISO: Record<string, string> = {
  G: 'GB', F: 'FR', D: 'DE', I: 'IT', E: 'ES', HOL: 'NL', BEL: 'BE', LUX: 'LU',
  AUT: 'AT', SUI: 'CH', POR: 'PT', IRL: 'IE', NOR: 'NO', S: 'SE', FIN: 'FI',
  DNK: 'DK', POL: 'PL', CZE: 'CZ', SVK: 'SK', HNG: 'HU', ROU: 'RO', BUL: 'BG',
  GRC: 'GR', HRV: 'HR', SVN: 'SI', SRB: 'RS', UKR: 'UA', RUS: 'RU', EST: 'EE',
  LVA: 'LV', LTU: 'LT', ISL: 'IS', TUR: 'TR', ALB: 'AL', MKD: 'MK', BIH: 'BA',
  MNE: 'ME', AND: 'AD', LIE: 'LI', MCO: 'MC', SMR: 'SM', MLT: 'MT', CYP: 'CY',
};

/** ITU symbol → ISO (FM-DX). Returns '' if unmapped. */
export function ituToIso(itu?: string): string {
  const k = itu?.trim().toUpperCase();
  return (k && ITU_TO_ISO[k]) || '';
}

// ECC (hex) → [15 ISO codes by PI country nibble 1..F]. Generated from
// librdsparser (Konrad Kosmatka), IEC 62106-4:2018. '' = unassigned.
const ECC_CC_ISO: Record<string, string[]> = {
  A1: ['', '', '', '', '', '', '', '', '', '', 'CA', 'CA', 'CA', 'CA', 'GL'],
  A2: ['AI', 'AG', '', 'FK', 'BB', 'BZ', 'KY', 'CR', 'CU', 'AR', 'BR', '', '', 'GP', 'BS'],
  A3: ['BO', 'CO', 'JM', 'MQ', '', 'PY', 'NI', '', 'PA', 'DM', 'DO', 'CL', 'GD', 'TB', 'GY'],
  A4: ['GT', 'HN', 'AW', '', 'MS', 'TT', 'PE', 'SR', 'UY', 'KN', 'LC', 'SN', 'HT', 'VE', 'VG'],
  A5: ['', '', '', '', '', '', '', '', '', '', 'MX', 'VC', 'MX', 'MX', 'MX'],
  A6: ['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'PM'],
  D0: ['CM', 'CF', 'DJ', 'MG', 'ML', 'AO', 'GQ', 'GA', 'GN', 'ZA', 'BF', 'CG', 'TG', 'BJ', 'MW'],
  D1: ['NA', 'LR', 'GH', 'MR', 'ST', 'CV', 'SN', 'GM', 'BI', 'SH', 'BW', 'KM', 'TZ', 'ET', 'NG'],
  D2: ['SL', 'ZW', 'MZ', 'UG', 'SZ', 'KE', 'SO', 'NE', 'TD', 'GW', 'CD', 'CI', '', 'ZM', 'ER'],
  D3: ['', '', 'EH', '', 'RW', 'LS', '', 'SC', '', 'MU', '', 'SD', '', '', ''],
  D4: ['', '', '', '', '', '', '', '', '', 'SS', '', '', '', '', ''],
  E0: ['DE', 'DZ', 'AD', 'IL', 'IT', 'BE', 'RU', 'PS', 'AL', 'AT', 'HU', 'MT', 'DE', '', 'EG'],
  E1: ['GR', 'CY', 'SM', 'CH', 'JO', 'FI', 'LU', 'BG', 'DK', 'GI', 'IQ', 'GB', 'LY', 'RO', 'FR'],
  E2: ['MA', 'CZ', 'PL', 'VA', 'SK', 'SY', 'TN', '', 'LI', 'IS', 'MC', 'LT', 'RS', 'ES', 'NO'],
  E3: ['ME', 'IE', 'TR', '', 'TJ', '', '', 'NL', 'LV', 'LB', 'AZ', 'HR', 'KZ', 'SE', 'BY'],
  E4: ['MD', 'EE', 'MK', '', '', 'UA', 'XK', 'PT', 'SI', 'AM', 'UZ', 'GE', '', 'TM', 'BA'],
  E5: ['', '', 'KG', '', '', '', '', '', '', '', '', '', '', '', ''],
  F0: ['AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'AU', 'SA', 'AF', 'MM', 'CN', 'KP', 'BH', 'MY'],
  F1: ['KI', 'BT', 'BD', 'PK', 'FJ', 'OM', 'NR', 'IR', 'NZ', 'SB', 'BN', 'LK', 'TW', 'KR', 'HK'],
  F2: ['KW', 'QA', 'KH', 'WS', 'IN', 'MO', 'VN', 'PH', 'JP', 'SG', 'MV', 'ID', 'AE', 'NP', 'VU'],
  F3: ['LA', 'TH', 'TO', '', '', '', '', 'CN', 'PG', '', 'YE', '', '', 'FM', 'MN'],
  F4: ['', '', '', '', '', '', '', '', 'CN', '', 'MH', '', '', '', ''],
};

/** RDS ECC + PI code → ISO country. `ecc` is the raw byte, `pi` a hex string
 *  ('C06F') whose first nibble is the country code (1..F). '' when unresolved. */
export function eccPiToIso(ecc?: number, pi?: string): string {
  if (!ecc || !pi) return '';
  const row = ECC_CC_ISO[ecc.toString(16).toUpperCase().padStart(2, '0')];
  if (!row) return '';
  const nibble = parseInt(pi[0], 16);          // PI top nibble = country code
  return nibble >= 1 && nibble <= 15 ? (row[nibble - 1] || '') : '';
}
