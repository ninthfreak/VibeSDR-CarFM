// bandThemes.ts — the artist Easter-egg "band themes" engine (handoff v1.11.0
// §12). Cosmetic skins that dress the face for the artist currently playing and
// revert the instant the track changes. PURELY presentational: no layout,
// control, or behaviour change (the §12 "scale-up rule").
//
// This module is the DATA + MATCHER only — framework-free (no RN imports) so the
// matching logic is unit-testable as a leaf. The motif ART (AC/DC horns, the NIN
// spiral, the xerox smiley, etc.) and font application live in the components
// that consume a resolved egg.
//
// Activation: the live RadioText is lower-cased and stripped of punctuation, then
// substring-matched against each theme's `names`. First match wins. A theme
// forced from the settings secret panel overrides detection. Nothing persists.

/** The interactive palette fields a theme reads/overrides (subset of the CarFm
 *  palette — kept structural so this file needs no token import). */
export type EggPalette = { text: string; dim: string; border: string; blue: string; blueFill: string };

export type Motif = 'acdc' | 'submarine' | 'bigsuit' | 'xerox' | 'spiral';

/** A resolved band theme. Every field is optional except identity; a consumer
 *  reads only what it needs and falls back to the default token otherwise. All
 *  values are RN-agnostic (colour/font strings, numbers). */
export type Egg = {
  id: string;
  names: string[];
  motif: Motif;
  // type
  font?: string; heroFont?: string; heroScale?: number; heroTrack?: number; heroCase?: 'lower';
  freqFont?: string; freqScale?: number; freqColor?: string;
  rtFont?: string; rtSpacing?: number; bold?: boolean;
  // genre line
  genreText?: string; genreColor?: string; genreFont?: string; genreDroop?: boolean;
  genreCycle?: string[]; genrePulse?: { light: string[]; dark: string[] }; genrePulseOn?: boolean;
  genreOutline?: { color: string; width: number };
  // surfaces
  card?: { bg: string; border: string; text: string; sub: string };
  cardFrame?: { width: number; rings: string[] };
  pageBg?: string;
  rtPlate?: { bg: string; border: string; text: string; serial?: string };
  // lettering
  nameBlock?: { bg: string; color: string; pad: string };
  nameGhost?: { color: string; dx: number; dy: number };
  nameOutline?: { fill: string; stroke: string; width: number };
  heroGlitch?: boolean;
  // accent restatement (recolours every interactive element)
  uiAccent?: string; uiAccentFill?: string; uiAccentOn?: string;
  accent: string; glow: string; chromeInk?: string;
  // art hooks (drawn by the component per `motif`)
  suppressLogos?: boolean; horns?: boolean; stripes?: boolean;
  callSignBolt?: boolean; settingsBoltColor?: string;
  stereoArtL?: string; stereoArtR?: string; stereoArtFilter?: string;
  callLined?: { line: string; gap: number }; freqShadow?: { color: string; dx: number; dy: number };
  // per-colour-scheme overrides, merged over the entry for the active scheme
  modes?: { light?: Partial<Egg>; dark?: Partial<Egg> };
};

/** The band-theme display faces are bundled (App.tsx useFonts). Font fields below
 *  are REGISTERED RN family names. Anton (Talking Heads) and Permanent Marker
 *  (Nirvana) are the design's actual spec faces — both open-licensed. The rest are
 *  open-licensed STAND-INS for proprietary faces we can't legally ship:
 *    Metal Mania  → AC/DC "Squealer"          Bebas Neue → Nirvana hero "Onyx"
 *    Chakra Petch → NIN "Gridnik"/"Singothic"  Righteous  → the Beatles faces (partial)
 *  Set false to fall every theme back to Atkinson. */
export const BAND_FONTS_READY = true;

/** Build the theme registry against the active palette. It's a function (not a
 *  const) because two themes (Nirvana, NIN) deliberately keep the DEFAULT palette
 *  — their `accent`/`glow`/genre colours resolve from the live tokens. */
export function buildEggs(pal: EggPalette): Egg[] {
  return [
    {
      id: 'AC/DC', names: ['ac dc', 'acdc'], motif: 'acdc',
      font: 'Metal Mania',
      accent: '#E31E24', glow: '#FF3B30',
      genreText: "High Voltage Rock 'n' Roll", genreColor: '#E8A400',
      genrePulse: { light: ['#E8A400', '#FFE24A'], dark: ['#E8A400', '#FFE24A'] }, genrePulseOn: true,
      callSignBolt: true, settingsBoltColor: '#E8A400',
      stereoArtL: 'assets/fan-l2.png', stereoArtR: 'assets/fan-r2.png',
      horns: true, suppressLogos: true, bold: true, rtSpacing: 2,
      modes: {
        light: { genreOutline: { color: '#241B0E', width: 1 } },
        // "Back in Black": panels sit a few points off true black, borders near-invisible.
        dark: {
          pageBg: '#000000', card: { bg: '#0B0B0B', border: '#A2A2A2', text: '#E8E8E8', sub: '#7E7E7E' },
          nameOutline: { fill: '#0B0B0B', stroke: '#C9C9C9', width: 1.1 },
          uiAccent: '#C9C9C9', uiAccentFill: 'rgba(201,201,201,0.15)', uiAccentOn: '#0B0B0B',
          stereoArtFilter: 'grayscale(1) brightness(2.3) contrast(0.85)',
          rtPlate: { bg: '#070707', border: '#171717', text: '#E8E8E8' },
        },
      },
    },
    {
      id: 'The Beatles', names: ['beatles'], motif: 'submarine',
      font: 'Righteous',
      accent: '#C9A227', glow: '#E8CF7A',
      genreText: 'Rock', genreColor: '#4A2C15',
      genreFont: 'Righteous', genreDroop: true,
      card: { bg: '#F3E8D2', border: '#A81F28', text: '#241608', sub: '#6B4A2A' },
      cardFrame: { width: 8, rings: ['#F3E8D2 5px', '#2E4EA0 6.5px', '#F3E8D2 17px', '#A81F28 18.5px'] },
      heroCase: 'lower', heroFont: 'Righteous',
      callLined: { line: '#8E1B24', gap: 5 }, freqShadow: { color: '#8E1B24', dx: 5, dy: 6 },
      rtPlate: { bg: '#FFFFFF', border: '#DED6C6', text: '#1A1A1A', serial: 'No. 0101538' },
      stripes: true, suppressLogos: true,
    },
    {
      id: 'Talking Heads', names: ['talking heads'], motif: 'bigsuit',
      font: 'Anton',
      accent: '#D8231C', glow: '#FF4A2E',
      genreText: 'Same As It Ever Was', genreColor: '#D8231C',
      card: { bg: '#EFE9DE', border: '#111111', text: '#111111', sub: '#6B6560' },
      cardFrame: { width: 3, rings: ['#EFE9DE 4px', '#D8231C 5.5px'] },
      nameBlock: { bg: '#D8231C', color: '#EFE9DE', pad: '2px 18px 6px' },
      rtPlate: { bg: '#EFE9DE', border: '#111111', text: '#111111' },
      suppressLogos: true, rtSpacing: 1.5,
    },
    {
      id: 'Nirvana', names: ['nirvana'], motif: 'xerox',
      font: 'Permanent Marker',
      accent: pal.text, glow: pal.border, chromeInk: pal.text,
      genreText: 'Verse Chorus Verse', genreColor: pal.dim,
      genreFont: 'Permanent Marker',
      heroFont: 'Bebas Neue', heroScale: 1.5,
      nameGhost: { color: 'rgba(0,0,0,0.2)', dx: 3, dy: 3 },
      suppressLogos: true, rtSpacing: 1,
    },
    {
      id: 'Nine Inch Nails', names: ['nine inch nails'], motif: 'spiral',
      font: 'Chakra Petch',
      accent: pal.text, glow: pal.border, chromeInk: pal.text,
      genreText: 'Broken Machines', genreCycle: ['Broken Machines', 'Things Falling Apart'], genreColor: pal.dim,
      genreFont: 'Chakra Petch',
      rtFont: 'Chakra Petch', freqFont: 'Chakra Petch',
      heroFont: 'Chakra Petch', heroScale: 1.3, heroTrack: 9, freqScale: 0.95, heroGlitch: true,
      nameGhost: { color: 'rgba(0,0,0,0.16)', dx: 2, dy: 0 },
      suppressLogos: true, rtSpacing: 5,
    },
  ];
}

/** Lower-case + collapse every non-alphanumeric run to a space (the §12 rule). */
export function normalizeRt(rt: string | null | undefined): string {
  return (rt ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
}

/** The id of the theme that should be active, or null. `forcedId` (from the
 *  secret panel) wins over detection; otherwise the first theme any of whose
 *  `names` appears as a substring of the normalized RadioText. Pure + testable. */
export function matchEggId(rt: string | null | undefined, forcedId?: string | null): string | null {
  if (forcedId) return forcedId;
  const norm = normalizeRt(rt);
  if (!norm.trim()) return null;
  for (const e of MATCH_TABLE) if (e.names.some((n) => norm.indexOf(n) >= 0)) return e.id;
  return null;
}

/** id+names only — enough to match without a palette (keeps matchEggId pure). */
const MATCH_TABLE: { id: string; names: string[] }[] = [
  { id: 'AC/DC', names: ['ac dc', 'acdc'] },
  { id: 'The Beatles', names: ['beatles'] },
  { id: 'Talking Heads', names: ['talking heads'] },
  { id: 'Nirvana', names: ['nirvana'] },
  { id: 'Nine Inch Nails', names: ['nine inch nails'] },
];

/** Every theme's id + its secret-panel pun label, in registry order. */
export const EGG_MENU: { id: string; label: string }[] = [
  { id: 'AC/DC', label: 'Powerage' },
  { id: 'The Beatles', label: 'The Walrus was Paul' },
  { id: 'Talking Heads', label: 'Big Suit' },
  { id: 'Nirvana', label: 'Smells Like Gen X' },
  { id: 'Nine Inch Nails', label: 'Now I’m Nothing' },
];

/** Resolve the active theme for the current RadioText / forced id / colour
 *  scheme, with the per-scheme `modes` merged over the base entry (so downstream
 *  reads plain `egg.x`). Returns null when nothing matches. `off` (audio priority
 *  released → face flattened) suppresses all theming. */
export function resolveEgg(opts: {
  rt: string | null | undefined; forcedId?: string | null; dark: boolean; pal: EggPalette; off?: boolean;
}): Egg | null {
  if (opts.off) return null;
  const id = matchEggId(opts.rt, opts.forcedId);
  if (!id) return null;
  const base = buildEggs(opts.pal).find((e) => e.id === id);
  if (!base) return null;
  const mode = base.modes && base.modes[opts.dark ? 'dark' : 'light'];
  return mode ? { ...base, ...mode } : base;
}

/** The interactive-token overrides a resolved egg imposes (uiAccent recolours
 *  every interactive element at once). Returns the merged {blue,blueFill} to
 *  spread over the palette; a no-op object when the egg doesn't restate them.
 *  (The design's `uiAccentOn` has no home in the app palette, so it's carried on
 *  the Egg for the art pass but not applied here.) */
export function eggTokens(egg: Egg | null, pal: EggPalette): { blue: string; blueFill: string } {
  if (!egg?.uiAccent) return { blue: pal.blue, blueFill: pal.blueFill };
  return { blue: egg.uiAccent, blueFill: egg.uiAccentFill ?? pal.blueFill };
}
