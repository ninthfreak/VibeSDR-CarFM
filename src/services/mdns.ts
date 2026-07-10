import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

// mDNS/Bonjour auto-discovery of networked RTL-TCP servers. Platform-agnostic
// wrapper over the native discovery:
//   • iOS     — folded into VibePowerModule (NWBrowser), NativeModules.VibePowerModule
//   • Android — VibeMDNS module (NsdManager)
// Both emit the same events (VibeMdnsFound / VibeMdnsLost) via the device event
// emitter, so the only per-platform difference is which module hosts them.
//
// This is the App-Store-clean path: we only ever see servers that *advertise*
// `_rtl_tcp._tcp` — no subnet scanning. The advertiser (e.g. an mDNS record next
// to rtl_tcp on the UberSDR host) publishes host, port, and an optional `name`
// TXT record for a friendly label.

export type ServerProto = 'rtltcp' | 'vibeserver';
export type DiscoveredServer = {
  name: string; host: string; port: number;
  proto: ServerProto;   // which protocol the advertised server speaks
  pin: boolean;         // VibeServer only: whether it requires a PIN
};

const nativeModule: any =
  Platform.OS === 'ios'
    ? (NativeModules as any).VibePowerModule
    : (NativeModules as any).VibeMDNS;

const key = (host: string, port: number) => `${host}:${port}`;

/**
 * Start browsing for RTL-TCP servers. `onChange` is called with the full current
 * list whenever it changes. Returns a stop function — call it on unmount/blur.
 * No-ops safely (returns a stop fn that does nothing) if the native module is
 * unavailable on this build.
 */
export function startMdnsDiscovery(
  onChange: (servers: DiscoveredServer[]) => void,
): () => void {
  if (!nativeModule?.startDiscovery) return () => {};

  const emitter = new NativeEventEmitter(nativeModule);
  const byKey = new Map<string, DiscoveredServer>();
  const nameToKey = new Map<string, string>();

  const push = () => onChange(Array.from(byKey.values()));

  const foundSub = emitter.addListener('VibeMdnsFound', (e: any) => {
    const host = String(e?.host ?? '').trim();
    const port = Number(e?.port);
    if (!host || !Number.isFinite(port) || port <= 0) return;
    const name = String(e?.name ?? '').trim() || `${host}:${port}`;
    const proto: ServerProto = e?.proto === 'vibeserver' ? 'vibeserver' : 'rtltcp';
    const pin = !!e?.pin;
    const k = key(host, port);
    byKey.set(k, { name, host, port, proto, pin });
    if (e?.name) nameToKey.set(String(e.name), k);
    push();
  });

  // Removal events carry only the service name (host/port aren't re-resolved on
  // teardown), so map it back to the key we stored on discovery.
  const lostSub = emitter.addListener('VibeMdnsLost', (e: any) => {
    const svcName = String(e?.name ?? '');
    const k = nameToKey.get(svcName);
    if (k && byKey.delete(k)) {
      nameToKey.delete(svcName);
      push();
    }
  });

  try { nativeModule.startDiscovery(); } catch {}

  return () => {
    try { nativeModule.stopDiscovery?.(); } catch {}
    foundSub.remove();
    lostSub.remove();
  };
}

// ── Advertise (Android only): publish this device's RTL-TCP server ────────────
// Uses the Android VibeMDNS module (NsdManager). No-op on iOS (the server
// feature is Android-only). Call again with a new name to re-advertise.
export async function advertiseRtlTcp(name: string, port: number): Promise<void> {
  return advertiseServer(name, port, 'rtltcp', false);
}

// Advertise a server of either protocol. `pinRequired` publishes a `pin` TXT so
// clients know a VibeServer needs auth before they connect. Android-only.
export async function advertiseServer(
  name: string, port: number, proto: ServerProto, pinRequired: boolean,
): Promise<void> {
  const m: any = (NativeModules as any).VibeMDNS;
  if (Platform.OS !== 'android' || !m?.advertise) return;
  try { await m.advertise(name, port, proto, pinRequired); } catch {}
}

export function stopAdvertiseRtlTcp(): void {
  const m: any = (NativeModules as any).VibeMDNS;
  try { m?.stopAdvertise?.(); } catch {}
}
