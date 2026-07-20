/**
 * Public facade for the "stations near me" feature — the surface the UI calls.
 * Offline-first: the list always comes from the bundled FCC DB and NEVER blocks
 * on the network. Logos live in the same DB (blobs); they're read instantly and
 * resolved through the layered source chain (addendum §7): DuckDuckGo image
 * search (freq + callsign) -> Wikidata -> site favicon, with manual override.
 * Auto/background resolution is OFF — the chain runs only on an explicit user
 * action (enrichNow / resolveLogo force); see logoResolver.AUTO_LOGO_RESOLUTION.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, NativeModules } from 'react-native';

import { getUserLocation } from './instancesApi';
import { haversineKm } from './stationGeo';
import {
  nearbyStations as dbNearby, stationsForCallsignBase, snapshotDate,
  getLogoDataUri, markWanted, wantedBases, basesMissingLogo,
  setManualLogo, logoSourceOf,
  type NearbyDbResult,
} from './stationDb';
import { resolveLogo, fetchImage, base64ToBytes, type LogoStation } from './logoResolver';
import { stationLogoQuery } from './logoDuckDuckGo';
import { piToCallsign, callsignBase } from './piCallsign';
import type { NearbyStation, StationIdentity, StationRow } from './stationTypes';

export interface NearbyResult {
  location: { lat: number; lon: number } | null;
  radiusKm: number;
  stations: NearbyStation[];
  snapshotDate: string | null;
}

export interface NearbyOptions {
  radiusKm?: number;
  limit?: number;
  location?: { lat: number; lon: number };
  /** Lazily resolve logos the list is missing (default true). */
  enrich?: boolean;
}

/** Build a resolver descriptor from a nearby DB row. */
function toLogoStation(r: NearbyDbResult): LogoStation {
  return {
    base: r.callsignBase,
    callsign: r.callsign,
    homepage: r.homepage,
    name: r.callsign,
    freqMhz: r.frequencyMhz,   // feeds the DuckDuckGo "radio <freq> <callsign> logo" query
  };
}

/** Fire background logo resolution for rows we don't have yet (throttled inside). */
async function lazyResolve(rows: NearbyDbResult[], cap = 20): Promise<void> {
  const missing = new Set(await basesMissingLogo(rows.map((r) => r.callsignBase)));
  rows.filter((r) => missing.has(r.callsignBase)).slice(0, cap)
    .forEach((r) => { void resolveLogo(toLogoStation(r)); });
}

export async function getNearbyStations(opts: NearbyOptions = {}): Promise<NearbyResult> {
  const radiusKm = opts.radiusKm ?? 100;
  const location = opts.location ?? (await getUserLocation());
  const snap = await snapshotDate();
  if (!location) return { location: null, radiusKm, stations: [], snapshotDate: snap };

  const rows = await dbNearby(location.lat, location.lon, radiusKm, opts.limit ?? 100);

  const stations: NearbyStation[] = await Promise.all(rows.map(async (r) => ({
    ...r,
    logoUri: r.hasLogo ? await getLogoDataUri(r.callsignBase) : null,
    genre: r.genre,
    homepage: r.homepage,
  })));

  if (opts.enrich !== false) void lazyResolve(rows.filter((r) => r.service === 'FM'));
  return { location, radiusKm, stations, snapshotDate: snap };
}

function bestStation(rows: StationRow[]): StationRow | null {
  if (rows.length === 0) return null;
  const order: Record<string, number> = { FM: 0, FL: 1, FX: 2 };
  return [...rows].sort((a, b) => (order[a.service] ?? 9) - (order[b.service] ?? 9))[0];
}

export async function identifyByPi(pi: number, psText?: string): Promise<StationIdentity> {
  const dec = piToCallsign(pi);
  if (!dec.callsign) return { pi, callsign: null, confident: false, station: null, note: dec.note };

  const base = callsignBase(dec.callsign);
  const rows = await stationsForCallsignBase(base);
  const station = bestStation(rows);

  let confident = dec.confident && station != null && station.service === 'FM';
  let note = dec.note;
  if (station == null) note = 'no DB match for computed callsign';
  else if (station.service !== 'FM') note = `matched a ${station.service} (formula unreliable for translators)`;

  if (psText) {
    const other = psText.toUpperCase().match(/\b([KW][A-Z]{3})\b/);
    if (other && other[1] !== base) { confident = false; note = `PS text names ${other[1]}, not ${dec.callsign}`; }
  }

  // Tuning to it counts as an encounter — resolve its logo (background: no-op
  // until AUTO is enabled; freq carried so a later forced resolve has it).
  void noteEncountered({ base, callsign: dec.callsign, homepage: null, name: station?.callsign, freqMhz: station?.frequencyMhz });
  return { pi, callsign: dec.callsign, confident, station, note };
}

/** A station was tuned/shown — resolve its logo now, or queue it if offline. */
export async function noteEncountered(st: LogoStation): Promise<void> {
  if (!st.base) return;
  if ((await basesMissingLogo([st.base])).length === 0) return; // already have it
  await markWanted(st.base);        // queued even if the resolve below fails
  void resolveLogo(st);             // clears the queue entry on success
}

/** On-demand logo (data: URI) for one station (e.g. a row scrolled into view). */
export async function getStationLogo(base: string): Promise<string | null> {
  return getLogoDataUri(base);
}

/**
 * Force logo resolution for one station NOW, on explicit user request. Unlike the
 * background paths this bypasses the AUTO gate and runs the DuckDuckGo source, so
 * pass the real dial frequency + callsign to build the proven query. Result is
 * stored in the DB (source='ddg'); a manual assignment still wins over it later.
 */
export async function enrichNow(
  base: string, opts?: { callsign?: string; freqMhz?: number; nameHint?: string },
): Promise<boolean> {
  return resolveLogo(
    { base, callsign: opts?.callsign ?? base, freqMhz: opts?.freqMhz, name: opts?.nameHint },
    { force: true },
  );
}

export async function getStationDataDate(): Promise<string | null> {
  return snapshotDate();
}

// ── callsign by frequency (FCC DB) ────────────────────────────────────────────
// Presets are saved under the on-air PS name — or a bare "FM 88.7" when no name
// was captured — NOT the callsign. So station identity (logo key, logo-search
// query) must resolve the callsign from the dial frequency against the bundled
// FCC dataset. Cached briefly since it's hit once per visible tile.
let freqCallsignCache: { at: number; map: Map<number, string> } | null = null;
const FREQ_CACHE_MS = 60 * 1000;

/** Resolve the closest FM station's callsign base for a dial frequency, or null
 *  (no GPS / not in the dataset). Nearest by distance when several share a freq. */
export async function callsignForFreq(freqMhz?: number): Promise<string | null> {
  if (freqMhz == null || !isFinite(freqMhz)) return null;
  if (!freqCallsignCache || Date.now() - freqCallsignCache.at > FREQ_CACHE_MS) {
    try {
      const { stations } = await getNearbyStations({ enrich: false });
      const map = new Map<number, string>();
      stations
        .filter((s) => s.service === 'FM')
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .forEach((s) => { const k = Math.round(s.frequencyMhz * 10); if (!map.has(k)) map.set(k, s.callsignBase); });
      freqCallsignCache = { at: Date.now(), map };
    } catch {
      freqCallsignCache = { at: Date.now(), map: new Map() };
    }
  }
  return freqCallsignCache.map.get(Math.round(freqMhz * 10)) ?? null;
}

// ── manual assignment + web image search (addendum §7, user addition) ─────────
/**
 * Assign a logo to a station from an image URL (a web-search result or a pasted
 * link). Sticky: auto sources never overwrite it. Returns true on success.
 */
export async function setStationLogoFromUrl(base: string, url: string): Promise<boolean> {
  const img = await fetchImage(url);
  if (!img) return false;
  await setManualLogo(base, img.bytes, img.mime);
  return true;
}

/** True if this station's logo was set by hand. */
export async function isManualLogo(base: string): Promise<boolean> {
  return (await logoSourceOf(base)) === 'manual';
}

export interface ImageResult { url: string; thumb: string; title: string; width?: number; height?: number; }

/**
 * Quick in-app image search for the manual-assign UI, via Wikimedia Commons
 * (keyless, non-Google, licensable). Coverage is narrow — for whole-web logo
 * search use openLogoWebSearch() (browser + share-back) below.
 */
export async function searchLogoImages(query: string, limit = 24): Promise<ImageResult[]> {
  try {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
      + `&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${limit}`
      + '&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=256&origin=*';
    const res = await fetch(u, { headers: { 'User-Agent': 'CarFM-CarFM/1.0' } });
    const pages = ((await res.json()) as { query?: { pages?: Record<string, {
      title?: string; imageinfo?: { url?: string; thumburl?: string; width?: number; height?: number; mime?: string }[];
    }> } })?.query?.pages ?? {};
    return Object.values(pages).flatMap((p) => {
      const ii = p.imageinfo?.[0];
      if (!ii?.url || !(ii.mime ?? '').startsWith('image/')) return [];
      return [{ url: ii.url, thumb: ii.thumburl ?? ii.url, title: p.title ?? '', width: ii.width, height: ii.height }];
    });
  } catch {
    return [];
  }
}

// ── whole-web logo search via browser + Android share-back ────────────────────
const PENDING_LOGO_TARGET = '@vibesdr/logo_assign_target';
// Non-Google image search. Swap for Bing/Brave/Qwant by changing this one line:
//   Bing:  https://www.bing.com/images/search?q=
//   Brave: https://search.brave.com/images?q=
const IMAGE_SEARCH_URL = (q: string) => `https://duckduckgo.com/?iax=images&ia=images&q=${encodeURIComponent(q)}`;

/**
 * Open the browser to a (non-Google) image search for a station's logo. The user
 * long-presses the logo and shares it back to CarFM (Android share sheet); the
 * app then assigns it via consumeSharedLogo(). We remember which station the
 * search was for so the shared image lands on the right one.
 */
export async function openLogoWebSearch(
  base: string, opts?: { query?: string; callsign?: string; freqMhz?: number },
): Promise<void> {
  await AsyncStorage.setItem(PENDING_LOGO_TARGET, base.toUpperCase());
  // Default to the proven DDG query shape: "radio <freq> <lowercase-callsign> logo"
  // (see logoDuckDuckGo.stationLogoQuery — it returned the right logo #1, 7/7).
  const q = opts?.query ?? stationLogoQuery(opts?.freqMhz, opts?.callsign ?? base);
  await Linking.openURL(IMAGE_SEARCH_URL(q));
}

/**
 * Consume an image shared into the app and assign it to the station chosen by the
 * preceding openLogoWebSearch(). Call this on app foreground/resume. Returns the
 * callsign_base that got a logo, or null.
 */
export async function consumeSharedLogo(): Promise<string | null> {
  const Local = (NativeModules as { VibeLocalSDR?: { consumeSharedLogo?: () => Promise<{ base64: string; mime: string } | null> } }).VibeLocalSDR;
  if (!Local?.consumeSharedLogo) return null;
  let shared: { base64: string; mime: string } | null = null;
  try { shared = await Local.consumeSharedLogo(); } catch { return null; }
  if (!shared?.base64) return null;
  const base = await AsyncStorage.getItem(PENDING_LOGO_TARGET);
  if (!base) return null;                       // no pending target — ignore
  await AsyncStorage.removeItem(PENDING_LOGO_TARGET);
  try {
    await setManualLogo(base, base64ToBytes(shared.base64), shared.mime || 'image/png');
    return base;
  } catch {
    return null;
  }
}

// ── launch-time logo maintenance ─────────────────────────────────────────────
const PREFETCH_KEY = '@vibesdr/logo_prefetch';
const PREFETCH_MIN_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // at most monthly
const PREFETCH_MOVE_KM = 50;                                // ...or if the car moved region

/** Sweep the wanted queue: retry logos for stations seen while offline. */
export async function sweepWantedLogos(cap = 100): Promise<void> {
  const bases = await wantedBases(cap);
  bases.forEach((b) => { void resolveLogo({ base: b, callsign: b }); });
}

/** Prefetch logos for stations around a location (throttled inside resolveLogo). */
async function regionalPrefetch(lat: number, lon: number, radiusKm = 100, cap = 60): Promise<void> {
  const rows = await dbNearby(lat, lon, radiusKm, 200);
  const fm = rows.filter((r) => r.service === 'FM' && !r.hasLogo);
  const missing = new Set(await basesMissingLogo(fm.map((r) => r.callsignBase)));
  fm.filter((r) => missing.has(r.callsignBase)).slice(0, cap)
    .forEach((r) => { void resolveLogo(toLogoStation(r)); });
}

/**
 * Call once at launch (ideally after a GPS fix). Sweeps the offline queue, and
 * — at most monthly, or when the car has moved to a new region — prefetches
 * logos for the surrounding stations. All fetches are background + rate-limited.
 */
export async function initLogoService(location?: { lat: number; lon: number }): Promise<void> {
  void sweepWantedLogos();

  const loc = location ?? (await getUserLocation());
  if (!loc) return;
  try {
    const raw = await AsyncStorage.getItem(PREFETCH_KEY);
    const prev = raw ? JSON.parse(raw) as { lat: number; lon: number; at: number } : null;
    const stale = !prev || (Date.now() - prev.at) > PREFETCH_MIN_INTERVAL_MS;
    const moved = !!prev && haversineKm(prev.lat, prev.lon, loc.lat, loc.lon) > PREFETCH_MOVE_KM;
    if (stale || moved) {
      await AsyncStorage.setItem(PREFETCH_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, at: Date.now() }));
      void regionalPrefetch(loc.lat, loc.lon);
    }
  } catch { /* prefetch is best-effort */ }
}
