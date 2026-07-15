/**
 * On-device access to the bundled station database (addendum §3–§7).
 *
 * The DB (assets/db/stations.sqlite) is produced by tools/build_station_db/ from
 * the FCC LMS files and shipped in the APK. At runtime it's copied once into the
 * SQLite dir (a WRITABLE location) and opened. Station rows are read-only
 * reference data; **logos live in the SAME db** (the `logos` table, blobs) and
 * are written at runtime, plus a `logo_wanted` queue for stations seen offline.
 *
 * When the bundled data is refreshed (DB_ASSET_VERSION bump) the copy is replaced
 * with the new asset, so runtime-acquired logos + the wanted queue are MIGRATED
 * forward first (bundled logos, if any, take precedence; runtime ones fill gaps).
 *
 * Everything degrades to "empty" if the DB is unbuilt (placeholder ships 0 rows),
 * so the feature never crashes.
 */

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { boundingBox, haversineKm, receivabilityScore } from './stationGeo';
import { bytesToBase64 } from './base64';
import type { StationRow } from './stationTypes';

const DB_NAME = 'stations.sqlite';
// Bump whenever you rebuild + rebundle the DB (see tools/build_station_db). On a
// bump the stale copy is replaced with the new asset; logos/wanted are migrated.
const DB_ASSET_VERSION = '2';

const LOGO_DDL = `
  CREATE TABLE IF NOT EXISTS logos (
    callsign_base TEXT PRIMARY KEY, img BLOB, mime TEXT,
    genre TEXT, homepage TEXT, source TEXT, fetched_at INTEGER);
  CREATE TABLE IF NOT EXISTS logo_wanted (
    callsign_base TEXT PRIMARY KEY, marked_at INTEGER);`;

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
          carryLogos = await old.getAllAsync<LogoRow>('SELECT * FROM logos WHERE img IS NOT NULL').catch(() => []);
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
      return nd;
    }

    const d = await SQLite.openDatabaseAsync(DB_NAME);
    await d.execAsync(LOGO_DDL); // safety: ensure tables exist on any copy
    return d;
  } catch (e) {
    console.warn('[stationDb] open failed', e);
    return null;
  }
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

// ── logos (same db) ──────────────────────────────────────────────────────────
/** Logo as a data URI for RN <Image>, or null if none stored. */
export async function getLogoDataUri(base: string): Promise<string | null> {
  const d = await db();
  if (!d || !base) return null;
  try {
    const row = await d.getFirstAsync<{ img: Uint8Array | null; mime: string | null }>(
      `SELECT img, mime FROM logos WHERE callsign_base = ?`, [base.toUpperCase()]);
    if (!row?.img) return null;
    return `data:${row.mime || 'image/png'};base64,${bytesToBase64(row.img)}`;
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

/** Assign a logo by hand (sticky — auto sources won't overwrite it). */
export async function setManualLogo(base: string, img: Uint8Array, mime: string): Promise<void> {
  await saveLogo(base, img, mime, null, null, 'manual');
}

/** The source that last set a station's stored logo, or null. */
export async function logoSourceOf(base: string): Promise<string | null> {
  const d = await db();
  if (!d || !base) return null;
  try {
    const r = await d.getFirstAsync<{ source: string | null }>(
      `SELECT source FROM logos WHERE callsign_base = ?`, [base.toUpperCase()]);
    return r?.source ?? null;
  } catch { return null; }
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

/** True if a real logo (non-null blob) is stored for this station. */
export async function hasLogo(base: string): Promise<boolean> {
  const d = await db();
  if (!d || !base) return false;
  try {
    const r = await d.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM logos WHERE callsign_base = ? AND img IS NOT NULL`, [base.toUpperCase()]);
    return (r?.n ?? 0) > 0;
  } catch { return false; }
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

/** Of the given bases, which have no stored logo yet (need fetching). */
export async function basesMissingLogo(bases: string[]): Promise<string[]> {
  const d = await db();
  if (!d || bases.length === 0) return [];
  const up = bases.map((b) => b.toUpperCase());
  try {
    const placeholders = up.map(() => '?').join(',');
    const have = await d.getAllAsync<{ callsign_base: string }>(
      `SELECT callsign_base FROM logos WHERE img IS NOT NULL AND callsign_base IN (${placeholders})`, up);
    const haveSet = new Set(have.map((r) => r.callsign_base));
    return up.filter((b) => !haveSet.has(b));
  } catch { return up; }
}
