import { NativeModules, Platform } from 'react-native';
import { loadActiveEibi } from './eibi';
import { getUserLocation } from './instancesApi';
import { getServerName } from './rtlTcpServer';
import { latLonToGrid, gridToLatLon } from './grid';
import type { ServerBookmark } from './stations';
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
  /** mDNS advertise. Passed to native only so a crash-restored server re-advertises. */
  advertise?: boolean;
  /** Rebuild the server if the app process dies under it. Default true. */
  autoRestore?: boolean;
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
    advertise: cfg.advertise ?? true,
    autoRestore: cfg.autoRestore ?? true,
  });
  // Hand the web client's search its station list. Fire-and-forget: the server is
  // already up and useful without it, and this can involve a network fetch.
  void publishStations();
  void publishLocation();
  startBookmarkAutosave();
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

// ── Learned station bookmarks (RDS) ─────────────────────────────────────────
//
// The SHIM learns these — it is the only place that sees both the tuned frequency
// and the decoded RDS name. It has no storage of its own, so the app persists them,
// exactly as it does the station list.

const BM_KEY = 'vs_learned_bookmarks';

/** Hand the shim the saved list at start-up. */
export async function loadLearnedBookmarks(): Promise<void> {
  if (!Local?.setBookmarksJson) return;
  try {
    const raw = await AsyncStorage.getItem(BM_KEY);
    if (raw) Local.setBookmarksJson(raw);
  } catch {}
}

/** Read the shim's current list back and store it. Expired entries are already
 *  pruned on the way out, so saving is also what garbage-collects the list. */
export async function saveLearnedBookmarks(): Promise<void> {
  if (!Local?.getBookmarksJson) return;
  try {
    const json = await Local.getBookmarksJson();
    if (typeof json === 'string' && json.length > 2) {
      await AsyncStorage.setItem(BM_KEY, json);
    }
  } catch {}
}

/** The shim's learned list, right now — for the app's own search + VTS. */
export async function getLearnedBookmarksNow(): Promise<ServerBookmark[]> {
  if (!Local?.getBookmarksJson) return [];
  try {
    const json = await Local.getBookmarksJson();
    const arr = JSON.parse(json || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((b: any) => b?.name && b?.frequency)
      .map((b: any) => ({
        name: String(b.name),
        frequency: Number(b.frequency),
        mode: b.mode ?? 'wfm',
        source: 'server' as const,
      })) as ServerBookmark[];
  } catch { return []; }
}

/**
 * Keep the saved copy in step with what the shim is learning.
 *
 * The shim learns continuously but has no storage, so if nothing pulls the list out
 * and writes it down, everything heard in a session is lost the moment the process
 * ends. Any session that runs the shim — serving OR listening locally — should hold
 * one of these. Saving on a timer AND on stop, because a session that is killed
 * (or crashes) never reaches its stop path.
 */
let bmTimer: ReturnType<typeof setInterval> | null = null;

export function startBookmarkAutosave(): void {
  if (bmTimer) return;
  void loadLearnedBookmarks();
  bmTimer = setInterval(() => { void saveLearnedBookmarks(); }, 60_000);
}

export function stopBookmarkAutosave(): void {
  if (bmTimer) { clearInterval(bmTimer); bmTimer = null; }
  void saveLearnedBookmarks();     // final flush
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
 * Resolve whatever the host typed into a position — a place name OR a Maidenhead
 * locator ("Northampton" or "IO92nh").
 *
 * A LOCATOR is tried first and never touches the network: it decodes arithmetically.
 * That matters because a VibeServer is exactly the thing likely to be sitting in a
 * shed on a solar panel with no internet — a radio amateur knows their grid square,
 * and making them depend on a geocoding API to state it would be daft.
 *
 * A place name falls back to Nominatim. Called ONCE, when the host saves — never per
 * client — and the result is stored, so the server keeps serving its location offline
 * forever after.
 */
export async function resolveLocation(input: string): Promise<ServerLocation | null> {
  const q = input.trim();
  if (!q) return null;

  // Maidenhead: 2 letters, 2 digits, optionally 2 more letters. Decoded locally.
  if (/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(q)) {
    const ll = gridToLatLon(q);
    if (ll) {
      // Canonical casing: fields/squares upper, subsquare lower (IO92nh).
      const g = q.length >= 6
        ? q.slice(0, 4).toUpperCase() + q.slice(4, 6).toLowerCase()
        : q.toUpperCase();
      return { lat: ll.lat, lon: ll.lon, label: g };
    }
  }
  return geocodeCity(q);
}

/**
 * Turn a typed place name into a position ("Northampton" → 52.24, -0.90).
 *
 * Needs the network. Prefer resolveLocation(), which handles a grid square offline.
 * Nominatim asks for an identifying User-Agent and rate-limits; both fine for a
 * one-shot.
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

/** Cache of coarse lat/lon → place name, so the reverse lookup happens once ever. */
const RGEO_KEY = 'vs_rgeo';

/**
 * Name the place we're at ("Moulton"), from a coarse position.
 *
 * Done on the SERVER, once — not in each client. Clients would otherwise each hit a
 * geocoder for the same answer, and a name is a property of the receiver just as its
 * position is. Cached against the ROUNDED coordinates, so it survives a restart and
 * never repeats. With no internet we keep the bare coordinates: ugly but honest, and
 * the grid square is there regardless.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<{ name: string; iso?: string } | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  try {
    const raw = await AsyncStorage.getItem(RGEO_KEY);
    const cache: Record<string, { name: string; iso?: string }> = raw ? JSON.parse(raw) : {};
    if (cache[key]) return cache[key];

    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&zoom=13&lat=${lat}&lon=${lon}`,
      { headers: { 'User-Agent': 'VibeSDR/8 (https://github.com/stuey3d/VibeSDR)' } },
    );
    const j = await r.json() as { address?: Record<string, string> };
    const a = j?.address ?? {};
    // Most specific useful name first. zoom=13 keeps this to a town, never a street:
    // the position is deliberately coarsened to ~1 km and the label must not imply
    // more precision than that.
    const name = a.town || a.village || a.city || a.suburb || a.municipality
              || a.county || a.state || null;
    if (!name) return null;

    // The COUNTRY is the valuable half. Station-logo lookup needs it to anchor a name
    // match (without one it demands a near-exact name and so almost always fails), and
    // the RDS country code that would otherwise supply it rides in group 1A, which many
    // stations never transmit. FM is line-of-sight, so a station this receiver can hear
    // is essentially always in the receiver's own country — a very good default.
    const out = { name, iso: (a.country_code || '').toUpperCase() || undefined };
    cache[key] = out;
    await AsyncStorage.setItem(RGEO_KEY, JSON.stringify(cache));
    return out;
  } catch {
    return null;   // offline — coordinates + grid still work
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

    // A bare "52.29, -0.85" means nothing to a human. On the DEVICE path there's no
    // label to show, so name the place — once, here, and cached — rather than make
    // every client reverse-geocode the same point for itself.
    const rev = await reverseGeocode(lat, lon);
    let label = mode === 'manual' ? manual?.label ?? undefined : undefined;
    if (!label) label = rev?.name ?? undefined;

    emit({
      lat, lon, label,
      // Receiver country — clients use it to anchor station-logo lookups and to flag
      // a station whose RDS never carried a country code of its own.
      iso: rev?.iso,
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
  stopBookmarkAutosave();
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

