import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, DeviceEventEmitter, NativeModules, Platform, StatusBar, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebViewMessageEvent } from 'react-native-webview';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useKeepAwake } from 'expo-keep-awake';
import { RootStackParamList } from '../../App';
import WaterfallWebView, { WaterfallWebViewHandle, loadAppPrefs, saveAppPref } from '../components/WaterfallWebView';
import {
  clearDefaultInstance,
  getDefaultInstance,
  setDefaultInstance,
} from '../services/defaultInstance';
import { ViewMode, setViewMode } from '../services/viewMode';

type Props = NativeStackScreenProps<RootStackParamList, 'SDR'>;

// ── Android media service bridge ──────────────────────────────────────────────
const MediaSvc = Platform.OS === 'android' ? NativeModules.VibeMediaService : null;

function formatHz(hz: number): string {
  if (!hz) return 'VibeSDR';
  if (hz >= 1000000) return (hz / 1_000_000).toFixed(3) + ' MHz';
  return (hz / 1000).toFixed(3) + ' kHz';
}

export default function SDRScreen({ route, navigation }: Props) {
  const { baseUrl, instanceName, viewMode = 'default' } = route.params;
  useKeepAwake();

  const insets      = useSafeAreaInsets();
  const wvRef       = useRef<WaterfallWebViewHandle>(null);
  const [isDefault, setIsDefault] = useState(false);
  const [appPrefs, setAppPrefs]   = useState<Record<string, unknown>>({});

  useEffect(() => {
    loadAppPrefs().then(setAppPrefs);
  }, []);

  // Android media-service state refs (avoid triggering re-renders)
  const mediaStarted = useRef(false);
  const lastTitle    = useRef('');
  const lastArtist   = useRef('');
  const lastMuted    = useRef(false);

  // ── Default instance ────────────────────────────────────────────────────────

  const refreshDefault = useCallback(async () => {
    const d = await getDefaultInstance();
    const def = d?.url === baseUrl;
    setIsDefault(def);
    wvRef.current?.inject(
      `if(typeof window.vibeSetDefaultLabel==='function')` +
      `window.vibeSetDefaultLabel('${def ? '★ REMOVE DEFAULT' : '☆ SET AS DEFAULT'}');`
    );
  }, [baseUrl]);

  useEffect(() => { refreshDefault(); }, [refreshDefault]);

  // ── Background / foreground ─────────────────────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        wvRef.current?.inject(
          `try { if (typeof window._lsvExitAudioOnly === 'function') window._lsvExitAudioOnly(); } catch(e) {}`
        );
      } else {
        wvRef.current?.inject(
          `try { if (typeof window._lsvEnterAudioOnly === 'function') window._lsvEnterAudioOnly(); } catch(e) {}`
        );
      }
    });
    return () => sub.remove();
  }, []);

  // ── Android: listen for notification media-control events ──────────────────

  useEffect(() => {
    if (!MediaSvc) return;

    const sub = DeviceEventEmitter.addListener('vibeMediaControl', (action: string) => {
      switch (action) {
        case 'play':
          // Unmute if muted
          wvRef.current?.inject(
            `try { if (window.isMuted && typeof window.toggleMute==='function') window.toggleMute(); } catch(e) {}`
          );
          break;
        case 'pause':
          // Mute if not muted
          wvRef.current?.inject(
            `try { if (!window.isMuted && typeof window.toggleMute==='function') window.toggleMute(); } catch(e) {}`
          );
          break;
        case 'next':
          wvRef.current?.inject(
            `try { var b=document.getElementById('lsv-vts-rarr')||document.getElementById('vts-desktop-wrap-rarr'); if(b) b.click(); } catch(e) {}`
          );
          break;
        case 'prev':
          wvRef.current?.inject(
            `try { var b=document.getElementById('lsv-vts-larr')||document.getElementById('vts-desktop-wrap-larr'); if(b) b.click(); } catch(e) {}`
          );
          break;
      }
    });

    return () => {
      sub.remove();
      MediaSvc.stop();
    };
  }, []);

  // ── Navigation ──────────────────────────────────────────────────────────────

  const goBack = useCallback(() => {
    if (MediaSvc) MediaSvc.stop();
    navigation.goBack();
  }, [navigation]);

  const toggleDefault = useCallback(async () => {
    if (isDefault) {
      Alert.alert(
        'Remove Default',
        `Stop auto-connecting to "${instanceName ?? baseUrl}" on startup?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => { await clearDefaultInstance(); refreshDefault(); },
          },
        ],
      );
    } else {
      Alert.alert(
        'Set as Default',
        `Auto-connect to "${instanceName ?? baseUrl}" on every startup?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Set Default',
            onPress: async () => {
              await setDefaultInstance({ name: instanceName ?? baseUrl, url: baseUrl });
              refreshDefault();
            },
          },
        ],
      );
    }
  }, [isDefault, baseUrl, instanceName, refreshDefault]);

  // ── Message handler ─────────────────────────────────────────────────────────

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);

      if (msg.type === 'pref-set' && msg.key) {
        saveAppPref(msg.key as string, msg.value).catch(() => {});
        setAppPrefs(prev => ({ ...prev, [msg.key as string]: msg.value }));
      }

      if (msg.type === 'haptic') {
        const style = msg.style === 'light' ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Rigid;
        Haptics.impactAsync(style).catch(() => {});
      }
      if (msg.type === 'back')           goBack();
      if (msg.type === 'toggle-default') toggleDefault();
      if (msg.type === 'set-view-mode' && (msg.mode === 'default' || msg.mode === 'accessibility')) {
        setViewMode(msg.mode as ViewMode).catch(() => {});
      }
      if (msg.type === 'open-url' && msg.url) {
        navigation.navigate('WebViewer', { url: msg.url, title: msg.title });
      }

      // ── Android media service ──────────────────────────────────────────────
      if (MediaSvc) {
        if (msg.type === 'audio-started' && !mediaStarted.current) {
          mediaStarted.current = true;
          const title  = formatHz(msg.hz ?? 0);
          const artist = msg.station || instanceName || 'SDR Receiver';
          lastTitle.current  = title;
          lastArtist.current = artist;
          lastMuted.current  = false;
          MediaSvc.start(title, artist, true);
        }

        if (msg.type === 'state' && mediaStarted.current) {
          const title  = formatHz(msg.hz ?? 0);
          const artist = (msg.station as string) || instanceName || 'SDR Receiver';
          const muted  = !!(msg.muted);
          // Only push update if something changed
          if (title !== lastTitle.current || artist !== lastArtist.current || muted !== lastMuted.current) {
            lastTitle.current  = title;
            lastArtist.current = artist;
            lastMuted.current  = muted;
            MediaSvc.update(title, artist, !muted);
          }
        }
      }
    } catch { /* ignore */ }
  }, [goBack, toggleDefault, navigation, instanceName]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <WaterfallWebView
        ref={wvRef}
        url={baseUrl + '/'}
        viewMode={viewMode}
        appPrefs={appPrefs}
        onMessage={onMessage}
        onLoad={refreshDefault}
        onError={() =>
          Alert.alert('Connection Lost', 'Lost connection to SDR server', [
            { text: 'Back', onPress: goBack },
          ])
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
});
