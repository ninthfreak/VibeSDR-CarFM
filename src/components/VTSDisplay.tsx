import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Band, getPrimaryBandAt } from '../constants/bandPlan';
import { Colors } from '../constants/theme';

interface VTSDisplayProps {
  freqHz: number;
  onPrevBand?: () => void;
  onNextBand?: () => void;
}

function getBandColor(band: Band | null): string {
  if (!band) return Colors.goldDim;
  switch (band.type) {
    case 'ham':       return Colors.amber;
    case 'broadcast': return '#FBBF24';
    default:          return Colors.goldDim;
  }
}

export default function VTSDisplay({ freqHz, onPrevBand, onNextBand }: VTSDisplayProps) {
  const band     = getPrimaryBandAt(freqHz);
  const color    = getBandColor(band);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(fadeAnim, { toValue: 0.4, duration: 80,  useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1,   duration: 200, useNativeDriver: true }),
    ]).start();
  }, [freqHz, fadeAnim]);

  const name = band?.name ?? 'Outside HF Bands';

  return (
    <View style={styles.wrap}>
      <Text style={styles.arrow} onPress={onPrevBand}>{'◀'}</Text>
      <Animated.View style={[styles.nameArea, { opacity: fadeAnim }]}>
        <Text style={[styles.name, { color }]} numberOfLines={1}>{name}</Text>
        {band?.bandLabel && (
          <Text style={styles.bandLabel}>{band.bandLabel}</Text>
        )}
      </Animated.View>
      <Text style={styles.arrow} onPress={onNextBand}>{'▶'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection:   'row',
    alignItems:      'center',
    width:           '100%',
    height:          26,
    paddingHorizontal: 4,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius:    4,
  },
  arrow: {
    fontFamily:    'Courier',
    fontSize:      14,
    color:         Colors.amberDim,
    paddingHorizontal: 5,
  },
  nameArea: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    overflow:       'hidden',
  },
  name: {
    fontFamily:    'Courier',
    fontSize:      11,
    letterSpacing: 1.5,
    flexShrink:    1,
  },
  bandLabel: {
    fontFamily:    'Courier',
    fontSize:      10,
    color:         Colors.goldDim,
    letterSpacing: 1,
    flexShrink:    0,
  },
});
