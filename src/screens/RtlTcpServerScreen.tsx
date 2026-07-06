import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet, Alert,
  PermissionsAndroid, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { themeFor } from '../constants/theme';
import {
  startRtlTcpServer, stopRtlTcpServer, setServerSampleRate, getServerStatus,
  getServerName, saveServerName, BANDWIDTH_OPTIONS, type ServerInfo, type ServerStatus,
} from '../services/rtlTcpServer';
import { advertiseRtlTcp, stopAdvertiseRtlTcp } from '../services/mdns';

type Props = NativeStackScreenProps<RootStackParamList, 'RtlTcpServer'>;

// The RTL-TCP server control screen. Owns the full lifecycle: starts the server
// + mDNS advert on mount, tears both down on unmount (so leaving = back to the
// instance list, dongle freed for on-device use).
export default function RtlTcpServerScreen({ navigation, route }: Props) {
  const { colors: C, font: F } = themeFor();
  const [name, setName]       = useState(route.params?.name ?? 'VibeSDR RTL-SDR');
  const [info, setInfo]       = useState<ServerInfo | null>(null);
  const [status, setStatus]   = useState<ServerStatus | null>(null);
  const [override, setOverride] = useState(0);
  const [starting, setStarting] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const startedRef = useRef(false);

  // Start the server (once) + advertise.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      const initialName = await getServerName(route.params?.name ?? 'VibeSDR RTL-SDR');
      if (cancelled) return;
      setName(initialName);
      // Android 13+: the FGS notification is suppressed without POST_NOTIFICATIONS.
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        try { await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS); } catch {}
      }
      if (cancelled) return;
      try {
        const res = await startRtlTcpServer({ name: initialName });
        if (cancelled) return;
        setInfo(res);
        setStarting(false);
        advertiseRtlTcp(res.name, res.port);
      } catch (e: any) {
        if (cancelled) return;
        setStarting(false);
        setError(e?.message ?? 'Could not start the server. Is an RTL-SDR plugged in via USB OTG?');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Teardown on unmount (any way of leaving the screen).
  useEffect(() => () => {
    stopAdvertiseRtlTcp();
    stopRtlTcpServer();
  }, []);

  // Poll status for the live readout (client connected / actual bandwidth).
  useEffect(() => {
    if (starting || error) return;
    const t = setInterval(async () => {
      const s = await getServerStatus();
      if (s) setStatus(s);
    }, 2000);
    return () => clearInterval(t);
  }, [starting, error]);

  const applyOverride = useCallback((value: number) => {
    setOverride(value);
    setServerSampleRate(value);
  }, []);

  const commitName = useCallback(() => {
    const n = name.trim() || 'VibeSDR RTL-SDR';
    setName(n);
    saveServerName(n);
    if (info) advertiseRtlTcp(n, info.port);
  }, [name, info]);

  const stopAndBack = useCallback(() => {
    stopAdvertiseRtlTcp();
    stopRtlTcpServer();
    navigation.goBack();
  }, [navigation]);

  const clientLine = status?.client
    ? (status.clientAddr ? `Connected: ${status.clientAddr}` : 'Client connected')
    : 'Waiting for a client to connect…';
  const bwActual = status?.sampleRate
    ? `${(status.sampleRate / 1e6).toFixed(3).replace(/\.?0+$/, '')} MHz`
    : '—';

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: C.bg }]}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 40 }}>
        <Text style={[styles.h1, { color: C.amber, fontFamily: F }]}>RTL-TCP Server</Text>
        <Text style={[styles.sub, { color: C.textDim, fontFamily: F }]}>
          Sharing this phone's RTL-SDR over your network. Leaving this screen stops the
          server and frees the dongle for use on this device.
        </Text>

        {starting && (
          <View style={styles.center}>
            <ActivityIndicator color={C.amber} />
            <Text style={{ color: C.textDim, fontFamily: F, marginTop: 10 }}>Starting server…</Text>
          </View>
        )}

        {error && (
          <View style={[styles.card, { borderColor: C.red }]}>
            <Text style={{ color: C.red, fontFamily: F, fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {info && !error && (
          <>
            {/* Live status */}
            <View style={[styles.card, { borderColor: C.borderBright }]}>
              <View style={styles.rowBetween}>
                <Text style={[styles.label, { color: C.textDim, fontFamily: F }]}>ADDRESS</Text>
                <Text style={[styles.value, { color: C.amber, fontFamily: F }]}>{info.ip}:{info.port}</Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={[styles.label, { color: C.textDim, fontFamily: F }]}>BANDWIDTH</Text>
                <Text style={[styles.value, { color: C.amber, fontFamily: F }]}>
                  {bwActual}{override > 0 ? ' (capped)' : ''}
                </Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={[styles.label, { color: C.textDim, fontFamily: F }]}>STATUS</Text>
                <Text style={[styles.value, { color: status?.client ? C.green : C.goldDim, fontFamily: F }]}>
                  {clientLine}
                </Text>
              </View>
            </View>

            {/* Advertised name */}
            <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>ADVERTISED NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              onBlur={commitName}
              onSubmitEditing={commitName}
              placeholder="VibeSDR RTL-SDR"
              placeholderTextColor={C.goldDim}
              style={[styles.input, { color: C.amber, borderColor: C.border, fontFamily: F }]}
            />
            <Text style={[styles.hint, { color: C.textDim, fontFamily: F }]}>
              Shown to clients discovering this server on the network.
            </Text>

            {/* Bandwidth override */}
            <Text style={[styles.section, { color: C.textDim, fontFamily: F }]}>BANDWIDTH OVERRIDE</Text>
            <Text style={[styles.hint, { color: C.textDim, fontFamily: F, marginBottom: 8 }]}>
              Default lets the client choose. Force a lower rate here if the connection struggles.
            </Text>
            {BANDWIDTH_OPTIONS.map(opt => {
              const active = override === opt.value;
              return (
                <TouchableOpacity key={opt.value}
                  style={[styles.optRow, { borderColor: active ? C.amber : C.border }]}
                  onPress={() => applyOverride(opt.value)}>
                  <Text style={{ color: active ? C.amber : C.gold, fontFamily: F, fontSize: 15 }}>
                    {opt.label}
                  </Text>
                  {active && <Text style={{ color: C.amber, fontFamily: F }}>✓</Text>}
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* Stop + back */}
        <TouchableOpacity style={[styles.stopBtn, { borderColor: C.red }]} onPress={stopAndBack}>
          <Text style={{ color: C.red, fontFamily: F, fontSize: 16 }}>
            {error ? '‹ Back to instances' : '■ Stop server & back to instances'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  h1: { fontSize: 24, marginBottom: 6 },
  sub: { fontSize: 13, lineHeight: 18, marginBottom: 16 },
  center: { alignItems: 'center', paddingVertical: 40 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16, gap: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 11, letterSpacing: 1 },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right', marginLeft: 8 },
  section: { fontSize: 11, letterSpacing: 1, marginTop: 4, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  hint: { fontSize: 11.5, lineHeight: 16, marginTop: 6 },
  optRow: {
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  stopBtn: {
    borderWidth: 1, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20,
  },
});
