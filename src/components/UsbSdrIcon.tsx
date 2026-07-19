import React from 'react';
import Svg, { Path, Line, Circle, Rect } from 'react-native-svg';

type Props = {
  /** width & height in px (icon is square) */
  size?: number;
  /** stroke + fill colour; pass your theme foreground, e.g. theme.fg */
  color?: string;
  /** base stroke weight (the bold USB-logo parts) on the 24x24 grid */
  strokeWidth?: number;
};

/**
 * UsbSdrIcon — the USB trident with an antenna (line + tip dot + radio waves
 * fanning off the top) rising from its left node. Represents local SDR
 * hardware feeding the device a radio signal over USB.
 *
 * Single-colour, 24x24 grid. The trident keeps the bold USB-logo weight; the
 * antenna mast and waves are drawn finer. Pass `color={theme.fg}` and it tints
 * to the active CarFM theme (default or amber/Nixie). Reads best at ~28px+.
 */
export default function UsbSdrIcon({
  size = 24,
  color = 'currentColor',
  strokeWidth = 2.4,
}: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* radio waves off the top (right inner/outer, left inner/outer) */}
      <Path d="M7.59 8.41 A2.3 2.3 0 0 0 6.26 5.57" strokeWidth={1.4} />
      <Path d="M9.58 9.06 A4.4 4.4 0 0 0 7.05 3.62" strokeWidth={1.4} />
      <Path d="M3.21 8.41 A2.3 2.3 0 0 1 4.54 5.57" strokeWidth={1.4} />
      <Path d="M1.22 9.06 A4.4 4.4 0 0 1 3.75 3.62" strokeWidth={1.4} />
      {/* tip dot */}
      <Circle cx="5.4" cy="7.7" r="1.15" fill={color} stroke="none" />
      {/* antenna mast (line) */}
      <Line x1="5.4" y1="8.9" x2="5.4" y2="14.4" strokeWidth={1.8} />
      {/* USB trident: left node */}
      <Circle cx="5.4" cy="15" r="1.8" fill={color} stroke="none" />
      {/* shaft to arrow */}
      <Line x1="5.4" y1="15" x2="17.8" y2="15" />
      {/* arrow head */}
      <Path d="M17.4 11.9 L22.3 15 L17.4 18.1 Z" fill={color} stroke="none" />
      {/* upper branch -> circle */}
      <Path d="M9.2 15 C 9.2 12.1 11.2 11 12.6 11" />
      <Circle cx="13.1" cy="11" r="1.6" fill={color} stroke="none" />
      {/* lower branch -> square */}
      <Path d="M11.1 15 C 11.1 17.9 13.1 19.4 14.1 19.4" />
      <Rect x="13.4" y="17.9" width="3" height="3" rx="0.3" fill={color} stroke="none" />
    </Svg>
  );
}
