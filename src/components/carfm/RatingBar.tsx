/**
 * RatingBar — four buttons for tagging what the radio actually sounds like.
 *
 * Only present while debug mode is on. The point is a one-tap verdict from the
 * driver's seat, so the targets are large, the words are short, and nothing
 * confirms or animates: press it and keep driving.
 *
 * The four are NOT a scale. They name distinct experiences that point at
 * different physical causes, which is what makes them worth correlating against
 * the measured level rather than merely averaging. See debugMode.ts for the
 * vocabulary and where it came from.
 *
 * No red/green anywhere — the design's constraint throughout. A press flashes
 * amber and the most recent choice stays outlined, so a glance confirms the tap
 * registered without needing a toast.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RATING_HINTS, RATING_LABELS, type AudioRating } from '../../services/debugSample';
import { FONT, FONT_BOLD, type CarFmPalette } from './tokens';

const ORDER: AudioRating[] = ['clean', 'crackle', 'breakup', 'barely'];

export default function RatingBar({
  pal, current, onRate,
}: {
  pal: CarFmPalette;
  /** The last rating given, outlined so a glance confirms the tap landed. */
  current: AudioRating | null;
  onRate: (r: AudioRating) => void;
}) {
  return (
    <View style={[styles.wrap, { backgroundColor: pal.backdrop, borderColor: pal.border }]}>
      {ORDER.map((r) => {
        const active = current === r;
        return (
          <Pressable
            key={r}
            onPress={() => onRate(r)}
            accessibilityRole="button"
            accessibilityLabel={`${RATING_LABELS[r]} — ${RATING_HINTS[r]}`}
            style={({ pressed }) => [
              styles.btn,
              { borderColor: active ? pal.amber : pal.border, backgroundColor: pal.panel },
              pressed && { backgroundColor: pal.amberFill },
            ]}
          >
            <Text numberOfLines={1} style={[styles.label, { color: active ? pal.amber : pal.text }]}>
              {RATING_LABELS[r]}
            </Text>
            <Text numberOfLines={1} style={[styles.hint, { color: pal.dim }]}>
              {RATING_HINTS[r]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    flexDirection: 'row',
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    zIndex: 60,
  },
  btn: {
    flex: 1,
    // 48dp is the floor for a target meant to be hit without looking.
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontFamily: FONT_BOLD, fontSize: 15, letterSpacing: 0.2 },
  hint: { fontFamily: FONT, fontSize: 10, marginTop: 1 },
});
