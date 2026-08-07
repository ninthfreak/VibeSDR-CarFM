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

export type Motif = 'acdc' | 'submarine' | 'xerox' | 'spiral' | 'runes';

/** The four marks from Led Zeppelin's untitled fourth record, in sleeve order.
 *  Keys into RUNE_PATHS (bandArt) — the art is specific, traced outlines, never
 *  lettering and never a font glyph. */
export type RuneKey = 'zoso' | 'triquetra' | 'rings' | 'feather';

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
  /** Limits the theme's typeface to one region. `'hero'` puts it on the hero card
   *  and RadioText ONLY, leaving preset tiles and peek cards on the default face
   *  (Led Zeppelin). Absent = the face applies everywhere, as before. */
  fontScope?: 'hero';
  /** Outline weight on the hero lettering, in px. */
  heroStroke?: number;
  // genre line
  genreText?: string; genreColor?: string; genreFont?: string; genreDroop?: boolean;
  /** Marks drawn IN PLACE OF the genre line. Debossed rather than printed —
   *  see LOSSY-ELEMENTS #14 and the note on RUNE_SHADOW in bandArt. */
  genreArt?: RuneKey[];
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

/** The band-theme display faces are bundled (App.tsx useFonts) — the REAL supplied
 *  faces from the v1.12.0 handoff, registered under the family names below verbatim
 *  (Squealer, BeatlesYellowSub, SgtPeppers, MadieRoger, PermanentMarker, Onyx,
 *  Gridnik, Singothic, Kashmir). No stand-ins. Set false to fall back to Atkinson. */
// The nine band-theme display faces are decorative and load in the BACKGROUND —
// blocking first paint on them cost seconds of blank screen at every launch. A
// theme only applies its typeface once they've actually arrived; until then it
// falls back to the default face. Eggs resolve off RadioText, which lands well
// after startup, so in practice they are always ready by the time one triggers.
let bandFontsReady = false;
const bandFontListeners = new Set<() => void>();
export function areBandFontsReady(): boolean { return bandFontsReady; }
export function setBandFontsReady(v: boolean): void {
  if (bandFontsReady === v) return;
  bandFontsReady = v;
  bandFontListeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
}
export function subscribeBandFonts(l: () => void): () => void {
  bandFontListeners.add(l);
  return () => { bandFontListeners.delete(l); };
}

/** Build the theme registry against the active palette. It's a function (not a
 *  const) because two themes (Nirvana, NIN) deliberately keep the DEFAULT palette
 *  — their `accent`/`glow`/genre colours resolve from the live tokens. */
export function buildEggs(pal: EggPalette): Egg[] {
  return [
    {
      id: 'AC/DC', names: ['ac dc', 'acdc'], motif: 'acdc',
      font: 'Squealer',
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
      font: 'BeatlesYellowSub',
      accent: '#C9A227', glow: '#E8CF7A',
      genreText: 'Rock', genreColor: '#4A2C15',
      genreFont: 'MadieRoger', genreDroop: true,
      card: { bg: '#F3E8D2', border: '#A81F28', text: '#241608', sub: '#6B4A2A' },
      cardFrame: { width: 8, rings: ['#F3E8D2 5px', '#2E4EA0 6.5px', '#F3E8D2 17px', '#A81F28 18.5px'] },
      heroCase: 'lower', heroFont: 'SgtPeppers',
      // §4: the SgtPeppers cut is outline-only; the prototype's callLined/freqShadow
      // are KNOWN-WRONG placeholders — do not port. Hero lettering stays plain.
      rtPlate: { bg: '#FFFFFF', border: '#DED6C6', text: '#1A1A1A', serial: 'No. 0101538' },
      stripes: true, suppressLogos: true,
    },
    {
      // v1.13.0 replaced Talking Heads with this one. NO PALETTE CHANGES AT ALL —
      // default theme colours throughout, exactly like Nirvana below. Type and
      // marks only; the accent/glow/chromeInk just restate the theme's own tokens.
      id: 'Led Zeppelin', names: ['led zeppelin', 'zeppelin'], motif: 'runes',
      // Kashmir is scoped to the hero card and RadioText. Preset tiles and peek
      // cards keep the default face — a display cut at tile size is unreadable,
      // and the theme reads from the hero anyway.
      font: 'Kashmir', fontScope: 'hero',
      heroFont: 'Kashmir', heroScale: 1.3, heroStroke: 0.9,
      rtFont: 'Kashmir', rtSpacing: 2,
      accent: pal.text, glow: pal.border, chromeInk: pal.text,
      // The four marks stand IN PLACE OF the genre line, in sleeve order.
      genreArt: ['zoso', 'triquetra', 'rings', 'feather'],
      suppressLogos: true,
    },
    {
      id: 'Nirvana', names: ['nirvana'], motif: 'xerox',
      font: 'PermanentMarker',
      accent: pal.text, glow: pal.border, chromeInk: pal.text,
      genreText: 'Verse Chorus Verse', genreColor: pal.dim,
      genreFont: 'PermanentMarker',
      heroFont: 'Onyx', heroScale: 1.5,
      nameGhost: { color: 'rgba(0,0,0,0.2)', dx: 3, dy: 3 },
      suppressLogos: true, rtSpacing: 1,
    },
    {
      id: 'Nine Inch Nails', names: ['nine inch nails'], motif: 'spiral',
      font: 'Gridnik',
      accent: pal.text, glow: pal.border, chromeInk: pal.text,
      genreText: 'Broken Machines', genreCycle: ['Broken Machines', 'Things Falling Apart'], genreColor: pal.dim,
      genreFont: 'Singothic',
      rtFont: 'Singothic', freqFont: 'Singothic',
      heroFont: 'Gridnik', heroScale: 1.3, heroTrack: 9, freqScale: 0.95, heroGlitch: true,
      nameGhost: { color: 'rgba(0,0,0,0.16)', dx: 2, dy: 0 },
      suppressLogos: true, rtSpacing: 5,
    },
  ];
}

/** Lower-case + collapse every non-alphanumeric run to a space (the §12 rule). */
export function normalizeRt(rt: string | null | undefined): string {
  return (rt ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
}

/**
 * The id of the theme that should be active, or null. `forcedId` (from the
 * secret panel) wins over detection; otherwise the first theme any of whose
 * `names` appears in the normalized RadioText ON TOKEN BOUNDARIES.
 *
 * Boundaries, not raw substrings. `normalizeRt` turns punctuation into spaces,
 * which is what lets "AC/DC" match the stored "ac dc" — but it also means an
 * advert for "Hometown HVAC DC power" normalizes to "hometown hvac dc power",
 * which CONTAINS "ac dc" and used to repaint the entire app as AC/DC.
 *
 * That stopped being hypothetical on 2026-08-04: WIBA began rotating adverts
 * through RadioText ("NicoletLaw.com  Injured? Get Nicolet!"), so this matcher
 * now runs against arbitrary ad copy rather than a fixed station slogan.
 *
 * Padding both sides with a space and searching for the padded name gives whole
 * tokens for free, without a regex per entry. Pure + testable.
 */
export function matchEggId(rt: string | null | undefined, forcedId?: string | null): string | null {
  if (forcedId) return forcedId;
  const norm = normalizeRt(rt);
  if (!norm.trim()) return null;
  const padded = ` ${norm.trim().replace(/\s+/g, ' ')} `;
  for (const e of MATCH_TABLE) if (e.names.some((n) => padded.indexOf(` ${n} `) >= 0)) return e.id;
  return null;
}

/** id+names only — enough to match without a palette (keeps matchEggId pure). */
const MATCH_TABLE: { id: string; names: string[] }[] = [
  { id: 'AC/DC', names: ['ac dc', 'acdc'] },
  { id: 'The Beatles', names: ['beatles'] },
  { id: 'Led Zeppelin', names: ['led zeppelin', 'zeppelin'] },
  { id: 'Nirvana', names: ['nirvana'] },
  { id: 'Nine Inch Nails', names: ['nine inch nails'] },
];

/** Every theme's id + its secret-panel pun label, in registry order. */
export const EGG_MENU: { id: string; label: string }[] = [
  { id: 'AC/DC', label: 'Powerage' },
  { id: 'The Beatles', label: 'The Walrus was Paul' },
  { id: 'Led Zeppelin', label: 'Hammer of the Gods' },
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
