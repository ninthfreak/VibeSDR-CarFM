import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { themeFor } from '../constants/theme';
import {
  SDRInstance,
  fetchInstances,
  getUserLocation,
  isVersionOld,
  MIN_RECOMMENDED_VERSION,
} from '../services/instancesApi';
import { checkConnection } from '../services/ubersdrProtocol';
import {
  DefaultInstance,
  clearDefaultInstance,
  getDefaultInstance,
  setDefaultInstance,
} from '../services/defaultInstance';
import { ViewMode, clearViewMode, getViewMode } from '../services/viewMode';
import PasswordModal from '../components/PasswordModal';

type SortMode = 'nearest' | 'snr';
type Props = NativeStackScreenProps<RootStackParamList, 'InstancePicker'>;

export default function InstancePickerScreen({ navigation }: Props) {
  const [instances,   setInstances]     = useState<SDRInstance[]>([]);
  const [loading,     setLoading]       = useState(true);
  const [error,       setError]         = useState<string | null>(null);
  const [customUrl,   setCustomUrl]     = useState('');
  const [connecting,  setConnecting]    = useState(false);
  const [filter,      setFilter]        = useState('');
  const [defaultInst, setDefaultInst]   = useState<DefaultInstance | null>(null);
  const [viewMode,    setViewModeState] = useState<ViewMode>('default');
  const [modeReady,   setModeReady]     = useState(false);
  const [sortMode,    setSortMode]      = useState<SortMode>('nearest');
  const [pwModal,     setPwModal]       = useState<{ url: string; name: string } | null>(null);
  const userLocRef = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const mode = await getViewMode();
      if (cancelled) return;
      if (!mode) { navigation.replace('ViewPicker'); return; }
      setViewModeState(mode);
      setModeReady(true);

      const d = await getDefaultInstance();
      if (!cancelled && d) {
        setDefaultInst(d);
        navigation.navigate('SDR', { baseUrl: d.url, instanceName: d.name, viewMode: mode });
      }
    }

    async function load() {
      try {
        // Try to get user location to enable distance + sort
        const loc = await getUserLocation();
        if (!cancelled) userLocRef.current = loc;

        const list = await fetchInstances(loc?.lat, loc?.lon);
        if (!cancelled) setInstances(list);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load instances');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    load();
    return () => { cancelled = true; };
  }, []);

  // Re-read viewMode each time the screen comes into focus so that a skin
  // change made inside an active instance is picked up for the next connection.
  useFocusEffect(useCallback(() => {
    getViewMode().then(mode => { if (mode) setViewModeState(mode); });
  }, []));

  const { colors: C, font: F, scale } = themeFor(viewMode);

  // Normalised custom URL for default-checking
  const normalisedCustomUrl = useMemo(() => {
    let u = customUrl.trim().replace(/\/+$/, '');
    if (u && !u.startsWith('http://') && !u.startsWith('https://')) u = 'http://' + u;
    return u;
  }, [customUrl]);
  const fs = (base: number) => Math.round(base * scale);

  const connect = useCallback(async (url: string, name: string, password?: string) => {
    if (!url) return;
    const cleaned = url.trim().replace(/\/$/, '');
    setConnecting(true);
    try {
      const result = await checkConnection(cleaned, password);
      if (result.passwordRequired && !password) {
        setConnecting(false);
        setPwModal({ url: cleaned, name });
        return;
      }
      if (!result.allowed) {
        setConnecting(false);
        Alert.alert('Connection Refused', result.reason ?? 'Server refused connection');
        return;
      }
      setConnecting(false);
      navigation.navigate('SDR', { baseUrl: cleaned, instanceName: name, password, viewMode });
    } catch (e: any) {
      setConnecting(false);
      Alert.alert('Connection Error', e.message ?? 'Could not reach server');
    }
  }, [navigation, viewMode]);

  const connectCustom = useCallback(() => {
    if (!customUrl.trim()) return;
    let url = customUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
    connect(url, url);
  }, [customUrl, connect]);

  const handleSetDefault = useCallback((inst: DefaultInstance) => {
    Alert.alert('Set Default', `Auto-connect to "${inst.name}" on startup?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Set Default', onPress: async () => { await setDefaultInstance(inst); setDefaultInst(inst); } },
    ]);
  }, []);

  const handleClearDefault = useCallback(() => {
    Alert.alert('Remove Default', 'Stop auto-connecting on startup?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => { await clearDefaultInstance(); setDefaultInst(null); } },
    ]);
  }, []);

  const handleResetSettings = useCallback(() => {
    Alert.alert(
      'Reset App Settings',
      'Clears your display mode choice and returns to the setup screen. Your default instance is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: async () => { await clearViewMode(); navigation.replace('ViewPicker'); } },
      ],
    );
  }, [navigation]);

  // Filter by name, location AND callsign
  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    const list = !q ? instances : instances.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.location ?? '').toLowerCase().includes(q) ||
      (i.callsign ?? '').toLowerCase().includes(q),
    );

    if (sortMode === 'snr') {
      return [...list].sort((a, b) => {
        const sa = a.bestSnr ?? -Infinity;
        const sb = b.bestSnr ?? -Infinity;
        return sb - sa;
      });
    }
    // 'nearest' — preserve API order which is already sorted by distance
    // (server uses IP geolocation; if we passed GPS coords the distances
    //  are more precise but the relative order is still from the API)
    return list;
  }, [instances, filter, sortMode]);

  if (!modeReady) return <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A12' }} />;

  const renderItem = ({ item }: { item: SDRInstance }) => {
    const isDefault = defaultInst?.url === item.url;
    const versionOld = isVersionOld(item.version);

    return (
      <TouchableOpacity
        style={[
          styles.row,
          { borderColor: C.border },
          isDefault && { borderColor: C.borderBright, backgroundColor: 'rgba(255,160,0,0.08)' },
        ]}
        onPress={() => connect(item.url, item.name)}
        disabled={connecting}
      >
        <View style={styles.rowMain}>
          {/* Name row */}
          <View style={styles.nameRow}>
            <Text style={{ fontFamily: F, fontSize: fs(13), color: C.amber, flex: 1 }} numberOfLines={1}>
              {isDefault ? '★ ' : ''}{item.name}
            </Text>
            {item.version ? (
              <Text style={{ fontFamily: F, fontSize: fs(9), color: versionOld ? C.red : C.textDim, marginLeft: 6 }}>
                v{item.version}
              </Text>
            ) : null}
          </View>

          {/* Version warning */}
          {versionOld && (
            <Text style={{ fontFamily: F, fontSize: fs(9), color: C.red, marginTop: 2 }}>
              ⚠ Older than v{MIN_RECOMMENDED_VERSION} — may have visual glitches
            </Text>
          )}

          {/* Meta row: location · callsign · distance */}
          <View style={styles.metaRow}>
            {item.location ? (
              <Text style={{ fontFamily: F, fontSize: fs(10), color: C.gold }} numberOfLines={1}>
                {item.location}
              </Text>
            ) : null}
            {item.callsign ? (
              <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim }}>
                {item.location ? '  ·  ' : ''}{item.callsign}
              </Text>
            ) : null}
            {item.distance != null ? (
              <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim }}>
                {'  ·  '}{item.distance < 1 ? '<1' : Math.round(item.distance)} km
              </Text>
            ) : null}
          </View>

          {/* SNR badge */}
          {item.bestSnr != null ? (
            <Text style={{ fontFamily: F, fontSize: fs(9), color: snrColor(item.bestSnr, C), marginTop: 2 }}>
              {snrLabel(item.bestSnr)}
            </Text>
          ) : null}
        </View>

        {/* Right column */}
        <View style={styles.rowRight}>
          {(item.users != null && item.maxUsers) ? (
            <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim }}>
              {item.users}/{item.maxUsers}
            </Text>
          ) : null}
          <TouchableOpacity
            style={{ padding: 4 }}
            onPress={() => isDefault ? handleClearDefault() : handleSetDefault({ name: item.name, url: item.url })}
          >
            <Text style={{ fontSize: fs(18), color: isDefault ? C.amber : C.goldDim }}>
              {isDefault ? '★' : '☆'}
            </Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: C.bg }]}>
      <PasswordModal
        visible={!!pwModal}
        serverUrl={pwModal?.url ?? ''}
        onSubmit={pw => { const m = pwModal; setPwModal(null); if (m) connect(m.url, m.name, pw); }}
        onCancel={() => setPwModal(null)}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {/* Header */}
        <View style={[styles.header, { borderBottomColor: C.border }]}>
          <View style={styles.headerLeft}>
            <Text style={{ fontFamily: F, fontSize: fs(24), fontWeight: 'bold', color: C.amber, letterSpacing: 3,
              textShadowColor: C.amberGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 }}>
              VibeSDR
            </Text>
            <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim, letterSpacing: 1 }}>v0.1</Text>
          </View>
          <TouchableOpacity style={{ padding: 8 }} onPress={handleResetSettings}>
            <Text style={{ fontSize: fs(20), color: C.textDim }}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* Mode badge */}
        <TouchableOpacity
          style={[styles.modeBadge, { borderBottomColor: C.border }]}
          onPress={handleResetSettings}
        >
          <Text style={{ fontFamily: F, fontSize: fs(10), color: C.gold, letterSpacing: 1 }}>
            {viewMode === 'accessibility' ? '♿ ACCESSIBLE MODE' : '📻 DEFAULT MODE'}
          </Text>
          <Text style={{ fontFamily: F, fontSize: fs(9), color: C.textDim, textDecorationLine: 'underline' }}>change</Text>
        </TouchableOpacity>

        {/* Default banner */}
        {defaultInst && (
          <View style={[styles.defaultBanner, { borderBottomColor: C.borderBright }]}>
            <Text style={{ fontFamily: F, fontSize: fs(9), color: C.amber, letterSpacing: 2, flexShrink: 0 }}>★ AUTO-CONNECT</Text>
            <Text style={{ fontFamily: F, fontSize: fs(12), color: C.amber, flex: 1 }} numberOfLines={1}>{defaultInst.name}</Text>
            <TouchableOpacity onPress={handleClearDefault} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text style={{ fontFamily: F, fontSize: fs(14), color: C.red }}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Custom URL */}
        <View style={styles.customRow}>
          <TextInput
            style={[styles.urlInput, { fontFamily: F, fontSize: fs(12), color: C.amber, borderColor: C.border }]}
            placeholder="Custom URL  e.g. sdr.example.com"
            placeholderTextColor={C.textDim}
            value={customUrl}
            onChangeText={setCustomUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            onSubmitEditing={connectCustom}
          />
          {/* Star — sets custom URL as default without connecting */}
          {normalisedCustomUrl ? (
            <TouchableOpacity
              style={[styles.connectBtn, { borderColor: C.border, paddingHorizontal: 10 }]}
              onPress={() => {
                const url  = normalisedCustomUrl;
                const name = url.replace(/^https?:\/\//, '');
                if (defaultInst?.url === url) {
                  handleClearDefault();
                } else {
                  Alert.alert(
                    'Set as Default',
                    `Auto-connect to "${name}" on every startup?`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Set Default', onPress: async () => {
                          await setDefaultInstance({ name, url });
                          setDefaultInst({ name, url });
                        },
                      },
                    ],
                  );
                }
              }}
            >
              <Text style={{ fontSize: fs(18), color: defaultInst?.url === normalisedCustomUrl ? C.amber : C.goldDim }}>
                {defaultInst?.url === normalisedCustomUrl ? '★' : '☆'}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.connectBtn, { borderColor: C.borderBright }, connecting && { opacity: 0.5 }]}
            onPress={connectCustom}
            disabled={connecting}
          >
            <Text style={{ fontFamily: F, fontSize: fs(11), fontWeight: 'bold', color: C.amber, letterSpacing: 1 }}>
              {connecting ? '...' : 'CONNECT'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Filter + Sort toggle */}
        <View style={styles.filterRow}>
          <TextInput
            style={[styles.filterInput, { fontFamily: F, fontSize: fs(11), color: C.amber, borderColor: C.border, flex: 1 }]}
            placeholder="Search name, location or callsign…"
            placeholderTextColor={C.textDim}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.sortBtn, { borderColor: sortMode === 'snr' ? C.borderBright : C.border }]}
            onPress={() => setSortMode(m => m === 'nearest' ? 'snr' : 'nearest')}
          >
            <Text style={{ fontFamily: F, fontSize: fs(9), color: sortMode === 'snr' ? C.amber : C.textDim, letterSpacing: 1 }}>
              {sortMode === 'snr' ? '📶 SNR' : '📍 NEAR'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* List */}
        {loading ? (
          <View style={styles.centred}>
            <ActivityIndicator color={C.amber} />
            <Text style={{ fontFamily: F, fontSize: fs(12), color: C.gold }}>Loading instances…</Text>
          </View>
        ) : error ? (
          <View style={styles.centred}>
            <Text style={{ fontFamily: F, fontSize: fs(12), color: C.red, textAlign: 'center' }}>{error}</Text>
            <TouchableOpacity onPress={() => {
              setLoading(true); setError(null);
              fetchInstances(userLocRef.current?.lat, userLocRef.current?.lon)
                .then(setInstances).catch(e => setError(e.message)).finally(() => setLoading(false));
            }}>
              <Text style={{ fontFamily: F, fontSize: fs(12), color: C.amber, textDecorationLine: 'underline' }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={item => item.url}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 40 }}
            ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
            ListEmptyComponent={
              <Text style={{ fontFamily: F, fontSize: fs(12), color: C.textDim, textAlign: 'center', marginTop: 40 }}>
                No instances found
              </Text>
            }
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function snrLabel(snr: number): string {
  if (snr >= 30) return '▲ Excellent conditions';
  if (snr >= 20) return '▲ Good conditions';
  if (snr >= 6)  return '△ Fair conditions';
  return '▽ Poor conditions';
}
function snrColor(snr: number, C: any): string {
  if (snr >= 30) return C.green;
  if (snr >= 20) return '#88cc44';
  if (snr >= 6)  return C.amber;
  return C.red;
}

const styles = StyleSheet.create({
  safe:          { flex: 1 },
  flex:          { flex: 1 },
  header:        { flexDirection: 'row', alignItems: 'center', padding: 16, paddingBottom: 8, borderBottomWidth: 1 },
  headerLeft:    { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  modeBadge:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 5, borderBottomWidth: 1, backgroundColor: 'rgba(255,160,0,0.04)' },
  defaultBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,160,0,0.10)', borderBottomWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  customRow:     { flexDirection: 'row', gap: 8, padding: 12, paddingBottom: 8 },
  urlInput:      { flex: 1, height: 44, backgroundColor: 'rgba(20,10,0,0.75)', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12 },
  connectBtn:    { height: 44, backgroundColor: 'rgba(20,10,0,0.75)', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, justifyContent: 'center' },
  filterRow:     { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginBottom: 8, alignItems: 'center' },
  filterInput:   { height: 40, backgroundColor: 'rgba(10,8,4,0.60)', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12 },
  sortBtn:       { height: 40, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, justifyContent: 'center', backgroundColor: 'rgba(10,8,4,0.60)' },
  row:           { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, backgroundColor: 'rgba(20,10,0,0.55)', borderWidth: 1, borderRadius: 6 },
  rowMain:       { flex: 1 },
  rowRight:      { alignItems: 'center', gap: 6, flexDirection: 'row', marginLeft: 8 },
  nameRow:       { flexDirection: 'row', alignItems: 'center' },
  metaRow:       { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  centred:       { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 },
});
