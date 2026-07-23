import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert, Dimensions, NativeModules, Platform } from 'react-native';
// safe-area-context SafeAreaView — RN's own is iOS-only.
import { SafeAreaView } from 'react-native-safe-area-context';
import { splashBridge } from '../../App';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { newLocalSession } from '../services/localSession';
import { getUserLocation } from '../services/instancesApi';
import {
  DefaultInstance,
  getDefaultInstance,
} from '../services/defaultInstance';
import { isDeepLinkActive, whenInitialLinkChecked } from '../linking/deepLinkState';
import { ViewMode, getViewMode, setViewMode } from '../services/viewMode';
import { VibePowerModule } from '../components/AudioPlayer';
import { getCarAutostart } from '../services/carMode';

type Props = NativeStackScreenProps<RootStackParamList, 'InstancePicker'>;

/**
 * Boot router.
 *
 * This screen used to be the VibeSDR server picker — a full directory browser,
 * favourites list, custom-server box and RTL-TCP/SpyServer add flows. CarFM has
 * no use for any of that: launch goes straight into the FM face. So the visible
 * picker was gutted; what remains is pure launch orchestration that decides,
 * once, where a cold start lands and then navigates away. It renders nothing but
 * a dark hold-splash — the user never sees this screen.
 *
 * Launch decision order (all on Android; other platforms just fall through to a
 * plain dark screen since there is no picker to show):
 *   1. USB_DEVICE_ATTACHED (plugged in an RTL-SDR to launch)      → Local Hardware
 *   2. Car autostart with a dongle already attached at boot        → Local Hardware
 *   3. Otherwise                                                   → tunerless FM face
 * Deep links (carfm://, spyserver://) and the dev `noAutoConnect` param stand
 * down from the auto-connect so they can own the session.
 */
export default function InstancePickerScreen({ navigation, route }: Props) {
  // Android boots straight into the CarFM face; hold a plain dark splash until
  // then so nothing flashes up. Cleared only if we end up NOT redirecting
  // (non-Android, deep link, or noAutoConnect dev paths).
  const [booting,     setBooting]       = useState(Platform.OS === 'android');
  const [connecting,  setConnecting]    = useState(false);
  const [defaultInst, setDefaultInst]   = useState<DefaultInstance | null>(null);
  // Tell native the default-instance name (or '' = none) so it can auto-connect,
  // or prompt the user to set a default.
  useEffect(() => { VibePowerModule?.setDefaultInstance?.(defaultInst?.name ?? ''); }, [defaultInst]);
  const [viewMode,    setViewModeState] = useState<ViewMode>('default');
  const [modeReady,   setModeReady]     = useState(false);

  // Assigned once connectLocal is defined below; the mount + focus effects
  // (declared above those callbacks) call it through these refs to avoid a
  // use-before-declaration cycle.
  const tryUsbLaunchRef = useRef<null | ((m?: ViewMode) => Promise<boolean>)>(null);
  const tryCarAutostartRef = useRef<null | ((m?: ViewMode) => Promise<boolean>)>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAndInit() {
      let mode = await getViewMode();
      if (cancelled) return;
      const { width } = Dimensions.get('window');
      const isSmallScreen = width <= 390;
      if (!mode) {
        if (isSmallScreen) { await setViewMode('accessibility'); mode = 'accessibility'; }
        else { navigation.replace('InstancePicker'); return; }
      } else if (isSmallScreen && mode !== 'accessibility') {
        await setViewMode('accessibility'); mode = 'accessibility';
      }
      setViewModeState(mode);
      setModeReady(true);

      const dEarly = await getDefaultInstance();
      if (!cancelled && dEarly) {
        setDefaultInst(dEarly);
        splashBridge.updateLabel(dEarly.name || dEarly.url);
      }

      // Learn the user's location for distance sorting (used elsewhere), but
      // fire-and-forget, NEVER awaited: on Android this can pop the runtime
      // location-permission dialog, and awaiting it would gate every carFm exit
      // path below. Launch does not need location.
      getUserLocation().catch(() => {});

      // Launched by plugging in an RTL-SDR? Go straight to Local Hardware and skip
      // the default-instance auto-connect below (which would otherwise win the
      // race and open the default server / leave us on the picker).
      if (!cancelled && await tryUsbLaunchRef.current?.(mode)) return;
      // CarFM: a permanent install boots with the dongle already attached, so no
      // USB_DEVICE_ATTACHED fires. If a dongle is present and autostart is on,
      // connect it and drop into the FM face — the SDR screen restores the last
      // station. Guarded like the default-instance connect below (link).
      if (!cancelled && !isDeepLinkActive()
          && !route.params?.noAutoConnect
          && await tryCarAutostartRef.current?.(mode)) return;
      if (!cancelled) splashBridge.dismiss();

      // CarFM: NO dongle at launch — go straight into the FM face anyway, as a
      // TUNERLESS session. The face shows its tuner-error pill (the designed
      // no-tuner state); there is no background polling — a dongle plugged in
      // later is connected on demand via the settings panel's RETRY action.
      if (!cancelled && Platform.OS === 'android'
          && !isDeepLinkActive()
          && !route.params?.noAutoConnect) {
        navigation.navigate('SDR', {
          baseUrl: 'ws://127.0.0.1:1', instanceName: 'Local Hardware',
          viewMode: mode, serverType: 'ubersdr',
          isLocal: true, carFm: true, tunerless: true,
        });
        return;
      }

      // Reached only when we did NOT redirect into CarFM (non-Android, deep link,
      // noAutoConnect) — so reveal the (now blank) screen instead of the splash.
      if (!cancelled) setBooting(false);

      // A default instance still auto-connects straight through — unless a
      // carfm:// deep link is driving this launch (it owns the session and
      // resets us to its target; auto-connecting to the default would stomp it).
      //
      // WAIT for the cold-start link probe before deciding. getInitialURL() is
      // async, so merely SAMPLING the flag here races it.
      await whenInitialLinkChecked();
      // `noAutoConnect` is the durable "stand down" form.
      if (route.params?.noAutoConnect) return;
      if (!cancelled && dEarly && !isDeepLinkActive()) {
        navigation.navigate('SDR', { baseUrl: dEarly.url, instanceName: dEarly.name, viewMode: mode, serverLongitude: null });
      }
    }

    loadAndInit();
    return () => { cancelled = true; };
  }, []);

  const firstFocusRef = useRef(true);
  useFocusEffect(useCallback(() => {
    getViewMode().then(mode => { if (mode) setViewModeState(mode); });
    // Re-read the default on every focus — the SDR menu can set/clear it, and
    // returning here doesn't remount (keeps the native default-instance name in
    // sync via the effect above).
    getDefaultInstance().then(d => setDefaultInst(d)).catch(() => {});
    // Skip the initial focus (loadAndInit owns the launch-time USB check — running
    // it here too would race the read-and-clear flag). On LATER focuses (returning
    // from an SDR session), pick up an RTL-SDR that was plugged in while away.
    if (firstFocusRef.current) { firstFocusRef.current = false; return; }
    tryUsbLaunchRef.current?.();
  }, []));

  // V4 local hardware (Android only): start the on-device shim (RTL-SDR over
  // USB OTG) and connect to it on localhost. Returns true only when it actually
  // navigated into a session — the carFm launch paths (tryUsbLaunch/
  // tryCarAutostart) hand the launch back to the tunerless fallback on failure
  // instead of stranding the user. `quiet` suppresses the failure Alert on those
  // paths: the FM face's tuner-error pill (RETRY reconnects on demand) is the
  // designed failure surface there.
  const connectLocal = useCallback(async (modeOverride?: ViewMode, quiet?: boolean): Promise<boolean> => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.startSpectrum) { if (!quiet) Alert.alert('Local Hardware', 'Not available on this build.'); return false; }
    setConnecting(true);
    try {
      const res = await Local.startSpectrum({
        // fftSize 8192 over 2.4 MHz ≈ 293 Hz/bin (sharp AM/SSB); fftRate 10 to
        // match UberSDR's line cadence so the waterfall interpolation lines up.
        centerFreq: 100_000_000, sampleRate: 2_400_000, fftSize: 8192, fftRate: 10, mode: 'wfm',
      }) as { port: number; wsBaseUrl: string };
      setConnecting(false);
      navigation.navigate('SDR', {
        baseUrl: res.wsBaseUrl, instanceName: 'Local Hardware', viewMode: modeOverride ?? viewMode,
        serverType: 'ubersdr', isLocal: true, localPort: res.port,
        localGen: newLocalSession(), carFm: true,
      });
      return true;
    } catch (e: any) {
      setConnecting(false);
      if (!quiet) Alert.alert('Local Hardware', e?.message ?? 'Could not start local SDR. Is an RTL-SDR plugged in via USB OTG?');
      return false;
    }
  }, [navigation, viewMode]);

  // Route straight into Local Hardware when the app was launched/resumed by
  // plugging in an RTL-SDR (USB_DEVICE_ATTACHED). Returns true if it claimed the
  // launch, so the caller skips the default-instance auto-connect. Native flag is
  // read-and-cleared, so it fires once per attach.
  const tryUsbLaunch = useCallback(async (modeArg?: ViewMode): Promise<boolean> => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.consumeUsbLaunch) return false;
    let pending = false;
    try { pending = await Local.consumeUsbLaunch(); } catch { pending = false; }
    if (!pending) return false;
    splashBridge.dismiss();
    // CarFM: a plugged-in dongle means LISTEN, always — auto-grab, no prompt.
    // On failure (USB permission denied, shim start error) return false so
    // loadAndInit falls through to the tunerless FM face.
    return await connectLocal(modeArg, true);
  }, [connectLocal]);
  tryUsbLaunchRef.current = tryUsbLaunch;

  // CarFM autostart: no attach intent (dongle was already plugged in at boot).
  // If autostart is on and an RTL-SDR is present, connect straight to it with no
  // prompt so the app comes up playing the last station. Returns true if claimed.
  const tryCarAutostart = useCallback(async (modeArg?: ViewMode): Promise<boolean> => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.listDevices) return false;
    if (!(await getCarAutostart())) return false;
    let devs: unknown;
    try { devs = await Local.listDevices(); } catch { return false; }
    if (!Array.isArray(devs) || devs.length === 0) return false;   // no dongle → tunerless face
    splashBridge.dismiss();
    // Claim the launch ONLY if the session actually started; returning false
    // hands the launch to the tunerless FM face, whose tuner-error pill owns
    // retries (settings RETRY).
    return await connectLocal(modeArg, true);
  }, [connectLocal]);
  tryCarAutostartRef.current = tryCarAutostart;

  // SpyServer-compatible network IQ -> on-device shim (used by spyserver:// deep
  // links). Same wiring as Local Hardware; the server dictates the sample rate.
  const connectSpy = useCallback(async (host: string, port: number, name: string,
                                       sessionLimitMins?: number) => {
    const Local = (NativeModules as any).VibeLocalSDR;
    if (!Local?.startSpyServer) { Alert.alert('SpyServer', 'Not available on this build.'); return; }
    setConnecting(true);
    try {
      const res = await Local.startSpyServer({
        host, port,
        centerFreq: 100_000_000, fftSize: 8192, fftRate: 10, mode: 'wfm',
      }) as { port: number; wsBaseUrl: string };
      setConnecting(false);
      navigation.navigate('SDR', {
        baseUrl: res.wsBaseUrl, instanceName: name || `${host}:${port}`, viewMode,
        serverType: 'ubersdr', isLocal: true, isTcp: true, localPort: res.port,
        tcpHost: host, tcpPort: port, localGen: newLocalSession(),
        sessionLimitMins,
      });
    } catch (e: any) {
      setConnecting(false);
      Alert.alert('SpyServer', e?.message ?? `Could not connect to ${host}:${port}.`);
    }
  }, [navigation, viewMode]);

  // spyserver:// deep link → auto-connect once. Guard with a ref + clear the
  // param so a failed connect leaves the user put (connectSpy's own Alert is the
  // error UX) instead of a retry loop.
  const autoSpyFired = useRef(false);
  const autoSpy = route.params?.autoSpy;
  useEffect(() => {
    if (!autoSpy) { autoSpyFired.current = false; return; }
    if (autoSpyFired.current || connecting) return;
    autoSpyFired.current = true;
    navigation.setParams({ autoSpy: undefined });
    connectSpy(autoSpy.host, autoSpy.port, `${autoSpy.host}:${autoSpy.port}`);
  }, [autoSpy, connecting, connectSpy, navigation]);

  void modeReady;
  // Nothing to show — this screen is a pure boot router. Hold a dark splash while
  // deciding, then a blank dark screen on the non-redirect paths (the FM face
  // takes over via navigation).
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#161E29' }} />;
}
