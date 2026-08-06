/**
 * Public facade for the "stations near me" feature — the surface the UI calls.
 * Offline-first: the list always comes from the bundled FCC DB and NEVER blocks
 * on the network. Logo IMAGES are files (logoStore.ts, `file://` URIs); they're read instantly and
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
  nearbyStations as dbNearby, stationsForCallsignBase, stationsAtFrequency, snapshotDate,
  markWanted, wantedBases,
  type NearbyDbResult,
} from './stationDb';
import { prepareLogoRenditions } from './logoPrep';
import {
  putOriginal, readOriginalDataUri, displayUri, hasOriginal,
  basesWithoutLogo, basesWithLogo, migrateLogosFromDb,
} from './logoStore';
import { resolveLogo, fetchImage, fetchImageResult, base64ToBytes, type LogoStation } from './logoResolver';
import { stationLogoQuery } from './logoDuckDuckGo';
import { piToCallsign, callsignBase, piLowBitsCandidates } from './piCallsign';
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
  const missing = new Set(await basesWithoutLogo(rows.map((r) => r.callsignBase)));
  rows.filter((r) => missing.has(r.callsignBase)).slice(0, cap)
    .forEach((r) => { void resolveLogo(toLogoStation(r)); });
}

export async function getNearbyStations(opts: NearbyOptions = {}): Promise<NearbyResult> {
  const radiusKm = opts.radiusKm ?? 100;
  const location = opts.location ?? (await getUserLocation());
  const snap = await snapshotDate();
  if (!location) return { location: null, radiusKm, stations: [], snapshotDate: snap };

  const rows = await dbNearby(location.lat, location.lon, radiusKm, opts.limit ?? 100);

  // ONE directory listing tells us which of these have a logo at all; without it
  // this fanned out a filesystem lookup per row (up to 100 stations) just to
  // discover that most have none. `r.hasLogo` can't help — it is the DB's
  // (l.img IS NOT NULL), always false now that images are files.
  const withLogo = new Set(await basesWithLogo(rows.map((r) => r.callsignBase)));
  const stations: NearbyStation[] = await Promise.all(rows.map(async (r) => {
    const logoUri = withLogo.has(r.callsignBase)
      ? await displayUri(r.callsignBase, 96)   // nearby rows are small tiles
      : null;
    return { ...r, hasLogo: !!logoUri, logoUri, genre: r.genre, homepage: r.homepage };
  }));

  if (opts.enrich !== false) void lazyResolve(rows.filter((r) => r.service === 'FM'));
  return { location, radiusKm, stations, snapshotDate: snap };
}

function bestStation(rows: StationRow[]): StationRow | null {
  if (rows.length === 0) return null;
  const order: Record<string, number> = { FM: 0, FL: 1, FX: 2 };
  return [...rows].sort((a, b) => (order[a.service] ?? 9) - (order[b.service] ?? 9))[0];
}

/** Dial-vs-DB tolerance. The FM raster is 0.2 MHz in North America, so half a
 *  0.1 MHz step is loose enough for rounding and far tighter than any channel. */
const FREQ_EPS = 0.05;

/**
 * Look for the station the dial says we are on, when the PI says otherwise.
 *
 * Only called after a PI decoded cleanly to a callsign that the DB places on a
 * DIFFERENT frequency — the state that says the top nibble is wrong rather than
 * the whole code. Refuses on 0 or 2+ candidates; see piLowBitsCandidates for why
 * a single hit is trustworthy.
 */
async function salvageByLowBits(pi: number, freqMhz: number): Promise<StationRow | null> {
  const onDial = await stationsAtFrequency(freqMhz);
  const bases = piLowBitsCandidates(pi, onDial);
  if (bases.length !== 1) return null;
  return bestStation(onDial.filter((r) => r.callsignBase === bases[0]));
}

/**
 * Identify the live station from its RDS PI. Pass the tuned frequency whenever
 * it is known — it is what stops a mis-encoded PI from renaming the station.
 */
export async function identifyByPi(
  pi: number, psText?: string, freqMhz?: number,
): Promise<StationIdentity> {
  const dec = piToCallsign(pi);
  if (!dec.callsign) return { pi, callsign: null, confident: false, station: null, note: dec.note };

  let callsign = dec.callsign;
  let base = callsignBase(callsign);
  const rows = await stationsForCallsignBase(base);
  let station = bestStation(rows);

  // NO DB ROW MEANS NO STATION. The formula turns any 16 bits in the K/W range
  // into four plausible letters, so "it decoded" is not evidence that anything is
  // out there. On 2026-08-04 a corrupt block A on WERN read 0xA6FF as 0x57FF,
  // which the formula renders as WBGX — a callsign absent from the entire FCC
  // table. The old code marked it not-confident and returned it anyway, and the
  // hero dropped WERN's logo to show it.
  //
  // Returning early also repairs the frequency gate below, which was guarded on
  // `station != null` and so could never fire on exactly this case.
  if (station == null) {
    return { pi, callsign: null, confident: false, station: null, note: 'no DB match for computed callsign' };
  }

  let confident = dec.confident && station != null && station.service === 'FM';
  let note = dec.note;
  if (station.service !== 'FM') note = `matched a ${station.service} (formula unreliable for translators)`;

  // ── THE DIAL OUTRANKS THE PI ────────────────────────────────────────────────
  // A PI that decodes to a real station on a different frequency is not this
  // station, however clean the decode looks. Without this check WIBA-FM 101.5
  // renamed itself "KDTI · Rochester Hills" every time PI consensus landed, and
  // queued that station's logo — the decode was correct, the transmitted code
  // was not. See PI_LOW_MASK for the encoder fault and the two stations it hit.
  //
  // This is deliberately the one identity path that survives a head unit with no
  // GPS fix, which is exactly when nothing else can contradict a bad PI.
  if (typeof freqMhz === 'number' && freqMhz > 0 && station != null
      && Math.abs(station.frequencyMhz - freqMhz) > FREQ_EPS) {
    const clash = `${callsign} is ${station.frequencyMhz} MHz, dial is ${freqMhz}`;
    const salvaged = await salvageByLowBits(pi, freqMhz);
    if (!salvaged) {
      return { pi, callsign: null, confident: false, station: null, note: `${clash} — PI rejected` };
    }
    // The BASE, not the row's `callsign`: the formula path returns a bare
    // four-letter form ('WOLX' for a row reading 'WOLX-FM'), and the hero renders
    // whatever this is verbatim, so the two paths must agree on the shape.
    callsign = salvaged.callsignBase;
    base = salvaged.callsignBase;
    station = salvaged;
    confident = salvaged.service === 'FM';
    note = `${clash}; low 12 bits match ${salvaged.callsign} on the dial`;
  }

  if (psText) {
    const other = psText.toUpperCase().match(/\b([KW][A-Z]{3})\b/);
    if (other && other[1] !== base) { confident = false; note = `PS text names ${other[1]}, not ${callsign}`; }
  }

  // Tuning to it counts as an encounter — resolve its logo (background: no-op
  // until AUTO is enabled; freq carried so a later forced resolve has it).
  void noteEncountered({ base, callsign, homepage: null, name: station?.callsign, freqMhz: station?.frequencyMhz });
  return { pi, callsign, confident, station, note };
}

/** A station was tuned/shown — resolve its logo now, or queue it if offline. */
export async function noteEncountered(st: LogoStation): Promise<void> {
  if (!st.base) return;
  if (await hasOriginal(st.base)) return;          // already have it (files own images now)
  await markWanted(st.base);        // queued even if the resolve below fails
  void resolveLogo(st);             // clears the queue entry on success
}

/** On-demand logo (data: URI) for one station (e.g. a row scrolled into view). */
export async function getStationLogo(base: string, boxDp?: number): Promise<string | null> {
  // A `file://` URI for the DISPLAY image: the smallest pre-rendered size that
  // covers `boxDp`, else the trimmed copy, else the untouched master. File URIs
  // let Android's image loader cache the decoded bitmap — a data: URI can't be
  // cached and pays base64 + a bridge crossing on every load.
  return displayUri(base, boxDp);
}

/** The ORIGINAL as supplied, untouched — the input every derived rendition is
 *  computed from (dark-mode adaptation, future size variants). Never chain a
 *  derivation off the display copy. */
export async function getStationLogoOriginal(base: string): Promise<string | null> {
  return readOriginalDataUri(base);
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
//
// The dataset lookup is GEO-gated (getNearbyStations needs a GPS fix to know
// which 105.9 you mean). On a head unit that rarely gets a lock — esp. a cold
// start in a garage — that returns nothing and every station reads "Tuning…".
// So we also LEARN every freq→callsign we resolve into a persistent cache: one
// good lock (e.g. while driving) fills it for the whole local band, and later
// no-lock starts resolve names straight from it. Region-agnostic by frequency
// (fine for a car that lives in one area); a fresh lock overwrites entries, so
// it self-heals if you ever drive to a different market.
let freqCallsignCache: { at: number; map: Map<number, string> } | null = null;
const FREQ_CACHE_MS = 60 * 1000;
const FREQ_PERSIST_KEY = '@carfm/freq_callsign_v1';
let freqPersist: Map<number, string> | null = null;

async function loadFreqPersist(): Promise<Map<number, string>> {
  if (freqPersist) return freqPersist;
  try {
    const raw = await AsyncStorage.getItem(FREQ_PERSIST_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    freqPersist = new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
  } catch { freqPersist = new Map(); }
  return freqPersist;
}

async function saveFreqPersist(map: Map<number, string>): Promise<void> {
  try {
    const obj: Record<string, string> = {};
    map.forEach((v, k) => { obj[String(k)] = v; });
    await AsyncStorage.setItem(FREQ_PERSIST_KEY, JSON.stringify(obj));
  } catch { /* best-effort */ }
}

/** Resolve the closest FM station's callsign base for a dial frequency, or null.
 *  Prefers a live GPS-located lookup (and caches what it finds); falls back to
 *  the learned persistent cache when there's no lock. Null only when neither the
 *  live dataset nor the cache knows this frequency. */
let freqRefreshing = false;

/** Refresh the freq→callsign map from the live dataset (needs a GPS fix). Runs in
 *  the BACKGROUND — never on the path that a logo tile awaits. */
async function refreshFreqMap(): Promise<void> {
  if (freqRefreshing) return;
  freqRefreshing = true;
  try {
    const { stations } = await getNearbyStations({ enrich: false });
    const fresh = new Map<number, string>();
    stations
      .filter((s) => s.service === 'FM')
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .forEach((s) => { const k = Math.round(s.frequencyMhz * 10); if (!fresh.has(k)) fresh.set(k, s.callsignBase); });
    if (fresh.size > 0) {
      const persist = await loadFreqPersist();
      fresh.forEach((v, k) => persist.set(k, v));
      void saveFreqPersist(persist);
      freqCallsignCache = { at: Date.now(), map: new Map(persist) };
    } else if (freqCallsignCache) {
      freqCallsignCache.at = Date.now();     // no lock — don't re-ask every call
    }
  } catch { if (freqCallsignCache) freqCallsignCache.at = Date.now(); }
  finally { freqRefreshing = false; }
}

/**
 * The same answer as callsignForFreq(), but WITHOUT a promise — null when the map
 * has not been loaded yet or does not know this frequency.
 *
 * The hero needs this. On a preset step the face commits to the target frequency
 * in one React commit, but the station's IDENTITY came back a tick or two later
 * because even a pure map lookup was behind an `async`. That gap rendered the
 * hero with no callsign at all — a blank card — and then again with the plain
 * call sign before the logo arrived. Reading the map synchronously collapses
 * that to a single frame. The async version stays the entry point that LOADS the
 * map; this one only ever reads what is already there.
 */
export function callsignForFreqSync(freqMhz?: number): string | null {
  if (freqMhz == null || !isFinite(freqMhz) || !freqCallsignCache) return null;
  return freqCallsignCache.map.get(Math.round(freqMhz * 10)) ?? null;
}

export async function callsignForFreq(freqMhz?: number): Promise<string | null> {
  if (freqMhz == null || !isFinite(freqMhz)) return null;
  const k = Math.round(freqMhz * 10);
  // COLD START: serve the PERSISTED map immediately and refresh from GPS in the
  // background. This used to await getNearbyStations() first — i.e. a GPS fix and
  // a full dataset scan — and every logo tile blocks on this call to learn its
  // callsign, so a cold start couldn't paint a single logo until the fix landed
  // (or timed out). The learned map already answers almost every local frequency.
  if (!freqCallsignCache) {
    freqCallsignCache = { at: 0, map: await loadFreqPersist() };
    void refreshFreqMap();
    return freqCallsignCache.map.get(k) ?? null;
  }
  if (Date.now() - freqCallsignCache.at > FREQ_CACHE_MS) void refreshFreqMap();   // never awaited
  return freqCallsignCache.map.get(k) ?? null;
}

// The estimated-signal meter lived here and is GONE. It mapped a receivability
// score into a fake dBFS window so the face could draw grey "not live" bars, on
// the belief that this tuner reported no signal level. It does — seek() returns
// one — and the meter uses it.
//
// The prediction itself is NOT discredited and receivabilityScore stays: Nearby
// still ranks stations with it, which is what it is good at. Measured against 232
// settled samples it explained 85% of the variance in level BETWEEN stations
// (r = +0.924) and essentially none WITHIN one — on WERN the prediction moved 3.1
// while the level swung 27. Terrain and multipath are what move a signal on one
// station, and no dataset can see them, so this was always the wrong instrument
// for a live meter.

// ── manual assignment + web image search (addendum §7, user addition) ─────────
/**
 * Assign a logo to a station from one or more candidate image URLs (a web-search
 * result and its fallbacks). Tries each in order; the first that downloads wins.
 * Sticky: auto sources never overwrite it. Returns { ok, error? } — error is the
 * reason the LAST candidate failed, so the UI can show why instead of a generic
 * message. (A DDG full-size `image` often 403s or exceeds the size cap while its
 * proxied `thumbnail` succeeds — pass both so the pick still lands.)
 */
export async function setStationLogoFromUrls(
  base: string, urls: (string | undefined | null)[],
): Promise<{ ok: boolean; error?: string }> {
  const cands = urls.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (!cands.length) return { ok: false, error: 'no image address to download' };
  let lastErr = 'the image couldn’t be downloaded';
  for (const url of cands) {
    const r = await fetchImageResult(url);
    if ('bytes' in r) {
      await putOriginal(base, r.bytes, r.mime, 'manual');   // MASTER on disk, never altered
      await prepareLogoRenditions(base);                    // trimmed copy + size ladder
      return { ok: true };
    }
    lastErr = r.error;
  }
  return { ok: false, error: lastErr };
}

/**
 * Assign a logo to a station from an image URL (a web-search result or a pasted
 * link). Sticky: auto sources never overwrite it. Returns true on success.
 */
export async function setStationLogoFromUrl(base: string, url: string): Promise<boolean> {
  const img = await fetchImage(url);
  if (!img) return false;
  await putOriginal(base, img.bytes, img.mime, 'manual');   // MASTER on disk
  await prepareLogoRenditions(base);                        // trimmed copy + size ladder
  return true;
}

/** True if this station's logo was set by hand. */
export async function isManualLogo(base: string): Promise<boolean> {
  const { getMeta } = await import('./logoStore');
  return (await getMeta(base))?.source === 'manual';
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
    await putOriginal(base, base64ToBytes(shared.base64), shared.mime || 'image/png', 'manual');
    await prepareLogoRenditions(base);   // trimmed copy + size ladder
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
  // Don't pre-filter on r.hasLogo: that DB flag is always false now (images are
  // files). basesWithoutLogo is the real check.
  const fm = rows.filter((r) => r.service === 'FM');
  const missing = new Set(await basesWithoutLogo(fm.map((r) => r.callsignBase)));
  fm.filter((r) => missing.has(r.callsignBase)).slice(0, cap)
    .forEach((r) => { void resolveLogo(toLogoStation(r)); });
}

/**
 * Call once at launch (ideally after a GPS fix). Sweeps the offline queue, and
 * — at most monthly, or when the car has moved to a new region — prefetches
 * logos for the surrounding stations. All fetches are background + rate-limited.
 */
export async function initLogoService(location?: { lat: number; lon: number }): Promise<void> {
  // Images moved from SQLite blobs to files: drain the old tables once. Each
  // migrated blob becomes that station's MASTER and gets the trim + size ladder,
  // so logos assigned before prep-on-assign existed are fixed in place rather
  // than staying small until reassigned. Awaited so the first render reads files.
  try { await migrateLogosFromDb(); } catch { /* best effort */ }
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
