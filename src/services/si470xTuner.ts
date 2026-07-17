/**
 * Backend C (tuner-backends addendum §4): thin JS surface over the native
 * Si470x session. ADDITIVE support only — nothing subscribes or starts this
 * yet; the face keeps running the RTL-SDR path untouched. Wire-up into the
 * session/registry (probe order Si470x → RTL-SDR → rtl_tcp, §7) happens after
 * the driver's first hardware contact, since the HID framing is VERIFY-flagged.
 *
 * RDS arrives pre-decoded by the SHARED vibedsp decoder (via the JNI bridge):
 * VibeSi470xMeta carries the same JSON fields as the shim's {"type":"rds"}
 * frame, so the eventual session adapter reuses the existing mapping.
 */
import { NativeEventEmitter, NativeModules } from 'react-native';

export interface Si470xDevice { deviceName: string; vendorId: number; productId: number; }
export interface Si470xStatus { rssi: number; stereo: boolean; freqKHz: number; }

interface NativeSi470x {
  listSi470x(): Promise<Si470xDevice[]>;
  startSi470x(freqKHz: number): Promise<{ freqKHz: number }>;
  stopSi470x(): void;
  si470xTune(freqKHz: number): Promise<number>;
  si470xSeek(up: boolean): Promise<number | null>;
}

const Native = (NativeModules as { VibeLocalSDR?: Partial<NativeSi470x> }).VibeLocalSDR;

export const si470xAvailable = () => !!Native?.listSi470x;

export async function listSi470x(): Promise<Si470xDevice[]> {
  try { return (await Native?.listSi470x?.()) ?? []; } catch { return []; }
}

export const startSi470x = (freqKHz: number) => Native!.startSi470x!(freqKHz);
export const stopSi470x = () => Native?.stopSi470x?.();
export const si470xTune = (freqKHz: number) => Native!.si470xTune!(freqKHz);
export const si470xSeek = (up: boolean) => Native!.si470xSeek!(up);

/** Subscribe to RDS (parsed rds-frame JSON) + status. Returns unsubscribe. */
export function subscribeSi470x(handlers: {
  onRds?: (rds: Record<string, unknown>) => void;
  onStatus?: (s: Si470xStatus) => void;
}): () => void {
  const em = new NativeEventEmitter(NativeModules.VibeLocalSDR);
  const subs = [
    em.addListener('VibeSi470xMeta', (e: { json?: string }) => {
      if (!e.json || !handlers.onRds) return;
      try { handlers.onRds(JSON.parse(e.json) as Record<string, unknown>); } catch {}
    }),
    em.addListener('VibeSi470xStatus', (e: Si470xStatus) => handlers.onStatus?.(e)),
  ];
  return () => subs.forEach((s) => s.remove());
}
