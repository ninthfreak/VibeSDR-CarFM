/**
 * VfoLockIcon — a tiny spectrum-trace-with-padlock glyph for the VFO Lock
 * toggle (BRIEF-vfo-lock-and-panning §7/§5.9). Single colour per state; the
 * open shackle is the closed shackle swung up on its right foot.
 *   locked   → amber, closed padlock (view follows the VFO — today's default)
 *   unlocked → green, open padlock   (waterfall pans freely)
 */
import React from 'react';
import Svg, { Polyline, Line, Rect, Circle, Path } from 'react-native-svg';

export default function VfoLockIcon({
  size = 24,
  locked = true,
  lockedColor = '#ffb833',
  unlockedColor = '#3ddc84',
}: {
  size?: number;
  locked?: boolean;
  lockedColor?: string;
  unlockedColor?: string;
}) {
  const c = locked ? lockedColor : unlockedColor;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityLabel={locked ? 'VFO locked' : 'VFO unlocked'}
    >
      <Polyline
        points="2,20 3.2,19.2 4,19.6 5,17.5 6,19.4 7,18.8 8,15.5 9,19.3 10,18 11,12.5 12,19 13,18.4 14,19.2 15,16 16,19 17,18.3 18,19.3 19,17.6 20,19.4 21,19 22,20"
        fill="none"
        stroke={c}
        strokeWidth={1.3}
        strokeLinejoin="round"
        opacity={0.82}
      />
      <Line x1={11} y1={20} x2={11} y2={7} stroke={c} strokeWidth={2.1} strokeLinecap="round" />
      <Rect x={13.6} y={10} width={6} height={5} rx={1} fill="none" stroke={c} strokeWidth={1.5} />
      <Circle cx={16.6} cy={12.4} r={0.75} fill={c} />
      <Path
        d="M15.1 10 V8.3 a1.8 1.8 0 0 1 3.4 0 V10"
        fill="none"
        stroke={c}
        strokeWidth={1.5}
        strokeLinecap="round"
        transform={locked ? undefined : 'rotate(58 18.5 10)'}
      />
    </Svg>
  );
}
