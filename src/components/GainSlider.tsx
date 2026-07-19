import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Slider from '@react-native-community/slider';

// CarFM V4 — RTL-SDR tuner gain control. Used in both the RTL-SDR controls
// submenu and (a second copy) the demodulators popup for quick access. The
// `gains` list is the device's supported tuner gains in tenths of a dB.

const C = {
  gold:   '#ffe566',
  muted:  'rgba(255,255,255,0.92)',
  dim:    'rgba(200,210,225,0.90)',
  btnBg:  'rgba(20,18,14,0.85)',
  active: 'rgba(255,200,0,0.16)',
  border: 'rgba(255,229,102,0.55)',
};

export interface GainSliderProps {
  gains: number[];        // supported tuner gains, tenths of dB, ascending
  gainTenthDb: number;    // current manual gain (tenths of dB)
  auto: boolean;
  onAuto: (auto: boolean) => void;
  onGain: (tenthDb: number) => void;
  label?: string;
}

function nearestIndex(gains: number[], tenthDb: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < gains.length; i++) {
    const d = Math.abs(gains[i] - tenthDb);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export default function GainSlider({ gains, gainTenthDb, auto, onAuto, onGain, label = 'RF GAIN' }: GainSliderProps) {
  const haveGains = gains.length > 0;
  const idx = haveGains ? nearestIndex(gains, gainTenthDb) : 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.btn, auto && styles.btnActive]}
            onPress={() => onAuto(true)}
          >
            <Text style={[styles.btnTxt, auto && styles.btnTxtActive]}>AUTO</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, !auto && styles.btnActive]}
            onPress={() => onAuto(false)}
          >
            <Text style={[styles.btnTxt, !auto && styles.btnTxtActive]}>MANUAL</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.sliderRow}>
        <Slider
          style={{ flex: 1 }}
          minimumValue={0}
          maximumValue={haveGains ? gains.length - 1 : 1}
          step={1}
          value={idx}
          disabled={auto || !haveGains}
          onValueChange={(v: number) => { if (haveGains) onGain(gains[Math.round(v)]); }}
          minimumTrackTintColor={auto ? C.dim : C.gold}
          maximumTrackTintColor="rgba(255,255,255,0.25)"
          thumbTintColor={auto ? C.dim : C.gold}
        />
        <Text style={styles.val}>
          {auto ? 'Auto' : haveGains ? `${(gains[idx] / 10).toFixed(1)} dB` : '—'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: 12, letterSpacing: 1.5, color: C.dim, fontWeight: '600' },
  btnRow: { flexDirection: 'row', gap: 6 },
  btn: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', backgroundColor: C.btnBg },
  btnActive: { borderColor: C.border, backgroundColor: C.active },
  btnTxt: { fontSize: 11, color: C.muted },
  btnTxtActive: { color: C.gold },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  val: { width: 64, textAlign: 'right', fontSize: 13, color: C.muted },
});
