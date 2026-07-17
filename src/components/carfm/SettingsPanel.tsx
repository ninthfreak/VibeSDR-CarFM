/**
 * CarFM settings panel — what the face's gear opens (the design reserved the
 * gear as "where tuner setup lives"). Face design language throughout. Scope:
 * tuner status + retry, boot autostart toggle, theme override, and the one
 * deliberate escape into the stock Advanced SDR view.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { SignalWaves, WarningTriangle } from './icons';
import { FONT, type CarFmPalette } from './tokens';

export type CarFmTheme = 'system' | 'light' | 'dark';

function Section({ label, pal, children }: { label: string; pal: CarFmPalette; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: pal.dim }]}>{label}</Text>
      <View style={[styles.sectionBody, { backgroundColor: pal.raised, borderColor: pal.border }]}>
        {children}
      </View>
    </View>
  );
}

export default function SettingsPanel({
  visible, pal, tunerError, autostart, theme,
  onRetryTuner, onSetAutostart, onSetTheme, onAdvanced, onClose,
}: {
  visible: boolean;
  pal: CarFmPalette;
  tunerError: boolean;
  autostart: boolean;
  theme: CarFmTheme;
  onRetryTuner?: () => void;         // shown only when tunerError and provided
  onSetAutostart: (on: boolean) => void;
  onSetTheme: (t: CarFmTheme) => void;
  onAdvanced: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: pal.bg }]}>
          <View style={[styles.header, { borderBottomColor: pal.border }]}>
            <Text style={[styles.title, { color: pal.text }]}>Settings</Text>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.close, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Close settings"
            >
              <Text style={[styles.closeText, { color: pal.text }]}>✕</Text>
            </Pressable>
          </View>

          <Section label="TUNER" pal={pal}>
            <View style={styles.row}>
              {tunerError
                ? <WarningTriangle size={26} color={pal.amber} />
                : <SignalWaves size={26} strength={4} on={pal.amber} off={pal.meterEmpty} />}
              <Text style={[styles.rowText, { color: tunerError ? pal.amber : pal.text }]}>
                {tunerError ? 'Not connected — no USB tuner found' : 'Connected — Local Hardware (RTL-SDR)'}
              </Text>
              {tunerError && onRetryTuner ? (
                <Pressable
                  onPress={onRetryTuner}
                  style={({ pressed }) => [styles.retry, { borderColor: pal.blue, backgroundColor: pal.blueFill }, pressed && { opacity: 0.55 }]}
                  accessibilityRole="button" accessibilityLabel="Retry tuner connection"
                >
                  <Text style={[styles.retryText, { color: pal.blue }]}>RETRY</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={[styles.divider, { backgroundColor: pal.border }]} />
            <View style={styles.row}>
              <Text style={[styles.rowText, { color: pal.text, flex: 1 }]}>Start radio on boot</Text>
              <Switch
                value={autostart}
                onValueChange={onSetAutostart}
                trackColor={{ true: pal.blue, false: pal.meterEmpty }}
                thumbColor="#FFFFFF"
                accessibilityLabel="Start radio automatically on boot"
              />
            </View>
          </Section>

          <Section label="APPEARANCE" pal={pal}>
            <View style={styles.row}>
              <Text style={[styles.rowText, { color: pal.text, flex: 1 }]}>Theme</Text>
              <View style={styles.segs}>
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => onSetTheme(t)}
                    style={({ pressed }) => [
                      styles.seg,
                      { borderColor: theme === t ? pal.blue : pal.border, backgroundColor: theme === t ? pal.blueFill : 'transparent' },
                      pressed && { opacity: 0.55 },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: theme === t }}
                    accessibilityLabel={`Theme ${t}`}
                  >
                    <Text style={[styles.segText, { color: theme === t ? pal.blue : pal.dim }]}>
                      {t.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </Section>

          <Section label="ADVANCED" pal={pal}>
            <Pressable
              onPress={onAdvanced}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Open advanced SDR view"
            >
              <Text style={[styles.rowText, { color: pal.text, flex: 1 }]}>Advanced SDR view</Text>
              <Text style={[styles.chevron, { color: pal.dim }]}>›</Text>
            </Pressable>
          </Section>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  card: {
    width: 560, maxWidth: '94%', borderRadius: 24, paddingBottom: 20, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 50, shadowOffset: { width: 0, height: 20 },
    elevation: 24,
  },
  header: {
    height: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 22, borderBottomWidth: 1, marginBottom: 4,
  },
  title: { fontFamily: FONT, fontSize: 24, fontWeight: '700' },
  close: { width: 48, height: 48, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 20, fontWeight: '700' },

  section: { paddingHorizontal: 22, marginTop: 14 },
  sectionLabel: { fontFamily: FONT, fontSize: 12, fontWeight: '700', letterSpacing: 2, marginBottom: 6 },
  sectionBody: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16 },
  row: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { fontFamily: FONT, fontSize: 17, fontWeight: '700', flexShrink: 1 },
  divider: { height: 1, marginHorizontal: -16 },
  retry: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8 },
  retryText: { fontFamily: FONT, fontSize: 14, fontWeight: '700', letterSpacing: 1.5 },
  segs: { flexDirection: 'row', gap: 8 },
  seg: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  segText: { fontFamily: FONT, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  chevron: { fontSize: 24, fontWeight: '700' },
});
