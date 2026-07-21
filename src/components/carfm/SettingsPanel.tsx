/**
 * CarFM settings panel — the delivered Claude Design panel (SettingsPanel.dc.html).
 * Opened by the face's gear. Sections:
 *   TUNER       status (+ RETRY on error / Details diagnostics when connected),
 *               tuner-source picker (RTL-SDR / built-in head-unit tuners / Auto), boot autostart
 *   APPEARANCE  theme override (SYSTEM / LIGHT / DARK)
 *   SYSTEM      battery-optimization exemption (+ FIX), station-logos toggle (+ clear)
 * Face design language throughout; no red-vs-green state (amber/blue/neutral).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Modal, NativeModules, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { BatteryBolt, SignalWaves, WarningTriangle } from './icons';
import { FONT, FONT_BOLD, type CarFmPalette } from './tokens';
import { snapshotDate } from '../../services/stationDb';
import { clearLogoCache } from '../../services/stationLogoCache';
import { isNwdAvailable } from '../../services/nwdRadio';
import { isDiagEnabled, setDiagEnabled, diagLines, diagText, clearDiag, subscribeDiag } from '../../services/diag';

export type CarFmTheme = 'system' | 'light' | 'dark';

const APP_VERSION = '0.9.2';
const BACKEND_KEY = '@carfm/tuner_backend_v1';
const LOGOS_KEY = '@carfm/logos_enabled_v1';

interface BackendDef { id: string; name: string; kind: string; available: boolean; detected: boolean | null; }

/** iOS-style pill toggle (design custom switch: 60×34, blue on, white knob). */
function Toggle({ on, pal, onToggle, label }: { on: boolean; pal: CarFmPalette; onToggle: () => void; label: string }) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.track, { backgroundColor: on ? pal.blue : pal.meterEmpty }, pressed && { opacity: 0.7 }]}
      accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={label}
    >
      <View style={[styles.knob, { left: on ? 29 : 3 }]} />
    </Pressable>
  );
}

function SectionLabel({ text, pal }: { text: string; pal: CarFmPalette }) {
  return <Text style={[styles.sectionLabel, { color: pal.dim }]}>{text}</Text>;
}

export default function SettingsPanel({
  visible, pal, tunerError, autostart, theme,
  onRetryTuner, onSetAutostart, onSetTheme, onClose,
}: {
  visible: boolean;
  pal: CarFmPalette;
  tunerError: boolean;
  autostart: boolean;
  theme: CarFmTheme;
  onRetryTuner?: () => void;
  onSetAutostart: (on: boolean) => void;
  onSetTheme: (t: CarFmTheme) => void;
  onClose: () => void;
}) {
  const [diagOpen, setDiagOpen] = useState(false);
  const [backend, setBackend] = useState('rtl');
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [nwdAvail, setNwdAvail] = useState<boolean | null>(null);   // built-in NWD tuner present?
  const [logosOn, setLogosOn] = useState(false);
  const [dataDate, setDataDate] = useState<string | null>(null);
  const [diagOn, setDiagOn] = useState(isDiagEnabled());
  const [, forceTick] = useState(0);

  // Refresh the log view as events arrive while the panel is open.
  useEffect(() => {
    if (!visible || !diagOn) return;
    return subscribeDiag(() => forceTick((n) => n + 1));
  }, [visible, diagOn]);

  const toggleDiag = useCallback(() => {
    setDiagOn((v) => { const nv = !v; setDiagEnabled(nv); return nv; });
  }, []);

  // Export the log to a folder the user picks — Android's Storage Access
  // Framework picker includes a connected USB drive, so this saves straight to it.
  const saveLog = useCallback(async () => {
    const text = diagText();
    if (!text.trim()) { Alert.alert('Nothing to save', 'The tuner log is empty.'); return; }
    try {
      const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!perm.granted) return;   // user cancelled the picker
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const name = `carfm-tuner-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const uri = await FileSystem.StorageAccessFramework.createFileAsync(perm.directoryUri, name, 'text/plain');
      await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
      Alert.alert('Saved', `${name}.txt written to the folder you chose.`);
    } catch (e) {
      Alert.alert('Save failed', String(e));
    }
  }, []);

  const Local = (NativeModules as any).VibeLocalSDR as
    | { isIgnoringBatteryOptimizations?: () => Promise<boolean>; requestIgnoreBatteryOptimizations?: () => void }
    | undefined;

  // Load persisted prefs + live battery status whenever the panel opens.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      // Ignore the retired hidden 'rtltcp' id so a legacy stored value doesn't
      // leave the picker with no row highlighted.
      try { const b = await AsyncStorage.getItem(BACKEND_KEY); if (b && b !== 'rtltcp' && !cancelled) setBackend(b); } catch {}
      try { const l = await AsyncStorage.getItem(LOGOS_KEY); if (!cancelled) setLogosOn(l === '1'); } catch {}
      try { const d = await snapshotDate(); if (!cancelled) setDataDate(d); } catch {}
      try { const n = await isNwdAvailable(); if (!cancelled) setNwdAvail(n); } catch { if (!cancelled) setNwdAvail(false); }
      try {
        const ex = await Local?.isIgnoringBatteryOptimizations?.();
        if (!cancelled) setBatteryExempt(!!ex);
      } catch { if (!cancelled) setBatteryExempt(null); }
    })();
    return () => { cancelled = true; };
  }, [visible]);

  const pickBackend = useCallback((id: string, available: boolean) => {
    if (!available) return;
    setBackend(id);
    AsyncStorage.setItem(BACKEND_KEY, id).catch(() => {});
  }, []);
  const toggleLogos = useCallback(() => {
    setLogosOn((v) => { const nv = !v; AsyncStorage.setItem(LOGOS_KEY, nv ? '1' : '0').catch(() => {}); return nv; });
  }, []);
  const doClearLogos = useCallback(() => { clearLogoCache().catch(() => {}); }, []);
  const fixBattery = useCallback(() => { Local?.requestIgnoreBatteryOptimizations?.(); }, [Local]);

  const backends: BackendDef[] = [
    { id: 'rtl', name: 'RTL-SDR', kind: 'USB software-defined radio', available: true, detected: !tunerError },
    // Built-in head-unit tuners — same concept (the radio baked into the head
    // unit), differentiated only by the unit's platform. Parallel copy on purpose;
    // the state badge carries supported-vs-not. NWD self-detects via the vendor
    // service; FYT (com.syu.ms) has no adapter yet → greyed. See
    // docs/BUILTIN-TUNER-FINDINGS.md.
    { id: 'nwd', name: 'NWD / NOWADA built-in radio', kind: 'Integrated head-unit FM tuner', available: !!nwdAvail, detected: nwdAvail },
    { id: 'fyt', name: 'FYT / DuduOS built-in radio', kind: 'Integrated head-unit FM tuner', available: false, detected: false },
    // Last, not the default: a fallback for unusual setups (e.g. a unit with BOTH
    // a USB dongle and a built-in tuner) — probe every source, use what answers.
    { id: 'auto', name: 'Auto', kind: 'Probe all sources', available: true, detected: null },
  ];
  // rtl_tcp / networked-SDR sources are hidden from the picker for now (the
  // backend still exists; parked for a future advanced/developer mode).

  const badgeFor = (b: BackendDef) =>
    b.detected === null ? '' : b.detected ? 'Detected' : b.available ? 'Not detected' : 'Unavailable';

  const aboutText = `CarFM  ·  v${APP_VERSION}  ·  FCC station data as of ${dataDate ?? '—'}`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.card, { backgroundColor: pal.bg }]}>
          {/* header */}
          <View style={[styles.header, { borderBottomColor: pal.border }]}>
            <Text style={[styles.title, { color: pal.text }]}>Settings</Text>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.close, { borderColor: pal.border }, pressed && { opacity: 0.55 }]}
              accessibilityRole="button" accessibilityLabel="Close settings"
            >
              <Text style={[styles.closeText, { color: pal.dim }]}>✕</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
            {/* ── TUNER ── */}
            <SectionLabel text="TUNER" pal={pal} />
            <View style={[styles.group, { backgroundColor: pal.panel, borderColor: pal.border }]}>
              <View style={styles.statusRow}>
                <View style={styles.iconWrap}>
                  {tunerError
                    ? <WarningTriangle size={32} color={pal.amber} />
                    : <SignalWaves size={34} strength={4} on={pal.amber} off={pal.meterEmpty} />}
                </View>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>{tunerError ? 'Not connected' : 'Connected'}</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>
                    {tunerError ? 'No USB tuner found' : 'Local hardware · RTL-SDR (RTL2832U)'}
                  </Text>
                </View>
                {tunerError && onRetryTuner ? (
                  <Pressable
                    onPress={onRetryTuner}
                    style={({ pressed }) => [styles.retryBtn, { borderColor: pal.blue, backgroundColor: pal.blueFill }, pressed && { opacity: 0.6 }]}
                    accessibilityRole="button" accessibilityLabel="Retry tuner connection"
                  >
                    <Text style={[styles.retryText, { color: pal.blue }]}>RETRY</Text>
                  </Pressable>
                ) : !tunerError ? (
                  <Pressable
                    onPress={() => setDiagOpen((v) => !v)}
                    style={({ pressed }) => [styles.diagBtn, { borderColor: pal.border }, pressed && { opacity: 0.6 }]}
                    accessibilityRole="button" accessibilityLabel={diagOpen ? 'Hide tuner details' : 'Show tuner details'}
                  >
                    <Text style={[styles.diagText, { color: pal.dim }]}>{diagOpen ? 'Hide details' : 'Details'}</Text>
                  </Pressable>
                ) : null}
              </View>

              {diagOpen && !tunerError ? (
                <View style={[styles.diagPanel, { backgroundColor: pal.raised, borderColor: pal.border }]}>
                  {[['Device', 'Realtek RTL2832U + R820T2'], ['USB ID', '0bda:2838'], ['Sample rate', '2.048 MS/s']].map(([k, v]) => (
                    <View key={k} style={styles.diagLine}>
                      <Text style={[styles.diagKey, { color: pal.dim }]}>{k}</Text>
                      <Text style={[styles.diagVal, { color: pal.text }]}>{v}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              <View style={[styles.divider, { backgroundColor: pal.border }]} />
              <Text style={[styles.subLabel, { color: pal.dim }]}>Tuner source</Text>
              {backends.map((b) => {
                const active = b.id === backend;
                return (
                  <Pressable
                    key={b.id}
                    onPress={() => pickBackend(b.id, b.available)}
                    style={[
                      styles.backendRow,
                      { backgroundColor: active ? pal.blueFill : 'transparent', borderColor: active ? pal.blue : 'transparent', opacity: b.available ? 1 : 0.5 },
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active, disabled: !b.available }}
                    accessibilityLabel={`${b.name}. ${badgeFor(b) || b.kind}`}
                  >
                    <View style={[styles.radio, { borderColor: active ? pal.blue : pal.dim }]}>
                      {active ? <View style={[styles.radioDot, { backgroundColor: pal.blue }]} /> : null}
                    </View>
                    <View style={styles.textWrap}>
                      <Text style={[styles.backendName, { color: pal.text }]}>{b.name}</Text>
                      <Text style={[styles.rowSub, { color: pal.dim }]}>{b.kind}</Text>
                    </View>
                    {badgeFor(b) ? (
                      <Text style={[styles.badge, { color: b.detected ? pal.blue : pal.dim }]}>{badgeFor(b)}</Text>
                    ) : null}
                  </Pressable>
                );
              })}

              <View style={[styles.divider, { backgroundColor: pal.border }]} />
              <Pressable style={styles.switchRow} onPress={() => onSetAutostart(!autostart)} accessibilityRole="switch" accessibilityState={{ checked: autostart }}>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>Start radio on boot</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>Resume FM automatically when the head unit powers up</Text>
                </View>
                <Toggle on={autostart} pal={pal} onToggle={() => onSetAutostart(!autostart)} label="Start radio on boot" />
              </Pressable>
            </View>

            {/* ── APPEARANCE ── */}
            <SectionLabel text="APPEARANCE" pal={pal} />
            <View style={[styles.group, { backgroundColor: pal.panel, borderColor: pal.border }]}>
              <View style={styles.themeRow}>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>Theme</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>Overrides the system colour scheme on the radio</Text>
                </View>
                <View style={styles.segWrap}>
                  {(['system', 'light', 'dark'] as const).map((v) => {
                    const on = theme === v;
                    return (
                      <Pressable
                        key={v}
                        onPress={() => onSetTheme(v)}
                        style={({ pressed }) => [styles.chip, { borderColor: on ? pal.blue : pal.border, backgroundColor: on ? pal.blueFill : 'transparent' }, pressed && { opacity: 0.6 }]}
                        accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`Theme ${v}`}
                      >
                        <Text style={[styles.chipText, { color: on ? pal.blue : pal.dim }]}>{v.toUpperCase()}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </View>

            {/* ── SYSTEM ── */}
            <SectionLabel text="SYSTEM" pal={pal} />
            <View style={[styles.group, { backgroundColor: pal.panel, borderColor: pal.border }]}>
              <View style={styles.switchRow}>
                <View style={styles.iconWrap}>
                  <BatteryBolt size={30} color={batteryExempt ? pal.blue : pal.amber} />
                </View>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>Battery optimization</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>
                    {batteryExempt === null ? 'Checking…'
                      : batteryExempt ? 'Exempt — the radio can run in the background'
                      : 'Not exempt — Doze may stop the boot-started radio'}
                  </Text>
                </View>
                {batteryExempt === false ? (
                  <Pressable
                    onPress={fixBattery}
                    style={({ pressed }) => [styles.retryBtn, { borderColor: pal.amber, backgroundColor: pal.amberFill }, pressed && { opacity: 0.6 }]}
                    accessibilityRole="button" accessibilityLabel="Fix battery optimization"
                  >
                    <Text style={[styles.retryText, { color: pal.amber }]}>FIX</Text>
                  </Pressable>
                ) : batteryExempt ? (
                  <View style={[styles.okBadge, { backgroundColor: pal.blueFill }]}>
                    <Text style={[styles.okBadgeText, { color: pal.blue }]}>EXEMPT</Text>
                  </View>
                ) : null}
              </View>

              <View style={[styles.divider, { backgroundColor: pal.border }]} />
              <Pressable style={styles.switchRow} onPress={toggleLogos} accessibilityRole="switch" accessibilityState={{ checked: logosOn }}>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>Station logos</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>
                    {logosOn ? 'Auto-download station artwork over Wi-Fi'
                      : 'Off — assign logos manually from a station (auto-download in redesign)'}
                  </Text>
                </View>
                <Toggle on={logosOn} pal={pal} onToggle={toggleLogos} label="Station logos auto-download" />
              </Pressable>
              {logosOn ? (
                <Pressable style={styles.clearRow} onPress={doClearLogos} accessibilityRole="button" accessibilityLabel="Clear downloaded logos">
                  <Text style={[styles.clearText, { color: pal.blue }]}>Clear downloaded logos</Text>
                  <Text style={[styles.chevron, { color: pal.dim }]}>›</Text>
                </Pressable>
              ) : null}
            </View>

            {/* ── DIAGNOSTICS ── (head-unit substitute for adb logcat) */}
            <SectionLabel text="DIAGNOSTICS" pal={pal} />
            <View style={[styles.group, { backgroundColor: pal.panel, borderColor: pal.border }]}>
              <Pressable style={styles.switchRow} onPress={toggleDiag} accessibilityRole="switch" accessibilityState={{ checked: diagOn }}>
                <View style={styles.textWrap}>
                  <Text style={[styles.rowTitle, { color: pal.text }]}>Tuner log</Text>
                  <Text style={[styles.rowSub, { color: pal.dim }]}>
                    Capture tuner events — connect, signal (arg), RDS/RadioText, stereo, audio — for troubleshooting on the head unit.
                  </Text>
                </View>
                <Toggle on={diagOn} pal={pal} onToggle={toggleDiag} label="Tuner log" />
              </Pressable>
              {diagOn ? (
                <>
                  <ScrollView
                    style={[styles.diagLog, { borderColor: pal.border, backgroundColor: pal.raised }]}
                    contentContainerStyle={{ padding: 10 }}
                    nestedScrollEnabled
                  >
                    {diagLines().length ? diagLines().map((l, i) => (
                      <Text key={i} allowFontScaling={false} style={[styles.diagLogLine, { color: pal.dim }]}>{l}</Text>
                    )) : (
                      <Text allowFontScaling={false} style={[styles.diagLogLine, { color: pal.dim }]}>No events yet — tune a station.</Text>
                    )}
                  </ScrollView>
                  <Pressable style={styles.clearRow} onPress={saveLog} accessibilityRole="button" accessibilityLabel="Save log to a file">
                    <Text style={[styles.clearText, { color: pal.blue }]}>Save to file (USB…)</Text>
                    <Text style={[styles.chevron, { color: pal.dim }]}>›</Text>
                  </Pressable>
                  <View style={[styles.divider, { backgroundColor: pal.border }]} />
                  <Pressable style={styles.clearRow} onPress={clearDiag} accessibilityRole="button" accessibilityLabel="Clear log">
                    <Text style={[styles.clearText, { color: pal.blue }]}>Clear log</Text>
                    <Text style={[styles.chevron, { color: pal.dim }]}>›</Text>
                  </Pressable>
                </>
              ) : null}
            </View>

            <Text style={[styles.about, { color: pal.dim }]}>{aboutText}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  card: {
    width: 700, maxWidth: '96%', height: 576, maxHeight: '92%', borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 50, shadowOffset: { width: 0, height: 20 }, elevation: 24,
  },
  header: {
    height: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 26, borderBottomWidth: 1,
  },
  title: { fontFamily: FONT_BOLD, fontSize: 26,  },
  close: { width: 52, height: 52, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 22, fontWeight: '700' },

  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 26, paddingTop: 4, paddingBottom: 26 },
  sectionLabel: { fontFamily: FONT_BOLD, fontSize: 12, letterSpacing: 2, marginTop: 14, marginBottom: 8, marginHorizontal: 4 },
  group: { borderRadius: 18, borderWidth: 1, padding: 10 },
  divider: { height: 1, marginVertical: 6, marginHorizontal: 6 },
  subLabel: { fontFamily: FONT_BOLD, fontSize: 12, letterSpacing: 1, marginVertical: 4, marginHorizontal: 12 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 62, paddingHorizontal: 12, paddingVertical: 6 },
  iconWrap: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  textWrap: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontFamily: FONT_BOLD, fontSize: 18,  },
  rowSub: { fontFamily: FONT, fontSize: 14, fontWeight: '400' },
  retryBtn: { height: 44, paddingHorizontal: 22, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  retryText: { fontFamily: FONT_BOLD, fontSize: 15, letterSpacing: 1 },
  diagBtn: { height: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  diagText: { fontFamily: FONT_BOLD, fontSize: 14, letterSpacing: 0.5 },

  diagPanel: { marginHorizontal: 12, marginTop: 2, marginBottom: 8, padding: 14, borderRadius: 12, borderWidth: 1, gap: 8 },
  diagLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  diagKey: { fontFamily: FONT, fontSize: 14 },
  diagVal: { fontFamily: FONT_BOLD, fontSize: 15, fontVariant: ['tabular-nums'] },

  backendRow: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 60, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 14, borderWidth: 1 },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  radioDot: { width: 12, height: 12, borderRadius: 6 },
  backendName: { fontFamily: FONT_BOLD, fontSize: 18,  },
  badge: { fontFamily: FONT_BOLD, fontSize: 13, letterSpacing: 0.4, flexShrink: 0 },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 62, paddingHorizontal: 12, paddingVertical: 6 },
  track: { width: 60, height: 34, borderRadius: 17, flexShrink: 0, justifyContent: 'center' },
  knob: { position: 'absolute', top: 3, width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFFFFF' },

  themeRow: { flexDirection: 'row', alignItems: 'center', gap: 20, minHeight: 62, paddingHorizontal: 12, paddingVertical: 6 },
  segWrap: { flexDirection: 'row', gap: 8, width: 300, flexShrink: 0 },
  chip: { flex: 1, height: 44, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontFamily: FONT_BOLD, fontSize: 14, letterSpacing: 1 },

  okBadge: { height: 44, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  okBadgeText: { fontFamily: FONT_BOLD, fontSize: 14, letterSpacing: 1 },

  diagLog: { marginHorizontal: 10, marginTop: 2, maxHeight: 240, borderRadius: 12, borderWidth: 1 },
  diagLogLine: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  clearRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50, paddingHorizontal: 12, paddingVertical: 6 },
  clearText: { fontFamily: FONT_BOLD, fontSize: 16,  },

  chevron: { fontSize: 26, fontWeight: '700', flexShrink: 0 },

  about: { fontFamily: FONT, textAlign: 'center', fontSize: 13, color: '#888', paddingTop: 20, paddingBottom: 4, letterSpacing: 0.3 },
});
