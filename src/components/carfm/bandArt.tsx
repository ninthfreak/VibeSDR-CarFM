// bandArt.ts — the SUPPLIED §12 band-theme vector art (v1.12.0 handoff, art/).
// Rendered from the real SVG files via react-native-svg SvgXml — the spec's rule #1
// (ship the files; never redraw or substitute a glyph). Gears + bolt use
// currentColor, tinted per theme via SvgXml's `color` prop; the horns bake their
// own #E31E24 stroke + red glow and are drawn as-is (no tint).
import React from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import Svg, { Defs, FeDropShadow, Filter, G, Path } from 'react-native-svg';
import type { Motif, RuneKey } from './bandThemes';

export const HORN_LEFT = `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="96" viewBox="0 0 70 96" fill="none"><defs><filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="rgba(255,59,48,0.7)"></feDropShadow></filter></defs><g stroke="#E31E24" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" transform="rotate(-2.5 35 48)"><path d="M22.50 90.50 L21.76 88.03" stroke-width="6.47"></path><path d="M21.76 88.03 L21.04 85.50" stroke-width="6.16"></path><path d="M21.04 85.50 L20.34 82.94" stroke-width="5.83"></path><path d="M20.34 82.94 L19.66 80.33" stroke-width="5.49"></path><path d="M19.66 80.33 L18.99 77.69" stroke-width="5.15"></path><path d="M18.99 77.69 L18.35 75.00" stroke-width="4.83"></path><path d="M18.35 75.00 L17.72 72.29" stroke-width="4.55"></path><path d="M17.72 72.29 L17.11 69.55" stroke-width="4.34"></path><path d="M17.11 69.55 L16.51 66.78" stroke-width="4.21"></path><path d="M16.51 66.78 L15.93 63.98" stroke-width="4.07"></path><path d="M15.93 63.98 L15.37 61.17" stroke-width="3.93"></path><path d="M15.37 61.17 L14.82 58.33" stroke-width="3.78"></path><path d="M14.82 58.33 L14.29 55.48" stroke-width="3.63"></path><path d="M14.29 55.48 L13.78 52.62" stroke-width="3.47"></path><path d="M13.78 52.62 L13.28 49.75" stroke-width="3.33"></path><path d="M13.28 49.75 L12.79 46.87" stroke-width="3.19"></path><path d="M12.79 46.87 L12.31 43.99" stroke-width="3.05"></path><path d="M12.31 43.99 L11.85 41.11" stroke-width="2.92"></path><path d="M11.85 41.11 L11.40 38.23" stroke-width="2.78"></path><path d="M11.40 38.23 L10.97 35.35" stroke-width="2.64"></path><path d="M10.97 35.35 L10.54 32.48" stroke-width="2.49"></path><path d="M10.54 32.48 L10.13 29.63" stroke-width="2.34"></path><path d="M10.13 29.63 L9.73 26.78" stroke-width="2.20"></path><path d="M9.73 26.78 L9.34 23.96" stroke-width="2.05"></path><path d="M9.34 23.96 L8.96 21.15" stroke-width="1.90"></path><path d="M8.96 21.15 L8.59 18.36" stroke-width="1.80"></path><path d="M8.59 18.36 L8.23 15.60" stroke-width="1.75"></path><path d="M8.23 15.60 L7.88 12.87" stroke-width="1.73"></path><path d="M7.88 12.87 L7.53 10.17" stroke-width="1.72"></path><path d="M7.53 10.17 L7.20 7.50" stroke-width="1.69"></path><path d="M5.60 3.60 L7.08 5.83" stroke-width="1.89"></path><path d="M7.08 5.83 L8.63 8.03" stroke-width="2.12"></path><path d="M8.63 8.03 L10.25 10.21" stroke-width="2.33"></path><path d="M10.25 10.21 L11.93 12.36" stroke-width="2.50"></path><path d="M11.93 12.36 L13.67 14.48" stroke-width="2.63"></path><path d="M13.67 14.48 L15.47 16.57" stroke-width="2.72"></path><path d="M15.47 16.57 L17.32 18.62" stroke-width="2.80"></path><path d="M17.32 18.62 L19.21 20.64" stroke-width="2.87"></path><path d="M19.21 20.64 L21.15 22.62" stroke-width="2.95"></path><path d="M21.15 22.62 L23.12 24.57" stroke-width="3.05"></path><path d="M23.12 24.57 L25.13 26.47" stroke-width="3.18"></path><path d="M25.13 26.47 L27.16 28.33" stroke-width="3.31"></path><path d="M27.16 28.33 L29.22 30.15" stroke-width="3.39"></path><path d="M29.22 30.15 L31.30 31.92" stroke-width="3.44"></path><path d="M31.30 31.92 L33.39 33.64" stroke-width="3.47"></path><path d="M33.39 33.64 L35.49 35.31" stroke-width="3.50"></path><path d="M35.49 35.31 L37.60 36.93" stroke-width="3.54"></path><path d="M37.60 36.93 L39.71 38.50" stroke-width="3.61"></path><path d="M39.71 38.50 L41.81 40.01" stroke-width="3.70"></path><path d="M41.81 40.01 L43.91 41.47" stroke-width="3.82"></path><path d="M43.91 41.47 L46.00 42.86" stroke-width="3.94"></path><path d="M46.00 42.86 L48.07 44.20" stroke-width="4.06"></path><path d="M48.07 44.20 L50.12 45.47" stroke-width="4.18"></path><path d="M50.12 45.47 L52.14 46.68" stroke-width="4.29"></path><path d="M52.14 46.68 L54.13 47.83" stroke-width="4.40"></path><path d="M54.13 47.83 L56.09 48.91" stroke-width="4.50"></path><path d="M56.09 48.91 L58.02 49.91" stroke-width="4.60"></path><path d="M58.02 49.91 L59.89 50.85" stroke-width="4.70"></path><path d="M59.89 50.85 L61.72 51.71" stroke-width="4.87"></path><path d="M61.72 51.71 L63.50 52.50" stroke-width="5.08"></path></g></svg>`;
export const HORN_RIGHT = `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="96" viewBox="0 0 70 96" fill="none"><defs><filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="2.5" flood-color="rgba(255,59,48,0.7)"></feDropShadow></filter></defs><g stroke="#E31E24" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" transform="rotate(3 35 48)"><path d="M47.50 90.50 L48.15 88.21" stroke-width="5.45"></path><path d="M48.15 88.21 L48.79 85.85" stroke-width="5.21"></path><path d="M48.79 85.85 L49.43 83.42" stroke-width="5.03"></path><path d="M49.43 83.42 L50.07 80.93" stroke-width="4.89"></path><path d="M50.07 80.93 L50.69 78.38" stroke-width="4.81"></path><path d="M50.69 78.38 L51.32 75.77" stroke-width="4.78"></path><path d="M51.32 75.77 L51.93 73.11" stroke-width="4.77"></path><path d="M51.93 73.11 L52.54 70.40" stroke-width="4.78"></path><path d="M52.54 70.40 L53.14 67.65" stroke-width="4.78"></path><path d="M53.14 67.65 L53.73 64.86" stroke-width="4.76"></path><path d="M53.73 64.86 L54.31 62.03" stroke-width="4.70"></path><path d="M54.31 62.03 L54.87 59.18" stroke-width="4.60"></path><path d="M54.87 59.18 L55.43 56.29" stroke-width="4.47"></path><path d="M55.43 56.29 L55.98 53.39" stroke-width="4.33"></path><path d="M55.98 53.39 L56.51 50.46" stroke-width="4.18"></path><path d="M56.51 50.46 L57.03 47.52" stroke-width="4.04"></path><path d="M57.03 47.52 L57.54 44.57" stroke-width="3.89"></path><path d="M57.54 44.57 L58.03 41.62" stroke-width="3.74"></path><path d="M58.03 41.62 L58.51 38.66" stroke-width="3.59"></path><path d="M58.51 38.66 L58.97 35.71" stroke-width="3.45"></path><path d="M58.97 35.71 L59.42 32.76" stroke-width="3.28"></path><path d="M59.42 32.76 L59.85 29.82" stroke-width="3.05"></path><path d="M59.85 29.82 L60.26 26.90" stroke-width="2.79"></path><path d="M60.26 26.90 L60.66 23.99" stroke-width="2.52"></path><path d="M60.66 23.99 L61.03 21.11" stroke-width="2.25"></path><path d="M61.03 21.11 L61.39 18.26" stroke-width="2.01"></path><path d="M61.39 18.26 L61.72 15.44" stroke-width="1.80"></path><path d="M61.72 15.44 L62.04 12.65" stroke-width="1.64"></path><path d="M62.04 12.65 L62.33 9.90" stroke-width="1.53"></path><path d="M62.33 9.90 L62.60 7.20" stroke-width="1.47"></path><path d="M64.60 4.20 L63.10 6.37" stroke-width="1.87"></path><path d="M63.10 6.37 L61.53 8.53" stroke-width="1.94"></path><path d="M61.53 8.53 L59.90 10.67" stroke-width="1.99"></path><path d="M59.90 10.67 L58.20 12.80" stroke-width="2.04"></path><path d="M58.20 12.80 L56.44 14.89" stroke-width="2.13"></path><path d="M56.44 14.89 L54.63 16.97" stroke-width="2.28"></path><path d="M54.63 16.97 L52.77 19.01" stroke-width="2.48"></path><path d="M52.77 19.01 L50.87 21.02" stroke-width="2.67"></path><path d="M50.87 21.02 L48.92 23.00" stroke-width="2.86"></path><path d="M48.92 23.00 L46.94 24.95" stroke-width="3.04"></path><path d="M46.94 24.95 L44.92 26.85" stroke-width="3.22"></path><path d="M44.92 26.85 L42.88 28.72" stroke-width="3.39"></path><path d="M42.88 28.72 L40.82 30.53" stroke-width="3.55"></path><path d="M40.82 30.53 L38.73 32.30" stroke-width="3.70"></path><path d="M38.73 32.30 L36.64 34.02" stroke-width="3.85"></path><path d="M36.64 34.02 L34.53 35.69" stroke-width="4.06"></path><path d="M34.53 35.69 L32.42 37.31" stroke-width="4.30"></path><path d="M32.42 37.31 L30.31 38.86" stroke-width="4.55"></path><path d="M30.31 38.86 L28.20 40.35" stroke-width="4.80"></path><path d="M28.20 40.35 L26.10 41.79" stroke-width="5.02"></path><path d="M26.10 41.79 L24.01 43.15" stroke-width="5.20"></path><path d="M24.01 43.15 L21.94 44.44" stroke-width="5.33"></path><path d="M21.94 44.44 L19.89 45.67" stroke-width="5.41"></path><path d="M19.89 45.67 L17.86 46.82" stroke-width="5.48"></path><path d="M17.86 46.82 L15.87 47.89" stroke-width="5.54"></path><path d="M15.87 47.89 L13.91 48.88" stroke-width="5.60"></path><path d="M13.91 48.88 L11.99 49.79" stroke-width="5.65"></path><path d="M11.99 49.79 L10.11 50.62" stroke-width="5.71"></path><path d="M10.11 50.62 L8.28 51.35" stroke-width="5.76"></path><path d="M8.28 51.35 L6.50 52.00" stroke-width="5.81"></path></g></svg>`;
export const BOLT = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path d="M10.8 1.6 L18.2 1.6 L12.4 10.4 L16.8 10.4 L5.6 22.4 L10.4 13.2 L5.9 13.2 Z" fill="currentColor"></path></svg>`;
export const GEAR_BEATLES = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.2"></circle><circle cx="12" cy="12" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3"></circle><path d="M2.4 9.6 L21.6 9.6 L21.6 14.4 L2.4 14.4 Z" fill="currentColor" opacity="0.9"></path><path d="M12 2 L12 4.4 M12 19.6 L12 22 M2 12 L4.4 12 M19.6 12 L22 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>`;
export const GEAR_NIRVANA = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M6.7 7.9 L9.7 10.9 M9.7 7.9 L6.7 10.9" stroke-width="1.5"></path><path d="M14.3 7.9 L17.3 10.9 M17.3 7.9 L14.3 10.9" stroke-width="1.5"></path><rect x="13.7" y="16.2" width="2.8" height="4.4" rx="1.4" fill="currentColor" stroke="none" transform="rotate(-16 15.1 16.4)"></rect><path d="M7 14.9 Q12 19.6 17 14.9" stroke-width="1.7"></path></svg>`;
export const GEAR_NIN = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M14.90 22.39 L16.86 21.43" stroke-width="0.90"></path><path d="M16.86 21.43 L18.53 20.11" stroke-width="0.93"></path><path d="M18.53 20.11 L19.86 18.51" stroke-width="0.97"></path><path d="M19.86 18.51 L20.80 16.73" stroke-width="1.01"></path><path d="M20.80 16.73 L21.36 14.85" stroke-width="1.04"></path><path d="M21.36 14.85 L21.54 12.94" stroke-width="1.08"></path><path d="M21.54 12.94 L21.35 11.06" stroke-width="1.12"></path><path d="M21.35 11.06 L20.76 9.28" stroke-width="1.16"></path><path d="M20.76 9.28 L19.82 7.68" stroke-width="1.22"></path><path d="M19.82 7.68 L18.59 6.33" stroke-width="1.27"></path><path d="M18.59 6.33 L17.11 5.26" stroke-width="1.33"></path><path d="M17.11 5.26 L15.47 4.53" stroke-width="1.39"></path><path d="M15.47 4.53 L13.74 4.13" stroke-width="1.45"></path><path d="M13.74 4.13 L11.99 4.08" stroke-width="1.51"></path><path d="M11.99 4.08 L10.29 4.35" stroke-width="1.57"></path><path d="M10.29 4.35 L8.68 4.93" stroke-width="1.63"></path><path d="M8.68 4.93 L7.25 5.79" stroke-width="1.69"></path><path d="M7.25 5.79 L6.03 6.91" stroke-width="1.74"></path><path d="M6.03 6.91 L5.09 8.24" stroke-width="1.79"></path><path d="M5.09 8.24 L4.47 9.72" stroke-width="1.84"></path><path d="M4.47 9.72 L4.20 11.28" stroke-width="1.88"></path><path d="M4.20 11.28 L4.32 12.83" stroke-width="1.92"></path><path d="M4.32 12.83 L4.81 14.28" stroke-width="1.95"></path><path d="M4.81 14.28 L5.60 15.54" stroke-width="1.98"></path><path d="M5.60 15.54 L6.63 16.56" stroke-width="1.99"></path><path d="M6.63 16.56 L7.81 17.33" stroke-width="2.00"></path><path d="M7.81 17.33 L9.07 17.84" stroke-width="2.01"></path><path d="M9.07 17.84 L10.34 18.13" stroke-width="2.02"></path><path d="M10.34 18.13 L11.61 18.20" stroke-width="2.02"></path><path d="M11.61 18.20 L12.84 18.05" stroke-width="2.02"></path><path d="M12.84 18.05 L13.99 17.67" stroke-width="2.01"></path><path d="M13.99 17.67 L15.03 17.08" stroke-width="2.00"></path><path d="M15.03 17.08 L15.91 16.32" stroke-width="1.99"></path><path d="M15.91 16.32 L16.59 15.41" stroke-width="1.98"></path><path d="M16.59 15.41 L17.04 14.39" stroke-width="1.97"></path><path d="M17.04 14.39 L17.26 13.33" stroke-width="1.96"></path><path d="M17.26 13.33 L17.22 12.27" stroke-width="1.94"></path><path d="M17.22 12.27 L16.95 11.27" stroke-width="1.93"></path><path d="M16.95 11.27 L16.47 10.39" stroke-width="1.91"></path><path d="M16.47 10.39 L15.83 9.64" stroke-width="1.90"></path><path d="M15.83 9.64 L15.07 9.07" stroke-width="1.88"></path><path d="M15.07 9.07 L14.24 8.67" stroke-width="1.87"></path><path d="M14.24 8.67 L13.38 8.44" stroke-width="1.86"></path><path d="M13.38 8.44 L12.53 8.36" stroke-width="1.85"></path><path d="M12.53 8.36 L11.70 8.41" stroke-width="1.83"></path><path d="M11.70 8.41 L10.90 8.58" stroke-width="1.82"></path><path d="M10.90 8.58 L10.15 8.89" stroke-width="1.80"></path><path d="M10.15 8.89 L9.48 9.34" stroke-width="1.77"></path><path d="M9.48 9.34 L8.93 9.91" stroke-width="1.74"></path><path d="M8.93 9.91 L8.54 10.60" stroke-width="1.71"></path><path d="M8.54 10.60 L8.36 11.34" stroke-width="1.68"></path><path d="M8.36 11.34 L8.33 12.09" stroke-width="1.64"></path><path d="M8.33 12.09 L8.43 12.81" stroke-width="1.60"></path><path d="M8.43 12.81 L8.65 13.49" stroke-width="1.56"></path><path d="M8.65 13.49 L8.99 14.11" stroke-width="1.52"></path><path d="M8.99 14.11 L9.46 14.64" stroke-width="1.48"></path><path d="M9.46 14.64 L10.04 15.05" stroke-width="1.44"></path><path d="M10.04 15.05 L10.69 15.30" stroke-width="1.40"></path><path d="M10.69 15.30 L11.37 15.37" stroke-width="1.36"></path><path d="M11.37 15.37 L12.03 15.28" stroke-width="1.32"></path><path d="M12.03 15.28 L12.62 15.05" stroke-width="1.29"></path><path d="M12.62 15.05 L13.11 14.71" stroke-width="1.25"></path><path d="M13.11 14.71 L13.49 14.30" stroke-width="1.22"></path><path d="M13.49 14.30 L13.75 13.85" stroke-width="1.19"></path><path d="M13.75 13.85 L13.90 13.39" stroke-width="1.17"></path><path d="M13.90 13.39 L13.96 12.95" stroke-width="1.16"></path><path d="M13.96 12.95 L13.88 12.53" stroke-width="1.15"></path><path d="M13.88 12.53 L13.65 12.17" stroke-width="1.15"></path><path d="M13.65 12.17 L13.33 11.92" stroke-width="1.16"></path><path d="M13.33 11.92 L12.98 11.79" stroke-width="1.16"></path><path d="M12.98 11.79 L12.64 11.78" stroke-width="1.17"></path><path d="M12.64 11.78 L12.37 11.85" stroke-width="1.18"></path></svg>`;

/** The settings-gear replacement per theme, tinted. AC/DC uses the bolt.
 *
 *  PARTIAL on purpose: Led Zeppelin (`runes`) replaces the vehicle-in-motion tell
 *  instead and leaves the gear alone (EASTER-EGGS §2.3), so it has no entry here
 *  and BandGear returns null for it — the caller then draws the default gear. */
const GEAR_BY_MOTIF: Partial<Record<Motif, string>> = {
  acdc: BOLT, submarine: GEAR_BEATLES,
  xerox: GEAR_NIRVANA, spiral: GEAR_NIN,
};

/** Which motifs actually replace the gear — so a caller can pick its own default
 *  rather than rendering an empty slot. */
export const BAND_GEAR_MOTIFS: ReadonlySet<Motif> =
  new Set(Object.keys(GEAR_BY_MOTIF) as Motif[]);

export function BandGear({ motif, color, size = 26 }: { motif: Motif; color: string; size?: number }) {
  const xml = GEAR_BY_MOTIF[motif];
  if (!xml) return null;
  return <SvgXml xml={xml} width={size} height={size} color={color} />;
}

/** AC/DC horns — overhang the hero card's top corners (EASTER-EGGS §2.1). Each is
*  70×96 in its own space; baked red + glow, drawn as-is (no tint, fixed L/D). */
export function AcdcHorn({ side, w = 70, h = 96 }: { side: 'left' | 'right'; w?: number; h?: number }) {
  return <SvgXml xml={side === 'left' ? HORN_LEFT : HORN_RIGHT} width={w} height={h} />;
}

/** The AC/DC bolt as a standalone glyph — the call-sign splitter (WI⚡BA) and the
*  gear replacement. `color` tints the currentColor path. */
export function AcdcBolt({ color, width, height }: { color: string; width: number; height: number }) {
  return <SvgXml xml={BOLT} width={width} height={height} color={color} />;
}

/** The concentric ring frame around a hero card (the Beatles drum-hoop). Each `ring` is a "COLOUR OFFSETpx" pair — an inset border line —
 *  rendered as a stack of pointer-inert absolute borders (RN has no CSS multi-ring
 *  box-shadow). */
export function CardFrame({ rings, radius }: { rings: string[]; radius: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      {rings.map((r, i) => {
        const sp = r.trim().split(/\s+/);
        const inset = parseFloat(sp[1] ?? '0') || 0;
        return (
          <View
            key={i}
            style={{
              position: 'absolute', top: inset, left: inset, right: inset, bottom: inset,
              borderWidth: 1.4, borderColor: sp[0], borderRadius: Math.max(0, radius - inset),
            }}
          />
        );
      })}
    </View>
  );
}

// ── Led Zeppelin (EASTER-EGGS-BUILD §2.3) ───────────────────────────────────

/**
 * Led Zeppelin's four marks, from the untitled fourth record (EASTER-EGGS-BUILD
 * §2.3). Traced outlines lifted verbatim from the handoff's `zeppelin-runes.json`
 * — they are SPECIFIC MARKS, not lettering, and must never be redrawn or stood in
 * for by a font glyph.
 *
 * `w`/`h` are each mark's own viewBox, which differ: the row is laid out by
 * HEIGHT, and each mark takes its width from its own aspect.
 */
export const RUNE_PATHS: Record<RuneKey, { d: string; w: number; h: number }> = {
  zoso: { w: 100, h: 61.2, d: 'M55.8 19.4L59.7 19.4L61.2 20.2L64.0 23.3L64.0 24.0L59.7 27.5L58.9 25.6L56.6 23.6L52.3 23.3L51.2 24.4L51.2 26.4L53.5 31.0L60.9 39.9L65.1 39.9L67.1 36.4L67.8 36.0L67.8 35.3L69.8 33.3L75.2 31.0L77.9 31.0L82.2 32.2L86.0 35.7L87.2 38.4L87.2 42.6L85.7 46.1L83.3 48.8L77.5 51.2L73.3 51.2L69.4 49.2L66.3 45.7L65.5 42.6L63.6 42.2L62.8 42.6L62.8 43.4L64.0 46.1L64.0 49.6L62.8 52.3L59.7 55.4L57.0 57.0L51.6 57.4L47.7 55.4L46.1 53.5L46.1 51.9L50.8 48.1L51.6 50.8L53.9 53.1L57.0 54.3L59.7 54.3L60.1 53.5L59.7 49.6L58.1 46.5L57.0 45.7L57.0 45.0L55.4 43.8L54.7 42.2L49.6 42.2L48.1 43.0L46.5 44.2L44.6 48.1L43.0 49.6L39.9 51.2L33.3 51.2L32.6 50.4L30.6 50.0L29.8 48.8L28.3 48.1L26.4 44.2L26.4 40.3L27.1 38.0L30.6 33.7L34.1 31.8L41.9 31.8L46.1 35.3L47.3 38.8L48.4 40.3L52.7 39.9L50.8 37.6L50.8 36.8L48.1 34.1L46.9 31.4L46.9 28.3L48.1 25.6L49.6 24.4L49.6 23.6L53.1 20.5ZM6.2 26.0L27.1 26.4L28.3 29.8L8.5 49.2L8.5 50.0L7.4 50.8L7.4 52.3L16.7 61.6L17.4 61.6L20.2 64.3L20.9 64.3L24.8 67.8L26.7 68.6L27.5 69.8L28.3 69.8L29.1 70.9L31.0 71.7L31.8 72.9L32.6 72.9L37.6 76.7L41.9 77.5L43.4 76.4L44.2 74.8L44.2 71.3L43.0 68.6L39.5 65.9L36.8 65.9L36.8 67.1L37.6 67.8L38.8 67.8L39.1 68.6L38.0 69.0L34.9 72.1L33.7 72.5L32.2 71.3L31.8 68.6L32.6 66.7L35.3 64.0L38.4 62.4L44.2 62.8L45.3 64.0L46.1 64.0L49.2 67.8L61.2 68.6L61.2 65.9L60.5 64.3L56.6 60.9L59.7 58.9L70.9 58.9L70.9 60.1L70.2 60.1L69.0 61.2L66.7 61.6L65.1 62.8L65.1 68.6L78.3 68.6L87.6 67.4L91.9 66.3L93.0 65.1L94.6 64.7L99.2 59.7L100.0 60.5L94.2 66.3L93.4 66.3L91.1 68.2L89.9 68.2L86.0 70.2L76.0 71.7L49.2 71.3L48.1 72.5L46.9 75.2L46.1 75.6L46.1 76.4L43.0 79.5L40.3 80.6L32.2 80.2L28.3 78.3L27.9 77.5L23.6 75.2L22.9 74.0L22.1 74.0L21.3 72.9L20.5 72.9L19.8 71.7L19.0 71.7L18.2 70.5L17.4 70.5L16.7 69.4L15.9 69.4L0.0 55.0L21.3 32.6L20.9 31.8L5.4 32.2L0.8 33.7L0.8 32.2L2.7 29.8L3.1 28.3L4.3 27.5L4.7 26.4ZM32.6 34.5L29.8 36.4L29.5 38.8L29.8 41.1L31.4 43.8L33.7 46.1L36.4 47.7L42.2 47.7L43.8 45.3L43.4 42.6L39.5 42.2L38.4 42.6L37.6 43.8L35.3 43.8L34.5 43.0L34.9 39.9L38.0 39.5L42.2 40.7L41.9 38.8L38.0 35.3L35.7 34.5ZM72.5 34.5L69.8 36.0L69.0 37.6L69.4 40.3L70.2 40.7L74.4 39.5L77.5 39.5L79.1 40.7L79.1 41.5L78.7 42.6L77.1 43.4L75.6 43.4L75.2 42.6L70.2 42.6L70.5 43.8L73.6 46.5L77.5 48.1L81.4 48.1L82.9 47.3L83.7 46.1L83.7 42.6L81.8 38.8L79.8 36.8L76.4 34.9Z' },
  triquetra: { w: 100, h: 91.2, d: 'M50.8 4.4L51.2 4.6L51.2 5.1L53.9 8.6L54.1 9.5L55.6 11.5L56.3 13.2L56.7 13.5L59.8 19.9L59.8 20.5L60.3 21.0L60.3 21.6L60.7 22.1L60.9 23.4L61.8 25.2L61.8 26.0L62.3 26.5L63.6 26.7L68.4 28.9L68.7 29.4L69.5 29.6L69.8 30.0L70.6 30.2L71.1 30.9L72.8 31.8L78.6 37.3L78.6 37.7L79.5 38.4L79.5 38.9L80.1 39.3L80.1 39.7L81.5 41.3L81.7 42.2L82.1 42.4L84.8 48.1L86.3 54.1L86.8 62.0L86.1 66.9L90.9 71.7L90.9 72.2L91.6 72.6L91.6 73.1L92.3 73.5L92.3 74.0L94.9 77.5L97.8 83.0L97.8 83.7L98.5 84.5L100.0 89.0L95.4 89.0L90.5 89.6L86.8 89.6L79.2 88.7L73.7 87.2L73.3 87.9L72.8 87.9L72.4 88.5L72.0 88.5L69.8 90.3L64.0 93.2L56.7 95.1L49.7 95.6L43.7 94.9L37.5 93.2L31.8 90.3L31.6 89.8L29.1 88.5L28.7 87.9L28.3 87.9L27.8 87.2L23.2 88.5L16.3 89.4L8.6 89.2L0.0 87.6L2.2 82.6L2.6 82.3L4.2 79.0L4.6 78.8L4.6 78.4L5.1 78.1L6.8 75.1L9.3 72.4L9.3 72.0L10.6 70.9L10.6 70.4L15.2 66.0L14.8 58.1L15.5 53.0L16.8 48.1L19.4 42.4L20.3 41.5L21.4 39.3L23.0 37.7L23.0 37.3L28.5 32.0L28.9 32.0L29.4 31.3L29.8 31.3L32.0 29.6L33.3 29.1L33.6 28.7L35.3 27.8L36.0 27.8L36.9 27.2L37.5 27.2L38.0 26.7L39.7 26.3L41.7 19.9L45.0 12.8L45.5 12.6L45.9 11.3L46.4 11.0L46.6 10.2L47.0 9.9L47.9 8.2L48.6 7.7L48.6 7.3ZM50.8 14.3L50.3 14.6L49.9 15.9L49.4 16.1L48.1 18.8L48.1 19.4L46.8 21.9L45.9 24.7L55.6 24.7L55.2 23.0L53.6 20.1L53.6 19.4L53.0 18.8L53.0 18.1L52.3 17.4ZM47.9 30.0L44.4 30.7L43.5 36.2L43.7 44.2L45.5 52.5L53.6 52.3L56.3 52.8L57.6 48.6L58.5 42.6L58.5 36.0L57.6 30.7L53.9 30.0ZM38.2 32.7L34.2 34.7L33.1 35.8L32.0 36.2L31.3 37.1L30.9 37.1L27.2 40.8L27.2 41.3L26.3 41.9L26.3 42.4L24.5 44.6L22.3 49.0L20.8 54.3L20.3 57.6L20.3 61.8L20.8 61.8L22.3 60.5L23.2 60.3L23.4 59.8L24.3 59.6L24.5 59.2L29.8 56.5L30.5 56.5L30.9 56.1L36.0 54.3L40.2 53.4L38.9 48.8L38.2 44.2ZM63.8 32.9L63.8 44.8L62.9 50.1L61.8 53.4L71.1 56.5L78.1 60.3L80.6 62.3L81.2 62.3L81.2 57.8L80.8 54.3L79.2 49.0L77.0 44.6L76.6 44.4L75.3 41.9L74.4 41.3L74.4 40.8L70.6 37.1L70.2 37.1L69.5 36.2L69.1 36.2L67.3 34.7ZM47.9 57.8L47.7 58.1L48.1 58.5L48.1 59.2L48.8 59.8L49.4 61.6L49.9 61.8L50.6 63.4L51.2 63.6L54.3 58.1ZM41.1 58.7L36.6 59.8L34.2 60.9L32.9 61.1L32.0 61.8L31.3 61.8L27.8 63.6L27.6 64.0L26.3 64.5L26.0 64.9L25.6 64.9L25.4 65.3L24.9 65.3L21.4 68.0L22.1 70.4L24.3 75.1L24.7 75.3L24.9 76.2L26.0 77.3L26.0 77.7L26.7 78.1L26.7 78.6L27.8 79.5L27.8 79.9L28.9 81.0L31.1 80.4L36.0 77.9L36.2 77.5L37.1 77.3L37.3 76.8L39.7 75.5L42.2 73.3L42.6 73.3L43.9 71.7L44.4 71.7L47.5 68.4L47.2 67.8L46.6 67.3L46.4 66.4L45.9 66.2L45.9 65.8L45.5 65.6L45.5 65.1L45.0 64.9L44.6 63.6L44.2 63.4L42.2 59.4L42.2 58.7ZM60.3 58.7L59.6 59.2L59.6 59.8L58.1 62.9L57.6 63.1L57.2 64.5L56.7 64.7L56.5 65.6L56.1 65.8L56.1 66.2L55.6 66.4L54.5 68.4L58.5 72.6L58.9 72.6L60.0 74.0L60.5 74.0L62.7 75.9L63.1 75.9L64.7 77.3L65.6 77.5L65.8 77.9L67.5 78.6L67.8 79.0L72.6 81.0L73.7 79.9L73.7 79.5L74.8 78.6L74.8 78.1L75.5 77.7L75.5 77.3L76.2 76.8L76.8 75.3L77.3 75.1L79.0 71.5L79.9 68.4L79.0 68.0L78.4 67.1L77.9 67.1L77.5 66.4L75.1 65.1L74.8 64.7L74.0 64.5L73.7 64.0L72.4 63.6L72.2 63.1L69.5 61.8ZM17.0 72.0L14.8 74.0L14.8 74.4L11.7 77.7L11.7 78.1L10.6 79.2L10.6 79.7L9.3 81.2L8.2 83.4L10.4 83.9L16.8 83.9L23.2 82.8L19.9 78.4L19.4 77.0L19.0 76.8L18.1 75.1L18.1 74.4L17.2 73.1ZM51.0 72.8L43.9 79.2L42.8 79.7L42.4 80.4L41.9 80.4L40.4 81.7L34.2 84.8L34.0 85.2L36.4 86.3L37.5 87.2L38.2 87.2L40.8 88.5L45.3 89.6L48.8 90.1L52.8 90.1L58.5 89.2L62.5 87.9L63.4 87.2L64.0 87.2L65.3 86.5L65.6 86.1L66.4 85.9L66.7 85.4L67.5 85.2L67.5 84.8L64.0 83.2L63.8 82.8L62.5 82.3L62.3 81.9L61.8 81.9L61.6 81.5L60.7 81.2L60.3 80.6L58.5 79.7L55.4 76.8L55.0 76.8ZM84.5 72.8L84.1 73.1L83.7 74.6L81.7 78.4L78.4 82.8L83.4 83.9L92.1 83.9L88.5 77.7L87.9 77.3L87.4 76.2L86.5 75.5L86.5 75.1L85.4 74.2L85.4 73.7Z' },
  rings: { w: 100, h: 87.1, d: 'M46.0 6.4L51.2 6.4L57.1 7.5L63.2 10.1L63.4 10.6L64.3 10.8L66.0 12.3L66.4 12.3L66.9 13.0L67.3 13.0L71.2 16.9L71.2 17.3L72.1 18.0L72.1 18.4L72.8 18.8L73.9 21.0L74.3 21.2L75.8 24.3L77.1 28.0L78.2 34.3L81.3 35.2L82.1 35.8L84.1 36.5L84.3 36.9L85.6 37.4L85.8 37.8L87.6 38.7L89.1 40.2L89.5 40.2L93.7 44.6L93.7 45.0L94.3 45.4L94.3 45.9L95.6 47.4L96.1 48.7L96.5 48.9L97.2 50.2L97.2 50.9L97.8 51.7L99.1 55.7L100.0 61.1L99.8 67.9L98.3 74.0L97.8 74.4L97.8 75.1L96.3 78.3L94.8 80.3L94.6 81.2L93.0 82.7L93.0 83.1L88.2 87.7L87.8 87.7L86.1 89.2L82.4 91.2L81.7 91.2L78.9 92.5L74.9 93.4L68.0 93.6L64.7 93.1L60.1 91.8L56.0 89.9L55.8 89.4L54.9 89.2L53.2 87.7L52.7 87.7L52.1 86.8L51.6 86.8L50.3 85.3L49.7 85.3L47.9 87.3L47.5 87.3L47.1 87.9L46.6 87.9L44.4 89.7L37.9 92.5L32.0 93.6L27.0 93.6L24.0 93.1L17.6 91.2L15.9 90.3L15.7 89.9L14.4 89.4L14.2 89.0L12.4 88.1L12.0 87.5L11.5 87.5L6.3 82.2L6.3 81.8L5.7 81.4L5.7 80.9L5.2 80.7L3.7 77.7L3.1 77.0L0.7 70.0L0.0 65.0L0.0 61.8L1.1 55.0L2.4 51.3L4.1 47.8L4.6 47.6L5.9 45.2L6.5 44.8L6.5 44.3L10.0 40.6L10.5 40.6L11.3 39.5L11.8 39.5L12.2 38.9L12.6 38.9L13.1 38.2L14.6 37.6L14.8 37.1L19.2 35.2L19.8 29.7L21.8 23.9L23.5 20.6L24.8 19.1L24.8 18.6L29.6 13.4L30.1 13.4L30.9 12.3L31.4 12.3L34.2 10.1L38.3 8.2L42.0 7.1ZM46.6 12.5L43.8 13.0L39.7 14.3L35.9 16.2L33.8 18.2L33.3 18.2L30.1 21.7L30.1 22.1L28.8 23.6L28.5 24.5L28.1 24.7L26.1 29.3L25.5 31.9L25.5 33.4L32.0 33.2L37.0 34.1L43.6 36.7L43.8 37.1L45.1 37.6L46.8 39.1L47.3 39.1L49.7 41.5L50.3 41.5L53.4 38.7L53.8 38.7L55.3 37.4L56.6 36.9L56.9 36.5L58.8 35.8L59.7 35.2L64.9 33.7L68.2 33.2L72.1 33.2L70.8 28.0L68.8 23.9L67.3 22.1L67.3 21.7L66.4 21.0L66.4 20.6L63.8 18.0L63.4 18.0L62.7 17.1L62.3 17.1L60.8 15.8L59.0 15.1L58.8 14.7L58.2 14.7L57.3 14.1L55.3 13.4L50.8 12.5ZM27.9 39.3L25.5 39.8L25.5 41.1L26.8 45.6L28.8 49.6L30.3 51.3L30.3 51.7L31.4 52.6L31.4 53.1L34.2 55.7L34.6 55.7L35.1 56.3L35.5 56.3L37.0 57.6L41.2 59.4L41.6 56.5L42.7 52.8L43.1 52.4L43.1 51.7L44.7 48.5L46.0 46.7L46.0 46.1L41.6 42.6L37.5 40.6L33.1 39.5ZM68.8 39.3L64.7 40.0L61.4 41.1L57.7 43.0L57.3 43.7L56.9 43.7L54.0 46.1L54.0 46.7L54.9 47.6L56.9 51.5L58.2 55.4L58.6 58.3L61.4 57.0L61.9 56.3L63.0 55.9L63.8 54.8L64.3 54.8L67.3 51.5L67.3 51.1L69.1 48.9L71.5 43.2L72.1 39.5ZM78.2 40.6L77.8 41.1L77.6 43.5L76.3 47.8L75.6 48.7L75.6 49.3L74.5 51.5L74.1 51.7L73.9 52.6L73.4 52.8L73.2 53.7L72.5 54.1L72.1 55.2L67.5 60.0L67.1 60.0L65.8 61.3L65.4 61.3L63.8 62.6L63.0 62.9L62.7 63.3L59.0 64.8L58.8 68.3L58.0 72.2L57.1 74.0L56.9 75.3L54.9 79.2L54.0 80.1L54.0 80.7L56.4 82.9L61.9 85.9L66.4 87.3L68.4 87.5L74.5 87.3L79.1 85.9L83.9 83.3L88.0 79.6L88.0 79.2L89.1 78.3L89.1 77.9L90.2 76.8L92.6 72.0L93.9 66.8L93.9 60.0L92.2 53.7L89.5 49.1L86.3 45.4L85.8 45.4L85.0 44.3L84.5 44.3L84.1 43.7L83.7 43.7L82.1 42.4ZM19.4 41.7L15.9 43.7L13.3 46.3L12.9 46.3L12.9 46.7L11.3 48.0L11.3 48.5L10.0 49.8L7.6 54.4L6.1 60.5L6.1 66.3L6.8 69.8L7.6 72.4L8.3 73.3L8.3 74.0L8.9 75.3L9.4 75.5L9.6 76.4L10.5 77.2L10.5 77.7L13.7 81.4L14.2 81.4L15.3 82.7L15.7 82.7L16.1 83.3L17.0 83.6L17.9 84.4L21.6 86.2L25.7 87.3L31.8 87.5L35.5 86.8L39.2 85.5L40.5 84.9L40.7 84.4L41.6 84.2L41.8 83.8L42.7 83.6L46.0 80.7L46.0 80.1L45.5 79.8L43.4 75.7L42.0 72.0L41.2 67.9L41.2 65.9L37.9 64.8L33.6 62.6L33.3 62.2L31.6 61.3L31.2 60.7L30.7 60.7L29.8 59.6L29.4 59.6L26.6 56.8L26.6 56.3L25.5 55.4L25.5 55.0L24.8 54.6L24.8 54.1L23.5 52.6L22.9 50.9L22.0 49.8L22.0 49.1L21.4 48.3L21.4 47.6L20.5 45.9L20.5 45.0L19.8 43.5L19.8 42.2ZM50.1 51.7L49.7 52.0L48.8 53.7L48.4 55.7L47.7 56.8L47.1 60.0L47.3 60.7L50.3 60.7L52.9 60.2L52.3 56.8L51.4 54.1ZM51.4 66.6L47.3 66.8L47.7 70.0L49.9 75.3L50.3 75.1L51.0 73.1L51.6 72.2L52.9 67.2L52.9 66.6Z' },
  feather: { w: 100, h: 100, d: 'M43.7 0.0L56.7 0.0L64.1 1.5L69.1 3.3L70.0 3.9L70.7 3.9L75.0 6.1L75.2 6.5L76.1 6.7L76.3 7.2L76.7 7.2L77.0 7.6L77.8 7.8L78.9 8.9L80.0 9.3L80.7 10.2L81.1 10.2L82.8 12.0L83.3 12.0L83.3 12.4L83.7 12.4L87.8 16.5L87.8 17.0L90.7 20.0L90.7 20.4L93.3 23.9L96.1 29.3L96.1 30.0L97.4 32.6L99.1 38.5L100.0 43.5L100.0 56.3L98.9 62.2L97.6 65.7L97.6 66.5L97.2 67.0L96.3 69.8L95.4 71.1L95.4 71.7L94.6 72.8L93.0 76.1L92.6 76.3L92.4 77.2L91.3 78.3L90.2 80.2L89.6 80.7L89.6 81.1L86.7 83.9L86.7 84.3L82.6 88.3L82.2 88.3L81.3 89.3L80.9 89.3L80.4 90.0L80.0 90.0L79.6 90.7L79.1 90.7L76.3 92.8L70.4 95.9L69.8 95.9L67.2 97.2L64.3 97.8L63.0 98.5L57.6 99.6L53.5 100.0L47.0 100.0L39.1 98.9L35.2 97.6L34.3 97.6L33.9 97.2L29.3 95.7L26.3 94.1L26.1 93.7L24.8 93.3L24.6 92.8L23.7 92.6L23.5 92.2L21.1 90.9L18.7 88.7L18.3 88.7L17.6 87.8L17.2 87.8L12.2 82.8L12.2 82.4L11.1 81.5L11.1 81.1L10.4 80.7L10.4 80.2L9.8 79.8L9.8 79.3L9.1 78.9L9.1 78.5L7.4 76.3L7.2 75.4L6.7 75.2L5.9 73.0L5.4 72.8L4.8 71.5L4.8 70.9L3.0 67.4L1.5 62.6L0.4 57.2L0.0 52.6L0.0 47.2L0.4 42.6L1.7 36.3L3.7 30.7L6.3 25.2L6.7 25.0L7.6 23.0L8.0 22.8L8.9 21.1L9.6 20.7L9.6 20.2L10.2 19.8L10.7 18.7L13.7 15.7L13.7 15.2L15.7 13.3L16.1 13.3L17.6 11.5L18.0 11.5L18.9 10.4L19.3 10.4L20.7 9.1L21.1 9.1L23.9 7.0L24.8 6.7L25.0 6.3L27.2 5.4L27.4 5.0L28.7 4.3L29.3 4.3L30.7 3.5L33.0 2.8L33.5 2.4L37.8 1.1ZM46.3 10.0L38.5 11.5L31.1 14.6L30.9 15.0L29.6 15.4L29.3 15.9L27.0 17.2L26.5 17.8L26.1 17.8L25.7 18.5L25.2 18.5L20.0 23.5L20.0 23.9L18.0 25.9L18.0 26.3L15.9 29.1L15.7 30.0L15.2 30.2L12.6 35.9L10.7 43.3L10.2 47.2L10.2 52.6L11.5 60.4L13.0 65.0L14.1 66.7L14.1 67.4L14.8 68.7L15.2 68.9L15.7 70.2L16.1 70.4L16.3 71.3L17.2 72.2L17.2 72.6L17.8 73.0L17.8 73.5L18.5 73.9L19.1 75.2L20.4 76.3L20.4 76.7L23.3 79.6L23.7 79.6L25.9 81.7L26.3 81.7L29.8 84.3L36.7 87.6L45.0 89.6L53.3 89.8L60.9 88.5L65.2 87.0L65.7 86.5L66.3 86.5L70.2 84.6L70.4 84.1L71.3 83.9L71.5 83.5L73.3 82.6L74.6 81.3L75.0 81.3L80.4 76.1L80.4 75.7L82.8 73.0L82.8 72.6L84.1 71.1L84.3 70.2L84.8 70.0L85.2 68.7L85.7 68.5L88.5 61.5L90.0 53.7L90.0 45.9L89.3 41.5L88.3 38.3L88.3 37.4L85.2 30.4L84.8 30.2L84.3 28.9L83.9 28.7L83.0 27.0L82.4 26.5L82.0 25.4L81.1 24.8L81.1 24.3L75.7 18.9L75.2 18.9L74.6 18.0L74.1 18.0L73.7 17.4L73.3 17.4L71.1 15.7L70.2 15.4L70.0 15.0L66.1 13.0L65.4 13.0L65.0 12.6L64.3 12.6L62.0 11.5L54.1 10.0ZM51.5 13.3L53.5 13.3L57.0 14.1L61.7 16.7L63.7 18.7L64.1 18.7L64.1 19.1L64.6 19.1L65.0 20.0L66.1 20.9L67.2 22.8L67.2 24.6L64.3 25.0L61.5 26.3L58.9 28.7L57.4 31.5L56.7 33.9L56.1 40.7L56.3 62.0L55.7 70.2L54.6 73.5L53.7 75.0L51.1 77.4L48.7 78.3L48.7 83.7L47.8 86.3L46.1 87.8L43.9 88.0L42.2 86.5L42.2 86.1L43.9 86.3L44.8 85.4L45.0 78.5L42.2 77.4L39.8 74.8L38.7 72.4L37.6 67.2L36.7 32.4L37.0 26.3L38.7 21.1L39.1 20.9L40.0 19.1L42.2 17.0L42.6 17.0L44.3 15.4L46.3 14.8L47.2 14.1ZM51.5 14.6L47.0 15.7L44.3 17.0L42.6 18.7L42.2 18.7L40.2 21.1L39.1 23.3L38.3 26.5L38.3 42.2L38.7 49.3L38.9 67.0L39.6 70.7L41.1 74.3L42.6 76.1L44.3 77.0L45.0 77.0L44.8 72.2L42.8 70.2L42.8 69.8L41.1 68.3L41.1 67.8L39.8 66.7L39.8 66.1L40.7 65.4L44.8 70.2L44.8 66.3L41.7 63.0L41.7 62.6L40.7 61.7L40.7 61.3L39.6 60.4L39.6 60.0L40.2 59.3L40.7 59.3L41.1 60.2L42.2 61.1L42.2 61.5L43.5 62.6L43.5 63.0L44.8 64.1L44.8 59.8L39.6 53.9L39.6 53.5L40.2 52.8L40.7 52.8L40.9 53.5L42.2 54.6L42.2 55.0L43.5 56.1L43.5 56.5L44.8 57.6L44.6 53.3L39.6 48.3L40.0 47.4L40.7 47.4L44.6 51.5L44.6 47.8L40.2 43.5L40.2 43.0L41.1 42.4L44.6 45.9L44.6 41.7L40.0 37.0L40.0 36.5L40.7 35.9L41.1 35.9L41.7 36.5L41.7 37.0L44.6 39.8L44.6 35.2L42.2 32.6L42.2 32.2L41.3 31.5L41.3 31.1L40.4 30.4L40.4 29.8L41.3 29.1L42.6 30.7L42.6 31.1L44.6 33.0L44.6 29.1L43.7 27.6L42.4 23.7L43.0 23.0L43.7 23.5L45.0 27.4L45.2 27.8L45.7 27.8L45.9 27.2L47.4 25.7L47.2 20.4L47.8 19.8L48.3 19.8L48.5 20.4L48.5 24.3L48.9 24.3L50.4 22.8L51.3 22.6L51.5 21.5L52.6 19.6L52.8 18.3L53.3 18.5L53.9 17.6L54.3 17.8L54.3 18.7L53.0 21.7L56.5 20.7L58.5 20.4L59.8 19.8L60.7 19.8L61.1 20.2L61.1 20.9L58.0 21.7L56.3 23.0L55.9 23.0L55.4 23.7L55.0 23.7L55.7 23.9L56.1 23.5L57.0 23.5L58.7 22.6L59.3 22.6L60.0 23.3L60.0 23.7L53.5 25.9L52.6 26.3L52.6 26.7L51.7 27.4L51.7 27.8L52.2 27.8L53.0 27.2L54.3 27.0L55.9 26.1L56.5 26.1L57.2 26.7L56.7 27.4L56.1 27.4L52.0 29.3L51.3 29.3L50.7 30.0L50.0 30.0L48.9 31.5L48.9 35.0L54.6 29.6L55.2 29.6L55.7 30.0L55.4 30.9L55.0 30.9L52.8 33.3L52.4 33.3L50.2 35.7L49.8 35.7L48.5 37.0L48.5 41.3L48.9 41.3L53.7 36.1L54.6 36.7L53.7 38.3L48.5 43.5L48.5 47.4L52.8 43.3L52.8 42.8L53.9 43.7L51.1 46.5L51.1 47.0L48.5 49.3L48.5 53.0L52.8 48.7L52.8 48.3L53.5 47.6L54.6 48.5L52.6 50.4L52.6 50.9L48.5 54.8L48.7 59.1L53.5 53.3L53.9 53.3L54.1 53.9L54.6 53.9L54.6 54.3L53.3 55.4L53.3 55.9L52.2 56.7L52.2 57.2L48.5 61.1L48.5 65.4L48.9 65.4L48.9 65.0L50.2 63.9L50.2 63.5L51.5 62.4L51.5 62.0L52.6 61.1L52.6 60.7L53.5 59.8L53.9 59.8L54.6 60.7L52.0 63.5L52.0 63.9L50.9 64.8L50.9 65.2L49.1 66.7L49.1 67.2L48.5 67.4L48.5 71.3L48.9 71.3L49.1 70.7L50.4 69.6L50.4 69.1L52.0 67.8L52.0 67.4L53.3 66.1L53.7 66.1L54.3 66.7L53.9 67.6L52.4 68.9L52.4 69.3L50.9 70.7L50.9 71.1L49.6 72.2L49.6 72.6L49.1 72.6L49.1 73.0L48.5 73.5L48.5 76.1L48.9 77.0L51.3 75.7L52.8 73.9L53.7 72.2L54.6 68.9L55.0 62.0L54.8 40.0L55.7 32.6L57.2 28.9L59.3 26.3L59.8 26.3L60.4 25.4L61.3 25.2L61.5 24.8L62.8 24.1L65.9 23.5L64.8 21.3L62.4 18.9L62.0 18.9L60.0 17.2L55.4 15.0Z' },
};

/**
 * The debossed shadow stack — the marks are CUT INTO the surface, not printed on
 * it, using the same engraved treatment as the disabled tells.
 *
 * Two hard 1px edges (light below, dark above) give the rim; two soft bloom
 * layers give the recess a wall rather than just an edge. Values verbatim from
 * §2.3's table.
 *
 * LOSSY-ELEMENTS #14 warns that RN has no filter chain and that stacking four
 * Views is wrong, because every layer must key off the GLYPH OUTLINE rather than
 * a rectangle. Both hold for RN Views — but react-native-svg 15.x carries real
 * SVG filter primitives, so the CSS chain ports directly: four feDropShadow
 * primitives, each taking the previous one's result, every one of them keyed off
 * the path itself. That is the same construction the doc asks for, without
 * shipping two baked files per mark.
 */
const RUNE_SHADOW = {
  light: [
    { dx: 0, dy: 1,   sd: 0, c: 'rgba(255,255,255,1)' },
    { dx: 0, dy: -1,  sd: 0, c: 'rgba(0,0,0,0.45)' },
    { dx: 0, dy: 2.5, sd: 2, c: 'rgba(255,255,255,0.85)' },
    { dx: 0, dy: -2,  sd: 2, c: 'rgba(0,0,0,0.28)' },
  ],
  dark: [
    { dx: 0, dy: 1,   sd: 0, c: 'rgba(255,255,255,0.28)' },
    { dx: 0, dy: -1,  sd: 0, c: 'rgba(0,0,0,0.75)' },
    { dx: 0, dy: 2.5, sd: 2, c: 'rgba(255,255,255,0.14)' },
    { dx: 0, dy: -2,  sd: 2, c: 'rgba(0,0,0,0.55)' },
  ],
};

/**
 * One rune, laid out by HEIGHT. Each mark has its own viewBox and its own aspect,
 * so the width follows from the file rather than being imposed.
 *
 * ZoSo alone needs nudging: its glyph sits high and wide in its box, so §2.3
 * gives it translateY(0.07em) and a -0.2em right margin. The other three take no
 * adjustment.
 */
export function ZeppelinRune({ mark, size, color, dark }: {
  mark: RuneKey; size: number; color: string; dark: boolean;
}) {
  const r = RUNE_PATHS[mark];
  const w = (size * r.w) / r.h;
  const id = `deboss-${mark}-${dark ? 'd' : 'l'}`;
  const layers = dark ? RUNE_SHADOW.dark : RUNE_SHADOW.light;
  return (
    <Svg width={w} height={size} viewBox={`0 0 ${r.w} ${r.h}`}
      style={mark === 'zoso' ? { transform: [{ translateY: size * 0.07 }], marginRight: -size * 0.2 } : undefined}>
      <Defs>
        <Filter id={id} x="-40%" y="-40%" width="180%" height="180%">
          {layers.map((l, i) => (
            <FeDropShadow key={i} in={i === 0 ? 'SourceGraphic' : `s${i - 1}`} result={`s${i}`}
              dx={l.dx} dy={l.dy} stdDeviation={l.sd} floodColor={l.c} />
          ))}
        </Filter>
      </Defs>
      {/* fill-opacity 0.82 so the genre line's own colour still drives the mark. */}
      <Path d={r.d} fill={color} fillOpacity={0.82} fillRule="evenodd" filter={`url(#${id})`} />
    </Svg>
  );
}

/**
 * A RIGID airship — not a blimp, which is the §2.3 reject-if. The ring frames
 * showing through the envelope are what say "rigid", so they are the one detail
 * that cannot be dropped.
 *
 * Blunt nose, tapered tail, three ring frames, small swept fins whose trailing
 * edges run back to the tail point, and a gondola under the bow. Drawn on the
 * same 34×24 viewBox as the car it replaces, at 46×33.
 *
 * It takes the motion slot's FIXED amber and its slow ~2.6s pulse from the
 * caller. A theme never recolours that slot — it is a safety colour.
 */
export function ZeppelinAirship({ w = 46, h = 33, color }: { w?: number; h?: number; color: string }) {
  return (
    <Svg width={w} height={h} viewBox="0 0 34 24">
      <G fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round">
        {/* Envelope: blunt nose right, tail drawn to a point at (3,12). */}
        <Path strokeWidth={1.5}
          d="M3 12 C8 5.4 20 4.4 28.4 9.1 C30.5 10.4 30.5 13.6 28.4 14.9 C20 19.6 8 18.6 3 12 Z" />
        {/* Three ring frames seen through the envelope — the "rigid" tell. */}
        <Path strokeWidth={1} d="M11.6 6.9 A2.7 5.4 0 0 0 11.6 17.1" />
        <Path strokeWidth={1} d="M17.4 5.7 A2.9 6.2 0 0 0 17.4 18.3" />
        <Path strokeWidth={1} d="M23.2 6.4 A2.8 5.8 0 0 0 23.2 17.6" />
        {/* Swept fins: trailing edges converge on the tail point. */}
        <Path strokeWidth={1.5} d="M8.6 8.5 L5.4 4.1 L3 12" />
        <Path strokeWidth={1.5} d="M8.6 15.5 L5.4 19.9 L3 12" />
        {/* Gondola, under the bow. */}
        <Path strokeWidth={1.5} d="M22.2 16.7 L22.2 18.9 L25.8 18.9 L25.8 16.1" />
      </G>
    </Svg>
  );
}
