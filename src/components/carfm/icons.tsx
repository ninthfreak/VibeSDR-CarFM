/**
 * CarFM custom icons, redrawn as react-native-svg from the design handoff
 * (all icons in the design are inline SVG; no external icon assets).
 */
import React from 'react';
import Svg, { Circle, G, Line, Path, Polygon, Rect } from 'react-native-svg';

/**
 * Three concentric broadcast waves around a dot; `strength` 0–4 controls how
 * many waves are amber (position encodes strength — never colour alone).
 */
export function SignalWaves({ size = 33, strength, on, off }: {
  size?: number; strength: number; on: string; off: string;
}) {
  // Exact port of RadioFace.dc.html `signalIcon`: viewBox 0 0 34 24, centre dot +
  // three concentric arc pairs at r 5 / 8.7 / 12.5, lit by level (dot ≥1, pairs
  // ≥2/≥3/≥4). Width from the caller; height keeps the 34:24 viewBox aspect.
  const s = Math.max(0, Math.min(4, strength));
  const col = (n: number) => (s >= n ? on : off);
  const arc = (d: string, lvl: number) => (
    <Path d={d} stroke={col(lvl)} strokeWidth={2.2} strokeLinecap="round" fill="none" />
  );
  return (
    <Svg width={size} height={Math.round((size * 24) / 34)} viewBox="0 0 34 24">
      <Circle cx={15} cy={12} r={2.6} fill={col(1)} />
      {arc('M11 8 A 5 5 0 0 0 11 16', 2)}
      {arc('M19 8 A 5 5 0 0 1 19 16', 2)}
      {arc('M7.5 5 A 8.7 8.7 0 0 0 7.5 19', 3)}
      {arc('M22.5 5 A 8.7 8.7 0 0 1 22.5 19', 3)}
      {arc('M4 2 A 12.5 12.5 0 0 0 4 22', 4)}
      {arc('M26 2 A 12.5 12.5 0 0 1 26 22', 4)}
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
        d="M12 17.3 L18.2 21 16.5 13.9 22 9.2 14.8 8.6 12 2 9.2 8.6 2 9.2 7.5 13.9 5.8 21 Z"
        fill={filled ? color : 'none'}
        stroke={filled ? color : outline}
        strokeWidth="1.7"
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
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
        stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"
      />
      <Line x1="12" y1="9" x2="12" y2="13" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <Line x1="12" y1="17" x2="12.01" y2="17" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

/**
 * Magnifier-over-picture — the reorder-mode "find/replace this station's logo"
 * badge glyph (RadioFace editIcon). A framed image (tiny sun + hill) with a lens
 * at lower-right; deliberately distinct from the Nearby magnifier-over-tower.
 * White stroke on the blue badge.
 */
export function LogoSearchIcon({ size = 17, color = '#FFFFFF' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="2.5" y="3.5" width="12" height="10" rx="2" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="6" cy="7" r="1.15" fill={color} />
      <Path d="M3 12 L6.8 8.3 L10 11" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="16.5" cy="16" r="4.2" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <Line x1="19.6" y1="19.1" x2="22" y2="21.5" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

/** Left-pointing back-arrow — the Nearby genre filter's "reset to All" chip. */
export function BackArrowIcon({ size = 22, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M11 5 L4 12 L11 19" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M4 12 H19" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
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

/**
 * GPS-lock glyph (§4.6): an angled satellite — body tilted ~28°, two side panels,
 * dish, and downward signal arcs. Exact port of RadioFace.dc.html `gps` SVG.
 * `color` is blue on a fix, dim text colour when unlocked (opacity set by caller).
 */
export function GpsSatellite({ size = 30, color }: { size?: number; color: string }) {
  const p = { stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G transform="rotate(-28 12 12)">
        <Rect x="0.5" y="9.9" width="7.3" height="4.2" rx="0.5" {...p} />
        <Line x1="2.9" y1="9.9" x2="2.9" y2="14.1" {...p} />
        <Line x1="5.3" y1="9.9" x2="5.3" y2="14.1" {...p} />
        <Line x1="0.5" y1="12" x2="7.8" y2="12" {...p} />
        <Rect x="16.2" y="9.9" width="7.3" height="4.2" rx="0.5" {...p} />
        <Line x1="18.6" y1="9.9" x2="18.6" y2="14.1" {...p} />
        <Line x1="21" y1="9.9" x2="21" y2="14.1" {...p} />
        <Line x1="16.2" y1="12" x2="23.5" y2="12" {...p} />
        <Path d="M7.8 12h1.3M14.9 12h1.3" {...p} />
        <Rect x="9.1" y="8.3" width="5.8" height="7.4" rx="1" {...p} />
        <Path d="M12 15.7v3.1" {...p} />
        <Path d="M9.9 18.7a3 3 0 0 0 4.2 0" {...p} />
        <Path d="M8.4 20.4a6 6 0 0 0 7.2 0" {...p} />
      </G>
    </Svg>
  );
}

/**
 * Vehicle-in-motion glyph (§4.6): a car with three trailing motion lines. Exact
 * port of RadioFace.dc.html `motion` SVG. Amber; the slow pulse is applied by the
 * caller (Animated wrapper).
 */
export function MotionCar({ size = 34, color }: { size?: number; color: string }) {
  const p = { stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <G transform="translate(2.6 1) scale(0.82)">
        <Path d="M19 17h2a1 1 0 0 0 1-1v-3c0-.9-.7-1.6-1.5-1.9L16 10l-1.9-2.4A2 2 0 0 0 12.5 7H6.2a2 2 0 0 0-1.8 1.1L2.7 11.6A3 3 0 0 0 2 13.5V16a1 1 0 0 0 1 1h1.5" {...p} />
        <Circle cx="8" cy="17" r="2" {...p} />
        <Circle cx="17" cy="17" r="2" {...p} />
        <Path d="M10 17h5" {...p} />
      </G>
      <Line x1="0.5" y1="8.5" x2="3.6" y2="8.5" {...p} />
      <Line x1="0" y1="12" x2="2.8" y2="12" {...p} />
      <Line x1="1" y1="15.5" x2="3.4" y2="15.5" {...p} />
    </Svg>
  );
}
