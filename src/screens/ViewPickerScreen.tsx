import React, { useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { ViewMode, setViewMode } from '../services/viewMode';

type Props = NativeStackScreenProps<RootStackParamList, 'ViewPicker'>;

export default function ViewPickerScreen({ navigation }: Props) {
  const [saving, setSaving] = useState(false);

  const choose = async (mode: ViewMode) => {
    setSaving(true);
    await setViewMode(mode);
    navigation.replace('InstancePicker');
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.inner}>

        <View style={s.header}>
          <Text style={s.logo}>VibeSDR</Text>
          <Text style={s.title}>CHOOSE DISPLAY MODE</Text>
          <Text style={s.sub}>
            Select how controls appear on your device.{'\n'}
            You can change this any time from the menu.
          </Text>
        </View>

        {/* DEFAULT card — matches skin's lsv-sp-default button */}
        <TouchableOpacity style={[s.card, s.cardDefault]} onPress={() => choose('default')} disabled={saving} activeOpacity={0.75}>
          <Text style={s.cardLabel}>DEFAULT</Text>
          <Text style={s.cardDesc}>
            Compact vintage controls with full information density.
            Best for larger phones and tablets.
          </Text>
          <View style={s.recommended}>
            <Text style={s.recommendedTxt}>RECOMMENDED</Text>
          </View>
        </TouchableOpacity>

        {/* ACCESSIBLE card — matches skin's lsv-sp-a11y button */}
        <TouchableOpacity style={[s.card, s.cardA11y]} onPress={() => choose('accessibility')} disabled={saving} activeOpacity={0.75}>
          <Text style={s.cardLabelA11y}>♿ ACCESSIBLE</Text>
          <Text style={s.cardDescA11y}>
            Larger text and touch targets. For smaller phones, or when using
            system accessibility features such as Display Zoom.
          </Text>
        </TouchableOpacity>

        {saving && <ActivityIndicator color="#FFB833" style={{ marginTop: 24 }} />}

      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: '#0A0A12' },
  inner: { flex: 1, padding: 28, justifyContent: 'center', gap: 20 },

  header: { alignItems: 'center', gap: 10, marginBottom: 8 },
  logo: {
    fontFamily: 'Courier', fontSize: 28, fontWeight: 'bold',
    color: '#FFB833', letterSpacing: 4,
    textShadowColor: '#FFAA00', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 10,
  },
  title: { fontFamily: 'Courier', fontSize: 14, color: '#FFB833', letterSpacing: 2, fontWeight: 'bold' },
  sub:   { fontFamily: 'Courier', fontSize: 10, color: 'rgba(200,137,58,0.70)', textAlign: 'center', lineHeight: 16 },

  card: {
    borderRadius: 8, padding: 20, gap: 8,
    borderWidth: 1,
  },
  cardDefault: {
    backgroundColor: 'rgba(20,10,0,0.80)',
    borderColor: 'rgba(255,160,0,0.45)',
  },
  cardA11y: {
    backgroundColor: 'rgba(20,10,0,0.60)',
    borderColor: 'rgba(255,160,0,0.25)',
  },

  cardLabel: {
    fontFamily: 'Courier', fontSize: 16, fontWeight: 'bold',
    color: '#FFB833', letterSpacing: 3,
  },
  cardDesc: {
    fontFamily: 'Courier', fontSize: 11, color: 'rgba(200,137,58,0.75)', lineHeight: 17,
  },

  cardLabelA11y: {
    fontSize: 18, fontWeight: 'bold',
    color: '#FFFFFF', letterSpacing: 1,
  },
  cardDescA11y: {
    fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 19,
  },

  recommended: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,160,0,0.12)',
    borderWidth: 1, borderColor: 'rgba(255,160,0,0.40)',
    borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, marginTop: 4,
  },
  recommendedTxt: { fontFamily: 'Courier', fontSize: 9, color: '#FFB833', letterSpacing: 2 },
});
