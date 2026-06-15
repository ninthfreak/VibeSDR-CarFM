import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { Animated, ActivityIndicator, LogBox, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
LogBox.ignoreAllLogs();

import InstancePickerScreen from './src/screens/InstancePickerScreen';
import SDRScreen            from './src/screens/SDRScreen';
import CrashBoundary        from './src/components/CrashBoundary';
import { installCrashGuard } from './src/services/crashGuard';
import { ThemeProvider }    from './src/contexts/ThemeContext';
import type { ViewMode }    from './src/services/viewMode';

export type RootStackParamList = {
  InstancePicker: undefined;
  SDR: {
    baseUrl:         string;
    password?:       string;
    instanceName?:   string;
    viewMode:        ViewMode;
    serverLongitude?: number | null;
    serverType?:     'ubersdr' | 'kiwi' | 'owrx';   // v3 multi-backend; default ubersdr
  };
};

export const splashBridge = {
  dismiss:     (_target?: string) => {},
  updateLabel: (_label: string)   => {},
};

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

  splashBridge.dismiss = useCallback((target?: string) => {
    if (target) setSplashLabel(`CONNECTING TO:\n${target.toUpperCase()}`);
    Animated.timing(splashOpacity, { toValue: 0, duration: 450, useNativeDriver: true })
      .start(() => setSplashDone(true));
  }, [splashOpacity]);
  splashBridge.updateLabel = (label: string) => setSplashLabel(label.toUpperCase());

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
            <Text style={{ color: '#FFB833', fontSize: 22, fontFamily: 'Courier', fontWeight: 'bold' }}>
              VibeSDR
            </Text>
            <Text style={{ color: 'rgba(255,184,51,0.6)', fontSize: 11, fontFamily: 'Courier', marginTop: 12, textAlign: 'center' }}>
              {splashLabel}
            </Text>
            <ActivityIndicator color="#FFB833" style={{ marginTop: 28 }} />
          </Animated.View>
        )}
      </View>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
