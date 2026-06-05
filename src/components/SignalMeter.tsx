import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Colors } from '../constants/theme';

interface SignalMeterProps {
  snrDb: number;  // -1 = no signal
}

const MAX_SNR = 40;
const HISTORY = 48;

function snrToLabel(snrDb: number): string {
  if (snrDb < 0) return '---';
  const s = Math.round(snrDb);
  if (s >= 30) return `S9+${s - 30}`;
  const unit = Math.max(0, Math.floor((s / 30) * 9));
  return `S${unit}`;
}

function snrToColor(snrDb: number): string {
  if (snrDb < 0) return Colors.amberDim;
  if (snrDb > 25) return Colors.amber;
  if (snrDb > 10) return Colors.gold;
  return Colors.goldDim;
}

export default function SignalMeter({ snrDb }: SignalMeterProps) {
  const barAnim    = useRef(new Animated.Value(0)).current;
  const historyRef = useRef<number[]>(Array(HISTORY).fill(0));

  useEffect(() => {
    const norm = snrDb < 0 ? 0 : Math.min(1, snrDb / MAX_SNR);
    Animated.spring(barAnim, {
      toValue:       norm,
      useNativeDriver: false,
      friction:      6,
      tension:       40,
    }).start();
    historyRef.current.push(norm);
    historyRef.current.shift();
  }, [snrDb, barAnim]);

  const barWidth = barAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: ['0%', '100%'],
  });

  const label = snrToLabel(snrDb);
  const color = snrToColor(snrDb);

  return (
    <View style={styles.wrap}>
      <View style={styles.barTrack}>
        <Animated.View
          style={[styles.barFill, { width: barWidth, backgroundColor: color }]}
        />
        <View style={styles.peakLine} />
      </View>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            6,
    paddingHorizontal: 4,
  },
  barTrack: {
    width:        60,
    height:       10,
    borderRadius: 3,
    backgroundColor: 'rgba(105,98,82,0.30)',
    overflow:     'hidden',
    position:     'relative',
  },
  barFill: {
    height:       '100%',
    borderRadius: 3,
  },
  peakLine: {
    position:    'absolute',
    right:       0,
    top:         0,
    bottom:      0,
    width:       1,
    backgroundColor: 'rgba(255,245,200,0.70)',
  },
  label: {
    fontFamily:    'Courier',
    fontSize:      9,
    fontWeight:    'bold',
    letterSpacing: 0.8,
    minWidth:      38,
    textAlign:     'right',
  },
});
