/**
 * CarFmFace — the FM radio face for the CarFM fork, built to the Claude Design
 * handoff (design_handoff_fm_radio_face): header pills, hero band (logo tile +
 * call letters + star + amber frequency + RadioText strip), SEEK/PREV/NEXT side
 * columns, presets band with reorder mode + custom scrollbar + NEARBY disc,
 * plus the direct-entry numpad and Nearby picker modals.
 *
 * Renders as a full-screen opaque layer OVER the existing SDR pipeline (spec §4):
 * SDRScreen keeps doing all the connect / audio / RDS work; this presents the
 * tuner and calls back. Readable at a glance, in a moving car, in sunlight.
 *
 * Accessibility (spec §6): no state is encoded red-vs-green — amber/blue/neutral
 * only, and colour only ever reinforces a label/shape/position.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Pressable, StyleSheet, Text, View, useColorScheme,
  type LayoutChangeEvent,
} from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getNearbyStations } from '../services/stationFinder';
import type { NearbyStation } from '../services/stationTypes';
import { ChevronShape, GearIcon, SignalWaves, StarIcon, StereoWave, WarningTriangle } from './carfm/icons';
import LogoTile from './carfm/LogoTile';
import NearbyPicker from './carfm/NearbyPicker';
import Numpad from './carfm/Numpad';
import PresetsBand, { type PresetItem } from './carfm/PresetsBand';
import SettingsPanel, { type CarFmTheme } from './carfm/SettingsPanel';
import { DARK, FM_MAX_MHZ, FM_MIN_MHZ, FONT, LIGHT } from './carfm/tokens';

export interface CarFmPreset {
  name: string;
  frequency: number;   // Hz
}

export interface CarFmFaceProps {
  freqHz: number;
  stationName?: string;     // RDS PS
  callsignHint?: string;    // PI-derived callsign (·city), shown only when PS absent
  radioText?: string;       // RDS RT
  stereo: boolean;
  signalDb: number | null;
  /** RDS decoder has a lock (PI/PS seen) — drives the RDS tell. */
  rdsOk?: boolean;
  /** RDS Traffic Programme flag. */
  tp?: boolean;
  /** RDS Traffic Announcement in progress (pulses amber). */
  ta?: boolean;
  /** Station transmits an AF list. */
  af?: boolean;
  /** Programme-type label ("Rock", …) — already region-decoded. */
  ptyText?: string;
  /** No compatible tuner session (dongle absent/failed) — replaces the whole
   *  header status cluster with the error pill (design addendum). */
  tunerError?: boolean;
  /** Theme override from settings ('system' follows the OS). */
  theme?: CarFmTheme;
  /** Start-radio-on-boot setting (shown/edited in the settings panel). */
  autostart?: boolean;
  onSetAutostart?: (on: boolean) => void;
  onSetTheme?: (t: CarFmTheme) => void;
  /** Immediate tuner reconnect attempt (tunerless sessions). */
  onRetryTuner?: () => void;
  presets: CarFmPreset[];   // displayed order (user-arranged)
  onTuneHz: (hz: number) => void;
  onToggleSave: () => void;              // star: save/remove current frequency
  onReorderPreset: (index: number, dir: 1 | -1) => void;
  onRemovePreset: (index: number) => void;
  onSaveStationPreset: (name: string, freqMhz: number) => void;  // nearby hold
  onOpenAdvanced: () => void;
}

const CHANNEL_HZ = 100_000;             // 0.1 MHz — the design's tune/seek step
const SCAN_TICK_MS = 34;                // fast text sweep, per the handoff
const RT_MARQUEE_CHARS = 46;

const mhzOf = (hz: number) => Math.round(hz / CHANNEL_HZ) / 10;
const fmt = (mhz: number) => mhz.toFixed(1);

/** dB → 0–4 waves (count/position encode strength, never colour alone). */
function waveStrength(db: number | null): number {
  if (db == null) return 0;
  return Math.max(0, Math.min(4, Math.round((db / 40) * 4)));
}

// ── RadioText strip: static when short, 16s marquee when > 46 chars ──────────
function RadioTextStrip({ text, colors }: { text: string; colors: { raised: string; border: string; dim: string } }) {
  const [w, setW] = useState(0);
  const [tw, setTw] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const marquee = text.length > RT_MARQUEE_CHARS;

  useEffect(() => {
    if (!marquee || !w || !tw) { x.setValue(0); return; }
    x.setValue(w);
    const anim = Animated.loop(Animated.timing(x, {
      toValue: -tw, duration: 16_000, easing: Easing.linear, useNativeDriver: true,
    }));
    anim.start();
    return () => anim.stop();
  }, [marquee, w, tw, text, x]);

  return (
    <View
      style={[styles.rtStrip, { backgroundColor: colors.raised, borderColor: colors.border }]}
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
    >
      {marquee ? (
        <Animated.Text
          numberOfLines={1}
          style={[styles.rtText, { color: colors.dim, transform: [{ translateX: x }] }]}
          onLayout={(e: LayoutChangeEvent) => setTw(e.nativeEvent.layout.width)}
        >
          {text}
        </Animated.Text>
      ) : (
        <Text numberOfLines={1} style={[styles.rtText, { color: colors.dim, textAlign: 'center' }]}>
          {text}
        </Text>
      )}
    </View>
  );
}

// The header's little status letters ("tells"): lit when true, ghosted when
// not. HD is never lit — an RTL-SDR pipeline doesn't decode IBOC — but the
// slot stays so the strip reads the same as a factory head unit's.
function Tell({ label, on, pulse, pal }: { label: string; on: boolean; pulse?: boolean; pal: { text: string; amber: string } }) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pulse) { op.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(op, { toValue: 0.35, duration: 550, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(op, { toValue: 1, duration: 550, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse, op]);
  return (
    <Animated.Text style={[styles.tell, { color: pulse ? pal.amber : pal.text, opacity: pulse ? op : (on ? 1 : 0.32) }]}>
      {label}
    </Animated.Text>
  );
}

export default function CarFmFace(props: CarFmFaceProps) {
  const {
    freqHz, stationName, callsignHint, radioText, stereo, signalDb,
    rdsOk, tp, ta, af, ptyText, tunerError, theme, autostart,
    onSetAutostart, onSetTheme, onRetryTuner, presets,
    onTuneHz, onToggleSave, onReorderPreset, onRemovePreset, onSaveStationPreset,
    onOpenAdvanced,
  } = props;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const pal = (theme === 'light' || (theme !== 'dark' && scheme === 'light')) ? LIGHT : DARK;

  // A car radio's display never sleeps mid-drive: keep the screen awake for as
  // long as the face is mounted (released automatically on unmount).
  useKeepAwake();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [scan, setScan] = useState<{ dir: 1 | -1; display: number } | null>(null);
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Measured side-column size -> chevron polygon in true pixels (no distortion).
  const [chev, setChev] = useState({ w: 86, h: 180 });

  const mhz = mhzOf(freqHz);
  const inBand = mhz >= FM_MIN_MHZ - 0.05 && mhz <= FM_MAX_MHZ + 0.05;
  const ps = (stationName ?? '').trim();
  const rt = (radioText ?? '').trim();
  const callsign = ps || callsignHint || '';

  // Displayed-order presets in MHz for the band + saved checks.
  const items = useMemo<PresetItem[]>(
    () => presets.map((p) => ({ name: p.name, frequencyMhz: mhzOf(p.frequency) })),
    [presets],
  );
  const activeIndex = useMemo(
    () => items.findIndex((p) => Math.abs(p.frequencyMhz - mhz) < 0.05),
    [items, mhz],
  );
  const saved = activeIndex >= 0;
  const presetMHz = useMemo(
    () => new Set(items.map((p) => Math.round(p.frequencyMhz * 10))),
    [items],
  );

  // ── Seek: scan to the next/previous station in the local FCC DB ────────────
  // The frequency list loads lazily (offline-first facade; enrich off since only
  // frequencies are needed). Empty list (no GPS / no DB) → seek sweeps one step.
  const seekFreqs = useRef<number[]>([]);
  useEffect(() => {
    getNearbyStations({ enrich: false, limit: 200 })
      .then((r) => {
        seekFreqs.current = [...new Set(r.stations.map((s) => Math.round(s.frequencyMhz * 10) / 10))]
          .sort((a, b) => a - b);
      })
      .catch(() => {});
  }, []);

  const stopScan = useCallback(() => {
    if (scanTimer.current) { clearInterval(scanTimer.current); scanTimer.current = null; }
  }, []);
  useEffect(() => stopScan, [stopScan]);

  const runSeek = useCallback((dir: 1 | -1) => {
    if (scanTimer.current) return;                     // one sweep at a time
    const cur = mhzOf(freqHz);
    const fs = seekFreqs.current;
    let target: number;
    if (fs.length > 0) {
      target = dir > 0
        ? (fs.find((f) => f > cur + 0.05) ?? fs[0])                          // wrap
        : ([...fs].reverse().find((f) => f < cur - 0.05) ?? fs[fs.length - 1]);
    } else {
      target = Math.round((cur + dir * 0.1) * 10) / 10;                      // fallback: one step
      if (target > FM_MAX_MHZ) target = FM_MIN_MHZ;
      if (target < FM_MIN_MHZ) target = FM_MAX_MHZ;
    }
    let v = cur;
    setScan({ dir, display: v });
    scanTimer.current = setInterval(() => {
      v = Math.round((v + dir * 0.1) * 10) / 10;
      if (v > FM_MAX_MHZ) v = FM_MIN_MHZ;
      if (v < FM_MIN_MHZ) v = FM_MAX_MHZ;
      if (Math.abs(v - target) < 0.05) {
        stopScan();
        setScan(null);
        onTuneHz(Math.round(target * 1e6));
      } else {
        setScan({ dir, display: v });
      }
    }, SCAN_TICK_MS);
  }, [freqHz, onTuneHz, stopScan]);

  // PREV/NEXT step through presets in their DISPLAYED order (wrapping).
  const stepPreset = useCallback((dir: 1 | -1) => {
    if (items.length === 0) return;
    const i = activeIndex >= 0 ? activeIndex : (dir > 0 ? -1 : 0);
    const n = ((i + dir) % items.length + items.length) % items.length;
    onTuneHz(Math.round(items[n].frequencyMhz * 1e6));
  }, [items, activeIndex, onTuneHz]);

  const onNearbyTune = useCallback((st: NearbyStation) => {
    onTuneHz(Math.round(st.frequencyMhz * 1e6));
  }, [onTuneHz]);
  const onNearbySave = useCallback((st: NearbyStation) => {
    onSaveStationPreset(st.callsign, st.frequencyMhz);
  }, [onSaveStationPreset]);

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: pal.bg,
          paddingTop: insets.top + 18,
          paddingBottom: insets.bottom + 18,
        },
      ]}
    >
      {/* ── Header row (design v2: signal · stereo+tells · PTY · gear) ──
          Tuner error is a hard either/or with the status cluster: with no tuner
          session there is no signal/RDS/stereo/genre to read, so the whole
          cluster is replaced by the one fault pill (design addendum). */}
      <View style={styles.header}>
        {tunerError ? (
        <View style={[styles.tunerErrPill, { borderColor: pal.amber, backgroundColor: pal.amberFill }]}>
          <WarningTriangle size={26} color={pal.amber} />
          <Text style={[styles.tunerErrText, { color: pal.amber }]} numberOfLines={1}>
            Failure to connect to tuner.
          </Text>
        </View>
        ) : (
        <View style={styles.headerLeft}>
          <View style={styles.signalPill}>
            <SignalWaves size={26} strength={waveStrength(signalDb)} on={pal.amber} off={pal.meterEmpty} />
            <Text style={[styles.signalText, { color: pal.text }]}>
              {signalDb == null ? '—' : `${Math.round(signalDb)} dB`}
            </Text>
          </View>
          <View style={styles.stereoCol}>
            <View style={styles.stereoRow}>
              {stereo ? <StereoWave color={pal.blue} flip /> : <View style={styles.waveSpacer} />}
              <Text style={[styles.stereoText, { color: stereo ? pal.blue : pal.dim }]}>
                {stereo ? 'STEREO' : 'MONO'}
              </Text>
              {stereo ? <StereoWave color={pal.blue} /> : <View style={styles.waveSpacer} />}
            </View>
            <View style={styles.tellStrip}>
              <Tell label="RDS" on={!!rdsOk} pal={pal} />
              <Tell label="HD" on={false} pal={pal} />
              {ta ? <Tell label="TA" on pulse pal={pal} /> : <Tell label="TP" on={!!tp} pal={pal} />}
              <Tell label="AF" on={!!af} pal={pal} />
            </View>
          </View>
          {ptyText ? (
            <View style={[styles.ptyPill, { borderColor: pal.border, backgroundColor: pal.raised }]}>
              <Text style={[styles.ptyText, { color: pal.dim }]}>{ptyText}</Text>
            </View>
          ) : null}
          {!inBand ? (
            <View style={[styles.oobPill, { borderColor: pal.amber }]}>
              <Text style={[styles.oobText, { color: pal.amber }]}>⚠ OUT OF FM BAND</Text>
            </View>
          ) : null}
        </View>
        )}
        <Pressable
          onPress={() => setSettingsOpen(true)}
          style={({ pressed }) => [styles.gearBtn, { borderColor: pal.border, backgroundColor: pal.raised }, pressed && { opacity: 0.55 }]}
          accessibilityRole="button" accessibilityLabel="Settings"
        >
          <GearIcon size={24} color={pal.dim} />
        </Pressable>
      </View>

      {/* ── Hero band ── */}
      <View style={styles.hero}>
        {/* left column: full-height PREV PRESET chevron (steering-wheel mappable) */}
        <Pressable
          onPress={() => stepPreset(-1)}
          onLayout={(e: LayoutChangeEvent) => setChev({
            w: Math.round(e.nativeEvent.layout.width), h: Math.round(e.nativeEvent.layout.height),
          })}
          style={({ pressed }) => [styles.sideCol, pressed && { opacity: 0.55 }]}
          accessibilityRole="button" accessibilityLabel="Previous preset"
        >
          <ChevronShape w={chev.w} h={chev.h} dir={-1} fill={pal.raised} stroke={pal.border} />
          <View style={[styles.chevLabelWrap, { transform: [{ translateX: -8 }] }]}>
            <Text style={[styles.chevLabel, { color: pal.dim }]}>PREV</Text>
            <Text style={[styles.chevLabel, { color: pal.dim }]}>PRESET</Text>
          </View>
        </Pressable>

        {/* center hero */}
        <View style={styles.center}>
          {scan ? (
            <View style={styles.scanWrap}>
              <Text allowFontScaling={false} style={[styles.call, { color: pal.dim, fontStyle: 'italic' }]}>
                Scanning…
              </Text>
              <View style={styles.freqRow}>
                <Text style={[styles.scanArrow, { color: pal.dim }]}>{scan.dir > 0 ? '▲' : '▼'}</Text>
                <Text allowFontScaling={false} style={[styles.freq, { color: pal.amber }]}>
                  {fmt(scan.display)}
                </Text>
                <Text style={[styles.mhz, { color: pal.dim }]}>MHz</Text>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.stationRow}>
                <LogoTile name={callsign || undefined} size={92} radius={20} />
                <Text
                  allowFontScaling={false}
                  numberOfLines={1}
                  style={[
                    styles.call,
                    { color: pal.text },
                    !ps && { fontStyle: 'italic', color: pal.dim },
                  ]}
                >
                  {callsign || 'Tuning…'}
                </Text>
                <Pressable
                  onPress={onToggleSave}
                  style={({ pressed }) => [
                    styles.starBtn,
                    { backgroundColor: saved ? pal.blueFill : pal.raised },
                    pressed && { opacity: 0.55 },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: saved }}
                  accessibilityLabel={saved ? 'Remove this frequency from presets' : 'Save this frequency as a preset'}
                >
                  <StarIcon size={30} filled={saved} color={pal.amber} outline={pal.dim} />
                </Pressable>
              </View>
              <Pressable
                onPress={() => setNumpadOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`Frequency ${fmt(mhz)} megahertz. Tap to enter a frequency.`}
              >
                <View style={styles.freqRow}>
                  <Text allowFontScaling={false} style={[styles.freq, { color: pal.amber }]}>
                    {fmt(mhz)}
                  </Text>
                  <Text style={[styles.mhz, { color: pal.dim }]}>MHz</Text>
                </View>
              </Pressable>
              <View style={styles.rtArea}>
                <RadioTextStrip
                  text={rt || ' '}
                  colors={{ raised: pal.raised, border: pal.border, dim: pal.dim }}
                />
              </View>
            </>
          )}
        </View>

        {/* right column: full-height NEXT PRESET chevron (mirror of left) */}
        <Pressable
          onPress={() => stepPreset(1)}
          style={({ pressed }) => [styles.sideCol, pressed && { opacity: 0.55 }]}
          accessibilityRole="button" accessibilityLabel="Next preset"
        >
          <ChevronShape w={chev.w} h={chev.h} dir={1} fill={pal.raised} stroke={pal.border} />
          <View style={[styles.chevLabelWrap, { transform: [{ translateX: 8 }] }]}>
            <Text style={[styles.chevLabel, { color: pal.dim }]}>NEXT</Text>
            <Text style={[styles.chevLabel, { color: pal.dim }]}>PRESET</Text>
          </View>
        </Pressable>
      </View>

      {/* ── Presets band ── */}
      <PresetsBand
        pal={pal}
        presets={items}
        activeIndex={activeIndex}
        reordering={reordering}
        onSelect={(p) => onTuneHz(Math.round(p.frequencyMhz * 1e6))}
        onEnterReorder={() => setReordering(true)}
        onExitReorder={() => setReordering(false)}
        onMove={onReorderPreset}
        onRemove={onRemovePreset}
        onOpenNearby={() => setPickerOpen(true)}
      />

      {/* ── Modals ── */}
      <Numpad
        visible={numpadOpen}
        pal={pal}
        currentMHz={fmt(scan ? scan.display : mhz)}
        scanning={!!scan}
        onSeek={runSeek}
        onTune={(f) => { setNumpadOpen(false); onTuneHz(Math.round(f * 1e6)); }}
        onClose={() => setNumpadOpen(false)}
      />
      <NearbyPicker
        visible={pickerOpen}
        pal={pal}
        presetMHz={presetMHz}
        onTune={onNearbyTune}
        onSavePreset={onNearbySave}
        onClose={() => setPickerOpen(false)}
      />
      <SettingsPanel
        visible={settingsOpen}
        pal={pal}
        tunerError={!!tunerError}
        autostart={autostart ?? true}
        theme={theme ?? 'system'}
        onRetryTuner={onRetryTuner}
        onSetAutostart={(on) => onSetAutostart?.(on)}
        onSetTheme={(t) => onSetTheme?.(t)}
        onAdvanced={() => { setSettingsOpen(false); onOpenAdvanced(); }}
        onClose={() => setSettingsOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 60, paddingHorizontal: 24, gap: 12,
  },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  signalPill: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  signalText: { fontFamily: FONT, fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stereoCol: { alignItems: 'center', gap: 2 },
  stereoRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  waveSpacer: { width: 20, height: 28 },
  stereoText: { fontFamily: FONT, fontSize: 14, fontWeight: '700', letterSpacing: 1.5 },
  tellStrip: { flexDirection: 'row', gap: 10 },
  tell: { fontFamily: FONT, fontSize: 11, fontWeight: '700', letterSpacing: 1, lineHeight: 12 },
  ptyPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  ptyText: { fontFamily: FONT, fontSize: 13, fontWeight: '700' },
  oobPill: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  oobText: { fontFamily: FONT, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  gearBtn: { width: 52, height: 52, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tunerErrPill: {
    height: 44, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5,
    flexDirection: 'row', alignItems: 'center', gap: 11, alignSelf: 'flex-start',
  },
  tunerErrText: { fontFamily: FONT, fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },

  hero: { flex: 1, flexDirection: 'row', gap: 20 },
  sideCol: { width: 86, alignItems: 'center', justifyContent: 'center' },
  chevLabelWrap: { alignItems: 'center' },
  chevLabel: { fontFamily: FONT, fontSize: 11, fontWeight: '700', letterSpacing: 1, lineHeight: 14 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stationRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  call: { fontFamily: FONT, fontSize: 66, fontWeight: '700', letterSpacing: -1, flexShrink: 1 },
  starBtn: { width: 56, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  freqRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6 },
  freq: { fontFamily: FONT, fontSize: 60, fontWeight: '700', fontVariant: ['tabular-nums'] },
  mhz: { fontFamily: FONT, fontSize: 20, fontWeight: '700' },
  rtArea: { alignSelf: 'stretch', flexGrow: 0, marginTop: 18, justifyContent: 'center' },
  rtStrip: {
    borderWidth: 1, borderRadius: 14, height: 52,
    justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 16,
  },
  rtText: { fontFamily: FONT, fontSize: 22 },

  scanWrap: { alignItems: 'center', gap: 6 },
  scanArrow: { fontSize: 22 },
});
