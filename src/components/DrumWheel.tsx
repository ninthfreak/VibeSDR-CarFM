import React, { useCallback, useRef } from 'react';
import {
  GestureResponderEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Colors } from '../constants/theme';

// Physics constants dialled-in from the skin
const FRICTION    = 0.974;
const MAX_VEL     = 580;
const MIN_VEL     = 0.8;
const UPDATE_RATE = 40;   // Hz
const PX_STEP     = 22;   // pixels per step
const GRIP        = 7;

interface DrumWheelProps {
  label:    string;
  value:    string;
  step:     number;          // Hz per step
  minHz:    number;
  maxHz:    number;
  currentHz: number;
  onChange: (newHz: number) => void;
  width?:   number;
}

export default function DrumWheel({
  label, value, step, minHz, maxHz, currentHz, onChange, width = 140,
}: DrumWheelProps) {
  const velRef       = useRef(0);
  const lastXRef     = useRef(0);
  const lastTimeRef  = useRef(0);
  const accRef       = useRef(0);
  const animRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef    = useRef(false);
  const lastSendRef  = useRef(0);

  const stopAnim = useCallback(() => {
    if (animRef.current) { clearInterval(animRef.current); animRef.current = null; }
  }, []);

  const startAnim = useCallback(() => {
    stopAnim();
    animRef.current = setInterval(() => {
      velRef.current *= FRICTION;
      if (Math.abs(velRef.current) < MIN_VEL) { velRef.current = 0; stopAnim(); return; }
      accRef.current += velRef.current;
      const steps = Math.trunc(accRef.current / PX_STEP);
      if (steps !== 0) {
        accRef.current -= steps * PX_STEP;
        const now = Date.now();
        if (now - lastSendRef.current >= 1000 / UPDATE_RATE) {
          lastSendRef.current = now;
          const next = Math.max(minHz, Math.min(maxHz, currentHz + steps * step));
          if (next !== currentHz) onChange(next);
        }
      }
    }, 1000 / UPDATE_RATE);
  }, [stopAnim, currentHz, step, minHz, maxHz, onChange]);

  const onTouchStart = useCallback((e: GestureResponderEvent) => {
    stopAnim();
    activeRef.current = true;
    velRef.current    = 0;
    accRef.current    = 0;
    lastXRef.current  = e.nativeEvent.pageX;
    lastTimeRef.current = Date.now();
  }, [stopAnim]);

  const onTouchMove = useCallback((e: GestureResponderEvent) => {
    if (!activeRef.current) return;
    const x    = e.nativeEvent.pageX;
    const now  = Date.now();
    const dt   = Math.max(1, now - lastTimeRef.current);
    const dx   = x - lastXRef.current;
    velRef.current  = Math.max(-MAX_VEL, Math.min(MAX_VEL, (dx / dt) * GRIP * 10));
    lastXRef.current  = x;
    lastTimeRef.current = now;
    accRef.current += dx;
    const steps = Math.trunc(accRef.current / PX_STEP);
    if (steps !== 0) {
      accRef.current -= steps * PX_STEP;
      const now2 = Date.now();
      if (now2 - lastSendRef.current >= 1000 / UPDATE_RATE) {
        lastSendRef.current = now2;
        const next = Math.max(minHz, Math.min(maxHz, currentHz + steps * step));
        if (next !== currentHz) onChange(next);
      }
    }
  }, [currentHz, step, minHz, maxHz, onChange]);

  const onTouchEnd = useCallback(() => {
    activeRef.current = false;
    if (Math.abs(velRef.current) > MIN_VEL) startAnim();
  }, [startAnim]);

  return (
    <View
      style={[styles.drum, { width }]}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={onTouchStart}
      onResponderMove={onTouchMove}
      onResponderRelease={onTouchEnd}
      onResponderTerminate={onTouchEnd}
    >
      <Text style={styles.value} numberOfLines={1}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  drum: {
    height:          44,
    borderRadius:    6,
    borderWidth:     1,
    borderColor:     'rgba(0,140,32,0.32)',
    backgroundColor: 'rgba(0,0,0,0.60)',
    alignItems:      'center',
    justifyContent:  'center',
    overflow:        'hidden',
  },
  value: {
    fontFamily:    'Courier',
    fontSize:      15,
    color:         Colors.amber,
    letterSpacing: 1,
  },
  label: {
    fontSize:      8,
    color:         Colors.amberDim,
    letterSpacing: 1.5,
    marginTop:     1,
  },
});
