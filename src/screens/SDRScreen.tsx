/**
 * SDRScreen — main receiver screen for VibeSDR v2.
 *
 * Hierarchy:
 *   SDRScreen
 *   ├── WaterfallView         (GPU Skia waterfall + spectrum, fills full screen)
 *   ├── ControlsBar           (drums, sig-frame, freq/mode pill, step, menu — absolute overlay)
 *   ├── MenuSheet             (slide-up panel)
 *   ├── StepPicker            (bottom-sheet step selector)
 *   ├── ModeSelector          (bottom-sheet demodulator selector)
 *   ├── FreqModal             (numpad frequency entry)
 *   ├── ChatDrawer            (slide-up chat)
 *   ├── DecoderPanel          (floating above pill)
 *   └── AudioPlayer           (renderless; plays Opus stream)
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  ActivityIndicator,
  Dimensions,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake }       from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList }     from '../../App';

import { MODE_BANDWIDTHS, type SDRStatus, type SDRMode } from '../services/UberSDRClient';
import { createBackend } from '../services/UberSDRAdapter';
import { KiwiAdapter } from '../services/KiwiAdapter';
import { localSessionGen } from '../services/localSession';
import { filterEdgeMax, type SDRBackend, type ProfileInfo, type BackendMode, type DabProgramme } from '../services/SDRBackend';
import { DecoderClient, RTTY_PRESETS,
         type RttySettings, type MorseQuality,
         type SpotRow, type SpotsKind,
         type ChatUserRow }                            from '../services/DecoderClient';
import { type DecoderImageHandle }                     from '../components/DecoderImageCanvas';
import { MIN_HZ, MAX_HZ, STEPS, stepsForFreq }         from '../services/sdrTypes';
import { v4 as uuidv4 }                                from 'uuid';
import AsyncStorage                                    from '@react-native-async-storage/async-storage';
import { setDefaultInstance, getDefaultInstance,
         clearDefaultInstance }                        from '../services/defaultInstance';
import { useTheme }                                     from '../contexts/ThemeContext';

import WaterfallView   from '../components/WaterfallView';
import ControlsBar, { createMeterBus } from '../components/ControlsBar';
import { setDrumHaptics } from '../components/DrumWheel';
import MenuSheet, { type DspFilterDesc } from '../components/MenuSheet';
import { useCoachmarkTour, tourRef } from '../components/Coachmark';
import AudioPlayer, { VibePowerModule } from '../components/AudioPlayer';
import LocalAudioPlayer from '../components/LocalAudioPlayer';
import LocalHardwarePanel from '../components/LocalHardwarePanel';
import FreqModal       from '../components/FreqModal';
import ModeSelector    from '../components/ModeSelector';
import StepPicker      from '../components/StepPicker';
import ChatDrawer,
  { type ChatMessage } from '../components/ChatDrawer';
import DecoderPanel,
  { type DecoderType } from '../components/DecoderPanel';
import SpecRatioOverlay  from '../components/SpecRatioOverlay';
import MapOverlay, { type MapKind } from '../components/MapOverlay';
import CityPickerModal from '../components/CityPickerModal';
import BrowserOverlay from '../components/BrowserOverlay';
import AboutOverlay from '../components/AboutOverlay';
import RecordingsOverlay from '../components/RecordingsOverlay';
import VTSBar, { type VtsNotifData } from '../components/VTSBar';
import CenterVfoButton from '../components/CenterVfoButton';
import PasswordModal from '../components/PasswordModal';
import {
  fetchBookmarks, findNearest, findNextBookmark,
  fmtBandFreq, deriveItuRegion, refreshBandSnr, getBandSnrDb, propCondition,
  fetchUiConfig, fetchReceiverInfo,
  VTS_ON_HZ, searchStations, type ServerBookmark, type ServerBand,
  type ServerUiConfig, type ReceiverInfo,
} from '../services/stations';
import {
  loadUserBookmarks, saveUserBookmarks, bookmarksForInstance, withoutInstance,
  exportBookmarksJSON, parseBookmarksAny, mergeBookmarks, type UserBookmark,
} from '../services/userBookmarks';
import { getBandsAtRegion, bandTuneDefaults, BAND_PLAN, type Band } from '../constants/bandPlan';
import { loadActiveEibi } from '../services/eibi';
import { getUserLocation } from '../services/instancesApi';
import { distanceKmToGrid } from '../services/grid';
import { countryForCallsign } from '../services/callsignCountry';
import * as DocumentPicker from 'expo-document-picker';
// SDK 56 moved readAsStringAsync to the legacy entry (new File API otherwise).
import * as FileSystem from 'expo-file-system/legacy';

// ── Constants ──────────────────────────────────────────────────────────────────

// Drum sensitivity (skin SENS_TABLE parity): px of travel per tune step /
// zoom octave. PRECISE doubles travel for everything (22→44, 40→77 ≈ skin's
// zoom 30→58 ratio).
const DRUM_SENS = {
  normal:  { vfo: 22, zoomOctave: 40 },
  precise: { vfo: 44, zoomOctave: 77 },
};
// Velocity-adaptive VFO (beyond skin): a slow deliberate thumb gets up to
// FINE_MULT× more travel per step (fine tuning), a fast spin stays at 1×.
// Mapped continuously, so decelerating onto a signal gains precision mid-drag.
const VFO_FINE_MULT  = 4;    // sensitivity multiplier at the slow end
const VFO_VEL_FINE   = 40;   // px/s and below → fully fine
const VFO_VEL_FAST   = 350;  // px/s and above → full speed

// SNR-bar compression — the skin's sigNorm curve (30/60@0.8/80) shifted down
// 30dB: upstream UberSDR's S-meter reads radiod's raw audio-stream SNR which
// FLOORS at ~30dB with no signal (madpsy/ka9q_ubersdr#77); ours comes from
// spectrum bins (the correct source), so no-signal ≈ 0-5dB. Same shape: 30dB
// of span to the knee at 0.8 fill, top fifth compressed for 45-55dB monsters.
const SIG_FLOOR = 5, SIG_KNEE = 35, SIG_KNEE_FILL = 0.8, SIG_CEIL = 55;
function sigNorm(v: number): number {
  if (v <= SIG_FLOOR) return 0;
  if (v >= SIG_CEIL)  return 1;
  if (v <= SIG_KNEE)
    return SIG_KNEE_FILL * (v - SIG_FLOOR) / (SIG_KNEE - SIG_FLOOR);
  return SIG_KNEE_FILL +
         (1 - SIG_KNEE_FILL) * (v - SIG_KNEE) / (SIG_CEIL - SIG_KNEE);
}


// ── Types ──────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'SDR'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowUTCStr() {
  const n = new Date();
  return String(n.getUTCHours()).padStart(2,'0') + String(n.getUTCMinutes()).padStart(2,'0') + 'z';
}
let _msgId = 0;
function mkMsg(type: ChatMessage['type'], text: string, user?: string): ChatMessage {
  return { id: String(++_msgId), type, text, user, ts: nowUTCStr() };
}

// ── Voice (Siri) query resolution ───────────────────────────────────────────
// Parse a spoken frequency: "7150", "7.15 MHz", "648 khz", "7150 usb". Bare
// numbers ≥ 30 are kHz (7150 → 7150 kHz), < 30 are MHz (7.15 / 14 → MHz).
function parseVoiceFreq(q: string): { hz: number; mode?: string } | null {
  const lower = q.toLowerCase();
  const modeM = lower.match(/\b(usb|lsb|sam|am|nfm|fm|cwu|cwl|cw)\b/);
  const mode  = modeM ? (modeM[1] === 'cw' ? 'cwu' : modeM[1]) : undefined;
  // NB: only spell out units (mhz/khz/hz). A bare "m"/"k" is NOT treated as a
  // unit — "20m"/"40m" are ham *bands* (metres), not 20 MHz; band routing below.
  const numM  = lower.match(/(\d+(?:[.,]\d+)?)\s*(mhz|khz|hz)?/);
  if (!numM) return null;
  const n = parseFloat(numM[1].replace(',', '.'));
  if (Number.isNaN(n)) return null;
  const unit = numM[2];
  let hz: number;
  if (unit === 'mhz')      hz = n * 1e6;
  else if (unit === 'khz') hz = n * 1e3;
  else if (unit === 'hz')                  hz = n;
  else                                     hz = n < 30 ? n * 1e6 : n * 1e3;
  hz = Math.round(hz);
  if (hz < MIN_HZ || hz > MAX_HZ) return null;
  return { hz, mode };
}

/** Resolve a spoken query to a tune. Frequency first, else the bookmark/band
 *  search (reusing searchStations). Band synonyms (amateur/voice → ham) are
 *  normalised so "40m ham", "40m amateur", "40m voice" all hit the 40m band. */
function resolveVoiceQuery(
  q: string, bms: ServerBookmark[], bands: ServerBand[],
): { hz: number; mode: string | null; isBand: boolean } | null {
  const lower = q.toLowerCase();
  // "N metre" amateur band — match the band by its wavelength label directly,
  // ahead of the fuzzy search. This is robust to Siri mishearing "ham" as "hand"
  // (we key off the number) and stops a "20 MHz" bookmark like WWV from winning
  // over the 20m band (bookmarks otherwise always rank before bands). Excludes a
  // bare "20 MHz"/"20 mhz" (the m must be metres, not a MHz unit prefix).
  // A spoken mode anywhere in the phrase ("7150 lower sideband", "40m upper
  // side band") — parseVoiceMode knows every synonym; it overrides band defaults.
  const spokenMode = parseVoiceMode(q);
  // CB / "citizens band" — the server's band label is usually just "11m", so the
  // word "CB" alone finds nothing. Map it onto the 11m band (by label or the
  // 26.9–27.4 MHz range) so "CB band" and "11m band" both work.
  if (/\b(c\.?\s?b\.?|citizens?\s*band)\b/i.test(q)) {
    const band = bands.find((b) => {
      const l = (b.label || '').toLowerCase();
      return l.includes('cb') || l.includes('11m') ||
             ((b.start || 0) <= 27000000 && (b.end || 0) >= 26960000);
    });
    if (band) return { hz: band.start, mode: spokenMode ?? band.mode ?? null, isBand: true };
  }
  // "N metre" amateur band — match the band by its wavelength label directly,
  // ahead of the fuzzy search. This is robust to Siri mishearing "ham" as "hand"
  // (we key off the number) and stops a "20 MHz" bookmark like WWV from winning
  // over the 20m band (bookmarks otherwise always rank before bands). Excludes a
  // bare "20 MHz"/"20 mhz" (the m must be metres, not a MHz unit prefix).
  const meterM = lower.match(/\b(\d{1,4})\s*m(?:et(?:er|re)s?)?\b/);
  if (meterM && !/\b\d+\s*mhz\b/.test(lower)) {
    const n = meterM[1];
    const band = bands.find((b) => {
      const l = (b.label || '').toLowerCase().replace(/\s+/g, '');
      return l === `${n}m` || l.startsWith(`${n}m`);
    });
    if (band) return { hz: band.start, mode: spokenMode ?? band.mode ?? null, isBand: true };
  }
  const norm = q.replace(/\b(amateur|voice|ssb|phone)\b/gi, 'ham');
  const bandSearch = () => {
    const res = searchStations(bms, bands, norm, 1);
    if (!res.length) return null;
    const r = res[0];
    if (r.isBand && r.band) return { hz: r.band.start, mode: spokenMode ?? r.band.mode ?? null, isBand: true };
    if (r.bm)               return { hz: r.bm.frequency, mode: spokenMode ?? r.bm.mode ?? null, isBand: false };
    return null;
  };
  // Only treat the phrase as a numeric tune when it's *purely* a frequency:
  // a number + optional unit + optional mode words, nothing else. Strip the freq
  // units AND every spoken-mode phrase — crucially WITHOUT word boundaries and
  // with \s* between words, so Siri's mashed forms ("lowersideband", "side band")
  // are all removed; otherwise "7150 lowersideband" keeps letters, gets routed to
  // the band search, and 7150 (inside 40m) snaps to the band start 7000. If any
  // letters survive it's a name ("BBC Radio 5", "20m ham band") → search first.
  const residue = lower
    // Remove numbers AND any trailing unit first — even glued ("909000hz",
    // "7150khz"), which a \b-anchored unit strip would miss.
    .replace(/\d+(?:[.,]\d+)?\s*(?:mhz|khz|hz)?/g, ' ')
    .replace(/(?:upper|lower)\s*side\s*band|side\s*band|synchron\w*(?:\s*(?:a\.?m|amplitude))?|amplitude\s*modulation|frequency\s*modulation|narrow\s*f\.?m|continuous\s*wave|\b(?:usb|lsb|sam|am|nfm|fm|cwu|cwl|cw|morse)\b/g, ' ')
    .replace(/[^a-z]/g, '');
  if (residue.length === 0) {
    const f = parseVoiceFreq(q);
    if (f) return { hz: f.hz, mode: spokenMode ?? f.mode ?? null, isBand: false };
    return bandSearch();
  }
  const b = bandSearch();
  if (b) return b;
  const f = parseVoiceFreq(q);
  return f ? { hz: f.hz, mode: spokenMode ?? f.mode ?? null, isBand: false } : null;
}

/** Spoken demodulator with synonyms → SDRMode. "synchronous AM"/"SAM"→sam,
 *  "lower side band"/"LSB"→lsb, "amplitude modulation"/"AM"→am, etc. Ordered so
 *  the specific phrases win (sam before am, nfm before fm, sideband before am). */
function parseVoiceMode(q: string): SDRMode | null {
  const s = q.toLowerCase();
  const map: [RegExp, SDRMode][] = [
    [/synchron\w*\s*(a\.?m|amplitude)|\bsync\s*am\b|\bsam\b/, 'sam'],
    [/upper\s*side\s*?band|\busb\b/, 'usb'],
    [/lower\s*side\s*?band|\blsb\b/, 'lsb'],
    [/narrow\w*\s*(f\.?m|frequency)|\bnfm\b/, 'nfm'],
    [/frequency\s*modulation|\bf\.?m\b/, 'fm'],
    [/amplitude\s*modulation|\ba\.?m\b/, 'am'],
    [/\bcwl\b|cw\s*lower/, 'cwl'],
    [/\bcwu\b|cw\s*upper|\bcw\b|morse|continuous\s*wave/, 'cwu'],
  ];
  for (const [re, m] of map) if (re.test(s) && m in MODE_BANDWIDTHS) return m as SDRMode;
  return null;
}

/** Spoken step → nearest supported step (Hz). "100Hz"→100, "1kHz"/"1000"→1000. */
function parseVoiceStep(q: string): number | null {
  const f = parseVoiceFreq(q.toLowerCase().replace(/\bstep\b/g, ''));
  // parseVoiceFreq clamps to the tuning range; a bare "100"/"500" wouldn't pass,
  // so parse a plain Hz/kHz value here too.
  let hz: number | null = null;
  const m = q.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(khz|hz|k)?/);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.'));
    if (!Number.isNaN(n)) hz = (m[2] === 'khz' || m[2] === 'k') ? n * 1000 : n;
  }
  if (hz == null && f) hz = f.hz;
  if (hz == null) return null;
  // snap to the nearest supported step
  let best = STEPS[0], bestD = Infinity;
  for (const s of STEPS) { const d = Math.abs(s - hz); if (d < bestD) { bestD = d; best = s; } }
  return best;
}

/** RFC3339 server timestamp → "HHMMz" (falls back to now) */
function chatTs(rfc: string): string {
  const d = rfc ? new Date(rfc) : new Date();
  if (isNaN(d.getTime())) return nowUTCStr();
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}z`;
}

// ── Component ──────────────────────────────────────────────────────────────────


// V4 local hardware (RTL-SDR) demodulator list — includes WFM (broadcast FM),
// which HF UberSDR servers don't offer.
// SAM omitted — the on-device DSP (VibeDSP) has no synchronous-AM demodulator yet.
const LOCAL_MODES: { id: string; label: string }[] = [
  { id: 'wfm', label: 'WFM' }, { id: 'nfm', label: 'NFM' }, { id: 'am', label: 'AM' },
  { id: 'cwu', label: 'CW' },
  // LSB + USB last so they're the two large bottom buttons (the SSB pair),
  // with USB as the final option (sits below LSB in the grid).
  { id: 'lsb', label: 'LSB' }, { id: 'usb', label: 'USB' },
];

export default function SDRScreen({ route, navigation }: Props) {
  const { baseUrl, instanceName, password } = route.params;
  useKeepAwake();

  // V4 local hardware: tear down the on-device shim (closes the RTL-SDR + the
  // localhost server) when leaving the screen — BUT only if this is still the
  // latest local session. The shim is a singleton; when switching instances a new
  // session may already be running by the time this stale screen unmounts, and an
  // unguarded stopSpectrum() would kill it (V5's fast native start re-exposed this).
  const myLocalGen = useRef(route.params.localGen ?? 0).current;
  useEffect(() => {
    if (!route.params.isLocal) return;
    return () => {
      if (localSessionGen() === myLocalGen) (NativeModules as any).VibeLocalSDR?.stopSpectrum?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── V4 local hardware controls (RTL-SDR) ──────────────────────────────────
  const isLocal = !!route.params.isLocal;
  const LocalHw = (NativeModules as any).VibeLocalSDR;
  const [hwOpen,        setHwOpen]        = useState(false);
  const [hwGains,       setHwGains]       = useState<number[]>([]);
  const [hwGain,        setHwGain]        = useState(0);     // tenths of dB
  const [hwAutoGain,    setHwAutoGain]    = useState(true);
  const [hwPpm,         setHwPpm]         = useState(0);
  const [hwSampleRate,  setHwSampleRate]  = useState(2_400_000);
  const [hwBiasTee,     setHwBiasTee]     = useState(false);
  const [hwAgc,         setHwAgc]         = useState(false);
  const [hwDirectSamp,  setHwDirectSamp]  = useState(0);
  const [hwDeemph,      setHwDeemph]      = useState(50e-6);  // FM de-emphasis tau (0/50µs/75µs)
  const [hwStereo,      setHwStereo]      = useState(true);   // WFM stereo on / forced mono (local)
  const [hwSquelch,     setHwSquelch]     = useState(-100);   // audio squelch dBFS (-100 = off)
  const [hwNrLevel,     setHwNrLevel]     = useState(0);      // audio NR strength 0=off..20 (÷15 → native 0..1.33)
  const [hwNotch,       setHwNotch]       = useState(false);  // auto notch — LOCAL (shim)
  const [netNotch,      setNetNotch]      = useState(false);  // auto notch — NETWORK (UberSDR/OWRX/Kiwi)

  // Load saved RTL-SDR hardware settings and apply them to the running session,
  // so gain/bias-T/PPM/etc. persist across connections.
  const hwLoaded = useRef(false);
  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    (async () => {
      let prefs: any = {};
      try { const j = await AsyncStorage.getItem('lsv_local_hw'); if (j) prefs = JSON.parse(j); } catch {}
      if (cancelled) return;
      const auto = prefs.autoGain ?? true;
      const ppm  = typeof prefs.ppm === 'number' ? prefs.ppm : 0;
      let rate = typeof prefs.sampleRate === 'number' ? prefs.sampleRate : 2_400_000;
      // Local USB needs >=1 MHz (a dongle is sluggish/underfiltered lower); only
      // RTL-TCP may sit low. Clamp a stale/low saved rate for USB.
      if (!route.params.isTcp && rate < 1_000_000) rate = 2_400_000;
      const bias = !!prefs.biasTee;
      const agc  = !!prefs.agc;
      const ds   = typeof prefs.directSampling === 'number' ? prefs.directSampling : 0;
      const deemph = typeof prefs.deemph === 'number' ? prefs.deemph : 50e-6;
      const stereo = prefs.stereo !== false;   // default on
      // Squelch / NR / Notch are session-scoped DSP — NEVER restored, so a new
      // connection always starts clean (no surprise muted/“funny” audio carried
      // over from a previous session). Device config (gain/ppm/etc.) still persists.
      const sql = -100, nrLvl = 0, notch = false;
      setHwAutoGain(auto); setHwPpm(ppm); setHwSampleRate(rate);
      setHwBiasTee(bias); setHwAgc(agc); setHwDirectSamp(ds); setHwDeemph(deemph); setHwStereo(stereo); setHwSquelch(sql); setHwNrLevel(nrLvl); setHwNotch(notch);
      if (typeof prefs.gain === 'number') setHwGain(prefs.gain);
      // Re-apply to the native session (already running from startSpectrum).
      LocalHw?.setPpm?.(ppm);
      LocalHw?.setBiasTee?.(bias);
      LocalHw?.setAgc?.(agc);
      LocalHw?.setDirectSampling?.(ds);
      LocalHw?.setDeemphasis?.(deemph);
      LocalHw?.setStereoEnabled?.(stereo);
      LocalHw?.setSquelch?.(sql > -100, sql);
      LocalHw?.setNrStrength?.(nrLvl / 15);
      LocalHw?.setNR?.(nrLvl > 0);
      LocalHw?.setNotch?.(notch);
      if (rate !== 2_400_000) LocalHw?.setSampleRate?.(rate);
      LocalHw?.setGain?.(auto ? -1 : (typeof prefs.gain === 'number' ? prefs.gain : 0));
      try {
        const g = await LocalHw?.getTunerGains?.();
        if (!cancelled && Array.isArray(g) && g.length) {
          setHwGains(g);
          if (typeof prefs.gain !== 'number') setHwGain(g[Math.floor(g.length / 2)]);
        }
      } catch {}
      hwLoaded.current = true;
    })();
    return () => { cancelled = true; };
  }, [isLocal, LocalHw]);

  // Persist hardware settings whenever they change (after the initial load).
  useEffect(() => {
    if (!isLocal || !hwLoaded.current) return;
    AsyncStorage.setItem('lsv_local_hw', JSON.stringify({
      autoGain: hwAutoGain, gain: hwGain, ppm: hwPpm, sampleRate: hwSampleRate,
      biasTee: hwBiasTee, agc: hwAgc, directSampling: hwDirectSamp, deemph: hwDeemph, stereo: hwStereo,
    })).catch(() => {});
    // NB: squelch / nrLevel / notch are intentionally NOT saved (session-scoped).
  }, [isLocal, hwAutoGain, hwGain, hwPpm, hwSampleRate, hwBiasTee, hwAgc, hwDirectSamp, hwDeemph, hwStereo]);

  const onHwAuto = useCallback((auto: boolean) => {
    setHwAutoGain(auto);
    LocalHw?.setGain?.(auto ? -1 : hwGain);
  }, [LocalHw, hwGain]);
  const onHwGain = useCallback((tenthDb: number) => {
    setHwAutoGain(false); setHwGain(tenthDb); LocalHw?.setGain?.(tenthDb);
  }, [LocalHw]);
  const onHwPpm = useCallback((ppm: number) => {
    const v = Math.max(-200, Math.min(200, ppm)); setHwPpm(v); LocalHw?.setPpm?.(v);
  }, [LocalHw]);
  const onHwSampleRate = useCallback((rate: number) => {
    setHwSampleRate(rate); LocalHw?.setSampleRate?.(rate);
  }, [LocalHw]);
  const onHwBiasTee = useCallback((on: boolean) => { setHwBiasTee(on); LocalHw?.setBiasTee?.(on); }, [LocalHw]);
  const onHwAgc = useCallback((on: boolean) => { setHwAgc(on); LocalHw?.setAgc?.(on); }, [LocalHw]);
  const onHwDirectSamp = useCallback((mode: number) => { setHwDirectSamp(mode); LocalHw?.setDirectSampling?.(mode); }, [LocalHw]);
  const onHwDeemph = useCallback((tau: number) => { setHwDeemph(tau); LocalHw?.setDeemphasis?.(tau); }, [LocalHw]);
  const onHwStereo = useCallback((on: boolean) => { setHwStereo(on); LocalHw?.setStereoEnabled?.(on); }, [LocalHw]);
  const onLocalSquelch = useCallback((db: number) => {
    setHwSquelch(db); LocalHw?.setSquelch?.(db > -100, db);
  }, [LocalHw]);
  const onLocalNR = useCallback((level: number) => {
    setHwNrLevel(level);
    LocalHw?.setNrStrength?.(level / 15);
    LocalHw?.setNR?.(level > 0);
  }, [LocalHw]);
  const onLocalNotch = useCallback((on: boolean) => {
    setHwNotch(on); LocalHw?.setNotch?.(on);
  }, [LocalHw]);
  // Network auto notch (UberSDR/OWRX/Kiwi): client-side, applied in the audio
  // engine (iOS VibePowerModule / Android VibeStreamService). Persisted globally
  // and (re)applied whenever the connection comes up — see the effect below.
  // Session-scoped: NOT persisted, so it reverts to Off on a server change. It
  // only survives pause/resume because the screen stays mounted (re-applied on
  // reconnect by the effect below).
  const onNetNotch = useCallback((on: boolean) => {
    setNetNotch(on);
  }, []);

  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = Dimensions.get('window');
  const isLandscape = screenW > screenH;

  // ── Spec ratio (portrait + landscape stored separately) ───────────────────
  const [specRatioPortrait,  setSpecRatioPortrait]  = useState(0.28);
  const [specRatioLandscape, setSpecRatioLandscape] = useState(0.20);
  const [ratioOverlayOpen,   setRatioOverlayOpen]   = useState(false);
  const specFrac = isLandscape ? specRatioLandscape : specRatioPortrait;

  // ── Client ────────────────────────────────────────────────────────────────

  const client    = useRef<SDRBackend | null>(null);
  const destroyed = useRef(false);
  // Bumping connEpoch mints a fresh session uuid and re-runs the whole connect
  // path (spectrum client + native audio engine + decoder) from scratch — used
  // to recover from a data-saver disconnect, where reopening the old session's
  // sockets lands in a broken half-state (frozen waterfall/zoom, no audio).
  const [connEpoch, setConnEpoch] = useState(0);
  const lastReconnectAt = useRef(0);
  const fullReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAt.current < 2000) return;  // debounce double-triggers
    lastReconnectAt.current = now;
    setConnEpoch((e: number) => e + 1);
    // If we don't connect within ~12s (server full / rate-limited), flag failure
    // so the lock-screen card + banner tell the user to open the app.
    setTimeout(() => {
      if (!connectedRef.current) {
        VibePowerModule?.setReconnectFailed?.(true);
        setReconnectFailedUi(true);
      }
    }, 12000);
  }, []);
  const sessionUuid = useMemo(() => uuidv4(), [baseUrl, connEpoch]);

  // ── SDR state ─────────────────────────────────────────────────────────────

  const [connected, setConnected] = useState(false);
  const [serverLost, setServerLost] = useState(false);   // OWRX server crashed/restarted
  const [serverBusy, setServerBusy] = useState(false);   // Kiwi receiver full (too_busy)
  const [connLost,   setConnLost]   = useState(false);   // UberSDR link down — auto-reconnecting
  const [connTimedOut, setConnTimedOut] = useState(false); // initial connect never completed
  const connLostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appActiveRef  = useRef(true);   // false while backgrounded — gates connLost
  const [profiles, setProfiles]   = useState<ProfileInfo[]>([]);  // OWRX only
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>(undefined);
  const [sdrUsage, setSdrUsage] = useState<Record<string, { name: string; inUse: boolean; activeProfileId?: string }>>({});  // OWRX: per-SDR usage
  const [clientCount, setClientCount] = useState(0);  // OWRX: live user count
  const [serverModes, setServerModes] = useState<BackendMode[]>([]);  // OWRX gated demod list
  // Live RDS (FM) / DAB station metadata (OWRX). liveStationRef mirrors the name
  // for the VTS resolver (reads in a debounced callback, avoids stale closures).
  const [dabProgrammes, setDabProgrammes] = useState<DabProgramme[]>([]);  // OWRX DAB ensemble
  const [activeDabId, setActiveDabId] = useState<number>(0);
  // DAB speed correction (dablin chipmunk workaround) — 1 = off; persisted.
  const [dabSpeed, setDabSpeed] = useState<number>(1);
  const [liveStation, setLiveStation] = useState<{ name?: string; text?: string; badge?: string }>({});
  const liveBadgeRef = useRef<string | undefined>(undefined);
  const liveStationRef = useRef<string>('');
  const [fmStereo, setFmStereo] = useState(false);   // WFM stereo pilot (local hardware)

  // DAB speed correction is remembered PER STATION (ensemble + programme), since
  // the chipmunk is per-service: you set ×0.67 on a bad station once and it
  // auto-applies every time you return, while good stations stay Off. dabSpeed
  // is the CURRENT station's factor (for the menu highlight); the map is the store.
  const dabSpeedMapRef = useRef<Record<string, number>>({});
  const dabKeyRef = useRef<string>('');   // "<ensemble>|<programme>" of the tuned service
  useEffect(() => {
    AsyncStorage.getItem('owrx_dab_speed_map').then((j: string | null) => {
      if (!j) return;
      try { const m = JSON.parse(j); if (m && typeof m === 'object') dabSpeedMapRef.current = m; } catch {}
    }).catch(() => {});
  }, []);
  // Menu speed buttons + fine slider set the factor for the CURRENTLY tuned
  // station. Applied live; the storage write is debounced so dragging the slider
  // doesn't hammer AsyncStorage (it fires onValueChange continuously).
  const dabSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDabSpeed = useCallback((scale: number) => {
    setDabSpeed(scale);
    client.current?.setDabAudioScale?.(scale);
    const key = dabKeyRef.current;
    if (!key) return;
    dabSpeedMapRef.current = { ...dabSpeedMapRef.current, [key]: scale };
    if (dabSaveTimer.current) clearTimeout(dabSaveTimer.current);
    dabSaveTimer.current = setTimeout(() => {
      AsyncStorage.setItem('owrx_dab_speed_map', JSON.stringify(dabSpeedMapRef.current)).catch(() => {});
    }, 400);
  }, []);
  // Called from the DAB metadata handler when the tuned service changes: look up
  // its saved correction (default Off) and apply it automatically.
  const applyDabStation = useCallback((ensemble: string, programme: string) => {
    const key = ensemble + '|' + programme;
    if (key === dabKeyRef.current) return;
    dabKeyRef.current = key;
    const saved = dabSpeedMapRef.current[key] ?? 1;
    setDabSpeed(saved);
    client.current?.setDabAudioScale?.(saved);
  }, []);
  const [status, setStatus]       = useState<SDRStatus>({
    frequency: 14_074_000, mode: 'usb',
    bandwidthLow: -3000, bandwidthHigh: 3000,
    binCount: 1024, binBandwidth: 0, centerHz: 0, bwHz: 0,
  });
  // Hot-path frame sink — WaterfallView registers its imperative frame handler
  // here; spectrum frames bypass React state entirely (CPU audit 2026-06-11:
  // setState per 10–20Hz frame re-rendered the whole tree ≈ a full core).
  const wfFrameSink = useRef<((b: Float32Array, s: SDRStatus) => void) | null>(null);
  // Muted via media controls (AirPods squeeze → pause = mute) — native emits
  // VibeMuted so the UI can show a tap-to-unmute banner.
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  // True when the data saver has dropped the SDR stream after a muted spell.
  const [dataSaverOff, setDataSaverOff] = useState(false);
  const dataSaverOffRef = useRef(false);
  useEffect(() => { dataSaverOffRef.current = dataSaverOff; }, [dataSaverOff]);
  const unmute = useCallback(() => {
    (NativeModules.VibePowerModule as { setMuted?: (m: boolean) => void })?.setMuted?.(false);
    setIsMuted(false);
  }, []);

  // Full-screen waterfall: hide the controls bar, floating chevron restores.
  const [controlsHidden, setControlsHidden] = useState(false);
  const onHideControls = useCallback(() => { setControlsHidden(true); setMenuOpen(false); }, []);

  // Centre the spectrum view on the tuned frequency at the current zoom
  // (reference-skin parity).
  const onCentreVfo = useCallback(() => {
    const c = client.current; if (!c) return;
    const v = c.getView();
    if (v.binBandwidth > 0) c.zoom(c.getStatus().frequency, v.binBandwidth);
  }, []);

  // ── VFO lock / waterfall panning (BRIEF-vfo-lock-and-panning) ───────────────
  // Default locked = today's behaviour (view follows the VFO). Unlocked lets the
  // waterfall pan freely. Persisted in lsv_vfo_lock; mirrored to the client as
  // followVfo. Disabled (but shown) on local hardware until Phase 2.
  const [vfoLocked, setVfoLocked] = useState(true);
  const vfoLockedRef = useRef(true);
  useEffect(() => { vfoLockedRef.current = vfoLocked; }, [vfoLocked]);

  useEffect(() => {
    AsyncStorage.getItem('lsv_vfo_lock')
      .then(v => {
        const locked = v == null ? true : v === '1';
        setVfoLocked(locked);
        client.current?.setFollowMode(locked);
      })
      .catch(() => {});
  }, []);

  // Local hardware: keep the client's Fs window in sync with the live sample
  // rate so panSpan()'s movable wall matches the real capture bandwidth.
  useEffect(() => {
    if (!isLocal) return;
    (client.current as { setLocalSampleRate?: (hz: number) => void } | null)
      ?.setLocalSampleRate?.(hwSampleRate);
  }, [isLocal, hwSampleRate]);

  const onToggleVfoLock = useCallback(() => {
    setVfoLocked(prev => {
      const next = !prev;
      client.current?.setFollowMode(next);
      if (next) onCentreVfo();                  // re-locking snaps back to the VFO
      AsyncStorage.setItem('lsv_vfo_lock', next ? '1' : '0').catch(() => {});
      return next;
    });
  }, [onCentreVfo]);

  // Boundary walls for the waterfall (unlocked only).
  //  • Remote (UberSDR/Kiwi/OWRX): hard walls at the band/profile/rx edges.
  //  • Local/RTL-TCP: the dongle's captured Fs window edges (centre ± Fs/2) —
  //    these are the real "you can pan/tune this far" boundaries; the spectrum
  //    ends there. They move as the dongle re-tunes.
  const walls = useMemo(() => {
    if (vfoLocked) return null;
    if (isLocal) {
      // Use the REAL captured bandwidth the shim reports (tracks the actual
      // sample-rate / bandwidth mode), not the JS hw config which can lag.
      const fs = (client.current as { captureBandwidth?: () => number } | null)
        ?.captureBandwidth?.() || hwSampleRate;
      if (!(status.centerHz > 0) || !(fs > 0)) return null;
      const half = fs / 2;
      return { loHz: status.centerHz - half, hiHz: status.centerHz + half };
    }
    const s = client.current?.panSpan();
    return s ? { loHz: s.loHz, hiHz: s.hiHz } : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vfoLocked, isLocal, status.centerHz, status.bwHz, hwSampleRate, connEpoch]);

  // VFO has panned outside the visible span → show the floating recentre button.
  // (No toast hint — the floating button itself is the affordance; VTS pop-ups
  // caused more trouble than they solved on the original skin.)
  const vfoOffscreen = !vfoLocked && status.bwHz > 0 &&
    (status.frequency < status.centerHz - status.bwHz / 2 ||
     status.frequency > status.centerHz + status.bwHz / 2);

  // ── Step ──────────────────────────────────────────────────────────────────

  const [step,      setStep]      = useState(1000);
  const [stepOpen,  setStepOpen]  = useState(false);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // ── Display settings ──────────────────────────────────────────────────────

  const [dbMin,         setDbMin]         = useState(-120);
  const [dbMax,         setDbMax]         = useState(-20);
  const [colormap,      setColormap]      = useState('Jet');       // production default
  const [nr,            setNr]            = useState(false);
  const [nb,            setNb]            = useState(false);
  // NR cycle: off → nr → nr2. SERV state controlled by server DSP section.
  const [nrMode,        setNrMode]        = useState<'off'|'nr'|'nr2'>('off');
  // Waterfall / spectrum display settings
  const [specShow,      setSpecShow]      = useState(true);
  const [specSmoothing, setSpecSmoothing] = useState(5);
  const [specFloor,     setSpecFloor]     = useState(0);
  const [specPeakScale, setSpecPeakScale] = useState(10);
  const [peakHold,      setPeakHold]      = useState(true);
  const [wfBrightness,  setWfBrightness]  = useState(0);
  const [wfContrast,    setWfContrast]    = useState(0);
  const [wfSharpness,   setWfSharpness]   = useState(5);
  // UberSDR auto-range symmetric contrast (0–20). Web client calibration = 10.
  const [autoContrast,  setAutoContrast]  = useState(5);  // production default (10 too dark)
  // M9PSY 5-tap spatial waterfall smooth
  const [spatialSmooth, setSpatialSmooth] = useState(true);
  const [wfCoarse,      setWfCoarse]      = useState<'auto'|'manual'>('auto');
  const [frameRate,     setFrameRate]     = useState<'native'|'20fps'|'30fps'>('20fps');
  // Smooth tune: 120Hz interpolated scroll while interacting; discrete row
  // steps + ~30fps spectrum tween once settled (ProMotion idles → battery).
  const [smoothTune,    setSmoothTune]    = useState(true);
  // Idle saver: after 30s without touch, ask the server for ⅓ frame rate
  // (set_rate 3 — skin default-waterfall parity). Meters/waterfall/spectrum
  // all slow with the data; any touch restores full rate instantly.
  const [idleSlow,      setIdleSlow]      = useState(true);
  const [vfoNeedle,     setVfoNeedle]     = useState('#ffffff');   // production default
  // Needle/glow brightness 1-10 (5 = original look) — bright palettes can
  // swallow the needle whatever colour it is (Stuart 2026-06-12 eve)
  const [vfoIntensity,  setVfoIntensity]  = useState(5);
  // Frost 0-10 (0 = off): smoked-glass band over the passband
  const [vfoFrost,      setVfoFrost]      = useState(5);           // production default
  // Instance spectrum backdrop (/api/spectrum-bg-image) + opacity 0-10
  // (3 = web default 0.30); follows the server's configured opacity until
  // the user moves the slider (or a saved pref exists)
  const [bgImageUrl,    setBgImageUrl]    = useState<string | null>(null);
  const [bgOpacity,     setBgOpacity]     = useState(3);
  const bgOpacityUserSet = useRef(false);
  // Station-ID overlay (web drawStationIdOverlay parity)
  const [stationId,     setStationId]     = useState<{ line1: string; line2?: string; color: string } | null>(null);
  // Server software version (menu footer — identifies the backend type)
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [serverLabel,   setServerLabel]   = useState<string | null>(null);  // OWRX: OpenWebRX/+
  const [aboutOpen,     setAboutOpen]     = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  // Mute the live SDR while a recording plays so they don't fight over the audio
  // session; restore the prior mute state when the browser closes.
  const preRecMuteRef = useRef(false);
  const onRecordingsActive = useCallback((active: boolean) => {
    const VM = NativeModules.VibePowerModule as { setMuted?: (m: boolean) => void };
    if (active) { preRecMuteRef.current = isMutedRef.current; VM?.setMuted?.(true); }
    else        { VM?.setMuted?.(preRecMuteRef.current); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUiConfig(baseUrl).then((cfg: ServerUiConfig | null) => {
      if (cancelled) return;
      if (cfg?.spectrum_bg_image) {
        const raw = cfg.spectrum_bg_image;
        const abs = raw.startsWith('http')
          ? raw
          : baseUrl.replace(/\/+$/, '') + (raw.startsWith('/') ? raw : '/' + raw);
        // Cache-bust like the web client — a freshly uploaded image always loads
        setBgImageUrl(abs + (abs.includes('?') ? '&' : '?') + 't=' + Date.now());
      } else {
        setBgImageUrl(null);
      }
      if (!bgOpacityUserSet.current && typeof cfg?.spectrum_bg_opacity === 'number') {
        setBgOpacity(Math.round(Math.max(0, Math.min(1, cfg.spectrum_bg_opacity)) * 10));
      }
      const overlayOff = cfg?.station_id_overlay === false;
      if (overlayOff) setStationId(null);
      const idColor = /^#[0-9a-fA-F]{6}$/.test((cfg?.station_id_color ?? '').trim())
        ? (cfg!.station_id_color as string).trim() : '#ffffff';
      fetchReceiverInfo(baseUrl).then((r: ReceiverInfo | null) => {
        if (cancelled || !r) return;
        if (r.serverVersion) setServerVersion(r.serverVersion);
        if (overlayOff) return;
        const callsign = (r.callsign ?? '').trim();
        const name     = (r.name ?? '').trim();
        if (!callsign && !name) return;
        setStationId({
          line1: callsign && name ? `${callsign} - ${name}` : (callsign || name),
          line2: (r.location ?? '').trim() || undefined,
          color: idColor,
        });
      }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [baseUrl]);

  // SNR squelch (audio gate) — value ≤ -999 = open/disabled
  const [snrSquelch,    setSnrSquelch]    = useState(-999);
  // FM squelch — value ≤ -999 = open. Only active on fm/nfm modes.
  const [fmSquelch,     setFmSquelch]     = useState(-999);
  // Server-side NR (DSP insert) — filter list + param descriptors arrive via
  // the native audio WS (get_dsp_filters → dsp_filters); params are STRINGS
  // on the wire (server paramInfo is all string-typed).
  const [serverDspEnabled, setServerDspEnabled] = useState(false);
  const [serverDspFilter,  setServerDspFilter]  = useState('');
  const [serverDspParams,  setServerDspParams]  = useState<Record<string,string>>({});
  const [dspFilters,       setDspFilters]       = useState<DspFilterDesc[]>([]);
  // Kiwi squelch is a CLIENT-SIDE dBFS gate (the server SNR-based squelch is
  // unreliable). Threshold in dBm: −130 = Off (open), up to −20. Driven from the
  // S-meter dBm in onSMeter → native setSquelchOpen, with a short release tail.
  const [kiwiSquelch,      setKiwiSquelch]      = useState(-130); // dBm threshold (−130 = off)
  const kiwiSqDbmRef  = useRef(-130);
  const kiwiSqOpenRef = useRef(true);
  const kiwiSqAboveAt = useRef(0);
  const onKiwiSquelch = useCallback((db: number) => {
    setKiwiSquelch(db); kiwiSqDbmRef.current = db;
    if (db <= -130) {  // Off → force the gate open immediately
      kiwiSqOpenRef.current = true;
      (NativeModules.VibePowerModule as { setSquelchOpen?: (o: boolean) => void })?.setSquelchOpen?.(true);
    }
  }, []);
  // Evaluate the Kiwi squelch gate against a fresh S-meter reading (dBm).
  const evalKiwiSquelch = useCallback((dbm: number) => {
    const thr = kiwiSqDbmRef.current;
    if (thr <= -130) return;                       // Off — handled in onKiwiSquelch
    const now = Date.now();
    if (dbm >= thr) kiwiSqAboveAt.current = now;
    const open = (now - kiwiSqAboveAt.current) < 350;  // 350 ms release tail
    if (open !== kiwiSqOpenRef.current) {
      kiwiSqOpenRef.current = open;
      (NativeModules.VibePowerModule as { setSquelchOpen?: (o: boolean) => void })?.setSquelchOpen?.(open);
    }
  }, []);
  const [dspError,         setDspError]         = useState<string | null>(null);

  // ── UI overlay state ──────────────────────────────────────────────────────

  const [menuOpen,      setMenuOpen]      = useState(false);
  const [freqModalOpen, setFreqModalOpen] = useState(false);

  // Server map overlays (HFDL / Digital spots / CW spots — skin parity)
  const [mapKind, setMapKind] = useState<MapKind | null>(null);
  // On-device FT8 spots map (Local/Kiwi) + its no-GPS city-picker fallback.
  const [localMapOpen, setLocalMapOpen]   = useState(false);
  const [cityPickerOpen, setCityPickerOpen] = useState(false);

  // Admin pages (skin menu Admin section) — in-app browser overlay
  const [adminPage, setAdminPage] = useState<{ url: string; title: string } | null>(null);
  const onAdminLink = useCallback((path: string, title: string) => {
    if (!baseUrl) return;
    setMenuOpen(false);
    setAdminPage({ url: baseUrl.replace(/\/+$/, '') + path, title });
  }, [baseUrl]);

  // Frequency display unit — chosen in FreqModal, drives the main readout too.
  const [freqUnit, setFreqUnit] = useState<'hz' | 'khz' | 'mhz'>('khz');
  useEffect(() => {
    AsyncStorage.getItem('lsv_fq_unit').then((u: string | null) => {
      if (u === 'hz' || u === 'khz' || u === 'mhz') setFreqUnit(u);
    }).catch(() => {});
    // Smooth tune is always on now (no toggle) — don't restore an old saved "off".
    AsyncStorage.getItem('lsv_idle_slow').then((v: string | null) => {
      if (v !== null) setIdleSlow(v === '1');
    }).catch(() => {});
    AsyncStorage.getItem('lsv_frame_rate').then((v: string | null) => {
      if (v === 'native' || v === '20fps' || v === '30fps') setFrameRate(v);
    }).catch(() => {});
  }, []);
  const [modeSelOpen,   setModeSelOpen]   = useState(false);

  // ── Signal / SNR ──────────────────────────────────────────────────────────

  // Meter values bypass React state entirely (full-tree re-render per update
  // was ~a third of all JS time in the CPU profile) — leaf widgets subscribe.
  const meterBus    = useRef(createMeterBus());
  const meterSmooth = useRef({ level: 0, peak: 0, hold: 0 });
  // SNR from radiod's channel status (basebandPower − noiseDensity), pushed by
  // native per audio packet. This is the demodulator's own measurement (zoom-
  // independent, unlike the spectrum). −30 corrects radiod's known +30 dB
  // audio-stream floor offset (madpsy/ka9q_ubersdr#77) so it's honest 0–50 dB,
  // NOT the buggy 30–80 dB UberSDR shows. null until the first reading arrives.
  const audioSnrRef = useRef<number | null>(null);
  // OWRX reports a real channel S-meter (dBm) over the control WS — the
  // demodulator's own level reading, zoom-independent like UberSDR's SNR. We
  // store the latest value and let it drive the absolute (S-meter/dBFS) meter
  // for OWRX, where there's no native VibeSignal feed. null until first reading.
  const owrxSmeterRef = useRef<number | null>(null);
  const [signalMode,   setSignalMode]   = useState<'snr' | 'smeter' | 'dbfs'>('snr');
  const signalModeRef = useRef<'snr' | 'smeter' | 'dbfs'>('snr');
  useEffect(() => { signalModeRef.current = signalMode; }, [signalMode]);

  // ── Display prefs persistence — every waterfall/spectrum/display setting in
  // one blob, restored on launch, saved debounced (sliders fire per-tick).
  const prefsLoaded = useRef(false);
  // Save scope: 'server' when a per-instance override exists (saved via the
  // display panel's THIS SERVER button) — auto-save then targets that key so
  // later tweaks stick to this instance instead of silently reverting.
  const prefsTarget = useRef<'global' | 'server'>('global');
  const latestPrefsJson = useRef('');
  useEffect(() => {
    (async () => {
      let j: string | null = null;
      try {
        j = await AsyncStorage.getItem('lsv_display_prefs:' + baseUrl);
        if (j) prefsTarget.current = 'server';
        else j = await AsyncStorage.getItem('lsv_display_prefs');
      } catch {}
      applyPrefs(j);
    })();
    function applyPrefs(j: string | null) {
      if (j) {
        try {
          const p = JSON.parse(j) as Record<string, unknown>;
          const num  = (k: string, set: (v: number) => void)  => { const v = p[k]; if (typeof v === 'number' && isFinite(v)) set(v); };
          const bool = (k: string, set: (v: boolean) => void) => { const v = p[k]; if (typeof v === 'boolean') set(v); };
          num('dbMin', setDbMin);                 num('dbMax', setDbMax);
          num('specSmoothing', setSpecSmoothing); num('specFloor', setSpecFloor);
          num('specPeakScale', setSpecPeakScale); num('wfBrightness', setWfBrightness);
          num('wfContrast', setWfContrast);       num('wfSharpness', setWfSharpness);
          num('autoContrast', setAutoContrast);   num('step', setStep);
          num('specRatioPortrait', setSpecRatioPortrait);
          num('specRatioLandscape', setSpecRatioLandscape);
          bool('specShow', setSpecShow);          bool('peakHold', setPeakHold);
          bool('spatialSmooth', setSpatialSmooth);
          if (p.wfCoarse === 'auto' || p.wfCoarse === 'manual') setWfCoarse(p.wfCoarse);
          if (p.signalMode === 'snr' || p.signalMode === 'smeter' || p.signalMode === 'dbfs') setSignalMode(p.signalMode);
          if (typeof p.colormap === 'string')  setColormap(p.colormap);
          if (typeof p.vfoNeedle === 'string') setVfoNeedle(p.vfoNeedle);
          num('vfoIntensity', setVfoIntensity);
          num('vfoFrost', setVfoFrost);
          num('bgOpacity', (v: number) => { setBgOpacity(v); bgOpacityUserSet.current = true; });
        } catch {}
      }
      prefsLoaded.current = true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  useEffect(() => {
    if (!prefsLoaded.current) return; // don't clobber the blob with defaults pre-load
    const json = JSON.stringify({
      dbMin, dbMax, colormap, specShow, specSmoothing, specFloor,
      specPeakScale, peakHold, wfBrightness, wfContrast, wfSharpness,
      autoContrast, spatialSmooth, wfCoarse, vfoNeedle, vfoIntensity, vfoFrost, bgOpacity, signalMode, step,
      specRatioPortrait, specRatioLandscape,
    });
    latestPrefsJson.current = json;
    const key = prefsTarget.current === 'server'
      ? 'lsv_display_prefs:' + baseUrl : 'lsv_display_prefs';
    const t = setTimeout(() => {
      AsyncStorage.setItem(key, json).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [dbMin, dbMax, colormap, specShow, specSmoothing, specFloor,
      specPeakScale, peakHold, wfBrightness, wfContrast, wfSharpness,
      autoContrast, spatialSmooth, wfCoarse, vfoNeedle, vfoIntensity, vfoFrost, bgOpacity, signalMode, step,
      specRatioPortrait, specRatioLandscape, baseUrl]);

  // Display-panel save row (skin parity): RESET = defaults + drop the server
  // override; THIS SERVER = per-instance override; GLOBAL = the shared blob.
  const onDispReset = useCallback(() => {
    AsyncStorage.removeItem('lsv_display_prefs:' + baseUrl).catch(() => {});
    prefsTarget.current = 'global';
    setDbMin(-120); setDbMax(-20); setColormap('Jet');
    setSpecShow(true); setSpecSmoothing(5); setSpecFloor(0);
    setSpecPeakScale(10); setPeakHold(true);
    setWfBrightness(0); setWfContrast(0); setWfSharpness(5);
    setAutoContrast(5); setSpatialSmooth(true); setWfCoarse('auto');
    setVfoNeedle('#ffffff'); setVfoIntensity(5); setVfoFrost(5); setBgOpacity(3); setSignalMode('snr'); setStep(1000);
    setSpecRatioPortrait(0.28); setSpecRatioLandscape(0.20);
    Alert.alert('Display Reset', 'Display settings restored to defaults.');
  }, [baseUrl]);

  const onDispSaveServer = useCallback(() => {
    prefsTarget.current = 'server';
    AsyncStorage.setItem('lsv_display_prefs:' + baseUrl, latestPrefsJson.current)
      .catch(() => {});
    Alert.alert('Saved', 'Display settings saved for this server.');
  }, [baseUrl]);

  const onDispSaveGlobal = useCallback(() => {
    prefsTarget.current = 'global';
    AsyncStorage.removeItem('lsv_display_prefs:' + baseUrl).catch(() => {});
    AsyncStorage.setItem('lsv_display_prefs', latestPrefsJson.current)
      .catch(() => {});
    Alert.alert('Saved', 'Display settings saved as the global default.');
  }, [baseUrl]);

  // ── Recording ─────────────────────────────────────────────────────────────

  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds,  setRecSeconds]  = useState(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleRecording = useCallback(() => {
    if (!isRecording) {
      // Pass the LIVE freq/mode for the filename — native currentFreq is only
      // tracked on UberSDR's audio WS, so OWRX would otherwise show a stale freq.
      (VibePowerModule as any)?.startRecording(Math.round(status.frequency || 0), String(status.mode || ''))
        .then(() => {
          setRecSeconds(0);
          recTimerRef.current = setInterval(() => setRecSeconds((s: number) => s + 1), 1000);
          setIsRecording(true);
        })
        .catch((e: Error) => Alert.alert('Recording', `Could not start recording: ${e.message}`));
    } else {
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
      setRecSeconds(0);
      setIsRecording(false);
      VibePowerModule?.stopRecording()
        .then(async (path: string | null) => {
          // Half-height native share sheet; the file also stays in app storage
          // (iOS Documents / Android filesDir) and is reachable via the
          // Recordings browser. Android needs an Expo content URI to share.
          if (!path) return;
          if (Platform.OS === 'android') {
            try {
              const cu = await FileSystem.getContentUriAsync(
                path.startsWith('file://') ? path : 'file://' + path);
              VibePowerModule?.shareRecording(cu);
            } catch {}
          } else {
            VibePowerModule?.shareRecording(path);
          }
        })
        .catch(() => {});
    }
  }, [isRecording, status.frequency, status.mode]);

  useEffect(() => () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  }, []);

  // ── Chat ──────────────────────────────────────────────────────────────────

  const [chatOpen,     setChatOpen]     = useState(false);
  const [chatUnread,   setChatUnread]   = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [myCallsign,   setMyCallsign]   = useState<string | null>(null);
  const [chatMuted,    setChatMuted]    = useState(false);
  const [chatUsers,    setChatUsers]    = useState<ChatUserRow[]>([]);
  const [chatEnabled,  setChatEnabled]  = useState(false);   // OWRX: from config allow_chat
  const [syncedUser,   setSyncedUser]   = useState<string | null>(null);
  const [zoomSync,     setZoomSync]     = useState(false);
  const myCallsignRef = useRef<string | null>(null);
  const chatMutedRef  = useRef(false);
  const syncedUserRef = useRef<string | null>(null);
  const zoomSyncRef   = useRef(false);
  useEffect(() => { myCallsignRef.current = myCallsign; }, [myCallsign]);
  useEffect(() => { chatMutedRef.current = chatMuted; },   [chatMuted]);
  useEffect(() => { syncedUserRef.current = syncedUser; }, [syncedUser]);
  useEffect(() => { zoomSyncRef.current = zoomSync; },     [zoomSync]);

  /** quiet=true (history replay / muted) — render without the unread pulse */
  const addChatMsg = useCallback((msg: ChatMessage, quiet = false) => {
    setChatMessages((prev: ChatMessage[]) => [...prev.slice(-99), msg]);
    if (quiet || chatMutedRef.current) return;
    setChatOpen((open: boolean) => {
      if (!open) setChatUnread(true);
      return open;
    });
  }, []);

  // Username rules (server SetUsername): 1–15 chars, letters/digits plus
  // - _ / inside; NO spaces; case preserved (need not be capitals).
  const sanitizeCallsign = useCallback((raw: string): string =>
    raw.replace(/[^A-Za-z0-9\-_\/]/g, '').replace(/^[-_\/]+|[-_\/]+$/g, '').slice(0, 15), []);

  const isOwrx = route.params.serverType === 'owrx';
  const isKiwi = route.params.serverType === 'kiwi';
  // Kiwi exposes its noise filters/blanker as DSP descriptors → reuse the
  // UberSDR server-DSP menu UI (filter selector + param sliders).
  useEffect(() => {
    if (isKiwi) setDspFilters(KiwiAdapter.DSP_FILTERS as DspFilterDesc[]);
  }, [isKiwi]);
  // OWRX and Kiwi have no SNR feed (radiod-only) — default to the S-meter
  // (the 'snr' mode reads dead on those backends).
  useEffect(() => { if ((isOwrx || isKiwi) && signalMode === 'snr') setSignalMode('smeter'); }, [isOwrx, isKiwi, signalMode]);
  const handleChatJoin = useCallback((cs: string) => {
    const clean = sanitizeCallsign(cs);
    if (!clean) return;
    setMyCallsign(clean);
    // OWRX has no join handshake — the name rides on each message; UberSDR joins.
    if (!isOwrx) decoderClient.current?.joinChat(clean);
    AsyncStorage.setItem('lsv_chat_callsign:' + baseUrl, clean).catch(() => {});
  }, [sanitizeCallsign, baseUrl, isOwrx]);

  const handleChatSend = useCallback((text: string) => {
    if (!myCallsign) return;
    if (isOwrx) client.current?.sendChat?.(text, myCallsign);
    else decoderClient.current?.sendChat(text);
    // Own messages echo back via the broadcast — rendered then (deduped),
    // matching the skin: what you see is what the server accepted.
  }, [myCallsign, isOwrx]);

  // Tune/zoom sync OUT: report our freq/mode/BW edges/zoom to chat so other
  // users can see and sync to us (debounced 1s — the drum emits fast)
  useEffect(() => {
    if (!myCallsign || !status.frequency || isOwrx) return;   // OWRX = basic text chat, no sync
    const t = setTimeout(() => {
      const view = client.current?.getView();
      decoderClient.current?.sendChatStatus({
        frequency: status.frequency,
        mode:      status.mode,
        bw_low:    status.bandwidthLow,
        bw_high:   status.bandwidthHigh,
        zoom_bw:   view?.binBandwidth ?? 0,
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [myCallsign, status.frequency, status.mode, status.bandwidthLow, status.bandwidthHigh]);

  // Tune/zoom sync IN: follow another user's tune (skin syncToUser)
  const applyChatSync = useCallback((u: ChatUserRow) => {
    if (!u.frequency || !u.mode) return;
    onTuneHzRef.current?.(u.frequency);
    const m = u.mode.toLowerCase();
    if (m in MODE_BANDWIDTHS) onModeRef.current?.(m as SDRMode);
    if (typeof u.bw_low === 'number' && typeof u.bw_high === 'number') {
      onFilterBothRef.current?.(u.bw_low, u.bw_high);
    }
    if (zoomSyncRef.current && u.zoom_bw && u.zoom_bw > 0) {
      client.current?.zoom(u.frequency, u.zoom_bw);
    }
  }, []);

  const toggleUserSync = useCallback((username: string) => {
    setSyncedUser((prev: string | null) => {
      const next = prev === username ? null : username;
      if (next) {
        const u = chatUsersRef.current.find((x: ChatUserRow) => x.username === next);
        if (u) applyChatSync(u);
      }
      return next;
    });
  }, [applyChatSync]);

  // One-shot: tap a user row to jump to their frequency without following
  const chatUserTap = useCallback((u: ChatUserRow) => {
    applyChatSync(u);
  }, [applyChatSync]);

  const chatUsersRef = useRef<ChatUserRow[]>([]);
  useEffect(() => { chatUsersRef.current = chatUsers; }, [chatUsers]);
  const chatIdRef = useRef(0);

  // chat_user_update broadcasts arrive whenever ANY user on the instance
  // retunes — on a busy instance that's several per second, and each
  // setChatUsers re-renders the entire screen tree (the historic CPU
  // killer). Maintain the list in the ref always; only touch React state
  // while the drawer is actually open (synced on open).
  const updateChatUsers = useCallback((fn: (prev: ChatUserRow[]) => ChatUserRow[]) => {
    chatUsersRef.current = fn(chatUsersRef.current);
    if (chatOpenRef.current) setChatUsers(chatUsersRef.current);
  }, []);

  // One-time heads-up about OWRX's profile model: pausing disconnects, and a
  // later reconnect resets the receiver to its server-side default profile/freq
  // (we can't persist server profile state across a fresh session without
  // hijacking it). Shown once per install when first connected to an OWRX server.
  useEffect(() => {
    if (!connected || (route.params.serverType ?? 'ubersdr') !== 'owrx') return;
    AsyncStorage.getItem('owrx_pause_warning_seen').then((seen: string | null) => {
      if (seen) return;
      AsyncStorage.setItem('owrx_pause_warning_seen', '1').catch(() => {});
      Alert.alert(
        'OpenWebRX — note on pausing',
        'OpenWebRX receivers use server-side profiles. If you pause from the lock screen, VibeSDR disconnects to free the receiver — and reconnecting resets it to the server’s default profile and frequency. (Locking the screen while playing keeps audio going; this only applies to an explicit pause.)',
        [{ text: 'Got it' }],
      );
    }).catch(() => {});
  }, [connected]);

  // Handler refs — the decoder-client effect below builds its callbacks once
  // per connect, but tune/mode/filter handlers are declared later in the file
  const onTuneHzRef    = useRef<((hz: number) => void) | null>(null);
  const onModeRef      = useRef<((m: SDRMode) => void) | null>(null);
  const onFilterBothRef = useRef<((low: number, high: number) => void) | null>(null);
  const onVtsJumpRef   = useRef<((d: 'left' | 'right') => void) | null>(null);
  const onSearchTuneRef = useRef<((hz: number, mode?: string | null, isBand?: boolean, voiceStep?: boolean) => void) | null>(null);

  // ── Media skip mode: lock-screen ⏮⏭ tune by step or jump bookmarks ───────
  const [mediaSkip, setMediaSkip] = useState<'step' | 'bookmark'>('step');
  const mediaSkipRef = useRef(mediaSkip);
  useEffect(() => { mediaSkipRef.current = mediaSkip; }, [mediaSkip]);
  // Lock-screen ⏮⏭ step-tune for backends whose tuning lives in JS (OWRX/Kiwi):
  // native delegates via VibeSkip rather than tuning its own WS. Snaps to the
  // step grid (matching the native UberSDR path + the VFO drum). Registered in a
  // ref so the once-mounted native event listener calls the latest closure.
  // DAB mode: ⏮⏭ cycle the ensemble's programmes instead of tuning (VFO locked).
  // Reassigned each render so it sees the current programme list + selection.
  const dabSkipRef = useRef<((dir: 'left' | 'right') => void) | null>(null);
  dabSkipRef.current = (dir: 'left' | 'right') => {
    const c = client.current; if (!c || dabProgrammes.length === 0) return;
    const idx = dabProgrammes.findIndex((p) => p.id === activeDabId);
    const next = dir === 'right'
      ? (idx + 1) % dabProgrammes.length
      : (idx - 1 + dabProgrammes.length) % dabProgrammes.length;
    const id = dabProgrammes[next].id;
    c.setAudioServiceId?.(id);
    setActiveDabId(id);
  };
  const mediaStepSkipRef = useRef<((dir: 'left' | 'right') => void) | null>(null);
  mediaStepSkipRef.current = (dir: 'left' | 'right') => {
    const c = client.current; if (!c) return;
    if (String(c.getStatus().mode) === 'dab') return;   // DAB locked to its ensemble
    const s = stepRef.current; if (!(s > 0)) return;
    const cur = c.getStatus().frequency;
    const snapped = dir === 'right'
      ? (Math.floor(cur / s) + 1) * s
      : (Math.ceil(cur / s) - 1) * s;
    const [loHz, hiHz] = c.caps.freqRange;
    const newHz = Math.max(loHz, Math.min(hiHz, snapped));
    if (newHz === cur) return;
    c.tune(newHz, undefined, { recenter: true });   // media-control skip = discrete jump
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: newHz }));
  };
  useEffect(() => {
    AsyncStorage.getItem('lsv_media_skip').then((v: string | null) => {
      if (v === 'bookmark' || v === 'step') setMediaSkip(v);
    }).catch(() => {});
  }, []);
  const onMediaSkip = useCallback((m: 'step' | 'bookmark') => {
    setMediaSkip(m);
    AsyncStorage.setItem('lsv_media_skip', m).catch(() => {});
  }, []);
  // Push to native; re-push on reconnect (the Android service can be recreated)
  useEffect(() => {
    VibePowerModule?.setMediaSkipMode(mediaSkip);
  }, [mediaSkip, connected]);

  // ── Pause = disconnect / Play = reconnect ─────────────────────────────────
  // Pause drops the SDR (the server lets it go on suspend anyway) and Play does
  // a full reconnect. If that reconnect doesn't land within a few seconds (server
  // full / rate-limited) we flag it so the lock-screen card + an in-app banner
  // tell the user to open the app.
  const [reconnectFailedUi, setReconnectFailedUi] = useState(false);
  const connectedRef = useRef(false);
  useEffect(() => {
    connectedRef.current = connected;
    if (connected) { VibePowerModule?.setReconnectFailed?.(false); setReconnectFailedUi(false); }
    // Siri: when live, the intent emits the command now; otherwise it stashes it.
    VibePowerModule?.setVoiceConnected?.(connected);
  }, [connected]);

  // (Re)apply the network notch to the audio engine whenever the connection is up
  // or the toggle changes. Local sources are notched in the shim, not here.
  useEffect(() => {
    if (!isLocal && connected) VibePowerModule?.setNotch?.(netNotch);
  }, [connected, netNotch, isLocal]);

  // The squelch gate is a persistent native flag (iOS VibePowerModule is a
  // singleton). Make sure non-Kiwi sessions start open, and always release the
  // gate on unmount so a closed Kiwi squelch can't silence the next session.
  useEffect(() => {
    const setOpen = (NativeModules.VibePowerModule as { setSquelchOpen?: (o: boolean) => void })?.setSquelchOpen;
    if (!isKiwi) setOpen?.(true);
    return () => { kiwiSqOpenRef.current = true; setOpen?.(true); };
  }, [isKiwi]);

  // Car-connected flag (iOS car-audio route / Android Auto client), updated by
  // the VibeCarConnected native event. Band-aware auto mode/step no longer gates
  // on this (it now fires for all non-hands-on tuning — see vtsCheck); kept for
  // potential car-specific behaviour later.
  const carConnected = useRef(false);

  // Chat drawer doesn't fit landscape even on a 17 Pro Max (let alone SE) —
  // the button stays live for the unread pulse, but opening demands portrait.
  const [chatRotateHint, setChatRotateHint] = useState(false);
  const chatHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showChatRotateHint = useCallback(() => {
    setChatRotateHint(true);
    if (chatHintTimer.current) clearTimeout(chatHintTimer.current);
    chatHintTimer.current = setTimeout(() => setChatRotateHint(false), 2500);
  }, []);
  useEffect(() => () => {
    if (chatHintTimer.current) clearTimeout(chatHintTimer.current);
  }, []);

  const openChat = useCallback(() => {
    if (isLandscape) { showChatRotateHint(); return; }
    // Prime the chat stream (history replay arrives quiet) even before join
    decoderClient.current?.subscribeChat();
    setChatUsers(chatUsersRef.current);  // ref is live; state only while open
    setChatOpen(true);
    setChatUnread(false);
  }, [isLandscape, showChatRotateHint]);

  const closeChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  // Rotating to landscape with chat open → close it and explain why
  useEffect(() => {
    if (isLandscape && chatOpen) {
      setChatOpen(false);
      showChatRotateHint();
    }
  }, [isLandscape, chatOpen, showChatRotateHint]);

  // Android back gesture/button: CONSUME it on this screen (iOS parity —
  // gestureEnabled:false on the stack). Edge swipes while working the VFO
  // drum were popping to the picker / exiting the app. Close transient UI
  // if open; leaving the instance is the menu's ← BACK button. RN Modals
  // (menu, maps, browser) intercept back themselves before this fires.
  const chatOpenRef = useRef(false);
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (chatOpenRef.current) setChatOpen(false);
      return true;  // consumed — never pop the screen from a gesture
    });
    return () => sub.remove();
  }, []);

  // ── Decoder ───────────────────────────────────────────────────────────────

  const [activeDecoder,  setActiveDecoder]  = useState<DecoderType>(null);
  const [decoderText,    setDecoderText]    = useState('');
  const [decoderStatus,  setDecoderStatus]  = useState('listening…');
  const [decoding,       setDecoding]       = useState(false);
  const [pillBottom,     setPillBottom]     = useState(200); // updated by pill layout
  const [rootH,          setRootH]          = useState(0);   // measured root height
  const pillYRef = useRef<number | null>(null);
  // Re-derive pillBottom once the root measures (or rotates) — the pill's
  // own onLayout may have fired first with a stale height
  useEffect(() => {
    if (rootH > 0 && pillYRef.current != null) setPillBottom(rootH - pillYRef.current);
  }, [rootH]);

  // Real decoders — UberSDR server audio extensions over /ws/dxcluster,
  // exactly as the confirmed-working skin wires them (see DecoderClient.ts).
  // Uses the SAME session uuid as audio so the extension taps this session's
  // demodulated stream server-side. DEC_SIM fake data is gone.
  const decoderClient   = useRef<DecoderClient | null>(null);
  const decoderImageRef = useRef<DecoderImageHandle | null>(null);
  const activeDecRef    = useRef<DecoderType>(null);

  // Decoder transport base. Local/UberSDR serve /ws/dxcluster themselves; Kiwi
  // (no dxcluster) gets a native decoder sidecar fed its audio, so we point the
  // DecoderClient at that localhost service instead.
  const [decoderBase, setDecoderBase] = useState<string | null>(isKiwi ? null : baseUrl);
  useEffect(() => {
    if (!isKiwi) { setDecoderBase(baseUrl); return; }
    let cancelled = false;
    (NativeModules as any).VibeLocalSDR?.startDecoderService?.()
      .then((port: number) => { if (!cancelled && port > 0) setDecoderBase(`ws://127.0.0.1:${port}`); })
      .catch(() => {});
    return () => {
      cancelled = true;
      (NativeModules as any).VibeLocalSDR?.stopDecoderService?.();
    };
  }, [isKiwi, baseUrl]);

  useEffect(() => {
    if (!decoderBase) return;
    const dc = new DecoderClient(decoderBase, sessionUuid, {
      onText: (text: string) => {
        setDecoding(true);
        setDecoderText((prev: string) => {
          const next = prev + text;
          return next.length > 3000 ? next.slice(next.length - 3000) : next;
        });
      },
      onStatus: (s: string)  => setDecoderStatus(s),
      onDot:    (d)          => setDecoding(d === 'active' || d === 'rx'),
      // WEFAX/SSTV — drive the panel's image canvas (skin canvas parity).
      // WEFAX lines are greyscale, SSTV lines are RGB; route by active decoder.
      onImageStart: (w: number, h: number) => decoderImageRef.current?.imageStart(w, h),
      onImageLine:  (ln: number, w: number, px: Uint8Array) => {
        if (activeDecRef.current === 'sstv') decoderImageRef.current?.sstvLine(ln, w, px);
        else                                 decoderImageRef.current?.wefaxLine(ln, w, px);
      },
      onImageDone: ()            => decoderImageRef.current?.imageDone(),
      onError:     (msg: string) => setDecoderStatus('error: ' + msg),
      onSpot: (s) => {
        if (s.kind !== spotsKindRef.current) return;
        spotBufRef.current.push(s); // flushed by the 400ms tick — no setState here
      },
      // ── Chat (same WS) — replayed history arrives quiet (no unread pulse),
      //    duplicates are dropped in DecoderClient before reaching here ──────
      onChatMessage: (user: string, text: string, ts: string, isHistory: boolean) => {
        const own = user === myCallsignRef.current;
        setChatMessages((prev: ChatMessage[]) => [
          ...prev.slice(-99),
          { id: 'c' + String(++chatIdRef.current),
            type: own ? 'own' : 'other', user, text, ts: chatTs(ts) },
        ]);
        if (!isHistory && !own && !chatMutedRef.current) {
          setChatOpen((open: boolean) => {
            if (!open) setChatUnread(true);
            return open;
          });
        }
      },
      onChatJoined: (username: string, isHistory: boolean) => {
        if (!isHistory) addChatMsg(mkMsg('system', `${username} joined the chat`), true);
        decoderClient.current?.requestChatUsers();
      },
      onChatLeft: (username: string, isHistory: boolean) => {
        if (!isHistory) addChatMsg(mkMsg('system', `${username} left the chat`), true);
        updateChatUsers((prev: ChatUserRow[]) =>
          prev.filter((u: ChatUserRow) => u.username !== username));
        setSyncedUser((prev: string | null) => (prev === username ? null : prev));
      },
      onChatUsers: (users: ChatUserRow[]) => updateChatUsers(() => users),
      onChatUserUpdate: (u: ChatUserRow) => {
        updateChatUsers((prev: ChatUserRow[]) => {
          const i = prev.findIndex((x: ChatUserRow) => x.username === u.username);
          if (i < 0) return [...prev, u];
          const next = [...prev];
          next[i] = { ...next[i], ...u };
          return next;
        });
        // Following this user → mirror their tune
        if (u.username === syncedUserRef.current) applyChatSync(u);
      },
      onChatError: (msg: string) => {
        addChatMsg(mkMsg('system', `⚠ ${msg}`), true);
        // Join rejected (taken/invalid/profane) → back to the join flow
        if (/username|callsign/i.test(msg)) {
          setMyCallsign(null);
          AsyncStorage.removeItem('lsv_chat_callsign:' + baseUrl).catch(() => {});
        }
      },
    }, password);
    decoderClient.current = dc;

    // Saved callsign → auto-join on connect (skin autoLogin parity); the
    // chat stream then stays live for unread pulses without opening the
    // drawer. Runs here so the client exists before joinChat fires.
    let cancelled = false;
    AsyncStorage.getItem('lsv_chat_callsign:' + baseUrl).then((cs: string | null) => {
      if (cancelled || !cs) return;
      setMyCallsign(cs);
      dc.joinChat(cs);
    }).catch(() => {});

    return () => { cancelled = true; dc.destroy(); decoderClient.current = null; };
  // decoderBase is async for Kiwi (null until the native decoder sidecar's port
  // arrives from startDecoderService) — it MUST be a dep, or the DecoderClient is
  // never (re)built when the port lands, leaving Kiwi decoders/spots with no output.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, sessionUuid, decoderBase]);

  // Selected decoder mode — persists across stop/start (skin _mode vs _on)
  const [selDecoder, setSelDecoder] =
    useState<'rtty'|'navtex'|'wefax'|'sstv'|'morse'|'whisper'|null>(null);

  // Digital/CW spots — share the dxcluster WS; mutually exclusive with decoders.
  // Spots are BUFFERED in a ref and flushed to state on a 400ms tick: the
  // server replays its whole buffer on subscribe (hundreds of messages in a
  // burst) and a setState per spot re-renders the entire screen tree — that's
  // what stuttered the waterfall. The skin never had this because DOM rows
  // append incrementally.
  const [spotsKind, setSpotsKind] = useState<SpotsKind | null>(null);
  const [spots,     setSpots]     = useState<SpotRow[]>([]);
  const spotsKindRef  = useRef<SpotsKind | null>(null);
  const spotBufRef    = useRef<SpotRow[]>([]);
  const spotTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  // Receiver position for FT8 spot distances (+ the on-device-decoder map).
  // Kiwi: server gps=(lat,lon) via onReceiverLoc. Local hardware: the phone's GPS
  // (same permission as instance-list distance sorting); null until resolved.
  const recvLocRef = useRef<{ lat: number; lon: number } | null>(null);
  const [recvLoc, setRecvLoc] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    getUserLocation().then(loc => {
      if (cancelled || !loc) return;
      recvLocRef.current = loc; setRecvLoc(loc);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isLocal]);

  const stopSpotFlush = useCallback(() => {
    if (spotTimerRef.current) { clearInterval(spotTimerRef.current); spotTimerRef.current = null; }
    spotBufRef.current = [];
  }, []);

  const startSpotFlush = useCallback(() => {
    stopSpotFlush();
    spotTimerRef.current = setInterval(() => {
      const buf = spotBufRef.current;
      if (buf.length === 0) return;
      spotBufRef.current = [];
      // On-device decoder (Local/Kiwi) sends a TX grid + callsign but no distance
      // or country — derive both here. UberSDR spots already carry them.
      const rx = recvLocRef.current;
      for (const s of buf) {
        if (s.distKm == null && s.grid && rx) s.distKm = distanceKmToGrid(rx, s.grid);
        if (!s.country && s.call) s.country = countryForCallsign(s.call);
      }
      buf.reverse(); // arrival order oldest→newest; display newest first
      setSpots((prev: SpotRow[]) => {
        const next = buf.concat(prev);
        return next.length > 200 ? next.slice(0, 200) : next;
      });
    }, 400);
  }, [stopSpotFlush]);

  useEffect(() => stopSpotFlush, [stopSpotFlush]); // clear on unmount

  const openDecoder = useCallback((type: DecoderType) => {
    setActiveDecoder(type);
    activeDecRef.current = type;
    setDecoderText('');
    setDecoderStatus('listening…');
    setDecoding(false);
    decoderImageRef.current?.reset();
    if (!type) return;
    if (type === 'ft8') {
      // FT8 is not an audio extension — it's served instance-wide via the
      // Digital Spots feed (decoder_feed / digi spots APIs), not per-session.
      setDecoderStatus('FT8 arrives via Digital Spots — see Server Extensions');
      return;
    }
    decoderClient.current?.start(type);
  }, []);

  const closeDecoder = useCallback(() => {
    decoderClient.current?.stop();
    decoderImageRef.current?.reset();
    setActiveDecoder(null);
    activeDecRef.current = null;
    setDecoding(false);
    setDecoderText('');
    setDecoderStatus('listening…');
  }, []);

  const stopSpots = useCallback(() => {
    decoderClient.current?.stopSpots();
    spotsKindRef.current = null;
    setSpotsKind(null);
    stopSpotFlush();
  }, [stopSpotFlush]);

  // Menu decoder toggle — skin semantics: same mode running → stop (selection
  // kept, settings stay visible); otherwise select + start. Menu stays open.
  // Spots and audio decoders share the panel — starting one stops the other.
  const onDecToggle = useCallback((m: 'rtty'|'navtex'|'wefax'|'sstv'|'morse'|'whisper') => {
    if (activeDecRef.current === m) {
      closeDecoder();
      setSelDecoder(m); // closeDecoder clears running state; keep selection
    } else {
      stopSpots();
      setSelDecoder(m);
      openDecoder(m);
    }
  }, [closeDecoder, openDecoder, stopSpots]);

  // Spots toggle (menu Server Extensions DIGITAL/CW — skin lsvSpots)
  const onSpotsToggle = useCallback((k: SpotsKind) => {
    if (spotsKindRef.current === k) {
      stopSpots();
    } else {
      closeDecoder();
      setSpots([]);
      spotsKindRef.current = k;
      setSpotsKind(k);
      startSpotFlush();
      decoderClient.current?.startSpots(k);
    }
  }, [closeDecoder, stopSpots, startSpotFlush]);

  // RTTY settings — applying requires a re-attach (server reads params at attach)
  const [rttySettings, setRttySettings] = useState<RttySettings>({ ...RTTY_PRESETS.ham });
  const onRttySettings = useCallback((s: RttySettings) => {
    setRttySettings(s);
    const dc = decoderClient.current;
    if (!dc) return;
    dc.rttySettings = { ...s };
    if (activeDecRef.current === 'rtty') {
      setDecoderStatus('re-attaching…');
      dc.start('rtty');
    }
  }, []);

  // Morse quality — client-side filter in DecoderClient, no re-attach needed
  const [morseQuality, setMorseQuality] = useState<MorseQuality>('all');
  const onMorseQuality = useCallback((q: MorseQuality) => {
    setMorseQuality(q);
    if (decoderClient.current) decoderClient.current.morseQuality = q;
  }, []);

  // WEFAX LPM — same re-attach rule
  const [wefaxLpm, setWefaxLpm] = useState(120);
  const onWefaxLpm = useCallback((lpm: number) => {
    setWefaxLpm(lpm);
    const dc = decoderClient.current;
    if (!dc) return;
    dc.wefaxLpm = lpm;
    if (activeDecRef.current === 'wefax') {
      setDecoderStatus('re-attaching…');
      dc.start('wefax');
    }
  }, []);

  // ── Display style — wired to ThemeContext so the whole app re-renders ────────
  const { themeName, setTheme } = useTheme();
  const displayStyle = themeName;
  const handleDisplayStyle = useCallback((s: 'amber' | 'white') => {
    setTheme(s);
  }, [setTheme]);

  // ── Media control tune events (iOS lock screen) ───────────────────────────

  const dspSeen = useRef(false);
  useEffect(() => {
    // Both platforms expose VibePowerModule with the same events now
    const emitter = new NativeEventEmitter(NativeModules.VibePowerModule);
    const sub = emitter.addListener('VibeTuned', (e: { frequency: number; mode: string }) => {
      const c = client.current;
      c?.syncFrequency(e.frequency, e.mode as SDRMode);
      setStatus((prev: SDRStatus) => ({ ...prev, frequency: e.frequency, ...(e.mode ? { mode: e.mode as SDRMode } : {}) }));
      // Media-control skips tune blind from the lock screen / car stereo —
      // recentre the view on EVERY skip so the VFO stays centred and the
      // waterfall moves around it (drum-style; Stuart's design). Skips made
      // while the spectrum WS is paused (locked) land in view.centerHz and
      // the onopen view-restore replays them on unlock.
      c?.pan(e.frequency);
    });
    const subMute = emitter.addListener('VibeMuted', (e: { muted: boolean }) => {
      setIsMuted(!!e.muted);
      // OWRX: pause releases the lock-screen controls (native) and disconnects —
      // there's no play-to-reconnect because an OWRX reconnect resets the server
      // profile. Close the WS and show the in-app reconnect prompt so the user
      // reconnects deliberately (the warning explains the reset).
      if (e.muted && (route.params.serverType ?? 'ubersdr') === 'owrx') {
        client.current?.disconnectSocket?.();
        setDataSaverOff(true);
      }
    });
    // radiod channel SNR (basebandPower − noiseDensity); −30 corrects the +30 dB
    // audio-stream floor offset so the meter reads honest dB.
    const subSig = emitter.addListener('VibeSignal', (e: { snr: number }) => {
      audioSnrRef.current = e.snr - 30;
    });
    // Native ⏮⏭ defer to JS. Bookmark mode jumps the station list; step mode
    // (used by OWRX/Kiwi, whose tuning lives in JS) snaps by the tune step.
    const subSkip = emitter.addListener('VibeSkip', (e: { direction: string }) => {
      const dir = e.direction === 'prev' ? 'left' : 'right';
      // DAB: cycle programmes within the ensemble (the VFO is locked there).
      if (String(client.current?.getStatus().mode) === 'dab') { dabSkipRef.current?.(dir); return; }
      if (mediaSkipRef.current === 'bookmark') onVtsJumpRef.current?.(dir);
      else mediaStepSkipRef.current?.(dir);
    });
    // Car audio route / Android Auto client connect — gates band-aware auto
    // mode/step (handheld use is never auto-switched).
    const subCar = emitter.addListener('VibeCarConnected', (e: { connected: boolean }) => {
      carConnected.current = !!e.connected;
    });
    // Car browse list pick (Android Auto / CarPlay) — tune via the shared
    // onSearchTune path so band-aware mode/step + region logic stay in one place.
    const subCarTune = emitter.addListener('VibeCarTune',
      (e: { frequency: number; mode?: string | null; isBand?: boolean }) => {
        onSearchTuneRef.current?.(e.frequency, e.mode ?? null, !!e.isBand);
      });
    // Siri voice command — native passes the spoken text + kind; JS resolves and
    // applies (tune: frequency/bookmark/band via searchStations + band mode/step;
    // mode: synonyms; step: nearest supported rate).
    const subVoice = emitter.addListener('VibeVoiceQuery', (e: { query: string; kind?: string }) => {
      if (e.kind === 'step') { const s = parseVoiceStep(e.query); if (s != null) setStep(s); return; }
      if (e.kind === 'mode') { const m = parseVoiceMode(e.query); if (m) onModeRef.current?.(m); return; }
      const r = resolveVoiceQuery(e.query, vtsBookmarks.current, searchBandsRef.current);
      if (r) onSearchTuneRef.current?.(r.hz, r.mode, r.isBand, true);
    });
    // Data saver dropped the stream — tear down the spectrum too (native already
    // closed the audio WS) and surface the reconnect prompt.
    const subDsOff = emitter.addListener('VibeDataSaverDisconnect', () => {
      setDataSaverOff(true);
      // UberSDR: native already closed the audio WS; just pause the spectrum WS.
      // OWRX/Kiwi: close the WS to free the server slot but KEEP the native audio
      // session (so the lock-screen disconnect card shows); a fresh adapter is
      // built on resume via fullReconnect. (destroy() would drop the card.)
      if ((route.params.serverType ?? 'ubersdr') === 'ubersdr') client.current?.pauseSpectrum();
      else client.current?.disconnectSocket?.();
    });
    // Resume from a data-saver disconnect (Play / unmute / banner tap). Reopening
    // the old session's sockets lands in a broken half-state (frozen waterfall +
    // zoom, no audio), so do a FULL from-scratch reconnect with a fresh uuid.
    const subDsOn = emitter.addListener('VibeDataSaverResume', () => {
      setDataSaverOff(false);
      setIsMuted(false);
      fullReconnect();
    });
    // Server-NR protocol messages arrive as text on the native audio WS
    const subWs = emitter.addListener('VibeWsText', (e: { text: string }) => {
      let msg: { type?: string; info?: Record<string, unknown> };
      try { msg = JSON.parse(e.text); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      const info = (msg.info ?? msg) as Record<string, unknown>;
      if (msg.type === 'dsp_filters') {
        dspSeen.current = true;
        const filters = (info.available ? (info.filters as DspFilterDesc[] | undefined) : []) ?? [];
        setDspFilters(filters);
        if (filters.length) {
          const name = filters.some((f: DspFilterDesc) => f.name === dspFilterRef.current)
            ? dspFilterRef.current : filters[0].name;
          setServerDspFilter(name);
          if (Object.keys(dspParamsRef.current).length === 0) {
            applyDspParams(dspDefaults(filters.find((f: DspFilterDesc) => f.name === name)));
          }
        }
      } else if (msg.type === 'dsp_status') {
        setServerDspEnabled(!!info.enabled);
        if (typeof info.filter === 'string' && info.filter) setServerDspFilter(info.filter);
        if (info.enabled && info.params && typeof info.params === 'object') {
          const merged = { ...dspParamsRef.current };
          for (const [k, v] of Object.entries(info.params as Record<string, unknown>)) {
            merged[k] = String(v);
          }
          applyDspParams(merged);
        }
      } else if (msg.type === 'dsp_error') {
        setDspError(String(info.error ?? 'DSP error'));
        setTimeout(() => setDspError(null), 4000);
      }
    });
    return () => {
      sub.remove(); subMute.remove(); subSig.remove(); subSkip.remove(); subWs.remove();
      subCar.remove(); subCarTune.remove(); subVoice.remove(); subDsOff.remove(); subDsOn.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Discover server-NR filters once the native audio WS is up (it opens on
  // mount; retries cover slow connects). No dsp_filters reply / available:
  // false ⇒ section stays hidden.
  useEffect(() => {
    const tries = [2000, 6000, 12000].map((ms) => setTimeout(() => {
      if (!dspSeen.current) sendAudioCmd({ type: 'get_dsp_filters' });
    }, ms));
    return () => tries.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────

  useEffect(() => {
    destroyed.current = false;
    const c = createBackend(route.params.serverType ?? 'ubersdr', baseUrl, sessionUuid, {
      // (callbacks below; bypass password rides every WS URL)
      onConnect:    () => { if (!destroyed.current) { setConnected(true); setServerLost(false); setServerBusy(false); setConnLost(false); if (connLostTimer.current) { clearTimeout(connLostTimer.current); connLostTimer.current = null; } } },
      onDisconnect: () => { if (!destroyed.current) setConnected(false); },
      onServerLost: () => {
        // OWRX server crashed/restarted. Keep the app alive, free the dead audio
        // engine, and surface the wait-and-reconnect prompt (no auto-reconnect —
        // the server is usually still restarting).
        if (destroyed.current) return;
        setServerLost(true);
        (VibePowerModule as any)?.stopExternalAudio?.();
      },
      onServerBusy: () => {
        if (destroyed.current) return;
        setServerBusy(true);
        (VibePowerModule as any)?.stopExternalAudio?.();
      },
      onReceiverLon: (lon) => { if (!destroyed.current) setRecvLon(lon); },
      onReceiverLoc: (lat, lon) => { recvLocRef.current = { lat, lon }; if (!destroyed.current) setRecvLoc({ lat, lon }); },
      onLink: (q) => {
        if (destroyed.current) return;
        const b = meterBus.current;
        b.emit({ ...b.value, link: q });
        // UberSDR auto-reconnects silently — without a cue the app just looks
        // frozen when the link drops (e.g. the instance reboots). But the spectrum
        // is deliberately paused on minimise/resume, which briefly starves the
        // link to 0 with audio still fine — so DEBOUNCE: only pop after a sustained
        // drop, and cancel the instant the link recovers. OWRX/Kiwi use serverLost.
        if ((route.params.serverType ?? 'ubersdr') === 'ubersdr' && appActiveRef.current) {
          if (q === 0) {
            if (!connLostTimer.current) {
              connLostTimer.current = setTimeout(() => {
                connLostTimer.current = null;
                if (!destroyed.current) setConnLost(true);
              }, 3000);
            }
          } else {
            if (connLostTimer.current) { clearTimeout(connLostTimer.current); connLostTimer.current = null; }
            setConnLost(false);
          }
        }
      },
      onStatus:     (s) => { if (!destroyed.current) setStatus(s); },
      onSMeter:     (dbm) => { if (!destroyed.current) { owrxSmeterRef.current = dbm; if (isKiwi) evalKiwiSquelch(dbm); } },
      onProfiles:   (list) => { if (!destroyed.current) setProfiles(list); },
      onSdrUsage:   (m) => { if (!destroyed.current) setSdrUsage(m); },
      onClients:    (n) => { if (!destroyed.current) setClientCount(n); },
      onChatEnabled: (en) => { if (!destroyed.current) setChatEnabled(en); },
      onServerInfo: (info) => { if (!destroyed.current) { setServerLabel(info.name); setServerVersion(info.version || null); } },
      onChatMessage: (name, text) => {
        // OWRX basic text chat (name + text). Server echoes our own back, so
        // don't local-echo on send — render the broadcast and mark own by name.
        if (destroyed.current) return;
        const own = name === myCallsignRef.current;
        setChatMessages((prev: ChatMessage[]) => [
          ...prev.slice(-99),
          { id: 'c' + String(++chatIdRef.current), type: own ? 'own' : 'other', user: name, text, ts: chatTs(new Date().toISOString()) },
        ]);
        if (!own && !chatMutedRef.current && !chatOpenRef.current) setChatUnread(true);
      },
      onModes:      (list) => { if (!destroyed.current) setServerModes(list); },
      onBookmarks:  (list) => {
        // OWRX server bookmarks/dial markers (over the WS) → same path as
        // UberSDR's fetched bookmarks: VTS station readout + search bar.
        if (!destroyed.current) setServerBookmarks(list.map((b) => ({ name: b.name, frequency: b.frequency, mode: b.mode, repeater: b.repeater, source: 'server' as const })));
      },
      onDecoderText: (line, replace) => {
        // OWRX server-side text decoders (Packet/POCSAG/ADSB/…) → the decoder
        // text panel. `replace` (ADS-B live list) supersedes the buffer.
        if (destroyed.current) return;
        // Auto-open the panel if decode output arrives without a manual pick
        // (e.g. a profile whose start_mod is a standalone decoder like ADSB).
        if (!activeDecRef.current) {
          const dec = (client.current as any)?.getSecondaryDecoder?.() ?? null;
          const dt: DecoderType = dec === 'sstv' ? 'sstv' : dec === 'fax' ? 'wefax' : dec ? (dec as unknown as DecoderType) : null;
          if (dt) { activeDecRef.current = dt; setActiveDecoder(dt); }
        }
        setDecoding(true);
        if (replace) { setDecoderText(line); return; }
        // Append raw — the adapter newline-terminates records and char-stream
        // decoders (RTTY/CW) carry their own line breaks.
        setDecoderText((prev: string) => {
          const next = prev + line;
          return next.length > 4000 ? next.slice(next.length - 4000) : next;
        });
      },
      onDecoderImage: (ev) => {
        // OWRX decodes SSTV/Fax server-side and streams scanlines — paint them
        // on the SAME decoder canvas UberSDR uses (Fax → 'wefax' greyscale path).
        if (destroyed.current) return;
        const dt: DecoderType = ev.kind === 'sstv' ? 'sstv' : 'wefax';
        if (activeDecRef.current !== dt) { activeDecRef.current = dt; setActiveDecoder(dt); }
        if (ev.phase === 'start') { decoderImageRef.current?.imageStart(ev.width, ev.height); setDecoderStatus(`receiving ${ev.width}x${ev.height}`); }
        else if (ev.phase === 'line') {
          if (ev.kind === 'sstv') decoderImageRef.current?.sstvLine(ev.line, ev.width, ev.pixels);
          else                    decoderImageRef.current?.wefaxLine(ev.line, ev.width, ev.pixels);
        } else { decoderImageRef.current?.imageDone(); }
      },
      onMetadata:   (meta) => {
        if (destroyed.current) return;
        // RDS (FM) / DAB labels feed the SAME station display as bookmarks (VTS),
        // so a live station name shows uniformly regardless of source.
        liveStationRef.current = meta.stationName ?? '';
        liveBadgeRef.current = meta.badge;
        setLiveStation({ name: meta.stationName, text: meta.text, badge: meta.badge });
        if (typeof meta.stereo === 'boolean') setFmStereo(meta.stereo);
        // meta.programmes is the full cached list (DAB) or [] (explicit clear);
        // RDS messages omit it entirely (undefined) → leave the picker untouched.
        if (meta.programmes) {
          setDabProgrammes(meta.programmes);
          // Mirror the server's default (first programme) so the picker reflects
          // what's actually playing until the user picks another.
          setActiveDabId((cur) => meta.programmes!.some((p) => p.id === cur)
            ? cur : (meta.programmes![0]?.id ?? 0));
          // Auto-apply this station's remembered speed correction.
          if (meta.stationName) applyDabStation(meta.ensemble ?? '', meta.stationName);
        }
      },
      onSpectrum:   (newBins, s) => {
        if (destroyed.current) return;
        // Waterfall/spectrum render imperatively — no React state per frame.
        wfFrameSink.current?.(newBins, s);
        // Geometry/status drives the React overlay (band plan, readouts) —
        // only update when something actually changed (settled frames don't).
        // Epsilon gate: radiod's per-frame frequency stamps can jitter ±1Hz —
        // exact comparison leaked ~3-5 full-tree renders/s while settled
        // (render-counter diagnostic 2026-06-11). Sub-2Hz wobble is invisible
        // at any usable span; real changes pass untouched.
        setStatus((prev: SDRStatus) =>
          Math.abs(prev.centerHz - s.centerHz) < 2 &&
          Math.abs(prev.bwHz - s.bwHz) < 2 &&
          prev.frequency === s.frequency && prev.mode === s.mode &&
          prev.bandwidthLow === s.bandwidthLow && prev.bandwidthHigh === s.bandwidthHigh &&
          prev.binCount === s.binCount &&
          Math.abs(prev.binBandwidth - s.binBandwidth) < 1e-6
            ? prev : s);
        // ── Derive signal level + SNR from bins ────────────────────────────
        // Full data rate (~10Hz) — updates only re-render the two meter leaf
        // widgets via the bus, so there's no need to throttle anymore.
        // Find peak bin power in the current bandwidth window
        if (newBins.length > 0) {
          const len = newBins.length;
          // Peak in the audio passband window — feeds the dBFS / S-meter modes.
          const bwFrac = Math.min(1, (s.bandwidthHigh - s.bandwidthLow) / Math.max(1, s.bwHz));
          const half = Math.floor((bwFrac * len) / 2);
          const mid = Math.floor(len / 2);
          let peak = -200;
          for (let i = Math.max(0, mid - half); i <= Math.min(len - 1, mid + half); i++) {
            if (newBins[i] > peak) peak = newBins[i];
          }
          // SNR comes from radiod's channel status (audioSnrRef), NOT the spectrum
          // — the demodulator's own measurement of the tuned channel, so it's
          // independent of zoom (this is how UberSDR's meter works). 0 until the
          // first reading lands.
          let snrDb = audioSnrRef.current ?? 0;
          // Local SDR has no radiod SNR feed, so derive it from the spectrum:
          // passband peak minus the noise floor (mean of all bins ≈ the floor
          // for a mostly-empty spectrum). Cheap (no per-frame sort) and gives a
          // meaningful, zoom-tolerant reading.
          if (isLocal) {
            let sum = 0;
            for (let i = 0; i < len; i++) sum += newBins[i];
            const floor = sum / len;
            snrDb = Math.max(0, peak - floor);
          }
          // OWRX exposes a real channel S-meter (dBm) over the control WS but no
          // SNR. When present it's the honest absolute level source (and, lacking
          // an SNR feed, drives the bar in every mode); otherwise fall back to
          // the spectrum-derived peak as before.
          const owrxDbm = owrxSmeterRef.current;
          const levelDbm = owrxDbm ?? peak;
          // Bar source follows the meter mode: SNR uses the compression curve
          // (sigNorm, calibrated for honest 0–50 dB); S-meter/dBFS use the
          // absolute level mapping off the dBm level. OWRX's smeter dB spans
          // roughly −110 (noise) … −10 (strong), a different scale to UberSDR's
          // spectrum, so it gets its own linear mapping.
          const norm = owrxDbm != null
            ? Math.max(0, Math.min(1, (owrxDbm + 110) / 100))
            : signalModeRef.current === 'snr'
              ? sigNorm(snrDb)
              : Math.max(0, Math.min(1, (peak + 130) / 90));
          // Skin-feel smoothing rescaled for 10Hz updates (the skin's 0.55/0.18
          // alphas assumed its ~60Hz rAF loop — at 10Hz they felt sluggish).
          const sm = meterSmooth.current;
          sm.level += (norm > sm.level ? 0.85 : 0.35) * (norm - sm.level);
          if (sm.level >= sm.peak)   { sm.peak = sm.level; sm.hold = 15; }
          else if (sm.hold > 0)      { sm.hold--; }
          else                       { sm.peak = Math.max(0, sm.peak - 0.02); }
          meterBus.current.emit({
            level: sm.level, peak: sm.peak, snr: snrDb, dbfs: levelDbm,
            active: owrxDbm != null ? owrxDbm > -110 : snrDb > 6,
            link: meterBus.current.value.link,
          });
        }
      },
      onError: (msg) => {
        if (destroyed.current) return;
        // Rate-limited / blocked → straight to the bypass-password box (the
        // instance password gets around per-IP limits); other errors offer
        // both routes.
        if (/429|rate.?limit|too many|refused|denied|blocked|busy/i.test(msg)) {
          setPwPrompt(true);
        } else {
          Alert.alert('Connection Error', msg, [
            { text: 'Back to Instances', onPress: () => navigation.goBack() },
            { text: 'Enter Password', onPress: () => setPwPrompt(true) },
          ]);
        }
      },
    }, password, !!route.params.isLocal);
    client.current = c;
    // Apply the persisted VFO-lock follow mode to the fresh connection.
    c.setFollowMode(vfoLockedRef.current);
    // Local hardware: thread the live device sample rate for panSpan()'s window.
    if (route.params.isLocal) (c as { setLocalSampleRate?: (hz: number) => void }).setLocalSampleRate?.(hwSampleRate);
    // QoL: restore the last frequency/mode used on THIS instance before
    // connecting (the hardcoded default landed on the 20m FT8 squeal every
    // launch). Falls back to the default tune on first visit / bad data.
    let cancelled = false;
    AsyncStorage.getItem(route.params.isLocal ? 'lsv_last_tune:local' : 'lsv_last_tune:' + baseUrl).then((j: string | null) => {
      if (cancelled || destroyed.current) return;
      let f = status.frequency;
      let m: SDRMode = status.mode;
      if (j) {
        try {
          const p = JSON.parse(j) as { frequency?: unknown; mode?: unknown };
          if (typeof p.frequency === 'number' && p.frequency >= MIN_HZ && p.frequency <= MAX_HZ) {
            f = Math.round(p.frequency);
          }
          if (typeof p.mode === 'string' && p.mode in MODE_BANDWIDTHS) m = p.mode as SDRMode;
        } catch {}
      }
      const bw = MODE_BANDWIDTHS[m];
      setStatus((prev: SDRStatus) => ({
        ...prev, frequency: f, mode: m,
        ...(bw ? { bandwidthLow: bw[0], bandwidthHigh: bw[1] } : {}),
      }));
      lastTuneLoaded.current = true;
      setTuneLoaded(true);
      // A server crash/refused connection rejects this — swallow it (onDisconnect
      // drives the UI). An unhandled rejection here can escalate to a hard crash.
      c.connect(f, m).catch(() => {});
    }).catch(() => {
      if (cancelled || destroyed.current) return;
      lastTuneLoaded.current = true;
      setTuneLoaded(true);
      c.connect(status.frequency, status.mode).catch(() => {});
    });
    return () => { cancelled = true; destroyed.current = true; c.destroy(); client.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, connEpoch]);

  // Persist the tune (debounced — the drum changes frequency rapidly) so the
  // next visit to this instance resumes where you left off.
  const lastTuneLoaded = useRef(false);
  // Bypass-password prompt — rate-limited/blocked connections show this
  // directly (the instance password gets around per-IP limits); submitting
  // replaces the screen with a fresh session carrying the password on every
  // WS URL (audio, spectrum, dxcluster).
  const [pwPrompt, setPwPrompt] = useState(false);

  // Audio engine start is GATED on the restore (ms-fast): the engine used to
  // start with the default 14.074/USB in the audio-WS URL and the corrective
  // restore tune could lose the race against the WS handshake — server stayed
  // on 20m FT8/USB while the UI showed the restored station (sounded like
  // "broken AM"), and zoom anchored on the stale server frequency.
  const [tuneLoaded, setTuneLoaded] = useState(false);

  // Initial-connect timeout: if the link never comes up (e.g. a wedged local
  // shim, dead host, or USB not ready) there's no error event to surface an
  // escape — the screen just spins forever. After 15s with no connection, show
  // a "couldn't connect" card with an escape back to the instance list.
  useEffect(() => {
    if (connected) { setConnTimedOut(false); return; }
    const t = setTimeout(() => { if (!destroyed.current && !connected) setConnTimedOut(true); }, 15000);
    return () => clearTimeout(t);
  }, [connected]);

  useEffect(() => {
    if (!lastTuneLoaded.current || !status.frequency) return;
    const t = setTimeout(() => {
      // Local hardware's baseUrl has a per-session port → use a stable key so
      // the last tune restores (otherwise it reverts to the 14 MHz default).
      AsyncStorage.setItem(route.params.isLocal ? 'lsv_last_tune:local' : 'lsv_last_tune:' + baseUrl,
        JSON.stringify({ frequency: status.frequency, mode: status.mode })).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [status.frequency, status.mode, baseUrl]);

  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state: string) => {
      if (state !== 'active') {
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        // Backgrounded: the spectrum pause starves the link to 0, but that's NOT
        // a disconnect (audio keeps playing). Suppress the connection-lost popup
        // while backgrounded and reset it so a long lock can't leave it armed.
        appActiveRef.current = false;
        if (connLostTimer.current) { clearTimeout(connLostTimer.current); connLostTimer.current = null; }
        setConnLost(false);
        client.current?.pauseSpectrum();
      } else if (dataSaverOffRef.current) {
        appActiveRef.current = true;
        // Opened the app after a data-saver disconnect (the Play event may not
        // survive suspension): do a full from-scratch reconnect.
        setDataSaverOff(false);
        setIsMuted(false);
        fullReconnect();
      } else {
        // Instant zombie-socket check — after a background suspension the
        // audio WS can be half-open (server reaped the session, socket never
        // errors) leaving audio+spectrum dead until relaunch. The native
        // watchdog also catches this within ~8s; this makes it immediate.
        // OWRX/Kiwi audio is JS-owned (no native WS) — revive() would resurrect a
        // UberSDR audio WS underneath the foreign stream, so only the native Opus
        // engine (ubersdr) is revived here.
        if ((route.params.serverType ?? 'ubersdr') === 'ubersdr') {
          (NativeModules.VibePowerModule as { revive?: () => void })?.revive?.();
        }
        // Reopen the spectrum only AFTER the audio session re-registers
        // server-side: the spectrum WS subscribes to that same session, so if it
        // reopens first it gets no frames and the waterfall stays frozen (the bug
        // where you had to back out to instances and reconnect). connect() uses
        // the same audio-first-then-1s ordering; mirror it here.
        appActiveRef.current = true;
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => { resumeTimer = null; client.current?.resumeSpectrum(); }, 1200);
      }
    });
    return () => { if (resumeTimer) clearTimeout(resumeTimer); sub.remove(); };
  }, []);

  // ── Smooth tune / idle saver ──────────────────────────────────────────────
  // Touches on RNGH surfaces (waterfall, drums) bypass the JS responder chain,
  // so interaction is marked BOTH in the root capture handler (catches all
  // Pressable UI) and at the top of each gesture callback below.
  const IDLE_SLOW_MS = 30_000;
  const IDLE_DIVISOR = 3; // skin default-waterfall parity

  const lastInteractRef = useRef(Date.now());
  const idleActiveRef   = useRef(false);

  const markInteract = useCallback(() => {
    lastInteractRef.current = Date.now();
    if (idleActiveRef.current) {
      idleActiveRef.current = false;
      client.current?.setRate(1); // wake: full data rate immediately
    }
  }, []);

  useEffect(() => {
    if (!idleSlow) {
      if (idleActiveRef.current) {
        idleActiveRef.current = false;
        client.current?.setRate(1);
      }
      return;
    }
    idleActiveRef.current = false; // new client (baseUrl) starts at divisor 1
    const t = setInterval(() => {
      if (!idleActiveRef.current &&
          Date.now() - lastInteractRef.current > IDLE_SLOW_MS) {
        idleActiveRef.current = true;
        client.current?.setRate(IDLE_DIVISOR);
      }
    }, 5000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleSlow, baseUrl]); // baseUrl: new client starts at divisor 1

  const onSmoothTune = useCallback((v: boolean) => {
    setSmoothTune(v);
    AsyncStorage.setItem('lsv_smooth_tune', v ? '1' : '0').catch(() => {});
  }, []);

  const onIdleSlow = useCallback((v: boolean) => {
    setIdleSlow(v);
    AsyncStorage.setItem('lsv_idle_slow', v ? '1' : '0').catch(() => {});
  }, []);

  const onFrameRate = useCallback((v: 'native'|'20fps'|'30fps') => {
    setFrameRate(v);
    AsyncStorage.setItem('lsv_frame_rate', v).catch(() => {});
  }, []);

  // ── Drum sensitivity (NORMAL / PRECISE) ──────────────────────────────────
  const [drumMode, setDrumMode] = useState<'normal'|'precise'>('normal');
  const drumModeRef = useRef<'normal'|'precise'>('normal');
  useEffect(() => {
    AsyncStorage.getItem('lsv_drum_sens').then((v: string | null) => {
      if (v === 'normal' || v === 'precise') { setDrumMode(v); drumModeRef.current = v; }
    }).catch(() => {});
  }, []);
  const onDrumMode = useCallback((m: 'normal'|'precise') => {
    setDrumMode(m);
    drumModeRef.current = m;
    AsyncStorage.setItem('lsv_drum_sens', m).catch(() => {});
  }, []);

  // ✦ HAPTICS toggle — was UI-only (props never passed from here, and the
  // drums ticked unconditionally). Module-level switch in DrumWheel.
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  useEffect(() => {
    AsyncStorage.getItem('lsv_haptics').then((v: string | null) => {
      if (v === '0') { setHapticsEnabled(false); setDrumHaptics(false); }
    }).catch(() => {});
  }, []);
  const onHaptics = useCallback((on: boolean) => {
    setHapticsEnabled(on);
    setDrumHaptics(on);
    AsyncStorage.setItem('lsv_haptics', on ? '1' : '0').catch(() => {});
  }, []);

  // ── VFO drum ──────────────────────────────────────────────────────────────
  // Skin-parity step tuning (vSendDelta + vDown from Scalable_Mobile_UI v6.3.1):
  //   - pending accumulates in Hz: px × step / pxPerStep (velocity-adaptive)
  //   - tunes ONLY in whole steps: steps = round(pending / step)
  //   - baseline snaps to the step grid, so frequency always lands on a
  //     multiple of the step rate (7,153,000 — never 7,153,437)
  const vfoPendingHz = useRef(0);
  const vfoVel = useRef({ t: 0, v: 0 }); // EMA thumb speed, px/s

  const onVfoDelta = useCallback((pxDelta: number) => {
    const c = client.current; if (!c) return;
    // DAB is locked to its ensemble block — VFO tuning just knocks it off the mux
    // (kills the decode, and the block is hard to re-find). Ignore drum input.
    if (String(c.getStatus().mode) === 'dab') return;
    markInteract();
    const s = stepRef.current;
    // Velocity-adaptive sensitivity: EMA of |px|/dt. A gesture gap resets to
    // 0 so a fresh slow touch starts fully fine; a fast flick's EMA catches
    // up within 2–3 events. The fine↔fast blend is continuous, so easing off
    // mid-spin onto a signal tightens the rate immediately.
    const now = Date.now();
    const gap = now - vfoVel.current.t;
    vfoVel.current.t = now;
    if (gap > 300) {
      vfoVel.current.v = 0;
    } else {
      const inst = Math.abs(pxDelta) / (Math.max(8, gap) / 1000);
      vfoVel.current.v = vfoVel.current.v * 0.7 + inst * 0.3;
    }
    const k = Math.max(0, Math.min(1,
      (vfoVel.current.v - VFO_VEL_FINE) / (VFO_VEL_FAST - VFO_VEL_FINE)));
    const pxPerStep = DRUM_SENS[drumModeRef.current].vfo
      * (VFO_FINE_MULT - (VFO_FINE_MULT - 1) * k);
    vfoPendingHz.current += (pxDelta * s) / pxPerStep;
    const steps = Math.round(vfoPendingHz.current / s);
    if (!steps) return;
    vfoPendingHz.current -= steps * s;
    const cur     = c.getStatus().frequency;
    const snapped = Math.round(cur / s) * s;   // vDown grid snap
    const [loHz, hiHz] = c.caps.freqRange;     // backend range (OWRX VHF/UHF ≠ 0–30 MHz)
    const newHz   = Math.max(loHz, Math.min(hiHz, snapped + steps * s));
    if (newHz === cur) return;
    c.tune(newHz);
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: newHz }));
  }, []);

  // ── BW drum ───────────────────────────────────────────────────────────────

  // Gesture accumulator: drum ticks arrive as small px deltas (rounding them
  // per-event gives factor 1 = no-op), and the server snaps binBandwidth to a
  // ladder (small factors snap back to the same step). So compound the whole
  // gesture from the bandwidth captured at gesture start.
  // VFO-anchored zoom: every zoom path (menu ±, zoom drum, pinch) anchors on
  // the tuned frequency when it's inside the current span — a fresh connect
  // sits on the server's default full-span view, so centre-anchored zooms
  // dove into mid-band (≈15MHz) instead of the restored station. Falls back
  // to the view centre when the VFO has been panned out of sight.
  const zoomAnchorHz = useCallback((s: SDRStatus): number => {
    const c = client.current; if (!c) return s.centerHz;
    const span  = s.binBandwidth * (s.binCount || 1024);
    const tuned = c.getStatus().frequency;
    return tuned && span > 0 && Math.abs(tuned - s.centerHz) < span / 2
      ? tuned : s.centerHz;
  }, []);

  const bwZoomAcc = useRef({ base: 0, px: 0, t: 0 });
  const onBwDelta = useCallback((pxDelta: number) => {
    const c = client.current; if (!c) return;
    markInteract();
    const s = c.getView(); // predicted view — getStatus() is one RTT stale mid-gesture
    if (!s.binBandwidth || !s.centerHz || !s.binCount) return;
    const a = bwZoomAcc.current;
    const now = Date.now();
    if (now - a.t > 400 || !a.base) { a.base = s.binBandwidth; a.px = 0; }
    a.t = now;
    a.px += pxDelta;
    // Drum px per zoom octave (2×) — PRECISE nearly doubles the travel
    c.zoom(zoomAnchorHz(s), Math.max(0.5,
      a.base * Math.pow(0.5, a.px / DRUM_SENS[drumModeRef.current].zoomOctave)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const c = client.current; if (!c) return;
    const v = c.getView(); if (!v.binBandwidth || !v.centerHz) return;
    c.zoom(zoomAnchorHz(v), Math.max(1, v.binBandwidth * factor));
  }, [zoomAnchorHz]);
  const onZoomIn  = useCallback(() => zoomBy(0.5), [zoomBy]);
  const onZoomOut = useCallback(() => zoomBy(2),   [zoomBy]);

  // Toggle: SET DEFAULT when this instance isn't the default, CLEAR when it is
  const [isDefault, setIsDefault] = useState(false);
  useEffect(() => {
    getDefaultInstance()
      .then((d) => setIsDefault(!!d && d.url === baseUrl))
      .catch(() => {});
  }, [baseUrl]);

  const onSetDefault = useCallback(() => {
    if (isDefault) {
      clearDefaultInstance()
        .then(() => {
          setIsDefault(false);
          Alert.alert('Default Cleared', 'No default instance is set.');
        })
        .catch(() => {});
    } else {
      setDefaultInstance({ name: instanceName ?? baseUrl, url: baseUrl })
        .then(() => {
          setIsDefault(true);
          Alert.alert('Default Set', `${instanceName ?? baseUrl} is now your default instance.`);
        })
        .catch(() => {});
    }
  }, [baseUrl, instanceName, isDefault]);

  // ── Waterfall gestures ────────────────────────────────────────────────────

  const onWfPanDelta = useCallback((dxPx: number) => {
    const c = client.current; if (!c) return;
    if (vfoLockedRef.current) return;                 // no free pan while locked
    markInteract();
    // Predicted view: pan() updates it synchronously, so successive deltas
    // compound correctly. Re-basing on getStatus() made every delta in an RTT
    // window re-apply from the same stale centre (rubber-banding).
    const s = c.getView(); if (!s.bwHz || !s.centerHz) return;
    const span = c.panSpan();
    const target = s.centerHz + Math.round((dxPx / screenW) * s.bwHz);
    // Silently clamp at the boundary walls (the visible walls show the limit;
    // no toast — per Stuart, VTS pop-ups caused more trouble than they solved).
    let clamped: number;
    if (span.movable) {
      // Local Fs window: span bounds the CENTRE directly (keeps the VFO inside
      // the capture window; the VFO itself may leave the visible view).
      clamped = Math.max(span.loHz, Math.min(span.hiHz, target));
    } else {
      // Hard walls (band edge / profile / rx range): keep the whole VIEW inside.
      const half = s.bwHz / 2;
      const loC = span.loHz + half, hiC = span.hiHz - half;
      clamped = loC <= hiC ? Math.max(loC, Math.min(hiC, target))
                           : Math.round((span.loHz + span.hiHz) / 2);
    }
    c.pan(clamped);
  }, [screenW]);

  // Same gesture-accumulator pattern as the BW drum (ladder snap-back).
  const wfZoomAcc = useRef({ base: 0, f: 1, t: 0 });
  const wfZoomBy = useCallback((factor: number) => {
    const c = client.current; if (!c) return;
    markInteract();
    const s = c.getView(); if (!s.binBandwidth || !s.centerHz) return;
    const a = wfZoomAcc.current;
    const now = Date.now();
    if (now - a.t > 400 || !a.base) { a.base = s.binBandwidth; a.f = 1; }
    a.t = now;
    a.f *= factor;
    c.zoom(zoomAnchorHz(s), Math.max(0.5, a.base * a.f));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWfZoomDelta = useCallback((dyPx: number) => {
    wfZoomBy(Math.pow(0.985, dyPx));
  }, [wfZoomBy]);

  const onWfPinchZoom = useCallback((scaleDelta: number) => {
    wfZoomBy(1 / scaleDelta);
  }, [wfZoomBy]);

  const onWfTapTune = useCallback((hz: number) => {
    const c = client.current; if (!c) return;
    if (String(c.getStatus().mode) === 'dab') return;   // DAB locked to its ensemble block
    markInteract();
    const [loHz, hiHz] = c.caps.freqRange;
    const clamped = Math.max(loHz, Math.min(hiHz, hz));
    c.tune(clamped);
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: clamped }));
  }, []);

  // ── Mode / filter / tune ──────────────────────────────────────────────────

  const onMode = useCallback((m: SDRMode) => {
    const c = client.current; if (!c) return;
    c.setMode(m); // client mirrors the server's per-mode bandwidth defaults
    setStatus({ ...c.getStatus() });
    if (m !== 'wfm') setFmStereo(false);  // stereo icon only applies to WFM
    // OWRX image decoders (SSTV/Fax) ride on top of the analog carrier — sync the
    // decoder canvas to the adapter's REAL decoder state (it auto-keeps/clears the
    // decoder when the carrier changes), so changing the carrier doesn't close it.
    if (route.params.serverType === 'owrx') {
      // Image decoders → the Skia canvas (sstv/wefax); any other secondary
      // decoder (packet/pocsag/adsb/…) → the text panel, titled by its mode id.
      const dec = c.getSecondaryDecoder?.() ?? null;
      const dt: DecoderType = dec === 'sstv' ? 'sstv'
        : dec === 'fax' ? 'wefax'
        : dec ? (dec as unknown as DecoderType) : null;
      if (dt !== activeDecRef.current) {
        if (dt) {
          decoderImageRef.current?.reset();
          setDecoderText('');
          activeDecRef.current = dt; setActiveDecoder(dt);
          setDecoderStatus('listening…');
        } else { activeDecRef.current = null; setActiveDecoder(null); }
      }
    }
  }, [route.params.serverType]);

  // Atomic both-edges setter — single setBandwidth, no stale-closure edge
  const onFilterBoth = useCallback((low: number, high: number) => {
    client.current?.setBandwidth(low, high);
    setStatus((prev: SDRStatus) => ({ ...prev, bandwidthLow: low, bandwidthHigh: high }));
  }, []);

  const onFilterLow  = useCallback((v: number) => { client.current?.setBandwidth(v, status.bandwidthHigh); setStatus((prev: SDRStatus) => ({ ...prev, bandwidthLow: v })); }, [status.bandwidthHigh]);
  const onFilterHigh = useCallback((v: number) => { client.current?.setBandwidth(status.bandwidthLow, v);  setStatus((prev: SDRStatus) => ({ ...prev, bandwidthHigh: v })); }, [status.bandwidthLow]);

  // ── Audio-WS commands (set_dsp / squelch / gate are AUDIO-WS message types;
  //    the spectrum WS doesn't know them — the old client.setNRMode/setDsp
  //    paths were sending into the void) ──────────────────────────────────────
  const sendAudioCmd = useCallback((obj: Record<string, unknown>) => {
    VibePowerModule?.sendAudioCommand(JSON.stringify(obj));
  }, []);

  // ── NR cycle: off → nr → nr2 — native Swift DSP (VibeDSP.swift skin ports)
  const onNrMode = useCallback((mode: 'off'|'nr'|'nr2') => {
    setNrMode(mode);
    VibePowerModule?.setNrMode(mode);  // Android: accepted no-op (port pending)
  }, []);

  // ── NB toggle — native Swift noise blanker ────────────────────────────────
  const onNb = useCallback((on: boolean) => {
    setNb(on);
    VibePowerModule?.setNoiseBlanker(on);  // Android: accepted no-op (port pending)
  }, []);

  // ── SNR squelch (audio gate) ──────────────────────────────────────────────
  // The slider/state are in OUR meter's units (spectrum-derived passband
  // SNR). The server gates on radiod's raw audio-stream SNR, which reads
  // ~30dB higher (floors at ~30 — madpsy/ka9q_ubersdr#77, same offset the
  // signal meter compensates for), so shift +30 on the wire.
  const onSnrSquelch = useCallback((minSnr: number) => {
    setSnrSquelch(minSnr);
    sendAudioCmd({ type: 'set_audio_gate', min_snr: minSnr <= -999 ? -999 : minSnr + 30 });
  }, [sendAudioCmd]);

  // ── FM squelch ────────────────────────────────────────────────────────────
  const onFmSquelch = useCallback((db: number) => {
    setFmSquelch(db);
    sendAudioCmd({ type: 'set_squelch', squelchOpen: db });
  }, [sendAudioCmd]);

  // radiod creates FM channels with its own DEFAULT squelch — entering
  // fm/nfm must re-assert the app's squelch state (default −999 = always
  // open), otherwise marginal signals cut in and out while the UI says
  // "Open". Delayed so the server has re-created the radiod channel after
  // the mode tune.
  const fmSquelchRef = useRef(fmSquelch);
  useEffect(() => { fmSquelchRef.current = fmSquelch; }, [fmSquelch]);
  useEffect(() => {
    if (status.mode !== 'fm' && status.mode !== 'nfm') return;
    const t = setTimeout(() => {
      sendAudioCmd({ type: 'set_squelch', squelchOpen: fmSquelchRef.current });
    }, 700);
    return () => clearTimeout(t);
  }, [status.mode, sendAudioCmd]);

  // ── Server-side NR (DSP insert) ───────────────────────────────────────────
  // Ref mirrors so the WS-event listener and debounced senders read current
  // values without re-subscribing.
  const dspFiltersRef       = useRef<DspFilterDesc[]>([]);
  const dspFilterRef        = useRef('');
  const dspParamsRef        = useRef<Record<string,string>>({});
  const serverDspEnabledRef = useRef(false);
  useEffect(() => { dspFiltersRef.current = dspFilters; },             [dspFilters]);
  useEffect(() => { dspFilterRef.current = serverDspFilter; },         [serverDspFilter]);
  useEffect(() => { serverDspEnabledRef.current = serverDspEnabled; }, [serverDspEnabled]);

  const dspDefaults = useCallback((f?: DspFilterDesc): Record<string,string> => {
    const out: Record<string,string> = {};
    for (const p of f?.params ?? []) {
      if (p.runtime_safe === false) continue;
      out[p.name] = p.default ?? p.min ?? '0';
    }
    return out;
  }, []);

  const applyDspParams = useCallback((p: Record<string,string>) => {
    dspParamsRef.current = p;
    setServerDspParams(p);
  }, []);

  const onServerDsp = useCallback((enabled: boolean) => {
    setServerDspEnabled(enabled);  // optimistic — dsp_status confirms
    if (isKiwi) {
      client.current?.setDsp?.(enabled, dspFilterRef.current, dspParamsRef.current);
      return;
    }
    if (enabled) {
      sendAudioCmd({ type: 'set_dsp', enabled: true,
                     filter: dspFilterRef.current, params: dspParamsRef.current });
      // Server NR replaces client NR — the menu NR button locks to SERV
      setNrMode('off');
      VibePowerModule?.setNrMode('off');
    } else {
      sendAudioCmd({ type: 'set_dsp', enabled: false });
    }
  }, [sendAudioCmd, isKiwi]);

  const onServerDspFilter = useCallback((name: string) => {
    setServerDspFilter(name);
    const defs = dspDefaults(dspFiltersRef.current.find((f: DspFilterDesc) => f.name === name));
    applyDspParams(defs);
    if (isKiwi) {
      if (serverDspEnabledRef.current) client.current?.setDspFilter?.(name, defs);
      return;
    }
    if (serverDspEnabledRef.current) {
      sendAudioCmd({ type: 'set_dsp', enabled: true, filter: name, params: defs });
    }
  }, [sendAudioCmd, dspDefaults, applyDspParams, isKiwi]);

  // Param edits send the FULL params map, debounced 120ms (skin parity)
  const dspParamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onServerDspParam = useCallback((name: string, value: string) => {
    const next = { ...dspParamsRef.current, [name]: value };
    applyDspParams(next);
    if (dspParamTimer.current) clearTimeout(dspParamTimer.current);
    dspParamTimer.current = setTimeout(() => {
      if (!serverDspEnabledRef.current) return;
      if (isKiwi) client.current?.setDspParams?.(dspParamsRef.current);
      else sendAudioCmd({ type: 'set_dsp_params', params: dspParamsRef.current });
    }, 120);
  }, [sendAudioCmd, applyDspParams, isKiwi]);
  useEffect(() => () => {
    if (dspParamTimer.current) clearTimeout(dspParamTimer.current);
  }, []);

  const onTuneHz = useCallback((hz: number) => {
    const c = client.current; if (!c) return;
    markInteract();
    const [loHz, hiHz] = c.caps.freqRange;
    const clamped = Math.max(loHz, Math.min(hiHz, hz));
    // Discrete jump (freq modal, bookmark/VTS, Siri, search) → always land
    // centred, regardless of the VFO lock.
    c.tune(clamped, undefined, { recenter: true });
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: clamped }));
  }, []);

  // Late-bound handler refs for the chat-sync engine (declared above the
  // decoder-client effect, which captures them in its callbacks)
  useEffect(() => {
    onTuneHzRef.current    = onTuneHz;
    onModeRef.current      = onMode;
    onFilterBothRef.current = onFilterBoth;
    onVtsJumpRef.current   = onVtsJump;
    onSearchTuneRef.current = onSearchTune;
  });

  // ── Share — deep link into this station (web-UI URL params; skin parity:
  //    the skin shared window.location.href which carries the same params) ──
  const onShareStation = useCallback(async () => {
    const c = client.current;
    let url = `${baseUrl.replace(/\/+$/, '')}/?freq=${Math.round(status.frequency)}`
      + `&mode=${status.mode}`
      + `&bwl=${Math.round(status.bandwidthLow)}&bwh=${Math.round(status.bandwidthHigh)}`;
    const v = c?.getView();
    if (v && v.binBandwidth > 0) {
      const span = v.binBandwidth * (v.binCount || 1024);
      if (span < 29_000_000) {  // only when actually zoomed in
        url += `&zoom_freq=${Math.round(v.centerHz)}&zoom_bw=${v.binBandwidth.toFixed(1)}`;
      }
    }
    const label = `VibeSDR — ${(status.frequency / 1e3).toFixed(3)} kHz ${status.mode.toUpperCase()}`;
    try {
      // iOS shares a real URL object (tappable everywhere); Android targets
      // ignore the url field, so embed it in the message text instead
      await Share.share(Platform.OS === 'ios'
        ? { url, message: label }
        : { message: `${label}\n${url}` });
    } catch {}
  }, [baseUrl, status.frequency, status.mode, status.bandwidthLow, status.bandwidthHigh]);

  // ── VTS (station/band steward — a11y popup bar only, no tuning guide) ─────
  // Stations come from /api/bookmarks (static config + live EiBi schedule);
  // popup shows the station name when within 150kHz (green when within 99Hz),
  // and band-plan info when crossing a band boundary. Menu arrows jump
  // bookmarks; an arrow jump defers any band notif 3s so the station name
  // shows first (skin VTS_ARROW_BOOKMARK_MS).
  // ITU region drives the MW channel step (9 kHz region 1, 10 kHz region 2/3).
  // Prefer the RECEIVER longitude (passed by the directory, which knows it); fall
  // back to the user's device longitude when we don't have it (default/favourite
  // reconnects, OWRX, custom URLs) so it isn't left at region 0 → wrong 10 kHz.
  // ITU region (MW 9/10 kHz) is a property of WHERE THE RECEIVER IS — not the
  // listener (a European on a US receiver wants 10 kHz). So use the receiver's
  // own longitude only: from the directory (serverLongitude) or the server's
  // status page (recvLon via onReceiverLon — OWRX/UberSDR /status.json,
  // KiwiSDR /status). NOT the device location.
  const [recvLon, setRecvLon] = useState<number | null>(null);
  const ituRegion = useMemo(
    () => deriveItuRegion(route.params.serverLongitude ?? recvLon),
    [recvLon],   // eslint-disable-line react-hooks/exhaustive-deps
  );
  const vtsBookmarks = useRef<ServerBookmark[]>([]);
  const [searchBookmarks, setSearchBookmarks] = useState<ServerBookmark[]>([]);
  const [searchBands,     setSearchBands]     = useState<ServerBand[]>([]);
  const searchBandsRef = useRef<ServerBand[]>([]);
  useEffect(() => { searchBandsRef.current = searchBands; }, [searchBands]);
  // Cold-launch Siri ("open VibeSDR and tune to …"): once connected + bookmarks
  // loaded, apply the pending spoken query the native intent stashed.
  const pendingVoiceDone = useRef(false);
  useEffect(() => {
    if (!connected || pendingVoiceDone.current) return;
    pendingVoiceDone.current = true;
    VibePowerModule?.getPendingVoiceQuery?.().then((json: string | null) => {
      if (!json) return;
      let cmd: { kind?: string; query?: string };
      try { cmd = JSON.parse(json); } catch { return; }
      const q = cmd.query ?? '';
      setTimeout(() => {   // bookmarks land shortly after connect
        if (cmd.kind === 'step') { const s = parseVoiceStep(q); if (s != null) setStep(s); }
        else if (cmd.kind === 'mode') { const m = parseVoiceMode(q); if (m) onModeRef.current?.(m); }
        else {
          const r = resolveVoiceQuery(q, vtsBookmarks.current, searchBandsRef.current);
          if (r) onSearchTuneRef.current?.(r.hz, r.mode, r.isBand, true);
        }
      }, 1500);
    }).catch(() => {});
  }, [connected]);
  const [vtsNotif,        setVtsNotif]        = useState<VtsNotifData | null>(null);
  const vtsKey            = useRef(0);
  const vtsLastStation    = useRef('');
  const vtsBandKey        = useRef<string | null>(null);
  const vtsBandInit       = useRef(false);
  const vtsArrowJumpUntil = useRef(0);
  const vtsDeferredBand   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [vtsMenuName, setVtsMenuName] = useState('');
  const [vtsMenuFreq, setVtsMenuFreq] = useState<number | undefined>(undefined);

  const [serverBookmarks, setServerBookmarks] = useState<ServerBookmark[]>([]);
  const [userBookmarks,   setUserBookmarks]   = useState<UserBookmark[]>([]);
  // EiBi shortwave schedule — the on-device fallback bookmark set. Toggleable
  // (some people find it too busy); used only when the backend has no server
  // bookmarks of its own. Persisted in lsv_eibi_enabled.
  const [eibiEnabled,   setEibiEnabled]   = useState(true);
  const [eibiBookmarks, setEibiBookmarks] = useState<ServerBookmark[]>([]);
  useEffect(() => {
    AsyncStorage.getItem('lsv_eibi_enabled').then((v) => { if (v === '0') setEibiEnabled(false); }).catch(() => {});
  }, []);
  const onEibiToggle = useCallback((on: boolean) => {
    setEibiEnabled(on);
    AsyncStorage.setItem('lsv_eibi_enabled', on ? '1' : '0').catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const st = route.params.serverType ?? 'ubersdr';
    // OUR band plan is ALWAYS the search bar's band list, on every backend (the
    // server /api/bands only exists on UberSDR; Kiwi/OWRX have none).
    setSearchBands(BAND_PLAN.map((b: Band) => ({
      label: b.bandLabel ?? b.name, start: b.lo, end: b.hi, group: b.type, mode: b.mode,
    })));
    // Server bookmarks: UberSDR via REST; OWRX/Kiwi arrive over the WS
    // (onBookmarks, tagged source='server' there); local hardware has none.
    // Whatever a backend yields is preferred; if it yields nothing, the EiBi
    // fallback below fills in — that's how Kiwi/local get a searchable list.
    if (!isLocal && st === 'ubersdr') {
      const load = () => {
        fetchBookmarks(baseUrl)
          .then((b: ServerBookmark[]) => { if (!cancelled) setServerBookmarks(b.map((x) => ({ ...x, source: 'server' as const }))); })
          .catch(() => { if (!cancelled) setServerBookmarks([]); });
      };
      load();
      refreshBandSnr(baseUrl);
      const iv = setInterval(load, 10 * 60_000);
      loadUserBookmarks().then((b: UserBookmark[]) => { if (!cancelled) setUserBookmarks(b); }).catch(() => {});
      return () => { cancelled = true; clearInterval(iv); };
    }
    // OWRX: the WS onBookmarks callback populates serverBookmarks. Kiwi/local:
    // none, so clear any stale set from a previous instance → EiBi takes over.
    if (st !== 'owrx') setServerBookmarks([]);
    loadUserBookmarks().then((b: UserBookmark[]) => { if (!cancelled) setUserBookmarks(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, [baseUrl]);

  // EiBi fallback set — loaded when enabled, refreshed as the schedule rolls.
  // Used only when the backend gave us no server bookmarks (see the merge).
  useEffect(() => {
    if (!eibiEnabled) { setEibiBookmarks([]); return; }
    let cancelled = false;
    const load = () => { loadActiveEibi().then((b) => { if (!cancelled) setEibiBookmarks(b); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 10 * 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [eibiEnabled]);

  // Server (or EiBi fallback) + user bookmarks merged — feeds the VTS lookups AND
  // the search bar identically. User entries win name+freq collisions. Each
  // carries a `source` so the VTS can show its origin icon.
  useEffect(() => {
    const mine = bookmarksForInstance(userBookmarks, baseUrl);
    const seen = new Set(mine.map((b: UserBookmark) => `${b.name}|${b.frequency}`));
    const fallback = serverBookmarks.length > 0 ? serverBookmarks : (eibiEnabled ? eibiBookmarks : []);
    const merged: ServerBookmark[] = [
      ...mine.map((b: UserBookmark) => ({
        name: b.name, frequency: b.frequency, mode: b.mode,
        group: b.group ?? undefined, comment: b.comment ?? undefined,
        bandwidth_low: b.bandwidth_low ?? undefined,
        bandwidth_high: b.bandwidth_high ?? undefined,
        source: 'user' as const,
      })),
      ...fallback.filter((b: ServerBookmark) => !seen.has(`${b.name}|${b.frequency}`)),
    ];
    vtsBookmarks.current = merged;
    setSearchBookmarks(merged);
    pushCarBrowse(merged);
  }, [serverBookmarks, eibiBookmarks, eibiEnabled, userBookmarks, baseUrl, ituRegion]);

  // Push the car browse tree (Bookmarks + Band Plan folders) to the native
  // media-browser service. Bookmarks come from the merged list; the band plan is
  // region-deduped. Native caches it and serves Android Auto / CarPlay; a no-op
  // until a car connects. mediaId encodes freq|mode|step|isBand for the tap.
  const pushCarBrowse = useCallback((bookmarks: ServerBookmark[]) => {
    const bandSeen = new Set<string>();
    const bands = BAND_PLAN.filter((b: Band) => {
      if (b.regions && b.regions.length && ituRegion && !b.regions.includes(ituRegion)) return false;
      if (bandSeen.has(b.name)) return false;
      bandSeen.add(b.name);
      return true;
    }).map((b: Band) => ({
      name: b.name, frequency: b.lo, mode: b.mode ?? null, step: b.step ?? 0,
    }));
    const payload = {
      bookmarks: bookmarks.map((b: ServerBookmark) => ({
        name: b.name, frequency: b.frequency, mode: b.mode ?? null,
      })),
      bands,
    };
    VibePowerModule?.setBrowseItems?.(JSON.stringify(payload));
  }, [ituRegion]);

  // ── User bookmark management (menu BOOKMARKS pane) ────────────────────────
  const persistUserBookmarks = useCallback((next: UserBookmark[]) => {
    setUserBookmarks(next);
    saveUserBookmarks(next).catch(() => {});
  }, []);

  const onAddBookmark = useCallback((name: string, allInstances: boolean) => {
    const clean = name.trim();
    if (!clean) return;
    const bm: UserBookmark = {
      name:           clean,
      frequency:      Math.round(status.frequency),
      mode:           status.mode,
      bandwidth_low:  status.bandwidthLow,
      bandwidth_high: status.bandwidthHigh,
      group:          null, comment: null, extension: null,
      scope:          allInstances ? '' : baseUrl,
    };
    persistUserBookmarks(mergeBookmarks(userBookmarks, [bm]));
  }, [status.frequency, status.mode, status.bandwidthLow, status.bandwidthHigh,
      baseUrl, userBookmarks, persistUserBookmarks]);

  // The menu's saved list should show only what applies to THIS instance —
  // global ('') + this-instance — not bookmarks scoped to OTHER instances (a
  // 'this instance only' bookmark was showing on every instance's list).
  const visibleBookmarks = useMemo(
    () => bookmarksForInstance(userBookmarks, baseUrl),
    [userBookmarks, baseUrl],
  );

  const onDeleteBookmark = useCallback((bm: UserBookmark) => {
    persistUserBookmarks(userBookmarks.filter(
      (b: UserBookmark) => !(b.name === bm.name && b.frequency === bm.frequency && b.scope === bm.scope),
    ));
  }, [userBookmarks, persistUserBookmarks]);

  const onExportBookmarks = useCallback(() => {
    const list = userBookmarks;
    if (!list.length) { Alert.alert('Bookmarks', 'No bookmarks to export.'); return; }
    // Plain-array JSON — directly importable by desktop UberSDR's
    // local-bookmarks Import (JSON). Share as text: save/airdrop/paste.
    Share.share({ message: exportBookmarksJSON(list) }).catch(() => {});
  }, [userBookmarks]);

  const onImportBookmarks = useCallback((text: string, allInstances: boolean): string => {
    try {
      const incoming = parseBookmarksAny(text, allInstances ? '' : baseUrl);
      if (!incoming.length) return 'No bookmarks found (JSON or YAML).';
      persistUserBookmarks(mergeBookmarks(userBookmarks, incoming));
      return `Imported ${incoming.length} bookmark${incoming.length !== 1 ? 's' : ''}.`;
    } catch {
      return 'Could not parse that file (need JSON or YAML).';
    }
  }, [baseUrl, userBookmarks, persistUserBookmarks]);

  // Pick a bookmark file (JSON/YAML) from the Files app and import it.
  const onPickImportFile = useCallback(async (allInstances: boolean): Promise<string> => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return '';
      const text = await FileSystem.readAsStringAsync(res.assets[0].uri);
      return onImportBookmarks(text, allInstances);
    } catch {
      return 'Could not read that file.';
    }
  }, [onImportBookmarks]);

  const showBandNotif = useCallback((bands: Band[]) => {
    if (!bands.length) return;
    const primary = bands[0];
    const range = `${fmtBandFreq(primary.lo)}–${fmtBandFreq(primary.hi)}`;
    let cond: string | null = null;
    let color: string | undefined;
    // Band conditions come from UberSDR's /api/noisefloor/latest (ft8_snr); only
    // UberSDR serves it. Don't attempt it on OWRX/Kiwi — they 404 (and the cache
    // clear in refreshBandSnr would otherwise be the only thing stopping the
    // previous instance's numbers leaking through).
    if (primary.type === 'ham' && (route.params.serverType ?? 'ubersdr') === 'ubersdr') {
      const snr = getBandSnrDb(baseUrl, primary.bandLabel);
      cond = propCondition(snr);
      if (snr !== null) {
        color = snr >= 30 ? 'rgba(60,220,90,0.95)'
              : snr >= 20 ? 'rgba(140,220,90,0.95)'
              : snr >= 6  ? 'rgba(255,200,80,0.95)'
              :             'rgba(235,90,80,0.95)';
      }
    }
    const primaryMsg = `BAND: ${range} · ${primary.name}`
      + (cond ? ` · Conditions: ${cond}` : '')
      + (bands.length > 1 && ituRegion ? ` (ITU R${ituRegion})` : '');
    const secondary = bands.slice(1).map((b: Band) => b.name).join('  │  ');
    vtsKey.current++;
    setVtsNotif({
      key: vtsKey.current, name: primaryMsg,
      secondary: secondary || undefined, kind: 'band', color,
    });
  }, [baseUrl, ituRegion]);

  const vtsCheck = useCallback((hz: number) => {
    // Band crossing
    const order: Record<string, number> = { ham: 0, broadcast: 1, utility: 2 };
    const bands = getBandsAtRegion(hz, ituRegion)
      .sort((a: Band, b: Band) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
    const key = bands.length ? bands.map((b: Band) => b.name).join('|') : null;
    if (!vtsBandInit.current) {
      vtsBandInit.current = true;
      vtsBandKey.current = key;
    } else if (key !== vtsBandKey.current) {
      vtsBandKey.current = key;
      if (vtsDeferredBand.current) { clearTimeout(vtsDeferredBand.current); vtsDeferredBand.current = null; }
      if (bands.length) {
        if (Date.now() < vtsArrowJumpUntil.current) {
          vtsDeferredBand.current = setTimeout(() => {
            vtsDeferredBand.current = null;
            showBandNotif(bands);
          }, 3000);
        } else {
          showBandNotif(bands);
        }
      }
      // Band-aware tuning on boundary crossing. Fires for any tuning that ISN'T
      // the user hands-on in the app — lock-screen / Apple Watch / headphone /
      // car media-control skips all trigger it. Suppressed only while the user
      // is actively tuning in-app (recent markInteract: VFO drum, waterfall tap,
      // any touch) so the demod/step they're dialling in isn't yanked away.
      // 1.5s window comfortably covers the drum's inertia glide after release.
      const handsOn = Date.now() - lastInteractRef.current < 1500;
      if (!handsOn) {
        const d = bandTuneDefaults(hz, ituRegion);
        if (d.mode && d.mode in MODE_BANDWIDTHS) onMode(d.mode);
        if (d.step) setStep(d.step);
      }
    }
    // A live RDS/DAB station name (OWRX) owns the station display — it's the
    // actual decode of what you're hearing, so it wins over a bookmark guess.
    // The liveStation effect drives the name + popup; just keep the menu freq
    // pointed at the VFO and skip the bookmark match.
    if (liveStationRef.current) { setVtsMenuFreq(hz); return; }
    // Nearest station
    const nearest = findNearest(vtsBookmarks.current, hz);
    if (!nearest) {
      setVtsMenuName('');
      setVtsMenuFreq(undefined);
      vtsLastStation.current = '';
      return;
    }
    setVtsMenuName(nearest.name);
    setVtsMenuFreq(nearest.hz);
    // Popup ONLY when ON a station (≤99Hz) — the off-tune offset-arrow
    // variant is the skin's tuning guide, which was erratic on the popup
    // bar and is intentionally not ported. Off-tune resets the latch so
    // re-landing on the same station pops again.
    const onTune = Math.abs(nearest.offset) <= VTS_ON_HZ;
    if (!onTune) {
      vtsLastStation.current = '';
    } else if (nearest.name !== vtsLastStation.current) {
      vtsLastStation.current = nearest.name;
      vtsKey.current++;
      // On a digital-voice mode (DMR/YSF/…), a repeater bookmark and the live
      // caller alternate — hold the bookmark too so the pair stays pinned while
      // the QSO is live (rather than the bookmark timing out under the caller).
      const voiceMode = ['dmr', 'ysf', 'dstar', 'nxdn', 'm17', 'radel', 'radeu']
        .includes(String(client.current?.getStatus().mode ?? ''));
      setVtsNotif({ key: vtsKey.current, name: nearest.name, kind: 'station-on', hold: voiceMode, source: nearest.source, flag: nearest.flag });
    }
  }, [ituRegion, showBandNotif, onMode]);

  // Watch the tuned frequency (debounced — the drum emits many per second)
  useEffect(() => {
    const hz = status.frequency;
    if (!hz) return;
    const t = setTimeout(() => vtsCheck(hz), 250);
    return () => clearTimeout(t);
  }, [status.frequency, vtsCheck]);

  // Live RDS/DAB station name arrives async (no frequency change to trigger
  // vtsCheck), so react to it directly: drive the VTS station readout + popup,
  // uniform with the bookmark-derived station-on notif. Cleared name hands the
  // display back to the bookmark resolver on the next tune.
  useEffect(() => {
    const name = liveStation.name;
    if (!name) {
      // Live data cleared (tuned away / mode change / voice idle) — dismiss the
      // held popup and re-evaluate bookmarks for the current spot, so a held RDS
      // name / DMR caller falls back to the channel's bookmark instead of nothing.
      if (vtsLastStation.current) {
        vtsLastStation.current = '';
        setVtsNotif(null);
        vtsCheck(status.frequency);
      }
      return;
    }
    setVtsMenuName(name);
    setVtsMenuFreq(status.frequency);
    // RDS: append the scrolling radiotext after the station name (the VTS bar
    // marquees overflow). e.g. "BBC Nhtn — BBC Radio Northampton …We love …".
    const display = liveStation.text ? `${name} — ${liveStation.text}` : name;
    if (display !== vtsLastStation.current) {
      vtsLastStation.current = display;
      vtsKey.current++;
      // Live server data (RDS/DMR/DAB) holds on screen until it changes/clears
      // — only the static bookmark/band notifs time out. Badge flags the source.
      setVtsNotif({ key: vtsKey.current, name: display, kind: 'station-on', hold: true, badge: liveBadgeRef.current });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStation.name, liveStation.text]);

  // ── VTS-aware media session ────────────────────────────────────────────────
  // Track  = freq (user's unit) + demod + tune step ("648 kHz AM · 9 kHz step")
  // Artist = "VibeSDR: Radio Caroline" on a station, else the band
  //          ("VibeSDR: 40m Ham Band"); art = app icon + server-type logo.
  useEffect(() => {
    const hz = status.frequency;
    if (!hz) return;
    const t = setTimeout(() => {
      const trim = (v: number, dp: number) =>
        v.toFixed(dp).replace(/\.?0+$/, '');
      const fq = freqUnit === 'hz' ? `${Math.round(hz)} Hz`
        : freqUnit === 'mhz' ? `${trim(hz / 1e6, 4)} MHz`
        : `${trim(hz / 1e3, 3)} kHz`;
      const st = mediaSkip === 'bookmark'
        ? 'bookmark skip'
        : (step >= 1000 ? `${trim(step / 1e3, 1)} kHz step` : `${step} Hz step`);
      const fqLine = `${fq} ${status.mode.toUpperCase()}`;
      // A live RDS/DAB station name becomes the TITLE (so it's prominent AND so a
      // DAB programme skip — which doesn't change the frequency — still changes the
      // now-playing metadata, forcing the lock-screen card to refresh). Otherwise
      // keep the freq/step title with the band/bookmark as the artist.
      let title: string, artist: string;
      if (liveStationRef.current) {
        title = liveStationRef.current;
        artist = `VibeSDR · ${fqLine}`;
      } else {
        const nearest = findNearest(vtsBookmarks.current, hz);
        let context: string;
        if (nearest && Math.abs(nearest.offset) <= 1000) {
          context = nearest.name;
        } else {
          const order: Record<string, number> = { ham: 0, broadcast: 1, utility: 2 };
          const bands = getBandsAtRegion(hz, ituRegion)
            .sort((a: Band, b: Band) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
          context = bands.length ? bands[0].name : 'HF Radio';
        }
        title = `${fqLine} · ${st}`;
        artist = `VibeSDR: ${context}`;
      }
      VibePowerModule?.setNowPlaying(title, artist);
      // Local hardware / RTL-TCP reuse serverType 'ubersdr' for the client, but get
      // their own album-art inset so the card is distinct from a network session.
      const artType = route.params.isTcp ? 'rtltcp'
                    : route.params.isLocal ? 'local'
                    : (route.params.serverType ?? 'ubersdr');
      VibePowerModule?.setArtwork(artType);  // native caches per type
    }, 300);
    return () => clearTimeout(t);
  }, [status.frequency, status.mode, step, freqUnit, ituRegion, mediaSkip,
      serverBookmarks, userBookmarks, liveStation.name]);

  useEffect(() => () => {
    if (vtsDeferredBand.current) clearTimeout(vtsDeferredBand.current);
  }, []);

  // Menu arrows: jump to next/previous bookmark (sets the bookmark's mode too)
  const onVtsJump = useCallback((dir: 'left' | 'right') => {
    const c = client.current; if (!c) return;
    const bm = findNextBookmark(vtsBookmarks.current, c.getStatus().frequency, dir);
    if (!bm) return;
    vtsArrowJumpUntil.current = Date.now() + 3000;
    onTuneHz(bm.frequency);
    const m = bm.mode?.toLowerCase();
    if (m && m in MODE_BANDWIDTHS) onMode(m as SDRMode);
  }, [onTuneHz, onMode]);
  const onVtsPrev = useCallback(() => onVtsJump('left'),  [onVtsJump]);
  const onVtsNext = useCallback(() => onVtsJump('right'), [onVtsJump]);

  // Search result tap: tune (+mode when the bookmark has one) and close menu
  // Tune from a search/list tap. For an explicit BAND selection we also apply
  // that band's demodulator + tune step (band-aware tuning) — a deliberate user
  // action, so it applies handheld too. Bookmark taps keep the bookmark's own
  // mode and leave the step untouched.
  const onSearchTune = useCallback((hz: number, mode?: string | null, isBand?: boolean, voiceStep?: boolean) => {
    setMenuOpen(false);
    const target = Math.round(hz);
    onTuneHz(target);
    const d = bandTuneDefaults(target, ituRegion);
    const explicit = mode?.toLowerCase() as SDRMode | undefined;
    if (isBand) {
      const m = d.mode ?? explicit;
      if (m && m in MODE_BANDWIDTHS) onMode(m);
      if (d.step) setStep(d.step);
    } else if (voiceStep) {
      // Voice/bookmark tune: explicit (spoken) mode wins, else the band default;
      // and adopt the band step too (e.g. Radio Caroline → MW 9 kHz).
      const m = (explicit && explicit in MODE_BANDWIDTHS) ? explicit : d.mode;
      if (m && m in MODE_BANDWIDTHS) onMode(m);
      if (d.step) setStep(d.step);
    } else if (explicit && explicit in MODE_BANDWIDTHS) {
      onMode(explicit);  // plain bookmark tap — mode only, step untouched
    }
  }, [onTuneHz, onMode, ituRegion]);

  // Menu INSTANCE row — ← BACK returns to the instance picker (it previously
  // fell back to just closing the menu). The ⟳ RECONNECT button was removed
  // 2026-06-12: it only recycled the spectrum client while the native audio
  // WS kept the old session → frozen waterfall, and the zombie watchdog +
  // revive() already cover real reconnects.
  const onBackToPicker = useCallback(() => {
    setMenuOpen(false);
    navigation.goBack();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable handlers — inline lambdas defeat the React.memo on ControlsBar.
  const onStepOpen  = useCallback(() => setStepOpen(true), []);
  const onMenuOpen  = useCallback(() => setMenuOpen(true), []);
  const onFreqOpen  = useCallback(() => setFreqModalOpen(true), []);
  const onModeOpen  = useCallback(() => setModeSelOpen(true), []);

  // First-run guided tour (dismissable). Spotlights the drum, step rate, the
  // disabled back-gesture, and the menu — opening it to show the route back to
  // the instance list. Fail-safe: always skippable; a target that can't be
  // measured falls back to a centred card.
  // A small render of the menu's instance section — shown in the tour instead of
  // opening the real menu (a second Modal over the coachmark wedges iOS).
  const menuMock = (
    <View style={{ borderRadius: 9, borderWidth: 1, borderColor: 'rgba(255,229,102,0.30)', backgroundColor: 'rgba(0,0,0,0.45)', padding: 9, gap: 7 }}>
      <Text style={{ color: 'rgba(255,255,255,0.45)', fontFamily: 'Atkinson Hyperlegible', fontSize: 9.5, letterSpacing: 2, marginBottom: 1 }}>☰  MENU</Text>
      <View style={{ borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', borderRadius: 5, paddingVertical: 7, paddingHorizontal: 10 }}>
        <Text style={{ color: 'rgba(255,255,255,0.82)', fontFamily: 'Atkinson Hyperlegible', fontSize: 11.5, letterSpacing: 0.5 }}>☆  SET DEFAULT</Text>
      </View>
      <View style={{ borderWidth: 1.5, borderColor: '#ffe566', backgroundColor: 'rgba(255,229,102,0.12)', borderRadius: 5, paddingVertical: 7, paddingHorizontal: 10 }}>
        <Text style={{ color: '#ffe566', fontFamily: 'Atkinson Hyperlegible', fontSize: 11.5, fontWeight: 'bold', letterSpacing: 0.5 }}>←  BACK TO INSTANCE LIST</Text>
      </View>
      <View style={{ borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', borderRadius: 5, paddingVertical: 7, paddingHorizontal: 10 }}>
        <Text style={{ color: 'rgba(255,255,255,0.82)', fontFamily: 'Atkinson Hyperlegible', fontSize: 11.5, letterSpacing: 0.5 }}>❔  REPLAY TUTORIAL</Text>
      </View>
    </View>
  );

  const sdrTour = useCoachmarkTour([
    { id: 'freq', title: 'Set the frequency',
      body: 'Tap the frequency readout to type one in directly (kHz or MHz).',
      target: tourRef('freqBox') },
    { id: 'mode', title: 'Choose the demodulator',
      body: 'Tap the mode to pick how the signal is decoded — AM, SSB (USB/LSB), CW, NFM/WFM and more.',
      target: tourRef('modeBtn') },
    { id: 'drum', title: 'Fine-tune with the VFO drum',
      body: 'Spin the drum to move up and down the band. The right-hand wheel zooms the waterfall.',
      target: tourRef('vfoDrum') },
    { id: 'step', title: 'Step rate',
      body: 'Sets how far each drum move jumps — a small step for fine tuning, a large one to skip across bands. Tap it to change.',
      target: tourRef('stepBtn') },
    { id: 'back', title: 'No back-swipe here',
      body: "The phone's Back gesture is switched off over the tuning area so it can't fight the drum.",
      target: tourRef('vfoDrum') },
    { id: 'menu', title: 'Everything else: the menu',
      body: 'Bandwidth, modes, noise reduction, the auto notch, decoders, bookmarks and settings all live here. And since Back is off, this is where you return to the server list:',
      target: tourRef('menuBtn'), illustration: menuMock },
  ], { storageKey: 'lsv_tour_sdr_v3' });
  const onReplayTour = useCallback(() => {
    setMenuOpen(false);
    setTimeout(() => sdrTour.restart(), 320);
  }, [sdrTour]);
  // Auto-start once on the first successful connection, after the controls have
  // laid out (so the drum/step/menu can be measured).
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => { sdrTour.maybeAutoStart(); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // ── Layout ────────────────────────────────────────────────────────────────

  const bottomInset = insets.bottom;

  return (
    <View
      style={styles.root}
      // Capture-phase touch sniff (returns false — never steals the touch):
      // marks interaction for smooth tune / idle saver on any Pressable UI.
      onStartShouldSetResponderCapture={() => { markInteract(); return false; }}
      // Real layout height — Android's Dimensions window height disagrees
      // with the laid-out root (status/nav bar handling), which pushed every
      // pillBottom-anchored overlay (spec-ratio popup, VTS bar, decoder
      // panel) off the bottom on Android.
      onLayout={(e: { nativeEvent: { layout: { height: number } } }) =>
        setRootH(e.nativeEvent.layout.height)}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />

      {/* Waterfall — fills screen below the status bar / Dynamic Island so the
          band plan strip is never hidden under the notch */}
      <View style={{ marginTop: insets.top }}>
      <WaterfallView
        frameSink={wfFrameSink}
        binCount={status.binCount}
        centerHz={status.centerHz}
        bwHz={status.bwHz}
        tuneHz={status.frequency}
        filterLow={status.bandwidthLow}
        filterHigh={status.bandwidthHigh}
        dbMin={dbMin}
        dbMax={dbMax}
        wfCoarse={wfCoarse}
        colormap={colormap}
        width={screenW}
        height={screenH - insets.top}
        // Block waterfall tune/pan/pinch in the bottom gap (home-indicator
        // zone): the whole strip below the pill when controls show, else just
        // the home bar. Preserves swipe-up-to-minimise + menu Modals.
        bottomGuard={controlsHidden ? bottomInset : bottomInset + 8}
        ituRegion={1}
        onPanDelta={onWfPanDelta}
        onZoomDelta={onWfZoomDelta}
        onTapTune={onWfTapTune}
        onPinchZoom={onWfPinchZoom}
        specShow={specShow}
        autoContrast={autoContrast}
        specSmoothing={specSmoothing}
        specFloor={specFloor}
        specPeakScale={specPeakScale}
        peakHold={peakHold}
        spatialSmooth={spatialSmooth}
        smoothTune={smoothTune}
        lastInteractAt={lastInteractRef}
        wfBrightness={wfBrightness}
        wfContrast={wfContrast}
        wfSharpness={wfSharpness}
        frameRate={frameRate}
        needleColor={vfoNeedle}
        needleIntensity={vfoIntensity}
        needleFrost={vfoFrost}
        bgImageUrl={bgImageUrl}
        bgOpacity={bgOpacity / 10}
        stationId={stationId}
        specFrac={specFrac}
        panLoHz={walls?.loHz}
        panHiHz={walls?.hiHz}
        showWalls={!!walls}
        // RF-centre marker = the dongle/RF centre frequency (local/RTL-TCP only).
        // Distinct from the VFO needle once you tune off-centre while unlocked.
        centerMarkerHz={status.centerHz}
        showCenterMarker={isLocal && !vfoLocked}
      />
      </View>

      {/* Spec ratio overlay — floats above pill */}
      <SpecRatioOverlay
        visible={ratioOverlayOpen}
        isLandscape={isLandscape}
        portraitRatio={specRatioPortrait}
        landscapeRatio={specRatioLandscape}
        bottomOffset={pillBottom + 8}
        onChange={(p, l) => { setSpecRatioPortrait(p); setSpecRatioLandscape(l); }}
        onClose={() => setRatioOverlayOpen(false)}
      />
      {/* Decoder panel needs vertical space landscape doesn't have (skin
          parity: panel is portrait-only) — decoder keeps running, banner
          tells the user where it went. */}
      {isLandscape && (activeDecoder !== null || spotsKind !== null) ? (
        <View style={[styles.rotateBanner, { bottom: pillBottom + 8 }]}
              pointerEvents="none">
          <Text style={styles.rotateBannerText}>
            ⟳ ROTATE TO PORTRAIT TO VIEW DECODER
          </Text>
        </View>
      ) : (
        <DecoderPanel
          activeDecoder={activeDecoder}
          decoderText={decoderText}
          decoderStatus={decoderStatus}
          decoding={decoding}
          bottomOffset={pillBottom + 8}
          onClear={() => setDecoderText('')}
          onClose={closeDecoder}
          morseQuality={morseQuality}
          onMorseQuality={onMorseQuality}
          spotsKind={spotsKind}
          spots={spots}
          onTuneHz={onTuneHz}
          imageRef={decoderImageRef}
          onImageStatus={setDecoderStatus}
        />
      )}

      {/* Chat rotate hint — chat is portrait-only, button stays for unread */}
      {chatRotateHint && (
        <View style={[styles.rotateBanner, {
                bottom: pillBottom + 8 +
                  (isLandscape && (activeDecoder !== null || spotsKind !== null) ? 42 : 0),
              }]}
              pointerEvents="none">
          <Text style={styles.rotateBannerText}>
            ⟳ ROTATE TO PORTRAIT FOR CHAT
          </Text>
        </View>
      )}

      {/* Reconnect failed (server full / rate-limited) — tap retries */}
      {reconnectFailedUi && (
        <TouchableOpacity style={[styles.mutedBanner, { top: insets.top + 46 }]}
          onPress={() => { setReconnectFailedUi(false); setDataSaverOff(false); unmute(); fullReconnect(); }}
          activeOpacity={0.85}>
          <Text style={styles.mutedBannerText}>⚠️ RECONNECT FAILED — TAP TO RETRY</Text>
        </TouchableOpacity>
      )}

      {/* OWRX server crashed/restarted (common on OWRX). Keep the app alive and
          tell the user to wait before reconnecting (the server's still booting). */}
      {serverLost && (() => {
        const lostLabel = route.params.serverType === 'kiwi' ? 'KiwiSDR'
                        : route.params.serverType === 'owrx' ? 'OpenWebRX'
                        : 'SDR';
        return (
        <View style={styles.serverLostWrap} pointerEvents="box-none">
          <View style={styles.serverLostCard}>
            <Text style={styles.serverLostTitle}>{lostLabel} server stopped responding</Text>
            <Text style={styles.serverLostBody}>{route.params.serverType === 'kiwi'
              ? "The receiver dropped the connection. KiwiSDR owners with few slots often restrict access: some allow only their own web page, so apps like VibeSDR are refused the moment they connect; some block broadcast / commercial bands and disconnect you when you tune there. If reconnecting drops the same way it's likely an owner restriction — try another receiver. Otherwise it may just be busy or restarting: wait a minute and reconnect."
              : `The receiver dropped the connection — ${lostLabel} servers restart from time to time. Please wait a minute, then reconnect — or pick another from the list.`}</Text>
            <View style={styles.serverLostBtnRow}>
              <TouchableOpacity style={[styles.serverLostBtn, styles.serverLostBtnAlt]}
                onPress={() => navigation.goBack()} activeOpacity={0.85}>
                <Text style={[styles.serverLostBtnText, styles.serverLostBtnAltText]}>INSTANCE LIST</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.serverLostBtn}
                onPress={() => { setServerLost(false); fullReconnect(); }} activeOpacity={0.85}>
                <Text style={styles.serverLostBtnText}>RECONNECT</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        );
      })()}

      {/* Kiwi receiver full (too_busy) — all channels in use. */}
      {serverBusy && (
        <View style={styles.serverLostWrap} pointerEvents="box-none">
          <View style={styles.serverLostCard}>
            <Text style={styles.serverLostTitle}>Receiver unavailable</Text>
            <Text style={styles.serverLostBody}>This KiwiSDR has no free channel for you right now — it may be full, or its channels may be password-protected or limited to local users (the directory's user count can be out of date). Pick another receiver, or try again shortly.</Text>
            <View style={styles.serverLostBtnRow}>
              <TouchableOpacity style={[styles.serverLostBtn, styles.serverLostBtnAlt]}
                onPress={() => navigation.goBack()} activeOpacity={0.85}>
                <Text style={[styles.serverLostBtnText, styles.serverLostBtnAltText]}>INSTANCE LIST</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.serverLostBtn}
                onPress={() => { setServerBusy(false); fullReconnect(); }} activeOpacity={0.85}>
                <Text style={styles.serverLostBtnText}>RETRY</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Connection to an UberSDR instance dropped (e.g. it rebooted). It auto-
          reconnects, but show a clear popup so the app doesn't just look frozen. */}
      {connLost && !dataSaverOff && !serverLost && !serverBusy && (
        <View style={styles.serverLostWrap} pointerEvents="box-none">
          <View style={styles.serverLostCard}>
            <Text style={styles.serverLostTitle}>Connection lost</Text>
            <Text style={styles.serverLostBody}>
              Lost connection to {instanceName || 'the instance'} — trying to reconnect…
            </Text>
            <ActivityIndicator color="#ffb84d" style={{ marginBottom: 14 }} />
            <View style={styles.serverLostBtnRow}>
              <TouchableOpacity style={[styles.serverLostBtn, styles.serverLostBtnAlt]}
                onPress={() => navigation.goBack()} activeOpacity={0.85}>
                <Text style={[styles.serverLostBtnText, styles.serverLostBtnAltText]}>INSTANCE LIST</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.serverLostBtn}
                onPress={() => { setConnLost(false); fullReconnect(); }} activeOpacity={0.85}>
                <Text style={styles.serverLostBtnText}>RECONNECT</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Initial connect never completed (wedged host/shim/USB). Escape hatch so
          the app can never be permanently stuck on the connecting spinner. */}
      {connTimedOut && !connected && !serverLost && !serverBusy && !connLost && !dataSaverOff && (
        <View style={styles.serverLostWrap} pointerEvents="box-none">
          <View style={styles.serverLostCard}>
            <Text style={styles.serverLostTitle}>Couldn’t connect</Text>
            <Text style={styles.serverLostBody}>
              No response from {instanceName || 'the receiver'}. {route.params.isLocal
                ? 'Check the SDR is plugged in and try again, or pick another instance.'
                : isKiwi
                  ? "It may be offline or a temporary network issue — but if a retry also fails, this KiwiSDR's owner likely only allows their own web page and blocks apps like VibeSDR. Try another, or use UberSDR / OpenWebRX."
                  : 'It may be offline or unreachable — try again or pick another instance.'}
            </Text>
            <View style={styles.serverLostBtnRow}>
              <TouchableOpacity style={[styles.serverLostBtn, styles.serverLostBtnAlt]}
                onPress={() => navigation.goBack()} activeOpacity={0.85}>
                <Text style={[styles.serverLostBtnText, styles.serverLostBtnAltText]}>INSTANCE LIST</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.serverLostBtn}
                onPress={() => { setConnTimedOut(false); fullReconnect(); }} activeOpacity={0.85}>
                <Text style={styles.serverLostBtnText}>RETRY</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Paused → disconnected — tap does a full from-scratch reconnect */}
      {dataSaverOff && !reconnectFailedUi && (
        <TouchableOpacity style={[styles.mutedBanner, { top: insets.top + 46 }]}
          onPress={() => { setDataSaverOff(false); unmute(); fullReconnect(); }} activeOpacity={0.85}>
          <Text style={styles.mutedBannerText}>⏸ PAUSED — TAP TO RECONNECT</Text>
        </TouchableOpacity>
      )}

      {/* Local hardware muted (media-control pause): the RTL/waterfall keep running,
          only audio is muted. Tap unmutes + clears the media-control paused state.
          (Network instances disconnect on pause, so this is local-only.) */}
      {isLocal && isMuted && !dataSaverOff && !reconnectFailedUi && (
        <TouchableOpacity style={[styles.mutedBanner, { top: insets.top + 46 }]}
          onPress={unmute} activeOpacity={0.85}>
          <Text style={styles.mutedBannerText}>🔇 AUDIO MUTED — TAP TO UNMUTE</Text>
        </TouchableOpacity>
      )}

      {/* Restore chevron when controls are hidden (full-screen waterfall) */}
      {controlsHidden && (
        <TouchableOpacity
          style={[styles.restoreBtn, { bottom: bottomInset + 10 }]}
          onPress={() => setControlsHidden(false)} activeOpacity={0.8} hitSlop={12}>
          <Text style={styles.restoreBtnText}>▲</Text>
        </TouchableOpacity>
      )}

      {/* Controls pill — absolute overlay, margin 8px each side */}
      {!controlsHidden && <View
        style={[styles.pillWrap, { bottom: bottomInset + 8 }]}
        onLayout={(e: any) => {
          // Track pill top so bottom-anchored overlays can sit above it
          const { y } = e.nativeEvent.layout;
          pillYRef.current = y;
          setPillBottom((rootH > 0 ? rootH : screenH) - y);
        }}
      >
        <ControlsBar
          frequency={status.frequency}
          mode={status.mode}
          step={step}
          connected={connected}
          onShare={onShareStation}
          bottomInset={0}
          instanceHost={instanceName ?? baseUrl}
          meterBus={meterBus.current}
          signalMode={signalMode}
          fmStereo={fmStereo}
          isRecording={isRecording}
          recSeconds={recSeconds}
          chatUnread={chatUnread}
          onVfoDelta={onVfoDelta}
          onBwDelta={onBwDelta}
          onMode={onMode}
          onStep={onStepOpen}
          onMenu={onMenuOpen}
          onChat={openChat}
          onFreqTap={onFreqOpen}
          onModeTap={onModeOpen}
          freqUnit={freqUnit}
          chatShareDisabled={isLocal}
        />
      </View>}

      {/* VTS popup — station / band-crossing notifications above the pill */}
      {!controlsHidden && <VTSBar notif={vtsNotif} bottom={pillBottom + 8} serverType={isLocal ? 'local' : route.params.serverType} />}

      {/* Floating CENTRE ON VFO — unlocked + VFO off-screen (BRIEF §5.8) */}
      <CenterVfoButton visible={vfoOffscreen && !controlsHidden} bottom={pillBottom + 56} onPress={onCentreVfo} />

      {/* Menu sheet */}
      <MenuSheet
        visible={menuOpen}
        serverType={route.params.serverType ?? 'ubersdr'}
        profiles={profiles}
        activeProfileId={activeProfileId}
        sdrUsage={sdrUsage}
        clientCount={clientCount}
        onSelectProfile={(id) => { client.current?.selectProfile?.(id); setActiveProfileId(id); }}
        dabProgrammes={dabProgrammes}
        activeDabId={activeDabId}
        onSelectDab={(id) => { client.current?.setAudioServiceId?.(id); setActiveDabId(id); }}
        dabSpeed={dabSpeed}
        onDabSpeed={onDabSpeed}
        vtsName={vtsMenuName}
        vtsFreq={vtsMenuFreq}
        onVtsPrev={onVtsPrev}
        onVtsNext={onVtsNext}
        searchBookmarks={searchBookmarks}
        searchBands={searchBands}
        onSearchTune={onSearchTune}
        userBookmarks={visibleBookmarks}
        currentFreq={status.frequency}
        currentMode={status.mode}
        onAddBookmark={onAddBookmark}
        onDeleteBookmark={onDeleteBookmark}
        onExportBookmarks={onExportBookmarks}
        onImportBookmarks={onImportBookmarks}
        onPickImportFile={onPickImportFile}
        colormap={colormap}
        dbMin={dbMin}
        dbMax={dbMax}
        filterLow={status.bandwidthLow}
        filterHigh={status.bandwidthHigh}
        bwEdgeMax={client.current ? filterEdgeMax(client.current.caps, status.mode) : 6000}
        nr={nrMode !== 'off'}
        nb={nb}
        recording={isRecording}
        recSeconds={recSeconds}
        signalMode={signalMode}
        displayStyle={displayStyle}
        serverName={instanceName ?? ''}
        serverUrl={baseUrl}
        onClose={() => setMenuOpen(false)}
        onLocalHardware={isLocal ? () => { setMenuOpen(false); setHwOpen(true); } : undefined}
        isTcp={!!route.params.isTcp}
        onColormap={setColormap}
        onDbMin={setDbMin}
        onDbMax={setDbMax}
        onFilterLow={onFilterLow}
        onFilterHigh={onFilterHigh}
        onFilterBoth={onFilterBoth}
        onNr={onNrMode}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onSetDefault={onSetDefault}
        isDefaultInstance={isDefault}
        decMode={selDecoder}
        decOn={activeDecoder !== null && activeDecoder === selDecoder}
        onDecToggle={onDecToggle}
        spotsKind={spotsKind}
        onSpotsToggle={onSpotsToggle}
        onServerMap={(k) => { setMenuOpen(false); setMapKind(k); }}
        onSpotsMap={() => {
          setMenuOpen(false);
          // The map plots the live Digital Spots feed — start it if it isn't on.
          if (spotsKindRef.current !== 'digi') onSpotsToggle('digi');
          setLocalMapOpen(true);
        }}
        rttySettings={rttySettings}
        onRttySettings={onRttySettings}
        wefaxLpm={wefaxLpm}
        onWefaxLpm={onWefaxLpm}
        onNb={onNb}
        onRec={toggleRecording}
        // OWRX/Kiwi have no SNR meter — skip 'snr' in the cycle, stay on S-meter/dBFS.
        onSignalMode={(m: 'snr' | 'smeter' | 'dbfs') => setSignalMode((isOwrx || isKiwi) && m === 'snr' ? 'smeter' : m)}
        onDisplayStyle={handleDisplayStyle}
        onBack={onBackToPicker}
        onAdminLink={onAdminLink}
        onReplayTour={onReplayTour}
        onResetSettings={() => {
          setDbMin(-120); setDbMax(-20); setColormap('Jet');
          setStep(1000);
          setSpecShow(true); setSpecSmoothing(5); setSpecFloor(0);
          setSpecPeakScale(10); setPeakHold(true);
          setWfBrightness(0); setWfContrast(0); setWfSharpness(5);
          setAutoContrast(5); setSpatialSmooth(true);
          setWfCoarse('auto'); setFrameRate('20fps'); setVfoNeedle('#ffffff'); setVfoIntensity(5); setVfoFrost(5); setBgOpacity(3);
          setSpecRatioPortrait(0.28); setSpecRatioLandscape(0.20);
          onNrMode('off'); onNb(false);
          onSnrSquelch(-999); onFmSquelch(-999);
          if (serverDspEnabled) onServerDsp(false);
          setMenuOpen(false);
          // Bookmarks are precious — never clear silently with a reset
          const instCount = bookmarksForInstance(userBookmarks, baseUrl)
            .filter((b: UserBookmark) => b.scope === baseUrl).length;
          if (instCount > 0) {
            Alert.alert(
              'Bookmarks',
              `Keep the ${instCount} bookmark${instCount !== 1 ? 's' : ''} saved for this instance?`,
              [
                { text: 'Keep', style: 'default' },
                { text: 'Clear', style: 'destructive',
                  onPress: () => persistUserBookmarks(withoutInstance(userBookmarks, baseUrl)) },
              ],
            );
          }
        }}
        onSpecRatio={() => { setMenuOpen(false); setRatioOverlayOpen(true); }}
        vfoNeedle={vfoNeedle}           onVfoNeedle={setVfoNeedle}
        vfoIntensity={vfoIntensity}       onVfoIntensity={setVfoIntensity}
        vfoFrost={vfoFrost}               onVfoFrost={setVfoFrost}
        bgOpacity={bgOpacity}             onBgOpacity={(v: number) => { bgOpacityUserSet.current = true; setBgOpacity(v); }}
        hasBgImage={bgImageUrl != null}
        wfCoarse={wfCoarse}             onWfCoarse={setWfCoarse}
        autoContrast={autoContrast}     onAutoContrast={setAutoContrast}
        spatialSmooth={spatialSmooth}   onSpatialSmooth={setSpatialSmooth}
        wfBrightness={wfBrightness}     onWfBrightness={setWfBrightness}
        wfContrast={wfContrast}         onWfContrast={setWfContrast}
        wfSharpness={wfSharpness}       onWfSharpness={setWfSharpness}
        specShow={specShow}             onSpecShow={setSpecShow}
        specSmoothing={specSmoothing}   onSpecSmoothing={setSpecSmoothing}
        specFloor={specFloor}           onSpecFloor={setSpecFloor}
        specPeakScale={specPeakScale}   onSpecPeakScale={setSpecPeakScale}
        peakHold={peakHold}             onPeakHold={setPeakHold}
        frameRate={frameRate}           onFrameRate={onFrameRate}
        smoothTune={smoothTune}         onSmoothTune={onSmoothTune}
        idleSlow={idleSlow}             onIdleSlow={onIdleSlow}
        drumMode={drumMode}             onDrumMode={onDrumMode}
        mediaSkip={mediaSkip}           onMediaSkip={onMediaSkip}
        hapticsEnabled={hapticsEnabled} onHaptics={onHaptics}
        onCentreVfo={onCentreVfo}       onHideControls={onHideControls}
        vfoLocked={vfoLocked}           onToggleVfoLock={onToggleVfoLock}
        onDispReset={onDispReset}       onDispSaveServer={onDispSaveServer}
        onDispSaveGlobal={onDispSaveGlobal}
        snrSquelch={snrSquelch}         onSnrSquelch={onSnrSquelch}
        fmSquelch={fmSquelch}           onFmSquelch={onFmSquelch}
        localSquelch={hwSquelch}        onLocalSquelch={isLocal ? onLocalSquelch : undefined}
        kiwiSquelch={kiwiSquelch}       onKiwiSquelch={isKiwi ? onKiwiSquelch : undefined}
        localNR={hwNrLevel}             onLocalNR={isLocal ? onLocalNR : undefined}
        notchOn={isLocal ? hwNotch : netNotch}   onNotch={isLocal ? onLocalNotch : onNetNotch}
        eibiEnabled={eibiEnabled}        onEibiToggle={onEibiToggle}
        isFmMode={status.mode === 'fm' || status.mode === 'nfm'}
        serverDspEnabled={serverDspEnabled}
        serverDspFilter={serverDspFilter}
        serverDspParams={serverDspParams}
        dspFilters={dspFilters}
        dspError={dspError}
        onServerDsp={onServerDsp}
        onServerDspFilter={onServerDspFilter}
        onServerDspParam={onServerDspParam}
        serverVersion={serverVersion}
        serverLabel={serverLabel}
        onOwrxSquelch={(db) => client.current?.setSquelch?.(db)}
        onOwrxNr={(th) => client.current?.setNr?.(th)}
        onAbout={() => { setMenuOpen(false); setAboutOpen(true); }}
        onRecordings={() => { setMenuOpen(false); setRecordingsOpen(true); }}
      />

      {/* About VibeSDR — V2 changes, credits, GPL-3.0 */}
      <AboutOverlay visible={aboutOpen} onClose={() => setAboutOpen(false)} />
      <RecordingsOverlay
        visible={recordingsOpen}
        onClose={() => setRecordingsOpen(false)}
        onActiveChange={onRecordingsActive}
      />

      {/* First-run guided tour (dismissable) — renders nothing until active */}
      {sdrTour.overlay}

      {/* Step picker — bottom sheet */}
      <StepPicker
        visible={stepOpen}
        currentStep={step}
        steps={stepsForFreq(status.frequency)}
        onSelect={hz => { setStep(hz); }}
        onClose={() => setStepOpen(false)}
      />

      {/* Mode selector */}
      <ModeSelector
        visible={modeSelOpen}
        gainControl={isLocal ? {
          gains: hwGains, gainTenthDb: hwGain, auto: hwAutoGain, onAuto: onHwAuto, onGain: onHwGain,
        } : undefined}
        current={status.mode}
        modes={isLocal ? LOCAL_MODES : route.params.serverType === 'owrx' ? serverModes : undefined}
        activeDecoder={route.params.serverType === 'owrx'
          ? (activeDecoder === 'sstv' ? 'sstv' : activeDecoder === 'wefax' ? 'fax' : undefined)
          : undefined}
        onSelect={onMode}
        onClose={() => setModeSelOpen(false)}
      />

      {/* v4 local hardware: RTL-SDR controls submenu */}
      {isLocal ? (
        <LocalHardwarePanel
          visible={hwOpen}
          onClose={() => setHwOpen(false)}
          gains={hwGains}
          gainTenthDb={hwGain}
          autoGain={hwAutoGain}
          onAuto={onHwAuto}
          onGain={onHwGain}
          ppm={hwPpm}
          onPpm={onHwPpm}
          sampleRate={hwSampleRate}
          onSampleRate={onHwSampleRate}
          isTcp={!!route.params.isTcp}
          biasTee={hwBiasTee}
          onBiasTee={onHwBiasTee}
          agc={hwAgc}
          onAgc={onHwAgc}
          directSampling={hwDirectSamp}
          onDirectSampling={onHwDirectSamp}
          deemph={hwDeemph}
          onDeemph={onHwDeemph}
          stereo={hwStereo}
          onStereo={onHwStereo}
        />
      ) : null}

      {/* Server map overlay (HFDL / Digital / CW — full-screen WebView Leaflet) */}
      <MapOverlay
        visible={mapKind !== null}
        kind={mapKind}
        baseUrl={baseUrl}
        sessionUuid={sessionUuid}
        onClose={() => setMapKind(null)}
      />

      {/* On-device FT8 spots map (Local/Kiwi): RN-fed spots (each with a grid),
          receiver position from device GPS / Kiwi gps / a picked city. */}
      <MapOverlay
        visible={localMapOpen}
        kind="digi"
        local
        baseUrl={isLocal ? 'https://localhost' : baseUrl}
        wsBaseOverride={decoderBase}
        sessionUuid={sessionUuid}
        rxLat={recvLoc?.lat ?? 0}
        rxLon={recvLoc?.lon ?? 0}
        spots={spots}
        onPickCity={() => setCityPickerOpen(true)}
        onClose={() => setLocalMapOpen(false)}
        disconnected={serverLost || serverBusy || connTimedOut}
        onBackToList={() => { setLocalMapOpen(false); navigation.goBack(); }}
        onRetry={() => fullReconnect()}
      />

      <CityPickerModal
        visible={cityPickerOpen}
        onClose={() => setCityPickerOpen(false)}
        onPick={(c) => {
          recvLocRef.current = { lat: c.lat, lon: c.lon };
          setRecvLoc({ lat: c.lat, lon: c.lon });
          setCityPickerOpen(false);
        }}
      />

      {/* Admin pages — in-app browser with ← SDR bar */}
      <BrowserOverlay
        url={adminPage?.url ?? null}
        title={adminPage?.title}
        allowSave={!!adminPage?.url?.includes('/files')}
        injectCSS={adminPage?.url?.endsWith('/map')
          ? '.webrx-top-container{display:none!important}'   // OWRX map: hide header → full-screen map
          : undefined}
        onClose={() => setAdminPage(null)}
      />

      {/* Frequency modal */}
      <FreqModal
        visible={freqModalOpen}
        currentHz={status.frequency}
        onConfirm={onTuneHz}
        onClose={() => setFreqModalOpen(false)}
        unit={freqUnit}
        onUnit={setFreqUnit}
        minHz={client.current?.caps.freqRange[0]}
        maxHz={client.current?.caps.freqRange[1]}
      />

      {/* Chat drawer */}
      <ChatDrawer
        visible={chatOpen}
        messages={chatMessages}
        myCallsign={myCallsign}
        onJoin={handleChatJoin}
        onSend={handleChatSend}
        onClose={closeChat}
        onMute={() => setChatMuted((p: boolean) => !p)}
        muted={chatMuted}
        users={chatUsers}
        syncedUser={syncedUser}
        zoomSync={zoomSync}
        onToggleSync={toggleUserSync}
        onToggleZoomSync={() => setZoomSync((p: boolean) => !p)}
        onUserTap={chatUserTap}
        textOnly={isOwrx}
        onChangeName={() => setMyCallsign(null)}
      />

      {/* Bypass password — rate-limit recovery (replaces the session) */}
      <PasswordModal
        visible={pwPrompt}
        serverUrl={baseUrl}
        onSubmit={(pw: string) => {
          setPwPrompt(false);
          navigation.replace('SDR', { ...route.params, password: pw });
        }}
        onCancel={() => { setPwPrompt(false); navigation.goBack(); }}
      />

      {/* Audio player (renderless) — held until the saved tune is restored
          so the audio WS opens on the CORRECT freq/mode (no race) */}
      <AudioPlayer
        // v3: the native UberSDR Opus engine only speaks UberSDR. OWRX/Kiwi audio
        // moves into their own native engines in a later phase — until then the
        // OWRX waterfall works but audio is off (don't point the Opus engine at it).
        // v4 local hardware (isLocal) uses LocalAudioPlayer below instead.
        baseUrl={tuneLoaded && !route.params.isLocal && (route.params.serverType ?? 'ubersdr') === 'ubersdr' ? baseUrl : null}
        password={password}
        frequency={status.frequency}
        mode={status.mode}
        step={step}
        instanceName={instanceName}
        uuid={sessionUuid}
      />
      {/* v4 local hardware: audio from the on-device shim's /ws/audio (PCM) */}
      {route.params.isLocal && route.params.localPort != null ? (
        <LocalAudioPlayer
          port={tuneLoaded ? route.params.localPort : null}
          frequency={status.frequency}
          mode={status.mode}
          bandwidthLow={status.bandwidthLow}
          bandwidthHigh={status.bandwidthHigh}
          instanceName={instanceName}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rotateBanner: {
    position: 'absolute', alignSelf: 'center', zIndex: 55,
    backgroundColor: 'rgba(8,12,6,0.92)', borderWidth: 1,
    borderColor: 'rgba(120,240,120,0.45)', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  rotateBannerText: {
    color: 'rgba(140,255,140,0.9)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 12, fontWeight: '700', letterSpacing: 0.5,
  },
  mutedBanner: {
    position: 'absolute', alignSelf: 'center', zIndex: 60,
    backgroundColor: 'rgba(20,6,4,0.92)', borderWidth: 1,
    borderColor: 'rgba(220,60,60,0.8)', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  mutedBannerText: {
    color: '#ff7a7a', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 13, fontWeight: '700', letterSpacing: 0.5,
  },
  serverLostWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 90,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  serverLostCard: {
    maxWidth: 360, marginHorizontal: 28, padding: 20, borderRadius: 14,
    backgroundColor: 'rgba(16,12,8,0.98)', borderWidth: 1, borderColor: 'rgba(255,184,77,0.55)',
    alignItems: 'center',
  },
  serverLostTitle: {
    color: '#ffb84d', fontFamily: 'Atkinson Hyperlegible', fontSize: 16,
    fontWeight: '700', textAlign: 'center', marginBottom: 8,
  },
  serverLostBody: {
    color: 'rgba(255,235,210,0.9)', fontFamily: 'Atkinson Hyperlegible',
    fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 16,
  },
  serverLostBtnRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  serverLostBtn: {
    backgroundColor: '#ffb84d', borderRadius: 8, paddingHorizontal: 22, paddingVertical: 10,
  },
  serverLostBtnText: {
    color: '#1a1206', fontFamily: 'Atkinson Hyperlegible', fontSize: 14,
    fontWeight: '700', letterSpacing: 0.5,
  },
  serverLostBtnAlt: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,184,77,0.6)',
  },
  serverLostBtnAltText: { color: '#ffb84d' },
  restoreBtn: {
    position: 'absolute', alignSelf: 'center', zIndex: 60,
    backgroundColor: 'rgba(10,10,10,0.55)', borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.30)', borderRadius: 16,
    paddingHorizontal: 18, paddingVertical: 4,
  },
  restoreBtnText: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  pillWrap: {
    position: 'absolute',
    left:  8,
    right: 8,
  },
});
