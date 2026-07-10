import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet, Platform, PermissionsAndroid, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { themeFor } from '../constants/theme';
import { getServerName, saveServerName } from '../services/rtlTcpServer';
import {
  startVibeServer, stopVibeServer, getVibeServerStatus, setVibeServerCompressAudio,
  vibeServerSupported, randomPin, fmtRate, FPS_TIERS, fpsForTier,
  type FpsTier, type VibeServerInfo, type VibeServerStatus,
} from '../services/vibeServer';
import { advertiseServer, stopAdvertiseRtlTcp } from '../services/mdns';

type Props = NativeStackScreenProps<RootStackParamList, 'ServerMode'>;

// Server-mode picker + VibeServer control screen.
//   • VibeServer (default) — server-side DSP, compressed audio + waterfall,
//     ~25x lighter than raw IQ, HMAC PIN. Handled inline here.
//   • RTL-TCP — raw IQ, maximum compatibility. Delegates to RtlTcpServerScreen.
// The auto-discovery (mDNS) toggle and the advertised name are shared by both.

type Proto = 'vibeserver' | 'rtltcp';
type PinMode = 'random' | 'custom' | 'off';

const RATE_OPTIONS = [
  { label: 'Full · 2.4 MHz',  value: 2_400_000 },
  { label: '1.2 MHz',         value: 1_200_000 },
  { label: '960 kHz (light)', value: 960_000 },
];

const K = {
  proto: 'vs_proto', advertise: 'vs_advertise', pinMode: 'vs_pinmode',
  pin: 'vs_pin', rate: 'vs_rate', fps: 'vs_fps', compress: 'vs_compress',
};

export default function ServerModeScreen({ navigation, route }: Props) {
  const { colors: C, font: F } = themeFor();

  const [proto, setProto]         = useState<Proto>('vibeserver');
  const [name, setName]           = useState(route.params?.name ?? 'VibeSDR');
  const [advertise, setAdvertise] = useState(true);
  const [pinMode, setPinMode]     = useState<PinMode>('random');
  const [pin, setPin]             = useState(() => randomPin(Date.now()));
  const [rate, setRate]           = useState(2_400_000);
  const [fps, setFps]             = useState<FpsTier>('full');
  const [compress, setCompress]   = useState(true);

  const [running, setRunning] = useState<VibeServerInfo | null>(null);
  const [status, setStatus]   = useState<VibeServerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const runningRef = useRef(false);

  // Load saved preferences + name.
  useEffect(() => {
    (async () => {
      const n = await getServerName(route.params?.name ?? 'VibeSDR');
      setName(n);
      try {
        const [p, a, pm, sp, r, fp, cp] = await Promise.all([
          AsyncStorage.getItem(K.proto), AsyncStorage.getItem(K.advertise),
          AsyncStorage.getItem(K.pinMode), AsyncStorage.getItem(K.pin),
          AsyncStorage.getItem(K.rate), AsyncStorage.getItem(K.fps),
          AsyncStorage.getItem(K.compress),
        ]);
        if (p === 'rtltcp' || p === 'vibeserver') setProto(p);
        if (a != null) setAdvertise(a !== '0');
        if (pm === 'random' || pm === 'custom' || pm === 'off') setPinMode(pm);
        // Restore the saved PIN for BOTH modes so re-opening the server keeps the
        // same code — it only changes when the user taps refresh (↻) or edits it.
        if (sp) setPin(sp);
        else AsyncStorage.setItem(K.pin, pin);   // first run: persist the generated default
        if (r) setRate(Number(r) || 2_400_000);
        if (fp === 'full' || fp === 'half' || fp === 'quarter') setFps(fp);
        if (cp != null) setCompress(cp !== '0');
      } catch {}
    })();
  }, []);

  // Stop the server when leaving unless it's running (VibeServer is ad-hoc: a
  // single remote client, so we tear down on exit to free the dongle).
  useEffect(() => () => {
    if (runningRef.current) { stopAdvertiseRtlTcp(); stopVibeServer(); }
  }, []);

  // Poll live status once serving.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const s = await getVibeServerStatus();
      if (s) setStatus(s);
    }, 1500);
    return () => clearInterval(t);
  }, [running]);

  const effectivePin = pinMode === 'off' ? '' : pin;

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    const n = name.trim() || 'VibeSDR';
    saveServerName(n);
    await AsyncStorage.multiSet([
      [K.proto, proto], [K.advertise, advertise ? '1' : '0'],
      [K.pinMode, pinMode], [K.pin, pin], [K.rate, String(rate)],
      [K.fps, fps], [K.compress, compress ? '1' : '0'],
    ]);
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      try { await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS); } catch {}
    }
    try {
      const info = await startVibeServer({
        name: n,
        sampleRate: rate,
        pin: effectivePin,
        maxFftRate: fpsForTier(fps),
        compressAudio: compress,
      });
      setRunning(info);
      runningRef.current = true;
      setStarting(false);
      if (advertise) advertiseServer(n, info.port, 'vibeserver', effectivePin !== '');
    } catch (e: any) {
      setStarting(false);
      setError(e?.message ?? 'Could not start VibeServer. Is an RTL-SDR plugged in via USB OTG?');
    }
  }, [name, proto, advertise, pinMode, pin, rate, fps, compress, effectivePin]);

  const stopAndBack = useCallback(() => {
    stopAdvertiseRtlTcp();
    stopVibeServer();
    runningRef.current = false;
    navigation.goBack();
  }, [navigation]);

  const toggleCompress = useCallback((on: boolean) => {
    setCompress(on);
    if (runningRef.current) setVibeServerCompressAudio(on);   // live toggle
  }, []);

  const regenPin = useCallback(() => {
    const p = randomPin(Date.now());
    setPin(p);
    AsyncStorage.setItem(K.pin, p);   // persist immediately so it survives re-open
  }, []);

  if (Platform.OS !== 'android' || !vibeServerSupported) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: C.bg }]}>
        <ScrollView contentContainerStyle={{ padding: 18 }}>
          <Text style={[styles.h1, { color: C.amber, fontFamily: F }]}>Server mode</Text>
          <Text style={[styles.sub, { color: C.textDim, fontFamily: F }]}>
            Sharing a local USB dongle is only available on Android.
          </Text>
          <TouchableOpacity style={[styles.stopBtn, { borderColor: C.border }]} onPress={() => navigation.goBack()}>
            <Text style={{ color: C.gold, fontFamily: F, fontSize: 16 }}>‹ Back</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Running view (live telemetry) ─────────────────────────────────────────
  if (running) {
    const spec = status?.specBytesPerSec ?? 0;
    const aud = status?.audioBytesPerSec ?? 0;
    const client = status?.client;
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: C.bg }]}>
        <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>
          <Text style={[styles.h1, { color: C.amber, fontFamily: F }]}>VibeServer</Text>
          <Text style={[styles.sub, { color: C.textDim, fontFamily: F }]}>
            Serving this phone's RTL-SDR with server-side DSP. Leaving this screen
            stops the server and frees the dongle.
          </Text>

          <View style={[styles.card, { borderColor: C.borderBright }]}>
            <Row C={C} F={F} k="ADDRESS" v={`${running.ip}:${running.port}`} vc={C.amber} />
            <Row C={C} F={F} k="ACCESS" v={effectivePin ? `PIN ${effectivePin}` : 'Open (no PIN)'} vc={effectivePin ? C.green : C.amber} />
            <Row C={C} F={F} k="STATUS"
              v={client ? (status?.clientAddr ? `Connected: ${status.clientAddr}` : 'Client connected') : 'Waiting for a client…'}
              vc={client ? C.green : C.goldDim} />
            <Row C={C} F={F} k="WATERFALL" v={`${fmtRate(spec)}`} vc={client ? C.amber : C.goldDim} />
            <Row C={C} F={F} k="AUDIO" v={`${fmtRate(aud)}${status?.compressed ? '' : ' (raw)'}`} vc={client ? C.amber : C.goldDim} />
          </View>

          <Text style={[styles.hint, { color: C.textDim, fontFamily: F }]}>
            The PIN protects tuning control — it is not audio encryption. Use a VPN
            for privacy on untrusted networks.
          </Text>

          {/* Live compressed-audio fallback toggle */}
          <View style={[styles.card, { borderColor: C.border, marginTop: 14 }]}>
            <View style={styles.rowBetween}>
              <Text style={[styles.value, { color: C.amber, fontFamily: F, flex: 1, paddingRight: 12 }]}>
                Compressed audio
              </Text>
              <Switch value={compress} onValueChange={toggleCompress}
                trackColor={{ false: C.border, true: C.green }} thumbColor={C.amber} />
            </View>
            <Text style={[styles.hint, { color: C.textDim, fontFamily: F, marginTop: 8 }]}>
              Turn off only if a client has audio trouble (falls back to raw PCM).
            </Text>
          </View>

          <TouchableOpacity style={[styles.stopBtn, { borderColor: C.red }]} onPress={stopAndBack}>
            <Text style={{ color: C.red, fontFamily: F, fontSize: 16 }}>■ Stop server & back to instances</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Config view ───────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>
        <Text style={[styles.h1, { color: C.amber, fontFamily: F }]}>Server mode</Text>
        <Text style={[styles.sub, { color: C.textDim, fontFamily: F }]}>
          Share this phone's RTL-SDR over your network.
        </Text>

        {/* Protocol picker */}
        <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>PROTOCOL</Text>
        <ProtoCard C={C} F={F} active={proto === 'vibeserver'} onPress={() => setProto('vibeserver')}
          title="VibeServer" tag="Recommended"
          desc="More secure, less data. Server-side DSP, compressed audio + waterfall, PIN protected." />
        <ProtoCard C={C} F={F} active={proto === 'rtltcp'} onPress={() => setProto('rtltcp')}
          title="RTL-TCP" tag="Compatible"
          desc="Raw IQ, maximum compatibility. Needs a fast, stable network. No PIN." />

        {/* Shared: advertised name */}
        <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>ADVERTISED NAME</Text>
        <TextInput value={name} onChangeText={setName}
          placeholder="VibeSDR" placeholderTextColor={C.goldDim}
          style={[styles.input, { color: C.amber, borderColor: C.border, fontFamily: F }]} />

        {/* Shared: auto-discovery */}
        <View style={[styles.card, { borderColor: C.border, marginTop: 14 }]}>
          <View style={styles.rowBetween}>
            <Text style={[styles.value, { color: C.amber, fontFamily: F, flex: 1, paddingRight: 12 }]}>
              Server auto-discovery
            </Text>
            <Switch value={advertise} onValueChange={setAdvertise}
              trackColor={{ false: C.border, true: C.green }} thumbColor={C.amber} />
          </View>
          <Text style={[styles.hint, { color: C.textDim, fontFamily: F, marginTop: 8 }]}>
            {advertise
              ? 'This server appears automatically on other VibeSDR devices on the network.'
              : "Hidden — clients must enter this phone's address by hand. Good on a public hotspot" +
                (proto === 'rtltcp' ? ' (RTL-TCP has no PIN).' : '.')}
          </Text>
        </View>

        {proto === 'vibeserver' ? (
          <>
            {/* PIN */}
            <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>PIN</Text>
            <View style={styles.pillRow}>
              {(['random', 'custom', 'off'] as PinMode[]).map(m => (
                <Pill key={m} C={C} F={F} active={pinMode === m}
                  label={m === 'random' ? 'Random' : m === 'custom' ? 'Custom' : 'No PIN'}
                  onPress={() => setPinMode(m)} />
              ))}
            </View>
            {pinMode !== 'off' && (
              <View style={styles.rowBetween}>
                <TextInput value={pin}
                  onChangeText={t => { setPin(t.replace(/[^0-9]/g, '').slice(0, 12)); if (pinMode === 'random') setPinMode('custom'); }}
                  editable={pinMode === 'custom'}
                  keyboardType="number-pad"
                  style={[styles.input, { flex: 1, color: C.amber, borderColor: C.border, fontFamily: F }]} />
                {pinMode === 'random' && (
                  <TouchableOpacity onPress={regenPin} style={[styles.regen, { borderColor: C.border }]}>
                    <Text style={{ color: C.gold, fontFamily: F, fontSize: 18 }}>↻</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
            <Text style={[styles.hint, { color: C.textDim, fontFamily: F }]}>
              {pinMode === 'off'
                ? 'Anyone on the network can connect and tune. Use only on a trusted LAN.'
                : 'Clients enter this PIN once. It authenticates control without ever crossing the wire (HMAC challenge-response).'}
            </Text>

            {/* Bandwidth (sample rate) */}
            <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>BANDWIDTH</Text>
            <Text style={[styles.hint, { color: C.textDim, fontFamily: F, marginBottom: 8 }]}>
              Lower the span to save processing power on a low-end phone.
            </Text>
            {RATE_OPTIONS.map(o => (
              <OptRow key={o.value} C={C} F={F} active={rate === o.value} label={o.label} onPress={() => setRate(o.value)} />
            ))}

            {/* Waterfall frame rate */}
            <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>WATERFALL RATE</Text>
            {FPS_TIERS.map(t => (
              <OptRow key={t.key} C={C} F={F} active={fps === t.key} label={t.label} onPress={() => setFps(t.key)} />
            ))}

            {/* Compressed audio */}
            <View style={[styles.card, { borderColor: C.border, marginTop: 14 }]}>
              <View style={styles.rowBetween}>
                <Text style={[styles.value, { color: C.amber, fontFamily: F, flex: 1, paddingRight: 12 }]}>
                  Compressed audio
                </Text>
                <Switch value={compress} onValueChange={setCompress}
                  trackColor={{ false: C.border, true: C.green }} thumbColor={C.amber} />
              </View>
              <Text style={[styles.hint, { color: C.textDim, fontFamily: F, marginTop: 8 }]}>
                IMA-ADPCM (~4x lighter). Turn off for maximum compatibility.
              </Text>
            </View>

            {error && (
              <View style={[styles.card, { borderColor: C.red, marginTop: 14 }]}>
                <Text style={{ color: C.red, fontFamily: F, fontSize: 14 }}>{error}</Text>
              </View>
            )}

            <TouchableOpacity style={[styles.startBtn, { borderColor: C.green, backgroundColor: C.green + '18' }]}
              onPress={start} disabled={starting}>
              {starting
                ? <ActivityIndicator color={C.green} />
                : <Text style={{ color: C.green, fontFamily: F, fontSize: 16 }}>▶ Start VibeServer</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity style={[styles.startBtn, { borderColor: C.amber, backgroundColor: C.amber + '18' }]}
            onPress={() => navigation.replace('RtlTcpServer', { name: name.trim() || 'VibeSDR RTL-SDR', advertise })}>
            <Text style={{ color: C.amber, fontFamily: F, fontSize: 16 }}>▶ Start RTL-TCP server</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.stopBtn, { borderColor: C.border }]} onPress={() => navigation.goBack()}>
          <Text style={{ color: C.gold, fontFamily: F, fontSize: 15 }}>‹ Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ C, F, k, v, vc }: any) {
  return (
    <View style={styles.rowBetween}>
      <Text style={[styles.label, { color: C.textDim, fontFamily: F }]}>{k}</Text>
      <Text style={[styles.value, { color: vc, fontFamily: F }]}>{v}</Text>
    </View>
  );
}

function ProtoCard({ C, F, active, onPress, title, tag, desc }: any) {
  return (
    <TouchableOpacity onPress={onPress}
      style={[styles.protoCard, { borderColor: active ? C.amber : C.border, backgroundColor: active ? C.amber + '14' : 'transparent' }]}>
      <View style={styles.rowBetween}>
        <Text style={{ color: active ? C.amber : C.gold, fontFamily: F, fontSize: 17 }}>{title}</Text>
        <Text style={{ color: active ? C.amber : C.goldDim, fontFamily: F, fontSize: 11 }}>{tag}</Text>
      </View>
      <Text style={{ color: C.textDim, fontFamily: F, fontSize: 12, lineHeight: 16, marginTop: 6 }}>{desc}</Text>
    </TouchableOpacity>
  );
}

function Pill({ C, F, active, label, onPress }: any) {
  return (
    <TouchableOpacity onPress={onPress}
      style={[styles.pill, { borderColor: active ? C.amber : C.border, backgroundColor: active ? C.amber + '22' : 'transparent' }]}>
      <Text style={{ color: active ? C.amber : C.gold, fontFamily: F, fontSize: 14 }}>{label}</Text>
    </TouchableOpacity>
  );
}

function OptRow({ C, F, active, label, onPress }: any) {
  return (
    <TouchableOpacity style={[styles.optRow, { borderColor: active ? C.amber : C.border }]} onPress={onPress}>
      <Text style={{ color: active ? C.amber : C.gold, fontFamily: F, fontSize: 15 }}>{label}</Text>
      {active && <Text style={{ color: C.amber, fontFamily: F }}>✓</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  h1: { fontSize: 24, marginBottom: 6 },
  sub: { fontSize: 13, lineHeight: 18, marginBottom: 16 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 8, gap: 10 },
  protoCard: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 11, letterSpacing: 1 },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right', marginLeft: 8 },
  section: { fontSize: 11, letterSpacing: 1, marginTop: 16, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  regen: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginLeft: 8 },
  hint: { fontSize: 11.5, lineHeight: 16, marginTop: 6 },
  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  pill: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  optRow: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  startBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 20 },
  stopBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
});
