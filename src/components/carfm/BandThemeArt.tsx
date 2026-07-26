// BandThemeArt.tsx — the procedural per-motif art for the §12 band themes, drawn
// with react-native-svg (no bitmap assets). Each motif is a self-contained
// vector so it scales to any card size and recolours from the theme accent. The
// art is COSMETIC ornament layered behind/around the hero content — pointer-inert,
// never affecting layout (the §12 scale-up rule).
//
// Deliberately crude / hand-drawn in feel per the design brief: thick strokes,
// slight wobble, no fine detail — these read as stamped ornament, not logos.
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, G, Line, Ellipse, Rect } from 'react-native-svg';
import type { Motif } from './bandThemes';

/** Build an Archimedean spiral path in a 100×100 box (NIN). Deterministic — no
 *  Math.random (which is unavailable in some runtimes and non-reproducible). */
function spiralPath(turns = 4, step = 0.16): string {
  const cx = 50, cy = 50;
  let d = '';
  for (let a = 0; a <= turns * 2 * Math.PI; a += 0.2) {
    const r = a * (100 / (turns * 2 * Math.PI)) * 0.48 * (1 - step * 0);
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    d += (d ? ' L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return d;
}
const SPIRAL = spiralPath();

/** The big watermark motif that sits behind the hero content. `color` is the
 *  theme accent; `opacity` keeps it subordinate to the text (tuned per scheme by
 *  the caller). Sized to a square edge; the caller positions/clips it. */
export function BandMotif({ motif, color, size, opacity = 0.14 }: { motif: Motif; color: string; size: number; opacity?: number }) {
  return (
    <View pointerEvents="none" style={{ opacity }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <MotifBody motif={motif} color={color} />
      </Svg>
    </View>
  );
}

function MotifBody({ motif, color }: { motif: Motif; color: string }) {
  switch (motif) {
    case 'acdc':
      // The lightning bolt (the slash between AC and DC), thick and jagged.
      return <Path d="M58 4 L26 54 L45 54 L34 96 L78 40 L56 40 L70 4 Z" fill={color} />;
    case 'spiral':
      // NIN concentric spiral, drawn as a stroked path.
      return <Path d={SPIRAL} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />;
    case 'xerox':
      // Nirvana wobbly xerox smiley: off-kilter circle, X eyes, drunken grin + tongue.
      return (
        <G stroke={color} strokeWidth={3.2} strokeLinecap="round" fill="none">
          <Path d="M50 8 C74 8 92 27 92 50 C92 74 73 92 50 92 C26 92 8 72 9 49 C10 27 27 9 50 8 Z" />
          {/* left X eye */}
          <Line x1="30" y1="38" x2="40" y2="48" /><Line x1="40" y1="38" x2="30" y2="48" />
          {/* right eye — the classic lopsided X */}
          <Line x1="60" y1="40" x2="72" y2="52" /><Line x1="72" y1="40" x2="60" y2="52" />
          {/* drunken grin with a tongue lolling out */}
          <Path d="M26 62 C38 82 64 82 76 64" />
          <Path d="M63 74 C64 82 72 82 72 73" fill={color} />
        </G>
      );
    case 'submarine':
      // The Beatles yellow submarine: hull, conning tower, periscope, portholes.
      return (
        <G fill={color} stroke={color} strokeWidth={2}>
          <Ellipse cx="50" cy="58" rx="42" ry="16" fill={color} stroke="none" />
          <Rect x="42" y="34" width="16" height="14" rx="3" fill={color} stroke="none" />
          <Line x1="50" y1="34" x2="50" y2="20" strokeWidth={3} strokeLinecap="round" />
          <Circle cx="50" cy="18" r="4" fill={color} stroke="none" />
          <Circle cx="34" cy="58" r="4.5" fill="#ffffff" stroke="none" />
          <Circle cx="50" cy="58" r="4.5" fill="#ffffff" stroke="none" />
          <Circle cx="66" cy="58" r="4.5" fill="#ffffff" stroke="none" />
        </G>
      );
    case 'bigsuit':
      // Talking Heads "Stop Making Sense" big suit: broad boxy shoulders, small head.
      return (
        <G fill={color} stroke="none">
          <Circle cx="50" cy="16" r="9" />
          <Path d="M18 92 C18 54 30 40 50 40 C70 40 82 54 82 92 Z" />
          <Path d="M50 40 L44 92 L56 92 Z" fill="#ffffff" opacity={0.35} />
        </G>
      );
    default:
      return null;
  }
}

/** A small lightning-bolt glyph (AC/DC): reused for the settings-gear swap and the
 *  call-sign bolt. Draws in `color` at the requested pixel size. */
export function BoltGlyph({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Path d="M58 4 L26 54 L45 54 L34 96 L78 40 L56 40 L70 4 Z" fill={color} />
    </Svg>
  );
}
