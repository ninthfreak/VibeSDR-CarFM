import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  NativeModules,
} from 'react-native';
// safe-area-context SafeAreaView — RN's own is iOS-only, which put the
// header under the status bar on Android (G35: cog untappable)
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { splashBridge } from '../../App';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import UsbSdrIcon from '../components/UsbSdrIcon';
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
import { Favourite, getFavourites, toggleFavourite, setFavouriteServerType,
         TcpFav, getTcpFavs, saveTcpFavs } from '../services/favourites';
import { loadUserBookmarks, saveUserBookmarks, type UserBookmark } from '../services/userBookmarks';
import { ViewMode, getViewMode, setViewMode } from '../services/viewMode';
import PasswordModal from '../components/PasswordModal';
import { VibePowerModule } from '../components/AudioPlayer';
import { APP_VERSION } from '../constants/version';
import { DIRECTORIES, fetchDirectory, type DirectoryId } from '../services/directories';

// Per-backend logo for the directory cards + per-instance type icon (receiverbook
// mixes OWRX + Kiwi, so the row icon tells them apart at a glance).
const TYPE_LOGOS: Record<string, any> = {
  ubersdr: require('../../assets/logo_ubersdr.png'),
  owrx:    require('../../assets/logo_owrx.png'),
  kiwi:    require('../../assets/logo_kiwi.png'),
};

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
  // RTL-TCP named favourites (host:port + friendly name), persisted locally.
  const [tcpFavs,     setTcpFavs]       = useState<TcpFav[]>([]);
  const [tcpModal,    setTcpModal]      = useState(false);
  const [tcpName,     setTcpName]       = useState('');
  const [tcpHost,     setTcpHost]       = useState('');
  const [tcpPort,     setTcpPort]       = useState('1234');
  // null = directory CHOOSER (favourites + directory cards); set = that
  // directory's instance list.
  const [selectedDir, setSelectedDir]   = useState<DirectoryId | null>(null);
  const userLocRef = useRef<{ lat: number; lon: number } | null>(null);

  const openDirectory = useCallback((id: DirectoryId) => {
    setSelectedDir(id);
    setInstances([]); setFilter(''); setError(null); setLoading(true);
    fetchDirectory(id, userLocRef.current?.lat, userLocRef.current?.lon)
      .then((list) => setInstances(list))
      .catch((e: any) => setError(e?.message || 'Failed to load this directory'))
      .finally(() => setLoading(false));
  }, []);

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
      const tfavs = await getTcpFavs();
      if (!cancelled) setTcpFavs(tfavs);

      const dEarly = await getDefaultInstance();
      if (!cancelled && dEarly) {
        setDefaultInst(dEarly);
        splashBridge.updateLabel(dEarly.name || dEarly.url);
      }

      // Learn the user's location for distance sorting (used when a directory is
      // opened), but DON'T fetch any directory here — the landing view is the
      // chooser (favourites + directory cards). Directories load on tap.
      try { const loc = await getUserLocation(); if (!cancelled) userLocRef.current = loc; } catch {}
      if (!cancelled) { setLoading(false); splashBridge.dismiss(); }

      // A default instance still auto-connects straight through.
      if (!cancelled && dEarly) {
        navigation.navigate('SDR', { baseUrl: dEarly.url, instanceName: dEarly.name, viewMode: mode, serverLongitude: null });
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

  // V4 local hardware (Android only): start the on-device shim (RTL-SDR over
  // USB OTG) and connect to it on localhost. Audio rides /ws/audio (external
  // PCM); spectrum/control reuse the UberSDR path against ws://127.0.0.1.
  const connectLocal = useCallback(async () => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.startSpectrum) { Alert.alert('Local Hardware', 'Not available on this build.'); return; }
    setConnecting(true);
    try {
      const res = await Local.startSpectrum({
        // fftSize 8192 over 2.4 MHz ≈ 293 Hz/bin (sharp AM/SSB); fftRate 10 to
        // match UberSDR's line cadence so the waterfall interpolation lines up.
        centerFreq: 100_000_000, sampleRate: 2_400_000, fftSize: 8192, fftRate: 10, mode: 'wfm',
      }) as { port: number; wsBaseUrl: string };
      setConnecting(false);
      navigation.navigate('SDR', {
        baseUrl: res.wsBaseUrl, instanceName: 'Local Hardware', viewMode,
        serverType: 'ubersdr', isLocal: true, localPort: res.port,
      });
    } catch (e: any) {
      setConnecting(false);
      Alert.alert('Local Hardware', e?.message ?? 'Could not start local SDR. Is an RTL-SDR plugged in via USB OTG?');
    }
  }, [navigation, viewMode]);

  // RTL-TCP: connect to an rtl_tcp server (host:port) over the network and run the
  // same on-device shim against it — no USB, so this also works on iOS. Reuses the
  // local-SDR wiring (isLocal) with isTcp set for the RTL-TCP icon/labels.
  const connectTcp = useCallback(async (host: string, port: number, name: string) => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.startTcp) { Alert.alert('RTL-TCP', 'Not available on this build.'); return; }
    setConnecting(true);
    try {
      const res = await Local.startTcp({
        host, port,
        centerFreq: 100_000_000, sampleRate: 2_400_000, fftSize: 8192, fftRate: 10, mode: 'wfm',
      }) as { port: number; wsBaseUrl: string };
      setConnecting(false);
      navigation.navigate('SDR', {
        baseUrl: res.wsBaseUrl, instanceName: name || `${host}:${port}`, viewMode,
        serverType: 'ubersdr', isLocal: true, isTcp: true, localPort: res.port,
        tcpHost: host, tcpPort: port,
      });
    } catch (e: any) {
      setConnecting(false);
      Alert.alert('RTL-TCP', e?.message ?? `Could not connect to ${host}:${port}. Is rtl_tcp running and reachable?`);
    }
  }, [navigation, viewMode]);

  // Parse the add-RTL-TCP modal: accept "host", "host:port", or separate fields.
  const parseTcpEntry = useCallback((): { host: string; port: number } | null => {
    let h = tcpHost.trim();
    let p = parseInt(tcpPort.trim(), 10);
    if (h.includes(':')) { const [hh, pp] = h.split(':'); h = hh.trim(); if (pp) p = parseInt(pp.trim(), 10); }
    if (!h) return null;
    if (!Number.isFinite(p) || p <= 0 || p > 65535) p = 1234;
    return { host: h, port: p };
  }, [tcpHost, tcpPort]);

  const tcpModalConnect = useCallback((save: boolean) => {
    const parsed = parseTcpEntry();
    if (!parsed) { Alert.alert('RTL-TCP', 'Enter a host (and optional :port).'); return; }
    const name = tcpName.trim() || `${parsed.host}:${parsed.port}`;
    if (save) {
      const next = [...tcpFavs.filter(f => !(f.host === parsed.host && f.port === parsed.port)),
                    { name, host: parsed.host, port: parsed.port }];
      setTcpFavs(next); saveTcpFavs(next).catch(() => {});
    }
    setTcpModal(false); setTcpName(''); setTcpHost(''); setTcpPort('1234');
    connectTcp(parsed.host, parsed.port, name);
  }, [parseTcpEntry, tcpName, tcpFavs, connectTcp]);

  const removeTcpFav = useCallback((fav: TcpFav) => {
    const next = tcpFavs.filter(f => !(f.host === fav.host && f.port === fav.port));
    setTcpFavs(next); saveTcpFavs(next).catch(() => {});
  }, [tcpFavs]);

  // Connect a saved favourite: use its stored backend type, or detect it once
  // (and remember it) so an OpenWebRX/Kiwi favourite doesn't reconnect as UberSDR.
  const connectFav = useCallback(async (fav: Favourite) => {
    // Re-detect on every connect. A SUCCESSFUL detection is authoritative and
    // self-heals a wrong stored type (e.g. an UberSDR-with-kiwi-emulation that a
    // previous build mis-saved as kiwi). Detection returns null only when the
    // host can't be reached — then keep the stored type rather than guessing.
    const detected = await detectServerType(fav.url);
    const type = detected ?? fav.serverType ?? 'ubersdr';
    if (type !== fav.serverType) setFavouriteServerType(fav.url, type).catch(() => {});
    connect(fav.url, fav.name, undefined, null, type);
  }, [connect]);

  const connectCustom = useCallback(async () => {
    if (!customUrl.trim()) return;
    let url = customUrl.trim();
    // Accept ws://, wss://, http(s)://, or a bare host. Normalise ws→http so the
    // host parses correctly (typing "ws://192.168.x.x" used to become
    // "http://ws://…", parsing the host as "ws" → bogus "not local" rejection).
    url = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    // Plain HTTP to public-internet servers IS allowed (NSAllowsArbitraryLoads in
    // Info.plist/app.json) — most KiwiSDR/OpenWebRX receivers are hobbyist HTTP
    // boxes with no TLS, so we don't block them (same as Echo SDR et al.).
    // v3: sniff the backend type (OpenWebRX / KiwiSDR / UberSDR) for manual adds.
    const type = (await detectServerType(url)) ?? 'ubersdr';
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
            onPress={() => connectFav(fav)}
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
    // Full receiver — greyed out + unselectable. The two directories report the
    // count with OPPOSITE meaning: UberSDR's `users` = FREE slots (20/20 = empty,
    // 0/20 = full); KiwiSDR's `users` = IN-USE (4/4 = full). So full-ness flips.
    const st = inst.serverType ?? 'ubersdr';
    const isFull = inst.maxUsers > 0 && (st === 'ubersdr'
      ? inst.users <= 0              // ubersdr: 0 free slots = full
      : inst.users >= inst.maxUsers); // kiwi: all in use = full

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
            isFull && { opacity: 0.4 },
          ]}
          onPress={() => connect(inst.url, inst.name, undefined, inst.longitude, inst.serverType)}
          disabled={connecting || isFull}
        >
          <View style={styles.rowMain}>
            <View style={styles.nameRow}>
              <View style={(inst.serverType ?? 'ubersdr') === 'owrx' ? styles.logoChip : undefined}>
                <Image source={TYPE_LOGOS[inst.serverType ?? 'ubersdr']} style={styles.typeLogo} resizeMode="contain" />
              </View>
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
              <Text style={{ fontFamily: F, fontSize: fs(12), color: isFull ? C.red : C.textDim, fontWeight: isFull ? 'bold' : 'normal' }}>
                {isFull ? 'FULL ' : ''}{inst.users}/{inst.maxUsers}
              </Text>
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

      {/* Add RTL-TCP server: friendly name + host:port; Connect, or Save & Connect. */}
      <Modal visible={tcpModal} transparent animationType="fade" onRequestClose={() => setTcpModal(false)}>
        <View style={styles.tcpBackdrop}>
          <View style={[styles.tcpCard, { borderColor: C.amber }]}>
            <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber, letterSpacing: 1, marginBottom: 10 }}>RTL-TCP SERVER</Text>
            <TextInput style={[styles.tcpInput, { color: C.gold, borderColor: C.border, fontFamily: F }]}
              placeholder="Name (e.g. Shack Pi)" placeholderTextColor={C.textDim}
              value={tcpName} onChangeText={setTcpName} autoCorrect={false} />
            <TextInput style={[styles.tcpInput, { color: C.gold, borderColor: C.border, fontFamily: F }]}
              placeholder="Host or IP (e.g. 192.168.1.50)" placeholderTextColor={C.textDim}
              value={tcpHost} onChangeText={setTcpHost} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
            <TextInput style={[styles.tcpInput, { color: C.gold, borderColor: C.border, fontFamily: F }]}
              placeholder="Port (default 1234)" placeholderTextColor={C.textDim}
              value={tcpPort} onChangeText={setTcpPort} keyboardType="number-pad" />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
              <TouchableOpacity style={styles.tcpBtnAlt} onPress={() => setTcpModal(false)}>
                <Text style={{ fontFamily: F, fontSize: fs(13), color: C.textDim }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.tcpBtnAlt} onPress={() => tcpModalConnect(false)}>
                <Text style={{ fontFamily: F, fontSize: fs(13), color: C.gold }}>Connect</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.tcpBtn, { backgroundColor: C.amber }]} onPress={() => tcpModalConnect(true)}>
                <Text style={{ fontFamily: F, fontSize: fs(13), color: '#1a1205', fontWeight: '600' }}>Save & Connect</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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

        {/* Directory back row — only inside an open directory */}
        {selectedDir !== null && (
          <TouchableOpacity
            style={[styles.backRow, { borderBottomColor: C.border }]}
            onPress={() => { setSelectedDir(null); setInstances([]); setFilter(''); setError(null); setLoading(false); }}
          >
            <Text style={{ fontFamily: F, fontSize: fs(13), color: C.amber }}>‹ Directories</Text>
            <Text style={{ fontFamily: F, fontSize: fs(11), color: C.textDim, letterSpacing: 1 }}>
              {DIRECTORIES.find(d => d.id === selectedDir)?.name ?? ''}
            </Text>
          </TouchableOpacity>
        )}

        {/* Custom URL — chooser only */}
        {selectedDir === null && (
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
                  const url     = normalisedCustomUrl;
                  const fallback = url.replace(/^https?:\/\//, '');
                  // Already a favourite → just un-favourite. Otherwise ask for a name.
                  if (isFav(url)) { handleToggleFav({ name: fallback, url }); return; }
                  if (Platform.OS === 'ios' && (Alert as any).prompt) {
                    (Alert as any).prompt(
                      'Name this favourite',
                      url,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Save', onPress: (text?: string) =>
                            handleToggleFav({ name: (text && text.trim()) || fallback, url }) },
                      ],
                      'plain-text',
                      fallback,
                    );
                  } else {
                    handleToggleFav({ name: fallback, url });
                  }
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
        )}

        {/* Filter + Sort toggle — directory view only */}
        {selectedDir !== null && (
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
        )}

        {/* Body: directory list when one is open, else the chooser */}
        {selectedDir !== null ? (
          loading ? (
            <View style={styles.centred}>
              <Text style={{ fontFamily: F, fontSize: fs(12), color: C.textDim }}>Loading…</Text>
            </View>
          ) : error ? (
            <View style={styles.centred}>
              <Text style={{ fontFamily: F, fontSize: fs(12), color: C.red, textAlign: 'center' }}>{error}</Text>
              <TouchableOpacity onPress={() => openDirectory(selectedDir)}>
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
          )
        ) : (
          <FlatList
            data={listData}
            keyExtractor={item => item.kind === 'custom' ? 'custom:' + item.fav.url : item.data.url}
            renderItem={renderItem}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 40 }}
            ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
            ListHeaderComponent={
              <View style={{ marginBottom: 4 }}>
                {/* Local USB hardware — Android only (iOS has no USB host SDR). */}
                {Platform.OS === 'android' && (<>
                  <SectionHeader label="LOCAL HARDWARE" fs={fs} F={F} C={C} />
                  <TouchableOpacity
                    style={[styles.row, { borderColor: C.amber }]}
                    onPress={connectLocal}
                  >
                    <View style={styles.rowMain}>
                      <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber }} numberOfLines={1}>Local Hardware</Text>
                      <Text style={{ fontFamily: F, fontSize: fs(11.5), color: C.textDim, marginTop: 2 }} numberOfLines={1}>
                        RTL-SDR plugged into this phone (USB-C OTG)
                      </Text>
                    </View>
                    <View style={{ marginLeft: 4 }}><UsbSdrIcon size={26} color={C.amber} strokeWidth={2.4} /></View>
                    <Text style={{ fontFamily: F, fontSize: fs(20), color: C.goldDim, marginLeft: 8 }}>›</Text>
                  </TouchableOpacity>
                </>)}

                {/* RTL-TCP — networked rtl_tcp server; works on both platforms. */}
                <View style={{ marginTop: Platform.OS === 'android' ? 10 : 0 }}>
                  <SectionHeader label="RTL-TCP" fs={fs} F={F} C={C} />
                  {tcpFavs.map((f) => (
                    <TouchableOpacity key={`${f.host}:${f.port}`}
                      style={[styles.row, { borderColor: C.amber }]}
                      onPress={() => connectTcp(f.host, f.port, f.name)}
                      onLongPress={() => Alert.alert(f.name, `${f.host}:${f.port}`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete', style: 'destructive', onPress: () => removeTcpFav(f) },
                      ])}
                    >
                      <Image source={require('../../assets/rtltcp.png')}
                        style={{ width: 26, height: 26, tintColor: C.amber, marginRight: 8 }} resizeMode="contain" />
                      <View style={styles.rowMain}>
                        <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber }} numberOfLines={1}>{f.name}</Text>
                        <Text style={{ fontFamily: F, fontSize: fs(11.5), color: C.textDim, marginTop: 2 }} numberOfLines={1}>
                          rtl_tcp · {f.host}:{f.port}
                        </Text>
                      </View>
                      <Text style={{ fontFamily: F, fontSize: fs(20), color: C.goldDim, marginLeft: 8 }}>›</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    style={[styles.row, { borderColor: C.goldDim, borderStyle: 'dashed' }]}
                    onPress={() => setTcpModal(true)}
                  >
                    <View style={styles.rowMain}>
                      <Text style={{ fontFamily: F, fontSize: fs(15), color: C.gold }} numberOfLines={1}>+ Add RTL-TCP server</Text>
                      <Text style={{ fontFamily: F, fontSize: fs(11.5), color: C.textDim, marginTop: 2 }} numberOfLines={1}>
                        host:port of an rtl_tcp server on your network
                      </Text>
                    </View>
                  </TouchableOpacity>
                </View>
              </View>
            }
            ListFooterComponent={
              <View style={{ marginTop: 14 }}>
                <SectionHeader label="DIRECTORIES" fs={fs} F={F} C={C} />
                {DIRECTORIES.map(d => (
                  <TouchableOpacity
                    key={d.id}
                    style={[styles.row, { borderColor: C.border, marginBottom: 6 }]}
                    onPress={() => openDirectory(d.id)}
                  >
                    <View style={styles.rowMain}>
                      <Text style={{ fontFamily: F, fontSize: fs(16), color: C.amber }} numberOfLines={1}>{d.name}</Text>
                      <Text style={{ fontFamily: F, fontSize: fs(11.5), color: C.textDim, marginTop: 2 }} numberOfLines={1}>{d.desc}</Text>
                    </View>
                    <View style={styles.rowRight}>
                      {d.kinds.map(k => (
                        <View key={k} style={k === 'owrx' ? styles.logoChip : undefined}>
                          <Image source={TYPE_LOGOS[k]} style={styles.typeLogo} resizeMode="contain" />
                        </View>
                      ))}
                      <Text style={{ fontFamily: F, fontSize: fs(20), color: C.goldDim, marginLeft: 4 }}>›</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                <Text style={{ fontFamily: F, fontSize: fs(10.5), color: C.textDim, lineHeight: fs(15),
                               paddingHorizontal: 6, paddingTop: 10, paddingBottom: 4 }}>
                  ⚠ KiwiSDR support is experimental. Many public KiwiSDRs limit or block app
                  connections, so some may refuse or drop out — this is a server-side restriction,
                  not a fault in VibeSDR. For the most reliable experience, use UberSDR or OpenWebRX.
                </Text>
              </View>
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
  tcpBackdrop:   { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 22 },
  tcpCard:       { backgroundColor: 'rgba(16,10,2,0.98)', borderWidth: 1, borderRadius: 12, padding: 18 },
  tcpInput:      { height: 44, backgroundColor: 'rgba(8,6,2,0.7)', borderWidth: 1, borderRadius: 6, paddingHorizontal: 12, marginBottom: 8 },
  tcpBtn:        { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  tcpBtnAlt:     { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: 'rgba(255,184,77,0.45)' },
  rowRight:      { alignItems: 'center', gap: 6, flexDirection: 'row', marginLeft: 8 },
  nameRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  typeLogo:      { width: 20, height: 20 },
  logoChip:      { backgroundColor: 'rgba(235,235,235,0.92)', borderRadius: 5, padding: 2 },
  backRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  metaRow:       { flexDirection: 'row', flexWrap: 'wrap', marginTop: 2 },
  centred:       { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 },
});
