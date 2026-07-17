/**
 * CarFM design tokens — from the Claude Design handoff (design_handoff_fm_radio_face).
 * Two palettes; the face picks via useColorScheme(). Amber is the "hot" tuned-state
 * colour, blue is interactive — never red-vs-green (user is red/green colourblind).
 */

export interface CarFmPalette {
  bg: string;
  panel: string;
  raised: string;
  text: string;
  dim: string;
  amber: string;
  blue: string;
  border: string;
  blueFill: string;
  amberFill: string;
  backdrop: string;
  meterEmpty: string;
  scrollThumb: string;
}

export const LIGHT: CarFmPalette = {
  bg:        '#EEF1F5',
  panel:     '#FFFFFF',
  raised:    '#F5F7FA',
  text:      '#1B222C',
  dim:       '#67717F',
  amber:     '#C9760A',
  blue:      '#2E86FF',
  border:    'rgba(20,30,45,0.13)',
  blueFill:  'rgba(46,134,255,0.12)',
  amberFill: 'rgba(201,118,10,0.08)',
  backdrop:  '#DCE0E6',
  meterEmpty: 'rgba(20,30,45,0.10)',
  scrollThumb: 'rgba(128,134,144,0.6)',
};

export const DARK: CarFmPalette = {
  bg:        '#161E29',
  panel:     '#212B38',
  raised:    '#2A3644',
  text:      '#E9EEF4',
  dim:       '#8B97A7',
  amber:     '#FFB833',
  blue:      '#4A9EFF',
  border:    'rgba(255,255,255,0.13)',
  blueFill:  'rgba(74,158,255,0.18)',
  amberFill: 'rgba(255,184,51,0.10)',
  backdrop:  '#0C1218',
  meterEmpty: 'rgba(255,255,255,0.10)',
  scrollThumb: 'rgba(128,134,144,0.6)',
};

/** Bundled via expo-font in App.tsx (no Google Fonts at runtime). */
export const FONT = 'Atkinson Hyperlegible';

export const FM_MIN_MHZ = 87.5;
export const FM_MAX_MHZ = 108.0;

/** Stable brand-ish colour for a monogram tile, hashed from the callsign. */
const BRAND_BGS = ['#20655B', '#2E5EAA', '#1E1E22', '#B02A6E', '#3A7D44',
                   '#6B4FA1', '#B4541B', '#265D73', '#7D2E2E', '#4A4E69'];
export function brandColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return BRAND_BGS[Math.abs(h) % BRAND_BGS.length];
}

/** "WJJO-FM" -> "JJO" style short monogram for the tile face. */
export function monogram(callsign: string): string {
  const base = callsign.toUpperCase().split('-')[0].trim();
  if (base.length === 4 && (base[0] === 'K' || base[0] === 'W')) return base.slice(1);
  return base.slice(0, 4) || '?';
}
