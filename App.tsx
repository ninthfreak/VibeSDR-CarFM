import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Animated, ActivityIndicator, LogBox, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import { setBandFontsReady } from './src/components/carfm/bandThemes';
LogBox.ignoreAllLogs();

import InstancePickerScreen from './src/screens/InstancePickerScreen';
import SDRScreen            from './src/screens/SDRScreen';
import RtlTcpServerScreen   from './src/screens/RtlTcpServerScreen';
import ServerModeScreen     from './src/screens/ServerModeScreen';
import TunerScreen          from './src/screens/TunerScreen';
import CrashBoundary        from './src/components/CrashBoundary';
import { installCrashGuard } from './src/services/crashGuard';
import { ThemeProvider }    from './src/contexts/ThemeContext';
import type { ViewMode }    from './src/services/viewMode';
import type { SDRMode }     from './src/services/UberSDRClient';
import { useDeepLinks }     from './src/linking/useDeepLinks';

export type RootStackParamList = {
  // autoSpy: set by an `sdr://host:port` deep link → the picker auto-runs
  // connectSpy() once, then clears the param (see InstancePickerScreen).
  InstancePicker: {
    autoSpy?: { host: string; port: number };
    /** Sit in the stack WITHOUT auto-connecting to the default.
     *
     *  A watch-driven boot resets to [InstancePicker, target] so that BACK still has
     *  somewhere to go — but the picker auto-connects to the default the moment it
     *  mounts, which would drag the user straight back off the server the watch just
     *  chose. This says "be here, but don't take over". */
    noAutoConnect?: boolean;
  } | undefined;
  SDR: {
    baseUrl:         string;
    password?:       string;
    instanceName?:   string;
    viewMode:        ViewMode;
    serverLongitude?: number | null;
    serverType?:     'ubersdr' | 'kiwi' | 'owrx';   // v3 multi-backend; default ubersdr
    // NB FM-DX servers route to the 'Tuner' screen instead (see below), not here.
    // V4 local hardware (Android): connect to the on-device shim on localhost.
    // Audio comes from its /ws/audio (external-PCM engine), not the UberSDR /ws.
    isLocal?:        boolean;
    localPort?:      number;
    // VibeServer (remote shim): the LAN host serving /ws/audio + /ws/user-spectrum,
    // and the PIN auth query suffix ("&vs_nonce=&vs_auth="). Absent for a local
    // (loopback) session, which stays on 127.0.0.1 with no auth.
    localHost?:      string;
    authSuffix?:     string;
    // RTL-TCP: same on-device shim but fed IQ from an rtl_tcp server over the
    // network (no USB → works on iOS). Reuses the isLocal wiring; isTcp drives the
    // RTL-TCP icon/labels, tcpHost/tcpPort allow reconnect.
    // Some public receivers cap how long one listener may stay (SpyServer's
    // maxSessionDuration; other directories expose the same idea). 0/undefined =
    // unlimited. Drives the on-connect warning and the countdown by the clock.
    sessionLimitMins?: number;
    isTcp?:          boolean;
    tcpHost?:        string;
    tcpPort?:        number;
    // Local-session generation (see services/localSession): the unmount cleanup
    // only stops the shim if this is still the latest session, so a stale screen
    // can't tear down a newer one when switching instances.
    localGen?:       number;
    // vibesdr:// deep link: connect and optionally apply an initial tune. These
    // override the persisted last-tune for this instance on first connect only.
    deepLink?:       boolean;
    initialFreq?:    number;
    initialMode?:    SDRMode;
    initialZoom?:    number;
    // CarFM fork: this is the car FM-radio use (local USB dongle or rtl_tcp dev
    // loop). Switches the MediaSession to the RDS->MediaMetadata mapping the
    // ESP32 display expects (RT->title, PS->artist, freq->album) and defaults
    // media ⏮/⏭ to stepping presets. Non-car SDR sessions leave it unset.
    carFm?:          boolean;
    // CarFM launched with NO tuner present: no backend client is created; the
    // FM face renders with the tuner-error pill and the screen polls for a
    // dongle, replacing itself with a real local session when one appears.
    tunerless?:      boolean;
  };
  // Server mode (Android): pick a sharing protocol (VibeServer / RTL-TCP) for
  // this device's USB dongle, with shared PIN + auto-discovery options.
  ServerMode: { name?: string } | undefined;
  // RTL-TCP server (Android): share this device's USB dongle over the network.
  // `advertise` (default true) lets the Server-mode picker honour the shared
  // auto-discovery toggle.
  RtlTcpServer: { name?: string; advertise?: boolean } | undefined;
  // FM-DX Webserver (v7): single shared FM tuner, server-side demod + RDS, MP3
  // audio. Distinct tuner UI (no waterfall) — see TunerScreen.
  Tuner: {
    baseUrl:       string;
    instanceName?: string;
    viewMode:      ViewMode;
    initialFreq?:  number;   // deep-link retune (retunes the shared tuner for all)
  };
};

export const splashBridge = {
  dismiss:     (_target?: string) => {},
  updateLabel: (_label: string)   => {},
  // True once the splash overlay has fully faded away. On FIRST launch the splash
  // is held open until the user taps CONTINUE on the power-saving notice, so any
  // first-run coachmark tour must wait for this — otherwise the tutorial draws
  // ON TOP of the splash (bug present since the info splash was added). Screens
  // subscribe via whenDismissed().
  dismissed: false,
  _waiters: [] as Array<() => void>,
  whenDismissed(cb: () => void): () => void {
    if (this.dismissed) { cb(); return () => {}; }
    this._waiters.push(cb);
    return () => { this._waiters = this._waiters.filter((w) => w !== cb); };
  },
  _notifyDismissed() {
    if (this.dismissed) return;
    this.dismissed = true;
    const w = this._waiters; this._waiters = [];
    w.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  },
};

const Stack = createNativeStackNavigator<RootStackParamList>();
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export default function App() {
  // Install the global JS crash guard once — flaky SDR servers must never abort
  // the whole app; recover to the picker with a server-attributed message.
  useEffect(() => { installCrashGuard(navigationRef); }, []);

  // FIRST PAINT waits only on the three UI faces. The nine band-theme display
  // faces (§12 Easter eggs) are decorative — gating render on all twelve meant a
  // blank screen until every one of them had loaded, which is a large part of the
  // slow startup. They load in parallel and announce themselves when ready; a
  // theme falls back to the default face until then, and eggs resolve off
  // RadioText (seconds after launch) so they are always ready in practice.
  const [fontsLoaded] = useFonts({
    'Nixie One':              require('./assets/fonts/NixieOne-Regular.ttf'),
    'Atkinson Hyperlegible':  require('./assets/fonts/AtkinsonHyperlegible-Regular.ttf'),
    // Real bold cut as its own family: Android fake-bolds a single family,
    // which reads lighter than the design's true 700 (design handoff §3).
    'AtkinsonHyperlegible-Bold': require('./assets/fonts/AtkinsonHyperlegible-Bold.ttf'),
  });
  // Band-theme display faces — the REAL supplied faces from the v1.12.0 handoff
  // (fonts/), bundled as res/font. No stand-ins, no network fetch; a theme's
  // identity is its typeface (EASTER-EGGS-BUILD §1.1, family names verbatim).
  const [bandFontsLoaded] = useFonts({
    'Squealer':         require('./assets/fonts/Squealer.otf'),          // AC/DC
    'BeatlesYellowSub': require('./assets/fonts/BeatlesYellowSub.ttf'),  // The Beatles (body)
    'SgtPeppers':       require('./assets/fonts/SgtPeppers.ttf'),        // The Beatles (hero — see EASTER-EGGS §4)
    'MadieRoger':       require('./assets/fonts/MadieRoger.ttf'),        // The Beatles (genre)
    'PermanentMarker':  require('./assets/fonts/PermanentMarker.ttf'),   // Nirvana (body)
    'Onyx':             require('./assets/fonts/Onyx.ttf'),              // Nirvana (hero, 1.5×)
    'Gridnik':          require('./assets/fonts/Gridnik.otf'),           // Nine Inch Nails (body/hero)
    'Singothic':        require('./assets/fonts/Singothic.ttf'),         // Nine Inch Nails (genre/RT/freq)
    'Anton':            require('./assets/fonts/Anton-Regular.ttf'),     // Talking Heads
  });
  useEffect(() => { setBandFontsReady(!!bandFontsLoaded); }, [bandFontsLoaded]);

  const [splashDone, setSplashDone]   = useState(false);
  const splashOpacity = useRef(new Animated.Value(1)).current;

  // First launch shows the power-saving info and waits for the user to tap
  // CONTINUE (so they can actually read it); every later launch reverts to the
  // brief connecting splash that auto-dismisses once the picker/instance is up.
  // `undefined` while we read the flag — keeps the splash from flashing the
  // wrong variant before AsyncStorage resolves.
  const SPLASH_SEEN_KEY = 'lsv_splash_info_seen_v1';
  const [firstOpen, setFirstOpen] = useState<boolean | undefined>(undefined);
  const firstOpenRef = useRef(false);
  useEffect(() => {
    // CarFM: the stock first-open power-saving notice (hold splash + CONTINUE)
    // is scrubbed — it explains waterfall behaviour that the radio face never
    // shows. The splash always auto-dismisses.
    firstOpenRef.current = false;
    setFirstOpen(false);
    AsyncStorage.setItem(SPLASH_SEEN_KEY, '1').catch(() => {});
  }, []);

  const fadeSplash = useCallback(() => {
    Animated.timing(splashOpacity, { toValue: 0, duration: 450, useNativeDriver: true })
      .start(() => { setSplashDone(true); splashBridge._notifyDismissed(); });
  }, [splashOpacity]);

  // The overlay is a plain solid screen (no logo, no wordmark, no status text —
  // the user explicitly wants NO splash imagery), so the label updates are no-ops;
  // the bridge signatures stay for the callers.
  splashBridge.dismiss = useCallback((_target?: string) => {
    if (firstOpenRef.current) return;
    fadeSplash();
  }, [fadeSplash]);
  splashBridge.updateLabel = (_label: string) => {};

  // vibesdr:// deep links — drain once fonts are loaded and the first-open flag
  // has resolved (so we don't navigate before the nav container is mounted).
  useDeepLinks(fontsLoaded && firstOpen !== undefined);

  // Hold splash until fonts are ready — prevents flash of Courier New fallback
  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
      <View style={{ flex: 1, backgroundColor: '#161E29' }}>
        <CrashBoundary>
        <NavigationContainer ref={navigationRef}>
          <StatusBar style="light" />
          <Stack.Navigator
            initialRouteName="InstancePicker"
            screenOptions={{
              // CarFM palette (headers are hidden on every screen, but these bleed
              // through on transitions — keep them off the old VibeSDR scheme).
              headerStyle:      { backgroundColor: '#161E29' },
              headerTintColor:  '#2E86FF',
              contentStyle:     { backgroundColor: '#161E29' },
              animation:        'fade',
            }}
          >
            <Stack.Screen name="InstancePicker" component={InstancePickerScreen} options={{ headerShown: false }} />
            <Stack.Screen name="SDR"            component={SDRScreen}            options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="ServerMode"     component={ServerModeScreen}     options={{ headerShown: false }} />
            <Stack.Screen name="RtlTcpServer"   component={RtlTcpServerScreen}   options={{ headerShown: false }} />
            <Stack.Screen name="Tuner"          component={TunerScreen}          options={{ headerShown: false }} />
          </Stack.Navigator>
        </NavigationContainer>
        </CrashBoundary>

        {/* Launch overlay: a PLAIN solid CarFM-dark screen that hides the picker
            handoff, then fades. Deliberately NOTHING on it — no logo, no wordmark,
            no spectrum art, no status text. (Was VibeSDR's amber-on-black SDR
            splash, which survived the rebrand with its title swapped.) */}
        {!splashDone && (
          <Animated.View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: '#161E29', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, opacity: splashOpacity,
          }}>
            <ActivityIndicator color="rgba(255,255,255,0.3)" />
          </Animated.View>
        )}
      </View>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
