/**
 * CenterVfoButton — floating "CENTRE ON VFO" pill shown above the controls pill
 * when the VFO is unlocked and has panned off the visible span
 * (BRIEF-vfo-lock-and-panning §5.8). One-shot recentre; does NOT re-lock.
 * Mirrors the reference skin's ubw-vfo-ind: centred, gentle pulse.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text } from 'react-native';

export default function CenterVfoButton({
  visible,
  bottom,
  onPress,
}: {
  visible: boolean;
  bottom: number;
  onPress: () => void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pulse]);

  if (!visible) return null;

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] });

  return (
    <Animated.View style={[styles.wrap, { bottom, transform: [{ scale }] }]} pointerEvents="box-none">
      <Pressable onPress={onPress} style={styles.pill} accessibilityLabel="Centre on VFO">
        <Text style={styles.label}>⌖ CENTRE ON VFO</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
    // Solid, opaque fill so it stays legible on any waterfall colormap (it was
    // translucent green → vanished on the green/sonar palette).
    backgroundColor: '#0b0f0c',
    borderWidth: 1.5,
    borderColor: '#3ddc84',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  label: {
    color: '#3ddc84',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
