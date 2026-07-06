import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Thin JS wrapper over the Android RTL-TCP SERVER native methods (VibeLocalSDR).
// The server shares this device's USB RTL-SDR over the LAN so another VibeSDR /
// SDR# can use it. Android-only (iOS has no USB host SDR).

const Local: any = (NativeModules as any).VibeLocalSDR;

export const rtlTcpServerSupported =
  Platform.OS === 'android' && !!Local?.startRtlTcpServer;

export type ServerInfo = { ip: string; port: number; name: string };
export type ServerStatus = {
  running: boolean;
  client: boolean;
  clientAddr: string;
  sampleRate: number;
  overrideRate: number;   // 0 = client-controlled
};

// Bandwidth override options. value 0 = client-controlled (default).
export const BANDWIDTH_OPTIONS: { label: string; value: number }[] = [
  { label: 'Client-controlled', value: 0 },
  { label: '3.2 MHz',           value: 3_200_000 },
  { label: '2.4 MHz',           value: 2_400_000 },
  { label: '2.048 MHz',         value: 2_048_000 },
  { label: '1.024 MHz',         value: 1_024_000 },
  { label: '0.25 MHz',          value: 250_000 },
];

const NAME_KEY = 'vsdr_rtltcp_server_name';

export async function getServerName(fallback = 'VibeSDR RTL-SDR'): Promise<string> {
  try { return (await AsyncStorage.getItem(NAME_KEY)) || fallback; } catch { return fallback; }
}
export async function saveServerName(name: string): Promise<void> {
  try { await AsyncStorage.setItem(NAME_KEY, name); } catch {}
}

export async function startRtlTcpServer(opts: {
  name: string; port?: number; overrideRate?: number;
}): Promise<ServerInfo> {
  return Local.startRtlTcpServer({
    name: opts.name,
    port: opts.port ?? 1234,
    overrideRate: opts.overrideRate ?? 0,
  });
}

export async function stopRtlTcpServer(): Promise<void> {
  try { await Local?.stopRtlTcpServer?.(); } catch {}
}

export function setServerSampleRate(rate: number): void {
  try { Local?.setServerSampleRate?.(rate); } catch {}
}

export async function getServerStatus(): Promise<ServerStatus | null> {
  try { return await Local?.getServerStatus?.(); } catch { return null; }
}
