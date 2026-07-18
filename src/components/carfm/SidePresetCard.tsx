/**
 * Side preset card (design handoff `wideHero`): the previous/next preset shown
 * as a faded, scaled panel card that tucks behind the hero, replacing the old
 * chevron PREV/NEXT buttons. Tapping it steps to that preset.
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
import { FONT, type CarFmPalette } from './tokens';

export default function SidePresetCard({
  name, pal, side, width, overlap, onPress,
}: {
  name: string;
  pal: CarFmPalette;
  side: 'left' | 'right';        // 'left' = PREV (tucks under the hero's left), 'right' = NEXT
  width: number;
  overlap: number;               // negative margin toward the hero (px)
  onPress: () => void;
}) {
  const gid = `sidefade-${side}`;
  // PREV (left card) fades on its RIGHT (inner) edge; NEXT fades on its LEFT.
  const x1 = side === 'left' ? '0' : '1';
  const x2 = side === 'left' ? '1' : '0';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          width,
          backgroundColor: pal.panel,
          borderColor: pal.border,
          marginRight: side === 'left' ? overlap : 0,
          marginLeft: side === 'right' ? overlap : 0,
          opacity: pressed ? 0.4 : 0.6,
          transform: [{ scale: 0.88 }],
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={side === 'left' ? `Previous preset ${name}` : `Next preset ${name}`}
    >
      <LogoTile name={name || undefined} size={Math.round(width * 0.5)} radius={16} />
      <Text style={[styles.call, { color: pal.text }]} numberOfLines={1}>{name || 'FM'}</Text>
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
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    aspectRatio: 1, maxWidth: 206, borderWidth: 1, borderRadius: 24, padding: 16,
    alignItems: 'center', justifyContent: 'center', gap: 12, flexShrink: 0,
  },
  call: {
    fontFamily: FONT, fontSize: 15, fontWeight: '700', textAlign: 'center', maxWidth: '100%',
  },
});
