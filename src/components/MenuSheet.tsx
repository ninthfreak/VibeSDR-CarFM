/**
 * MenuSheet — slide-up panel matching VibeSDR_Mockup_SAVE.html exactly.
 *
 * Sections (in order):
 *   Nearby Station · Spectrum/Waterfall · Audio · Server Maps
 *   Client Decoders · Server Extensions · Controls · Instance
 *   Reconnect · Reset Interface Settings
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import { COLORMAP_NAMES } from '../assets/colormapUtils';
import { RTTY_PRESETS, type RttySettings } from '../services/DecoderClient';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MenuSheetProps {
  visible:     boolean;
  serverName:  string;
  serverUrl:   string;

  colormap:    string;
  dbMin:       number;
  dbMax:       number;
  onColormap:  (n: string) => void;
  onDbMin:     (v: number) => void;
  onDbMax:     (v: number) => void;

  filterLow:    number;
  filterHigh:   number;
  onFilterLow:  (v: number) => void;
  onFilterHigh: (v: number) => void;
  nr?:          boolean;
  onNr?:        (mode: 'off'|'nr'|'nr2') => void;
  onZoomIn?:    () => void;
  onZoomOut?:   () => void;
  onSetDefault?: () => void;
  /** Client decoders — skin semantics: toggle start/stop, menu stays open. */
  decMode?:        'rtty'|'navtex'|'wefax'|'sstv'|'morse'|'whisper'|null;
  decOn?:          boolean;
  onDecToggle?:    (m: 'rtty'|'navtex'|'wefax'|'sstv'|'morse'|'whisper') => void;
  /** Digital/CW spots feeds (skin lsvSpots). */
  spotsKind?:      'digi'|'cw'|null;
  onSpotsToggle?:  (k: 'digi'|'cw') => void;
  /** Server map overlays (skin lsv-hfdl / lsv-digmap / lsv-cwmap). */
  onServerMap?:    (k: 'hfdl'|'digi'|'cw') => void;
  rttySettings?:   RttySettings;
  onRttySettings?: (s: RttySettings) => void;
  wefaxLpm?:       number;
  onWefaxLpm?:     (lpm: number) => void;
  nb?:          boolean;
  onNb?:        (on: boolean) => void;
  recording?:   boolean;
  onRec?:       () => void;
  recSeconds?:  number;

  // SNR squelch — value ≤ -999 = off/open
  snrSquelch?:    number;
  onSnrSquelch?:  (v: number) => void;
  // FM squelch — only shown for fm/nfm modes
  fmSquelch?:     number;
  onFmSquelch?:   (v: number) => void;
  isFmMode?:      boolean;

  // Server DSP
  serverDspEnabled?:   boolean;
  serverDspFilter?:    string;
  serverDspParams?:    Record<string, number>;
  onServerDsp?:        (enabled: boolean, filter?: string, params?: Record<string,number>) => void;
  onServerDspParams?:  (params: Record<string,number>) => void;

  signalMode?:     'snr' | 'smeter' | 'dbfs';
  onSignalMode?:   (m: 'snr' | 'smeter' | 'dbfs') => void;
  displayStyle?:   'amber' | 'white';
  onDisplayStyle?: (s: 'amber' | 'white') => void;
  drumMode?:       'normal' | 'precise';
  onDrumMode?:     (m: 'normal' | 'precise') => void;
  hapticsEnabled?: boolean;
  onHaptics?:      (on: boolean) => void;

  vtsName?:    string;
  vtsFreq?:    number;
  onVtsNext?:  () => void;
  onVtsPrev?:  () => void;

  onClose:          () => void;
  onBack?:          () => void;
  onReconnect?:     () => void;
  onResetSettings?: () => void;
  onDisplaySettings?: () => void;

  // Display settings panel props
  vfoNeedle?:         string;
  onVfoNeedle?:       (hex: string) => void;
  wfCoarse?:          'auto' | 'manual';
  onWfCoarse?:        (v: 'auto' | 'manual') => void;
  /** UberSDR auto-range symmetric contrast 0–20 (web calibration = 10). */
  autoContrast?:      number;
  onAutoContrast?:    (v: number) => void;
  /** M9PSY 5-tap spatial waterfall smooth. */
  spatialSmooth?:     boolean;
  onSpatialSmooth?:   (v: boolean) => void;
  wfBrightness?:      number;
  onWfBrightness?:    (v: number) => void;
  wfContrast?:        number;
  onWfContrast?:      (v: number) => void;
  wfSharpness?:       number;
  onWfSharpness?:     (v: number) => void;
  specShow?:          boolean;
  onSpecShow?:        (v: boolean) => void;
  specSmoothing?:     number;
  onSpecSmoothing?:   (v: number) => void;
  specFloor?:         number;
  onSpecFloor?:       (v: number) => void;
  specPeakScale?:     number;
  onSpecPeakScale?:   (v: number) => void;
  peakHold?:          boolean;
  onPeakHold?:        (v: boolean) => void;
  frameRate?:         'native' | '20fps' | '60fps';
  onFrameRate?:       (v: 'native' | '20fps' | '60fps') => void;
  onSpecRatio?:       () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const C = {
  bg:           '#0c0b09',
  border:       'rgba(255,160,0,0.35)',
  gold:         '#FFB833',
  goldDim:      '#c8893a',
  muted:        'rgba(255,184,51,0.40)',
  btnBg:        'rgba(20,10,0,0.80)',
  active:       'rgba(255,140,0,0.22)',
  danger:       'rgba(160,30,30,0.80)',
  dangerBorder: 'rgba(220,60,60,0.60)',
  text:         '#FFB833',
  sectionC:     'rgba(255,160,0,0.50)',
};

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = Math.min(SCREEN_H * 0.88, 700);


// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtHz(hz: number) {
  return hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : hz + ' Hz';
}

function fmtRecTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function StepSlider({
  value, min, max, step, format, onChange,
}: {
  value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <View style={styles.stepSlider}>
      <TouchableOpacity style={styles.stepSliderBtn} hitSlop={8}
        onPress={() => onChange(clamp(value - step))}>
        <Text style={styles.stepSliderBtnTxt}>−</Text>
      </TouchableOpacity>
      <Text style={styles.stepSliderVal}>{format(value)}</Text>
      <TouchableOpacity style={styles.stepSliderBtn} hitSlop={8}
        onPress={() => onChange(clamp(value + step))}>
        <Text style={styles.stepSliderBtnTxt}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionLabel({ label, first }: { label: string; first?: boolean }) {
  return (
    <View style={[styles.sectionBar, first && styles.sectionBarFirst]}>
      <Text style={styles.sectionLabel}>{label}</Text>
    </View>
  );
}

function BtnRow({ children, col }: { children: React.ReactNode; col?: boolean }) {
  return <View style={[styles.btnRow, col && styles.btnRowCol]}>{children}</View>;
}

function Btn({ label, active, danger, onPress, full, style }: {
  label: string; active?: boolean; danger?: boolean;
  onPress?: () => void; full?: boolean; style?: object;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, active && styles.btnActive, danger && styles.btnDanger, full && styles.btnFull, style]}
      onPress={onPress} hitSlop={4} activeOpacity={0.7}
    >
      <Text style={[styles.btnText, active && styles.btnTextActive, danger && styles.btnTextDanger]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function SubLabel({ label, small }: { label: string; small?: boolean }) {
  return <Text style={[styles.subLabel, small && styles.subLabelSmall]}>{label}</Text>;
}

function OptRow({ children }: { children: React.ReactNode }) {
  return <View style={[styles.btnRow, styles.optRow]}>{children}</View>;
}

function SegBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void; key?: React.Key }) {
  return (
    <TouchableOpacity style={[styles.btn, active && styles.btnActive]} onPress={onPress} hitSlop={4} activeOpacity={0.7}>
      <Text style={[styles.btnText, active && styles.btnTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Decoder settings (skin v6.3.2 lsv-mp-dec-settings-panel, REAL wiring) ─────
// RTTY: preset/shift/baud/encoding/invert; WEFAX: LPM. Settings live in the
// menu (not the decoder panel); changing one while running re-attaches.

function RttySettingsRows({ s, onChange }:
  { s: RttySettings; onChange: (s: RttySettings) => void }) {
  const presetKey = Object.entries(RTTY_PRESETS).find(([, p]) =>
    p.shift === s.shift && p.baud === s.baud &&
    p.encoding === s.encoding && p.inverted === s.inverted)?.[0] ?? '';
  return (
    <>
      <SubLabel label="Preset" />
      <OptRow>
        {([['ham','HAM'],['weather','WX'],['sitor-b','SITOR-B']] as const).map(([k, l]) => (
          <SegBtn key={k} label={l} active={presetKey === k}
                  onPress={() => onChange({ ...RTTY_PRESETS[k] })} />
        ))}
      </OptRow>
      <SubLabel label="Shift (Hz)" />
      <OptRow>{[170, 200, 425, 450, 850].map(v => (
        <SegBtn key={v} label={String(v)} active={s.shift === v}
                onPress={() => onChange({ ...s, shift: v })} />
      ))}</OptRow>
      <SubLabel label="Baud" />
      <OptRow>{[45.45, 50, 75, 100].map(v => (
        <SegBtn key={v} label={String(v)} active={s.baud === v}
                onPress={() => onChange({ ...s, baud: v })} />
      ))}</OptRow>
      <SubLabel label="Encoding" />
      <OptRow>{(['ITA2', 'ASCII', 'CCIR476'] as const).map(v => (
        <SegBtn key={v} label={v} active={s.encoding === v}
                onPress={() => onChange({ ...s, encoding: v })} />
      ))}</OptRow>
      <OptRow>
        <Btn label={s.inverted ? 'INVERT: ON' : 'INVERT: OFF'} active={s.inverted}
             onPress={() => onChange({ ...s, inverted: !s.inverted })} />
      </OptRow>
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MenuSheet({
  visible, serverName, serverUrl,
  colormap, dbMin, dbMax, onColormap, onDbMin, onDbMax,
  filterLow, filterHigh, onFilterLow, onFilterHigh,
  nr = false, onNr, nb = false, onNb, recording = false, onRec, recSeconds = 0,
  snrSquelch = -999, onSnrSquelch,
  fmSquelch  = -999, onFmSquelch, isFmMode = false,
  serverDspEnabled = false, serverDspFilter = 'wiener', serverDspParams = {}, onServerDsp, onServerDspParams,
  signalMode = 'snr', onSignalMode,
  displayStyle = 'amber', onDisplayStyle,
  drumMode = 'normal', onDrumMode,
  hapticsEnabled = false, onHaptics,
  vtsName = '', vtsFreq,
  onVtsNext, onVtsPrev,
  onClose, onBack, onReconnect, onResetSettings, onDisplaySettings,
  onZoomIn, onZoomOut, onSetDefault,
  decMode = null, decOn = false, onDecToggle,
  spotsKind = null, onSpotsToggle, onServerMap,
  rttySettings, onRttySettings,
  wefaxLpm = 120, onWefaxLpm,
  vfoNeedle = '#ff8800', onVfoNeedle,
  wfCoarse = 'auto', onWfCoarse,
  autoContrast = 10, onAutoContrast,
  spatialSmooth = true, onSpatialSmooth,
  wfBrightness = 0, onWfBrightness,
  wfContrast = 0, onWfContrast,
  wfSharpness = 5, onWfSharpness,
  specShow = true, onSpecShow,
  specSmoothing = 5, onSpecSmoothing,
  specFloor = 0, onSpecFloor,
  specPeakScale = 10, onSpecPeakScale,
  peakHold = false, onPeakHold,
  frameRate = '60fps', onFrameRate,
  onSpecRatio,
}: MenuSheetProps) {

  const translateY = useRef(new Animated.Value(SHEET_H)).current;
  const backdropOp = useRef(new Animated.Value(0)).current;
  const [dispSettingsOpen, setDispSettingsOpen] = useState(false);

  // NR cycle state — off→nr→nr2. SERV is locked by server DSP section.
  const [nrMode, setNrMode] = useState<'off'|'nr'|'nr2'|'serv'>(
    serverDspEnabled ? 'serv' : nr ? 'nr' : 'off'
  );
  const cycleNr = useCallback(() => {
    if (nrMode === 'serv') return; // locked — server DSP section controls this
    const next = nrMode === 'off' ? 'nr' : nrMode === 'nr' ? 'nr2' : 'off';
    setNrMode(next);
    onNr?.(next);
  }, [nrMode, onNr]);
  // Sync when server DSP toggled externally
  useEffect(() => {
    if (serverDspEnabled) setNrMode('serv');
    else if (nrMode === 'serv') setNrMode('off');
  }, [serverDspEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterBw   = filterHigh - filterLow;
  const setFilterBw = useCallback((bw: number) => {
    const half = bw / 2;
    onFilterLow(-half);
    onFilterHigh(half);
  }, [onFilterLow, onFilterHigh]);

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(backdropOp, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, damping: 22, stiffness: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropOp, { toValue: 0, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: SHEET_H, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, backdropOp, translateY]);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOp }]} />
        </TouchableWithoutFeedback>

        <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
          <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={styles.handle} />

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}>

            {/* ── NEARBY STATION ─────────────────────────────────── */}
            <SectionLabel label="NEARBY STATION" first />
            <View style={styles.vtsRow}>
              <TouchableOpacity style={styles.vtsArrow} onPress={onVtsPrev} hitSlop={8}>
                <Text style={styles.vtsArrowText}>◂</Text>
              </TouchableOpacity>
              <View style={styles.vtsInfo}>
                <Text style={styles.vtsName} numberOfLines={1}>{vtsName || '—'}</Text>
                {vtsFreq != null && (
                  <Text style={styles.vtsFreq}>{(vtsFreq / 1_000_000).toFixed(3)} MHz</Text>
                )}
              </View>
              <TouchableOpacity style={styles.vtsArrow} onPress={onVtsNext} hitSlop={8}>
                <Text style={styles.vtsArrowText}>▸</Text>
              </TouchableOpacity>
            </View>

            {/* ── SPECTRUM / WATERFALL ───────────────────────────── */}
            <SectionLabel label="SPECTRUM / WATERFALL" />
            <BtnRow>
              <Btn label="− ZOOM" onPress={onZoomOut} />
              <Btn label="+ ZOOM" onPress={onZoomIn} />
              <Btn label="MIN"    onPress={() => { onDbMin(-130); onDbMax(-40); }} />
              <Btn label="MAX"    onPress={() => { onDbMin(-120); onDbMax(-20); }} />
            </BtnRow>
            <BtnRow>
              <Btn label="☀ DISPLAY SETTINGS" full active={dispSettingsOpen}
                onPress={() => setDispSettingsOpen((p: boolean) => !p)} />
            </BtnRow>
            {dispSettingsOpen && (
              <View style={styles.subPanel}>

                {/* Save row */}
                <BtnRow>
                  <Btn label="↺ RESET"       onPress={() => {}} />
                  <Btn label="💾 THIS SERVER" onPress={() => {}} />
                  <Btn label="🌐 GLOBAL"      onPress={() => {}} />
                </BtnRow>

                {/* Layout — spectrum/waterfall ratio */}
                <SubLabel label="Layout" />
                <BtnRow>
                  <Btn label="📐 SPECTRUM / WATERFALL RATIO" full
                    onPress={() => onSpecRatio?.()} />
                </BtnRow>

                {/* Colour Map — picker-style row */}
                <SubLabel label="Colour Map" />
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.cmapStrip}>
                  {(['sonar','gqrx','green','inferno','plasma','viridis'] as const).map(name => (
                    <TouchableOpacity key={name}
                      style={[styles.cmapPill, name === colormap && styles.cmapPillActive]}
                      onPress={() => onColormap(name)} hitSlop={4}>
                      <Text style={[styles.cmapPillText, name === colormap && styles.cmapPillTextActive]}>
                        {name.charAt(0).toUpperCase()+name.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* VFO Needle Colour — colour swatches */}
                <SubLabel label="VFO Needle Colour" />
                <View style={styles.swatchRow}>
                  {([
                    {hex:'#ff2020',label:'Red'},    {hex:'#00ff44',label:'Green'},
                    {hex:'#4499ff',label:'Blue'},   {hex:'#ffdd00',label:'Yellow'},
                    {hex:'#00eeff',label:'Cyan'},   {hex:'#ff8800',label:'Orange'},
                    {hex:'#ffffff',label:'White'},  {hex:'#cc44ff',label:'Purple'},
                  ]).map(c => (
                    <TouchableOpacity key={c.hex} hitSlop={4}
                      style={[styles.swatch, { backgroundColor: c.hex },
                        vfoNeedle === c.hex && styles.swatchActive]}
                      onPress={() => onVfoNeedle?.(c.hex)}
                    />
                  ))}
                </View>

                {/* Waterfall — Coarse */}
                <SubLabel label="Waterfall — Coarse" />
                <BtnRow>
                  <Btn label="AUTO"   active={wfCoarse==='auto'}   onPress={() => onWfCoarse?.('auto')} />
                  <Btn label="MANUAL" active={wfCoarse==='manual'} onPress={() => onWfCoarse?.('manual')} />
                </BtnRow>
                {wfCoarse === 'auto' && (
                  <View style={styles.sliderWrap}>
                    <Text style={styles.sliderLabel}>Auto Range</Text>
                    <Slider style={{flex:1}} minimumValue={0} maximumValue={20} step={1}
                      value={autoContrast} onValueChange={onAutoContrast ?? (() => {})}
                      minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                    <Text style={styles.sliderVal}>{autoContrast}</Text>
                  </View>
                )}

                {/* Waterfall — Fine */}
                <SubLabel label="Waterfall — Fine" />
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Brightness</Text>
                  <Slider style={{flex:1}} minimumValue={-20} maximumValue={20} step={1}
                    value={wfBrightness} onValueChange={onWfBrightness ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{(wfBrightness > 0 ? '+' : '') + wfBrightness} dB</Text>
                </View>
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Contrast</Text>
                  <Slider style={{flex:1}} minimumValue={-10} maximumValue={10} step={1}
                    value={wfContrast} onValueChange={onWfContrast ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{(wfContrast > 0 ? '+' : '') + wfContrast}</Text>
                </View>
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Sharpness</Text>
                  <Slider style={{flex:1}} minimumValue={0} maximumValue={10} step={1}
                    value={wfSharpness} onValueChange={onWfSharpness ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{wfSharpness}</Text>
                </View>
                <BtnRow>
                  <Btn label="SPATIAL SMOOTH" active={spatialSmooth}
                       onPress={() => onSpatialSmooth?.(!spatialSmooth)} />
                </BtnRow>

                {/* Spectrum Trace */}
                <SubLabel label="Spectrum Trace" />
                <BtnRow>
                  <Btn label="SHOW" active={specShow}  onPress={() => onSpecShow?.(!specShow)} />
                  <Btn label="HIDE" active={!specShow} onPress={() => onSpecShow?.(false)} />
                </BtnRow>
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Smoothing</Text>
                  <Slider style={{flex:1}} minimumValue={1} maximumValue={10} step={1}
                    value={specSmoothing} onValueChange={onSpecSmoothing ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{specSmoothing}</Text>
                </View>
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Floor</Text>
                  <Slider style={{flex:1}} minimumValue={-20} maximumValue={20} step={1}
                    value={specFloor} onValueChange={onSpecFloor ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{(specFloor > 0 ? '+' : '') + specFloor} dB</Text>
                </View>
                <View style={styles.sliderWrap}>
                  <Text style={styles.sliderLabel}>Peak Scale</Text>
                  <Slider style={{flex:1}} minimumValue={1} maximumValue={30} step={1}
                    value={specPeakScale} onValueChange={onSpecPeakScale ?? (() => {})}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                  <Text style={styles.sliderVal}>{(specPeakScale / 10).toFixed(1)}×</Text>
                </View>
                <BtnRow>
                  <Btn label="PEAK HOLD" active={peakHold} onPress={() => onPeakHold?.(!peakHold)} />
                </BtnRow>

                {/* Frame Interpolation */}
                <SubLabel label="Frame Interpolation" />
                <BtnRow>
                  <Btn label="NATIVE" active={frameRate==='native'} onPress={() => onFrameRate?.('native')} />
                  <Btn label="20fps"  active={frameRate==='20fps'}  onPress={() => onFrameRate?.('20fps')} />
                  <Btn label="60fps"  active={frameRate==='60fps'}  onPress={() => onFrameRate?.('60fps')} />
                </BtnRow>

              </View>
            )}

            {/* ── AUDIO ──────────────────────────────────────────── */}
            <SectionLabel label="AUDIO" />
            <View style={styles.bwRow}>
              <Text style={styles.bwLabel}>LSB</Text>
              <Slider style={styles.bwSlider}
                minimumValue={0} maximumValue={15_000} step={50}
                value={Math.abs(filterLow)}
                onValueChange={(v: number) => onFilterLow(-v)}
                minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted}
                thumbTintColor={C.gold} />
              <Text style={styles.bwVal}>−{fmtHz(Math.abs(filterLow))}</Text>
            </View>
            <View style={styles.bwRow}>
              <Text style={styles.bwLabel}>USB</Text>
              <Slider style={styles.bwSlider}
                minimumValue={0} maximumValue={15_000} step={50}
                value={filterHigh}
                onValueChange={onFilterHigh}
                minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted}
                thumbTintColor={C.gold} />
              <Text style={styles.bwVal}>+{fmtHz(filterHigh)}</Text>
            </View>

            {/* NR cycles off→NR→NR2. Shows SERV (green, locked) when server DSP active. */}
            <BtnRow>
              <Btn
                label={nrMode === 'serv' ? 'SERV' : nrMode === 'nr2' ? 'NR2' : 'NR'}
                active={nrMode !== 'off'}
                style={nrMode === 'serv' ? { borderColor: 'rgba(50,210,100,0.60)', backgroundColor: 'rgba(50,210,100,0.10)' } : undefined}
                onPress={cycleNr}
              />
              <Btn label="NB"      active={nb}        onPress={() => onNb?.(!nb)} />
              <Btn label="⏺ REC"  active={recording} onPress={onRec} />
            </BtnRow>
            {recording && (
              <View style={styles.recTimer}>
                <View style={styles.recDot} />
                <Text style={styles.recTime}>{fmtRecTime(recSeconds)}</Text>
              </View>
            )}

            {/* SNR Squelch — audio gate, always visible. Slider 24–80 dB, left = Off */}
            <View style={styles.bwRow}>
              <Text style={styles.bwLabel}>SNR SQL</Text>
              <Slider style={styles.bwSlider}
                minimumValue={24} maximumValue={80} step={0.5}
                value={Math.max(24, snrSquelch === -999 ? 24 : snrSquelch)}
                onValueChange={(v: number) => onSnrSquelch?.(v <= 24.1 ? -999 : v)}
                minimumTrackTintColor={snrSquelch > 24 ? C.gold : C.muted}
                maximumTrackTintColor={C.muted}
                thumbTintColor={C.gold} />
              <Text style={styles.bwVal}>{snrSquelch <= -999 ? 'Off' : `≥${snrSquelch.toFixed(0)}`}</Text>
            </View>

            {/* FM Squelch — only shown for fm/nfm. Currently feature-flagged off in UberSDR. */}
            {isFmMode && (
              <View style={styles.bwRow}>
                <Text style={styles.bwLabel}>FM SQL</Text>
                <Slider style={styles.bwSlider}
                  minimumValue={0} maximumValue={100} step={1}
                  value={fmSquelch <= -999 ? 0 : Math.round((fmSquelch + 48) * 99 / 68 + 1)}
                  onValueChange={(v: number) => {
                    const db = v === 0 ? -999 : -48 + (v - 1) * (68 / 99);
                    onFmSquelch?.(db);
                  }}
                  minimumTrackTintColor={fmSquelch > -999 ? C.gold : C.muted}
                  maximumTrackTintColor={C.muted}
                  thumbTintColor={C.gold} />
                <Text style={styles.bwVal}>{fmSquelch <= -999 ? 'Open' : `${fmSquelch.toFixed(1)}dB`}</Text>
              </View>
            )}

            {/* ── SERVER DSP ─────────────────────────────────────── */}
            <SectionLabel label="SERVER DSP" />
            <BtnRow>
              <Btn
                label={serverDspEnabled ? 'DISABLE SERVER NR' : 'ENABLE SERVER NR'}
                active={serverDspEnabled}
                full
                style={serverDspEnabled ? { borderColor: 'rgba(50,210,100,0.50)', backgroundColor: 'rgba(50,210,100,0.10)' } : undefined}
                onPress={() => onServerDsp?.(!serverDspEnabled, serverDspFilter, serverDspParams)}
              />
            </BtnRow>

            {/* ── SERVER MAPS — full-screen Leaflet overlays (skin parity) ── */}
            <SectionLabel label="SERVER MAPS" />
            <BtnRow>
              <Btn label="✈ HFDL"     onPress={() => onServerMap?.('hfdl')} />
              <Btn label="📡 DIGITAL"  onPress={() => onServerMap?.('digi')} />
              <Btn label="⊟ CW"       onPress={() => onServerMap?.('cw')} />
            </BtnRow>

            {/* ── CLIENT DECODERS — skin: toggle start/stop, menu stays open;
                   settings for the selected mode appear underneath ── */}
            <SectionLabel label="CLIENT DECODERS" />
            <BtnRow>
              {(['rtty','navtex','wefax','sstv','morse'] as const).map(k => (
                <Btn key={k} label={k.toUpperCase()}
                  active={decMode === k && decOn}
                  style={decMode === k && !decOn ? styles.btnSelected : undefined}
                  onPress={() => onDecToggle?.(k)} />
              ))}
            </BtnRow>
            {decMode === 'rtty' && rttySettings && onRttySettings && (
              <View style={styles.subPanel}>
                <RttySettingsRows s={rttySettings} onChange={onRttySettings} />
              </View>
            )}
            {decMode === 'wefax' && (
              <View style={styles.subPanel}>
                <SubLabel label="LPM" />
                <OptRow>{[60, 120, 240].map(v => (
                  <SegBtn key={v} label={String(v)} active={wefaxLpm === v}
                          onPress={() => onWefaxLpm?.(v)} />
                ))}</OptRow>
              </View>
            )}

            {/* ── SERVER EXTENSIONS — spots feeds + speech-to-text ── */}
            <SectionLabel label="SERVER EXTENSIONS" />
            <BtnRow>
              <Btn label="DIGITAL SPOTS" active={spotsKind === 'digi'}
                   onPress={() => onSpotsToggle?.('digi')} />
              <Btn label="CW SPOTS" active={spotsKind === 'cw'}
                   onPress={() => onSpotsToggle?.('cw')} />
              <Btn label="STT" active={decMode === 'whisper' && decOn}
                   style={decMode === 'whisper' && !decOn ? styles.btnSelected : undefined}
                   onPress={() => onDecToggle?.('whisper')} />
            </BtnRow>
            {spotsKind !== null && (
              <View style={styles.subPanel}>
                <SubLabel label="Filters in decoder panel header · tap a spot to tune" small />
              </View>
            )}

            {/* ── CONTROLS ───────────────────────────────────────── */}
            <SectionLabel label="CONTROLS" />
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>SIGNAL</Text>
              <BtnRow>
                {(['snr','smeter','dbfs'] as const).map(m => (
                  <Btn key={m} label={m==='smeter' ? 'S-METER' : m.toUpperCase()}
                    active={signalMode===m} onPress={() => onSignalMode?.(m)} />
                ))}
              </BtnRow>
            </View>
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>DISPLAY STYLE</Text>
              <BtnRow>
                <Btn label="AMBER" active={displayStyle==='amber'} onPress={() => onDisplayStyle?.('amber')} />
                <Btn label="WHITE" active={displayStyle==='white'} onPress={() => onDisplayStyle?.('white')} />
              </BtnRow>
            </View>
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>DRUMS</Text>
              <BtnRow>
                <Btn label="NORMAL"    active={drumMode==='normal'}  onPress={() => onDrumMode?.('normal')} />
                <Btn label="PRECISE"   active={drumMode==='precise'} onPress={() => onDrumMode?.('precise')} />
                <Btn label="✦ HAPTICS" active={hapticsEnabled}       onPress={() => onHaptics?.(!hapticsEnabled)} />
              </BtnRow>
            </View>

            {/* ── INSTANCE ───────────────────────────────────────── */}
            <SectionLabel label="INSTANCE" />
            <Text style={styles.instanceUrl} numberOfLines={1}>{serverName || serverUrl}</Text>
            <BtnRow>
              <Btn label="☆ SET DEFAULT" onPress={onSetDefault} />
              <Btn label="← BACK"        onPress={onBack ?? onClose} />
            </BtnRow>
            <BtnRow col>
              <Btn label="⟳ RECONNECT"                full onPress={onReconnect ?? onClose} />
              <Btn label="↺ RESET INTERFACE SETTINGS" full danger onPress={onResetSettings} />
            </BtnRow>

            <View style={{ height: 24 }} />
          </ScrollView>

          <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <Text style={styles.closeBtnText}>CLOSE  ✕</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0, height: SHEET_H,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    overflow: 'hidden', borderTopWidth: 1, borderColor: C.border,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: C.border, marginTop: 10, marginBottom: 2,
  },
  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingTop: 4 },

  sectionBar: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,160,0,0.18)',
    paddingTop: 10, paddingBottom: 4, marginTop: 6,
  },
  sectionBarFirst: { borderTopWidth: 0, marginTop: 2 },
  sectionLabel: {
    color: C.sectionC, fontFamily: 'Nixie One', fontSize: 11,
    fontWeight: 'bold', letterSpacing: 2,
  },

  btnRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 4 },
  btnRowCol: { flexDirection: 'column', gap: 6 },
  optRow:    { paddingTop: 2, paddingBottom: 0 },

  btn: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, paddingHorizontal: 10, paddingVertical: 7,
    alignItems: 'center', justifyContent: 'center',
  },
  btnActive:     { backgroundColor: C.active, borderColor: C.gold },
  btnSelected:   { borderColor: 'rgba(255,160,0,0.55)' }, // selected but not running (skin)
  btnDanger:     { backgroundColor: C.danger, borderColor: C.dangerBorder },
  btnFull:       { flex: 1, alignSelf: 'stretch' },
  btnText:       { color: C.muted, fontFamily: 'Nixie One', fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5 },
  btnTextActive: { color: C.gold },
  btnTextDanger: { color: '#ff6666' },

  vtsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  vtsArrow: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, paddingHorizontal: 14, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  vtsArrowText: { color: C.gold, fontSize: 18 },
  vtsInfo:  { flex: 1, alignItems: 'center', gap: 3 },
  vtsName:  { color: C.text, fontFamily: 'Nixie One', fontSize: 14, letterSpacing: 1 },
  vtsFreq:  { color: C.sectionC, fontFamily: 'Nixie One', fontSize: 11, letterSpacing: 1 },

  sliderRow:   { paddingVertical: 4, gap: 4 },
  sliderLabel: { color: C.sectionC, fontFamily: 'Nixie One', fontSize: 11, letterSpacing: 1, width: 72, flexShrink: 0 },
  bwRow:    { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  bwLabel:  { color: C.sectionC, fontFamily: 'Nixie One', fontSize: 11, letterSpacing: 1, width: 32 },
  bwSlider: { flex: 1, height: 32 },
  bwVal:    { color: C.gold, fontFamily: 'Nixie One', fontSize: 11, minWidth: 68, textAlign: 'right' },
  sliderWrap:  { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  sliderVal:   { color: C.gold, fontFamily: 'Nixie One', fontSize: 11, minWidth: 72, textAlign: 'right' },

  stepSlider: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  stepSliderBtn: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  },
  stepSliderBtnTxt: { color: C.gold, fontSize: 18, fontWeight: 'bold', lineHeight: 22 },
  stepSliderVal: { color: C.gold, fontFamily: 'Nixie One', fontSize: 12, flex: 1, textAlign: 'center' },

  subPanel: {
    backgroundColor: 'rgba(255,160,0,0.05)', borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,160,0,0.15)',
    padding: 8, marginBottom: 4,
  },
  subLabel:      { color: C.sectionC, fontFamily: 'Nixie One', fontSize: 11, letterSpacing: 1, paddingTop: 6, paddingBottom: 2 },
  subLabelSmall: { fontSize: 9, opacity: 0.5 },

  recTimer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  recDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: '#cc2222' },
  recTime:  { color: C.gold, fontFamily: 'Nixie One', fontSize: 13 },

  ctrlRow:   { paddingVertical: 4, gap: 4 },
  ctrlLabel: { color: C.sectionC, fontFamily: 'Nixie One', fontSize: 10, letterSpacing: 1.5 },

  swatchRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingVertical: 4 },
  swatch:     { width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: 'transparent' },
  swatchActive: { borderColor: '#fff' },
  cmapStrip:          { gap: 6, flexDirection: 'row', paddingBottom: 4 },
  cmapPill:           { backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  cmapPillActive:     { backgroundColor: C.active, borderColor: C.gold },
  cmapPillText:       { color: C.muted, fontFamily: 'Nixie One', fontSize: 11 },
  cmapPillTextActive: { color: C.gold },

  instanceUrl: { color: 'rgba(255,184,51,0.30)', fontFamily: 'Nixie One', fontSize: 10, paddingBottom: 4 },

  closeBtn: {
    margin: 12, alignSelf: 'center', backgroundColor: C.btnBg,
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingHorizontal: 24, paddingVertical: 8,
  },
  closeBtnText: { color: C.goldDim, fontFamily: 'Nixie One', fontSize: 12, fontWeight: 'bold', letterSpacing: 1 },
});
