/**
 * Side preset card (design handoff `wideHero`): the previous/next preset shown
 * as a faded, scaled panel card that tucks behind the hero, replacing the old
 * chevron PREV/NEXT buttons. Tapping it steps to that preset.
 *
 * This renders the card *content* only; the resting scale (0.88), opacity (0.6)
 * and tuck margin — and the hero-swap FLIP transform — are owned by the wrapper
 * in CarFmFace so the peek slots can be morphed during a preset change.
 *
 * The design fades the card's inner edge with a CSS linear-gradient mask. React
 * Native has no CSS mask and neither masked-view nor expo-linear-gradient is a
 * dependency here, so the fade is approximated with a react-native-svg gradient
 * overlay painted in the page background colour (opaque at the inner edge →
 * transparent outward), which reads the same over the flat `bg`.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import LogoTile from './LogoTile';
import { FONT, FONT_BOLD, type CarFmPalette } from './tokens';

export const PEEK_SCALE = 0.88;
export const PEEK_OPACITY = 0.6;

export default function SidePresetCard({
  name, pal, side, width, k = 1, onPress,
}: {
  name: string;
  pal: CarFmPalette;
  side: 'left' | 'right';        // 'left' = PREV (tucks under the hero's left), 'right' = NEXT
  width: number;
  /** Type/element ramp factor from the face (§0 responsive tokens). */
  k?: number;
  onPress?: () => void;
}) {
  const s = (v: number) => Math.round(v * k);
  const gid = `sidefade-${side}`;
  // PREV (left card) fades on its RIGHT (inner) edge; NEXT fades on its LEFT.
  const x1 = side === 'left' ? '0' : '1';
  const x2 = side === 'left' ? '1' : '0';
  const Root: React.ComponentType<any> = onPress ? Pressable : View;
  return (
    <Root
      onPress={onPress}
      style={[styles.card, {
        width, backgroundColor: pal.panel, borderColor: pal.border,
        borderRadius: s(24), padding: s(16), gap: s(12),
      }]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={side === 'left' ? `Previous preset ${name}` : `Next preset ${name}`}
    >
      {/* Design sideLogoStyle: 58% of card width, capped 92, radius 16. */}
      <LogoTile name={name || undefined} size={Math.min(Math.round(width * 0.58), s(92))} radius={s(16)} />
      <Text style={[styles.call, { fontSize: Math.max(12, s(15)), color: pal.text }]} numberOfLines={1}>{name || 'FM'}</Text>
      {/* inner-edge fade */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id={gid} x1={x1} y1="0" x2={x2} y2="0">
            <Stop offset="0.5" stopColor={pal.bg} stopOpacity={0} />
            <Stop offset="1" stopColor={pal.bg} stopOpacity={0.92} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gid})`} />
      </Svg>
    </Root>
  );
}

const styles = StyleSheet.create({
  card: {
    aspectRatio: 1, maxWidth: 206, borderWidth: 1, borderRadius: 24, padding: 16,
    alignItems: 'center', justifyContent: 'center', gap: 12, flexShrink: 0,
  },
  call: {
    fontFamily: FONT_BOLD, fontSize: 15, textAlign: 'center', maxWidth: '100%',
  },
});
