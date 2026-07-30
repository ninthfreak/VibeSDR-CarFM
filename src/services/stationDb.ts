/**
 * On-device access to the bundled station database (addendum §3–§7).
 *
 * The DB (assets/db/stations.sqlite) is produced by tools/build_station_db/ from
 * the FCC LMS files and shipped in the APK. At runtime it's copied once into the
 * SQLite dir (a WRITABLE location) and opened. Station rows are read-only
 * reference data.
 *
 * Logo IMAGES no longer live here — they are FILES under <docs>/carfm-logos/
 * (see logoStore.ts), because a DB blob forced every render through a base64
 * `data:` URI that Android's image cache cannot key. The blob tables remain only
 * so the one-time migration can drain them; what stays in the DB is the non-image
 * metadata (genre/homepage/source/TTL), the `logo_wanted` queue, and the
 * per-station hero display prefs.
 *
 * When the bundled data is refreshed (DB_ASSET_VERSION bump) the copy is replaced
 * with the new asset and the wanted queue is carried forward. Logo images are no
 * longer affected by a bump at all — they live outside the DB, so they simply
 * survive it (the blob carry-forward below is vestigial, kept for a device that
 * hasn't run the filesystem migration yet).
 *
 * Everything degrades to "empty" if the DB is unbuilt (placeholder ships 0 rows),
 * so the feature never crashes.
 */

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { boundingBox, haversineKm, receivabilityScore } from './stationGeo';

import type { StationRow } from './stationTypes';

const DB_NAME = 'stations.sqlite';
// Bump whenever you rebuild + rebundle the DB (see tools/build_station_db). On a
// bump the stale copy is replaced with the new asset; logos/wanted are migrated.
// 3 = first real FCC build (LMS snapshot 2026-07-16, 20733 stations).
// 4 = purge of wrong auto-downloaded logos (auto resolution disabled — see
//     logoResolver TODO(logos)); only MANUAL logos survive the migration.
const DB_ASSET_VERSION = '4';

const LOGO_DDL = `
  CREATE TABLE IF NOT EXISTS logos (
    callsign_base TEXT PRIMARY KEY, img BLOB, mime TEXT,
    genre TEXT, homepage TEXT, source TEXT, fetched_at INTEGER);
  CREATE TABLE IF NOT EXISTS logo_wanted (
    callsign_base TEXT PRIMARY KEY, marked_at INTEGER);
  CREATE TABLE IF NOT EXISTS station_prefs (
    callsign_base TEXT PRIMARY KEY, show_call INTEGER, show_freq INTEGER);
  CREATE TABLE IF NOT EXISTS dark_logos (
    callsign_base TEXT PRIMARY KEY, treatment TEXT, chosen INTEGER, img BLOB, updated_at INTEGER);
  CREATE TABLE IF NOT EXISTS logo_renditions (
    callsign_base TEXT, kind TEXT, img BLOB, mime TEXT, w INTEGER, h INTEGER, updated_at INTEGER,
    PRIMARY KEY (callsign_base, kind));`;

let dbPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;

interface LogoRow { callsign_base: string; img: Uint8Array | null; mime: string | null; genre: string | null; homepage: string | null; source: string | null; fetched_at: number | null; }
interface WantedRow { callsign_base: string; marked_at: number | null; }

async function openDb(): Promise<SQLite.SQLiteDatabase | null> {
  try {
    const dir = `${FileSystem.documentDirectory}SQLite`;
    const dbPath = `${dir}/${DB_NAME}`;
    const verPath = `${dir}/${DB_NAME}.version`;

    const dbInfo = await FileSystem.getInfoAsync(dbPath);
    let haveCurrent = dbInfo.exists;
    if (haveCurrent) {
      try {
        const v = await FileSystem.readAsStringAsync(verPath);
        if (v.trim() !== DB_ASSET_VERSION) haveCurrent = false;
      } catch { haveCurrent = false; }
    }

    if (!haveCurrent) {
      // Carry forward runtime logos + the wanted queue from the outgoing copy.
      let carryLogos: LogoRow[] = [];
      let carryWanted: WantedRow[] = [];
      if (dbInfo.exists) {
        try {
          const old = await SQLite.openDatabaseAsync(DB_NAME);
          // Carry ONLY manual logos: the auto chain produced wrong images
          // (device test 2026-07-17), so its rows are dropped by this bump.
          carryLogos = await old.getAllAsync<LogoRow>("SELECT * FROM logos WHERE img IS NOT NULL AND source='manual'").catch(() => []);
          carryWanted = await old.getAllAsync<WantedRow>('SELECT * FROM logo_wanted').catch(() => []);
          await old.closeAsync();
        } catch { /* old copy unreadable — nothing to carry */ }
      }

      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      const asset = Asset.fromModule(require('../../assets/db/stations.sqlite'));
      await asset.downloadAsync();
      if (!asset.localUri) return null;
      if (dbInfo.exists) await FileSystem.deleteAsync(dbPath, { idempotent: true });
      await FileSystem.copyAsync({ from: asset.localUri, to: dbPath });
      await FileSystem.writeAsStringAsync(verPath, DB_ASSET_VERSION);

      const nd = await SQLite.openDatabaseAsync(DB_NAME);
      await nd.execAsync(LOGO_DDL);
      // Bundled logos win (INSERT OR IGNORE keeps them); runtime logos fill gaps.
      for (const l of carryLogos) {
        await nd.runAsync(
          `INSERT OR IGNORE INTO logos(callsign_base,img,mime,genre,homepage,source,fetched_at)
           VALUES (?,?,?,?,?,?,?)`,
          [l.callsign_base, l.img, l.mime, l.genre, l.homepage, l.source, l.fetched_at],
        ).catch(() => {});
      }
      for (const w of carryWanted) {
        await nd.runAsync('INSERT OR IGNORE INTO logo_wanted(callsign_base,marked_at) VALUES (?,?)',
          [w.callsign_base, w.marked_at]).catch(() => {});
      }
      await migratePrefs(nd);   // fresh copy: table is empty, just stamps user_version
      return nd;
    }

    const d = await SQLite.openDatabaseAsync(DB_NAME);
    await d.execAsync(LOGO_DDL); // safety: ensure tables exist on any copy
    await migratePrefs(d);
    return d;
  } catch (e) {
    console.warn('[stationDb] open failed', e);
    return null;
  }
}

/**
 * One-time repair (2026-07). The logo-search overlay used to save
 * show_call = show_freq = 1 on EVERY logo assignment, so every previously
 * downloaded logo persists a "show call sign + frequency" row that pins the
 * hero logo to its smallest size — defeating the logo-only default the design
 * wants (a freshly assigned logo now saves both OFF). Drop those {1,1} rows for
 * stations that actually HAVE a logo so they fall back to the no-show default
 * and fill the hero. Partial choices ({1,0}/{0,1}) and no-logo stations are left
 * untouched. Guarded by PRAGMA user_version so it runs at most once per DB copy.
 */
async function migratePrefs(d: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if ((row?.user_version ?? 0) >= 1) return;
    await d.runAsync(
      `DELETE FROM station_prefs
        WHERE show_call = 1 AND show_freq = 1
          AND callsign_base IN (SELECT callsign_base FROM logos WHERE img IS NOT NULL)`);
    await d.execAsync('PRAGMA user_version = 1');
  } catch (e) { console.warn('[stationDb] migratePrefs failed', e); }
}

function db(): Promise<SQLite.SQLiteDatabase | null> {
  return (dbPromise ??= openDb());
}

// ── stations ─────────────────────────────────────────────────────────────────
interface RawRow {
  callsign: string; callsign_base: string; frequency_mhz: number; service: string;
  station_class: string | null; erp_kw: number | null; lat: number; lon: number;
  city: string | null; state: string | null; facility_id: number;
  has_logo?: number; genre?: string | null; homepage?: string | null;
}
const mapRow = (r: RawRow): StationRow => ({
  callsign: r.callsign, callsignBase: r.callsign_base, frequencyMhz: r.frequency_mhz,
  service: r.service, stationClass: r.station_class, erpKw: r.erp_kw,
  lat: r.lat, lon: r.lon, city: r.city, state: r.state, facilityId: r.facility_id,
});

export interface NearbyDbResult extends StationRow {
  distanceKm: number;
  score: number;
  hasLogo: boolean;
  genre: string | null;
  homepage: string | null;
}

/**
 * Stations within radiusKm of (lat,lon), ranked by receivability (best first).
 * Joins the logos table so callers know which rows already have a logo/genre.
 */
export async function nearbyStations(
  lat: number, lon: number, radiusKm = 100, limit = 100,
): Promise<NearbyDbResult[]> {
  const d = await db();
  if (!d) return [];
  const b = boundingBox(lat, lon, radiusKm);
  let raw: RawRow[];
  try {
    raw = await d.getAllAsync<RawRow>(
      // has_logo is LEGACY and always 0 now (images are files): the join is kept
      // for genre/homepage. stationFinder overrides hasLogo from the logo store.
      `SELECT s.*, (l.img IS NOT NULL) AS has_logo, l.genre AS genre, l.homepage AS homepage
         FROM stations s LEFT JOIN logos l ON l.callsign_base = s.callsign_base
        WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?`,
      [b.minLat, b.maxLat, b.minLon, b.maxLon],
    );
  } catch (e) {
    console.warn('[stationDb] nearby query failed', e);
    return [];
  }
  const out: NearbyDbResult[] = [];
  for (const r of raw) {
    const distanceKm = haversineKm(lat, lon, r.lat, r.lon);
    if (distanceKm > radiusKm) continue;
    out.push({
      ...mapRow(r), distanceKm,
      score: receivabilityScore({ erpKw: r.erp_kw, stationClass: r.station_class, distanceKm }),
      hasLogo: !!r.has_logo, genre: r.genre ?? null, homepage: r.homepage ?? null,
    });
  }
  out.sort((a, b2) => b2.score - a.score);
  return out.slice(0, limit);
}

export async function stationsForCallsignBase(base: string): Promise<StationRow[]> {
  const d = await db();
  if (!d || !base) return [];
  try {
    const raw = await d.getAllAsync<RawRow>(
      `SELECT * FROM stations WHERE callsign_base = ?`, [base.toUpperCase()]);
    return raw.map(mapRow);
  } catch (e) {
    console.warn('[stationDb] callsign lookup failed', e);
    return [];
  }
}

export async function snapshotDate(): Promise<string | null> {
  const d = await db();
  if (!d) return null;
  try {
    const row = await d.getFirstAsync<{ value: string }>(
      `SELECT value FROM meta WHERE key = 'lms_snapshot_date'`);
    const v = row?.value ?? null;
    return v && v !== 'unbuilt' ? v : null;
  } catch { return null; }
}

/**
 * Upsert enrichment for a station. `img === null` records a known miss (no logo)
 * so we don't retry forever; a station saved here is cleared from the queue.
 */
export async function saveLogo(
  base: string, img: Uint8Array | null, mime: string | null,
  genre: string | null, homepage: string | null, source: string,
): Promise<void> {
  const d = await db();
  if (!d || !base) return;
  const key = base.toUpperCase();
  try {
    // A manually-assigned logo is sticky: an auto source never overwrites it
    // (only another 'manual' write can). See resolveLogo / setManualLogo.
    await d.runAsync(
      `INSERT INTO logos(callsign_base,img,mime,genre,homepage,source,fetched_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(callsign_base) DO UPDATE SET
         img=excluded.img, mime=excluded.mime, genre=excluded.genre,
         homepage=excluded.homepage, source=excluded.source, fetched_at=excluded.fetched_at
       WHERE logos.source IS NOT 'manual' OR excluded.source = 'manual'`,
      [key, img, mime, genre, homepage, source, Date.now()],
    );
    await d.runAsync('DELETE FROM logo_wanted WHERE callsign_base = ?', [key]);
  } catch (e) { console.warn('[stationDb] saveLogo failed', e); }
}

// ── images live on the FILESYSTEM now (see logoStore.ts) ─────────────────────
// Logo IMAGES were SQLite blobs, which forced every render through a base64
// `data:` URI — 33% bigger, shipped across the JS bridge as a string, and
// re-decoded each time because the native image cache cannot key a data URI.
// They are now files under <docs>/carfm-logos/ addressed by `file://` URI.
// The two helpers below exist ONLY so the one-time migration can drain the old
// tables; nothing else in the app reads or writes logo bytes here.

/** Every logo still stored as a blob — the migration's input. */
export async function allStoredLogos(): Promise<
  Array<{ base: string; img: Uint8Array; mime: string | null; source: string | null }>
> {
  const d = await db();
  if (!d) return [];
  try {
    const rows = await d.getAllAsync<{ callsign_base: string; img: Uint8Array | null; mime: string | null; source: string | null }>(
      'SELECT callsign_base, img, mime, source FROM logos WHERE img IS NOT NULL');
    return rows.filter((r) => r.img?.length)
      .map((r) => ({ base: r.callsign_base, img: r.img as Uint8Array, mime: r.mime, source: r.source }));
  } catch { return []; }
}

/** Drop ONE station's image blob, once its bytes are safely on the filesystem. */
export async function dropLogoBlob(base: string): Promise<void> {
  const d = await db();
  if (!d) return;
  const key = base.toUpperCase();
  try {
    await d.runAsync('UPDATE logos SET img = NULL, mime = NULL WHERE callsign_base = ?', [key]);
    await d.runAsync('DELETE FROM dark_logos WHERE callsign_base = ?', [key]);
    await d.runAsync('DELETE FROM logo_renditions WHERE callsign_base = ?', [key]);
  } catch (e) { console.warn('[stationDb] dropLogoBlob failed', e); }
}

/** Empty every image table so no stale second copy survives on disk. */
export async function dropAllLogoBlobs(): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    await d.execAsync('DELETE FROM logos; DELETE FROM dark_logos; DELETE FROM logo_renditions;');
  } catch (e) { console.warn('[stationDb] dropAllLogoBlobs failed', e); }
}

/** Clear the per-station hero display choices (they default off a logo's
 *  existence, so a logo wipe must take them with it). */
export async function clearAllStationPrefs(): Promise<void> {
  const d = await db();
  if (!d) return;
  try { await d.execAsync('DELETE FROM station_prefs; DELETE FROM logo_wanted;'); }
  catch (e) { console.warn('[stationDb] clearAllStationPrefs failed', e); }
}

// ── per-station hero display prefs (§6.4 Display Call Sign / Display Frequency) ──
/** Whether to show the call sign / frequency on the HERO for a station, as the
 *  user explicitly set it in the logo window — or `null` when unset. The default
 *  is logo-dependent (v1.9.0: logo → both off, no logo → both on) and is applied
 *  by the caller, which knows whether a logo exists. Affects the hero only. */
export async function getStationPrefs(base: string): Promise<{ showCall: boolean; showFreq: boolean } | null> {
  const d = await db();
  if (!d || !base) return null;
  try {
    const r = await d.getFirstAsync<{ show_call: number | null; show_freq: number | null }>(
      `SELECT show_call, show_freq FROM station_prefs WHERE callsign_base = ?`, [base.toUpperCase()]);
    if (!r) return null;
    return { showCall: r.show_call !== 0, showFreq: r.show_freq !== 0 };
  } catch { return null; }
}

export async function setStationPrefs(base: string, showCall: boolean, showFreq: boolean): Promise<void> {
  const d = await db();
  if (!d || !base) return;
  try {
    await d.runAsync(
      `INSERT INTO station_prefs(callsign_base,show_call,show_freq) VALUES (?,?,?)
       ON CONFLICT(callsign_base) DO UPDATE SET show_call=excluded.show_call, show_freq=excluded.show_freq`,
      [base.toUpperCase(), showCall ? 1 : 0, showFreq ? 1 : 0]);
  } catch (e) { console.warn('[stationDb] setStationPrefs failed', e); }
}

/**
 * When a station's logo was last fetched — for hits AND recorded misses — so the
 * network layer can honour a TTL and not re-hit. null = never attempted.
 */
export async function logoFetchedAt(base: string): Promise<number | null> {
  const d = await db();
  if (!d || !base) return null;
  try {
    const r = await d.getFirstAsync<{ fetched_at: number | null }>(
      `SELECT fetched_at FROM logos WHERE callsign_base = ?`, [base.toUpperCase()]);
    return r ? (r.fetched_at ?? 0) : null;
  } catch { return null; }
}

/** Mark a station's logo as wanted (seen offline / fetch failed). */
export async function markWanted(base: string): Promise<void> {
  const d = await db();
  if (!d || !base) return;
  try {
    // Don't queue one we already have.
    await d.runAsync(
      `INSERT OR IGNORE INTO logo_wanted(callsign_base, marked_at)
       SELECT ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM logos WHERE callsign_base = ? AND img IS NOT NULL)`,
      [base.toUpperCase(), Date.now(), base.toUpperCase()]);
  } catch { /* ignore */ }
}

/** The wanted-logo queue (oldest first), capped. */
export async function wantedBases(limit = 200): Promise<string[]> {
  const d = await db();
  if (!d) return [];
  try {
    const rows = await d.getAllAsync<{ callsign_base: string }>(
      `SELECT callsign_base FROM logo_wanted ORDER BY marked_at ASC LIMIT ?`, [limit]);
    return rows.map((r) => r.callsign_base);
  } catch { return []; }
}
