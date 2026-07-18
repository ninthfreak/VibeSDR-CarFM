/**
 * CarFM custom icons, redrawn as react-native-svg from the design handoff
 * (all icons in the design are inline SVG; no external icon assets).
 */
import React from 'react';
import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg';

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
// Faithful port of the APPROVED nearby icon (RadioFace.dc.html `lensTower` +
// `nearbyIcon`, viewBox 32×32): a thin-line magnifier lens containing a radio
// tower — straight A-frame legs that widen to the base, a single X-brace, an
// antenna mast + tip dot, and symmetric radiating arc waves, all bowed by a
// subtle barrel warp (lens refraction). The earlier in-app drawing diverged
// from this; the exact source math is reproduced so it matches pixel-for-pixel.
export function MagnifierTower({ size = 92, line, glass }: {
  size?: number; line: string; glass: string;
}) {
  const cx = 14.8, apex = 12.7, base = 22.3;
  const lcx = 14.8, lcy = 14.3, R = 12, K = 0.075;   // subtle barrel magnification
  const warp = (x: number, y: number): [number, number] => {
    const dx = x - lcx, dy = y - lcy, r = Math.hypot(dx, dy) || 1e-4;
    const f = 1 + K * (1 - (r / R) * (r / R));
    return [lcx + dx * f, lcy + dy * f];
  };
  const poly = (x1: number, y1: number, x2: number, y2: number, n = 8): string => {
    let d = '';
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [x, y] = warp(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      d += (i ? ' L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d;
  };
  const half = (y: number) => 0.8 + 3.4 * ((y - apex) / (base - apex));
  const xl = (y: number) => cx - half(y), xr = (y: number) => cx + half(y);
  const yTop = apex + 3.8, yBot = base - 0.6, tipY = 9.1;
  const [wtx, wty] = warp(cx, tipY);
  const waveD = (r: number, side: 1 | -1): string =>
    `M${wtx + side * r * 0.62} ${wty - r * 0.66} A ${r} ${r} 0 0 ${side > 0 ? 1 : 0} ${wtx + side * r * 0.62} ${wty + r * 0.66}`;

  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Circle cx={14.8} cy={14.3} r={11.2} fill={glass} />
      <Circle cx={14.8} cy={14.3} r={12.0} fill="none" stroke={line} strokeWidth={1.6} />
      {/* tower: A-frame legs */}
      <Path d={poly(cx - half(base), base, cx - half(apex), apex)} stroke={line} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={poly(cx + half(base), base, cx + half(apex), apex)} stroke={line} strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* X-brace */}
      <Path d={poly(xl(yTop), yTop, xr(yBot), yBot)} stroke={line} strokeWidth={1.0} strokeLinecap="round" fill="none" />
      <Path d={poly(xr(yTop), yTop, xl(yBot), yBot)} stroke={line} strokeWidth={1.0} strokeLinecap="round" fill="none" />
      {/* mast + tip */}
      <Path d={poly(cx, apex, cx, tipY)} stroke={line} strokeWidth={1.2} strokeLinecap="round" fill="none" />
      <Circle cx={wtx} cy={wty} r={0.9} fill={line} />
      {/* symmetric radiating waves */}
      <Path d={waveD(2.6, -1)} stroke={line} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Path d={waveD(4.4, -1)} stroke={line} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Path d={waveD(2.6, 1)} stroke={line} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      <Path d={waveD(4.4, 1)} stroke={line} strokeWidth={1.1} strokeLinecap="round" fill="none" />
      {/* butt-capped handle toward 5 o'clock */}
      <Line x1={21.3} y1={25.6} x2={24.5} y2={31.1} stroke={line} strokeWidth={3.2} strokeLinecap="butt" />
    </Svg>
  );
}

/** Battery-with-bolt glyph (settings SYSTEM row); colour encodes exempt/not. */
export function BatteryBolt({ size = 32, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={8} width={15} height={9} rx={2} stroke={color} strokeWidth={2} strokeLinejoin="round" />
      <Line x1={20.5} y1={11} x2={20.5} y2={14} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Path d="M10.5 9.5 L8.5 12.5 L11 12.5 L9.5 15.5" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
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

/** Trio of curved sound waves flanking the STEREO label (design v2). `flip`
 *  mirrors it for the left side. */
export function StereoWave({ color, flip, w = 20, h = 28 }: { color: string; flip?: boolean; w?: number; h?: number }) {
  return (
    <Svg width={w} height={h} viewBox="0 0 24 30" style={flip ? { transform: [{ scaleX: -1 }] } : undefined}>
      <Path d="M4 9 Q9 15 4 21" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M9 6 Q15 15 9 24" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
      <Path d="M14 3 Q21 15 14 27" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** Gear/settings icon (design v2 header — placeholder for the Advanced panel). */
export function GearIcon({ size = 24, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx="12" cy="12" r="3" stroke={color} strokeWidth="2" fill="none" />
      <Path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
    </Svg>
  );
}

/**
 * PREV/NEXT PRESET chevron silhouette (design v2): a notched hexagon-arrow
 * polygon computed in TRUE pixel coordinates from the measured button size, so
 * the chevron angle never distorts (the design explicitly forbids a fixed
 * viewBox stretched with preserveAspectRatio="none").
 */
export function ChevronShape({ w, h, dir, fill, stroke }: {
  w: number; h: number; dir: 1 | -1; fill: string; stroke: string;
}) {
  if (w <= 0 || h <= 0) return null;
  const pd = Math.min(22, w * 0.42);
  const my = h / 2;
  const points = dir < 0
    ? `${pd},2 ${w - 2},2 ${w - pd},${my} ${w - 2},${h - 2} ${pd},${h - 2} 2,${my}`
    : `2,2 ${w - pd},2 ${w - 2},${my} ${w - pd},${h - 2} 2,${h - 2} ${pd},${my}`;
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', top: 0, left: 0 }}>
      <Polygon points={points} fill={fill} stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" />
    </Svg>
  );
}

/** Rounded warning triangle (tuner-error pill): 2px amber stroke, no fill. */
export function WarningTriangle({ size = 26, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M10.3 3.9 2.4 17.6a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
        stroke={color} strokeWidth="2" strokeLinejoin="round" fill="none"
      />
      <Line x1="12" y1="9.5" x2="12" y2="13.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <Circle cx="12" cy="16.8" r="1.15" fill={color} />
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
