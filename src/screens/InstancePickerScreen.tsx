import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
// safe-area-context SafeAreaView — RN's own is iOS-only, which put the
// header under the status bar on Android (G35: cog untappable)
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { splashBridge } from '../../App';
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
import { checkConnection, detectServerType } from '../services/sdrTypes';
import {
  DefaultInstance,
  clearDefaultInstance,
  getDefaultInstance,
  setDefaultInstance,
} from '../services/defaultInstance';
import { Favourite, getFavourites, toggleFavourite } from '../services/favourites';
import { loadUserBookmarks, saveUserBookmarks, type UserBookmark } from '../services/userBookmarks';
import { ViewMode, getViewMode, setViewMode } from '../services/viewMode';
import PasswordModal from '../components/PasswordModal';
import { VibePowerModule } from '../components/AudioPlayer';
import { APP_VERSION } from '../constants/version';

/** ISO 3166-1 alpha-2 → 🇬🇧-style emoji flag (regional indicators, no assets). */
function flagEmoji(code: string | null): string {
  if (!code || code.length !== 2) return '';
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(127397 + cc.charCodeAt(0), 127397 + cc.charCodeAt(1));
}

type SortMode = 'nearest' | 'snr';
type Props = NativeStackScreenProps<RootStackParamList, 'InstancePicker'>;

// A unified list item — either a real SDRInstance or a favourited custom URL
type ListItem =
  | { kind: 'instance'; data: SDRInstance }
  | { kind: 'custom';   fav: Favourite };

export default function InstancePickerScreen({ navigation }: Props) {
  const [instances,   setInstances]     = useState<SDRInstance[]>([]);
  const [loading,     setLoading]       = useState(true);
  const [error,       setError]         = useState<string | null>(null);
  const [customUrl,   setCustomUrl]     = useState('');
  const [connecting,  setConnecting]    = useState(false);
  const [filter,      setFilter]        = useState('');
  const [defaultInst, setDefaultInst]   = useState<DefaultInstance | null>(null);
  // Tell native the default-instance name (or '' = none) so the Siri "open and
  // tune" intent can auto-connect, or prompt the user to set a default.
  useEffect(() => { VibePowerModule?.setDefaultInstance?.(defaultInst?.name ?? ''); }, [defaultInst]);
  const [viewMode,    setViewModeState] = useState<ViewMode>('default');
  const [modeReady,   setModeReady]     = useState(false);
  const [sortMode,    setSortMode]      = useState<SortMode>('nearest');
  const [pwModal,     setPwModal]       = useState<{ url: string; name: string } | null>(null);
  const [favourites,  setFavourites]    = useState<Favourite[]>([]);
  const userLocRef = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAndInit() {
      let mode = await getViewMode();
      if (cancelled) return;
      const { width } = require('react-native').Dimensions.get('window');
      const isSmallScreen = width <= 390;
      if (!mode) {
        if (isSmallScreen) { await setViewMode('accessibility'); mode = 'accessibility'; }
        else { navigation.replace('InstancePicker'); return; }
      } else if (isSmallScreen && mode !== 'accessibility') {
        await setViewMode('accessibility'); mode = 'accessibility';
      }
      setViewModeState(mode);
      setModeReady(true);

      const favs = await getFavourites();
      if (!cancelled) setFavourites(favs);

      const dEarly = await getDefaultInstance();
      if (!cancelled && dEarly) {
        setDefaultInst(dEarly);
        splashBridge.updateLabel(dEarly.name || dEarly.url);
      }

      let allInst: typeof instances = [];
      try {
        const loc = await getUserLocation();
        if (!cancelled) userLocRef.current = loc;
        allInst = await fetchInstances(loc?.lat, loc?.lon);
        if (!cancelled) setInstances(allInst);
      } catch (e: any) {
        const msg = (e.message ?? '');
        if (!cancelled) setError(
          msg.includes('429') ? 'Server busy — please try again in a moment' : (msg || 'Failed to load instances')
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
          splashBridge.dismiss();
        }
      }

      if (!cancelled && dEarly) {
        const match = allInst.find(i => i.url === dEarly.url);
        navigation.navigate('SDR', { baseUrl: dEarly.url, instanceName: dEarly.name, viewMode: mode, serverLongitude: match?.longitude ?? null });
      }
    }

    loadAndInit();
    return () => { cancelled = true; };
  }, []);

  useFocusEffect(useCallback(() => {
    getViewMode().then(mode => { if (mode) setViewModeState(mode); });
    // Re-read the default on every focus — the SDR menu can set/clear it,
    // and returning here doesn't remount (stale star otherwise).
    getDefaultInstance().then(d => setDefaultInst(d)).catch(() => {});
  }, []));

  const { colors: C, font: F, scale } = themeFor(viewMode);

  const normalisedCustomUrl = useMemo(() => {
    let u = customUrl.trim().replace(/\/+$/, '');
    if (u && !u.startsWith('http://') && !u.startsWith('https://')) u = 'http://' + u;
    return u;
  }, [customUrl]);
  const fs = (base: number) => Math.round(base * scale);

  const isFav = useCallback((url: string) => favourites.some(f => f.url === url), [favourites]);

  const handleToggleFav = useCallback(async (fav: Favourite) => {
    const next = await toggleFavourite(fav, favourites);
    setFavourites(next);
  }, [favourites]);

  const connect = useCallback(async (url: string, name: string, password?: string, serverLongitude?: number | null, serverType?: 'ubersdr' | 'kiwi' | 'owrx') => {
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
      navigation.navigate('SDR', { baseUrl: cleaned, instanceName: name, password, viewMode, serverLongitude, serverType });
    } catch (e: any) {
      setConnecting(false);
      Alert.alert('Connection Error', e.message ?? 'Could not reach server');
    }
  }, [navigation, viewMode]);

  const connectCustom = useCallback(async () => {
    if (!customUrl.trim()) return;
    let url = customUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
    // App Store security policy (ATS): plain HTTP is only allowed to LOCAL
    // network addresses — public-internet servers must use HTTPS. iOS blocks
    // the connection at the OS level, so warn instead of failing silently.
    const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0];
    const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
      || host.endsWith('.local');
    if (url.startsWith('http://') && !isLocal) {
      Alert.alert(
        'HTTP Not Supported',
        'Plain HTTP is only supported for local network addresses (e.g. 192.168.x.x). ' +
        'Internet servers must use https:// — App Store security policy blocks ' +
        'unencrypted connections to the web.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Try HTTPS', onPress: async () => { const u = url.replace(/^http:/, 'https:'); connect(u, u, undefined, null, await detectServerType(u)); } },
        ],
      );
      return;
    }
    // v3: sniff the backend type (OpenWebRX / KiwiSDR / UberSDR) for manual adds.
    const type = await detectServerType(url);
    connect(url, url, undefined, null, type);
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

  // Master factory reset — wipes ALL settings and stored data (display
  // prefs, per-instance tunes, favourites, default instance, callsigns…),
  // asking about bookmarks first (never cleared silently).
  const handleMasterReset = useCallback(() => {
    Alert.alert(
      'Factory Reset',
      'Clears ALL settings and stored data and returns the app to a fresh-install state. Recordings already saved to your device are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset Everything', style: 'destructive', onPress: async () => {
          const bms = await loadUserBookmarks().catch(() => [] as UserBookmark[]);
          const wipe = async (keepBms: boolean) => {
            await AsyncStorage.clear().catch(() => {});
            if (keepBms && bms.length) await saveUserBookmarks(bms).catch(() => {});
            navigation.replace('InstancePicker');
          };
          if (bms.length > 0) {
            Alert.alert(
              'Bookmarks',
              `Keep your ${bms.length} saved bookmark${bms.length !== 1 ? 's' : ''}?`,
              [
                { text: 'Keep', style: 'default', onPress: () => wipe(true) },
                { text: 'Clear All', style: 'destructive', onPress: () => wipe(false) },
              ],
            );
          } else {
            wipe(false);
          }
        } },
      ],
    );
  }, [navigation]);

  // Build list: favourites section (pinned top) then filtered instances
  const listData = useMemo((): ListItem[] => {
    const q = filter.toLowerCase().trim();

    // Favourited custom URLs (not in the instances list)
    const instanceUrls = new Set(instances.map(i => i.url));
    const customFavs: ListItem[] = favourites
      .filter(f => !instanceUrls.has(f.url))
      .filter(f => !q || f.name.toLowerCase().includes(q) || f.url.toLowerCase().includes(q))
      .map(f => ({ kind: 'custom', fav: f }));

    // Favourited instances (pinned to top)
    const favInstances: ListItem[] = instances
      .filter(i => isFav(i.url))
      .filter(i => !q || i.name.toLowerCase().includes(q) || (i.location ?? '').toLowerCase().includes(q) || (i.callsign ?? '').toLowerCase().includes(q))
      .map(i => ({ kind: 'instance', data: i }));

    // Remaining instances (not favourited)
    let rest = instances
      .filter(i => !isFav(i.url))
      .filter(i => !q || i.name.toLowerCase().includes(q) || (i.location ?? '').toLowerCase().includes(q) || (i.callsign ?? '').toLowerCase().includes(q));

    if (sortMode === 'snr') {
      rest = [...rest].sort((a, b) => (b.bestSnr ?? -Infinity) - (a.bestSnr ?? -Infinity));
    }

    return [
      ...customFavs,
      ...favInstances,
      ...rest.map(i => ({ kind: 'instance' as const, data: i })),
    ];
  }, [instances, favourites, filter, sortMode, isFav]);


  if (!modeReady) return <SafeAreaView style={{ flex: 1, backgroundColor: '#0A0A12' }} />;

  const renderItem = ({ item, index }: { item: ListItem; index: number }) => {
    // Section header before first non-favourite instance
    const favCount = listData.filter(d =>
      d.kind === 'custom' || (d.kind === 'instance' && isFav(d.data.url))
    ).length;
    const showFavHeader   = index === 0 && favCount > 0;
    const showOtherHeader = index === favCount && favCount > 0 && listData.length > favCount;

    if (item.kind === 'custom') {
      const fav = item.fav;
      const isDefault = defaultInst?.url === fav.url;
      return (
        <>
          {showFavHeader && <SectionHeader label="FAVOURITES" fs={fs} F={F} C={C} />}
          <TouchableOpacity
            style={[styles.row, { borderColor: C.borderBright, backgroundColor: 'rgba(255,100,100,0.06)' }]}
            onPress={() => connect(fav.url, fav.name)}
            disabled={connecting}
          >
            <View style={styles.rowMain}>
              <View style={styles.nameRow}>
                <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber, flex: 1 }} numberOfLines={1}>
                  {isDefault ? '★ ' : ''}{fav.name}
                </Text>
              </View>
              <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim }} numberOfLines={1}>{fav.url}</Text>
            </View>
            <View style={styles.rowRight}>
              <TouchableOpacity style={{ padding: 4 }}
                onPress={() => isDefault ? handleClearDefault() : handleSetDefault({ name: fav.name, url: fav.url })}>
                <Text style={{ fontSize: fs(18), color: isDefault ? C.amber : C.goldDim }}>{isDefault ? '★' : '☆'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ padding: 4 }} onPress={() => handleToggleFav(fav)}>
                <Text style={{ fontSize: fs(18), color: C.red }}>♥</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </>
      );
    }

    const inst = item.data;
    const isDefault = defaultInst?.url === inst.url;
    const versionOld = isVersionOld(inst.version);
    const favoured = isFav(inst.url);

    return (
      <>
        {showFavHeader  && <SectionHeader label="FAVOURITES" fs={fs} F={F} C={C} />}
        {showOtherHeader && <SectionHeader label="ALL INSTANCES" fs={fs} F={F} C={C} />}
        <TouchableOpacity
          style={[
            styles.row,
            { borderColor: C.border },
            isDefault && { borderColor: C.borderBright, backgroundColor: 'rgba(255,160,0,0.08)' },
            favoured && !isDefault && { borderColor: 'rgba(255,80,80,0.4)' },
          ]}
          onPress={() => connect(inst.url, inst.name, undefined, inst.longitude)}
          disabled={connecting}
        >
          <View style={styles.rowMain}>
            <View style={styles.nameRow}>
              <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber, flex: 1 }} numberOfLines={1}>
                {isDefault ? '★ ' : ''}{flagEmoji(inst.countryCode) ? flagEmoji(inst.countryCode) + ' ' : ''}{inst.name}
              </Text>
              {inst.version ? (
                <Text style={{ fontFamily: F, fontSize: fs(11), color: versionOld ? C.red : C.textDim, marginLeft: 6 }}>
                  v{inst.version}
                </Text>
              ) : null}
            </View>
            {versionOld && (
              <Text style={{ fontFamily: F, fontSize: fs(11), color: C.red, marginTop: 2 }}>
                ⚠ Older than v{MIN_RECOMMENDED_VERSION} — may have visual glitches
              </Text>
            )}
            <View style={styles.metaRow}>
              {inst.location ? (
                <Text style={{ fontFamily: F, fontSize: fs(12.5), color: C.gold }} numberOfLines={1}>{inst.location}</Text>
              ) : null}
              {inst.callsign ? (
                <Text style={{ fontFamily: F, fontSize: fs(12.5), color: C.textDim }}>
                  {inst.location ? '  ·  ' : ''}{inst.callsign}
                </Text>
              ) : null}
              {inst.distance != null ? (
                <Text style={{ fontFamily: F, fontSize: fs(12.5), color: C.textDim }}>
                  {'  ·  '}{inst.distance < 1 ? '<1' : Math.round(inst.distance)} km
                </Text>
              ) : null}
            </View>
            {inst.bestSnr != null ? (
              <Text style={{ fontFamily: F, fontSize: fs(11), color: snrColor(inst.bestSnr, C), marginTop: 2 }}>
                {snrLabel(inst.bestSnr)}
              </Text>
            ) : null}
          </View>
          <View style={styles.rowRight}>
            {(inst.users != null && inst.maxUsers) ? (
              <Text style={{ fontFamily: F, fontSize: fs(12), color: C.textDim }}>{inst.users}/{inst.maxUsers}</Text>
            ) : null}
            <TouchableOpacity style={{ padding: 4 }}
              onPress={() => isDefault ? handleClearDefault() : handleSetDefault({ name: inst.name, url: inst.url })}>
              <Text style={{ fontSize: fs(18), color: isDefault ? C.amber : C.goldDim }}>{isDefault ? '★' : '☆'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={{ padding: 4 }}
              onPress={() => handleToggleFav({ name: inst.name, url: inst.url })}>
              <Text style={{ fontSize: fs(18), color: favoured ? C.red : C.textDim }}>{favoured ? '♥' : '♡'}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </>
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
            <Text style={{ fontFamily: F, fontSize: fs(10), color: C.textDim, letterSpacing: 1 }}>v{APP_VERSION}</Text>
          </View>
          {/* ⚙ = factory reset (the mode-change badge is gone — single skin now) */}
          <TouchableOpacity style={{ padding: 10 }} onPress={handleMasterReset} hitSlop={8}>
            <Text style={{ fontSize: fs(22), color: C.textDim }}>⚙</Text>
          </TouchableOpacity>
        </View>

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
          {normalisedCustomUrl ? (
            <>
              {/* Heart — favourite this custom URL */}
              <TouchableOpacity
                style={[styles.connectBtn, { borderColor: C.border, paddingHorizontal: 10 }]}
                onPress={() => {
                  const url  = normalisedCustomUrl;
                  const name = url.replace(/^https?:\/\//, '');
                  handleToggleFav({ name, url });
                }}
              >
                <Text style={{ fontSize: fs(18), color: isFav(normalisedCustomUrl) ? C.red : C.textDim }}>
                  {isFav(normalisedCustomUrl) ? '♥' : '♡'}
                </Text>
              </TouchableOpacity>
              {/* Star — set as default */}
              <TouchableOpacity
                style={[styles.connectBtn, { borderColor: C.border, paddingHorizontal: 10 }]}
                onPress={() => {
                  const url  = normalisedCustomUrl;
                  const name = url.replace(/^https?:\/\//, '');
                  if (defaultInst?.url === url) {
                    handleClearDefault();
                  } else {
                    Alert.alert('Set as Default', `Auto-connect to "${name}" on every startup?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Set Default', onPress: async () => {
                          await setDefaultInstance({ name, url });
                          setDefaultInst({ name, url });
                        },
                      },
                    ]);
                  }
                }}
              >
                <Text style={{ fontSize: fs(18), color: defaultInst?.url === normalisedCustomUrl ? C.amber : C.goldDim }}>
                  {defaultInst?.url === normalisedCustomUrl ? '★' : '☆'}
                </Text>
              </TouchableOpacity>
            </>
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
        {loading ? null : error ? (
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
            data={listData}
            keyExtractor={item => item.kind === 'custom' ? 'custom:' + item.fav.url : item.data.url}
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

function SectionHeader({ label, fs, F, C }: { label: string; fs: (n: number) => number; F: string; C: any }) {
  return (
    <View style={{ paddingHorizontal: 4, paddingTop: 10, paddingBottom: 4 }}>
      <Text style={{ fontFamily: F, fontSize: fs(9), color: C.textDim, letterSpacing: 2 }}>{label}</Text>
    </View>
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
