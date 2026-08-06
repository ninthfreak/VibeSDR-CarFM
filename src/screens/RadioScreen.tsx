/**
 * RadioScreen — main receiver screen for CarFM v2.
 *
 * Hierarchy:
 *   RadioScreen
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
  NativeEventEmitter,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';
import { useKeepAwake }       from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList }     from '../../App';

import { MODE_BANDWIDTHS, type SDRStatus, type SDRMode } from '../services/UberSDRClient';
import { createBackend } from '../services/UberSDRAdapter';
import { isNwdAvailable, nwdConnect, nwdDisconnect, nwdTune, nwdSeek, nwdPoll, nwdSetRds, nwdSetAudio, nwdProbe, nwdStartIlluminationWatch, nwdStartLevelWatch, nwdStopLevelWatch, nwdReadLevelNow,
         onNwd, PANEL_KEY, panelKeyName } from '../services/nwdRadio';
import { createNwdRdsDecoder } from '../services/nwdRds';
import { levelToLit, settleDottedPairs, LEVEL_POLL_MS, LEVEL_SETTLE_MS } from '../services/nwdSignalLevel';
import { getTunerBackend, loadTunerBackend, subscribeTunerBackend, readoutFor } from '../services/tunerBackend';
import { stripStationFromRt } from '../services/rtStation';
import {
  isDebugMode, subscribeDebugMode, formatSample, bearingDeg, DEBUG_SAMPLE_MS,
  RATING_LABELS, RATING_FRESH_S, ratingBelongsHere, type AudioRating, type DebugSample,
} from '../services/debugMode';
import { getDetailedLocation } from '../services/instancesApi';
import { stationsAtFrequency } from '../services/stationDb';
import { haversineKm, receivabilityScore } from '../services/stationGeo';
import RatingBar from '../components/carfm/RatingBar';
import { diag, isDiagEnabled, isDiagOverlayEnabled, subscribeDiagPrefs } from '../services/diag';
import { startMotion, stopMotion } from '../services/motion';
import { startGpsFix, stopGpsFix } from '../services/gps';
import { KiwiAdapter } from '../services/KiwiAdapter';
import { localSessionGen, newLocalSession } from '../services/localSession';
import { startBookmarkAutosave, stopBookmarkAutosave,
         getLearnedBookmarksNow } from '../services/vibeServer';
import { setReceiverIso } from '../services/rdsCountry';

import { type SDRBackend, type ProfileInfo, type DabProgramme,
         type DspFilterDesc } from '../services/SDRBackend';
import { MIN_HZ, MAX_HZ }                              from '../services/sdrTypes';
import { v4 as uuidv4 }                                from 'uuid';
import AsyncStorage                                    from '@react-native-async-storage/async-storage';
import { useTheme }                                     from '../contexts/ThemeContext';

import AudioPlayer, { VibePowerModule } from '../components/AudioPlayer';
import LocalAudioPlayer from '../components/LocalAudioPlayer';
import { resolveStationLogo } from '../services/stationLogoCache';
import { isWholeProfileMode } from '../services/dataModes';
import { isoToFlag, validIso } from '../services/rdsCountry';
import {
  fetchBookmarks, findNearest, findNextBookmark,
  fmtBandFreq, refreshBandSnr, getBandSnrDb, propCondition,
  fetchUiConfig,
  VTS_ON_HZ, type ServerBookmark, type ServerBand,
  type ServerUiConfig,
} from '../services/stations';
import {
  loadUserBookmarks, saveUserBookmarks, bookmarksForInstance,
  mergeBookmarks, type UserBookmark,
} from '../services/userBookmarks';
import { getBandsAtRegion, bandTuneDefaults, BAND_PLAN, type Band } from '../constants/bandPlan';
import { fmNowPlaying } from '../services/nowPlaying';
import { ptyLabel } from '../services/ptyLabels';
import { getCarAutostart, setCarAutostart } from '../services/carMode';
import CarFmFace, { type CarFmPreset } from '../components/CarFmFace';
import DiagOverlay from '../components/carfm/DiagOverlay';
import { DARK, LIGHT } from '../components/carfm/tokens';
import { identifyByPi, initLogoService, consumeSharedLogo, getNearbyStations, callsignForFreq, estimatedSignalDbForFreq } from '../services/stationFinder';
import { warmStationLogos } from '../components/carfm/LogoTile';
import type { StationIdentity } from '../services/stationTypes';
import { loadActiveEibi } from '../services/eibi';
import { getUserLocation } from '../services/instancesApi';

// ── Types ──────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<RootStackParamList, 'Radio'>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A "virtual tuning scale" notification (station on/off tune, band crossing).
 *  The bar that rendered these was VibeSDR chrome; the payload type stays with
 *  the code that still computes them. */
interface VtsNotifData {
  key:        number;   // bump to re-trigger even with identical text
  name:       string;
  secondary?: string;   // overlap band names (band notifs only)
  offset?:    string;   // "-1.2kHz" distance to the station
  tuneDir?:   'left' | 'right';  // which way to tune to reach it
  kind:       'station-on' | 'station-off' | 'band';
  color?:     string;   // band-condition override for the primary text
  hold?:      boolean;  // stay up (no auto-dismiss) — digital-voice caller display
  badge?:     string;   // live-data tag (e.g. 'RDS', 'DMR') — shown before the name
  source?:    'eibi' | 'server' | 'user';  // bookmark origin → source icon
  flag?:      string;   // transmitter-country flag (EiBi bookmarks / RDS)
  logoUrl?:   string;   // resolved WFM RDS station logo
}


// ── Component ──────────────────────────────────────────────────────────────────


// The live-station snapshot that feeds the CarFM face (name/RadioText/RDS flags).
type LiveStation = { name?: string; text?: string; rtArtist?: string; rtTitle?: string; tp?: boolean; ta?: boolean; pty?: number; af?: boolean; afMhz?: number[]; badge?: string; countryIso?: string; pi?: string };

function sameNums(a?: number[], b?: number[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// RDS RadioText arrives as several fragments/sec; many carry nothing the face
// actually shows. Gate setLiveStation on a real change so identical ticks don't
// re-render the (SVG-heavy) CarFM face for nothing. Compares every displayed
// field; afMhz is the only non-primitive (element-wise).
function liveStationEqual(a: LiveStation, b: LiveStation): boolean {
  return a.name === b.name && a.text === b.text && a.rtArtist === b.rtArtist &&
    a.rtTitle === b.rtTitle && a.tp === b.tp && a.ta === b.ta && a.pty === b.pty &&
    a.af === b.af && a.badge === b.badge && a.countryIso === b.countryIso &&
    a.pi === b.pi && sameNums(a.afMhz, b.afMhz);
}

export default function RadioScreen({ route, navigation }: Props) {
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
  // rtl_tcp network health, polled from the shim's jitter buffer. 3 = good (also the
  // resting value on the USB path, where it never clamps anything).
  const netLinkRef = useRef<0|1|2|3>(3);
  // SpyServer with canControl=0: another client holds the tuner, so tuning would
  // silently do nothing. Show it rather than letting the user fight a dead dial.
  const [readOnly, setReadOnly] = useState(false);
  // Session limit (minutes) from the directory. The server enforces it; we just
  // warn up front, rather than letting it look like a crash.
  const sessionLimitMins: number = route.params.sessionLimitMins ?? 0;
  const [sessionEndsAt, setSessionEndsAt] = useState<number | null>(null);
  const noticeShownRef = useRef(false);
  // Per-device persistence suffix so each local source keeps its OWN remembered
  // setup (frequency/mode/step + hardware config). RTL-TCP is keyed by host:port,
  // so UberSDR-over-RTL-TCP and a real-hardware RTL-TCP server never share state;
  // a USB dongle uses ':usb'. The old single 'lsv_local_hw' / ':local' keys let
  // every local device clobber each other — and could restore an out-of-band
  // frequency (e.g. 96.6 MHz WFM onto an HF-only UberSDR RTL-TCP).
  const localDeviceKey = route.params.isTcp
    ? `tcp:${route.params.tcpHost ?? ''}:${route.params.tcpPort ?? ''}`
    : 'usb';
  const localHwKey = `lsv_local_hw:${localDeviceKey}`;
  const LocalHw = (NativeModules as any).VibeLocalSDR;
  const [hwGain,        setHwGain]        = useState(0);     // tenths of dB
  const [hwAutoGain,    setHwAutoGain]    = useState(true);
  const [hwPpm,         setHwPpm]         = useState(0);
  const [hwSampleRate,  setHwSampleRate]  = useState(2_400_000);
  const [hwBiasTee,     setHwBiasTee]     = useState(false);
  const [hwAgc,         setHwAgc]         = useState(false);
  const [hwDirectSamp,  setHwDirectSamp]  = useState(0);
  const [hwDeemph,      setHwDeemph]      = useState(50e-6);  // FM de-emphasis tau (0/50µs/75µs)
  const [hwStereo,      setHwStereo]      = useState(true);   // WFM stereo on / forced mono (local)
  const [netNotch,      setNetNotch]      = useState(false);  // auto notch — NETWORK (UberSDR/OWRX/Kiwi)

  // Load saved RTL-SDR hardware settings and apply them to the running session,
  // so gain/bias-T/PPM/etc. persist across connections.
  const hwLoaded = useRef(false);
  useEffect(() => {
    if (!isLocal) return;
    let cancelled = false;
    (async () => {
      let prefs: any = {};
      try {
        // Per-device key first; migrate the old global blob on first connect so a
        // single existing dongle keeps its gain/rate/etc.
        let j = await AsyncStorage.getItem(localHwKey);
        if (j == null) j = await AsyncStorage.getItem('lsv_local_hw');
        if (j) prefs = JSON.parse(j);
      } catch {}
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
      setHwBiasTee(bias); setHwAgc(agc); setHwDirectSamp(ds); setHwDeemph(deemph); setHwStereo(stereo);
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
          if (typeof prefs.gain !== 'number') setHwGain(g[Math.floor(g.length / 2)]);
        }
      } catch {}
      hwLoaded.current = true;
    })();
    return () => { cancelled = true; };
  }, [isLocal, LocalHw, localHwKey]);

  // Background-restriction nudge (local hardware only). Aggressive OEMs
  // (Motorola/Lenovo, some others) ship apps "Restricted" by default, which makes
  // Android strip our mediaPlayback foreground service in the background → the
  // process is demoted to a cached/little-core state → the local-SDR DSP thread
  // starves the audio writer → background audio breaks up. We can't clear the
  // restriction programmatically (user-only), so detect it once per session and
  // point the user at the Settings toggle. Shown at most once (until they act or
  // permanently dismiss). Network backends don't need this — only local hardware
  // runs a heavy in-process DSP thread that the demotion starves.
  useEffect(() => {
    if (!isLocal || !LocalHw?.isBackgroundRestricted) return;
    let cancelled = false;
    (async () => {
      try {
        const restricted = await LocalHw.isBackgroundRestricted();
        if (cancelled) return;
        if (!restricted) {
          // Not restricted → re-arm the prompt. If the OS later re-restricts the
          // app (an OEM battery-manager clamp, a system update, etc.), we want to
          // warn again even if the user previously tapped "Don't ask again" — that
          // dismissal only suppresses the CURRENT restricted episode, not forever.
          AsyncStorage.removeItem('lsv_bg_restrict_dismissed_v1').catch(() => {});
          return;
        }
        if ((await AsyncStorage.getItem('lsv_bg_restrict_dismissed_v1')) === '1') return;
        Alert.alert(
          'Allow background audio',
          "This device restricts CarFM when it isn't on screen, which breaks up audio in the background.\n\n" +
          "To fix it:\n" +
          "1. Tap “Open Settings” below.\n" +
          "2. Open “App battery usage” (or “Battery”) and turn ON “Allow background usage” (some phones instead call it “Unrestricted” / “Don't optimise”).\n" +
          "3. Then fully close CarFM (swipe it away from the recent-apps list) and open it again so the change takes effect.",
          [
            { text: 'Not now', style: 'cancel' },
            { text: "Don't ask again", style: 'destructive',
              onPress: () => { AsyncStorage.setItem('lsv_bg_restrict_dismissed_v1', '1').catch(() => {}); } },
            { text: 'Open Settings', onPress: () => { LocalHw?.openAppSettings?.(); } },
          ],
        );
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [isLocal, LocalHw]);

  // Persist hardware settings whenever they change (after the initial load).
  useEffect(() => {
    if (!isLocal || !hwLoaded.current) return;
    AsyncStorage.setItem(localHwKey, JSON.stringify({
      autoGain: hwAutoGain, gain: hwGain, ppm: hwPpm, sampleRate: hwSampleRate,
      biasTee: hwBiasTee, agc: hwAgc, directSampling: hwDirectSamp, deemph: hwDeemph, stereo: hwStereo,
    })).catch(() => {});
    // NB: squelch / nrLevel / notch are intentionally NOT saved (session-scoped).
  }, [isLocal, localHwKey, hwAutoGain, hwGain, hwPpm, hwSampleRate, hwBiasTee, hwAgc, hwDirectSamp, hwDeemph, hwStereo]);

  // VibeServer (remote shim): hardware controls ride the WS to the serving device
  // instead of the (non-existent) local dongle. localHost set = remote session.
  const isRemoteShim = isLocal && !!route.params.localHost;

  // Tell the RDS decoder where the RECEIVER is, so it can VALIDATE a station's PI
  // country nibble instead of the app inventing a country. It has to be the ANTENNA's
  // country: a phone in London listening to a German UberSDR hears German stations, so
  // the phone's own locale would be actively wrong. Blank when we don't know, which
  // just falls back to ECC-only (i.e. the old behaviour) rather than to a bad guess.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isRemoteShim && route.params.localHost) {
        // A remote VibeServer publishes its own location, including the country.
        try {
          const r = await fetch(`http://${route.params.localHost}:${route.params.localPort}/location`);
          const j = await r.json();
          if (!cancelled) setReceiverIso(typeof j?.iso === 'string' ? j.iso : '');
        } catch { if (!cancelled) setReceiverIso(''); }
        return;
      }
      if (isLocal) {
        // The dongle is on THIS device, so this device's region is the aerial's region.
        try {
          const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
          const region = loc.split('-')[1] || '';
          if (!cancelled) setReceiverIso(/^[A-Za-z]{2}$/.test(region) ? region : '');
        } catch { if (!cancelled) setReceiverIso(''); }
        return;
      }
      if (!cancelled) setReceiverIso('');   // network instance: we don't know where it is
    })();
    return () => { cancelled = true; setReceiverIso(''); };
  }, [isLocal, isRemoteShim]);

  // The shim learns station names from RDS whenever it runs — serving OR listening —
  // but it has no storage, so something has to write the list down. On a REMOTE shim
  // (VibeServer) the SERVING phone owns that; here we only do it for a shim running
  // on THIS device.
  useEffect(() => {
    if (!isLocal || isRemoteShim) return;
    startBookmarkAutosave();
    return () => stopBookmarkAutosave();
  }, [isLocal, isRemoteShim]);
  // ── Spec ratio (portrait + landscape stored separately) ───────────────────
  const [specRatioPortrait,  setSpecRatioPortrait]  = useState(0.28);
  const [specRatioLandscape, setSpecRatioLandscape] = useState(0.20);
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
      }
    }, 12000);
  }, []);
  const sessionUuid = useMemo(() => uuidv4(), [baseUrl, connEpoch]);

  // ── SDR state ─────────────────────────────────────────────────────────────

  const [connected, setConnected] = useState(false);
  const [serverLost, setServerLost] = useState(false);   // OWRX server crashed/restarted
  // Initialised from AppState.currentState — a cold launch INTO THE BACKGROUND (the
  // watch waking the phone) fires no `change` event, so assuming foreground here made
  // the app behave as though someone were looking at it.
  const appActiveRef  = useRef(AppState.currentState === 'active');
  // Returning from the background: the spectrum was deliberately paused, so the
  // link reads 0 for a moment while the waterfall re-subscribes. Show a calm
  // "reinitialising" notice, cleared when frames return (onLink q>0) or by the
  // watchdog if audio dies too.
  const [reinit, setReinit] = useState(false);
  const reinitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumingRef = useRef(false);   // true during the post-background reinit window
  // Audio came back fine but the spectrum/waterfall never re-subscribed — give
  // the user a way out (reconnect / instance list) instead of a stuck notice.
  const [profiles, setProfiles]   = useState<ProfileInfo[]>([]);  // OWRX only
  // OWRX: server/profile preset DSP defaults (initial_squelch_level / initial_nr_level)
  // pushed on connect + every profile switch; seeds the menu's squelch/NR sliders so
  // they reflect the owner's preset (e.g. an NFM 2 m profile with a fixed squelch).
  const [owrxDspDefaults, setOwrxDspDefaults] =
    useState<{ squelchDb?: number; nrEnabled?: boolean; nrThreshold?: number; seq: number }>({ seq: 0 });
  // Live RDS (FM) / DAB station metadata (OWRX). liveStationRef mirrors the name
  // for the VTS resolver (reads in a debounced callback, avoids stale closures).
  const [dabProgrammes, setDabProgrammes] = useState<DabProgramme[]>([]);  // OWRX DAB ensemble
  const [activeDabId, setActiveDabId] = useState<number>(0);
  // DAB speed correction (dablin chipmunk workaround) — 1 = off; persisted.
  const [dabSpeed, setDabSpeed] = useState<number>(1);
  const [liveStation, setLiveStation] = useState<LiveStation>({});
  const liveBadgeRef = useRef<string | undefined>(undefined);
  const liveStationRef = useRef<string>('');
  const [liveLogo, setLiveLogo] = useState<string | null>(null);   // WFM RDS station favicon
  const lastLiveLogoKey = useRef('');
  // WFM stereo pilot. null = UNKNOWN — nothing has told us yet, so the face shows
  // a blank pill rather than asserting MONO. The head-unit tuner only reports on a
  // CHANGE (NwdRadioStereo), and its one-shot getter is stuck true, so "unknown"
  // is the honest state between connect and the first callback.
  const [fmStereo, setFmStereo] = useState<boolean | null>(null);

  // Decodes the raw RDS groups the native pump reads off NwdFmManager. Held in a
  // ref so it survives re-renders — it accumulates PS/RT segments across groups.
  const rdsDecoder = useRef(createNwdRdsDecoder());
  /** When the last raw group arrived, ms. 0 = none since the last expiry. */
  const lastRdsAtRef = useRef(0);
  /** The face was blanked by an expiry but the DECODER still holds the station.
   *  The next group republishes it verbatim instead of re-acquiring from air. */
  const rdsStaleRef = useRef(false);
  /**
   * How long RDS survives without a group before the face drops it.
   *
   * Was twelve seconds, which the drive of 2026-08-04 showed is far too eager:
   * of fifteen expiries, eight had groups back within ten seconds and one within
   * ONE second. Every one of those blanked the plate for a moment over a station
   * that had not actually gone anywhere. Twenty-five seconds still catches the
   * genuine losses in that same log — the 36s, 60s and 68s gaps — while
   * suppressing all eight of the spurious ones.
   */
  const RDS_STALE_MS = 25_000;

  const [fmSignalDb, setFmSignalDb] = useState<number | null>(null);
  /** Measured level from NwdFmManager.seek — the built-in tuner's real signal
   *  reading, and the only measured one CarFM has ever had. Null until the first
   *  tick. UNDER DEVELOPMENT; see nwdSignalLevel.ts. */
  const [fmLevel, setFmLevel] = useState<number | null>(null);
  /** How many of the glyph's outermost lit wave pairs are drawn dotted — the
   *  reception-loss overlay. Derived from the decoder's rolling PI-match figure,
   *  through a hysteresis band so a value near a boundary cannot flicker a whole
   *  pair on and off. 0 whenever there is no figure at all. */
  // Which readout the face draws — the SETTINGS SELECTION, not the live probe
  // (ANDROID §6.3 v1.13.0). Presentation only; picking RTL-SDR does not re-bind
  // the hardware. See services/tunerBackend.
  const [tunerSel, setTunerSel] = useState(getTunerBackend());
  useEffect(() => {
    void loadTunerBackend().then(setTunerSel);
    return subscribeTunerBackend(() => setTunerSel(getTunerBackend()));
  }, []);

  const [fmDotted, setFmDotted] = useState(0);
  const fmDottedRef = useRef(0);
  useEffect(() => { fmDottedRef.current = fmDotted; }, [fmDotted]);

  // ── Debug/testing mode ───────────────────────────────────────────────────
  // Records one structured sample every 15s so the measured level and the
  // database's PREDICTION can be checked against what a person actually hears.
  // Nothing here runs unless the mode is on.
  const [debugOn, setDebugOn] = useState(isDebugMode());
  // The NWD event handlers are built once, so they would close over a stale
  // `debugOn` forever. A ref is what they read.
  const debugModeRef = useRef(isDebugMode());
  useEffect(() => subscribeDebugMode(() => {
    debugModeRef.current = isDebugMode();
    setDebugOn(debugModeRef.current);
  }), []);
  const ratingAtRef = useRef(0);
  /** Stereo transitions since the last sample. The best cheap proxy for what a
   *  level reading cannot see: multipath collapses the pilot, so a station can
   *  read 55 and still flap. WERN did exactly that all through one commute. */
  const stereoFlipsRef = useRef(0);
  /** RDS expiries since the last sample. */
  const rdsExpiriesRef = useRef(0);
  /** When the dial last moved — a sample taken seconds after a retune has not
   *  settled and must be droppable in analysis. */
  const lastTuneAtRef = useRef(Date.now());
  /** When the last sample closed, so rates are per-window rather than per-drive. */
  const lastSampleAtRef = useRef(Date.now());
  // True while the head unit's built-in NWD tuner is driving the face (a
  // tunerless carFm launch on an NWD/NOWADA unit). Routes tune commands to it.
  const nwdActiveRef = useRef(false);
  const [nwdActive, setNwdActive] = useState(false);   // built-in NWD tuner is the live source
  // Built-in tuner hardware seek: land on the next real station (freq arrives via
  // the NWD callback). Passed to the face only while NWD drives.
  const onFmHardwareSeek = useCallback((dir: 1 | -1) => { nwdSeek(dir > 0); }, []);
  // PI-derived station identity (addendum §6): RDS PI arrives in block 1 almost
  // immediately, so we can name the station from the bundled DB before PS text
  // assembles. A hint only — PS wins when present.
  const [piIdentity, setPiIdentity] = useState<StationIdentity | null>(null);

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
    // CarFM starts on the FM dial (matters for a tunerless launch, where no
    // last-tune restore runs — the face must not show the ham default).
    frequency: 98_500_000,
    mode: 'wfm',
    bandwidthLow: -3000, bandwidthHigh: 3000,
    binCount: 1024, binBandwidth: 0, centerHz: 0, bwHz: 0,
  });
  // Muted via media controls (AirPods squeeze → pause = mute) — native emits
  // VibeMuted so the UI can show a tap-to-unmute banner.
  const [isMuted, setIsMuted] = useState(false);
  const isMutedRef = useRef(false);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  /** The iPhone's real SYSTEM volume (0…1), kept current by the VibeVolume KVO event.
   *  The watch sends DELTAS against it — it never sends an absolute, because the phone
   *  owns the value and the wrist is only allowed to nudge it. */
  const sysVolRef = useRef(1);
  // True when the data saver has dropped the SDR stream after a muted spell.
  const [dataSaverOff, setDataSaverOff] = useState(false);
  const dataSaverOffRef = useRef(false);
  useEffect(() => { dataSaverOffRef.current = dataSaverOff; }, [dataSaverOff]);
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

  // ── Step ──────────────────────────────────────────────────────────────────

  const [step,      setStep]      = useState(1000);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // ── Display settings ──────────────────────────────────────────────────────

  const [dbMin,         setDbMin]         = useState(-120);
  const [dbMax,         setDbMax]         = useState(-20);
  const [colormap,      setColormap]      = useState('Jet');       // production default
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
  // Instance spectrum backdrop opacity 0-10 (3 = web default 0.30); follows the
  // server's configured opacity until the user moves the slider (or a saved
  // pref exists)
  const [bgOpacity,     setBgOpacity]     = useState(3);
  const bgOpacityUserSet = useRef(false);
  useEffect(() => {
    let cancelled = false;
    if (route.params.tunerless) return;   // no server behind the placeholder URL
    fetchUiConfig(baseUrl).then((cfg: ServerUiConfig | null) => {
      if (cancelled) return;
      if (!bgOpacityUserSet.current && typeof cfg?.spectrum_bg_opacity === 'number') {
        setBgOpacity(Math.round(Math.max(0, Math.min(1, cfg.spectrum_bg_opacity)) * 10));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [baseUrl]);

  // FM squelch — value ≤ -999 = open. Only active on fm/nfm modes.
  const [fmSquelch,     setFmSquelch]     = useState(-999);
  // Server-side NR (DSP insert) — filter list + param descriptors arrive via
  // the native audio WS (get_dsp_filters → dsp_filters); params are STRINGS
  // on the wire (server paramInfo is all string-typed).
  const [serverDspEnabled, setServerDspEnabled] = useState(false);
  const [serverDspFilter,  setServerDspFilter]  = useState('');
  const [dspFilters,       setDspFilters]       = useState<DspFilterDesc[]>([]);
  const kiwiSqDbmRef  = useRef(-130);
  const kiwiSqOpenRef = useRef(true);
  const kiwiSqAboveAt = useRef(0);
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

  // ── UI overlay state ──────────────────────────────────────────────────────


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
  }, []);
  // ── Signal / SNR ──────────────────────────────────────────────────────────

  // SNR from radiod's channel status (basebandPower − noiseDensity), pushed by
  // native per audio packet. This is the demodulator's own measurement (zoom-
  // independent, unlike the spectrum). −30 corrects radiod's known +30 dB
  // audio-stream floor offset (madpsy/ka9q_ubersdr#77) so it's honest 0–50 dB,
  // NOT the buggy 30–80 dB UberSDR shows. null until the first reading arrives.
  const audioSnrRef = useRef<number | null>(null);
  // Last time an audio packet was heard (VibeSignal fires ~5×/s while audio
  // flows). Used to tell a slow spectrum re-subscribe (audio still alive → keep
  // the calm "reinitialising" notice) from a genuine drop (audio dead too).
  const lastAudioAtRef = useRef(0);
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

  // ── Recording ─────────────────────────────────────────────────────────────

  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  }, []);

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
        'OpenWebRX receivers use server-side profiles. If you pause from the lock screen, CarFM disconnects to free the receiver — and reconnecting resets it to the server’s default profile and frequency. (Locking the screen while playing keeps audio going; this only applies to an explicit pause.)',
        [{ text: 'Got it' }],
      );
    }).catch(() => {});
  }, [connected]);

  // Handler refs — the decoder-client effect below builds its callbacks once
  // per connect, but tune/mode/filter handlers are declared later in the file
  /** Did WE close the spectrum WS on background? False when the watch kept it
   *  alive, so the foreground path knows not to re-open a live socket. */
  const specPausedByBgRef = useRef(false);

  /** Late-bound: zoomBy is declared further down. */
  const zoomByRef = useRef<((factor: number) => void) | null>(null);

  const onTuneHzRef    = useRef<((hz: number) => void) | null>(null);
  const onModeRef      = useRef<((m: SDRMode) => void) | null>(null);
  const onFilterBothRef = useRef<((low: number, high: number) => void) | null>(null);
  const onVtsJumpRef   = useRef<((d: 'left' | 'right') => void) | null>(null);
  const onSearchTuneRef = useRef<((hz: number, mode?: string | null, isBand?: boolean, voiceStep?: boolean) => void) | null>(null);
  const fmHwStepRef    = useRef<((dir: 1 | -1) => void) | null>(null);   // CarFM: steering-wheel ⏮⏭ → animated preset step

  // ── Media skip mode: lock-screen ⏮⏭ jump between presets ────────────────
  // Steering-wheel / ESP32 ⏮⏭ move between presets (spec §5b).
  const [mediaSkip, setMediaSkip] = useState<'step' | 'bookmark'>('bookmark');
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
    // Whole-profile data modes (DAB, ADS-B, ISM…) have nothing to tune — the only
    // thing a VFO can do is drag you OFF the block and kill the decode.
    if (isWholeProfileMode(String(c.getStatus().mode))) return;
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
  // CarFM steering-wheel ⏮⏭ preset step: a signal the face reacts to by running its
  // animated stepPreset (hero-swap FLIP + step in DISPLAYED/card order). Bumping the
  // seq each press is what makes a repeat press in the same direction re-fire.
  const [fmHwStep, setFmHwStep] = useState<{ dir: 1 | -1; seq: number } | undefined>(undefined);
  // DEVICE-CONFIRMED frequency, in MHz — written ONLY where the tuner itself told
  // us where it is (the NwdRadioFrequency callback and the getter poll). Never by
  // onTuneHz, which writes status.frequency optimistically the instant we ASK for
  // a tune.
  //
  // That distinction is the whole point. CarFmFace holds the hero on a committed
  // target until the dial arrives, but it was comparing the target against
  // status.frequency — i.e. against our own echo of the request — so the hold
  // released in the same React commit that opened it, every single time. The
  // 30 July drive log proves it: six preset steps, six instant "settled" lines,
  // and not one "holding" line. With the hold gone, the vendor service's own
  // preset walk (it steps ITS list on the same wheel press, transiting 98.1,
  // 100.7, 100.9, 101.1 …) painted straight onto the hero for a second or so
  // before our tune landed. That is the jitter.
  // Carries a `seq` because the frequency alone is not enough. If the face commits
  // to the station the tuner is ALREADY sitting on (press prev then next, landing
  // back where you started), a bare frequency match would settle instantly — and
  // then the vendor's transit away-and-back would jitter the hero anyway. The face
  // records the seq at commit time and only accepts a LATER report, so "already
  // there" still waits for the round trip.
  //
  // Change-gated on purpose: the 1 Hz getter poll must not bump the seq when it
  // merely re-reports the same frequency, or this would re-render every second and
  // the seq would carry no information.
  const [fmDevice, setFmDevice] = useState<{ mhz: number; seq: number } | null>(null);
  const fmDeviceSeq = useRef(0);
  /** The dial, for code that runs inside long-lived event closures where the
   *  `status` state would be stale. */
  const curMhzRef = useRef(0);

  const reportDeviceMhz = useCallback((mhz: number) => {
    curMhzRef.current = mhz;
    setFmDevice((prev) => (prev && Math.abs(prev.mhz - mhz) < 0.005
      ? prev
      : { mhz, seq: ++fmDeviceSeq.current }));
  }, []);

  /**
   * Close one debug sample: the level just measured, the position at that same
   * instant, what the station database predicts from there, and the reception
   * signals a level reading cannot see. One line, fixed columns.
   *
   * Everything is best-effort — a missing GPS fix or a station absent from the
   * database yields `?` in that column rather than dropping the sample, because
   * "the level was 54 and we do not know where" is still worth having.
   */
  /** One sample at a time. getDetailedLocation waits up to 8s for a live fix
   *  while the 15s tick keeps coming, so without this two samples overlap and
   *  corrupt each other's window — which is exactly what happened on
   *  2026-08-05: `tuned=-2s`, `rds=44.0/s` against a physical ceiling of ~11.4,
   *  and thirteen timestamps carrying two samples each. */
  const samplingRef = useRef(false);

  const writeDebugSample = useCallback(async (level: number) => {
    if (samplingRef.current) return;
    samplingRef.current = true;
    try {
    // SNAPSHOT EVERYTHING FIRST, then await. Every value below belongs to the
    // instant the level was measured; reading any of them after the GPS wait
    // means reading state a later retune or a later sample has already moved.
    const now = Date.now();
    const mhz = curMhzRef.current > 0 ? curMhzRef.current : null;
    const sinceTuneS = (now - lastTuneAtRef.current) / 1000;
    const windowS = Math.max(1, (now - lastSampleAtRef.current) / 1000);
    const st = rdsDecoder.current.stats();
    const flips = stereoFlipsRef.current;
    const expiries = rdsExpiriesRef.current;
    // A rating only counts for the station it was pressed on. Retuning clears it
    // (see the frequency handler), and this second check catches the race where a
    // press and a retune land between two samples: the press must be NEWER than
    // the tune, and on the same dial position.
    const ratingOwned = ratingRef.current != null && ratingBelongsHere({
      pressedAtMs: ratingAtRef.current || null,
      pressedMhz: ratingMhzRef.current,
      tunedAtMs: lastTuneAtRef.current,
      currentMhz: mhz,
    });
    const rating = ratingOwned ? ratingRef.current : null;
    const ratingAgeS = rating ? (now - ratingAtRef.current) / 1000 : null;
    // Close the window NOW, so groups arriving during the GPS wait count toward
    // the NEXT sample rather than being double-counted or lost.
    rdsDecoder.current.resetStats();
    stereoFlipsRef.current = 0;
    rdsExpiriesRef.current = 0;
    lastSampleAtRef.current = now;

    const loc = await getDetailedLocation(8000);

    // What the database expects here. stationsAtFrequency is nationwide, so with
    // a fix we pick the best-receivability row on this channel; without one there
    // is nothing honest to say.
    let predScore: number | null = null, distKm: number | null = null;
    let brg: number | null = null, erpKw: number | null = null;
    let stationClass: string | null = null, dbCall: string | null = null;
    if (loc && mhz != null) {
      try {
        const rows = await stationsAtFrequency(mhz);
        let best: { row: (typeof rows)[number]; score: number; d: number } | null = null;
        for (const row of rows) {
          const d = haversineKm(loc.lat, loc.lon, row.lat, row.lon);
          const score = receivabilityScore({ erpKw: row.erpKw, stationClass: row.stationClass, distanceKm: d });
          if (!best || score > best.score) best = { row, score, d };
        }
        if (best) {
          predScore = best.score;
          distKm = best.d;
          brg = bearingDeg(loc.lat, loc.lon, best.row.lat, best.row.lon);
          erpKw = best.row.erpKw;
          stationClass = best.row.stationClass;
          dbCall = best.row.callsign;
        }
      } catch { /* leave the prediction columns unknown */ }
    }

    const sample: DebugSample = {
      mhz,
      level,
      bars: levelToLit(level),
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      accM: loc?.accM ?? null,
      speedMs: loc?.speedMs ?? null,
      headingDeg: loc?.headingDeg ?? null,
      fixAgeS: loc?.fixAgeS ?? null,
      predScore, distKm, bearingDeg: brg, erpKw, stationClass, dbCall,
      rdsGroupsPerSec: st.groups / windowS,
      rdsErrPct: st.groups ? (100 * st.piMismatch) / st.groups : null,
      stereoFlips: flips,
      rdsExpiries: expiries,
      sinceTuneS,
      // A rating is an observation about a MOMENT, not a standing verdict. Past
      // its freshness window the sample carries none rather than implying the
      // driver still means it — the first build let one press colour every
      // sample until the next, which made 111 of 156 samples read "clean".
      //
      // It is also an observation about a STATION. The 2026-08-06 drive proved
      // that mattered: a hop across six presets in ninety seconds filed seven
      // verdicts against stations the driver had already left, including a
      // "clean" recorded against a frequency tuned zero seconds earlier. Those
      // rows are indistinguishable from real data unless `tuned=` happens to
      // expose the mismatch, and they land squarely on the loss thresholds.
      rating: rating && ratingAgeS != null && ratingAgeS <= RATING_FRESH_S ? rating : null,
      ratingAgeS: rating && ratingAgeS != null && ratingAgeS <= RATING_FRESH_S ? ratingAgeS : null,
    };
    diag(formatSample(sample));
    } finally {
      samplingRef.current = false;
    }
  }, []);

  /** The rating, for the sampler's long-lived closure. */
  const ratingRef = useRef<AudioRating | null>(null);
  /** The dial position the rating was pressed on — the address on the verdict. */
  const ratingMhzRef = useRef<number | null>(null);
  const onRateAudio = useCallback((r: AudioRating) => {
    ratingRef.current = r;
    ratingAtRef.current = Date.now();
    ratingMhzRef.current = curMhzRef.current > 0 ? curMhzRef.current : null;
    // Its own event line: the periodic sample carries the rating too, but the
    // moment of the press is when the driver heard the thing.
    diag(`RATE ${r} (${RATING_LABELS[r]}) f=${curMhzRef.current.toFixed(1)} lvl=${fmLevelRef.current ?? '?'}`);
  }, []);
  const fmLevelRef = useRef<number | null>(null);
  useEffect(() => { fmLevelRef.current = fmLevel; }, [fmLevel]);

  const fmHwSeq = useRef(0);
  const fmDoHwStep = useCallback((dir: 1 | -1) => {
    fmHwSeq.current += 1;
    setFmHwStep({ dir, seq: fmHwSeq.current });
  }, []);
  fmHwStepRef.current = fmDoHwStep;
  useEffect(() => {
    AsyncStorage.getItem('lsv_media_skip').then((v: string | null) => {
      if (v === 'bookmark' || v === 'step') setMediaSkip(v);
    }).catch(() => {});
  }, []);
  // Push to native; re-push on reconnect (the Android service can be recreated)
  useEffect(() => {
    VibePowerModule?.setMediaSkipMode(mediaSkip);
  }, [mediaSkip, connected]);

  // ── Pause = disconnect / Play = reconnect ─────────────────────────────────
  // Pause drops the SDR (the server lets it go on suspend anyway) and Play does
  // a full reconnect. If that reconnect doesn't land within a few seconds (server
  // full / rate-limited) we flag it to native so the lock-screen card tells the
  // user to open the app.
  const connectedRef = useRef(false);
  useEffect(() => {
    connectedRef.current = connected;
    if (connected) { VibePowerModule?.setReconnectFailed?.(false); }
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

  // Android back gesture/button: CONSUME it on this screen (iOS parity —
  // gestureEnabled:false on the stack). Edge swipes while working the VFO
  // drum were popping to the picker / exiting the app. Close transient UI
  // if open; leaving the instance is the menu's ← BACK button. RN Modals
  // (menu, maps, browser) intercept back themselves before this fires.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // ── Display style — wired to ThemeContext so the whole app re-renders ────────
  const { themeName, setTheme } = useTheme();
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
      lastAudioAtRef.current = Date.now();
    });
    // Native ⏮⏭ defer to JS. Bookmark mode jumps the station list; step mode
    // (used by OWRX/Kiwi, whose tuning lives in JS) snaps by the tune step.
    const subSkip = emitter.addListener('VibeSkip', (e: { direction: string }) => {
      const dir = e.direction === 'prev' ? 'left' : 'right';
      // DAB: cycle programmes within the ensemble (the VFO is locked there).
      if (String(client.current?.getStatus().mode) === 'dab') { dabSkipRef.current?.(dir); return; }
      // Drive the FACE's animated preset step (hero-swap FLIP, steps in
      // displayed/card order) — not onVtsJump, which silently retuned by frequency.
      fmHwStepRef.current?.(dir === 'left' ? -1 : 1);
    });
    // DIAGNOSTIC: raw media-button keycodes from the service's MediaSession. On
    // the built-in NWD path this confirms the steering wheel actually reaches
    // CarFM (and with which keycode) while the control session is held.
    const subMediaKey = emitter.addListener('VibeMediaKey', (e: { keyCode: number; keyName: string; nwdControl: boolean }) => {
      diag(`media key: ${e.keyName} (${e.keyCode})${e.nwdControl ? ' [nwd-control]' : ''}`);
    });
    // DIAGNOSTIC: keys injected into the ACTIVITY input stream (capture path 2 —
    // some units deliver the wheel as plain key events to the foreground app).
    const subHwKey = emitter.addListener('VibeHwKey', (e: { keyCode: number; keyName: string; nwdControl: boolean }) => {
      diag(`activity key: ${e.keyName} (${e.keyCode})${e.nwdControl ? ' [nwd-control]' : ''}`);
    });
    // DIAGNOSTIC: audio-focus grant/changes for the NWD control session — shows
    // whether CarFM won focus (the media-key routing condition) and who takes it.
    const subFocus = emitter.addListener('VibeFocus', (e: { change: number; granted: boolean }) => {
      diag(e.change === 0 ? `nwd focus request: ${e.granted ? 'GRANTED' : 'DENIED'}` : `nwd focus change: ${e.change}`);
      // Focus is a HINT here, never the state. An earlier version drove the
      // powered-off face straight off these events and had two faults: Android
      // sends no GAIN after a permanent LOSS, so the face went grey for the rest
      // of the drive even once the MCU handed FM back; and LOSS_TRANSIENT — what
      // a navigation prompt raises — greyed the whole radio for the length of a
      // spoken direction. The 1.5s poll reads the MCU source instead and recovers
      // on its own; all this does is get there a beat sooner.
      //
      //   -1 LOSS  -> something took the speakers for good; reflect it now, and
      //               let the poll light it back up if the MCU returns FM.
      //   -2/-3    -> transient. A nav prompt or a ping. Leave the face alone.
      //    1 GAIN  -> ours again.
      if (userPoweredOffRef.current) return;
      if (e.change === -1) setFmAudioActive(false);
      else if (e.change === 1 || (e.change === 0 && e.granted)) setFmAudioActive(true);
    });
    // Car audio route / Android Auto client connect — gates band-aware auto
    // mode/step (handheld use is never auto-switched).
    const subCar = emitter.addListener('VibeCarConnected', (e: { connected: boolean }) => {
      carConnected.current = !!e.connected;
    });
    // Car browse list pick (Android Auto) — tune via the shared onSearchTune path
    // so band-aware mode/step + region logic stay in one place.
    const subCarTune = emitter.addListener('VibeCarTune',
      (e: { frequency: number; mode?: string | null; isBand?: boolean }) => {
        onSearchTuneRef.current?.(e.frequency, e.mode ?? null, !!e.isBand);
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
    // The OS says the network path moved under us (WiFi→cellular, or a cellular IP
    // change on cell handover). Neither sends a FIN or an RST, so every socket on
    // the old flow is now a zombie that will sit OPEN forever. Native has already
    // treated the audio WS as suspect; the spectrum WS is JS's to revive, and it
    // has the same zombie on the same dead flow. Rate-limited inside the client.
    const subPath = emitter.addListener('VibeNetworkPathChanged', () => {
      client.current?.forceResubscribe?.('network-path-change');
    });
    // The device's SYSTEM volume changed — by the hardware buttons, a headset's own
    // rocker, etc. Track it so the app's own volume state stays in sync.
    const subVol = emitter.addListener('VibeVolume', (e: { volume: number }) => {
      sysVolRef.current = e.volume;
    });
    // Seed it. The observer emits the current volume when it starts, but that can land
    // before this listener exists — and it only fires on CHANGE thereafter, so read
    // the current value explicitly.
    (NativeModules.VibePowerModule as { getSystemVolume?: () => Promise<number> })
      ?.getSystemVolume?.()
      .then((v) => { sysVolRef.current = v; })
      .catch(() => {});
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
      }
    });
    return () => {
      sub.remove(); subMute.remove(); subSig.remove(); subSkip.remove(); subMediaKey.remove(); subHwKey.remove(); subFocus.remove(); subWs.remove();
      subCar.remove(); subCarTune.remove(); subDsOff.remove(); subDsOn.remove(); subPath.remove(); subVol.remove();
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
    // CarFM tunerless session: no tuner, so no backend at all — the face shows
    // the tuner-error pill. There is NO background polling: a dongle plugged in
    // later is connected on demand via the settings panel's RETRY action.
    // Creating a client against the placeholder URL would just spin a reconnect
    // loop against a dead socket.
    if (route.params.tunerless) return;
    destroyed.current = false;
    const c = createBackend(route.params.serverType ?? 'ubersdr', baseUrl, sessionUuid, {
      // (callbacks below; bypass password rides every WS URL)
      onConnect:    () => { if (!destroyed.current) { setConnected(true); setServerLost(false); resumingRef.current = false; if (reinitTimer.current) { clearTimeout(reinitTimer.current); reinitTimer.current = null; } setReinit(false); } },
      onDisconnect: () => { if (!destroyed.current) setConnected(false); },
      // VibeServer: the serving device's tuner gains → drive the gain slider (a
      // remote client can't query the hardware natively).
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
        (VibePowerModule as any)?.stopExternalAudio?.();
      },
      onReconnecting: () => {},
      onLink: (q) => {
        if (destroyed.current) return;
        // UberSDR auto-reconnects silently — without a cue the app just looks
        // frozen when the link drops (e.g. the instance reboots). But the spectrum
        // is deliberately paused on minimise/resume, which briefly starves the
        // link to 0 with audio still fine — so DEBOUNCE: only pop after a sustained
        // drop, and cancel the instant the link recovers. OWRX/Kiwi use serverLost.
        if ((route.params.serverType ?? 'ubersdr') === 'ubersdr' && appActiveRef.current && q !== 0) {
          // Frames flowing again — the post-resume reinit completed, so drop the
          // "reinitialising" notice.
          if (resumingRef.current) {
            resumingRef.current = false;
            if (reinitTimer.current) { clearTimeout(reinitTimer.current); reinitTimer.current = null; }
            setReinit(false);
          }
        }
      },
      onStatus:     (s) => { if (!destroyed.current) setStatus(s); },
      onSMeter:     (dbm) => { if (!destroyed.current) { owrxSmeterRef.current = dbm; if (isKiwi) evalKiwiSquelch(dbm); } },
      onProfiles:   (list) => { if (!destroyed.current) setProfiles(list); },
      onServerDspDefaults: (d) => {
        // Adapter already applied these to the demod; bump seq so the menu re-syncs
        // its sliders even when the new profile presets the same value as before.
        if (!destroyed.current) setOwrxDspDefaults((p) => ({ ...d, seq: p.seq + 1 }));
      },
      onBookmarks:  (list) => {
        // OWRX server bookmarks/dial markers (over the WS) → same path as
        // UberSDR's fetched bookmarks: VTS station readout + search bar.
        if (!destroyed.current) setServerBookmarks(list.map((b) => ({ name: b.name, frequency: b.frequency, mode: b.mode, repeater: b.repeater, source: 'server' as const })));
      },
      onMetadata:   (meta) => {
        if (destroyed.current) return;
        // RDS (FM) / DAB labels feed the SAME station display as bookmarks (VTS),
        // so a live station name shows uniformly regardless of source.
        liveStationRef.current = meta.stationName ?? '';
        liveBadgeRef.current = meta.badge;
        const nextLive: LiveStation = { name: meta.stationName, text: meta.text, rtArtist: meta.rtArtist, rtTitle: meta.rtTitle, tp: meta.tp, ta: meta.ta, pty: meta.pty, af: meta.af, afMhz: meta.afMhz, badge: meta.badge, countryIso: meta.countryIso, pi: meta.pi };
        setLiveStation(prev => liveStationEqual(prev, nextLive) ? prev : nextLive);
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
        // Geometry/status drives the React overlay (band plan, readouts) —
        // only update when something actually changed (settled frames don't).
        // Epsilon gate: radiod's per-frame frequency stamps can jitter ±1Hz —
        // exact comparison leaked ~3-5 full-tree renders/s while settled
        // (render-counter diagnostic 2026-06-11). Sub-2Hz wobble is invisible
        // at any usable span; real changes pass untouched. Kept even under the FM
        // face so the tuned-frequency readout stays live.
        setStatus((prev: SDRStatus) =>
          Math.abs(prev.centerHz - s.centerHz) < 2 &&
          Math.abs(prev.bwHz - s.bwHz) < 2 &&
          prev.frequency === s.frequency && prev.mode === s.mode &&
          prev.bandwidthLow === s.bandwidthLow && prev.bandwidthHigh === s.bandwidthHigh &&
          prev.binCount === s.binCount &&
          Math.abs(prev.binBandwidth - s.binBandwidth) < 1e-6
            ? prev : s);
      },
      onError: (msg) => {
        if (destroyed.current) return;
        // The bypass-password box this used to open no longer exists, so the
        // rate-limited branch showed nothing at all. Both cases now surface the
        // same alert rather than failing silently.
        Alert.alert('Connection Error', msg, [
          { text: 'Back to Instances', onPress: () => navigation.goBack() },
        ]);
      },
    }, password, !!route.params.isLocal);
    client.current = c;
    // Apply the persisted VFO-lock follow mode to the fresh connection.
    c.setFollowMode(vfoLockedRef.current);
    // Local hardware: thread the live device sample rate for panSpan()'s window.
    if (route.params.isLocal) (c as { setLocalSampleRate?: (hz: number) => void }).setLocalSampleRate?.(hwSampleRate);
    // VibeServer PIN: append the auth suffix to the spectrum WS.
    if (route.params.authSuffix) (c as { setAuthSuffix?: (s: string) => void }).setAuthSuffix?.(route.params.authSuffix);
    // QoL: restore the last frequency/mode used on THIS instance before
    // connecting (the hardcoded default landed on the 20m FT8 squeal every
    // launch). Falls back to the default tune on first visit / bad data.
    let cancelled = false;
    const tuneKey = isLocal ? `lsv_last_tune:${localDeviceKey}` : 'lsv_last_tune:' + baseUrl;
    (async () => {
      let j = await AsyncStorage.getItem(tuneKey).catch(() => null);
      // Migrate the pre-per-device global local key on first per-device connect.
      if (j == null && isLocal) j = await AsyncStorage.getItem('lsv_last_tune:local').catch(() => null);
      return j;
    })().then((j: string | null) => {
      if (cancelled || destroyed.current) return;
      let f = status.frequency;
      let m: SDRMode = status.mode;
      if (j) {
        try {
          const p = JSON.parse(j) as { frequency?: unknown; mode?: unknown };
          // MAX_HZ (30 MHz) is the HF ceiling for network SDRs, but local RTL-SDR
          // hardware tunes VHF/UHF — so an FM/airband/etc. last-tune would fail
          // the guard and silently reset to the default. Use a wide hardware bound
          // for local (the per-device key only ever stores a freq that was
          // tunable on THIS device, so it's inherently valid).
          const hiHz = isLocal ? 2_000_000_000 : MAX_HZ;
          if (typeof p.frequency === 'number' && p.frequency >= MIN_HZ && p.frequency <= hiHz) {
            f = Math.round(p.frequency);
          }
          if (typeof p.mode === 'string' && p.mode in MODE_BANDWIDTHS) m = p.mode as SDRMode;
        } catch {}
      }
      // NB: no device-range clamp here — the per-device key already means each
      // source only ever restores ITS OWN last frequency (valid when saved), so
      // there's nothing to guard against, and c.caps.freqRange isn't reliable yet
      // at restore time (the local device's real caps land after connect), which
      // made it wrongly reset an in-range frequency to the default.
      // A carfm:// deep link's freq/mode override the persisted last-tune, but
      // only on the first connect of this screen (consumed via the ref) so a
      // reconnect/rotation later doesn't yank the user back to the link's freq.
      if (!deepLinkTuneApplied.current) {
        deepLinkTuneApplied.current = true;
        const df = route.params.initialFreq;
        const dm = route.params.initialMode;
        if (typeof df === 'number' && df >= MIN_HZ && df <= MAX_HZ) f = Math.round(df);
        if (typeof dm === 'string' && dm in MODE_BANDWIDTHS) m = dm as SDRMode;
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
  // One-shot: a deep-link initial tune is applied on the first connect only.
  const deepLinkTuneApplied = useRef(false);
  // Start the session countdown once we're actually connected.
  useEffect(() => {
    if (!connected || !sessionLimitMins || sessionEndsAt) return;
    setSessionEndsAt(Date.now() + sessionLimitMins * 60_000);
  }, [connected, sessionLimitMins, sessionEndsAt]);

  // One combined notice covering BOTH constraints — a read-only, time-limited
  // receiver should not produce two popups in a row.
  useEffect(() => {
    if (noticeShownRef.current || !connected) return;
    if (!readOnly && !sessionLimitMins) return;
    noticeShownRef.current = true;
    const parts: string[] = [];
    if (readOnly) parts.push(
      'This receiver is listen-only — another user is controlling it, so tuning ' +
      'and mode controls are disabled.');
    if (sessionLimitMins) parts.push(
      `This receiver limits each listener to ${sessionLimitMins} minutes. ` +
      'A countdown is shown next to the clock, and it will disconnect you when the time is up.');
    Alert.alert(readOnly && sessionLimitMins ? 'Listen-only, and time limited'
                : readOnly ? 'Listen-only receiver' : 'Time-limited receiver',
                parts.join('\n\n'));
  }, [connected, readOnly, sessionLimitMins]);

  // rtl_tcp link meter: poll the shim's network-stall counter — periods where the
  // socket delivered nothing for >120 ms. That is the honest client-side view of
  // the link; the backend's own quality reading is FFT-frame timing measured after
  // the jitter buffer, so it stays green while the network is failing.
  useEffect(() => {
    if (!isLocal) return;
    let last = -1;
    let toldClosed = false;
    const t = setInterval(async () => {
      try {
        const s = await LocalHw?.getNetStatus?.();
        if (!s?.tcp) { netLinkRef.current = 3; return; }   // USB path: nothing to clamp

        // The SpyServer hung up. It is NOT a generic connection loss: public
        // servers enforce session limits (30 min – 24 h) and hand the single
        // tuner to whoever asks next. Say so, once.
        if (s.spy && s.closed && !toldClosed) {
          toldClosed = true;
          Alert.alert(
            'Receiver disconnected',
            'The SpyServer closed the connection. Public receivers often limit how ' +
            'long one listener can stay, and many allow only one at a time — someone ' +
            'else may now have the tuner.',
            [{ text: 'OK', onPress: () => navigation.goBack() }],
          );
          return;
        }
        // Another client owns the tuner: the dial would silently do nothing.
        if (s.spy) setReadOnly(!s.canControl);

        const n = s.stalls ?? 0;
        if (last < 0) { last = n; return; }                // first sample: no delta yet
        const delta = n - last;
        last = n;
        netLinkRef.current = delta === 0 ? 3 : delta <= 2 ? 2 : 1;
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [isLocal, navigation]);

  // Audio engine start is GATED on the restore (ms-fast): the engine used to
  // start with the default 14.074/USB in the audio-WS URL and the corrective
  // restore tune could lose the race against the WS handshake — server stayed
  // on 20m FT8/USB while the UI showed the restored station (sounded like
  // "broken AM"), and zoom anchored on the stale server frequency.
  const [tuneLoaded, setTuneLoaded] = useState(false);

  useEffect(() => {
    if (!lastTuneLoaded.current || !status.frequency) return;
    const t = setTimeout(() => {
      // Local hardware's baseUrl has a per-session port → use a stable PER-DEVICE
      // key (usb / tcp:host:port) so the last tune restores and devices don't
      // clobber each other (otherwise it reverts to the 14 MHz default).
      AsyncStorage.setItem(isLocal ? `lsv_last_tune:${localDeviceKey}` : 'lsv_last_tune:' + baseUrl,
        JSON.stringify({ frequency: status.frequency, mode: status.mode })).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [status.frequency, status.mode, baseUrl]);

  useEffect(() => {
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state: string) => {
      // Tunerless carFm session: there is NO client, no audio, no spectrum —
      // none of the resume/reinit machinery below applies, and letting it run
      // armed a watchdog that escalated into a bogus blocking "Connection
      // lost" card over the face (device test 2026-07-17).
      if (route.params.tunerless) { appActiveRef.current = (state === 'active'); return; }
      if (state !== 'active') {
        if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
        // Backgrounded: the spectrum pause starves the link to 0, but that's NOT
        // a disconnect (audio keeps playing). Suppress the connection-lost popup
        // while backgrounded and reset it so a long lock can't leave it armed.
        appActiveRef.current = false;
        resumingRef.current = false;
        if (reinitTimer.current) { clearTimeout(reinitTimer.current); reinitTimer.current = null; }
        setReinit(false);
        specPausedByBgRef.current = true;
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
        // Surface the calm "waterfall reinitialising" notice while the spectrum
        // re-subscribes. If frames return (onLink q>0) it clears itself. After a
        // long background the spectrum can take a while to come back even though
        // audio never stopped — so the watchdog only escalates to the real
        // "Connection lost" popup when AUDIO is also dead; while audio still
        // flows it keeps the calm notice and re-checks.
        if ((route.params.serverType ?? 'ubersdr') === 'ubersdr' && specPausedByBgRef.current) {
          resumingRef.current = true;
          setReinit(true);
          const resumeStartedAt = Date.now();
          const armReinitWatchdog = () => {
            if (reinitTimer.current) clearTimeout(reinitTimer.current);
            reinitTimer.current = setTimeout(() => {
              reinitTimer.current = null;
              if (destroyed.current || !resumingRef.current) return;
              if (Date.now() - lastAudioAtRef.current < 2000) {
                // Audio is still flowing → we're connected. If the spectrum has
                // been silent for a long while it has genuinely failed to
                // re-subscribe — surface an escape (reconnect / instance list)
                // rather than spin the calm notice forever. Otherwise keep
                // waiting; it's just slow to come back.
                if (Date.now() - resumeStartedAt > 10000) {
                  resumingRef.current = false;
                  setReinit(false);
                  return;
                }
                armReinitWatchdog();
                return;
              }
              // Audio is dead too → genuine disconnect.
              resumingRef.current = false;
              setReinit(false);
            }, 3500);
          };
          armReinitWatchdog();
        }
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          // If the watch kept the socket alive through the lock there is nothing
          // to re-subscribe — just restore full rate. Re-opening a live socket
          // would drop frames and flash the "reinitialising" notice for nothing.
          if (specPausedByBgRef.current) {
            specPausedByBgRef.current = false;
            client.current?.resumeSpectrum();
          }
          // ALWAYS restore full rate on wake, on every path. If the watch held the
          // socket open through the lock we dropped the feed to quarter rate for
          // it; failing to undo that anywhere leaves the phone's own waterfall
          // crawling at 5fps.
          idleActiveRef.current = false;
          client.current?.setRate(1);
        }, 1200);
      }
    });
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
      if (reinitTimer.current) { clearTimeout(reinitTimer.current); reinitTimer.current = null; }
      sub.remove();
    };
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

  const zoomBy = useCallback((factor: number) => {
    const c = client.current; if (!c) return;
    const v = c.getView(); if (!v.binBandwidth || !v.centerHz) return;
    c.zoom(zoomAnchorHz(v), Math.max(1, v.binBandwidth * factor));
  }, [zoomAnchorHz]);

  // ── Mode / filter / tune ──────────────────────────────────────────────────

  const onMode = useCallback((m: SDRMode) => {
    const c = client.current; if (!c) return;
    c.setMode(m); // client mirrors the server's per-mode bandwidth defaults
    setStatus({ ...c.getStatus() });
    if (m !== 'wfm') setFmStereo(false);  // stereo icon only applies to WFM
  }, []);

  // Atomic both-edges setter — single setBandwidth, no stale-closure edge
  const onFilterBoth = useCallback((low: number, high: number) => {
    client.current?.setBandwidth(low, high);
    setStatus((prev: SDRStatus) => ({ ...prev, bandwidthLow: low, bandwidthHigh: high }));
  }, []);

  // ── Audio-WS commands (set_dsp / squelch / gate are AUDIO-WS message types;
  //    the spectrum WS doesn't know them — the old client.setNRMode/setDsp
  //    paths were sending into the void) ──────────────────────────────────────
  const sendAudioCmd = useCallback((obj: Record<string, unknown>) => {
    VibePowerModule?.sendAudioCommand(JSON.stringify(obj));
  }, []);

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
  }, []);

  // Param edits send the FULL params map, debounced 120ms (skin parity)
  const dspParamTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (dspParamTimer.current) clearTimeout(dspParamTimer.current);
  }, []);

  const onTuneHz = useCallback((hz: number) => {
    markInteract();
    const c = client.current;
    // Tunerless CarFM session: no backend exists (the connect effect skips it),
    // but the face must still track the chosen frequency so a Nearby pick /
    // numpad entry / preset / seek updates the readout and the ★ save target —
    // and reads back as the user's choice — even with no dongle connected.
    if (!c) {
      setStatus((prev: SDRStatus) => ({ ...prev, frequency: Math.round(hz) }));
      // Built-in NWD tuner (no SDR client): drive the hardware tuner directly.
      if (nwdActiveRef.current) nwdTune(Math.round(hz) / 1e6).catch(() => {});
      return;
    }
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
    zoomByRef.current      = zoomBy;
    onFilterBothRef.current = onFilterBoth;
    onVtsJumpRef.current   = onVtsJump;
    onSearchTuneRef.current = onSearchTune;
  });

  // ── VTS (station/band steward — a11y popup bar only, no tuning guide) ─────
  // Stations come from /api/bookmarks (static config + live EiBi schedule);
  // popup shows the station name when within 150kHz (green when within 99Hz),
  // and band-plan info when crossing a band boundary. Menu arrows jump
  // bookmarks; an arrow jump defers any band notif 3s so the station name
  // shows first (skin VTS_ARROW_BOOKMARK_MS).
  // ITU region drives the MW channel step (9 kHz region 1, 10 kHz region 2/3).
  // ITU region 2 — the Americas. FIXED, not detected.
  //
  // CarFM is a North American car radio: the station database is the FCC's, and
  // PTY labels use RBDS. Deriving the region was a VibeSDR concern, where a
  // listener might connect to a receiver anywhere on earth. Here it only ever
  // produced ways to be wrong — the head-unit tuner reports no longitude and the
  // unit reports no GPS fix, so detection resolved to "unknown" and silently fell
  // back to the European PTY table, printing "Drama" over a classic-rock station.
  //
  // If CarFM is ever wanted outside region 2, this is the one line to revisit.
  const ituRegion = 2;
  const vtsBookmarks = useRef<ServerBookmark[]>([]);
  const [searchBands,     setSearchBands]     = useState<ServerBand[]>([]);
  const searchBandsRef = useRef<ServerBand[]>([]);
  useEffect(() => { searchBandsRef.current = searchBands; }, [searchBands]);
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
  useEffect(() => {
    let cancelled = false;
    const st = route.params.serverType ?? 'ubersdr';
    // OUR band plan is ALWAYS the search bar's band list, on every backend (the
    // server /api/bands only exists on UberSDR; Kiwi/OWRX have none).
    setSearchBands(BAND_PLAN.map((b: Band) => ({
      label: b.bandLabel ?? b.name, start: b.lo, end: b.hi, group: b.type, mode: b.mode,
    })));
    // LOCAL / VibeServer: the shim learns stations from RDS as you tune, so local
    // hardware is no longer bookmark-less — it builds its own list of what this
    // aerial can actually hear. Poll it (the shim keeps it in memory; the autosave
    // effect above is what writes it down).
    if (isLocal) {
      const load = () => {
        getLearnedBookmarksNow()
          .then((b) => { if (!cancelled && b.length) setServerBookmarks(b); })
          .catch(() => {});
      };
      load();
      const iv = setInterval(load, 30_000);
      loadUserBookmarks().then((b: UserBookmark[]) => { if (!cancelled) setUserBookmarks(b); }).catch(() => {});
      return () => { cancelled = true; clearInterval(iv); };
    }

    // Server bookmarks: UberSDR via REST; OWRX/Kiwi arrive over the WS
    // (onBookmarks, tagged source='server' there).
    // Whatever a backend yields is preferred; if it yields nothing, the EiBi
    // fallback below fills in — that's how Kiwi gets a searchable list.
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
  }, [serverBookmarks, eibiBookmarks, eibiEnabled, userBookmarks, baseUrl, ituRegion]);

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
    // WFM broadcast FM: show the RDS country flag + station logo (from PI/ECC).
    const wfm = status.mode === 'wfm';
    const flag = wfm && validIso(liveStation.countryIso) ? isoToFlag(liveStation.countryIso) : undefined;
    const logoUrl = wfm ? (liveLogo ?? undefined) : undefined;
    const composite = `${display}|${flag ?? ''}|${logoUrl ?? ''}`;
    if (composite !== vtsLastStation.current) {
      vtsLastStation.current = composite;
      vtsKey.current++;
      // Live server data (RDS/DMR/DAB) holds on screen until it changes/clears
      // — only the static bookmark/band notifs time out. Badge flags the source.
      setVtsNotif({ key: vtsKey.current, name: display, kind: 'station-on', hold: true, badge: liveBadgeRef.current, flag, logoUrl });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStation.name, liveStation.text, liveStation.countryIso, liveLogo, status.mode]);

  // ── Station logo ────────────────────────────────────
  // NOT gated on WFM any more. The gate existed because a station name only ever
  // arrived via RDS, which is FM-only — but a name now also comes from a bookmark or
  // the EiBi schedule, so an AM or shortwave station has one too, and EiBi even states
  // the transmitter's country outright. Refusing to look it up outside WFM meant the
  // browser client showed logos for stations the app wouldn't.
  useEffect(() => {
    const name = liveStation.name?.trim();
    const iso = validIso(liveStation.countryIso) ? liveStation.countryIso!.toUpperCase() : '';
    const key = `${name ?? ''}|${iso}`;
    if (key === lastLiveLogoKey.current) return;
    lastLiveLogoKey.current = key;
    if (!name) { setLiveLogo(null); return; }
    setLiveLogo(null);
    resolveStationLogo({ pi: liveStation.pi, name, iso: iso || undefined }).then((url) => {
      if (!destroyed.current && lastLiveLogoKey.current === key) setLiveLogo(url);
    });
  }, [liveStation.name, liveStation.countryIso, liveStation.pi]);

  // ── VTS-aware media session ────────────────────────────────────────────────
  // Track  = freq (user's unit) + demod + tune step ("648 kHz AM · 9 kHz step")
  // Artist = "CarFM: Radio Caroline" on a station, else the band
  //          ("CarFM: 40m Ham Band"); art = app icon + server-type logo.
  useEffect(() => {
    const hz = status.frequency;
    if (!hz) return;
    const t = setTimeout(() => {
      // CarFM contract (spec §5b): on broadcast FM, map RDS the way the ESP32
      // display expects — RadioText -> TITLE, station name (PS) -> ARTIST,
      // frequency -> ALBUM. Gadgetbridge relays these three, so this branch is
      // the whole system contract; the general SDR mapping below is bypassed.
      if (status.mode === 'wfm') {
        const np = fmNowPlaying({
          ps: liveStation.name, rt: liveStation.text,
          rtArtist: liveStation.rtArtist, rtTitle: liveStation.rtTitle, freqHz: hz,
        });
        VibePowerModule?.setNowPlaying(np.title, np.artist);
        VibePowerModule?.setNowPlayingAlbum?.(np.album);
        VibePowerModule?.setArtwork(route.params.isTcp ? 'rtltcp' : 'local');
        return;
      }
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
        artist = `CarFM · ${fqLine}`;
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
        artist = `CarFM: ${context}`;
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
      serverBookmarks, userBookmarks, liveStation.name, liveStation.text,
      liveStation.rtArtist, liveStation.rtTitle]);

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
  // Search result tap: tune (+mode when the bookmark has one) and close menu
  // Tune from a search/list tap. For an explicit BAND selection we also apply
  // that band's demodulator + tune step (band-aware tuning) — a deliberate user
  // action, so it applies handheld too. Bookmark taps keep the bookmark's own
  // mode and leave the step untouched.
  const onSearchTune = useCallback((hz: number, mode?: string | null, isBand?: boolean, voiceStep?: boolean) => {
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

  // ── CarFM face wiring ─────────────────────────────────────────────────────
  // Sample the (ref-based) audio SNR on a timer while the FM face is up, so the
  // meter is reactive without re-rendering on every VibeSignal event.
  useEffect(() => {
    const t = setInterval(() => {
      // The built-in NWD tuner drives the meter from its own signal level (arg);
      // don't overwrite it with the SDR-path audio SNR (which is stale/0 there).
      if (nwdActiveRef.current) return;
      const v = audioSnrRef.current;
      setFmSignalDb(Number.isFinite(v) ? v : null);
    }, 500);
    return () => clearInterval(t);
  }, []);

  // CarFM launch: sweep any offline-queued logos and, at most monthly / on a
  // region change, prefetch logos for the surrounding stations (all background,
  // rate-limited — never blocks). Once per carFm session.
  useEffect(() => { void initLogoService(); }, []);

  // CarFM: an image shared into the app (from the browser logo search) gets
  // assigned to the station the user picked for. Consume on mount + each resume.
  useEffect(() => {
    void consumeSharedLogo();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') void consumeSharedLogo(); });
    return () => sub.remove();
  }, []);

  // Resolve station identity from the RDS PI (offline, via the bundled DB) so the
  // FM face can name the station before PS arrives. Hex string -> int -> lookup.
  //
  // The dial goes in with it. A PI that decodes cleanly to a station on some
  // other frequency is not this station, and without the dial to say so, WIBA-FM
  // 101.5 renamed itself "KDTI · Rochester Hills" — see identifyByPi.
  useEffect(() => {
    if (status.mode !== 'wfm' || !liveStation.pi) { setPiIdentity(null); return; }
    const pi = parseInt(liveStation.pi, 16);
    if (!Number.isFinite(pi)) { setPiIdentity(null); return; }
    let cancelled = false;
    const dialMhz = status.frequency > 0 ? status.frequency / 1e6 : undefined;
    identifyByPi(pi, liveStation.name, dialMhz)
      .then((id) => { if (!cancelled) setPiIdentity(id); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [status.mode, status.frequency, liveStation.pi, liveStation.name]);

  // Callsign/city hint shown only when PS text is absent (PS always wins, §6).
  //
  // `confident` is what that flag is FOR and this was the only consumer, which
  // read the callsign and ignored the verdict — so a PI the identifier had
  // explicitly refused to vouch for was still painted over the hero. Belt and
  // braces with identifyByPi's own early return: either alone would have kept
  // WBGX off the face on 2026-08-04.
  const fmCallsignHint = useMemo<string | undefined>(() => {
    if (liveStation.name || !piIdentity?.callsign || !piIdentity.confident) return undefined;
    const city = piIdentity.station?.city;
    return city ? `${piIdentity.callsign} · ${city}` : piIdentity.callsign;
  }, [liveStation.name, piIdentity]);

  // RadioText for the plate, with the station's own name trimmed off the ends.
  // WIBA sends "101.5 IBA-FM - Walk This Way - Aerosmith" and the hero already
  // says which station this is, so those eleven characters cost the plate its
  // scarcest space. Raw text stays in liveStation.text — the band-theme matcher
  // and anything else that wants the broadcast verbatim reads that.
  //
  // The callsign comes from the PI identity or the DB, NEVER from PS: WIBA
  // scrolls song titles through PS, so a PS of "Walk" would have cut "Walk This
  // Way" out of its own RadioText.
  const fmRadioTextDisplay = useMemo(
    () => stripStationFromRt(liveStation.text, {
      mhz: status.frequency > 0 ? status.frequency / 1e6 : null,
      callsign: piIdentity?.callsign ?? null,
    }),
    [liveStation.text, status.frequency, piIdentity],
  );

  // Tuner-connection error state (design addendum): true whenever there is no
  // live tuner session. A tunerless launch shows it immediately (that IS the
  // no-tuner presentation — no separate waiting screen). Otherwise: before the
  // FIRST successful connect, allow 6 s before declaring failure (a healthy
  // local connect lands in ~1-2 s, so a normal boot never flashes the pill);
  // after that, any drop (dongle yanked, shim/driver died) shows immediately
  // and clears on reconnect.
  const [fmTunerError, setFmTunerError] = useState(!!route.params.tunerless);
  const everConnectedRef = useRef(false);
  useEffect(() => {
    if (route.params.tunerless) { setFmTunerError(true); return; }
    if (connected) { everConnectedRef.current = true; setFmTunerError(false); return; }
    if (everConnectedRef.current) { setFmTunerError(true); return; }
    const t = setTimeout(() => setFmTunerError(true), 6000);
    return () => clearTimeout(t);
  }, [connected, route.params.tunerless]);

  // Tunerless carFm: one dongle-connect attempt, driven ONLY by the settings
  // panel's RETRY button (no background polling — the picker already checked for
  // a dongle at launch; a dongle plugged in later is grabbed on demand here).
  // Success hot-swaps in a real local session (navigation.replace remounts this
  // screen connected). tunerSwapDone latches the successful swap; tunerBusy is an
  // in-flight guard so a double-tap of RETRY can't start two native sessions and
  // tear down the one it just handed to navigation.replace.
  const tunerSwapDone = useRef(false);
  const tunerBusy = useRef(false);
  const tryTunerNow = useCallback(async (): Promise<void> => {
    if (!route.params.tunerless || tunerSwapDone.current || tunerBusy.current) return;
    tunerBusy.current = true;
    try {
      const Local = (NativeModules as { VibeLocalSDR?: {
        listDevices?: () => Promise<unknown>;
        startSpectrum?: (opts: object) => Promise<{ port: number; wsBaseUrl: string }>;
      } }).VibeLocalSDR;
      if (!Local?.listDevices || !Local.startSpectrum) return;
      const devs = await Local.listDevices();
      if (tunerSwapDone.current || !Array.isArray(devs) || devs.length === 0) return;
      const res = await Local.startSpectrum({
        centerFreq: 100_000_000, sampleRate: 2_400_000, fftSize: 8192, fftRate: 10, mode: 'wfm',
      });
      if (tunerSwapDone.current) return;
      tunerSwapDone.current = true;
      navigation.replace('Radio', {
        baseUrl: res.wsBaseUrl, instanceName: 'Local Hardware',
        viewMode: route.params.viewMode, serverType: 'ubersdr',
        isLocal: true, localPort: res.port, localGen: newLocalSession(),
      });
    } catch { /* dongle not ready / permission denied — RETRY tries again */ }
    finally { tunerBusy.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params.tunerless, route.params.viewMode]);

  // CarFM permanent install: ask ONCE to exempt the app from battery
  // optimization — Doze on an idle head unit can throttle/kill the boot-started
  // radio service. The system dialog does the actual grant; declining is
  // remembered and never re-asked (the setting stays reachable via App info).
  useEffect(() => {
    const Local = (NativeModules as { VibeLocalSDR?: {
      isIgnoringBatteryOptimizations?: () => Promise<boolean>;
      requestIgnoreBatteryOptimizations?: () => void;
    } }).VibeLocalSDR;
    if (!Local?.isIgnoringBatteryOptimizations) return;
    let cancelled = false;
    (async () => {
      try {
        if (await AsyncStorage.getItem('@carfm/battery_prompted_v1')) return;
        if (await Local.isIgnoringBatteryOptimizations!()) return;
        if (cancelled) return;
        await AsyncStorage.setItem('@carfm/battery_prompted_v1', '1');
        Alert.alert(
          'Keep the radio running',
          'For a permanent car install, CarFM should be exempt from battery '
          + 'optimization so the radio always starts with the car and never '
          + 'gets paused in the background.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Allow', onPress: () => Local.requestIgnoreBatteryOptimizations?.() },
          ],
        );
      } catch { /* best effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // CarFM settings: theme override + boot autostart, persisted.
  const [fmTheme, setFmTheme] = useState<'system' | 'light' | 'dark'>('system');
  // Headlights. This ROM does NOT set Android's uiMode night flag — measured
  // 2026-08-01: extra_ill_state toggles 1/0 while androidUiMode stays DAY — so
  // useColorScheme() never fires and CarFM stayed light while every other app on
  // the unit went dark. Drive day/night from the vendor broadcast instead.
  // null = never heard, so `system` still falls back to useColorScheme().
  const [fmIllNight, setFmIllNight] = useState<boolean | null>(null);

  // The level watch, owned separately from the connect effect because its cadence
  // depends on debug mode: 15s while sampling, 30s otherwise. Started here so a
  // mid-drive toggle takes effect immediately — folded into the connect effect it
  // would have kept the slow rate until the next reconnect, and the log would
  // have quietly held half the samples the mode promises.
  useEffect(() => {
    if (!nwdActive) return;
    // A fresh window: the counters and the RDS tally belong to the interval that
    // is starting, not to whatever was accumulating before the toggle.
    stereoFlipsRef.current = 0;
    rdsExpiriesRef.current = 0;
    lastSampleAtRef.current = Date.now();
    rdsDecoder.current.resetStats();
    nwdStartLevelWatch(debugOn ? DEBUG_SAMPLE_MS : LEVEL_POLL_MS);
    return () => nwdStopLevelWatch();
  }, [nwdActive, debugOn]);

  // Mirror the tail of the tuner log onto the face. Off by default; the settings
  // toggle drives it, and the persisted value arrives after mount, so this
  // subscribes rather than reading once.
  const [diagOverlay, setDiagOverlay] = useState(isDiagOverlayEnabled());
  useEffect(() => subscribeDiagPrefs(() => setDiagOverlay(isDiagOverlayEnabled())), []);
  const osScheme = useColorScheme();

  // Listen for the headlights on EVERY backend, not just NWD. This used to be
  // registered only inside the NWD connect path, which is gated on a tunerless
  // launch — so an RTL-SDR session never heard the broadcast and stayed light all
  // night. Idempotent, and a no-op on a non-NWD unit.
  useEffect(() => { nwdStartIlluminationWatch(); }, []);

  // What the face is actually told. An explicit light/dark preference always
  // wins; only 'system' defers to the headlights.
  //
  // PROVISIONAL NIGHT: the broadcast reports CHANGES only, and no getter for the
  // current illumination state has been found yet (NwdDeviceConfig is unexplored).
  // Starting the car after dark with the headlights already on therefore produced
  // no event, and 'system' fell through useColorScheme() — which this ROM pins to
  // DAY permanently — to a full-white face in the driver's eyeline for the whole
  // drive. Until the first real broadcast arrives, guess from the clock. A wrong
  // guess costs a dim screen in daylight; the alternative cost is glare at night.
  const fmThemeEffective = fmTheme !== 'system' ? fmTheme
    : fmIllNight !== null ? (fmIllNight ? 'dark' : 'light')
    : (new Date().getHours() >= 19 || new Date().getHours() < 7) ? 'dark'
    : 'system';
  const [fmAutostart, setFmAutostart] = useState(true);
  // §4.7 audio-priority (claim/release) on the hero power button. Visual state for
  // now; the real native claim (ACTION_APP_IN_OUT app_id=8) / release (ExitFm)
  // hooks in with task #14 once the probe verifies it on-device.
  const [fmAudioActive, setFmAudioActive] = useState(true);
  // True once the user has powered the face off deliberately. Audio-focus changes
  // must not undo that — losing and regaining focus should never turn the radio
  // back on behind the user's back.
  const userPoweredOffRef = useRef(false);
  // The power button must actually drive the tuner, not just flip the visual state —
  // on NWD, claiming/releasing the MCU FM source is what starts/STOPS the (analog,
  // MCU-routed) audio. Without this the face went "dead" but sound kept playing.
  const onFmClaimAudio = useCallback(() => {
    userPoweredOffRef.current = false;
    setFmAudioActive(true);
    if (nwdActiveRef.current) nwdSetAudio(true);
  }, []);
  const onFmReleaseAudio = useCallback(() => {
    userPoweredOffRef.current = true;
    setFmAudioActive(false);
    if (nwdActiveRef.current) nwdSetAudio(false);
  }, []);
  useEffect(() => {
    AsyncStorage.getItem('@carfm/theme_v1')
      .then((v: string | null) => { if (v === 'light' || v === 'dark' || v === 'system') setFmTheme(v); })
      .catch(() => {});
    getCarAutostart().then(setFmAutostart).catch(() => {});
  }, []);
  const onFmSetTheme = useCallback((t: 'system' | 'light' | 'dark') => {
    setFmTheme(t);
    AsyncStorage.setItem('@carfm/theme_v1', t).catch(() => {});
  }, []);
  const onFmSetAutostart = useCallback((on: boolean) => {
    setFmAutostart(on);
    void setCarAutostart(on);
  }, []);

  // Presets = this-instance FM bookmarks (broadcast band), in the USER'S order
  // (design: presets are an ordered strip, reorderable in the face; PREV/NEXT
  // step displayed order). The order overlay is a persisted list of frequency
  // keys; bookmarks not in it append frequency-sorted at the end.
  const FM_ORDER_KEY = '@carfm/preset_order_v1';
  const fmKeyOf = (hz: number) => String(Math.round(hz / 100_000));  // 0.1 MHz key
  const [fmOrder, setFmOrder] = useState<string[]>([]);
  useEffect(() => {
    AsyncStorage.getItem(FM_ORDER_KEY)
      .then((raw: string | null) => { if (raw) setFmOrder(JSON.parse(raw)); })
      .catch(() => {});
  }, []);
  const persistFmOrder = useCallback((keys: string[]) => {
    setFmOrder(keys);
    AsyncStorage.setItem(FM_ORDER_KEY, JSON.stringify(keys)).catch(() => {});
  }, []);

  const fmPresets = useMemo<CarFmPreset[]>(() => {
    // CarFM presets are GLOBAL — independent of baseUrl, the tuner, or whether a
    // tuner is connected at all. Read every FM-band bookmark across ALL scopes
    // (a tunerless session and a live-dongle session have different baseUrls, and
    // legacy presets may carry an old per-URL scope) and dedupe by channel, so a
    // preset survives the tunerless→dongle hot-swap and shows on a no-dongle boot.
    const src = userBookmarks;
    const byChannel = new Map<string, UserBookmark>();
    for (const b of src) {
      if (!(b.mode === 'wfm' || (b.frequency >= 87_000_000 && b.frequency <= 108_500_000))) continue;
      const k = fmKeyOf(b.frequency);
      if (!byChannel.has(k)) byChannel.set(k, b);   // first wins (global before per-URL dupes)
    }
    const base = [...byChannel.values()]
      .map((b: UserBookmark) => ({ name: b.name, frequency: b.frequency }))
      .sort((a, b) => a.frequency - b.frequency);
    if (fmOrder.length === 0) return base;
    const pos = new Map(fmOrder.map((k, i) => [k, i]));
    return [...base].sort((a, b) =>
      (pos.get(fmKeyOf(a.frequency)) ?? 1e6 + a.frequency / 1e5)
      - (pos.get(fmKeyOf(b.frequency)) ?? 1e6 + b.frequency / 1e5));
  }, [userBookmarks, visibleBookmarks, fmOrder]);

  // Warm the preset logos as soon as the list is known, so the strip paints its
  // art on the first frame instead of each tile resolving its own async chain.
  useEffect(() => {
    if (fmPresets.length === 0) return;
    void warmStationLogos(fmPresets.map((p) => ({ name: p.name, frequencyMhz: p.frequency / 1e6 })));
  }, [fmPresets]);

  // Star: save the tuned station (named from RDS PS), or un-save if it already
  // is a preset. Removal also drops any duplicate bookmarks on that channel.
  const fmRemoveAt = useCallback((hz: number) => {
    const key = fmKeyOf(hz);
    persistUserBookmarks(userBookmarks.filter((b: UserBookmark) => fmKeyOf(b.frequency) !== key));
    persistFmOrder(fmOrder.filter((k) => k !== key));
  }, [userBookmarks, persistUserBookmarks, fmOrder, persistFmOrder]);

  const onFmToggleSave = useCallback(() => {
    const hz = client.current?.getStatus().frequency ?? status.frequency;
    if (fmPresets.some((p) => fmKeyOf(p.frequency) === fmKeyOf(hz))) { fmRemoveAt(hz); return; }
    const name = (liveStationRef.current || '').trim()
      || `FM ${(hz / 1e6).toFixed(1)}`;
    onAddBookmark(name, true);   // GLOBAL scope — preset is independent of the tuner/URL
  }, [status.frequency, fmPresets, fmRemoveAt, onAddBookmark]);

  // Reorder from the face's drag-reorder: `order` is the new arrangement as the
  // original displayed indices (order[newPos] = oldIndex). Map to keys and persist.
  const onFmReorderPreset = useCallback((order: number[]) => {
    const cur = fmPresets.map((p) => fmKeyOf(p.frequency));
    if (order.length !== cur.length) return;
    const next = order.map((i) => cur[i]);
    if (next.some((k) => k == null)) return;
    persistFmOrder(next);
  }, [fmPresets, persistFmOrder]);
  const onFmRemovePreset = useCallback((index: number) => {
    const p = fmPresets[index];
    if (p) fmRemoveAt(p.frequency);
  }, [fmPresets, fmRemoveAt]);


  // CarFM media surface: push Presets + Nearby (FCC DB) as the browse tree +
  // queue. Nearby is fetched once per session (offline-first facade) and the
  // payload re-pushes whenever the presets change so Android Auto / AVRCP /
  // the lock-screen queue stay current.
  const fmNearbyRef = useRef<{ name: string; frequency: number }[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (fmNearbyRef.current.length === 0) {
        try {
          const r = await getNearbyStations({ enrich: false, limit: 100 });
          if (cancelled) return;
          fmNearbyRef.current = r.stations.map((s) => ({
            name: `${s.frequencyMhz.toFixed(1)} ${s.callsign}`,
            frequency: Math.round(s.frequencyMhz * 1e6),
          }));
        } catch { /* no GPS / no DB — nearby folder stays empty */ }
      }
      if (cancelled) return;
      VibePowerModule?.setBrowseItems?.(JSON.stringify({
        carfm: true,
        bookmarks: fmPresets.map((p) => ({ name: p.name, frequency: p.frequency, mode: 'wfm' })),
        bands: [],
        nearby: fmNearbyRef.current.map((n) => ({ ...n, mode: 'wfm' })),
      }));
    })();
    return () => { cancelled = true; };
  }, [fmPresets]);

  // Seek from a media surface (notification / Android Auto custom action):
  // next/previous station in the local FCC list, wrapping. No sweep animation —
  // this path isn't the on-screen face.
  const onFmMediaSeek = useCallback((dir: 1 | -1) => {
    const freqs = [...new Set(fmNearbyRef.current.map((n) => n.frequency))].sort((a, b) => a - b);
    if (freqs.length === 0) return;
    const cur = client.current?.getStatus().frequency ?? status.frequency;
    const next = dir > 0
      ? (freqs.find((f) => f > cur + 50_000) ?? freqs[0])
      : ([...freqs].reverse().find((f) => f < cur - 50_000) ?? freqs[freqs.length - 1]);
    onTuneHz(next);
  }, [status.frequency, onTuneHz]);

  useEffect(() => {
    const em = new NativeEventEmitter(NativeModules.VibePowerModule);
    const sub = em.addListener('VibeCarAction', (e: { action?: string }) => {
      if (e.action === 'save') onFmToggleSave();
      else if (e.action === 'seek_up') onFmMediaSeek(1);
      else if (e.action === 'seek_down') onFmMediaSeek(-1);
    });
    return () => sub.remove();
  }, [onFmToggleSave, onFmMediaSeek]);

  // ── Vehicle motion (GPS speed → is_moving) + GPS lock state ──────────────────
  // Both wired and ready as DATA only; the UI (speed readout, GPS-lock indicator)
  // comes in a later design handoff. Features can gate on isMoving()/
  // subscribeMotion() and hasGpsFix()/useGpsFix(). Low-rate GPS while the face is up.
  useEffect(() => {
    void startMotion();
    void startGpsFix();
    return () => { stopMotion(); stopGpsFix(); };
  }, []);

  // ── Built-in NWD/NOWADA tuner (Backend E) ────────────────────────────────────
  // On a tunerless carFm launch (no SDR dongle) — the normal case on a permanent
  // head-unit install — bind the unit's own FM tuner if it exposes the NWD radio
  // service, and drive the face from IT instead of showing the tuner-error pill.
  // Audio is analog + MCU-routed; PS/RadioText/PTY/TA/stereo arrive as native
  // callback events. Tune commands route via onTuneHz's nwdActiveRef branch.
  useEffect(() => {
    if (!route.params.tunerless) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    // Auto-probe-on-park: a few seconds after the dial settles on a frequency,
    // dump every readable NWD getter (station name, RadioText, RDS selectors,
    // band plan, presets) once — so a drive log captures the FULL tuner state at
    // each station without any interaction. Debounced (reset on every freq
    // change) and de-duped per frequency; only runs while diagnostics are on.
    let probeTimer: ReturnType<typeof setTimeout> | null = null;
    // Debounced post-tune level read; see the frequency handler.
    let levelSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastProbedMhz = 0;
    const scheduleProbe = (mhz: number) => {
      if (!isDiagEnabled() || !(mhz > 0) || Math.abs(mhz - lastProbedMhz) < 0.05) return;
      if (probeTimer) clearTimeout(probeTimer);
      if (levelSettleTimer) clearTimeout(levelSettleTimer);
      probeTimer = setTimeout(async () => {
        if (cancelled) return;
        lastProbedMhz = mhz;
        const dump = await nwdProbe();
        if (cancelled) return;
        // Label the block with the frequency the DUMP itself reports, not the one
        // that scheduled it. The probe is debounced by 4s and the dial can move in
        // that time: the 31 July log carries "— probe @ 101.5 —" above a body
        // reading freq=10590, and looked up the callsign for 101.5 while the tuner
        // sat on 105.9. A diagnostic that pairs a stale heading with live values is
        // worse than no heading at all.
        const mult = Number(/freqMult=(\d+)/.exec(dump)?.[1]) || 100;
        const raw = Number(/freq=band=\d+\s+freq=(\d+)/.exec(dump)?.[1]);
        const at = isFinite(raw) && raw > 0 ? raw / mult : mhz;
        diag(`— probe @ ${at.toFixed(1)}${Math.abs(at - mhz) >= 0.05 ? ` (scheduled at ${mhz.toFixed(1)})` : ''} —`);
        for (const l of dump.split('\n')) if (l.trim()) diag(l);
        // Does the name lookup actually resolve for this station? null here while
        // the audio is fine = the "Tuning…" bug is the FCC lookup (location), not
        // the tuner.
        try {
          const cs = await callsignForFreq(at);
          if (!cancelled) diag(`  callsign@${at.toFixed(1)}=${cs ?? 'null'}`);
        } catch (e) { if (!cancelled) diag(`  callsign@${at.toFixed(1)}=error ${String(e)}`); }
      }, 4000);
    };
    // Stereo debounce: the NwdRadioStereo callback is the TRUTH (it flaps with the
    // real signal — confirmed on a fringe station), but the isStreroOn() getter is
    // stuck true, so the poll must NOT drive stereo (it was stomping the callback
    // back to STEREO every 1.5s). Hold a stereo value ~2s before applying it so a
    // fringe station doesn't strobe the pill; a stable station still settles.
    let stereoTimer: ReturnType<typeof setTimeout> | null = null;
    const setStereoDebounced = (on: boolean) => {
      if (stereoTimer) clearTimeout(stereoTimer);
      stereoTimer = setTimeout(() => { if (!cancelled) setFmStereo(on); }, 2000);
    };
    // Estimated signal: this tuner reports NO signal level (arg is just the preset
    // slot). So on a settled tune, estimate receivability from the FCC DB + live
    // GPS; the face renders it GREY ("not live") and shows zero when there's no fix
    // or no dataset entry. Debounced so seeks don't thrash it.
    let signalTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleSignalEst = (mhz: number) => {
      if (!(mhz > 0)) return;
      setFmSignalDb(null);   // clear immediately → zero/grey until the estimate lands
      if (signalTimer) clearTimeout(signalTimer);
      signalTimer = setTimeout(async () => {
        const db = await estimatedSignalDbForFreq(mhz);
        if (!cancelled) setFmSignalDb(db);
      }, 1200);
    };
    const subs: Array<() => void> = [];
    (async () => {
      const avail = await isNwdAvailable();
      diag(`NWD available? ${avail}`);
      if (!avail || cancelled) return;
      try {
        // Retry the bind. The native side now rejects after 8s rather than
        // awaiting an onServiceConnected that may never arrive, which turned an
        // inert face into a reachable failure — but a failure with no way back is
        // still a dead radio, and the realistic cause is timing: CarFM autostarts
        // at ignition alongside the vendor service and can win the race. Three
        // attempts spans about half a minute of vendor-service boot.
        let info: Awaited<ReturnType<typeof nwdConnect>> | null = null;
        for (let attempt = 1; attempt <= 3 && !cancelled; attempt++) {
          try { info = await nwdConnect(); break; }
          catch (e) {
            diag(`NWD connect attempt ${attempt}/3 failed: ${String(e)}`);
            if (attempt === 3) throw e;
            nwdDisconnect();   // drop the half-bound connection before rebinding
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        if (cancelled || !info) { nwdDisconnect(); return; }
        nwdActiveRef.current = true;
        setNwdActive(true);
        setFmTunerError(false);
        nwdSetRds(true);
        nwdSetAudio(true);
        // Hold a media-buttons-only MediaSession so the steering-wheel ⏮⏭ keys
        // route to CarFM (→ VibeSkip → animated preset step) instead of the radio
        // service's own preset list. No audio is produced by that session — the
        // MCU keeps routing the analog FM audio.
        (VibePowerModule as any)?.startNwdControl?.();
        diag(`NWD connected: registered=${info.registered} band=${info.band} freqMult=${info.freqMult} mhz=${info.mhz ?? '?'} ps='${info.ps ?? ''}' rt='${info.rt ?? ''}' pty=${info.pty}; RDS on`);
        // Station names come from the FCC-DB callsign lookup, which needs GPS.
        // ONE-SHOT, and about a second after launch — so a null here means the
        // last-known cache was cold at that instant, NOT that location is
        // unavailable for the drive. Reading it as the latter is a mistake this
        // comment exists to prevent: the nearby search works later in the same
        // session. For anything that needs a position it can trust, use
        // getDetailedLocation(), which requests a live fix and reports its age.
        getUserLocation()
          .then((loc) => diag(`location at launch: ${loc ? `${loc.lat},${loc.lon}` : 'no cached fix yet (cold start — not a failure)'}`))
          .catch((e) => diag(`location: error ${String(e)}`));
        // Seed the INITIAL tuner state — RT/PTY only push notify* on a CHANGE, so
        // a stable station would otherwise leave the face at defaults. Stereo is
        // deliberately NOT seeded: its getter is stuck true, so fmStereo stays
        // null (blank pill) until NwdRadioStereo reports something real.
        setLiveStation((prev) => ({
          ...prev,
          name: info.ps || prev.name,
          text: info.rt || prev.text,
          pty: (typeof info.pty === 'number' && info.pty >= 0) ? info.pty : prev.pty,
        }));
        if (typeof info.mhz === 'number' && info.mhz > 0) {
          setStatus((prev: SDRStatus) => ({ ...prev, frequency: Math.round(info.mhz! * 1e6) }));
          if (info.ps) liveStationRef.current = info.ps;
          scheduleSignalEst(info.mhz);   // seed the estimated meter for the boot station
        }
      } catch (e) {
        diag(`NWD connect FAILED: ${String(e)}`);
        // Say so on the face. Without this the pill's state depends on whatever it
        // happened to hold, and a launch that never reached the tuner could still
        // read as a working radio.
        setFmTunerError(true);
        return;
      }
      if (cancelled) return;
      // Decoded RDS + tuning state pushed from the service (Binder → JS events).
      subs.push(onNwd('NwdRadioFrequency', (p) => {
        liveStationRef.current = p.ps ?? '';
        setStatus((prev: SDRStatus) => ({ ...prev, frequency: Math.round(p.mhz * 1e6) }));
        reportDeviceMhz(p.mhz);
        // Every RDS-derived field belongs to the station we just LEFT. Clearing
        // them here is what drops the RDS tell (rdsOk reads pi/name) and empties
        // the RadioText plate until the new station is acquired — otherwise the
        // previous station's text sits under the new frequency for seconds.
        setLiveStation((prev) => ({
          ...prev,
          name: p.ps || undefined,
          text: undefined,
          pty: undefined,
          tp: false,
          ta: false,
          pi: undefined,
        }));
        // `arg` is the preset-slot index, NOT signal (confirmed on-device: it equals
        // the frequency's position in the factory preset list, −1 otherwise). The
        // tuner exposes no real signal level, so drive the meter from the DB+GPS
        // estimate instead (grey/estimated on the face).
        scheduleSignalEst(p.mhz);
        // PS/RadioText belong to the station we just left. A PI change clears
        // them too, but the dial moves first and PI only arrives with the next
        // group — without this the old name lingers across a preset step.
        rdsDecoder.current.reset();
        // Restart the staleness clock at the retune, so the new station gets a
        // full window to acquire instead of inheriting the old one's countdown.
        lastRdsAtRef.current = Date.now();
        // A retune outranks a pending expiry: there is nothing worth restoring,
        // the decoder was just emptied.
        rdsStaleRef.current = false;
        // The level belongs to the station we just left. Drop it and ask for a
        // fresh one rather than letting the meter lie until the next tick — but
        // WAIT for the front end to settle first.
        //
        // A reading taken immediately after a retune is systematically inflated.
        // Measured on 2026-08-05 across 24 paired comparisons — the first reading
        // after a tune against the same station 20s later — the mean excess was
        // +17.7, with individual cases of +45, +48 and +57. Banded by age the
        // same drive gives 0-5s mean 70.3 against 5-15s mean 51.8.
        //
        // The value comes from seek(), the chip's own scan primitive, so a level
        // read while the tune is still completing plausibly reflects that
        // operation rather than the settled channel. Whatever the mechanism, the
        // number is not usable that early, and the meter was showing it.
        setFmLevel(null);
        // The rating belongs to the station we just left, exactly like the level
        // and the decoder's text above it. Left standing it follows the driver
        // onto the new frequency and is filed there as though it described it.
        ratingRef.current = null;
        ratingMhzRef.current = null;
        lastTuneAtRef.current = Date.now();
        if (levelSettleTimer) clearTimeout(levelSettleTimer);
        levelSettleTimer = setTimeout(() => { if (!cancelled) nwdReadLevelNow(); }, LEVEL_SETTLE_MS);
        diag(`freq ${p.mhz.toFixed(1)} arg=${p.arg} PS='${p.ps}'`);
        scheduleProbe(p.mhz);
      }));
      // RAW RDS — the channel the AIDL cannot provide. Groups arrive from
      // NwdFmManager.getRadioRDSDataArm() via the native pump; decoding them
      // ourselves is what finally yields RadioText on this unit, along with a
      // real PI instead of the FCC-DB frequency guess.
      // MEASURED signal level — the first one this app has ever had on this unit.
      // The estimate it replaces needed a GPS fix, which this head unit never
      // provides, so the meter has been showing an empty icon and the word "EST"
      // for its whole life. Each reading COMMANDS the tuner, so the native side
      // paces it and skips any tick where FM is not the MCU's current source.
      subs.push(onNwd('NwdRadioLevel', (p) => {
        // `ok` false means the tuner did not stay on the frequency we asked
        // about, which is the same check AWNative makes before it believes a
        // level. Keep the previous reading rather than showing a wrong one.
        if (!p.ok) { diag(`level: REJECTED asked=${p.asked} landed=${p.landed}${p.err ? ` ${p.err}` : ''}`); return; }
        setFmLevel(p.level);
        if (!debugModeRef.current) {
          diag(`level ${p.level} @ ${p.asked} → ${levelToLit(p.level)} lit`);
          return;
        }
        // DEBUG MODE: this reading is the heartbeat of the dataset. Take the
        // position at the same instant and close a sample window.
        void writeDebugSample(p.level);
      }));
      // The watch is NOT started here — its interval depends on debug mode, and
      // this effect runs once per connection. See the dedicated effect below.

      subs.push(onNwd('NwdRdsGroup', (p) => {
        // Stamp on ARRIVAL, not on publish: a group getting through means the RDS
        // carrier is still there, even when consensus rejects it and push()
        // returns null. This is what the staleness sweep in the poll measures.
        lastRdsAtRef.current = Date.now();
        const pushed = rdsDecoder.current.push(p.hex);
        // The carrier is back after an expiry. The decoder never lost the station,
        // so restore what it already holds rather than waiting to re-acquire —
        // push() returns null when nothing changed, which after an expiry is the
        // normal case and would otherwise leave the plate blank indefinitely.
        let s = pushed;
        if (rdsStaleRef.current) {
          rdsStaleRef.current = false;
          s = rdsDecoder.current.state();
        }
        if (!s) return;
        setLiveStation((prev) => ({
          ...prev,
          // A scrolling PS is not a name. `s.ps` goes empty the moment the
          // decoder decides that, but `|| prev.name` would cheerfully keep the
          // last chunk on the hero forever — which is how "Walk This Way" ended
          // up where WIBA's logo belongs. Clear it outright and let the
          // PI-derived identity take over, which is what the hero falls back to.
          name: s.psScrolling ? undefined : (s.ps || prev.name),
          text: s.rt || prev.text,
          pty: s.pty ?? prev.pty,
          tp: s.tp,
          ta: s.ta,
          // PI is a 4-digit uppercase hex STRING everywhere else in the app
          // (SDRBackend: "hex PI code, '' when none"), so match that rather than
          // leaking the decoder's numeric form into shared state.
          pi: s.pi === null ? prev.pi : s.pi.toString(16).toUpperCase().padStart(4, '0'),
        }));
        if (s.ps) liveStationRef.current = s.ps;
        // Debug mode is deliberately quiet: this one line fired 184 times in a
        // 40-minute commute and is what buries the events worth reading. The
        // structured sample carries the same information, aggregated.
        if (!debugModeRef.current) {
          diag(`RDS pi=${s.pi?.toString(16)} ps='${s.ps}' pty=${s.pty} rt='${s.rt}'`);
        }
      }));
      // STEERING WHEEL — the real transport. The MCU broadcasts
      // com.nwd.action.ACTION_KEY_VALUE and the vendor service picks it up
      // WITHOUT a permission, so we receive the same broadcast (decompile,
      // 2026-07-30). This is why MediaSession + activity-key capture saw nothing:
      // the wheel never enters Android's input pipeline.
      //
      // We can't cancel a normal broadcast, so the service still jumps to ITS
      // slot (prefeb → mPrefFrequency[band][n-1]). Stepping CarFM's own preset
      // right after makes the APP's order win — including refusing to walk into
      // the phantom slots past the end of the user's list.
      subs.push(onNwd('NwdPanelKey', (p) => {
        // Name EVERY key the dispatch table knows, not just the two we act on:
        // an unnamed line then means "the MCU sent a code we have never
        // identified", which is what the diagnostics overlay highlights.
        const keyName = panelKeyName(p.key);
        diag(`panel key ${p.key}${keyName ? ` (${keyName})` : ''}`);
        if (p.key === PANEL_KEY.PRESET_NEXT) fmHwStepRef.current?.(1);
        else if (p.key === PANEL_KEY.PRESET_PREV) fmHwStepRef.current?.(-1);
      }));
      // Headlights → day/night. Logs only; nothing drives the palette from this
      // yet. The pairing is the answer: if uiMode flips with the broadcast, the
      // ROM does set Android night mode and the face should already follow it.
      subs.push(onNwd('NwdIllState', (p) => {
        // extra_ill_state: 1 = headlights on = night. Confirmed on device; the
        // same log confirmed androidUiMode never moves, which is why this is the
        // signal rather than useColorScheme().
        const m = /extra_ill_state=(\d+)/.exec(p.extras);
        if (m) setFmIllNight(m[1] === '1');
        diag(`ILL ${p.action} [${p.extras}] androidUiMode=${p.uiMode}`);
      }));
      subs.push(onNwd('NwdRadioRt', (p) => { setLiveStation((prev) => ({ ...prev, text: p.rt || undefined })); diag(`RT '${p.rt}'`); }));
      subs.push(onNwd('NwdRadioStereo', (p) => {
        // Counted on the RAW event, before the 2s debounce: the debounce exists to
        // stop the pill flickering, and the flapping it hides is exactly the
        // measurement we want.
        stereoFlipsRef.current++;
        setStereoDebounced(p.on);
        if (!debugModeRef.current) diag(`stereo ${p.on}`);
      }));
      subs.push(onNwd('NwdRadioPty', (p) => { setLiveStation((prev) => ({ ...prev, pty: p.pty })); diag(`PTY ${p.pty}`); }));
      subs.push(onNwd('NwdRadioTa', (p) => { setLiveStation((prev) => ({ ...prev, ta: p.ta })); diag(`TA ${p.ta}`); }));
      // Poll the getters as a freq fallback. RESOLVED: isStreroOn() is stuck true
      // (reads true even on dead air), so the poll must NOT drive stereo — the
      // NwdRadioStereo callback is the trustworthy source (see setStereoDebounced).
      // The poll still backstops the frequency and logs the getters' readings
      // (change-gated) so a drive log keeps a full trace.
      let lastPollSig = '';
      pollTimer = setInterval(async () => {
        const p = await nwdPoll();
        if (cancelled || !p) return;
        if (typeof p.mhz === 'number' && p.mhz > 0) {
          setStatus((prev: SDRStatus) => Math.round(p.mhz! * 1e6) === prev.frequency ? prev : ({ ...prev, frequency: Math.round(p.mhz! * 1e6) }));
          reportDeviceMhz(p.mhz!);
          scheduleProbe(p.mhz);
        }
        // Is FM actually playing? The MCU's own source register is the truth on a
        // head unit: the audio is analog and MCU-routed, and after a permanent
        // AUDIOFOCUS_LOSS Android never sends a GAIN — so a focus-driven state
        // goes dark when Android Auto takes over and NEVER comes back when the MCU
        // hands FM back. This poll self-heals. An explicit power-off still wins.
        if (typeof p.source === 'number' && p.source >= 0 && !userPoweredOffRef.current) {
          setFmAudioActive(p.source === 4);
        }
        // RDS EXPIRES. Losing a station is silence, not an event: drive out of
        // range without touching the dial and the groups simply stop. Every
        // liveStation merge is `x || prev.x` and only a retune ever cleared
        // anything, so the plate went on scrolling the last song, the genre kept
        // the old PTY, TP/TA stayed latched and the RDS tell stayed lit — all of
        // it over hiss, for as long as the drive lasted.
        //
        // Self-healing: the decoder is reset too, so the next group that gets
        // through republishes from scratch. The hero keeps its name and logo via
        // the FCC-database fallback, which is by design.
        if (lastRdsAtRef.current && Date.now() - lastRdsAtRef.current > RDS_STALE_MS) {
          lastRdsAtRef.current = 0;
          // DO NOT reset the decoder. Expiry means "the carrier went quiet", not
          // "we are on a different station" — a retune is what means that, and
          // the frequency handler already resets there.
          //
          // Resetting here was making the corruption worse, not better. A reset
          // clears rtPublished, which re-opens the instant-publish path for the
          // first complete assembly after the signal returns — and that assembly
          // is being received in exactly the marginal conditions that caused the
          // gap. On 2026-08-04, eight of the eleven corrupt RadioText changes on
          // WERN were first fills after an expiry. Keeping the decoder means the
          // confirmed text comes straight back instead of being re-acquired from
          // the worst air of the drive.
          rdsStaleRef.current = true;
          setLiveStation((prev) =>
            (prev.name || prev.text || prev.pty !== undefined || prev.tp || prev.ta || prev.pi)
              ? { ...prev, name: undefined, text: undefined, pty: undefined, tp: false, ta: false, pi: undefined }
              : prev);
          rdsExpiriesRef.current++;
          diag(`RDS expired — no group for ${RDS_STALE_MS / 1000}s`);
        }
        // Reception loss → the dotted-wave overlay. The decoder's ring is NOT
        // reset by an expiry (see above), so gate on the stale flag here instead —
        // a figure held over from before the carrier went quiet would be
        // describing air we are no longer receiving.
        //
        // The band is settled HERE rather than at render: the ring's percentage
        // drifts by fractions of a point every poll, and both the rounding and the
        // hysteresis have to happen once, against the band actually on screen.
        {
          const match = rdsStaleRef.current ? null : rdsDecoder.current.quality().piMatchPct;
          const loss = match == null ? null : 100 - match;
          const next = settleDottedPairs(fmDottedRef.current, loss);
          if (next !== fmDottedRef.current) setFmDotted(next);
        }
        // The poll does NOT drive PS / RadioText / PTY.
        //
        // On this unit those getters are worthless: getRtMessage() is a hardcoded
        // "" on one manager and region-gated on the other, psName stays empty for a
        // passive bound client, and getPTYType() returns 0. The old merge accepted
        // `p.pty >= 0`, so that 0 overwrote a correctly decoded PTY and ptyLabels
        // renders '' for 0 — the genre line vanished and could not recover, because
        // the decoder's internal state was already correct so no later group
        // re-published it.
        //
        // Raw RDS from NwdRdsGroup is strictly better data and is the only writer
        // now. Same reasoning that already keeps the poll away from stereo.
        // Log a poll line whenever the getters' reading CHANGES (not just the first
        // few), so a full drive shows how isStreroOn()/getCurrentFrequency() behave
        // over time — especially whether stereo sticks true on empty channels —
        // alongside the callback `stereo`/`freq` lines. Change-gated: a parked
        // station stays quiet, a flapping one records every flip.
        const sig = `${p.mhz ?? '?'}|${p.ps ?? ''}|${p.stereo}|${p.rt ?? ''}|${p.pty}`;
        if (sig !== lastPollSig) {
          lastPollSig = sig;
          // Wheel-capture state rides along: the control session starts at CONNECT,
          // which is usually BEFORE diagnostics get switched on, so its own one-shot
          // line never makes the log. This makes it visible at any time.
          let ctl = '';
          try { ctl = await (VibePowerModule as any)?.getNwdControlState?.() ?? ''; } catch { /* older build */ }
          diag(`poll: mhz=${p.mhz ?? '?'} ps='${p.ps ?? ''}' stereo=${p.stereo} rt='${p.rt ?? ''}' pty=${p.pty}${ctl ? `  [${ctl}]` : '  [no ctl state — OLD BUILD]'}`);
        }
      }, 1500);
    })();
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (probeTimer) clearTimeout(probeTimer);
      if (levelSettleTimer) clearTimeout(levelSettleTimer);
      if (stereoTimer) clearTimeout(stereoTimer);
      if (signalTimer) clearTimeout(signalTimer);
      nwdActiveRef.current = false;
      setNwdActive(false);
      subs.forEach((u) => u());
      (VibePowerModule as any)?.stopNwdControl?.();   // drop the media-button session
      nwdSetAudio(false);   // release the radio audio source before unbinding
      nwdDisconnect();
    };
  }, [route.params.tunerless]);

  // While an SDR/dongle is the active source, the built-in FM must NOT run in
  // parallel — no reason for it to, and it would only fight the dongle audio /
  // muddy the source. CarFM never CLAIMS the FM source off the tunerless path,
  // but the stock radio (or a prior built-in session) can leave it playing, and
  // an SDR-FIRST launch never releases it (the built-in→SDR swap does, in the
  // tunerless effect's cleanup above). So release it ONCE on entry — the same
  // device-proven source→0 — then let the dongle's own MediaSession own audio +
  // the steering wheel (that path already routes ⏮⏭ → VibeSkip → preset step,
  // identically to the built-in path). Latched so it can't cut dongle audio that
  // starts moments later.
  const sdrSilencedFm = useRef(false);
  useEffect(() => {
    if (route.params.tunerless) return;   // tunerless = built-in FM owns the tuner
    if (sdrSilencedFm.current) return;
    sdrSilencedFm.current = true;
    (async () => {
      if (await isNwdAvailable()) { nwdSetAudio(false); diag('SDR active → released built-in FM source (source→0)'); }
    })();
  }, [route.params.tunerless]);

  // TA: a real car radio breaks mute for traffic announcements. If TA rises
  // while muted, unmute for the announcement and restore the mute when it
  // ends. Only ever restores a mute THIS effect lifted.
  const taLiftedMute = useRef(false);
  useEffect(() => {
    const VM = NativeModules.VibePowerModule as { setMuted?: (m: boolean) => void };
    if (liveStation.ta && isMutedRef.current && !taLiftedMute.current) {
      taLiftedMute.current = true;
      VM?.setMuted?.(false);
    } else if (!liveStation.ta && taLiftedMute.current) {
      taLiftedMute.current = false;
      VM?.setMuted?.(true);
    }
  }, [liveStation.ta]);

  // AF-follow: when the signal has been weak for a sustained stretch and the
  // station transmits an AF list, probe an alternative: keep it ONLY if it is
  // provably the same station (PI match) with a clearly better signal, else
  // revert. Deliberately conservative — one probe at most every 30 s, only
  // after 10 s of continuous weakness, never within 10 s of any retune.
  const afCtx = useRef({ db: null as number | null, pi: undefined as string | undefined,
                         afMhz: undefined as number[] | undefined, freq: 0 });
  afCtx.current = { db: fmSignalDb, pi: liveStation.pi, afMhz: liveStation.afMhz, freq: status.frequency };
  const afState = useRef({
    weakSince: null as number | null, lastTry: 0, freqChangedAt: 0, tryIdx: 0,
    probe: null as null | { fromHz: number; pi?: string; db: number; started: number },
  });
  useEffect(() => { afState.current.freqChangedAt = Date.now(); }, [status.frequency]);
  useEffect(() => {
    if (route.params.tunerless) return;
    const WEAK_DB = 8, HOLD_MS = 10_000, RETRY_MS = 30_000, PROBE_MS = 4_000, IMPROVE_DB = 5;
    const t = setInterval(() => {
      const c = afCtx.current, s = afState.current, now = Date.now();
      if (s.probe) {
        if (now - s.probe.started < PROBE_MS) return;
        // Same PI + clearly stronger keeps the AF; anything else goes back.
        const keep = c.pi != null && c.pi === s.probe.pi && (c.db ?? -99) >= s.probe.db + IMPROVE_DB;
        const from = s.probe.fromHz;
        s.probe = null; s.weakSince = null;
        if (!keep) onTuneHzRef.current?.(from);
        return;
      }
      if (c.db == null || c.db >= WEAK_DB) { s.weakSince = null; return; }
      if (s.weakSince == null) { s.weakSince = now; return; }
      if (now - s.weakSince < HOLD_MS || now - s.lastTry < RETRY_MS
          || now - s.freqChangedAt < HOLD_MS || c.pi == null) return;
      const afs = (c.afMhz ?? []).map((m) => Math.round(m * 1e6))
        .filter((f) => Math.abs(f - c.freq) > 50_000);
      if (afs.length === 0) return;
      const cand = afs[s.tryIdx % afs.length];
      s.tryIdx += 1;
      s.lastTry = now;
      s.probe = { fromHz: c.freq, pi: c.pi, db: c.db, started: now };
      onTuneHzRef.current?.(cand);
    }, 1000);
    return () => clearInterval(t);
  }, [route.params.tunerless]);

  // Save a station straight from the Nearby picker (hold a row).
  const onFmSaveStationPreset = useCallback((name: string, freqMhz: number) => {
    const bm: UserBookmark = {
      name: name.trim() || `FM ${freqMhz.toFixed(1)}`,
      frequency: Math.round(freqMhz * 1e6),
      mode: 'wfm',
      bandwidth_low: null, bandwidth_high: null,
      group: null, comment: null, extension: null,
      scope: '',   // GLOBAL — a saved FM station never depends on the session's tuner/URL
    };
    persistUserBookmarks(mergeBookmarks(userBookmarks, [bm]));
  }, [userBookmarks, persistUserBookmarks]);

  // ── Layout ────────────────────────────────────────────────────────────────

  return (
    <View
      style={styles.root}
      // Capture-phase touch sniff (returns false — never steals the touch):
      // marks interaction for smooth tune / idle saver on any Pressable UI.
      onStartShouldSetResponderCapture={() => { markInteract(); return false; }}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />

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
          host={route.params.localHost}
          authSuffix={route.params.authSuffix}
        />
      ) : null}

      {/* The FM face — the whole CarFM UI, over the live pipeline. */}
      <CarFmFace
        freqHz={status.frequency}
        stationName={liveStation.name}
        callsignHint={fmCallsignHint}
        // RT+ (when transmitted) gives a clean "Artist – Title"; show that on
        // the strip instead of the raw RT line with its promo framing.
        radioText={liveStation.rtArtist && liveStation.rtTitle
          ? `${liveStation.rtArtist} – ${liveStation.rtTitle}`
          : fmRadioTextDisplay}
        stereo={fmStereo}
        signalDb={fmSignalDb}
        // MEASURED bars, built-in tuner only. Outranks the GPS+database estimate
        // because it is a reading rather than a prediction — the estimate is
        // coarse and only recomputed on retune. UNDER DEVELOPMENT.
        signalLit={levelToLit(fmLevel)}
        signalLevelRaw={fmLevel}
        signalDottedPairs={fmDotted}
        signalReadout={readoutFor(tunerSel)}
        rdsOk={!!liveStation.pi || !!liveStation.name}
        tp={liveStation.tp}
        ta={liveStation.ta}
        af={liveStation.af}
        ptyText={ptyLabel(liveStation.pty, ituRegion === 2)}
        tunerError={fmTunerError}
        theme={fmThemeEffective}
        autostart={fmAutostart}
        onSetTheme={onFmSetTheme}
        onSetAutostart={onFmSetAutostart}
        onRetryTuner={route.params.tunerless ? () => { void tryTunerNow(); } : undefined}
        nwdActive={nwdActive}
        onHardwareSeek={nwdActive ? onFmHardwareSeek : undefined}
        presets={fmPresets}
        onTuneHz={onTuneHz}
        onToggleSave={onFmToggleSave}
        onReorderPreset={onFmReorderPreset}
        onRemovePreset={onFmRemovePreset}
        onSaveStationPreset={onFmSaveStationPreset}
        audioActive={fmAudioActive}
        onClaimAudio={onFmClaimAudio}
        onReleaseAudio={onFmReleaseAudio}
        hardwareStep={fmHwStep}
        device={fmDevice}
      />

      {/* Tuner log tail, on the face. Off unless both diagnostics toggles are on;
          never interactive. Follows the same day/night resolution as the face so
          it doesn't glare at night. */}
      {/* Audio-quality rating — debug mode only, and gone entirely otherwise. */}
      {debugOn ? (
        <RatingBar
          pal={(fmThemeEffective === 'dark' || (fmThemeEffective === 'system' && osScheme === 'dark')) ? DARK : LIGHT}
          onRate={onRateAudio}
        />
      ) : null}

      {diagOverlay ? (
        <DiagOverlay pal={
          (fmThemeEffective === 'dark' || (fmThemeEffective === 'system' && osScheme === 'dark'))
            ? DARK : LIGHT
        } />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
});
