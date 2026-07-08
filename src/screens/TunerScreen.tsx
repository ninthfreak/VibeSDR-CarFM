import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { createBackend } from '../services/UberSDRAdapter';
import type { SDRBackend, FmdxState } from '../services/SDRBackend';
import { lookupStationLogo } from '../services/stationLogo';
import { useTheme, type ThemeTokens } from '../contexts/ThemeContext';
import ControlsBar from '../components/ControlsBar';
import ChatDrawer, { type ChatMessage } from '../components/ChatDrawer';
import FreqModal from '../components/FreqModal';
import FmdxDial, { type DialStation } from '../components/FmdxDial';

// FM-DX Webserver tuner screen (v7). Single shared hardware tuner: server-side
// demod + RDS, native MP3 audio. No waterfall — station/RDS panels fill the top,
// and the app's real control island (single VFO drum, no bandwidth) sits at the
// bottom so it reads as native VibeSDR. Chat is first-class (shared tuning).

type Props = NativeStackScreenProps<RootStackParamList, 'Tuner'>;

const PTY = [
  'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama',
  'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music', 'Easy Listening',
  'Light Classical', 'Serious Classical', 'Other Music', 'Weather', 'Finance',
  'Children', 'Social Affairs', 'Religion', 'Phone In', 'Travel', 'Leisure',
  'Jazz Music', 'Country Music', 'National Music', 'Oldies Music', 'Folk Music',
  'Documentary', 'Alarm Test', 'Alarm',
];

const FM_LO = 87_500_000, FM_HI = 108_000_000;
const clampFm = (hz: number) => Math.min(FM_HI, Math.max(FM_LO, hz));
// FM step ladder (Hz) — server accepts any kHz via T<kHz>, so we lock the STEP
// button to broadcast-FM-sensible values (1 kHz DX → 1 MHz coarse).
const FM_STEPS = [1_000, 10_000, 100_000, 1_000_000];
// VFO drum feel — ported from SDRScreen's velocity-adaptive tuning.
const DRUM_VFO_SENS = 22, VFO_FINE_MULT = 4, VFO_VEL_FINE = 40, VFO_VEL_FAST = 350;
const pad2 = (n: number) => String(n).padStart(2, '0');
const zulu = () => { const d = new Date(); return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}z`; };

export default function TunerScreen({ route, navigation }: Props) {
  const { baseUrl, instanceName } = route.params;
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const backendRef = useRef<SDRBackend | null>(null);
  const destroyed = useRef(false);

  const [st, setSt] = useState<FmdxState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const lastLogoName = useRef<string>('');

  // Client-learned dial map: every RDS name we decode is pinned to its frequency
  // on the vintage dial, persisted per server. Accumulate in a ref, flush to state
  // + storage debounced.
  const [dialStations, setDialStations] = useState<DialStation[]>([]);
  const dialMapRef = useRef<Map<number, string>>(new Map());
  const dialFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DIAL_KEY = `lsv_fmdx_dial:${baseUrl}`;
  const learnStation = useCallback((freqHz: number, name: string) => {
    const n = name.trim();
    if (n.length < 2) return;                          // wait for a real PS lock
    if (dialMapRef.current.get(freqHz) === n) return;  // unchanged — no-op (no spam while parked)
    dialMapRef.current.set(freqHz, n);
    // Update the dial LIVE as you tune; persist to storage debounced.
    const arr = Array.from(dialMapRef.current, ([f, nm]) => ({ freqHz: f, name: nm })).slice(-300);
    setDialStations(arr);
    if (dialFlushTimer.current) clearTimeout(dialFlushTimer.current);
    dialFlushTimer.current = setTimeout(() => {
      AsyncStorage.setItem(DIAL_KEY, JSON.stringify(arr)).catch(() => {});
    }, 800);
  }, [DIAL_KEY]);

  // Tuning: displayFreq is what the pill/drum show; while dragging we update it
  // locally and only COMMIT (tune the shared radio) on settle so a drum spin
  // doesn't spam retunes for everyone. When not dragging, the server frame drives it.
  const [displayFreq, setDisplayFreq] = useState(95_000_000);
  const [step, setStep] = useState(100_000);
  const [freqModalOpen, setFreqModalOpen] = useState(false);
  const dragFreqRef = useRef<number | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vfoPendingHz = useRef(0);
  const vfoVel = useRef({ t: 0, v: 0 });   // EMA thumb speed, px/s
  // After we command a tune, the server keeps streaming the OLD freq for a beat
  // before it retunes. Hold our target and ignore mismatching frames until it
  // converges (or a grace timeout — a locked/spectator server never will), so
  // the display doesn't bounce back to the old frequency.
  const targetFreqRef = useRef<number | null>(null);
  const convergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTarget = useCallback((f: number) => {
    targetFreqRef.current = f;
    if (convergeTimer.current) clearTimeout(convergeTimer.current);
    convergeTimer.current = setTimeout(() => { targetFreqRef.current = null; }, 3000);
  }, []);

  // Chat
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [myCallsign, setMyCallsign] = useState<string | null>(null);
  const myCallsignRef = useRef<string | null>(null);
  const chatOpenRef = useRef(false);
  const msgId = useRef(0);
  useEffect(() => { myCallsignRef.current = myCallsign; }, [myCallsign]);
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);

  const CALLSIGN_KEY = `lsv_chat_callsign:${baseUrl}`;

  // ── Connect / teardown ──────────────────────────────────────────────────────
  useEffect(() => {
    destroyed.current = false;
    AsyncStorage.getItem(CALLSIGN_KEY).then((cs) => { if (!destroyed.current && cs) setMyCallsign(cs); });
    AsyncStorage.getItem(DIAL_KEY).then((raw) => {
      if (destroyed.current || !raw) return;
      try {
        const arr: DialStation[] = JSON.parse(raw);
        dialMapRef.current = new Map(arr.map((s) => [s.freqHz, s.name]));
        setDialStations(arr);
      } catch {}
    });

    const uuid = uuidv4();
    const backend = createBackend('fmdx', baseUrl, uuid, {
      onSpectrum: () => {},
      onStatus:   () => {},
      onError:    (m) => { if (!destroyed.current) setError(m); },
      onConnect:  () => { if (!destroyed.current) { setConnected(true); setError(null); } },
      onDisconnect: () => { if (!destroyed.current) setConnected(false); },
      onServerLost: () => { if (!destroyed.current) setError('Server stopped responding'); },
      onFmdxState: (s) => {
        if (destroyed.current) return;
        setSt(s);
        if (s.rds && s.ps) learnStation(s.freqHz, s.ps);  // pin RDS name to the dial
        if (dragFreqRef.current != null) return;          // dragging — drum owns the display
        const target = targetFreqRef.current;
        if (target != null) {
          if (s.freqHz === target) {                       // server caught up
            targetFreqRef.current = null;
            if (convergeTimer.current) clearTimeout(convergeTimer.current);
            setDisplayFreq(s.freqHz);
          }
          // else: still the stale old freq — hold the target, don't bounce
        } else {
          setDisplayFreq(s.freqHz);                        // idle — server drives
        }
      },
      onChatMessage: (name, text) => {
        if (destroyed.current) return;
        const own = name === myCallsignRef.current;
        setChatMessages((prev) => [...prev.slice(-99), {
          id: `m${msgId.current++}`, type: own ? 'own' : 'other', user: name, text, ts: zulu(),
        }]);
        if (!chatOpenRef.current) setChatUnread(true);
      },
    });
    backendRef.current = backend;
    backend.connect().catch((e) => { if (!destroyed.current) setError(String(e?.message ?? e)); });

    return () => {
      destroyed.current = true;
      if (commitTimer.current) clearTimeout(commitTimer.current);
      if (convergeTimer.current) clearTimeout(convergeTimer.current);
      if (dialFlushTimer.current) clearTimeout(dialFlushTimer.current);
      backendRef.current?.destroy();
      backendRef.current = null;
    };
  }, [baseUrl]);

  // ── Station logo (radio-browser, EXACT-name match only so we never show the
  //    wrong station's logo). Use the transmitter's full station name — far
  //    better than the truncated RDS PS. Monogram when there's no confident hit. ──
  const logoName = st?.tx?.tx?.trim() || st?.ps?.trim() || '';
  const logoIso = st?.countryIso ?? '';
  useEffect(() => {
    const key = `${logoName}|${logoIso}`;
    if (!logoName || key === lastLogoName.current) return;
    lastLogoName.current = key;
    setLogo(null);
    lookupStationLogo(logoName, logoIso || undefined).then((url) => {
      if (!destroyed.current && lastLogoName.current === key) setLogo(url);
    });
  }, [logoName, logoIso]);

  // ── Drum tuning: velocity-adaptive accumulator, snapped to the step grid,
  //    committed once on settle (shared tuner — don't spam retunes). ───────────
  const commitTune = useCallback(() => {
    const f = dragFreqRef.current;
    dragFreqRef.current = null;
    if (f != null) { armTarget(f); backendRef.current?.tune(f); }
  }, [armTarget]);

  const onVfoDelta = useCallback((pxDelta: number) => {
    const s = step;
    const now = Date.now();
    const gap = now - vfoVel.current.t;
    vfoVel.current.t = now;
    if (gap > 300) vfoVel.current.v = 0;
    else {
      const inst = Math.abs(pxDelta) / (Math.max(8, gap) / 1000);
      vfoVel.current.v = vfoVel.current.v * 0.7 + inst * 0.3;
    }
    const k = Math.max(0, Math.min(1, (vfoVel.current.v - VFO_VEL_FINE) / (VFO_VEL_FAST - VFO_VEL_FINE)));
    const pxPerStep = DRUM_VFO_SENS * (VFO_FINE_MULT - (VFO_FINE_MULT - 1) * k);
    vfoPendingHz.current += (pxDelta * s) / pxPerStep;
    const steps = Math.round(vfoPendingHz.current / s);
    if (!steps) return;
    vfoPendingHz.current -= steps * s;
    const cur = dragFreqRef.current ?? displayFreq;
    const snapped = Math.round(cur / s) * s;              // lock to the step grid
    const newHz = clampFm(snapped + steps * s);
    if (newHz === cur) return;
    dragFreqRef.current = newHz;
    setDisplayFreq(newHz);
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitTune, 220);
  }, [displayFreq, step, commitTune]);

  const onConfirmFreq = useCallback((hz: number) => {
    const f = clampFm(hz);
    dragFreqRef.current = null;
    setDisplayFreq(f);
    armTarget(f);
    backendRef.current?.tune(f);
  }, [armTarget]);

  // ── Chat handlers ───────────────────────────────────────────────────────────
  const onJoin = useCallback((cs: string) => {
    const clean = cs.trim().replace(/[^A-Za-z0-9\-_/]/g, '').slice(0, 20);
    if (!clean) return;
    setMyCallsign(clean);
    AsyncStorage.setItem(CALLSIGN_KEY, clean).catch(() => {});
  }, [CALLSIGN_KEY]);
  const onSend = useCallback((text: string) => {
    if (myCallsignRef.current) (backendRef.current as any)?.sendChat?.(text, myCallsignRef.current);
  }, []);
  const openChat = useCallback(() => { setChatOpen(true); setChatUnread(false); }, []);

  const ps = st?.ps?.trim() || (connected ? '' : 'Connecting…');
  const monogram = (st?.ps?.trim() || '?').slice(0, 3).toUpperCase();
  const sigNorm = Math.min(1, Math.max(0, (st?.sig ?? 0) / 70));

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header (Back lives in the control island's menu slot) */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{instanceName ?? 'FM-DX'}</Text>
        {!!st && <Text style={styles.users}>{st.users} 👤</Text>}
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
        {error && <Text style={styles.err}>{error}</Text>}

        {/* Vintage tuning dial — every RDS name we decode is pinned to its freq */}
        <FmdxDial
          freqHz={displayFreq}
          loHz={FM_LO}
          hiHz={FM_HI}
          stations={dialStations}
          onTune={(hz) => onConfirmFreq(Math.round(hz / 100_000) * 100_000)}
          theme={theme}
        />

        {/* PI (signal reading lives under the mode label; station name + RDS
            RadioText moved to the VTS strip above the island) */}
        <View style={styles.panel}>
          <Text style={styles.metaLabel}>PI CODE</Text>
          <Text style={styles.metaVal}>{st?.pi || '––––'}</Text>
        </View>

        {/* Transmitter (relative to the RECEIVER's location) */}
        {st?.tx?.tx && (
          <View style={styles.panel}>
            <Text style={styles.metaLabel}>TRANSMITTER</Text>
            <Text style={styles.txName}>{st.tx.tx}{st.tx.city ? ` · ${st.tx.city}` : ''}</Text>
            <Text style={styles.txMeta}>
              {[st.tx.erp ? `${st.tx.erp} kW` : '', st.tx.pol ? st.tx.pol.toUpperCase() : '',
                Number.isFinite(st.tx.dist as number) ? `${st.tx.dist} km` : '',
                Number.isFinite(st.tx.azi as number) ? `${st.tx.azi}°` : ''].filter(Boolean).join(' · ')}
              {'   (from receiver)'}
            </Text>
          </View>
        )}

        {/* Alternative frequencies — tap to tune (same station elsewhere) */}
        {!!st?.af?.length && (
          <View style={styles.panel}>
            <Text style={styles.metaLabel}>AF · TAP TO TUNE</Text>
            <View style={styles.afRow}>
              {st.af.map((h, i) => (
                <TouchableOpacity key={`${h}-${i}`} style={styles.afChip} onPress={() => onConfirmFreq(h)} activeOpacity={0.7}>
                  <Text style={styles.afChipTxt}>{(h / 1e6).toFixed(1)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {!connected && !error && (
          <View style={{ alignItems: 'center', padding: 20 }}><ActivityIndicator color={theme.btnActiveText} /></View>
        )}
      </ScrollView>

      {/* VTS — current station identity + RadioText, above the island (like the
          SDR screen's station readout) */}
      <View style={styles.vts}>
        <View style={styles.vtsLogo}>
          {logo
            ? <Image source={{ uri: logo }} style={styles.vtsLogoImg} resizeMode="contain" />
            : <Text style={styles.vtsMono}>{monogram}</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.vtsTopRow}>
            <Text style={styles.vtsName} numberOfLines={1}>{ps || '—'}</Text>
            {st?.stereo && <Pill label="ST" on styles={styles} />}
            {st?.tp && <Pill label="TP" on styles={styles} />}
            {st?.ta && <Pill label="TA" on styles={styles} />}
          </View>
          {!!st?.rt?.trim() && (
            <Text style={styles.vtsRt} numberOfLines={1}>{st.rt.replace(/\s{2,}/g, ' ').trim()}</Text>
          )}
        </View>
      </View>

      {/* The app's real control island — single VFO drum (no bandwidth) */}
      <ControlsBar
        frequency={displayFreq}
        mode="wfm"
        step={step}
        connected={connected}
        signalLevel={sigNorm}
        peakLevel={sigNorm}
        snrDb={st?.sig ?? 0}
        signalActive={connected}
        fmStereo={!!st?.stereo}
        freqUnit="mhz"
        bottomInset={insets.bottom}
        onVfoDelta={onVfoDelta}
        onBwDelta={() => {}}
        onMode={() => {}}
        onStep={setStep}
        onMenu={() => navigation.goBack()}
        onChat={openChat}
        onFreqTap={() => setFreqModalOpen(true)}
        chatUnread={chatUnread}
        instanceHost={instanceName ?? 'FM-DX'}
        singleDrum
        menuAsBack
        stepList={FM_STEPS}
        meterLabel={st ? `${Math.round(st.sig)} dBf` : ''}
        freqFormat={(hz) => (hz / 1e6).toFixed(3)}
      />

      <FreqModal
        visible={freqModalOpen}
        currentHz={displayFreq}
        onConfirm={onConfirmFreq}
        onClose={() => setFreqModalOpen(false)}
        unit="mhz"
        lockUnit
        minHz={FM_LO}
        maxHz={FM_HI}
      />

      <ChatDrawer
        visible={chatOpen}
        messages={chatMessages}
        myCallsign={myCallsign}
        onJoin={onJoin}
        onSend={onSend}
        onClose={() => setChatOpen(false)}
        onChangeName={() => setMyCallsign(null)}
        textOnly
      />
    </SafeAreaView>
  );
}

function Pill({ label, on, styles }: { label: string; on?: boolean; styles: any }) {
  return (
    <View style={[styles.pill, on && styles.pillOn]}>
      <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>{label}</Text>
    </View>
  );
}

function makeStyles(t: ThemeTokens) {
  const F = t.font;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: '#080601' },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12, borderBottomWidth: 1, borderBottomColor: t.barBorder },
    back: { paddingVertical: 2, paddingRight: 4 },
    backTxt: { color: t.btnActiveText, fontFamily: F, fontSize: 15 },
    title: { flex: 1, color: t.freqColor, fontFamily: F, fontSize: 18, fontWeight: 'bold', letterSpacing: 1 },
    users: { color: t.snrColor, fontFamily: F, fontSize: 13 },
    err: { color: '#ff8a8a', fontFamily: F, fontSize: 13, textAlign: 'center' },
    panel: { backgroundColor: t.barBg, borderRadius: 14, borderWidth: 1, borderColor: t.barBorder, padding: 14 },
    stationRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    logoBox: { width: 72, height: 72, borderRadius: 10, backgroundColor: t.pillBg, borderWidth: 1, borderColor: t.barBorder, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    logo: { width: 68, height: 68 },
    monogram: { color: t.btnActiveText, fontFamily: F, fontSize: 22, fontWeight: 'bold' },
    station: { color: t.freqColor, fontFamily: F, fontSize: 22, fontWeight: 'bold' },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    pill: { borderColor: t.btnBorder, borderWidth: 1, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: t.btnBg },
    pillOn: { backgroundColor: t.btnActiveBg, borderColor: t.btnActiveBdr },
    pillTxt: { color: t.unitColor, fontFamily: F, fontSize: 10, fontWeight: 'bold', letterSpacing: 1 },
    pillTxtOn: { color: t.btnActiveText },
    metaRow: { flexDirection: 'row', gap: 12 },
    metaCell: { flex: 1 },
    metaLabel: { color: t.sectionColor, fontFamily: F, fontSize: 11, fontWeight: 'bold', letterSpacing: 2, marginBottom: 4 },
    metaVal: { color: t.freqColor, fontFamily: F, fontSize: 26, fontWeight: 'bold' },
    metaUnit: { fontSize: 14, color: t.unitColor, fontWeight: 'normal' },
    sigBarBg: { height: 6, backgroundColor: t.pillBg, borderRadius: 3, marginTop: 8, overflow: 'hidden' },
    sigBarFill: { height: 6, backgroundColor: t.btnActiveText },
    rt: { color: t.freqColor, fontFamily: F, fontSize: 15, marginTop: 4 },
    txName: { color: t.freqColor, fontFamily: F, fontSize: 15, fontWeight: 'bold', marginTop: 2 },
    txMeta: { color: t.unitColor, fontFamily: F, fontSize: 12, marginTop: 3 },
    af: { color: t.freqColor, fontFamily: F, fontSize: 15, marginTop: 4, letterSpacing: 1 },
    vts: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 14, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: t.barBg, borderRadius: 12, borderWidth: 1, borderColor: t.barBorder },
    vtsLogo: { width: 40, height: 40, borderRadius: 8, backgroundColor: t.pillBg, borderWidth: 1, borderColor: t.barBorder, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    vtsLogoImg: { width: 38, height: 38 },
    vtsMono: { color: t.btnActiveText, fontFamily: F, fontSize: 14, fontWeight: 'bold' },
    vtsTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    vtsName: { color: t.freqColor, fontFamily: F, fontSize: 17, fontWeight: 'bold', flexShrink: 1 },
    vtsRt: { color: t.unitColor, fontFamily: F, fontSize: 12, marginTop: 1 },
    afRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
    afChip: { backgroundColor: t.btnBg, borderWidth: 1, borderColor: t.btnBorder, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7 },
    afChipTxt: { color: t.btnActiveText, fontFamily: F, fontSize: 15, fontWeight: 'bold' },
  });
}
