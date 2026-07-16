/**
 * CarFM custom icons, redrawn as react-native-svg from the design handoff
 * (all icons in the design are inline SVG; no external icon assets).
 */
import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

/**
 * Three concentric broadcast waves around a dot; `strength` 0–4 controls how
 * many waves are amber (position encodes strength — never colour alone).
 */
export function SignalWaves({ size = 26, strength, on, off }: {
  size?: number; strength: number; on: string; off: string;
}) {
  const s = Math.max(0, Math.min(4, strength));
  const col = (i: number) => (s > i ? on : off);
  return (
    <Svg width={size} height={size} viewBox="0 0 26 26">
      <Circle cx="13" cy="13" r="2.4" fill={col(0)} />
      {/* left + right wave pairs, inner→outer */}
      <Path d="M8.6 8.6a6.2 6.2 0 0 0 0 8.8" stroke={col(1)} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M17.4 8.6a6.2 6.2 0 0 1 0 8.8" stroke={col(1)} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M5.4 5.4a10.7 10.7 0 0 0 0 15.2" stroke={col(2)} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M20.6 5.4a10.7 10.7 0 0 1 0 15.2" stroke={col(2)} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M2.3 2.3a15.1 15.1 0 0 0 0 21.4" stroke={col(3)} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M23.7 2.3a15.1 15.1 0 0 1 0 21.4" stroke={col(3)} strokeWidth="2" strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** Filled (saved) or outline star. */
export function StarIcon({ size = 26, filled, color, outline }: {
  size?: number; filled: boolean; color: string; outline: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z"
        fill={filled ? color : 'none'}
        stroke={filled ? color : outline}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Seek glyph: |◄ / ►| (bar + triangle), like the design's scan icon. */
export function SeekIcon({ size = 30, dir, color }: { size?: number; dir: 1 | -1; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {dir < 0 ? (
        <>
          <Rect x="4" y="4" width="2.6" height="16" rx="1.3" fill={color} />
          <Path d="M19 4.6v14.8L8.6 12 19 4.6z" fill={color} />
        </>
      ) : (
        <>
          <Rect x="17.4" y="4" width="2.6" height="16" rx="1.3" fill={color} />
          <Path d="M5 4.6v14.8L15.4 12 5 4.6z" fill={color} />
        </>
      )}
    </Svg>
  );
}

/**
 * The NEARBY disc icon: thin-line magnifying glass (large lens, ~5 o'clock
 * stubby handle) with a radio tower inside (A-frame legs, one low X-brace,
 * antenna mast + radiating waves). Colour anatomy per the handoff tweaks.
 */
export function MagnifierTower({ size = 92, line, glass }: {
  size?: number; line: string; glass: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      {/* lens */}
      <Circle cx="29" cy="27" r="18" fill={glass} stroke={line} strokeWidth="3" />
      {/* stubby butt-capped handle toward 5 o'clock */}
      <Line x1="42" y1="40.5" x2="51" y2="50" stroke={line} strokeWidth="6" strokeLinecap="round" />
      {/* tower: A-frame legs with slight barrel bow (lens refraction) */}
      <Path d="M24.5 37 Q26.5 26 28.2 17.5" stroke={line} strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <Path d="M33.5 37 Q31.5 26 29.8 17.5" stroke={line} strokeWidth="2.2" strokeLinecap="round" fill="none" />
      {/* single X-brace low in the body */}
      <Line x1="25.4" y1="33.4" x2="32.8" y2="29.2" stroke={line} strokeWidth="1.7" strokeLinecap="round" />
      <Line x1="25.2" y1="29.2" x2="32.6" y2="33.4" stroke={line} strokeWidth="1.7" strokeLinecap="round" />
      {/* antenna mast */}
      <Line x1="29" y1="17.5" x2="29" y2="12.5" stroke={line} strokeWidth="2" strokeLinecap="round" />
      {/* radiating waves from the mast tip */}
      <Path d="M24.6 12.4a6.2 6.2 0 0 1 8.8 0" stroke={line} strokeWidth="1.7" strokeLinecap="round" fill="none" />
      <Path d="M22.2 9.9a9.6 9.6 0 0 1 13.6 0" stroke={line} strokeWidth="1.7" strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** Small ◎ target glyph for the STEREO pill. */
export function StereoDot({ size = 16, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.8" fill="none" />
      <Circle cx="8" cy="8" r="2.2" fill={color} />
    </Svg>
  );
}

/** Backspace key glyph for the numpad. */
export function BackspaceIcon({ size = 30, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M8.2 5h11.3A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H8.2a1.5 1.5 0 0 1-1.1-.5L2 12l5.1-6.5a1.5 1.5 0 0 1 1.1-.5z"
        stroke={color} strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      <Line x1="11" y1="9.5" x2="16" y2="14.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <Line x1="16" y1="9.5" x2="11" y2="14.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}
