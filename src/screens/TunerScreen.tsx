import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { v4 as uuidv4 } from 'uuid';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { createBackend } from '../services/UberSDRAdapter';
import type { SDRBackend, FmdxState } from '../services/SDRBackend';
import { lookupStationLogo } from '../services/stationLogo';

// FM-DX Webserver tuner screen (v7). A single shared hardware tuner: server-side
// demod + RDS, MP3 audio decoded natively. No waterfall. First build = tiers 1–2
// (RDS block + station logo + audio); spectrum / vintage dial come later.

type Props = NativeStackScreenProps<RootStackParamList, 'Tuner'>;

const AMBER = '#ffb833';
const BG = '#0A0A12';
const PANEL = '#14141f';
const DIM = '#8a8a72';

const PTY = [
  'None', 'News', 'Current Affairs', 'Information', 'Sport', 'Education', 'Drama',
  'Culture', 'Science', 'Varied', 'Pop Music', 'Rock Music', 'Easy Listening',
  'Light Classical', 'Serious Classical', 'Other Music', 'Weather', 'Finance',
  'Children', 'Social Affairs', 'Religion', 'Phone In', 'Travel', 'Leisure',
  'Jazz Music', 'Country Music', 'National Music', 'Oldies Music', 'Folk Music',
  'Documentary', 'Alarm Test', 'Alarm',
];

const FM_LO = 87_500_000, FM_HI = 108_000_000;

export default function TunerScreen({ route, navigation }: Props) {
  const { baseUrl, instanceName } = route.params;
  const backendRef = useRef<SDRBackend | null>(null);
  const destroyed = useRef(false);

  const [st, setSt] = useState<FmdxState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const lastLogoName = useRef<string>('');

  // ── Connect / teardown ──────────────────────────────────────────────────────
  useEffect(() => {
    destroyed.current = false;
    const uuid = uuidv4();
    const backend = createBackend('fmdx', baseUrl, uuid, {
      onSpectrum: () => {},
      onStatus:   () => {},
      onError:    (m) => { if (!destroyed.current) setError(m); },
      onConnect:  () => { if (!destroyed.current) { setConnected(true); setError(null); } },
      onDisconnect: () => { if (!destroyed.current) setConnected(false); },
      onServerLost: () => { if (!destroyed.current) setError('Server stopped responding'); },
      onFmdxState: (s) => { if (!destroyed.current) setSt(s); },
    });
    backendRef.current = backend;
    backend.connect().catch((e) => { if (!destroyed.current) setError(String(e?.message ?? e)); });

    return () => {
      destroyed.current = true;
      backendRef.current?.destroy();
      backendRef.current = null;
    };
  }, [baseUrl]);

  // ── Station logo (radio-browser favicon; monogram fallback) ─────────────────
  useEffect(() => {
    const name = st?.ps?.trim() ?? '';
    if (!name || name === lastLogoName.current) return;
    lastLogoName.current = name;
    setLogo(null);
    lookupStationLogo(name).then((url) => {
      if (!destroyed.current && lastLogoName.current === name) setLogo(url);
    });
  }, [st?.ps]);

  // ── Tuning (shared tuner — retunes for everyone) ────────────────────────────
  const tuneBy = useCallback((deltaHz: number) => {
    const cur = st?.freqHz ?? FM_LO;
    const next = Math.min(FM_HI, Math.max(FM_LO, Math.round((cur + deltaHz) / 10_000) * 10_000));
    backendRef.current?.tune(next);
  }, [st?.freqHz]);

  const freqMhz = st ? (st.freqHz / 1e6).toFixed(3) : '––.–––';
  const ps = st?.ps?.trim() || (connected ? '' : 'Connecting…');
  const monogram = (st?.ps?.trim() || '?').slice(0, 3).toUpperCase();

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backTxt}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>{instanceName ?? 'FM-DX'}</Text>
        <Text style={styles.users}>{st ? `${st.users}👤` : ''}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
        {error && <Text style={styles.err}>{error}</Text>}

        {/* Frequency + tuning */}
        <View style={styles.panel}>
          <Text style={styles.freq}>{freqMhz}<Text style={styles.freqUnit}> MHz</Text></Text>
          <View style={styles.tuneRow}>
            {[[-1_000_000, '−1'], [-100_000, '−0.1'], [-10_000, '−.01'],
              [10_000, '+.01'], [100_000, '+0.1'], [1_000_000, '+1']].map(([d, lbl]) => (
              <TouchableOpacity key={lbl as string} style={styles.tuneBtn} onPress={() => tuneBy(d as number)}>
                <Text style={styles.tuneBtnTxt}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Logo + station name + pills */}
        <View style={[styles.panel, styles.stationRow]}>
          <View style={styles.logoBox}>
            {logo
              ? <Image source={{ uri: logo }} style={styles.logo} resizeMode="contain" />
              : <Text style={styles.monogram}>{monogram}</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.station} numberOfLines={1}>{ps}</Text>
            <View style={styles.pills}>
              {st?.stereo && <Pill label="STEREO" on />}
              {st?.rds && <Pill label="RDS" on />}
              {st?.tp && <Pill label="TP" on />}
              {st?.ta && <Pill label="TA" on />}
              {!!st && <Pill label={PTY[st.pty] ?? 'None'} />}
            </View>
          </View>
        </View>

        {/* Signal + PI */}
        <View style={styles.metaRow}>
          <View style={[styles.panel, styles.metaCell]}>
            <Text style={styles.metaLabel}>SIGNAL</Text>
            <Text style={styles.metaVal}>{st ? st.sig.toFixed(1) : '––'}<Text style={styles.metaUnit}> dBf</Text></Text>
            <View style={styles.sigBarBg}>
              <View style={[styles.sigBarFill, { width: `${Math.min(100, Math.max(0, ((st?.sig ?? 0) / 70) * 100))}%` }]} />
            </View>
          </View>
          <View style={[styles.panel, styles.metaCell]}>
            <Text style={styles.metaLabel}>PI CODE</Text>
            <Text style={styles.metaVal}>{st?.pi || '––––'}</Text>
          </View>
        </View>

        {/* RadioText */}
        <View style={styles.panel}>
          <Text style={styles.metaLabel}>RADIOTEXT</Text>
          <Text style={styles.rt}>{st?.rt || '—'}</Text>
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

        {/* Alternative frequencies */}
        {!!st?.af?.length && (
          <View style={styles.panel}>
            <Text style={styles.metaLabel}>AF</Text>
            <Text style={styles.af}>{st.af.map((h) => (h / 1e6).toFixed(1)).join('  ')}</Text>
          </View>
        )}

        {!connected && !error && (
          <View style={{ alignItems: 'center', padding: 20 }}><ActivityIndicator color={AMBER} /></View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Pill({ label, on }: { label: string; on?: boolean }) {
  return (
    <View style={[styles.pill, on && styles.pillOn]}>
      <Text style={[styles.pillTxt, on && styles.pillTxtOn]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  back: { paddingVertical: 4, paddingRight: 8 },
  backTxt: { color: AMBER, fontFamily: 'Courier', fontSize: 15 },
  title: { flex: 1, color: '#EEE', fontFamily: 'Courier', fontSize: 15, fontWeight: 'bold' },
  users: { color: DIM, fontFamily: 'Courier', fontSize: 12 },
  err: { color: '#E66', fontFamily: 'Courier', fontSize: 13, textAlign: 'center' },
  panel: { backgroundColor: PANEL, borderRadius: 12, padding: 14 },
  freq: { color: '#FFF', fontFamily: 'Courier', fontSize: 48, fontWeight: 'bold', textAlign: 'center' },
  freqUnit: { fontSize: 18, color: DIM, fontWeight: 'normal' },
  tuneRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, gap: 6 },
  tuneBtn: { flex: 1, backgroundColor: '#22222e', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  tuneBtnTxt: { color: AMBER, fontFamily: 'Courier', fontSize: 13, fontWeight: 'bold' },
  stationRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  logoBox: { width: 72, height: 72, borderRadius: 10, backgroundColor: '#0c0c14', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logo: { width: 68, height: 68 },
  monogram: { color: AMBER, fontFamily: 'Courier', fontSize: 24, fontWeight: 'bold' },
  station: { color: '#FFF', fontFamily: 'Courier', fontSize: 22, fontWeight: 'bold' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  pill: { borderColor: DIM, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  pillOn: { backgroundColor: AMBER, borderColor: AMBER },
  pillTxt: { color: DIM, fontFamily: 'Courier', fontSize: 10, fontWeight: 'bold' },
  pillTxtOn: { color: '#111' },
  metaRow: { flexDirection: 'row', gap: 12 },
  metaCell: { flex: 1 },
  metaLabel: { color: AMBER, fontFamily: 'Courier', fontSize: 11, fontWeight: 'bold', marginBottom: 4 },
  metaVal: { color: '#FFF', fontFamily: 'Courier', fontSize: 26, fontWeight: 'bold' },
  metaUnit: { fontSize: 14, color: DIM, fontWeight: 'normal' },
  sigBarBg: { height: 6, backgroundColor: '#0c0c14', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  sigBarFill: { height: 6, backgroundColor: AMBER },
  rt: { color: '#DDD', fontFamily: 'Courier', fontSize: 15, marginTop: 4 },
  txName: { color: '#FFF', fontFamily: 'Courier', fontSize: 15, fontWeight: 'bold', marginTop: 2 },
  txMeta: { color: DIM, fontFamily: 'Courier', fontSize: 12, marginTop: 3 },
  af: { color: '#DDD', fontFamily: 'Courier', fontSize: 15, marginTop: 4, letterSpacing: 1 },
});
