/**
 * MenuSheet — slide-up panel matching VibeSDR_Mockup_SAVE.html exactly.
 *
 * Sections (in order):
 *   Nearby Station · Spectrum/Waterfall · Audio · Server Maps
 *   Client Decoders · Server Extensions · Controls · Instance
 *   Reset Interface Settings
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import Slider from '@react-native-community/slider';
import { COLORMAP_NAMES } from '../assets/colormapUtils';
import { RTTY_PRESETS, type RttySettings } from '../services/DecoderClient';
import {
  searchStations, fmtFreq, fmtRange, grpAbbr,
  type ServerBookmark, type ServerBand, type SearchResult,
} from '../services/stations';
import { type UserBookmark } from '../services/userBookmarks';
import { APP_VERSION } from '../constants/version';

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
  /** Per-edge passband half-width cap (Hz) for the active mode/backend.
      Drives the bandwidth sliders' range — never hardcode it. Default 6000. */
  bwEdgeMax?:   number;
  onFilterLow:  (v: number) => void;
  onFilterHigh: (v: number) => void;
  /** Atomic both-edges setter — used by the mirrored sliders + SYNC. */
  onFilterBoth?: (low: number, high: number) => void;
  nr?:          boolean;
  onNr?:        (mode: 'off'|'nr'|'nr2') => void;
  onZoomIn?:    () => void;
  onZoomOut?:   () => void;
  onSetDefault?: () => void;
  isDefaultInstance?: boolean;
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
  // OWRX squelch (dB, -150=off) + NR (threshold dB, 0=off) — replace the UberSDR
  // SNR/FM squelch + NR/NB controls (which do nothing on OWRX).
  serverLabel?:   string | null;
  onOwrxSquelch?: (db: number) => void;
  onOwrxNr?:      (threshold: number) => void;

  // Server DSP
  serverDspEnabled?:   boolean;
  serverDspFilter?:    string;
  serverDspParams?:    Record<string, string>;
  dspFilters?:         DspFilterDesc[];
  dspError?:           string | null;
  onServerDsp?:        (enabled: boolean) => void;
  onServerDspFilter?:  (name: string) => void;
  onServerDspParam?:   (name: string, value: string) => void;

  signalMode?:     'snr' | 'smeter' | 'dbfs';
  onSignalMode?:   (m: 'snr' | 'smeter' | 'dbfs') => void;
  displayStyle?:   'amber' | 'white';
  onDisplayStyle?: (s: 'amber' | 'white') => void;
  drumMode?:       'normal' | 'precise';
  onDrumMode?:     (m: 'normal' | 'precise') => void;
  mediaSkip?:      'step' | 'bookmark';
  onMediaSkip?:    (m: 'step' | 'bookmark') => void;
  /** Recentre the spectrum view on the tuned frequency (skin parity). */
  onCentreVfo?:    () => void;
  /** Hide the controls bar for a full-screen waterfall (chevron restores). */
  onHideControls?: () => void;
  onDispReset?:      () => void;
  onDispSaveServer?: () => void;
  onDispSaveGlobal?: () => void;
  hapticsEnabled?: boolean;
  onHaptics?:      (on: boolean) => void;

  vtsName?:    string;
  vtsFreq?:    number;
  onVtsNext?:  () => void;
  onVtsPrev?:  () => void;
  // OWRX profiles (hidden unless a backend reports them)
  profiles?:        { id: string; name: string }[];
  activeProfileId?: string;
  sdrUsage?:        Record<string, { name: string; inUse: boolean; activeProfileId?: string }>;  // OWRX: per-SDR usage
  clientCount?:     number;     // OWRX: live users online
  onSelectProfile?: (id: string) => void;
  // OWRX DAB ensemble — programme picker (hidden unless a DAB ensemble is tuned)
  dabProgrammes?:   { id: number; name: string }[];
  activeDabId?:     number;
  onSelectDab?:     (id: number) => void;
  dabSpeed?:        number;            // DAB speed-correction factor (1 = off)
  onDabSpeed?:      (scale: number) => void;
  serverType?:      string;   // 'ubersdr' | 'owrx' | 'kiwi' — picks the footer logo
  searchBookmarks?: ServerBookmark[];
  searchBands?:     ServerBand[];
  onSearchTune?:    (hz: number, mode?: string | null, isBand?: boolean) => void;
  userBookmarks?:     UserBookmark[];
  currentFreq?:       number;
  currentMode?:       string;
  onAddBookmark?:     (name: string, allInstances: boolean) => void;
  onDeleteBookmark?:  (bm: UserBookmark) => void;
  onExportBookmarks?: () => void;
  onImportBookmarks?: (text: string, allInstances: boolean) => string;

  onClose:          () => void;
  onBack?:          () => void;
  onAdminLink?:     (path: string, title: string) => void;
  onResetSettings?: () => void;
  onDisplaySettings?: () => void;
  /** UberSDR server software version (/api/description) — footer right side. */
  serverVersion?:   string | null;
  /** Opens the About VibeSDR overlay (footer left side). */
  onAbout?:         () => void;

  // Display settings panel props
  vfoNeedle?:         string;
  onVfoNeedle?:       (hex: string) => void;
  /** Needle/glow brightness 1–10 (5 = original look). */
  vfoIntensity?:      number;
  onVfoIntensity?:    (v: number) => void;
  /** Frosted backing 0–10 (0 = off) — dims the waterfall behind the needle. */
  vfoFrost?:          number;
  onVfoFrost?:        (v: number) => void;
  /** Instance spectrum backdrop opacity 0–10 (server-supplied image). */
  bgOpacity?:         number;
  onBgOpacity?:       (v: number) => void;
  hasBgImage?:        boolean;
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
  frameRate?:         'native' | '20fps' | '30fps';
  onFrameRate?:       (v: 'native' | '20fps' | '30fps') => void;
  smoothTune?:        boolean;
  onSmoothTune?:      (v: boolean) => void;
  idleSlow?:          boolean;
  onIdleSlow?:        (v: boolean) => void;
  onSpecRatio?:       () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Server-software logos for the menu footer — one per supported backend so the
// user can see what they're connected to (KiwiSDR/OpenWebRX to come).
const SERVER_LOGOS: Record<string, any> = {
  ubersdr: require('../../assets/logo_ubersdr.png'),
  owrx:    require('../../assets/logo_owrx.png'),
};

// Accessibility skin (reference body.lsv-a11y) — the single style going
// forward: white Atkinson Hyperlegible text, larger touch targets, neutral
// white borders. Gold survives only as the ACTIVE-state accent.
const C = {
  bg:           'rgba(6,4,2,0.99)',        // a11y #lsv-menu-panel
  border:       'rgba(255,255,255,0.30)',
  divider:      'rgba(255,255,255,0.12)',  // a11y section rules
  gold:         '#ffe566',                 // active text
  goldDim:      'rgba(255,229,102,0.70)',  // active border
  muted:        'rgba(255,255,255,0.92)',  // base button/value text — white
  btnBg:        'rgba(20,18,14,0.85)',
  active:       'rgba(255,200,0,0.12)',
  danger:       'rgba(160,30,30,0.80)',
  dangerBorder: 'rgba(220,60,60,0.60)',
  text:         '#ffffff',
  sectionC:     'rgba(180,190,210,0.80)',  // a11y .lsv-mp-section
  sliderLabel:  'rgba(200,210,225,0.90)',
};

const { height: SCREEN_H } = Dimensions.get('window');
const SHEET_H = Math.min(SCREEN_H * 0.88, 700);

// Bookmark scope colours (key shown above the saved list)
const BM_GLOBAL_C = 'rgba(110,200,255,0.95)';  // all instances — cyan
const BM_LOCAL_C  = '#ffe566';                 // this instance — gold


// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtHz(hz: number) {
  return hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : hz + ' Hz';
}

function fmtRecTime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ── Server-side NR (DSP insert) descriptors — shapes match the server's
//    dsp_filters paramInfo/filterInfo JSON (all values are strings on the wire)
export interface DspParamDesc {
  name:          string;
  type?:         string;   // 'float' | 'int' | 'bool' | free text
  default?:      string;
  min?:          string;
  max?:          string;
  description?:  string;
  runtime_safe?: boolean;
}
export interface DspFilterDesc {
  name:         string;
  description?: string;
  params?:      DspParamDesc[];
}

function fmtParamName(n: string) {
  return n.replace(/_/g, ' ').toUpperCase();
}
function dspStep(min: number, max: number) {
  const r = max - min;
  if (r <= 1)   return 0.01;
  if (r <= 10)  return 0.1;
  if (r <= 100) return 1;
  return Math.pow(10, Math.floor(Math.log10(r)) - 2);
}
function fmtDspVal(v: number, step: number) {
  return v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
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
  filterLow, filterHigh, bwEdgeMax = 6000, onFilterLow, onFilterHigh, onFilterBoth,
  nr = false, onNr, nb = false, onNb, recording = false, onRec, recSeconds = 0,
  snrSquelch = -999, onSnrSquelch,
  fmSquelch  = -999, onFmSquelch, isFmMode = false,
  serverLabel = null, onOwrxSquelch, onOwrxNr,
  serverDspEnabled = false, serverDspFilter = '', serverDspParams = {},
  dspFilters = [], dspError = null, onServerDsp, onServerDspFilter, onServerDspParam,
  signalMode = 'snr', onSignalMode,
  displayStyle = 'amber', onDisplayStyle,
  drumMode = 'normal', onDrumMode, onCentreVfo, onHideControls,
  mediaSkip = 'step', onMediaSkip,
  onDispReset, onDispSaveServer, onDispSaveGlobal,
  hapticsEnabled = false, onHaptics,
  vtsName = '', vtsFreq,
  onVtsNext, onVtsPrev,
  profiles = [], activeProfileId, sdrUsage = {}, clientCount = 0, onSelectProfile, serverType = 'ubersdr',
  dabProgrammes = [], activeDabId, onSelectDab, dabSpeed = 1, onDabSpeed,
  searchBookmarks = [], searchBands = [], onSearchTune,
  userBookmarks = [], currentFreq = 0, currentMode = '',
  onAddBookmark, onDeleteBookmark, onExportBookmarks, onImportBookmarks,
  onClose, onBack, onAdminLink, onResetSettings, onDisplaySettings,
  serverVersion = null, onAbout,
  onZoomIn, onZoomOut, onSetDefault, isDefaultInstance = false,
  decMode = null, decOn = false, onDecToggle,
  spotsKind = null, onSpotsToggle, onServerMap,
  rttySettings, onRttySettings,
  wefaxLpm = 120, onWefaxLpm,
  vfoNeedle = '#ffffff', onVfoNeedle,
  vfoIntensity = 5, onVfoIntensity,
  vfoFrost = 0, onVfoFrost,
  bgOpacity = 3, onBgOpacity, hasBgImage = false,
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
  frameRate = '20fps', onFrameRate,
  smoothTune = true, onSmoothTune, idleSlow = true, onIdleSlow,
  onSpecRatio,
}: MenuSheetProps) {

  const translateY = useRef(new Animated.Value(SHEET_H)).current;
  const [cmapOpen, setCmapOpen] = useState(false);

  // Responsive sheet geometry — SHEET_H is a module constant measured in
  // PORTRAIT, so in landscape a bottom-anchored 700pt sheet pokes past the top
  // of the screen (unscrollable) and full-bleed width runs under the Dynamic
  // Island. Recompute per orientation and inset-clear in landscape.
  const { width: winW, height: winH } = useWindowDimensions();
  const sheetInsets = useSafeAreaInsets();
  const isLandscape = winW > winH;
  const sheetH = Math.min(winH * 0.88, 700);
  const sheetW = isLandscape
    ? Math.min(520, winW - sheetInsets.left - sheetInsets.right - 24)
    : undefined;
  const sheetGeom = isLandscape
    ? { height: sheetH, width: sheetW, left: (winW - (sheetW ?? winW)) / 2,
        right: undefined, borderTopLeftRadius: 16, borderTopRightRadius: 16 }
    : { height: sheetH };
  const backdropOp = useRef(new Animated.Value(0)).current;
  const [profileOpen, setProfileOpen] = useState(false);   // OWRX profile dropdown
  const [dabOpen, setDabOpen] = useState(false);           // OWRX DAB programme dropdown
  const [owrxSql, setOwrxSql] = useState(-150);            // OWRX squelch dB (-150 = off)
  const [owrxNr,  setOwrxNr]  = useState(0);               // OWRX NR threshold dB (0 = off)
  const isOwrx = serverType === 'owrx';
  const [dispSettingsOpen, setDispSettingsOpen] = useState(false);

  // Palette list alphabetised (it ships in table order); profiles are LEFT in
  // server order on purpose — they're SDR-type ordered and re-sorting risks the
  // user tapping the wrong profile and disturbing an SDR in active use.
  const cmapSorted = useMemo(
    () => [...COLORMAP_NAMES].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [],
  );
  // OWRX profiles grouped per SDR (id = `sdrId|profileId`). The SDR name + in-use
  // flag come from /status.json (sdrUsage); profile order is preserved (server
  // order). Each profile label has the SDR-name prefix stripped (the wire name is
  // "{sdrName} {profileName}") so the dropdown reads cleanly under its header.
  const sdrGroups = useMemo(() => {
    const order: string[] = [];
    const byId = new Map<string, { id: string; name: string }[]>();
    for (const p of profiles) {
      const sid = p.id.includes('|') ? p.id.split('|')[0] : p.id;
      if (!byId.has(sid)) { byId.set(sid, []); order.push(sid); }
      byId.get(sid)!.push(p);
    }
    const lcp = (a: string[]) => {
      if (!a.length) return '';
      let pre = a[0];
      for (let i = 1; i < a.length; i++) { let k = 0; while (k < pre.length && k < a[i].length && pre[k] === a[i][k]) k++; pre = pre.slice(0, k); }
      return pre;
    };
    return order.map((sid) => {
      const items = byId.get(sid)!;
      const info = sdrUsage[sid];
      const sdrName = info?.name || lcp(items.map((i) => i.name)).replace(/\s+\S*$/, '').trim() || sid;
      const strip = (n: string) => (sdrName && n.startsWith(sdrName + ' ') ? n.slice(sdrName.length + 1) : n);
      return { sid, sdrName, inUse: !!info?.inUse, activeProfileId: info?.activeProfileId, items: items.map((i) => ({ id: i.id, label: strip(i.name) })) };
    });
  }, [profiles, sdrUsage]);
  // Compact dropdowns: each is a bounded, internally-scrollable box. While one is
  // open the OUTER menu scroll is DISABLED (see scrollEnabled below) so the inner
  // box gets all the gestures — that's what fixes the "outer steals the drag"
  // fight. On open we scroll the inner box to the current row (measureLayout of
  // the active row against the inner ScrollView → content-relative y, works
  // through the per-SDR group wrappers).
  const profScroll = useRef<ScrollView | null>(null);
  const dabScroll  = useRef<ScrollView | null>(null);
  const cmapScroll = useRef<ScrollView | null>(null);
  // content-relative y of each active row (captured via onLayout); the rows are
  // flat children of their ScrollView so onLayout y == scroll offset.
  const profY = useRef<Record<string, number>>({});
  const dabY  = useRef<Record<string, number>>({});
  const cmapY = useRef<Record<string, number>>({});
  // Read the position INSIDE the delay (not before) so onLayout has populated it.
  const openAt = (sv: ScrollView | null, y?: number) => {
    if (sv == null) return;
    setTimeout(() => { if (y != null) sv.scrollTo({ y: Math.max(0, y - 8), animated: false }); }, 60);
  };
  useEffect(() => { if (profileOpen) openAt(profScroll.current, activeProfileId != null ? profY.current[activeProfileId] : undefined); }, [profileOpen, activeProfileId]);
  useEffect(() => { if (dabOpen)     openAt(dabScroll.current,  activeDabId != null ? dabY.current[String(activeDabId)] : undefined); }, [dabOpen, activeDabId]);
  useEffect(() => { if (cmapOpen)    openAt(cmapScroll.current, cmapY.current[colormap]); }, [cmapOpen, colormap]);

  // Bookmarks pane (replaces menu content like DISPLAY SETTINGS)
  const [bookmarksOpen,  setBookmarksOpen]  = useState(false);
  const [bmName,         setBmName]         = useState('');
  const [bmAll,          setBmAll]          = useState(false);
  const [bmImportOpen,   setBmImportOpen]   = useState(false);
  const [bmImportText,   setBmImportText]   = useState('');
  const [bmImportMsg,    setBmImportMsg]    = useState('');
  useEffect(() => {
    if (!visible) {
      setBookmarksOpen(false); setBmImportOpen(false); setBmImportMsg('');
      // Collapse the dropdowns on close — MenuSheet stays mounted (returns null),
      // so an open dropdown would persist and reopen scrolled to the top instead
      // of the current item (the open-at-current effect only fires on open).
      setProfileOpen(false); setDabOpen(false); setCmapOpen(false);
    }
  }, [visible]);
  const [bwSync,           setBwSync]           = useState(false);

  // NR cycle state — off→nr→nr2. SERV is locked by server DSP section.
  // Search bookmarks & band plan (skin lsv-mp-bm-input)
  const [searchQuery, setSearchQuery] = useState('');
  const searchResults = useMemo(
    () => searchStations(searchBookmarks, searchBands, searchQuery),
    [searchBookmarks, searchBands, searchQuery],
  );
  useEffect(() => { if (!visible) setSearchQuery(''); }, [visible]);

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
  // Coarser step for wideband ranges (e.g. OWRX broadcast FM ±96 kHz) so the
  // slider thumb travels in usable increments; 50 Hz for narrow modes.
  const bwStep     = bwEdgeMax > 20000 ? 1000 : 50;
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
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}
           supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}>
      <View style={StyleSheet.absoluteFill}>
        <TouchableWithoutFeedback onPress={onClose}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOp }]} />
        </TouchableWithoutFeedback>

        <Animated.View style={[styles.sheet, sheetGeom, { transform: [{ translateY }] }]}>
          <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} />
          {/* a11y panel is near-opaque (reference bg rgba(6,4,2,0.99)) */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(6,4,2,0.60)' }]} />
          <View style={styles.handle} />

          <ScrollView style={styles.scroll}
            contentContainerStyle={[styles.scrollContent,
              { paddingBottom: sheetInsets.bottom + 16 }]}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={!(profileOpen || dabOpen || cmapOpen)}
            showsVerticalScrollIndicator={false}>

            {/* Display settings is its OWN view — it REPLACES the main menu
                content instead of expanding inline over it (inline blended in
                and was confusing to read). */}
            {!dispSettingsOpen && !bookmarksOpen && (<>

            {/* ── PROFILE (OWRX only — hidden unless the backend reports profiles) ── */}
            {profiles.length > 0 && (<>
              <SectionLabel label="PROFILE" first />
              {sdrGroups.some((g) => g.inUse) && (
                <View style={styles.etiquette}>
                  <Text style={styles.etiquetteText}>
                    <Text style={styles.etiquetteLead}>Etiquette: </Text>
                    if an SDR shows IN USE, check chat before changing its profile — you may interrupt another listener.
                    {clientCount > 0 ? `  ${clientCount} user${clientCount === 1 ? '' : 's'} online.` : ''}
                  </Text>
                </View>
              )}
              <View style={styles.profileDrop}>
                <TouchableOpacity style={styles.profileDropHead} onPress={() => setProfileOpen((o) => !o)} activeOpacity={0.7}>
                  <Text style={styles.profileDropHeadText} numberOfLines={1}>
                    {profiles.find((p) => p.id === activeProfileId)?.name ?? 'Select profile'}
                  </Text>
                  <Text style={styles.profileDropChevron}>{profileOpen ? '▴' : '▾'}</Text>
                </TouchableOpacity>
                {profileOpen && (
                  <ScrollView ref={profScroll} style={styles.profileDropList} nestedScrollEnabled
                              keyboardShouldPersistTaps="handled">
                    {/* Flat children (header rows + item rows) so each item's
                        onLayout y is content-relative → scroll-to-current works. */}
                    {sdrGroups.flatMap((g) => {
                      const isCurrentSdr = g.items.some((it) => it.id === activeProfileId);
                      return [
                        <View key={'h:' + g.sid} style={styles.sdrHeadRow}>
                          <Text style={styles.sdrHeadText} numberOfLines={1}>{g.sdrName}</Text>
                          {isCurrentSdr && <Text style={[styles.sdrBadge, styles.sdrBadgeCurrent]}>CURRENT</Text>}
                          {g.inUse && !isCurrentSdr && <Text style={[styles.sdrBadge, styles.sdrBadgeInUse]}>IN USE</Text>}
                        </View>,
                        ...g.items.map((it) => {
                          const active = it.id === activeProfileId;          // our own pick (green)
                          const serverActive = it.id === g.activeProfileId;  // tuned on the server (amber)
                          return (
                            <TouchableOpacity
                              key={it.id}
                              style={[styles.profileDropItemSub, serverActive && !active && styles.profileItemInUse]}
                              onLayout={e => { profY.current[it.id] = e.nativeEvent.layout.y; }}
                              onPress={() => { onSelectProfile?.(it.id); setProfileOpen(false); }}
                              activeOpacity={0.7}>
                              <Text style={[styles.profileDropItemText,
                                            serverActive && !active && styles.profileTextInUse,
                                            active && styles.profileChipTextActive]} numberOfLines={1}>
                                {active ? '✓ ' : serverActive ? '● ' : ''}{it.label}
                                {serverActive && !active ? '  (in use)' : ''}
                              </Text>
                            </TouchableOpacity>
                          );
                        }),
                      ];
                    })}
                  </ScrollView>
                )}
              </View>
            </>)}

            {/* ── DAB PROGRAMME (OWRX — only when a DAB ensemble is tuned) ── */}
            {dabProgrammes.length > 0 && (<>
              <SectionLabel label="DAB PROGRAMME" />
              <View style={styles.profileDrop}>
                <TouchableOpacity style={styles.profileDropHead} onPress={() => setDabOpen((o) => !o)} activeOpacity={0.7}>
                  <Text style={styles.profileDropHeadText} numberOfLines={1}>
                    {dabProgrammes.find((p) => p.id === activeDabId)?.name ?? 'Select programme'}
                  </Text>
                  <Text style={styles.profileDropChevron}>{dabOpen ? '▴' : '▾'}</Text>
                </TouchableOpacity>
                {dabOpen && (
                  <ScrollView ref={dabScroll} style={styles.profileDropList} nestedScrollEnabled
                              keyboardShouldPersistTaps="handled">
                    {dabProgrammes.map((p) => {
                      const active = p.id === activeDabId;
                      return (
                        <TouchableOpacity
                          key={p.id}
                          style={styles.profileDropItem}
                          onLayout={e => { dabY.current[String(p.id)] = e.nativeEvent.layout.y; }}
                          onPress={() => { onSelectDab?.(p.id); setDabOpen(false); }}
                          activeOpacity={0.7}>
                          <Text style={[styles.profileDropItemText, active && styles.profileChipTextActive]} numberOfLines={1}>
                            {active ? '✓ ' : ''}{p.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
              {/* DAB speed correction — works around the dablin/OWRX chipmunk
                  (UK DAB+ stations whose sample rate is misread). Presets match
                  the common rate misreads; the user picks what sounds right. */}
              <Text style={styles.dabSpeedLabel}>Speed fix · remembered per station</Text>
              <View style={styles.dabSpeedRow}>
                {[
                  { v: 1,       l: 'Off' },
                  { v: 0.6667,  l: '×0.67' },
                  { v: 0.5,     l: '×0.50' },
                  { v: 0.3333,  l: '×0.33' },
                  { v: 0.25,    l: '×0.25' },
                ].map((o) => {
                  const active = Math.abs((dabSpeed ?? 1) - o.v) < 0.001;
                  return (
                    <TouchableOpacity
                      key={o.l}
                      style={[styles.dabSpeedChip, active && styles.dabSpeedChipActive]}
                      onPress={() => onDabSpeed?.(o.v)}
                      activeOpacity={0.7}>
                      <Text style={[styles.dabSpeedChipText, active && styles.profileChipTextActive]}>{o.l}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>)}

            {/* ── NEARBY STATION ─────────────────────────────────── */}
            <SectionLabel label="NEARBY STATION" first={profiles.length === 0 && dabProgrammes.length === 0} />
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

            {/* Search bookmarks & band plan — tap a result to tune */}
            <View style={styles.searchWrap}>
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="🔍 Search bookmarks & band plan…"
                placeholderTextColor="rgba(255,255,255,0.40)"
                autoCorrect={false}
                autoCapitalize="none"
                spellCheck={false}
                clearButtonMode="while-editing"
              />
              {searchQuery.trim().length > 0 && (
                <View style={styles.searchDrop}>
                  {searchResults.length === 0 ? (
                    <Text style={styles.searchMsg}>No results for “{searchQuery.trim()}”</Text>
                  ) : (<>
                    <Text style={styles.searchHint}>
                      {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} · tap to tune
                    </Text>
                    <ScrollView style={styles.searchScroll} nestedScrollEnabled
                      keyboardShouldPersistTaps="handled"
                      showsVerticalScrollIndicator={true}>
                    {searchResults.map((r: SearchResult, i: number) => (
                      <TouchableOpacity
                        key={i}
                        style={styles.searchRow}
                        activeOpacity={0.7}
                        onPress={() => {
                          setSearchQuery('');
                          if (r.isBand && r.band) onSearchTune?.(r.band.start, r.band.mode, true);
                          else if (r.bm) onSearchTune?.(r.bm.frequency, r.bm.mode);
                        }}
                      >
                        <Text style={styles.searchFreq}>
                          {r.isBand && r.band ? fmtRange(r.band.start, r.band.end) : fmtFreq(r.bm?.frequency ?? 0)}
                        </Text>
                        <Text style={styles.searchMode}>
                          {r.isBand ? grpAbbr(r.band?.group) : (r.bm?.mode ?? '—').toUpperCase()}
                        </Text>
                        <Text style={styles.searchName} numberOfLines={1}>
                          {r.isBand ? (r.band?.label ?? '') : (r.bm?.name ?? '')}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    </ScrollView>
                  </>)}
                </View>
              )}
            </View>

            {/* User bookmarks pane opener */}
            <BtnRow>
              <Btn label={`★ BOOKMARKS (${userBookmarks.length})`} full
                   onPress={() => setBookmarksOpen(true)} />
            </BtnRow>

            {/* ── SPECTRUM / WATERFALL ───────────────────────────── */}
            <SectionLabel label="SPECTRUM / WATERFALL" />
            <BtnRow>
              <Btn label="− ZOOM" onPress={onZoomOut} />
              <Btn label="+ ZOOM" onPress={onZoomIn} />
              <Btn label="⌖ VFO"  onPress={onCentreVfo} />
              <Btn label="MIN"    onPress={() => { onDbMin(-130); onDbMax(-40); }} />
              <Btn label="MAX"    onPress={() => { onDbMin(-120); onDbMax(-20); }} />
            </BtnRow>
            <BtnRow>
              <Btn label="☀ DISPLAY SETTINGS" full active={dispSettingsOpen}
                onPress={() => setDispSettingsOpen((p: boolean) => !p)} />
            </BtnRow>
            <BtnRow>
              <Btn label="▼ HIDE CONTROLS" full onPress={onHideControls} />
            </BtnRow>
            </>)}

            {/* ── BOOKMARKS pane — replaces the menu (display-settings
                   pattern). Add current tune / list / delete / export-import
                   in the desktop-UberSDR JSON format. ── */}
            {bookmarksOpen && (
              <View style={styles.subPanel}>
                <TouchableOpacity style={styles.backRow}
                  onPress={() => setBookmarksOpen(false)} activeOpacity={0.7}>
                  <Text style={styles.backRowChevron}>‹  BACK</Text>
                  <Text style={styles.backRowTitle}>BOOKMARKS</Text>
                </TouchableOpacity>

                {/* Add current tune */}
                <SubLabel label={`Add: ${(currentFreq / 1_000_000).toFixed(4)} MHz ${currentMode.toUpperCase()}`} />
                <TextInput
                  style={styles.searchInput}
                  value={bmName}
                  onChangeText={setBmName}
                  placeholder="Bookmark name…"
                  placeholderTextColor="rgba(255,255,255,0.40)"
                  autoCorrect={false}
                  maxLength={60}
                />
                <OptRow>
                  <SegBtn label="THIS INSTANCE" active={!bmAll} onPress={() => setBmAll(false)} />
                  <SegBtn label="ALL INSTANCES" active={bmAll}  onPress={() => setBmAll(true)} />
                </OptRow>
                <BtnRow>
                  <Btn label="★ SAVE BOOKMARK" full
                       onPress={() => {
                         if (!bmName.trim()) return;
                         onAddBookmark?.(bmName, bmAll);
                         setBmName('');
                       }} />
                </BtnRow>

                {/* Saved list — tap to tune, ✕ deletes. Scope colour-coded:
                    cyan = all instances, gold = this instance only. */}
                <SubLabel label={`Saved (${userBookmarks.length})`} />
                <View style={styles.bmKey}>
                  <View style={[styles.bmKeyDot, { backgroundColor: BM_GLOBAL_C }]} />
                  <Text style={styles.bmKeyTxt}>All instances</Text>
                  <View style={[styles.bmKeyDot, { backgroundColor: BM_LOCAL_C }]} />
                  <Text style={styles.bmKeyTxt}>This instance</Text>
                </View>
                {userBookmarks.length === 0 && (
                  <Text style={styles.bmEmpty}>No bookmarks yet — tune somewhere good and save it.</Text>
                )}
                {userBookmarks.map((b: UserBookmark, i: number) => (
                  <View key={`${b.name}|${b.frequency}|${i}`} style={styles.bmRow}>
                    <View style={[styles.bmKeyDot, { backgroundColor: b.scope ? BM_LOCAL_C : BM_GLOBAL_C }]} />
                    <TouchableOpacity style={styles.bmTune} activeOpacity={0.7}
                      onPress={() => onSearchTune?.(b.frequency, b.mode)}>
                      <Text style={[styles.bmName, { color: b.scope ? BM_LOCAL_C : BM_GLOBAL_C }]}
                        numberOfLines={1}>
                        {b.name}
                      </Text>
                      <Text style={styles.bmFreq}>
                        {fmtFreq(b.frequency)}  {b.mode.toUpperCase()}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity hitSlop={8} onPress={() => onDeleteBookmark?.(b)}>
                      <Text style={styles.bmDel}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Export / import — desktop-UberSDR-compatible JSON */}
                <SubLabel label="Transfer" />
                <BtnRow>
                  <Btn label="⇧ EXPORT JSON" onPress={onExportBookmarks} />
                  <Btn label="⇩ IMPORT" active={bmImportOpen}
                       onPress={() => { setBmImportOpen((p: boolean) => !p); setBmImportMsg(''); }} />
                </BtnRow>
                {bmImportOpen && (<>
                  <TextInput
                    style={[styles.searchInput, styles.bmImportBox]}
                    value={bmImportText}
                    onChangeText={setBmImportText}
                    placeholder="Paste UberSDR bookmarks JSON here…"
                    placeholderTextColor="rgba(255,255,255,0.40)"
                    autoCorrect={false}
                    autoCapitalize="none"
                    multiline
                  />
                  <BtnRow>
                    <Btn label="CONFIRM IMPORT" full
                         onPress={() => {
                           const msg = onImportBookmarks?.(bmImportText, bmAll) ?? '';
                           setBmImportMsg(msg);
                           if (msg.startsWith('Imported')) setBmImportText('');
                         }} />
                  </BtnRow>
                  {!!bmImportMsg && <Text style={styles.bmImportMsg}>{bmImportMsg}</Text>}
                </>)}
                <View style={{ height: 24 }} />
              </View>
            )}

            {dispSettingsOpen && (
              <View style={styles.subPanel}>

                {/* Back header — this panel replaces the main menu */}
                <TouchableOpacity style={styles.backRow}
                  onPress={() => setDispSettingsOpen(false)} activeOpacity={0.7}>
                  <Text style={styles.backRowChevron}>‹  BACK</Text>
                  <Text style={styles.backRowTitle}>DISPLAY SETTINGS</Text>
                </TouchableOpacity>

                {/* Save row */}
                <BtnRow>
                  <Btn label="↺ RESET"       onPress={onDispReset} />
                  <Btn label="💾 THIS SERVER" onPress={onDispSaveServer} />
                  <Btn label="🌐 GLOBAL"      onPress={onDispSaveGlobal} />
                </BtnRow>

                {/* Layout — spectrum/waterfall ratio */}
                <SubLabel label="Layout" />
                <BtnRow>
                  <Btn label="📐 SPECTRUM / WATERFALL RATIO" full
                    onPress={() => onSpecRatio?.()} />
                </BtnRow>

                {/* Colour Map — dropdown over the FULL palette list. (The old
                    pill strip hardcoded names like 'sonar'/'green' that never
                    existed in the tables → silent gqrx fallback.) */}
                <SubLabel label="Colour Map" />
                <TouchableOpacity style={styles.dropHeader}
                  onPress={() => setCmapOpen((o: boolean) => !o)} activeOpacity={0.7}>
                  <Text style={styles.dropHeaderText}>
                    {colormap === 'gqrx' ? 'GQRX' : colormap.charAt(0).toUpperCase() + colormap.slice(1)}
                  </Text>
                  <Text style={styles.dropChevron}>{cmapOpen ? '▴' : '▾'}</Text>
                </TouchableOpacity>
                {cmapOpen && (
                  <ScrollView ref={cmapScroll} style={styles.dropList} nestedScrollEnabled
                              keyboardShouldPersistTaps="handled">
                    {cmapSorted.map(name => (
                      <TouchableOpacity key={name}
                        style={[styles.dropItem, name === colormap && styles.dropItemActive]}
                        onLayout={e => { cmapY.current[name] = e.nativeEvent.layout.y; }}
                        onPress={() => { onColormap(name); setCmapOpen(false); }}
                        activeOpacity={0.7}>
                        <Text style={[styles.dropItemText, name === colormap && styles.dropItemTextActive]}>
                          {name === 'gqrx' ? 'GQRX' : name.charAt(0).toUpperCase() + name.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                )}

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

                {/* VFO Intensity — needle + glow brightness; bright palettes
                    can swallow the needle whatever colour it is */}
                <View style={styles.bwRow}>
                  <Text style={styles.bwLabel}>VFO GLOW</Text>
                  <Slider style={styles.bwSlider}
                    minimumValue={1} maximumValue={10} step={1}
                    value={vfoIntensity}
                    onValueChange={(v: number) => onVfoIntensity?.(v)}
                    minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted}
                    thumbTintColor={C.gold} />
                  <Text style={styles.bwVal}>{vfoIntensity}</Text>
                </View>

                {/* Frosted backing — dims the waterfall across the passband
                    so the needle keeps contrast on bright palettes */}
                <View style={styles.bwRow}>
                  <Text style={styles.bwLabel}>VFO FROST</Text>
                  <Slider style={styles.bwSlider}
                    minimumValue={0} maximumValue={10} step={1}
                    value={vfoFrost}
                    onValueChange={(v: number) => onVfoFrost?.(v)}
                    minimumTrackTintColor={vfoFrost > 0 ? C.gold : C.muted}
                    maximumTrackTintColor={C.muted}
                    thumbTintColor={C.gold} />
                  <Text style={styles.bwVal}>{vfoFrost === 0 ? 'Off' : vfoFrost}</Text>
                </View>

                {/* Instance spectrum backdrop — only shown when the server
                    actually serves one (/api/spectrum-bg-image) */}
                {hasBgImage && (
                  <View style={styles.bwRow}>
                    <Text style={styles.bwLabel}>BACKDROP</Text>
                    <Slider style={styles.bwSlider}
                      minimumValue={0} maximumValue={10} step={1}
                      value={bgOpacity}
                      onValueChange={(v: number) => onBgOpacity?.(v)}
                      minimumTrackTintColor={bgOpacity > 0 ? C.gold : C.muted}
                      maximumTrackTintColor={C.muted}
                      thumbTintColor={C.gold} />
                    <Text style={styles.bwVal}>{bgOpacity === 0 ? 'Off' : bgOpacity}</Text>
                  </View>
                )}

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
                {wfCoarse === 'manual' && (
                  <>
                    {/* Manual dB window — floor/ceiling kept ≥5dB apart */}
                    <View style={styles.sliderWrap}>
                      <Text style={styles.sliderLabel}>Floor</Text>
                      <Slider style={{flex:1}} minimumValue={-160} maximumValue={-60} step={1}
                        value={Math.min(dbMin, dbMax - 5)}
                        onValueChange={(v: number) => onDbMin?.(Math.min(v, dbMax - 5))}
                        minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                      <Text style={styles.sliderVal}>{dbMin} dB</Text>
                    </View>
                    <View style={styles.sliderWrap}>
                      <Text style={styles.sliderLabel}>Ceiling</Text>
                      <Slider style={{flex:1}} minimumValue={-100} maximumValue={0} step={1}
                        value={Math.max(dbMax, dbMin + 5)}
                        onValueChange={(v: number) => onDbMax?.(Math.max(v, dbMin + 5))}
                        minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted} thumbTintColor={C.gold} />
                      <Text style={styles.sliderVal}>{dbMax} dB</Text>
                    </View>
                  </>
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
                {/* NATIVE = data rate (~10 lines/s, discrete rows); 20/30 =
                    temporally interpolated 2×/3× line rate. Smooth-tune boost
                    overrides to panel-native refresh while touching. */}
                <BtnRow>
                  <Btn label="NATIVE" active={frameRate==='native'} onPress={() => onFrameRate?.('native')} />
                  <Btn label="20fps"  active={frameRate==='20fps'}  onPress={() => onFrameRate?.('20fps')} />
                  <Btn label="30fps"  active={frameRate==='30fps'}  onPress={() => onFrameRate?.('30fps')} />
                </BtnRow>

                {/* Power saving — SMOOTH TUNE: 120Hz only while interacting,
                    discrete rows + eased spectrum when settled. IDLE SAVER:
                    ⅓ server frame rate after 30s without touch. */}
                <SubLabel label="Power Saving" />
                <BtnRow>
                  <Btn label="SMOOTH TUNE" active={smoothTune} onPress={() => onSmoothTune?.(!smoothTune)} />
                  <Btn label="IDLE SAVER"  active={idleSlow}   onPress={() => onIdleSlow?.(!idleSlow)} />
                </BtnRow>

              </View>
            )}

            {!dispSettingsOpen && !bookmarksOpen && (<>

            {/* ── AUDIO ──────────────────────────────────────────── */}
            <SectionLabel label="AUDIO" />
            {/* Bandwidth — mirrored sliders around the carrier: slide the LEFT
                one LEFT to widen the lower sideband, the RIGHT one RIGHT to
                widen the upper. SYNC mirrors both edges (AM/FM symmetric). */}
            <View style={styles.bwMirrorRow}>
              <Text style={styles.bwEdgeVal}>{filterLow >= 0 ? '+' : '−'}{fmtHz(Math.abs(filterLow))}</Text>
              <Slider style={styles.bwHalfSlider}
                minimumValue={-bwEdgeMax} maximumValue={0} step={bwStep}
                value={Math.max(-bwEdgeMax, Math.min(0, filterLow))}
                onValueChange={(v: number) => {
                  if (bwSync) onFilterBoth?.(v, -v);
                  else        onFilterBoth?.(v, filterHigh);
                }}
                minimumTrackTintColor={C.muted} maximumTrackTintColor={C.gold}
                thumbTintColor={C.gold} />
              <TouchableOpacity hitSlop={6}
                style={[styles.btn, bwSync && styles.btnActive]}
                onPress={() => setBwSync((p: boolean) => !p)} activeOpacity={0.7}>
                <Text style={[styles.btnText, bwSync && styles.btnTextActive]}>SYNC</Text>
              </TouchableOpacity>
              <Slider style={styles.bwHalfSlider}
                minimumValue={0} maximumValue={bwEdgeMax} step={bwStep}
                value={Math.min(bwEdgeMax, Math.max(0, filterHigh))}
                onValueChange={(v: number) => {
                  if (bwSync) onFilterBoth?.(-v, v);
                  else        onFilterBoth?.(filterLow, v);
                }}
                minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted}
                thumbTintColor={C.gold} />
              <Text style={styles.bwEdgeVal}>{filterHigh < 0 ? '−' : '+'}{fmtHz(Math.abs(filterHigh))}</Text>
            </View>

            {/* NR/NB are UberSDR client-side DSP — hidden for OWRX (its NR is a
                server slider, below). REC stays for both. */}
            <BtnRow>
              {!isOwrx && (
                <Btn
                  label={nrMode === 'serv' ? 'SERV' : nrMode === 'nr2' ? 'NR2' : 'NR'}
                  active={nrMode !== 'off'}
                  style={nrMode === 'serv' ? { borderColor: 'rgba(50,210,100,0.60)', backgroundColor: 'rgba(50,210,100,0.10)' } : undefined}
                  onPress={cycleNr}
                />
              )}
              {!isOwrx && <Btn label="NB" active={nb} onPress={() => onNb?.(!nb)} />}
              <Btn label="⏺ REC"  active={recording} onPress={onRec} />
            </BtnRow>
            {recording && (
              <View style={styles.recTimer}>
                <View style={styles.recDot} />
                <Text style={styles.recTime}>{fmtRecTime(recSeconds)}</Text>
              </View>
            )}

            {/* OWRX squelch (dB) + NR (threshold dB) — server-side. Squelch left =
                Off (open); NR left = Off, slides up for more reduction. */}
            {isOwrx && (<>
              <View style={styles.bwRow}>
                <Text style={styles.bwLabel}>SQUELCH</Text>
                <Slider style={styles.bwSlider}
                  minimumValue={-130} maximumValue={-20} step={1}
                  value={owrxSql <= -130 ? -130 : owrxSql}
                  onValueChange={(v: number) => { const db = v <= -130 ? -150 : v; setOwrxSql(db); onOwrxSquelch?.(db); }}
                  minimumTrackTintColor={owrxSql > -130 ? C.gold : C.muted}
                  maximumTrackTintColor={C.muted}
                  thumbTintColor={C.gold} />
                <Text style={styles.bwVal}>{owrxSql <= -130 ? 'Off' : `${owrxSql}dB`}</Text>
              </View>
              <View style={styles.bwRow}>
                <Text style={styles.bwLabel}>NR</Text>
                <Slider style={styles.bwSlider}
                  minimumValue={0} maximumValue={30} step={1}
                  value={owrxNr}
                  onValueChange={(v: number) => { setOwrxNr(v); onOwrxNr?.(v); }}
                  minimumTrackTintColor={owrxNr > 0 ? C.gold : C.muted}
                  maximumTrackTintColor={C.muted}
                  thumbTintColor={C.gold} />
                <Text style={styles.bwVal}>{owrxNr <= 0 ? 'Off' : `${owrxNr}dB`}</Text>
              </View>
            </>)}

            {/* SNR Squelch — UberSDR audio gate. Slider 0–50 dB in OUR meter's
                units (SDRScreen shifts +30 for the server's raw SNR scale). */}
            {!isOwrx && (
            <View style={styles.bwRow}>
              <Text style={styles.bwLabel}>SNR SQL</Text>
              <Slider style={styles.bwSlider}
                minimumValue={0} maximumValue={50} step={0.5}
                value={Math.max(0, snrSquelch === -999 ? 0 : snrSquelch)}
                onValueChange={(v: number) => onSnrSquelch?.(v <= 0.1 ? -999 : v)}
                minimumTrackTintColor={snrSquelch > 0 ? C.gold : C.muted}
                maximumTrackTintColor={C.muted}
                thumbTintColor={C.gold} />
              <Text style={styles.bwVal}>{snrSquelch <= -999 ? 'Off' : `≥${snrSquelch.toFixed(0)}`}</Text>
            </View>
            )}

            {/* FM Squelch — only shown for fm/nfm. Currently feature-flagged off in UberSDR. */}
            {!isOwrx && isFmMode && (
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

            {/* ── SERVER SIDE NR (DSP insert) — section appears only when the
                   server advertises filters (get_dsp_filters → dsp_filters);
                   type selector + per-filter param sliders only while active,
                   to keep the menu clutter-free. ── */}
            {dspFilters.length > 0 && (<>
            <SectionLabel label="SERVER SIDE NR" />
            <BtnRow>
              <Btn
                label={serverDspEnabled ? 'DISABLE SERVER NR' : 'ENABLE SERVER NR'}
                active={serverDspEnabled}
                full
                style={serverDspEnabled ? { borderColor: 'rgba(50,210,100,0.50)', backgroundColor: 'rgba(50,210,100,0.10)' } : undefined}
                onPress={() => onServerDsp?.(!serverDspEnabled)}
              />
            </BtnRow>
            {dspError != null && (
              <Text style={styles.dspError}>{dspError}</Text>
            )}
            {serverDspEnabled && (
              <View style={styles.subPanel}>
                <SubLabel label="DSP TYPE" />
                <OptRow>
                  {dspFilters.map((f: DspFilterDesc) => (
                    <SegBtn key={f.name} label={f.name.toUpperCase()}
                            active={serverDspFilter === f.name}
                            onPress={() => onServerDspFilter?.(f.name)} />
                  ))}
                </OptRow>
                {(dspFilters.find((f: DspFilterDesc) => f.name === serverDspFilter)?.params ?? [])
                  .filter((p: DspParamDesc) => p.runtime_safe !== false)
                  .map((p: DspParamDesc) => {
                    const val = serverDspParams[p.name] ?? p.default ?? '';
                    if ((p.type ?? 'float').toLowerCase() === 'bool') {
                      return (
                        <BtnRow key={p.name}>
                          <Btn label={fmtParamName(p.name)} active={val === 'true'} full
                               onPress={() => onServerDspParam?.(p.name, val === 'true' ? 'false' : 'true')} />
                        </BtnRow>
                      );
                    }
                    const min = parseFloat(p.min ?? ''), max = parseFloat(p.max ?? '');
                    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
                      return null;  // free-text params: not editable on mobile
                    }
                    const step = dspStep(min, max);
                    const num  = Number.isFinite(parseFloat(val)) ? parseFloat(val) : min;
                    return (
                      <View key={p.name} style={styles.bwRow}>
                        <Text style={styles.bwLabel} numberOfLines={1}>{fmtParamName(p.name)}</Text>
                        <Slider style={styles.bwSlider}
                          minimumValue={min} maximumValue={max} step={step}
                          value={Math.max(min, Math.min(max, num))}
                          onValueChange={(v: number) => onServerDspParam?.(p.name, fmtDspVal(v, step))}
                          minimumTrackTintColor={C.gold} maximumTrackTintColor={C.muted}
                          thumbTintColor={C.gold} />
                        <Text style={styles.bwVal}>{fmtDspVal(num, step)}</Text>
                      </View>
                    );
                  })}
              </View>
            )}
            </>)}

            {/* ── SERVER MAPS — UberSDR's per-feed Leaflet overlays (skin parity).
                   OWRX has its own combined map (opened from the OPENWEBRX section
                   below), so these UberSDR-specific feeds are hidden for it. ── */}
            {serverType !== 'owrx' && (<>
              <SectionLabel label="SERVER MAPS" />
              <BtnRow>
                <Btn label="✈ HFDL"     onPress={() => onServerMap?.('hfdl')} />
                <Btn label="📡 DIGITAL"  onPress={() => onServerMap?.('digi')} />
                <Btn label="⊟ CW"       onPress={() => onServerMap?.('cw')} />
              </BtnRow>
            </>)}

            {/* ── CLIENT DECODERS — skin: toggle start/stop, menu stays open;
                   settings for the selected mode appear underneath.
                   Landscape: hidden — the decoder panel needs vertical space
                   that landscape (esp. SE-class screens) doesn't have. Maps
                   stay available; rotate to portrait for decoders.
                   OWRX decodes server-side (results stream back), so the
                   client-side decoders + UberSDR spot feeds are hidden for it —
                   replaced by the OPENWEBRX map/files/admin below (Phase 1). ── */}
            {!isLandscape && serverType !== 'owrx' && (<>
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
            </>)}

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
            {/* DISPLAY STYLE row removed — accessibility skin (white/Atkinson)
                is the single style now; amber/Nixie dropped for readability. */}
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>DRUMS</Text>
              <BtnRow>
                <Btn label="NORMAL"    active={drumMode==='normal'}  onPress={() => onDrumMode?.('normal')} />
                <Btn label="PRECISE"   active={drumMode==='precise'} onPress={() => onDrumMode?.('precise')} />
                <Btn label="✦ HAPTICS" active={hapticsEnabled}       onPress={() => onHaptics?.(!hapticsEnabled)} />
              </BtnRow>
            </View>
            {/* Lock-screen / car-stereo skip buttons: tune by step, or jump
                bookmarks like the VTS arrows */}
            <View style={styles.ctrlRow}>
              <Text style={styles.ctrlLabel}>MEDIA ⏮⏭</Text>
              <BtnRow>
                <Btn label="TUNE STEP" active={mediaSkip==='step'}
                     onPress={() => onMediaSkip?.('step')} />
                <Btn label="BOOKMARK SKIP" active={mediaSkip==='bookmark'}
                     onPress={() => onMediaSkip?.('bookmark')} />
              </BtnRow>
            </View>

            {/* ── SERVER PAGES — in-app browser view. OWRX bundles map + files
                   gallery (SSTV/WEFAX/Navtex images) + settings, so we link those
                   rather than UberSDR's noise/conditions/listeners pages. ──── */}
            {serverType === 'owrx' ? (<>
              <SectionLabel label="OPENWEBRX" />
              <BtnRow>
                <Btn label="🗺 MAP"   onPress={() => onAdminLink?.('/map', 'Map')} />
                <Btn label="🖼 FILES" onPress={() => onAdminLink?.('/files', 'Files')} />
              </BtnRow>
              <BtnRow>
                <Btn label="⚙ ADMIN" full onPress={() => onAdminLink?.('/settings', 'Settings')} />
              </BtnRow>
            </>) : (<>
              <SectionLabel label="INSTANCE ADMIN" />
              <BtnRow>
                <Btn label="ADMIN"      onPress={() => onAdminLink?.('/admin.html', 'Admin')} />
                <Btn label="NOISE"      onPress={() => onAdminLink?.('/noisefloor.html', 'Noise Floor')} />
              </BtnRow>
              <BtnRow>
                <Btn label="CONDITIONS" onPress={() => onAdminLink?.('/bandconditions.html', 'Band Conditions')} />
                <Btn label="LISTENERS"  onPress={() => onAdminLink?.('/session_stats.html', 'Listeners')} />
              </BtnRow>
            </>)}

            {/* ── INSTANCE ───────────────────────────────────────── */}
            <SectionLabel label="INSTANCE" />
            <Text style={styles.instanceUrl} numberOfLines={1}>{serverName || serverUrl}</Text>
            <BtnRow>
              <Btn label={isDefaultInstance ? '★ CLEAR DEFAULT' : '☆ SET DEFAULT'}
                   active={isDefaultInstance} onPress={onSetDefault} />
            </BtnRow>
            <BtnRow>
              <Btn label="← BACK TO INSTANCE LIST" full onPress={onBack ?? onClose} />
            </BtnRow>
            <BtnRow col>
              <Btn label="↺ RESET INTERFACE SETTINGS" full danger onPress={onResetSettings} />
            </BtnRow>

            {/* ── Footer — app version | server type + version. The logo
                identifies WHICH backend this instance runs (UberSDR today;
                KiwiSDR/OpenWebRX later), so it's keyed by server type. ── */}
            <View style={styles.footerRow}>
              <TouchableOpacity onPress={onAbout} hitSlop={8}>
                <Text style={styles.footerBrand}>VibeSDR v{APP_VERSION}</Text>
                <Text style={styles.footerAboutHint}>ABOUT</Text>
              </TouchableOpacity>
              <View style={styles.footerServer}>
                <Image source={SERVER_LOGOS[serverType] ?? SERVER_LOGOS.ubersdr} style={styles.footerLogo} resizeMode="contain" />
                <View>
                  <Text style={styles.footerServerName}>{serverLabel ?? (isOwrx ? 'OpenWebRX' : 'UberSDR')}</Text>
                  {serverVersion ? (
                    <Text style={styles.footerServerVer}>v{serverVersion}</Text>
                  ) : null}
                </View>
              </View>
            </View>

            <View style={{ height: 24 }} />
            </>)}
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
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider,
    paddingTop: 12, paddingBottom: 6, marginTop: 6,
  },
  sectionBarFirst: { borderTopWidth: 0, marginTop: 2 },
  sectionLabel: {
    color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 12,
    fontWeight: 'bold', letterSpacing: 2,
  },

  footerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.divider,
    marginTop: 14, paddingTop: 14, paddingHorizontal: 2,
  },
  footerBrand: {
    color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 15,
    fontWeight: 'bold', letterSpacing: 1.5,
  },
  footerAboutHint: {
    color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 10,
    letterSpacing: 2, marginTop: 1,
  },
  footerServer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footerLogo:   { width: 30, height: 30 },
  footerServerName: {
    color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 13,
    fontWeight: 'bold', letterSpacing: 1, textAlign: 'right',
  },
  footerServerVer: {
    color: C.sliderLabel, fontFamily: 'Atkinson Hyperlegible', fontSize: 11,
    letterSpacing: 1, textAlign: 'right', marginTop: 1,
  },

  btnRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 4 },
  btnRowCol: { flexDirection: 'column', gap: 6 },
  optRow:    { paddingTop: 2, paddingBottom: 0 },

  // a11y .lsv-mp-btn: 15px text, 11×16 padding
  btn: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 5, paddingHorizontal: 16, paddingVertical: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  btnActive:     { backgroundColor: C.active, borderColor: C.goldDim },
  btnSelected:   { borderColor: C.goldDim }, // selected but not running (skin)
  btnDanger:     { backgroundColor: C.danger, borderColor: C.dangerBorder },
  btnFull:       { flex: 1, alignSelf: 'stretch' },
  // Colour map dropdown
  dropHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, paddingHorizontal: 12, paddingVertical: 9, marginVertical: 4,
  },
  dropHeaderText: { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 15, fontWeight: 'bold', letterSpacing: 0.5 },
  dropChevron:    { color: C.muted, fontSize: 10 },
  dropList: {
    borderWidth: 1, borderColor: C.border, borderRadius: 4, maxHeight: 240,
    marginBottom: 6, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.25)',
  },
  dropItem: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  dropItemActive:     { backgroundColor: C.active },
  dropItemText:       { color: C.muted, fontFamily: 'Atkinson Hyperlegible', fontSize: 15, letterSpacing: 0.5 },
  dropItemTextActive: { color: C.gold, fontWeight: 'bold' },

  btnText:       { color: C.muted, fontFamily: 'Atkinson Hyperlegible', fontSize: 15, fontWeight: 'bold', letterSpacing: 0.5 },
  btnTextActive: { color: C.gold },
  btnTextDanger: { color: '#ff6666' },

  profileDrop: { paddingVertical: 6 },
  profileDropHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.btnBg,
  },
  profileDropHeadText: { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14, flex: 1 },
  profileDropChevron: { color: C.muted, fontSize: 14, marginLeft: 8 },
  profileDropList: {
    marginTop: 4, borderRadius: 8, borderWidth: 1, borderColor: C.border, maxHeight: 300,
    backgroundColor: C.btnBg, overflow: 'hidden',
  },
  profileDropItem: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.divider },
  profileDropItemSub: { paddingLeft: 22, paddingRight: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.divider },
  profileDropItemText: { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14 },
  profileChipTextActive: { color: C.gold },
  profileItemInUse: { backgroundColor: 'rgba(255,184,77,0.10)' },
  profileTextInUse: { color: '#ffb84d' },
  sdrHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 11, paddingBottom: 6, backgroundColor: 'rgba(255,255,255,0.04)' },
  sdrHeadText: { flexShrink: 1, color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  sdrBadge: { fontFamily: 'Atkinson Hyperlegible', fontSize: 9, fontWeight: '700', letterSpacing: 0.5, overflow: 'hidden', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 2, color: '#0a0a0a' },
  sdrBadgeInUse: { backgroundColor: '#ffb84d' },     // amber — busy, switching may disturb
  sdrBadgeCurrent: { backgroundColor: '#52dc64' },   // green — this is where you are
  etiquette: { marginBottom: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,184,77,0.45)', backgroundColor: 'rgba(255,184,77,0.10)' },
  etiquetteText: { color: 'rgba(255,225,180,0.92)', fontFamily: 'Atkinson Hyperlegible', fontSize: 11.5, lineHeight: 16 },
  etiquetteLead: { color: '#ffb84d', fontWeight: '700' },
  dabSpeedLabel: { color: C.muted, fontFamily: 'Atkinson Hyperlegible', fontSize: 11, marginTop: 8, marginBottom: 4 },
  dabSpeedRow: { flexDirection: 'row', gap: 8 },
  dabSpeedChip: {
    flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.btnBg,
  },
  dabSpeedChipActive: { borderColor: C.active },
  dabSpeedChipText: { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 13 },
  vtsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  vtsArrow: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, paddingHorizontal: 14, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  vtsArrowText: { color: C.gold, fontSize: 18 },
  vtsInfo:  { flex: 1, alignItems: 'center', gap: 3 },
  vtsName:  { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14, letterSpacing: 1 },
  vtsFreq:  { color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 11, letterSpacing: 1 },
  searchWrap: { paddingTop: 6, paddingBottom: 2 },
  bmEmpty: {
    color: 'rgba(255,255,255,0.45)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 12, paddingVertical: 6,
  },
  bmRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  bmTune: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  bmName: { flexShrink: 1, color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14 },
  bmKey: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingBottom: 6,
  },
  bmKeyDot: { width: 9, height: 9, borderRadius: 4.5, flexShrink: 0 },
  bmKeyTxt: {
    color: 'rgba(255,255,255,0.55)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 11, marginRight: 10,
  },
  bmFreq: { flexShrink: 0, color: '#ffe566', fontFamily: 'Atkinson Hyperlegible', fontSize: 12 },
  bmDel:  { color: 'rgba(220,80,80,0.85)', fontSize: 16, paddingHorizontal: 6 },
  bmImportBox: { minHeight: 90, textAlignVertical: 'top', marginTop: 4 },
  bmImportMsg: {
    color: 'rgba(120,235,140,0.90)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 12, paddingVertical: 4,
  },
  searchInput: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.30)', borderRadius: 8,
    color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14,
    paddingHorizontal: 12, paddingVertical: 9,
  },
  searchDrop: {
    marginTop: 4, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)',
    borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.45)', overflow: 'hidden',
  },
  searchScroll: { maxHeight: 240 },
  searchHint: {
    color: 'rgba(255,255,255,0.45)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 11, paddingHorizontal: 10, paddingVertical: 6,
  },
  searchMsg: {
    color: 'rgba(255,255,255,0.55)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 13, paddingHorizontal: 10, paddingVertical: 10,
  },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.12)',
  },
  searchFreq: {
    color: '#ffe566', fontFamily: 'Atkinson Hyperlegible', fontSize: 12,
    width: 92,
  },
  searchMode: {
    color: 'rgba(255,255,255,0.50)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 11, width: 42,
  },
  searchName: {
    flex: 1, color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 13,
  },

  sliderRow:   { paddingVertical: 4, gap: 4 },
  sliderLabel: { color: C.sliderLabel, fontFamily: 'Atkinson Hyperlegible', fontSize: 13, letterSpacing: 1, width: 90, flexShrink: 0 },
  bwRow:    { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  bwMirrorRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  bwHalfSlider: { flex: 1, height: 32 },
  bwEdgeVal:    { color: C.gold, fontFamily: 'Atkinson Hyperlegible', fontSize: 10, minWidth: 44, textAlign: 'center' },
  bwLabel:  { color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 11, letterSpacing: 1, width: 32 },
  bwSlider: { flex: 1, height: 32 },
  bwVal:    { color: C.gold, fontFamily: 'Atkinson Hyperlegible', fontSize: 11, minWidth: 68, textAlign: 'right' },
  sliderWrap:  { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  sliderVal:   { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 14, minWidth: 72, textAlign: 'right' },

  stepSlider: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  stepSliderBtn: {
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 4, width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  },
  stepSliderBtnTxt: { color: C.gold, fontSize: 18, fontWeight: 'bold', lineHeight: 22 },
  stepSliderVal: { color: C.gold, fontFamily: 'Atkinson Hyperlegible', fontSize: 12, flex: 1, textAlign: 'center' },

  subPanel: {
    backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.divider,
    padding: 10, marginBottom: 4,
  },
  subLabel:      { color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 12, letterSpacing: 1, paddingTop: 8, paddingBottom: 3 },
  subLabelSmall: { fontSize: 10, opacity: 0.5 },

  // Display-settings back header
  backRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border,
    borderRadius: 5, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 8,
  },
  backRowChevron: { color: C.gold, fontFamily: 'Atkinson Hyperlegible', fontSize: 15, fontWeight: 'bold' },
  backRowTitle:   { color: C.text, fontFamily: 'Atkinson Hyperlegible', fontSize: 15, fontWeight: 'bold', letterSpacing: 1 },

  recTimer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  recDot:   { width: 8, height: 8, borderRadius: 4, backgroundColor: '#cc2222' },
  recTime:  { color: C.gold, fontFamily: 'Atkinson Hyperlegible', fontSize: 13 },
  dspError: { color: 'rgba(220,53,69,0.95)', fontFamily: 'Atkinson Hyperlegible', fontSize: 13, paddingBottom: 6 },

  ctrlRow:   { paddingVertical: 4, gap: 4 },
  ctrlLabel: { color: C.sectionC, fontFamily: 'Atkinson Hyperlegible', fontSize: 10, letterSpacing: 1.5 },

  swatchRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingVertical: 4 },
  swatch:     { width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: 'transparent' },
  swatchActive: { borderColor: '#fff' },
  cmapStrip:          { gap: 6, flexDirection: 'row', paddingBottom: 4 },
  cmapPill:           { backgroundColor: C.btnBg, borderWidth: 1, borderColor: C.border, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  cmapPillActive:     { backgroundColor: C.active, borderColor: C.gold },
  cmapPillText:       { color: C.muted, fontFamily: 'Atkinson Hyperlegible', fontSize: 11 },
  cmapPillTextActive: { color: C.gold },

  instanceUrl: { color: 'rgba(255,255,255,0.40)', fontFamily: 'Atkinson Hyperlegible', fontSize: 11, paddingBottom: 4 },

  closeBtn: {
    margin: 12, alignSelf: 'center', backgroundColor: C.btnBg,
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingHorizontal: 24, paddingVertical: 8,
  },
  closeBtnText: { color: C.goldDim, fontFamily: 'Atkinson Hyperlegible', fontSize: 12, fontWeight: 'bold', letterSpacing: 1 },
});
