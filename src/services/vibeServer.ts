import { NativeModules, Platform } from 'react-native';
import { loadActiveEibi } from './eibi';

// VibeServer: share this device's USB dongle with server-side DSP (compressed
// audio + waterfall over a WebSocket, ~25x lighter than raw RTL-TCP IQ). The
// heavy lifting is the SAME shim used for local listening — here it's LAN-bound
// and silent on the serving phone, so the single client slot goes to the one
// remote VibeSDR. Android-only (only Android owns the local USB dongle).

const Local: any = (NativeModules as any).VibeLocalSDR;

export const vibeServerSupported =
  Platform.OS === 'android' && !!Local?.startVibeServer;

// Waterfall frame-rate tiers. Our Local Hardware default is 20 fps; Half (10) is
// exactly UberSDR's shipping default, Quarter (5) sits just under OWRX's 9 — the
// client interpolates the waterfall so a throttled rate still scrolls smoothly.
export type FpsTier = 'full' | 'half' | 'quarter';
export const FPS_TIERS: { key: FpsTier; label: string; fps: number }[] = [
  { key: 'full',    label: 'Full · 20 fps',    fps: 20 },
  { key: 'half',    label: 'Half · 10 fps',    fps: 10 },
  { key: 'quarter', label: 'Quarter · 5 fps',  fps: 5  },
];
export const fpsForTier = (t: FpsTier) => FPS_TIERS.find(x => x.key === t)?.fps ?? 20;

// Optional demod-bandwidth cap (server-side), for low-end hosts / slow networks.
// 0 = no cap (client gets the full control set).
export type VibeServerConfig = {
  name: string;
  centerFreq?: number;
  sampleRate?: number;
  mode?: string;
  pin: string;              // '' = open access (no PIN)
  maxBandwidthHz?: number;  // 0 = no cap
  maxFftRate?: number;      // 0 = server default (20 fps)
  compressAudio?: boolean;  // default true
};

export type VibeServerInfo = { ip: string; port: number; name: string };

export type VibeServerStatus = {
  running: boolean;
  client: boolean;
  clientAddr: string;
  specBytesPerSec: number;
  audioBytesPerSec: number;
  compressed: boolean;
  pinEnabled: boolean;
  fftRate: number;
  bandwidthHz: number;
  port: number;
  ip: string;
};

export async function startVibeServer(cfg: VibeServerConfig): Promise<VibeServerInfo> {
  const info = await Local.startVibeServer({
    name: cfg.name,
    centerFreq: cfg.centerFreq,
    sampleRate: cfg.sampleRate,
    mode: cfg.mode,
    pin: cfg.pin,
    maxBandwidthHz: cfg.maxBandwidthHz ?? 0,
    maxFftRate: cfg.maxFftRate ?? 0,
    compressAudio: cfg.compressAudio ?? true,
  });
  // Hand the web client's search its station list. Fire-and-forget: the server is
  // already up and useful without it, and this can involve a network fetch.
  void publishStations();
  return info;
}

/**
 * Publish the station list the web client searches (GET /stations on the shim).
 *
 * The APP does this, not the shim, for two reasons:
 *   1. A browser CANNOT fetch eibispace.de — it sends no Access-Control-Allow-Origin,
 *      and unlike React Native a browser enforces CORS. Served from the shim it's
 *      same-origin, so the problem disappears.
 *   2. The app already owns the EiBi download + seasonal cache, so the search keeps
 *      working with no internet at query time — the allotment case.
 *
 * Same model as UberSDR: the server presents the stations, the client renders them.
 */
export async function publishStations(): Promise<void> {
  if (!Local?.setStationsJson) return;
  try {
    const eibi = await loadActiveEibi();
    if (!eibi.length) return;
    Local.setStationsJson(JSON.stringify(eibi));
  } catch {
    // Offline or EiBi unreachable — the web client degrades to bookmarks + band
    // plan, which are both local. Not worth surfacing.
  }
}

export async function stopVibeServer(): Promise<void> {
  try { await Local?.stopVibeServer?.(); } catch {}
}

export async function getVibeServerStatus(): Promise<VibeServerStatus | null> {
  try { return await Local?.getVibeServerStatus?.(); } catch { return null; }
}

// Live toggle — flip compressed audio without restarting the server (a fallback
// if a client hits a decode issue).
export function setVibeServerCompressAudio(on: boolean): void {
  try { Local?.setVibeServerCompressAudio?.(on); } catch {}
}

// A fresh random 6-digit default PIN. The user can keep it, set their own, or
// disable auth entirely on the sharing screen.
export function randomPin(seed: number): string {
  // Caller passes a seed (e.g. Date.now()) so this stays pure/testable.
  let x = (seed ^ 0x9e3779b9) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
  return String(100000 + (x % 900000));
}

// Format a byte/sec rate for the live telemetry readout.
export function fmtRate(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  const kb = bytesPerSec / 1024;
  return kb >= 1000 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb.toFixed(0)} KB/s`;
}
