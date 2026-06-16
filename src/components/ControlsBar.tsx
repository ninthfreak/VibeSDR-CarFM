/**
 * ControlsBar — scales from 320dp (iPhone SE Display Zoom) to 430dp+
 *
 * PORTRAIT — 4 rows (locked, do not change):
 *   Row 1: signal bar + freq/mode pill
 *   Row 2: [STEP] [MENU] [CHAT] [SHARE]
 *   Row 3: [VFO drum flex:1] [Zoom drum flex:1]
 *   Row 4: clock · rec timer
 *
 * LANDSCAPE — single row:
 *   [VFO drum] [STEP/MENU col] [sig bar + pill flex:2] [CHAT/SHARE col] [Zoom drum]
 *
 * Scaling: useUiScale() — port of computeUiScale() from skin
 *   Portrait:  scale = clamp(0.75, W/390, 1.45)  → 320dp = 0.82
 *   Landscape: scale = clamp(0.58, W/926, 1.45)  → 568dp = 0.61
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Animated,
  AppState,
  Platform,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import {
  Canvas,
  Group,
  LinearGradient,
  Path,
  Rect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import DrumWheel from './DrumWheel';
import { useTheme } from '../contexts/ThemeContext';
import { useUiScale } from '../hooks/useUiScale';
import { STEPS, stepsForFreq, type SDRMode } from '../services/sdrTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

export type FreqUnit = 'hz' | 'khz' | 'mhz';

// Display follows the user's chosen unit (FreqModal selection) and always
// shows full Hz resolution — never silently truncates digits.
function formatHz(hz: number, unit: FreqUnit): string {
  if (unit === 'hz')  return Math.round(hz).toLocaleString('en-US');
  if (unit === 'mhz') return (hz / 1e6).toFixed(6);
  return (hz / 1_000).toFixed(3);
}
function freqUnitLabel(unit: FreqUnit): string {
  return unit === 'hz' ? 'Hz' : unit === 'mhz' ? 'MHz' : 'kHz';
}
function formatStep(s: number): string {
  return s >= 1_000_000 ? s / 1_000_000 + 'M'
       : s >= 1_000     ? s / 1_000 + 'k'
       :                  s + 'Hz';
}

// ── Signal gradient — port of sigGradient() ──────────────────────────────────
function sigGradColors(sig: number): string[] {
  if (sig < 0.20) return ['#bb1100', '#ff4400'];
  if (sig < 0.58) return ['#bb1100', '#ff4400', '#ffaa00'];
  return ['#bb1100', '#ff4400', '#ffaa00', '#00dd44'];
}
function sigGradPos(sig: number): number[] {
  if (sig < 0.20) return [0, 1];
  if (sig < 0.58) return [0, 0.20 / sig, 1];
  return [0, 0.15, 0.45, 1];
}

// ── SNR text — port of snrToDisplay() ────────────────────────────────────────
// ── Meter bus ─────────────────────────────────────────────────────────────────
// Meter values arrive ~7×/s; routing them through screen-level React state
// re-rendered the entire SDRScreen tree per update (CPU profile: React task
// execution ≈ a third of all JS time). The bus lets ONLY the two leaf widgets
// that display them (SignalCanvas, FreqModePill) subscribe and re-render.
/** link: 0=disconnected, 1=poor(red), 2=fluctuating(yellow), 3=good(green) */
export interface MeterValues {
  level: number; peak: number; snr: number;
  /** Peak power in the passband, dBFS — feeds the S-meter / dBFS readouts. */
  dbfs: number;
  active: boolean; link: 0|1|2|3;
}
export interface MeterBus {
  value: MeterValues;
  subs:  Set<(v: MeterValues) => void>;
  emit:  (v: MeterValues) => void;
}
export function createMeterBus(): MeterBus {
  const bus: MeterBus = {
    value: { level: 0, peak: 0, snr: 0, dbfs: -120, active: false, link: 0 },
    subs:  new Set(),
    emit(v: MeterValues) { bus.value = v; bus.subs.forEach(f => f(v)); },
  };
  return bus;
}
function useMeters(bus?: MeterBus): MeterValues | null {
  const [v, setV] = useState<MeterValues | null>(bus ? bus.value : null);
  useEffect(() => {
    if (!bus) return;
    const f = (nv: MeterValues) => setV(nv);
    bus.subs.add(f);
    return () => { bus.subs.delete(f); };
  }, [bus]);
  return bus ? v : null;
}

// Real S-meter from passband dBFS (classic 6dB/S-unit, S9 ≈ −73) — replaces
// the old synthetic conversion built on upstream's broken +30dB SNR offset.
function dbfsToSMeter(dbfs: number): string {
  if (dbfs >= -73) {
    const over = Math.round(dbfs + 73);
    return over > 0 ? `S9+${over}` : 'S9';
  }
  const s = Math.max(1, 9 - Math.ceil((-73 - dbfs) / 6));
  return `S${s}`;
}

function meterText(mode: 'snr' | 'smeter' | 'dbfs', m: MeterValues): string {
  if (mode === 'smeter') return dbfsToSMeter(m.dbfs);
  if (mode === 'dbfs')   return `${Math.round(m.dbfs)}dB`;
  return isFinite(m.snr) ? `${Math.round(m.snr)}db` : '';
}

// ── Clock — port of tick() ────────────────────────────────────────────────────
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Background audio keeps JS alive when locked — don't re-render the
    // controls every second behind a screen nobody can see.
    const id = setInterval(() => {
      if (AppState.currentState === 'active') setNow(new Date());
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const utc   = now.toUTCString().slice(17, 22);
  const local = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const tz    = now.toLocaleDateString([], { timeZoneName: 'short' }).split(', ')[1] || '';
  return `${utc} UTC  ·  ${local} ${tz}`;
}

// ── SVG paths (from mockup HTML) ──────────────────────────────────────────────
const CHAT_PATH   = Skia.Path.MakeFromSVGString('M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v8A1.5 1.5 0 0 1 15.5 14H7l-4 3V4.5Z')!;
const SHARE_LINES = Skia.Path.MakeFromSVGString('M13.3 5L6.7 9M13.3 15L6.7 11')!;
const SHARE_C1    = Skia.Path.MakeFromSVGString('M15 4m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0')!;
const SHARE_C2    = Skia.Path.MakeFromSVGString('M15 16m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0')!;
const SHARE_C3    = Skia.Path.MakeFromSVGString('M5 10m-1.8 0a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0')!;

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ControlsBarProps {
  frequency:     number;
  mode:          SDRMode;
  step:          number;
  connected:     boolean;
  signalLevel?:  number;
  peakLevel?:    number;
  snrDb?:        number;
  signalActive?: boolean;
  /** Meter bus — values bypass React screen state; only the meter leaves
   *  subscribe. Preferred over the 4 legacy props above. */
  meterBus?:     MeterBus;
  /** Readout mode for the pill text (menu SIGNAL METER toggles). */
  signalMode?:   'snr' | 'smeter' | 'dbfs';
  /** WFM stereo pilot detected (local hardware) → "ST" badge on the mode pill. */
  fmStereo?:     boolean;
  bottomInset:   number;
  onVfoDelta:    (px: number) => void;
  onBwDelta:     (px: number) => void;
  onMode:        (m: SDRMode) => void;
  onStep:        (s: number)  => void;
  onMenu:        () => void;
  onChat?:       () => void;
  /** Deep-link share (instance URL + freq/mode params). Falls back to text. */
  onShare?:      () => void;
  onFreqTap?:    () => void;
  onModeTap?:    () => void;
  freqUnit?:     FreqUnit;
  instanceHost?: string;
  isRecording?:  boolean;
  recSeconds?:   number;
  chatUnread?:   boolean;
  /** Grey out chat + share (local hardware has no server chat / shareable URL). */
  chatShareDisabled?: boolean;
}

// ── Signal bar canvas ─────────────────────────────────────────────────────────

function SignalCanvas({ width, height, signal: sigProp = 0, peak: peakProp = 0, bus }:
  { width: number; height: number; signal?: number; peak?: number; bus?: MeterBus }) {
  const m = useMeters(bus);
  const signal = m ? m.level : sigProp;
  const peak   = m ? m.peak  : peakProp;

  // Direct rendering at the real data rate (~10Hz) — interpolation removed by
  // request; updates cost only this small canvas re-render via the meter bus.
  if (width < 4) return null;
  const fillW  = width * Math.min(1, Math.max(0, signal));
  const peakX  = width * Math.min(1, Math.max(0, peak));
  const colors = signal > 0.001 ? sigGradColors(signal) : [];
  const pos    = signal > 0.001 ? sigGradPos(signal) : [];
  return (
    <Canvas style={StyleSheet.absoluteFill}>
      <Rect x={0} y={0} width={width} height={height} color="rgba(105,98,82,0.30)" />
      {fillW > 1 && colors.length > 0 && (
        <Rect x={0} y={0} width={fillW} height={height}>
          <LinearGradient start={vec(0,0)} end={vec(fillW,0)} colors={colors} positions={pos} />
        </Rect>
      )}
      {peakX > 2 && (
        <Rect x={peakX - 1} y={0} width={2} height={height} color="rgba(255,245,200,0.92)" />
      )}
    </Canvas>
  );
}

// ── Link quality bars (replaces the old connection dot) ───────────────────────
// Mobile-signal style: 3 green = solid link, 2 yellow = jitter/some drops,
// 1 red = stalling/reconnecting, all dim = disconnected.
function LinkBars({ q }: { q: 0 | 1 | 2 | 3 }) {
  // Disconnected (q=0) → a clear red ✕ rather than ambiguous dim bars.
  if (q === 0) {
    return (
      <View style={pm.linkWrap}>
        <Text style={{ color: '#e04040', fontSize: 14, fontWeight: '900', lineHeight: 14 }}>✕</Text>
      </View>
    );
  }
  const litColor = q === 3 ? '#33cc44' : q === 2 ? '#e0b020' : '#e04040';
  return (
    <View style={pm.linkWrap}>
      {[0, 1, 2].map(i => (
        <View key={i} style={[pm.linkBar, {
          height: 4 + i * 3,
          backgroundColor: i < q ? litColor : 'rgba(255,255,255,0.18)',
        }]} />
      ))}
    </View>
  );
}

// ── Link indicator cluster: 📱 ⇄ bars ⇄ server ───────────────────────────────
// Lives in the bottom row so the metaphor is explicit: quality of the path
// between THIS phone and the SDR server.
function PhoneGlyph({ color }: { color: string }) {
  return (
    <View style={[pm.phoneGlyph, { borderColor: color }]}>
      <View style={[pm.phoneDot, { backgroundColor: color }]} />
    </View>
  );
}
function ServerGlyph({ color }: { color: string }) {
  return (
    <View style={[pm.serverGlyph, { borderColor: color }]}>
      <View style={[pm.serverLine, { backgroundColor: color }]} />
      <View style={[pm.serverLine, { backgroundColor: color }]} />
    </View>
  );
}
export function LinkIndicator({ bus }: { bus?: MeterBus }) {
  const m = useMeters(bus);
  const q = m ? m.link : 0;
  const dim = 'rgba(255,255,255,0.40)';
  return (
    <View style={pm.linkRow}>
      <PhoneGlyph color={dim} />
      <Text style={pm.linkArrows}>⇄</Text>
      <LinkBars q={q} />
      <Text style={pm.linkArrows}>⇄</Text>
      <ServerGlyph color={dim} />
    </View>
  );
}

// ── Freq + mode pill ──────────────────────────────────────────────────────────
// All sizes passed as props from parent so they scale with useUiScale()

// Classic interlocking-rings stereo symbol (two overlapping ring outlines),
// shown on the mode pill when a WFM stereo pilot is locked.
function StereoIcon({ size, color }: { size: number; color: string }) {
  const bw = Math.max(1.2, size * 0.13);
  const ring = { position: 'absolute' as const, top: 0, width: size, height: size,
                 borderRadius: size / 2, borderWidth: bw, borderColor: color, backgroundColor: 'transparent' };
  return (
    <View style={{ width: size * 1.62, height: size, marginLeft: 5, justifyContent: 'center' }}>
      <View style={[ring, { left: 0 }]} />
      <View style={[ring, { left: size * 0.62 }]} />
    </View>
  );
}

function FreqModePill({ freqStr, unit, modeLabel, snrText, connected, signalActive,
  onFreqTap, onModeTap, freqFontSize, freqWidth, unitFontSize, modeFontSize,
  modeLs, snrWidth, pillPadH, pillPadV, modePadH, modePadV, gap, bus, meterMode,
  tight = false, fmStereo = false,
}: any) {
  const { theme: t } = useTheme();
  // Skin parity (lsvSnrDisp): plain "NNdb", not a synthetic S-meter reading.
  const m = useMeters(bus);
  const liveSnrText = m ? meterText(meterMode ?? 'snr', m) : snrText;
  const liveActive  = m ? m.active : signalActive;
  return (
    // maxWidth cap: the pill must NEVER swallow the signal bar — on narrow
    // screens (SE / Moto G35) and with Android font metrics the fixed dp
    // widths overflow the frame; the freq text's adjustsFontSizeToFit
    // absorbs the squeeze (meter stays visible ≥13% each side).
    <View style={[pm.row, { maxWidth: tight ? '66%' : '74%', alignSelf: 'center' }]}>
      <TouchableOpacity
        style={[pm.freqBox, { backgroundColor: t.pillBg, paddingHorizontal: pillPadH, paddingVertical: pillPadV, gap }]}
        onPress={onFreqTap} activeOpacity={0.80} hitSlop={8}
      >
        <Text style={[pm.freq, {
          color: t.freqColor, fontSize: freqFontSize, width: freqWidth,
          fontFamily: t.font, textShadowColor: t.freqGlowColor,
          // Tight line metrics — Atkinson's tall default line-height (and
          // Android's extra font padding) inflated the pill to fill the
          // whole meter frame, hiding the signal ring around it
          lineHeight: Math.round(freqFontSize * 1.12),
          includeFontPadding: false,
        }]} numberOfLines={1} adjustsFontSizeToFit>
          {freqStr}
        </Text>
        <Text style={[pm.unit, { color: t.unitColor, fontFamily: t.font, fontSize: unitFontSize }]}>
          {unit}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[pm.modeBtn, { backgroundColor: t.pillBg, paddingHorizontal: modePadH, paddingVertical: modePadV, minWidth: tight ? 72 : 84 }]}
        onPress={onModeTap} activeOpacity={0.80} hitSlop={8}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={[pm.modeLbl, {
            color: t.modeColor, fontSize: modeFontSize, letterSpacing: modeLs, fontFamily: t.font,
            lineHeight: Math.round(modeFontSize * 1.15), includeFontPadding: false,
          }]}>
            {modeLabel}
          </Text>
          {/* stereo icon removed — pilot detection too eager to be reliable */}
        </View>
        <Text style={[pm.snr, {
          color: t.snrColor, fontFamily: t.font, width: snrWidth,
          fontSize: Math.max(9, Math.round(modeFontSize * 0.75)),
          lineHeight: Math.round(Math.max(9, modeFontSize * 0.75) * 1.15),
          includeFontPadding: false,
          fontWeight: '700',
          opacity: liveActive ? 1.0 : 0.65,
        }]}>
          {liveSnrText}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const pm = StyleSheet.create({
  row:      { flexDirection: 'row', alignItems: 'stretch', justifyContent: 'center' },
  linkWrap: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, alignSelf: 'center', flexShrink: 0 },
  linkBar:  { width: 3, borderRadius: 1 },
  linkRow:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  linkArrows: { color: 'rgba(255,255,255,0.40)', fontSize: 9, lineHeight: 11 },
  phoneGlyph: { width: 8, height: 13, borderWidth: 1, borderRadius: 2,
                alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 1.5 },
  phoneDot:   { width: 2.5, height: 1.5, borderRadius: 1 },
  serverGlyph:{ width: 13, height: 11, borderWidth: 1, borderRadius: 2,
                justifyContent: 'space-evenly', paddingHorizontal: 2 },
  serverLine: { height: 1, borderRadius: 0.5 },
  dot:     { width: 7, height: 7, borderRadius: 3.5, marginRight: 5, alignSelf: 'center', flexShrink: 0 },
  dotOn:   { backgroundColor: '#00cc44' },
  dotOff:  { backgroundColor: '#333' },
  freqBox: { flexDirection: 'row', alignItems: 'flex-end', borderTopLeftRadius: 5, borderBottomLeftRadius: 5, flexShrink: 1 },
  freq:    { letterSpacing: 1.5, textAlign: 'center', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6, flexShrink: 1 },
  unit:    { letterSpacing: 1, alignSelf: 'flex-end', paddingBottom: 2, flexShrink: 0 },
  modeBtn: { borderTopRightRadius: 5, borderBottomRightRadius: 5,
             borderLeftWidth: 1, borderLeftColor: 'rgba(70,60,45,0.45)',
             alignItems: 'center', justifyContent: 'center', gap: 1, flexShrink: 0 },
  modeLbl: { fontWeight: 'bold', textShadowColor: 'rgba(255,160,0,0.6)',
             textShadowOffset: { width:0,height:0 }, textShadowRadius: 5 },
  snr:     { fontSize: 9, textAlign: 'center' },
});

// ── Hamburger icon ────────────────────────────────────────────────────────────

function Hamburger({ color, lineW }: { color: string; lineW: number }) {
  return (
    <View style={{ gap: 3 }}>
      <View style={{ width: lineW, height: 1.5, borderRadius: 1, backgroundColor: color }} />
      <View style={{ width: lineW, height: 1.5, borderRadius: 1, backgroundColor: color }} />
      <View style={{ width: lineW, height: 1.5, borderRadius: 1, backgroundColor: color }} />
    </View>
  );
}

// ── Share icon canvas ─────────────────────────────────────────────────────────

function ShareIcon({ size, color }: { size: number; color: string }) {
  // Paths are authored in a 20×20 space — scale to the canvas, otherwise
  // small buttons (SE landscape) clip the icon edges
  const k = size / 20;
  return (
    <Canvas pointerEvents="none" style={{ width: size, height: size }}>
      <Group transform={[{ scale: k }]}>
        <Path path={SHARE_LINES} color={color} strokeWidth={1.6 / k} style="stroke" strokeCap="round" />
        <Path path={SHARE_C1}    color={color} strokeWidth={1.6 / k} style="stroke" />
        <Path path={SHARE_C2}    color={color} strokeWidth={1.6 / k} style="stroke" />
        <Path path={SHARE_C3}    color={color} strokeWidth={1.6 / k} style="stroke" />
      </Group>
    </Canvas>
  );
}

function ChatIcon({ size, color }: { size: number; color: string }) {
  const k = size / 20;
  return (
    <Canvas pointerEvents="none" style={{ width: size, height: size }}>
      <Group transform={[{ scale: k }]}>
        <Path path={CHAT_PATH} color={color} strokeWidth={1.6 / k} style="stroke" strokeCap="round" strokeJoin="round" />
      </Group>
    </Canvas>
  );
}

// ── PORTRAIT ──────────────────────────────────────────────────────────────────

function PortraitBar({ freqStr, unit, modeLabel, snrText, connected, signalActive, bus, meterMode, fmStereo = false,
  signal, peak, stepLabel, onFreqTap, onModeTap, onStep, onChat, onMenu, onShare,
  onVfoDelta, onBwDelta, clock, isRecording, recTime, chatUnread, csDisabled }: any) {

  const { theme: t } = useTheme();
  const s = useUiScale();
  const [sigW, setSigW] = useState(0);

  // Recording pulse — menu button border cycles red
  const recPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isRecording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(recPulse, { toValue: 1, duration: 2500, useNativeDriver: false }),
          Animated.timing(recPulse, { toValue: 0, duration: 2500, useNativeDriver: false }),
        ])
      ).start();
    } else {
      recPulse.stopAnimation();
      recPulse.setValue(0);
    }
  }, [isRecording, recPulse]);

  // Chat unread pulse — chat button border cycles blue
  const chatPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (chatUnread) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(chatPulse, { toValue: 1, duration: 2500, useNativeDriver: false }),
          Animated.timing(chatPulse, { toValue: 0, duration: 2500, useNativeDriver: false }),
        ])
      ).start();
    } else {
      chatPulse.stopAnimation();
      chatPulse.setValue(0);
    }
  }, [chatUnread, chatPulse]);

  const menuBorderColor = recPulse.interpolate({
    inputRange:  [0, 1],
    outputRange: [t.btnBorder, 'rgba(255,60,60,1.00)'],
  });
  const chatBorderColor = chatPulse.interpolate({
    inputRange:  [0, 1],
    outputRange: [t.btnBorder, 'rgba(100,180,255,1.00)'],
  });

  // All dp values go through s.r() — port of applyUiScale()'s r() function
  const SIG_H      = s.r(40); // match the landscape bar height (skin look)
  const DRUM_H     = s.r(60);
  const ROW_GAP    = s.r(7);
  const COL_GAP    = s.r(8);
  const BAR_PAD_H  = s.r(12);
  const BTN_H      = s.r(44); // a11y minimum touch target (was 36 — misses)
  const ICON_SZ    = s.r(20);
  const HBURG_W    = s.r(16);
  // Freq/mode sizing — read from theme so white mode can increase them
  // Pill sized to leave the signal bar visible around it (the white theme's
  // 28pt/168w pill covered the whole frame — screenshots 2026-06-11; 23/138
  // was still too wide on a 390pt screen). Android renders the same dp
  // sizes WIDER (font metrics) and the pill swallowed the meter on the G35
  // AND the iPhone SE — tighter sizes on Android and on narrow screens
  // (screenshots 2026-06-12).
  const tight      = Platform.OS === 'android' || s.isSmall;
  const FREQ_FONT  = s.r(tight ? 19 : 22);
  const FREQ_W     = s.r(tight ? 112 : 130);
  const UNIT_FONT  = s.r(9);
  const MODE_FONT  = s.r(tight ? 12 : 13);
  const MODE_LS    = s.f(t.modeLs);
  const SNR_W      = s.r(tight ? 50 : 58);
  const PILL_PAD_H = s.r(7);
  // Slim vertical paddings — the pill must float INSIDE the meter frame
  // with the signal ring visible above and below (boxes were touching the
  // frame edges on SE/G35, screenshots 2026-06-12 eve)
  const PILL_PAD_V = s.r(3);
  const MODE_PAD_H = s.r(10);
  const MODE_PAD_V = s.r(3);
  const PILL_GAP   = s.r(5);
  const BTN_FONT   = s.f(t.btnSize);
  const CLOCK_FONT = s.f(8);

  return (
    <View style={{ gap: ROW_GAP }}>

      {/* Row 1 — signal bar */}
      <View style={[por.sigFrame, { height: SIG_H }]}
            onLayout={(e: any) => setSigW(e.nativeEvent.layout.width)}>
        <SignalCanvas width={sigW} height={SIG_H} signal={signal} peak={peak} bus={bus} />
        <FreqModePill
          freqStr={freqStr} unit={unit} modeLabel={modeLabel} snrText={snrText}
          connected={connected} signalActive={signalActive} bus={bus} meterMode={meterMode} fmStereo={fmStereo}
          onFreqTap={onFreqTap} onModeTap={onModeTap}
          freqFontSize={FREQ_FONT} freqWidth={FREQ_W} unitFontSize={UNIT_FONT}
          modeFontSize={MODE_FONT} modeLs={MODE_LS} snrWidth={SNR_W}
          pillPadH={PILL_PAD_H} pillPadV={PILL_PAD_V}
          modePadH={MODE_PAD_H} modePadV={MODE_PAD_V} gap={PILL_GAP}
          tight={tight}
        />
      </View>

      {/* Row 2 — 4 equal buttons */}
      <View style={{ flexDirection: 'row', gap: COL_GAP }}>

        {/* STEP */}
        <TouchableOpacity
          style={[por.btn, { minHeight: BTN_H, borderColor: t.btnBorder }]}
          onPress={onStep} activeOpacity={0.75} hitSlop={10}
        >
          <Text style={[por.btnTxt, { color: t.btnText, fontFamily: t.font, fontSize: BTN_FONT }]}>
            {stepLabel}
          </Text>
        </TouchableOpacity>

        {/* MENU */}
        <Animated.View style={[por.btn, { minHeight: BTN_H, borderColor: menuBorderColor, borderWidth: 1 }]}>
          <TouchableOpacity
            style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
            onPress={onMenu} activeOpacity={0.75} hitSlop={10}
          >
            <Hamburger color={t.btnText} lineW={HBURG_W} />
          </TouchableOpacity>
        </Animated.View>

        {/* CHAT */}
        <Animated.View style={[por.btn, { minHeight: BTN_H, borderColor: chatBorderColor, borderWidth: 1, opacity: csDisabled ? 0.4 : 1 }]}>
          <TouchableOpacity
            style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
            onPress={csDisabled ? undefined : onChat} disabled={csDisabled} activeOpacity={0.75} hitSlop={10}
          >
            {/* decorative — don't let the Skia view contest the touch */}
            <ChatIcon size={ICON_SZ} color={t.btnText} />
          </TouchableOpacity>
        </Animated.View>

        {/* SHARE */}
        <TouchableOpacity
          style={[por.btn, { minHeight: BTN_H, borderColor: t.btnBorder, opacity: csDisabled ? 0.4 : 1 }]}
          onPress={csDisabled ? undefined : onShare} disabled={csDisabled} activeOpacity={0.75} hitSlop={10}
        >
          <ShareIcon size={ICON_SZ} color={t.btnText} />
        </TouchableOpacity>

      </View>

      {/* Row 3 — drums 50/50 */}
      <View style={{ flexDirection: 'row', gap: COL_GAP }}>
        <DrumWheel type="vfo"  height={DRUM_H} onDelta={onVfoDelta} style={{ flex: 1 }} />
        <DrumWheel type="zoom" height={DRUM_H} onDelta={onBwDelta}  style={{ flex: 1 }} />
      </View>

      {/* Row 4 — clock · link quality · rec */}
      <View style={por.clockRow}>
        <View style={{ flex: 1 }}>
          <Text style={[por.clock, { color: t.clockColor, fontFamily: t.font, fontSize: CLOCK_FONT }]}>
            {clock}
          </Text>
        </View>
        <LinkIndicator bus={bus} />
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          {isRecording && (
            <View style={por.recRow}>
              <View style={por.recDot} />
              <Text style={[por.recTime, { fontFamily: t.font, fontSize: CLOCK_FONT }]}>{recTime}</Text>
            </View>
          )}
        </View>
      </View>

    </View>
  );
}

const por = StyleSheet.create({
  sigFrame: { borderRadius: 7, overflow: 'hidden', backgroundColor: 'rgba(105,98,82,0.30)', justifyContent: 'center' },
  btn:      { flex: 1, backgroundColor: 'rgba(20,10,0,0.75)', borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center' },
  btnTxt:   { letterSpacing: 0.5, textAlign: 'center' },
  clockRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 2 },
  clock:    { letterSpacing: 1 },
  recRow:   { flexDirection: 'row', alignItems: 'center', gap: 4 },
  recDot:   { width: 6, height: 6, borderRadius: 3, backgroundColor: '#e05050' },
  recTime:  { letterSpacing: 1, color: '#e05050' },
});

// ── LANDSCAPE ─────────────────────────────────────────────────────────────────

function LandscapeBar({ freqStr, unit, modeLabel, snrText, connected, signalActive, bus, meterMode, fmStereo = false,
  signal, peak, stepLabel, onFreqTap, onModeTap, onStep, onChat, onMenu, onShare,
  onVfoDelta, onBwDelta, clock, isRecording, recTime, chatUnread, csDisabled }: any) {

  const { theme: t } = useTheme();
  const s = useUiScale();
  const [sigW, setSigW] = useState(0);

  const DRUM_H    = s.r(44);   // landscape drum height from skin BASE_LSV_DH=44
  const SIG_H     = s.r(40);  // was 48 — frame dwarfed the small pill
  const GAP       = s.r(6);
  const BTN_W     = s.r(56);
  // Pill enlarged toward portrait proportions — at 20pt in a 48pt frame the
  // signal bar visually swallowed it (screenshots 2026-06-11).
  const FREQ_FONT = s.r(24);
  const FREQ_W    = s.r(148);
  const UNIT_FONT = s.r(9);
  const MODE_FONT = s.r(15);
  const MODE_LS   = s.f(t.modeLs > 1.5 ? 1.2 : 1.0);
  const SNR_W     = s.r(74);
  const PILL_PAD_H = s.r(5);
  const PILL_PAD_V = s.r(3);
  const MODE_PAD_H = s.r(7);
  const MODE_PAD_V = s.r(4);
  const PILL_GAP  = s.r(4);
  const ICON_SZ   = s.r(18);
  const HBURG_W   = s.r(14);
  const CLOCK_FONT = s.f(7);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', justifyContent: 'center', gap: GAP }}>

      {/* VFO drum + clock */}
      <View style={{ flex: 1, minWidth: s.r(80) }}>
        <DrumWheel type="vfo" height={DRUM_H} onDelta={onVfoDelta} style={{ flex: 1 }} />
        <Text style={[lnd.clock, { color: t.clockColor, fontFamily: t.font, fontSize: CLOCK_FONT }]}>
          {clock}
        </Text>
        <View style={{ alignItems: 'center', marginTop: 2 }}>
          <LinkIndicator bus={bus} />
        </View>
        {isRecording && (
          <View style={lnd.recRow}>
            <View style={lnd.recDot} />
            <Text style={[lnd.recTime, { fontFamily: t.font, fontSize: CLOCK_FONT }]}>{recTime}</Text>
          </View>
        )}
      </View>

      {/* STEP + MENU column */}
      <View style={{ width: BTN_W, gap: GAP }}>
        <TouchableOpacity style={[lnd.lsBtn, { borderColor: t.btnBorder }]} onPress={onStep} activeOpacity={0.75} hitSlop={10}>
          <Text style={[lnd.lsTxt, { color: t.btnText, fontFamily: t.font, fontSize: s.f(11) }]}
                numberOfLines={2} adjustsFontSizeToFit>
            {stepLabel}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[lnd.lsBtn, { borderColor: isRecording ? 'rgba(220,40,40,0.90)' : t.btnBorder }]}
          onPress={onMenu} activeOpacity={0.75} hitSlop={10}
        >
          <Hamburger color={t.btnText} lineW={HBURG_W} />
        </TouchableOpacity>
      </View>

      {/* Signal bar + pill — flex so small screens (SE) get a shorter bar with
          everything still fitting; maxWidth caps the stretch on big panels. */}
      <View style={{ width: s.r(340), justifyContent: 'center' }}
            onLayout={(e: any) => setSigW(e.nativeEvent.layout.width)}>
        <View style={[lnd.sigFrame, { height: SIG_H }]}>
          <SignalCanvas width={sigW} height={SIG_H} signal={signal} peak={peak} bus={bus} />
          <FreqModePill
            freqStr={freqStr} unit={unit} modeLabel={modeLabel} snrText={snrText}
            connected={connected} signalActive={signalActive} bus={bus} meterMode={meterMode} fmStereo={fmStereo}
            onFreqTap={onFreqTap} onModeTap={onModeTap}
            freqFontSize={FREQ_FONT} freqWidth={FREQ_W} unitFontSize={UNIT_FONT}
            modeFontSize={MODE_FONT} modeLs={MODE_LS} snrWidth={SNR_W}
            pillPadH={PILL_PAD_H} pillPadV={PILL_PAD_V}
            modePadH={MODE_PAD_H} modePadV={MODE_PAD_V} gap={PILL_GAP}
          />
        </View>
      </View>

      {/* CHAT + SHARE column */}
      <View style={{ width: BTN_W, gap: GAP }}>
        <TouchableOpacity
          style={[lnd.lsBtn, { borderColor: chatUnread ? 'rgba(40,140,255,0.85)' : t.btnBorder, opacity: csDisabled ? 0.4 : 1 }]}
          onPress={csDisabled ? undefined : onChat} disabled={csDisabled} activeOpacity={0.75} hitSlop={10}
        >
          <ChatIcon size={ICON_SZ} color={t.btnText} />
        </TouchableOpacity>
        <TouchableOpacity style={[lnd.lsBtn, { borderColor: t.btnBorder, opacity: csDisabled ? 0.4 : 1 }]}
          onPress={csDisabled ? undefined : onShare} disabled={csDisabled} activeOpacity={0.75} hitSlop={10}>
          <ShareIcon size={ICON_SZ} color={t.btnText} />
        </TouchableOpacity>
      </View>

      {/* Zoom drum */}
      <View style={{ flex: 1, minWidth: s.r(80) }}>
        <DrumWheel type="zoom" height={DRUM_H} onDelta={onBwDelta} style={{ flex: 1 }} />
      </View>

    </View>
  );
}

const lnd = StyleSheet.create({
  sigFrame: { borderRadius: 7, overflow: 'hidden', backgroundColor: 'rgba(105,98,82,0.30)', justifyContent: 'center', alignSelf: 'stretch' },
  lsBtn:    { flex: 1, backgroundColor: 'rgba(20,10,0,0.75)', borderWidth: 1, borderRadius: 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  lsTxt:    { letterSpacing: 0.5, textAlign: 'center', lineHeight: 14 },
  clock:    { letterSpacing: 1, marginTop: 3, textAlign: 'center' },
  recRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 1 },
  recDot:   { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#e05050' },
  recTime:  { letterSpacing: 1, color: '#e05050' },
});

// ── Root ──────────────────────────────────────────────────────────────────────

function ControlsBar({
  frequency, mode, step, connected, bottomInset,
  signalLevel, peakLevel, snrDb = 40, signalActive, meterBus, signalMode = 'snr',
  fmStereo = false,
  onVfoDelta, onBwDelta, onMode, onStep,
  onMenu, onChat, onFreqTap, onModeTap,
  instanceHost = 'ubersdr',
  isRecording = false, recSeconds = 0, chatUnread = false,
  freqUnit = 'khz',
  onShare: onShareProp,
  chatShareDisabled = false,
}: ControlsBarProps) {
  const { theme: t } = useTheme();
  const s = useUiScale();

  const freqStr   = useMemo(() => formatHz(frequency, freqUnit), [frequency, freqUnit]);
  const unit      = useMemo(() => freqUnitLabel(freqUnit),       [freqUnit]);
  const stepLabel = useMemo(() => formatStep(step),      [step]);
  const snrText   = ''; // legacy fallback — live text comes from the bus + meterText()
  const clock     = useClock();

  const cycleStep = useCallback(() => {
    const list = stepsForFreq(frequency);
    const idx = list.indexOf(step);
    onStep(list[(idx + 1) % list.length] ?? list[0]);
  }, [step, onStep, frequency]);

  // Parent supplies the deep-link share (instance URL + freq/mode/bw/zoom
  // params — tappable straight into the station); plain text is the fallback
  const handleShare = useCallback(async () => {
    if (onShareProp) { onShareProp(); return; }
    await Share.share({ message: `VibeSDR — ${freqStr} ${unit} ${mode.toUpperCase()} — ${instanceHost}` });
  }, [onShareProp, freqStr, unit, mode, instanceHost]);

  const hh = Math.floor(recSeconds / 3600);
  const mm = Math.floor((recSeconds % 3600) / 60);
  const ss = recSeconds % 60;
  const recTime = `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;

  // Bar padding scales with screen
  const PAD_H   = s.r(12);
  const PAD_TOP = s.r(8);
  const RADIUS  = s.r(18);

  const shared = {
    freqStr, unit, modeLabel: mode.toUpperCase(), snrText, fmStereo,
    connected, signalActive, bus: meterBus, meterMode: signalMode,
    signal: signalLevel, peak: peakLevel,
    stepLabel, onFreqTap, onModeTap,
    onStep: cycleStep, onChat, onMenu, onShare: handleShare,
    onVfoDelta, onBwDelta,
    clock, isRecording, recTime, chatUnread,
    csDisabled: chatShareDisabled,
  };

  return (
    <View style={[
      root.bar,
      {
        paddingTop: PAD_TOP,
        paddingHorizontal: PAD_H,
        paddingBottom: Math.max(bottomInset, s.r(10)),
        borderRadius: RADIUS,
      },
    ]}>
      {/* High-intensity blur so waterfall colour bleeds through the pill */}
      <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
      {/* Tinted overlay — semi-transparent so blur shows; NOT fully opaque */}
      <View style={[StyleSheet.absoluteFill, root.tint, { borderRadius: RADIUS }]}
            pointerEvents="none" />
      {/* Border ring */}
      <View style={[root.border, { borderRadius: RADIUS, borderColor: t.barBorder }]}
            pointerEvents="none" />
      {s.isLandscape
        ? <LandscapeBar {...shared} />
        : <PortraitBar  {...shared} />
      }
    </View>
  );
}

const root = StyleSheet.create({
  bar: {
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.85,
    shadowRadius: 12,
    elevation: 12,
  },
  // Semi-transparent tint: waterfall colours show through but content is legible
  tint: {
    backgroundColor: 'rgba(8,6,2,0.55)',
    inset: 1,              // keeps tint inside the border ring visually
  },
  border: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1,
  },
});

// Memo wall — clock/meters live in internal state or the bus, so screen
// renders with stable props skip this whole subtree.
export default React.memo(ControlsBar);
