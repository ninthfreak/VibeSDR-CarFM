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
  Dimensions,
  NativeEventEmitter,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake }       from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList }     from '../../App';

import { UberSDRClient, type SDRStatus, type SDRMode } from '../services/UberSDRClient';
import { DecoderClient, RTTY_PRESETS,
         type RttySettings, type MorseQuality,
         type SpotRow, type SpotsKind }                from '../services/DecoderClient';
import { type DecoderImageHandle }                     from '../components/DecoderImageCanvas';
import { MIN_HZ, MAX_HZ, STEPS }                       from '../services/sdrTypes';
import { v4 as uuidv4 }                                from 'uuid';
import AsyncStorage                                    from '@react-native-async-storage/async-storage';
import { setDefaultInstance }                          from '../services/defaultInstance';
import { useTheme }                                     from '../contexts/ThemeContext';

import WaterfallView   from '../components/WaterfallView';
import ControlsBar     from '../components/ControlsBar';
import MenuSheet       from '../components/MenuSheet';
import AudioPlayer     from '../components/AudioPlayer';
import FreqModal       from '../components/FreqModal';
import ModeSelector    from '../components/ModeSelector';
import StepPicker      from '../components/StepPicker';
import ChatDrawer,
  { type ChatMessage } from '../components/ChatDrawer';
import DecoderPanel,
  { type DecoderType } from '../components/DecoderPanel';
import SpecRatioOverlay  from '../components/SpecRatioOverlay';
import MapOverlay, { type MapKind } from '../components/MapOverlay';

// ── Constants ──────────────────────────────────────────────────────────────────

const LSV_PX_STEP = 22;
const BW_ZOOM_OCTAVE_PX = 40;   // drum px per 2× waterfall zoom

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

// ── Component ──────────────────────────────────────────────────────────────────

export default function SDRScreen({ route, navigation }: Props) {
  const { baseUrl, instanceName, password } = route.params;
  useKeepAwake();

  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = Dimensions.get('window');
  const isLandscape = screenW > screenH;

  // ── Spec ratio (portrait + landscape stored separately) ───────────────────
  const [specRatioPortrait,  setSpecRatioPortrait]  = useState(0.28);
  const [specRatioLandscape, setSpecRatioLandscape] = useState(0.20);
  const [ratioOverlayOpen,   setRatioOverlayOpen]   = useState(false);
  const specFrac = isLandscape ? specRatioLandscape : specRatioPortrait;

  // ── Client ────────────────────────────────────────────────────────────────

  const client    = useRef<UberSDRClient | null>(null);
  const destroyed = useRef(false);
  const sessionUuid = useMemo(() => uuidv4(), [baseUrl]);

  // ── SDR state ─────────────────────────────────────────────────────────────

  const [connected, setConnected] = useState(false);
  const [status, setStatus]       = useState<SDRStatus>({
    frequency: 14_074_000, mode: 'usb',
    bandwidthLow: -3000, bandwidthHigh: 3000,
    binCount: 1024, binBandwidth: 0, centerHz: 0, bwHz: 0,
  });
  const [bins, setBins] = useState<Float32Array | null>(null);

  // ── Step ──────────────────────────────────────────────────────────────────

  const [step,      setStep]      = useState(1000);
  const [stepOpen,  setStepOpen]  = useState(false);
  const stepRef = useRef(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // ── Display settings ──────────────────────────────────────────────────────

  const [dbMin,         setDbMin]         = useState(-120);
  const [dbMax,         setDbMax]         = useState(-20);
  const [colormap,      setColormap]      = useState('gqrx');
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
  const [autoContrast,  setAutoContrast]  = useState(10);
  // M9PSY 5-tap spatial waterfall smooth
  const [spatialSmooth, setSpatialSmooth] = useState(true);
  const [wfCoarse,      setWfCoarse]      = useState<'auto'|'manual'>('auto');
  const [frameRate,     setFrameRate]     = useState<'native'|'20fps'|'60fps'>('60fps');
  const [vfoNeedle,     setVfoNeedle]     = useState('#ff8800');
  // SNR squelch (audio gate) — value ≤ -999 = open/disabled
  const [snrSquelch,    setSnrSquelch]    = useState(-999);
  // FM squelch — value ≤ -999 = open. Only active on fm/nfm modes.
  const [fmSquelch,     setFmSquelch]     = useState(-999);
  // Server DSP
  const [serverDspEnabled, setServerDspEnabled] = useState(false);
  const [serverDspFilter,  setServerDspFilter]  = useState('wiener');
  const [serverDspParams,  setServerDspParams]  = useState<Record<string,number>>({});

  // ── UI overlay state ──────────────────────────────────────────────────────

  const [menuOpen,      setMenuOpen]      = useState(false);
  const [freqModalOpen, setFreqModalOpen] = useState(false);

  // Server map overlays (HFDL / Digital spots / CW spots — skin parity)
  const [mapKind, setMapKind] = useState<MapKind | null>(null);

  // Frequency display unit — chosen in FreqModal, drives the main readout too.
  const [freqUnit, setFreqUnit] = useState<'hz' | 'khz' | 'mhz'>('khz');
  useEffect(() => {
    AsyncStorage.getItem('lsv_fq_unit').then((u: string | null) => {
      if (u === 'hz' || u === 'khz' || u === 'mhz') setFreqUnit(u);
    }).catch(() => {});
  }, []);
  const [modeSelOpen,   setModeSelOpen]   = useState(false);

  // ── Signal / SNR ──────────────────────────────────────────────────────────

  const [signalLevel,  setSignalLevel]  = useState(0);
  const [peakLevel,    setPeakLevel]    = useState(0);
  const [snrDb,        setSnrDb]        = useState(40);
  const [signalActive, setSignalActive] = useState(false);
  const [signalMode,   setSignalMode]   = useState<'snr' | 'smeter' | 'dbfs'>('snr');

  // ── Recording ─────────────────────────────────────────────────────────────

  const [isRecording, setIsRecording] = useState(false);
  const [recSeconds,  setRecSeconds]  = useState(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleRecording = useCallback(() => {
    setIsRecording((prev: boolean) => {
      if (!prev) {
        setRecSeconds(0);
        recTimerRef.current = setInterval(() => setRecSeconds((s: number) => s + 1), 1000);
      } else {
        if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
        setRecSeconds(0);
      }
      return !prev;
    });
  }, []);

  useEffect(() => () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  }, []);

  // ── Chat ──────────────────────────────────────────────────────────────────

  const [chatOpen,     setChatOpen]     = useState(false);
  const [chatUnread,   setChatUnread]   = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [myCallsign,   setMyCallsign]   = useState<string | null>(null);
  const [chatMuted,    setChatMuted]    = useState(false);

  const addChatMsg = useCallback((msg: ChatMessage) => {
    setChatMessages((prev: ChatMessage[]) => [...prev.slice(-99), msg]);
    // If drawer is closed and not muted, mark unread
    setChatOpen((open: boolean) => {
      if (!open) setChatUnread(true);
      return open;
    });
  }, []);

  const handleChatJoin = useCallback((cs: string) => {
    setMyCallsign(cs);
    addChatMsg(mkMsg('system', `${cs} joined the chat`));
  }, [addChatMsg]);

  const handleChatSend = useCallback((text: string) => {
    if (!myCallsign) return;
    addChatMsg(mkMsg('own', text, myCallsign));
    // TODO: send via UberSDR chat WebSocket
  }, [myCallsign, addChatMsg]);

  const openChat = useCallback(() => {
    setChatOpen(true);
    setChatUnread(false);
  }, []);

  const closeChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  // ── Decoder ───────────────────────────────────────────────────────────────

  const [activeDecoder,  setActiveDecoder]  = useState<DecoderType>(null);
  const [decoderText,    setDecoderText]    = useState('');
  const [decoderStatus,  setDecoderStatus]  = useState('listening…');
  const [decoding,       setDecoding]       = useState(false);
  const [pillBottom,     setPillBottom]     = useState(200); // updated by pill layout

  // Real decoders — UberSDR server audio extensions over /ws/dxcluster,
  // exactly as the confirmed-working skin wires them (see DecoderClient.ts).
  // Uses the SAME session uuid as audio so the extension taps this session's
  // demodulated stream server-side. DEC_SIM fake data is gone.
  const decoderClient   = useRef<DecoderClient | null>(null);
  const decoderImageRef = useRef<DecoderImageHandle | null>(null);
  const activeDecRef    = useRef<DecoderType>(null);

  useEffect(() => {
    const dc = new DecoderClient(baseUrl, sessionUuid, {
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
    });
    decoderClient.current = dc;
    return () => { dc.destroy(); decoderClient.current = null; };
  }, [baseUrl, sessionUuid]);

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

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const emitter = new NativeEventEmitter(NativeModules.VibePowerModule);
    const sub = emitter.addListener('VibeTuned', (e: { frequency: number; mode: string }) => {
      client.current?.syncFrequency(e.frequency, e.mode as SDRMode);
      setStatus((prev: SDRStatus) => ({ ...prev, frequency: e.frequency, ...(e.mode ? { mode: e.mode as SDRMode } : {}) }));
    });
    return () => sub.remove();
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────

  useEffect(() => {
    destroyed.current = false;
    const c = new UberSDRClient(baseUrl, sessionUuid, {
      onConnect:    () => { if (!destroyed.current) setConnected(true); },
      onDisconnect: () => { if (!destroyed.current) setConnected(false); },
      onStatus:     (s) => { if (!destroyed.current) setStatus(s); },
      onSpectrum:   (newBins, s) => {
        if (destroyed.current) return;
        setBins(new Float32Array(newBins));
        setStatus(s);
        // ── Derive signal level + SNR from bins ────────────────────────────
        // Find peak bin power in the current bandwidth window
        if (newBins.length > 0) {
          const len = newBins.length;
          // Bandwidth window — centre ±bw fraction of bins
          const bwFrac = Math.min(1, (s.bandwidthHigh - s.bandwidthLow) / Math.max(1, s.bwHz));
          const half = Math.floor((bwFrac * len) / 2);
          const mid = Math.floor(len / 2);
          const lo = Math.max(0, mid - half);
          const hi = Math.min(len - 1, mid + half);
          let peak = -200, sum = 0, count = 0;
          for (let i = lo; i <= hi; i++) {
            const v = newBins[i];
            if (v > peak) peak = v;
            sum += v; count++;
          }
          const avg = count > 0 ? sum / count : -120;
          // Noise floor from outer 20% of bins
          const edgeN = Math.floor(len * 0.1);
          let noiseSum = 0, noiseCount = 0;
          for (let i = 0; i < edgeN; i++) { noiseSum += newBins[i]; noiseCount++; }
          for (let i = len - edgeN; i < len; i++) { noiseSum += newBins[i]; noiseCount++; }
          const noise = noiseCount > 0 ? noiseSum / noiseCount : -130;
          const snr = Math.max(0, Math.min(100, (peak - noise) * 2.5));
          const normLevel = Math.max(0, Math.min(1, (peak + 130) / 90));
          const normPeak  = Math.max(0, Math.min(1, (avg  + 130) / 90));
          setSignalLevel(normLevel);
          setPeakLevel(normPeak);
          setSnrDb(snr);
          setSignalActive(peak > noise + 6);
        }
      },
      onError: (msg) => {
        if (destroyed.current) return;
        Alert.alert('Connection Error', msg, [{ text: 'Back', onPress: () => navigation.goBack() }]);
      },
    });
    client.current = c;
    c.connect(status.frequency, status.mode);
    return () => { destroyed.current = true; c.destroy(); client.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: string) => {
      if (state !== 'active') client.current?.pauseSpectrum();
      else                    client.current?.resumeSpectrum();
    });
    return () => sub.remove();
  }, []);

  // ── VFO drum ──────────────────────────────────────────────────────────────
  // Skin-parity step tuning (vSendDelta + vDown from Scalable_Mobile_UI v6.3.1):
  //   - pending accumulates in Hz: px × step / LSV_PX_STEP
  //   - tunes ONLY in whole steps: steps = round(pending / step)
  //   - baseline snaps to the step grid, so frequency always lands on a
  //     multiple of the step rate (7,153,000 — never 7,153,437)
  const vfoPendingHz = useRef(0);

  const onVfoDelta = useCallback((pxDelta: number) => {
    const c = client.current; if (!c) return;
    const s = stepRef.current;
    vfoPendingHz.current += (pxDelta * s) / LSV_PX_STEP;
    const steps = Math.round(vfoPendingHz.current / s);
    if (!steps) return;
    vfoPendingHz.current -= steps * s;
    const cur     = c.getStatus().frequency;
    const snapped = Math.round(cur / s) * s;   // vDown grid snap
    const newHz   = Math.max(MIN_HZ, Math.min(MAX_HZ, snapped + steps * s));
    if (newHz === cur) return;
    c.tune(newHz);
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: newHz }));
  }, []);

  // ── BW drum ───────────────────────────────────────────────────────────────

  // Gesture accumulator: drum ticks arrive as small px deltas (rounding them
  // per-event gives factor 1 = no-op), and the server snaps binBandwidth to a
  // ladder (small factors snap back to the same step). So compound the whole
  // gesture from the bandwidth captured at gesture start.
  const bwZoomAcc = useRef({ base: 0, px: 0, t: 0 });
  const onBwDelta = useCallback((pxDelta: number) => {
    const c = client.current; if (!c) return;
    const s = c.getStatus();
    if (!s.binBandwidth || !s.centerHz || !s.binCount) return;
    const a = bwZoomAcc.current;
    const now = Date.now();
    if (now - a.t > 400 || !a.base) { a.base = s.binBandwidth; a.px = 0; }
    a.t = now;
    a.px += pxDelta;
    // 40px of drum travel per zoom octave (2×) — tune BW_ZOOM_OCTAVE_PX to taste
    c.zoom(s.centerHz, Math.max(0.5, a.base * Math.pow(0.5, a.px / BW_ZOOM_OCTAVE_PX)));
  }, []);

  const onZoomIn = useCallback(() => {
    const c = client.current; if (!c) return;
    const s = c.getStatus(); if (!s.binBandwidth || !s.centerHz) return;
    c.zoom(s.centerHz, Math.max(1, s.binBandwidth / 2));
  }, []);

  const onZoomOut = useCallback(() => {
    const c = client.current; if (!c) return;
    const s = c.getStatus(); if (!s.binBandwidth || !s.centerHz) return;
    c.zoom(s.centerHz, s.binBandwidth * 2);
  }, []);

  const onSetDefault = useCallback(() => {
    setDefaultInstance({ name: instanceName ?? baseUrl, url: baseUrl })
      .then(() => Alert.alert('Default Set', `${instanceName ?? baseUrl} is now your default instance.`))
      .catch(() => {});
  }, [baseUrl, instanceName]);

  // ── Waterfall gestures ────────────────────────────────────────────────────

  const onWfPanDelta = useCallback((dxPx: number) => {
    const c = client.current; if (!c) return;
    const s = c.getStatus(); if (!s.bwHz || !s.centerHz) return;
    c.pan(s.centerHz + Math.round((dxPx / screenW) * s.bwHz));
  }, [screenW]);

  // Same gesture-accumulator pattern as the BW drum (ladder snap-back).
  const wfZoomAcc = useRef({ base: 0, f: 1, t: 0 });
  const wfZoomBy = useCallback((factor: number) => {
    const c = client.current; if (!c) return;
    const s = c.getStatus(); if (!s.binBandwidth || !s.centerHz) return;
    const a = wfZoomAcc.current;
    const now = Date.now();
    if (now - a.t > 400 || !a.base) { a.base = s.binBandwidth; a.f = 1; }
    a.t = now;
    a.f *= factor;
    c.zoom(s.centerHz, Math.max(0.5, a.base * a.f));
  }, []);

  const onWfZoomDelta = useCallback((dyPx: number) => {
    wfZoomBy(Math.pow(0.985, dyPx));
  }, [wfZoomBy]);

  const onWfPinchZoom = useCallback((scaleDelta: number) => {
    wfZoomBy(1 / scaleDelta);
  }, [wfZoomBy]);

  const onWfTapTune = useCallback((hz: number) => {
    const c = client.current; if (!c) return;
    const clamped = Math.max(MIN_HZ, Math.min(MAX_HZ, hz));
    c.tune(clamped);
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: clamped }));
  }, []);

  // ── Mode / filter / tune ──────────────────────────────────────────────────

  const onMode = useCallback((m: SDRMode) => {
    client.current?.setMode(m);
    setStatus((prev: SDRStatus) => ({ ...prev, mode: m }));
  }, []);

  const onFilterLow  = useCallback((v: number) => { client.current?.setBandwidth(v, status.bandwidthHigh); setStatus((prev: SDRStatus) => ({ ...prev, bandwidthLow: v })); }, [status.bandwidthHigh]);
  const onFilterHigh = useCallback((v: number) => { client.current?.setBandwidth(status.bandwidthLow, v);  setStatus((prev: SDRStatus) => ({ ...prev, bandwidthHigh: v })); }, [status.bandwidthLow]);

  // ── NR cycle: off → nr → nr2 (SERV locked by server DSP section) ──────────
  const onNrMode = useCallback((mode: 'off'|'nr'|'nr2') => {
    setNrMode(mode);
    client.current?.setNRMode(mode);
  }, []);

  // ── NB toggle ────────────────────────────────────────────────────────────
  const onNb = useCallback((on: boolean) => {
    setNb(on);
    client.current?.setNoiseBlanker(on);
  }, []);

  // ── SNR squelch (audio gate) ──────────────────────────────────────────────
  const onSnrSquelch = useCallback((minSnr: number) => {
    setSnrSquelch(minSnr);
    client.current?.setAudioGate(minSnr);
  }, []);

  // ── FM squelch ────────────────────────────────────────────────────────────
  const onFmSquelch = useCallback((db: number) => {
    setFmSquelch(db);
    client.current?.setSquelch(db);
  }, []);

  // ── Server DSP ────────────────────────────────────────────────────────────
  const onServerDsp = useCallback((enabled: boolean, filter?: string, params?: Record<string,number>) => {
    setServerDspEnabled(enabled);
    if (filter) setServerDspFilter(filter);
    if (params) setServerDspParams(params);
    client.current?.setDsp(enabled, filter, params);
  }, []);

  const onServerDspParams = useCallback((params: Record<string,number>) => {
    setServerDspParams(params);
    client.current?.setDspParams(params);
  }, []);

  const onTuneHz = useCallback((hz: number) => {
    const c = client.current; if (!c) return;
    const clamped = Math.max(MIN_HZ, Math.min(MAX_HZ, hz));
    c.tune(clamped);
    setStatus((prev: SDRStatus) => ({ ...prev, frequency: clamped }));
  }, []);

  // ── Layout ────────────────────────────────────────────────────────────────

  const bottomInset = insets.bottom;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#000" translucent={false} />

      {/* Waterfall — fills screen below the status bar / Dynamic Island so the
          band plan strip is never hidden under the notch */}
      <View style={{ marginTop: insets.top }}>
      <WaterfallView
        bins={bins}
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
        wfBrightness={wfBrightness}
        wfContrast={wfContrast}
        wfSharpness={wfSharpness}
        frameRate={frameRate}
        needleColor={vfoNeedle}
        specFrac={specFrac}
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

      {/* Controls pill — absolute overlay, margin 8px each side */}
      <View
        style={[styles.pillWrap, { bottom: bottomInset + 8 }]}
        onLayout={(e: any) => {
          // Track pill top so decoder panel can anchor above it
          const { y, height } = e.nativeEvent.layout;
          setPillBottom(screenH - y);
        }}
      >
        <ControlsBar
          frequency={status.frequency}
          mode={status.mode}
          step={step}
          connected={connected}
          bottomInset={0}
          instanceHost={instanceName ?? baseUrl}
          signalLevel={signalLevel}
          peakLevel={peakLevel}
          snrDb={snrDb}
          signalActive={signalActive}
          isRecording={isRecording}
          recSeconds={recSeconds}
          chatUnread={chatUnread}
          onVfoDelta={onVfoDelta}
          onBwDelta={onBwDelta}
          onMode={onMode}
          onStep={() => setStepOpen(true)}
          onMenu={() => setMenuOpen(true)}
          onChat={openChat}
          onFreqTap={() => setFreqModalOpen(true)}
          onModeTap={() => setModeSelOpen(true)}
          freqUnit={freqUnit}
        />
      </View>

      {/* Menu sheet */}
      <MenuSheet
        visible={menuOpen}
        colormap={colormap}
        dbMin={dbMin}
        dbMax={dbMax}
        filterLow={status.bandwidthLow}
        filterHigh={status.bandwidthHigh}
        nr={nrMode !== 'off'}
        nb={nb}
        recording={isRecording}
        recSeconds={recSeconds}
        signalMode={signalMode}
        displayStyle={displayStyle}
        serverName={instanceName ?? ''}
        serverUrl={baseUrl}
        onClose={() => setMenuOpen(false)}
        onColormap={setColormap}
        onDbMin={setDbMin}
        onDbMax={setDbMax}
        onFilterLow={onFilterLow}
        onFilterHigh={onFilterHigh}
        onNr={onNrMode}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onSetDefault={onSetDefault}
        decMode={selDecoder}
        decOn={activeDecoder !== null && activeDecoder === selDecoder}
        onDecToggle={onDecToggle}
        spotsKind={spotsKind}
        onSpotsToggle={onSpotsToggle}
        onServerMap={(k) => { setMenuOpen(false); setMapKind(k); }}
        rttySettings={rttySettings}
        onRttySettings={onRttySettings}
        wefaxLpm={wefaxLpm}
        onWefaxLpm={onWefaxLpm}
        onNb={onNb}
        onRec={toggleRecording}
        onSignalMode={setSignalMode}
        onDisplayStyle={handleDisplayStyle}
        onReconnect={() => { client.current?.destroy(); setConnected(false); }}
        onResetSettings={() => {
          setDbMin(-120); setDbMax(-20); setColormap('gqrx');
          setStep(1000);
          setSpecShow(true); setSpecSmoothing(5); setSpecFloor(0);
          setSpecPeakScale(10); setPeakHold(true);
          setWfBrightness(0); setWfContrast(0); setWfSharpness(5);
          setAutoContrast(10); setSpatialSmooth(true);
          setWfCoarse('auto'); setFrameRate('60fps'); setVfoNeedle('#ff8800');
          setSpecRatioPortrait(0.28); setSpecRatioLandscape(0.20);
          onNrMode('off'); onNb(false);
          onSnrSquelch(-999); onFmSquelch(-999);
          onServerDsp(false);
          setMenuOpen(false);
        }}
        onSpecRatio={() => { setMenuOpen(false); setRatioOverlayOpen(true); }}
        vfoNeedle={vfoNeedle}           onVfoNeedle={setVfoNeedle}
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
        frameRate={frameRate}           onFrameRate={setFrameRate}
        snrSquelch={snrSquelch}         onSnrSquelch={onSnrSquelch}
        fmSquelch={fmSquelch}           onFmSquelch={onFmSquelch}
        isFmMode={status.mode === 'fm' || status.mode === 'nfm'}
        serverDspEnabled={serverDspEnabled}
        serverDspFilter={serverDspFilter}
        serverDspParams={serverDspParams}
        onServerDsp={onServerDsp}
        onServerDspParams={onServerDspParams}
      />

      {/* Step picker — bottom sheet */}
      <StepPicker
        visible={stepOpen}
        currentStep={step}
        onSelect={hz => { setStep(hz); }}
        onClose={() => setStepOpen(false)}
      />

      {/* Mode selector */}
      <ModeSelector
        visible={modeSelOpen}
        current={status.mode}
        onSelect={onMode}
        onClose={() => setModeSelOpen(false)}
      />

      {/* Server map overlay (HFDL / Digital / CW — full-screen WebView Leaflet) */}
      <MapOverlay
        visible={mapKind !== null}
        kind={mapKind}
        baseUrl={baseUrl}
        onClose={() => setMapKind(null)}
      />

      {/* Frequency modal */}
      <FreqModal
        visible={freqModalOpen}
        currentHz={status.frequency}
        onConfirm={onTuneHz}
        onClose={() => setFreqModalOpen(false)}
        unit={freqUnit}
        onUnit={setFreqUnit}
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
      />

      {/* Audio player (renderless) */}
      <AudioPlayer
        baseUrl={baseUrl}
        frequency={status.frequency}
        mode={status.mode}
        step={step}
        instanceName={instanceName}
        uuid={sessionUuid}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
