import { ViewMode } from '../services/viewMode';

// ── Default (vintage amber/monospace) ────────────────────────────────────────
export const Colors = {
  bg:           '#0A0A12',
  bgPanel:      'rgba(10,8,4,0.88)',
  bgPanelSolid: '#0A0804',
  border:       'rgba(255,160,0,0.22)',
  borderBright: 'rgba(255,160,0,0.45)',
  amber:        '#FFB833',
  amberDim:     'rgba(255,160,0,0.50)',
  amberGlow:    '#FFAA00',
  gold:         '#C8893A',
  goldDim:      'rgba(200,137,58,0.50)',
  textDim:      'rgba(150,100,30,0.65)',
  red:          '#E05050',
  green:        '#28A745',
  white:        '#FFFFFF',
} as const;

export const Fonts = {
  mono: 'Courier',
} as const;

// ── Accessibility theme — matches skin's body.lsv-a11y style ─────────────────
export const A11yColors = {
  bg:           '#0A0A12',
  bgPanel:      'rgba(10,8,4,0.92)',
  bgPanelSolid: '#0A0804',
  border:       'rgba(255,160,0,0.35)',
  borderBright: 'rgba(255,160,0,0.60)',
  amber:        '#FFB833',
  amberDim:     'rgba(255,160,0,0.60)',
  amberGlow:    '#FFAA00',
  gold:         '#FFFFFF',        // white text in a11y
  goldDim:      'rgba(255,255,255,0.65)',
  textDim:      'rgba(255,255,255,0.45)',
  red:          '#FF6B6B',
  green:        '#55D98D',
  white:        '#FFFFFF',
} as const;

export const A11yFonts = {
  // Matches skin's 'Atkinson Hyperlegible' fallback chain
  mono: 'System',  // system-ui / -apple-system on iOS
} as const;

// ── Helper ────────────────────────────────────────────────────────────────────
export function themeFor(mode: ViewMode) {
  return {
    colors: mode === 'accessibility' ? A11yColors : Colors,
    font:   mode === 'accessibility' ? A11yFonts.mono : Fonts.mono,
    // Accessibility uses larger base font sizes
    scale:  mode === 'accessibility' ? 1.25 : 1.0,
  };
}
