/**
 * Public facade for the "stations near me" feature — the surface the UI calls.
 * Offline-first: the list always comes from the bundled FCC DB and NEVER blocks
 * on the network. Logos live in the same DB (blobs); they're read instantly and
 * fetched/queued in the background (addendum §1, §7, §8).
 *
 * Logo lifecycle:
 *   - getNearbyStations() returns logos already stored, and lazily fetches ones
 *     it's missing for the rows it returns (fetch self-queues if offline).
 *   - initLogoService() runs at launch: sweeps the wanted queue (stations seen
 *     offline) and, once, prefetches logos for the user's region.
 *   - noteEncountered() marks/fetches a station's logo when it's tuned.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getUserLocation } from './instancesApi';
import { haversineKm } from './stationGeo';
import {
  nearbyStations as dbNearby, stationsForCallsignBase, snapshotDate,
  getLogoDataUri, markWanted, wantedBases, basesMissingLogo,
} from './stationDb';
import { enrichStation } from './radioBrowser';
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
  /** Lazily fetch logos the list is missing (default true). */
  enrich?: boolean;
}

/** Fire background logo fetches for bases we don't have yet (throttled inside). */
async function lazyFetch(bases: string[], cap = 20): Promise<void> {
  const missing = (await basesMissingLogo(bases)).slice(0, cap);
  missing.forEach((b) => { void enrichStation(b); });
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

  // Lazy fetch logos for FM rows we don't have yet (self-queues if offline).
  if (opts.enrich !== false) {
    void lazyFetch(rows.filter((r) => !r.hasLogo && r.service === 'FM').map((r) => r.callsignBase));
  }
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

  // Tuning to it counts as an encounter — get/queue its logo.
  if (station) void noteEncountered(base, station.callsign);
  return { pi, callsign: dec.callsign, confident, station, note };
}

/** A station was tuned/shown — fetch its logo now, or queue it if offline. */
export async function noteEncountered(base: string, nameHint?: string): Promise<void> {
  if (!base) return;
  const missing = await basesMissingLogo([base]);
  if (missing.length === 0) return;          // already have it
  await markWanted(base);                     // ensure it's queued even if the fetch below fails
  void enrichStation(base, nameHint);         // clears the queue entry on success
}

/** On-demand logo for one station (e.g. a row scrolled into view). */
export async function getStationLogo(base: string): Promise<string | null> {
  return getLogoDataUri(base);
}

export async function enrichNow(base: string, nameHint?: string) {
  return enrichStation(base, nameHint);
}

export async function getStationDataDate(): Promise<string | null> {
  return snapshotDate();
}

// ── launch-time logo maintenance ─────────────────────────────────────────────
const PREFETCH_KEY = '@vibesdr/logo_prefetch';
const PREFETCH_MIN_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // at most monthly
const PREFETCH_MOVE_KM = 50;                                // ...or if the car moved region

/** Sweep the wanted queue: retry logos for stations seen while offline. */
export async function sweepWantedLogos(cap = 100): Promise<void> {
  const bases = await wantedBases(cap);
  bases.forEach((b) => { void enrichStation(b); });
}

/** Prefetch logos for stations around a location (throttled inside enrichStation). */
async function regionalPrefetch(lat: number, lon: number, radiusKm = 100, cap = 60): Promise<void> {
  const rows = await dbNearby(lat, lon, radiusKm, 200);
  const bases = rows.filter((r) => r.service === 'FM' && !r.hasLogo).map((r) => r.callsignBase);
  (await basesMissingLogo(bases)).slice(0, cap).forEach((b) => { void enrichStation(b); });
}

/**
 * Call once at launch (ideally after a GPS fix). Sweeps the offline queue, and
 * — at most monthly, or when the car has moved to a new region — prefetches
 * logos for the surrounding stations so the Nearby list is populated on day one.
 * All fetches are background + rate-limited; this never blocks.
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
