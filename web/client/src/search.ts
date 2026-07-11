/**
 * search.ts — station/bookmark/band search for the web client.
 *
 * Three sources, ordered the way the app orders them (server first, EiBi as
 * fallback, band plan ALWAYS included — that ordering is what fixed Kiwi search):
 *
 *   1. USER bookmarks — local to this browser, exportable. The app's own module
 *      does the work (userBookmarks.ts, aliased onto localStorage at bundle time)
 *      so the export is byte-compatible with the phone AND with desktop UberSDR.
 *   2. SERVER stations — GET /stations on the shim. That's the EiBi schedule the
 *      APP downloaded and cached, handed over when Server mode started. The
 *      browser can't fetch eibispace.de itself: it sends no CORS headers, and
 *      unlike React Native a browser enforces them.
 *   3. BAND PLAN — always searched, bundled, offline.
 *
 * A future "save to server" (shared list, gated behind the admin password once
 * public use lands) drops in as a fourth source — the shape here allows for it.
 */

import {
  loadUserBookmarks, saveUserBookmarks, exportBookmarksJSON,
  parseBookmarksAny, mergeBookmarks, type UserBookmark,
} from '../../../src/services/userBookmarks';
import { BAND_PLAN } from '../../../src/constants/bandPlan';
import type { SDRMode } from './spectrum';

export type ResultSource = 'user' | 'server' | 'eibi' | 'band';

export interface SearchResult {
  name: string;
  frequency: number;         // Hz
  mode?: string;
  source: ResultSource;
  detail?: string;           // group / comment / band type
  flag?: string;             // EiBi transmitter country
  bandwidthLow?: number | null;
  bandwidthHigh?: number | null;
}

/** A station as the shim serves it (src/services/stations.ts ServerBookmark). */
interface ServerStation {
  name: string;
  frequency: number;
  mode?: string;
  group?: string;
  comment?: string;
  flag?: string;
  source?: 'eibi' | 'server' | 'user';
  bandwidth_low?: number;
  bandwidth_high?: number;
}

let stations: ServerStation[] = [];
let bookmarks: UserBookmark[] = [];

/** Pull the server's station list. Absent/offline is fine — we degrade. */
export async function loadStations(host: string): Promise<number> {
  try {
    const r = await fetch(`http://${host}/stations`, { cache: 'no-store' });
    if (!r.ok) return 0;
    const arr = await r.json();
    stations = Array.isArray(arr) ? arr.filter(s => s && s.name && s.frequency) : [];
  } catch {
    stations = [];   // no internet on the phone, or an older shim
  }
  return stations.length;
}

export async function loadBookmarks(): Promise<UserBookmark[]> {
  bookmarks = await loadUserBookmarks();
  return bookmarks;
}

export function getBookmarks(): UserBookmark[] { return bookmarks; }

export async function addBookmark(b: Omit<UserBookmark, 'scope'>): Promise<void> {
  bookmarks = mergeBookmarks(bookmarks, [{ ...b, scope: '' }]);
  await saveUserBookmarks(bookmarks);
}

export async function removeBookmark(name: string, frequency: number): Promise<void> {
  bookmarks = bookmarks.filter(b => !(b.name === name && b.frequency === frequency));
  await saveUserBookmarks(bookmarks);
}

/** UberSDR-importable JSON — the same file the phone app exports. */
export function exportBookmarks(): string { return exportBookmarksJSON(bookmarks); }

/** Import JSON or YAML (auto-detected), merged into the existing list. */
export async function importBookmarks(text: string): Promise<number> {
  const incoming = parseBookmarksAny(text, '');
  if (!incoming.length) throw new Error('No bookmarks found in that file');
  bookmarks = mergeBookmarks(bookmarks, incoming);
  await saveUserBookmarks(bookmarks);
  return incoming.length;
}

/** "100.7", "100.7M", "7150k", "14.074 MHz" -> Hz. Null if not a frequency. */
function parseFreq(q: string): number | null {
  const m = q.trim().match(/^([\d.]+)\s*(k|khz|m|mhz|hz)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit.startsWith('k')) return Math.round(n * 1e3);
  if (unit.startsWith('m')) return Math.round(n * 1e6);
  if (unit === 'hz') return Math.round(n);
  // Bare number: guess by magnitude, the way a ham would read it.
  if (n < 30) return Math.round(n * 1e6);        // 14.074 -> 14.074 MHz
  if (n < 30_000) return Math.round(n * 1e3);    // 7150 -> 7150 kHz
  return Math.round(n);
}

export function search(query: string, limit = 40): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: SearchResult[] = [];

  // A typed frequency is a result in its own right — the fastest way to tune.
  const hz = parseFreq(q);
  if (hz) {
    out.push({
      name: `Tune ${(hz / 1e6).toFixed(3)} MHz`,
      frequency: hz,
      source: 'band',
      detail: 'Direct entry',
    });
  }

  const hit = (s: string | undefined | null) => !!s && s.toLowerCase().includes(q);

  // 1. User bookmarks first — the user's own list outranks everything.
  for (const b of bookmarks) {
    if (hit(b.name) || hit(b.group) || hit(b.comment)) {
      out.push({
        name: b.name, frequency: b.frequency, mode: b.mode, source: 'user',
        detail: b.group || b.comment || undefined,
        bandwidthLow: b.bandwidth_low, bandwidthHigh: b.bandwidth_high,
      });
    }
  }

  // 2. Server stations (the app's cached EiBi).
  for (const s of stations) {
    if (hit(s.name) || hit(s.group) || hit(s.comment)) {
      out.push({
        name: s.name, frequency: s.frequency, mode: s.mode,
        source: s.source === 'server' ? 'server' : 'eibi',
        detail: s.group || s.comment || undefined,
        flag: s.flag,
        bandwidthLow: s.bandwidth_low, bandwidthHigh: s.bandwidth_high,
      });
      if (out.length > limit * 4) break;   // bound the scan; EiBi is ~10k rows
    }
  }

  // 3. Band plan — ALWAYS searched, never filtered out by the sources above.
  for (const b of BAND_PLAN) {
    if (hit(b.name) || hit(b.type) || hit(b.bandLabel)) {
      out.push({
        name: b.name,
        // Tuning to a BAND means parking in the middle of it.
        frequency: Math.round((b.lo + b.hi) / 2),
        mode: b.mode,
        source: 'band',
        detail: `${b.type} · ${(b.lo / 1e6).toFixed(3)}–${(b.hi / 1e6).toFixed(3)} MHz`,
      });
    }
  }

  // Closest-frequency-first within the same relevance is more useful than
  // alphabetical, but keep source order as the primary key.
  const rank: Record<ResultSource, number> = { user: 0, server: 1, eibi: 2, band: 3 };
  out.sort((a, b) => rank[a.source] - rank[b.source]);
  return out.slice(0, limit);
}

export type { UserBookmark, SDRMode };
