import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Animated, ActivityIndicator, LogBox, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
LogBox.ignoreAllLogs();

import InstancePickerScreen from './src/screens/InstancePickerScreen';
import SDRScreen            from './src/screens/SDRScreen';
import CrashBoundary        from './src/components/CrashBoundary';
import { installCrashGuard } from './src/services/crashGuard';
import { ThemeProvider }    from './src/contexts/ThemeContext';
import type { ViewMode }    from './src/services/viewMode';
import type { SDRMode }     from './src/services/UberSDRClient';
import { useDeepLinks }     from './src/linking/useDeepLinks';

export type RootStackParamList = {
  InstancePicker: undefined;
  SDR: {
    baseUrl:         string;
    password?:       string;
    instanceName?:   string;
    viewMode:        ViewMode;
    serverLongitude?: number | null;
    serverType?:     'ubersdr' | 'kiwi' | 'owrx';   // v3 multi-backend; default ubersdr
    // V4 local hardware (Android): connect to the on-device shim on localhost.
    // Audio comes from its /ws/audio (external-PCM engine), not the UberSDR /ws.
    isLocal?:        boolean;
    localPort?:      number;
    // RTL-TCP: same on-device shim but fed IQ from an rtl_tcp server over the
    // network (no USB → works on iOS). Reuses the isLocal wiring; isTcp drives the
    // RTL-TCP icon/labels, tcpHost/tcpPort allow reconnect.
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
  };
};

export const splashBridge = {
  dismiss:     (_target?: string) => {},
  updateLabel: (_label: string)   => {},
};

// Decorative spectrum + waterfall graphic for the splash heading. Purely
// cosmetic — a static synthesised trace so the launch screen reads as an SDR.
function SplashSpectrum() {
  // A peaky spectrum envelope (0..1), centre-weighted with a couple of signals.
  const bars = [
    0.10, 0.14, 0.12, 0.18, 0.55, 0.22, 0.16, 0.20, 0.30, 0.85,
    0.95, 0.78, 0.32, 0.22, 0.18, 0.40, 0.25, 0.16, 0.62, 0.70,
    0.38, 0.20, 0.15, 0.24, 0.12, 0.16, 0.10, 0.14, 0.11, 0.09,
  ];
  const W = 220, SPEC_H = 46, WF_H = 30, GAP = 2;
  const bw = (W - GAP * (bars.length - 1)) / bars.length;
  // Three waterfall rows fading downward — older lines dimmer.
  const wfRows = [0.85, 0.55, 0.3];
  return (
    <View style={{ width: W, marginBottom: 22, alignItems: 'center' }}>
      {/* Spectrum bars */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: SPEC_H, width: W }}>
        {bars.map((v, i) => (
          <View key={i} style={{
            width: bw, marginRight: i === bars.length - 1 ? 0 : GAP,
            height: Math.max(2, v * SPEC_H),
            backgroundColor: `rgba(255,184,51,${0.35 + v * 0.6})`,
            borderTopLeftRadius: 1, borderTopRightRadius: 1,
          }} />
        ))}
      </View>
      {/* Waterfall — a few rows of the same envelope, fading down */}
      <View style={{ width: W, height: WF_H, marginTop: 3, borderRadius: 2, overflow: 'hidden' }}>
        {wfRows.map((alpha, r) => (
          <View key={r} style={{ flexDirection: 'row', height: WF_H / wfRows.length, width: W }}>
            {bars.map((v, i) => (
              <View key={i} style={{
                width: bw, marginRight: i === bars.length - 1 ? 0 : GAP,
                flex: undefined,
                backgroundColor: `rgba(255,${120 + v * 90},${20 + v * 30},${v * alpha})`,
              }} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const Stack = createNativeStackNavigator<RootStackParamList>();
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

export default function App() {
  // Install the global JS crash guard once — flaky SDR servers must never abort
  // the whole app; recover to the picker with a server-attributed message.
  useEffect(() => { installCrashGuard(navigationRef); }, []);

  const [fontsLoaded] = useFonts({
    'Nixie One':              require('./assets/fonts/NixieOne-Regular.ttf'),
    'Atkinson Hyperlegible':  require('./assets/fonts/AtkinsonHyperlegible-Regular.ttf'),
  });

  const [splashDone, setSplashDone]   = useState(false);
  const [splashLabel, setSplashLabel] = useState('CONNECTING TO INSTANCE LIST');
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
    AsyncStorage.getItem(SPLASH_SEEN_KEY).then((v) => {
      const first = v !== '1';
      firstOpenRef.current = first;
      setFirstOpen(first);
    }).catch(() => { firstOpenRef.current = false; setFirstOpen(false); });
  }, []);

  const fadeSplash = useCallback(() => {
    Animated.timing(splashOpacity, { toValue: 0, duration: 450, useNativeDriver: true })
      .start(() => setSplashDone(true));
  }, [splashOpacity]);

  splashBridge.dismiss = useCallback((target?: string) => {
    if (target) setSplashLabel(`CONNECTING TO:\n${target.toUpperCase()}`);
    // On first launch hold the splash open — the user dismisses it with the
    // CONTINUE button so the power-saving notice is actually read.
    if (firstOpenRef.current) return;
    fadeSplash();
  }, [fadeSplash]);
  splashBridge.updateLabel = (label: string) => setSplashLabel(label.toUpperCase());

  const handleContinue = useCallback(() => {
    firstOpenRef.current = false;
    AsyncStorage.setItem(SPLASH_SEEN_KEY, '1').catch(() => {});
    fadeSplash();
  }, [fadeSplash]);

  // vibesdr:// deep links — drain once fonts are loaded and the first-open flag
  // has resolved (so we don't navigate before the nav container is mounted).
  useDeepLinks(fontsLoaded && firstOpen !== undefined);

  // Hold splash until fonts are ready — prevents flash of Courier New fallback
  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
      <View style={{ flex: 1, backgroundColor: '#080601' }}>
        <CrashBoundary>
        <NavigationContainer ref={navigationRef}>
          <StatusBar style="light" />
          <Stack.Navigator
            initialRouteName="InstancePicker"
            screenOptions={{
              headerStyle:      { backgroundColor: '#0A0A12' },
              headerTintColor:  '#FFB833',
              headerTitleStyle: { fontFamily: 'Courier' },
              contentStyle:     { backgroundColor: '#0A0A12' },
              animation:        'fade',
            }}
          >
            <Stack.Screen name="InstancePicker" component={InstancePickerScreen} options={{ headerShown: false }} />
            <Stack.Screen name="SDR"            component={SDRScreen}            options={{ headerShown: false, gestureEnabled: false }} />
          </Stack.Navigator>
        </NavigationContainer>
        </CrashBoundary>

        {!splashDone && (
          <Animated.View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: '#0A0A12', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, opacity: splashOpacity,
          }}>
            <SplashSpectrum />
            <Text style={{ color: '#FFB833', fontSize: 22, fontFamily: 'Courier', fontWeight: 'bold' }}>
              VibeSDR
            </Text>
            <Text style={{ color: 'rgba(255,184,51,0.6)', fontSize: 11, fontFamily: 'Courier', marginTop: 12, textAlign: 'center' }}>
              {splashLabel}
            </Text>
            {firstOpen ? (
              <TouchableOpacity
                onPress={handleContinue}
                activeOpacity={0.85}
                style={{
                  marginTop: 26, paddingVertical: 10, paddingHorizontal: 30,
                  borderRadius: 8, borderWidth: 1, borderColor: '#FFB833',
                  backgroundColor: 'rgba(255,184,51,0.12)',
                }}>
                <Text style={{ color: '#FFB833', fontSize: 13, fontFamily: 'Courier', fontWeight: 'bold', letterSpacing: 1 }}>
                  CONTINUE
                </Text>
              </TouchableOpacity>
            ) : (
              <ActivityIndicator color="#FFB833" style={{ marginTop: 28 }} />
            )}

            <View style={{ position: 'absolute', bottom: 40, left: 28, right: 28 }}>
              <Text style={{ color: 'rgba(255,184,51,0.9)', fontSize: 11, fontFamily: 'Courier', fontWeight: 'bold', textAlign: 'center', marginBottom: 10, letterSpacing: 1 }}>
                POWER-SAVING BEHAVIOUR
              </Text>
              <Text style={{ color: 'rgba(255,184,51,0.55)', fontSize: 10.5, fontFamily: 'Courier', textAlign: 'center', lineHeight: 16 }}>
                When you switch away from VibeSDR the waterfall and spectrum fully freeze to save power. They take a second or two to resume when you return — this is normal.{'\n\n'}
                After 30 seconds the waterfall and spectrum slow down to save power. This can be turned off in the menu.{'\n\n'}
                Full pausing in the background is by design and cannot be disabled.
              </Text>
            </View>
          </Animated.View>
        )}
      </View>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
