import { NativeModules, Platform } from 'react-native';
import { loadActiveEibi } from './eibi';
import { getUserLocation } from './instancesApi';
import { getServerName } from './rtlTcpServer';
import { latLonToGrid } from './grid';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  /** Serve the browser client at GET /. Off = only the VibeSDR app can connect,
   *  so a stranger can't stumble in from a URL. Default true. */
  webServer?: boolean;
  /** Pin the capture rate: clients cannot change it, and their picker is hidden.
   *  0 (the default) = client-controlled, as on the RTL-TCP server. */
  lockedRate?: number;
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
  /** Capture sample rate the CLIENT currently has the server running at. Shown on
   *  the sharing screen so the host can SEE the server answering the client. */
  sampleRate: number;
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
    webServer: cfg.webServer ?? true,
    lockedRate: cfg.lockedRate ?? 0,
  });
  // Hand the web client's search its station list. Fire-and-forget: the server is
  // already up and useful without it, and this can involve a network fetch.
  void publishStations();
  void publishLocation();
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

/** Where the host has manually said the receiver is (city picker fallback). */
const LOC_KEY = 'lsv_server_location';

export type ServerLocation = { lat: number; lon: number; label?: string };

export async function setManualServerLocation(loc: ServerLocation | null): Promise<void> {
  if (loc) await AsyncStorage.setItem(LOC_KEY, JSON.stringify(loc));
  else await AsyncStorage.removeItem(LOC_KEY);
  await publishLocation();
}

/**
 * Turn a typed place name into a position ("Northampton" → 52.24, -0.90).
 *
 * Called ONCE, when the host saves the setting — never per client. The result is
 * stored, so a server with no internet still serves its location. Nominatim asks
 * for a identifying User-Agent, and rate-limits; both are fine for a one-shot.
 */
export async function geocodeCity(name: string): Promise<ServerLocation | null> {
  const q = name.trim();
  if (!q) return null;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'VibeSDR/8 (https://github.com/stuey3d/VibeSDR)' } },
    );
    const j = await r.json() as Array<{ lat: string; lon: string; display_name?: string }>;
    if (!j?.length) return null;
    const lat = parseFloat(j[0].lat), lon = parseFloat(j[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Keep the name the HOST typed as the label, not Nominatim's verbose
    // "Northampton, West Northamptonshire, England, United Kingdom".
    return { lat, lon, label: q };
  } catch {
    return null;
  }
}

export async function getManualServerLocation(): Promise<ServerLocation | null> {
  try {
    const raw = await AsyncStorage.getItem(LOC_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * How the server decides what position to publish. Defaults to 'off'.
 *
 * This is a SEPARATE consent from the app's own location permission, on purpose.
 * Granting location so the instance list can be sorted by distance is NOT consent
 * to BROADCAST that position to every client that connects — and once VibeServer
 * can be public, "every client" could mean anyone. So publishing is opt-in, and
 * the default is to publish nothing.
 */
export type LocationMode = 'off' | 'device' | 'manual';
const LOCMODE_KEY = 'vs_locmode';

export async function getServerLocationMode(): Promise<LocationMode> {
  try {
    const v = await AsyncStorage.getItem(LOCMODE_KEY);
    return v === 'device' || v === 'manual' ? v : 'off';
  } catch { return 'off'; }
}

export async function setServerLocationMode(m: LocationMode): Promise<void> {
  await AsyncStorage.setItem(LOCMODE_KEY, m);
  await publishLocation();
}

/**
 * Publish the RECEIVER's position (GET /location on the shim).
 *
 * This is the SERVER's location, deliberately — NOT the client's. A VibeServer
 * might be left at a relative's house in another town, and once it can be public
 * it could be listened to from anywhere. Spot distances, map centring and the ITU
 * REGION are all properties of the ANTENNA: computing them from the listener's
 * position gives nonsense distances and, worse, the wrong region's band edges
 * (80m is 3.5–3.8 MHz in R1 but 3.5–4.0 in R2).
 *
 * Publishes ONLY what the host explicitly opted into — see LocationMode. When the
 * mode is 'off' (the default) we publish nothing at all, and the client shows a
 * "receiver location not set" warning rather than silently pretending to know.
 */
export async function publishLocation(): Promise<void> {
  if (!Local?.setLocationJson) return;
  // The NAME is always published — it identifies the receiver and is not sensitive
  // (the host typed it). The POSITION is published only when opted into. Clients
  // show "Moto G35 / Northampton IO92nh" when both are known, and just the name
  // with a "location not set" note when only the name is.
  const name = await getServerName('VibeSDR');
  const emit = (extra: object = {}) => {
    try { Local.setLocationJson(JSON.stringify({ name, ...extra })); } catch {}
  };
  try {
    const mode = await getServerLocationMode();
    if (mode === 'off') { emit(); return; }

    const manual = await getManualServerLocation();
    const loc = mode === 'manual' ? manual : await getUserLocation();
    if (!loc) { emit(); return; }

    // Coarsened to ~1 km — enough for distances, rings and the ITU region, and
    // nowhere near enough to point at a house. It is served to every client.
    const lat = Math.round(loc.lat * 100) / 100;
    const lon = Math.round(loc.lon * 100) / 100;
    emit({
      lat, lon,
      label: mode === 'manual' ? manual?.label ?? undefined : undefined,
      // The grid is DERIVED here, so no client ever has to ask a human for it —
      // a locator is a property of the antenna, not something the listener knows.
      grid: latLonToGrid(lat, lon),
    });
  } catch {
    // Permission revoked, or the picked city went missing — publish the name only,
    // never a position the host never agreed to share.
    emit();
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
