// On-device station-logo cache, keyed by RDS country+PI. A logo discovered
// online (on ANY backend — FM-DX or local RTL-SDR) is downloaded to disk and
// remembered against the station's PI code, so it displays OFFLINE later — e.g.
// discover Pride Radio's logo on an FM-DX server, then tune it locally on an
// offline RTL-SDR (the PI + ECC decode locally, no network). Stale entries
// refresh in the background when online so logo changes are picked up.
//
// NOTE: the online source (Radio-Browser) was removed; lookupStationLogo returns
// null until the logo-search rework lands, so this resolves to cached/null only.

import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lookupStationLogo } from './stationLogo';
import { receiverIso } from './rdsCountry';
import { AUTO_LOGO_RESOLUTION } from './logoResolver';

const DIR = FileSystem.documentDirectory + 'stationlogos/';
const INDEX_KEY = 'lsv_logo_cache_v1';
const REFRESH_MS = 14 * 24 * 3600 * 1000;   // re-fetch a cached logo after ~2 weeks

interface Entry { path: string; url: string; ts: number }
let index: Record<string, Entry> | null = null;

async function loadIndex(): Promise<Record<string, Entry>> {
  if (index) return index;
  try { index = JSON.parse((await AsyncStorage.getItem(INDEX_KEY)) || '{}'); }
  catch { index = {}; }
  return index!;
}
async function saveIndex(): Promise<void> {
  try { await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index || {})); } catch {}
}

/** Country+PI identifies a station uniquely (same PI = different station across
 *  countries). Both come from RDS, so this key is available offline too. */
function keyFor(pi?: string, iso?: string): string {
  return pi ? `${(iso || '').toUpperCase()}|${pi.toUpperCase()}` : '';
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

async function download(url: string, key: string): Promise<string | null> {
  try {
    await ensureDir();
    const ext = (url.match(/\.(png|jpe?g|webp|gif)/i)?.[1] || 'img').toLowerCase();
    const path = `${DIR}${key.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;
    const res = await FileSystem.downloadAsync(url, path);
    return res.status === 200 ? path : null;
  } catch { return null; }
}

async function refresh(key: string, name: string, iso?: string): Promise<void> {
  // receiverIso() is a PREFERENCE, not a filter: it searches the receiver's own
  // country first (a global name search buries the local station — "Kiss" found a
  // Greek one because the UK one was nowhere near the top by votes) but still falls
  // back worldwide, so a sporadic-E catch from abroad is not excluded.
  const url = await lookupStationLogo(name, iso, receiverIso() || undefined);   // no-op offline (returns null)
  if (!url) return;
  const path = await download(url, key);
  if (path) { (await loadIndex())[key] = { path, url, ts: Date.now() }; await saveIndex(); }
}

/** Wipe every downloaded logo: delete the on-disk files and the index. Used by
 *  the settings "Clear downloaded logos" action (wrong auto-logos may already be
 *  cached on installed devices; see logoResolver.AUTO_LOGO_RESOLUTION). */
export async function clearLogoCache(): Promise<void> {
  try { await FileSystem.deleteAsync(DIR, { idempotent: true }); } catch {}
  try { await AsyncStorage.removeItem(INDEX_KEY); } catch {}
  index = {};
}

/**
 * Resolve a station logo, cache-first (offline-capable):
 *  1. Cached (by country+PI) → return the local file URI; refresh in the
 *     background if stale + online.
 *  2. Not cached → online lookup, download, cache by PI (no source yet — rework pending).
 *  3. Offline + not cached → null (caller shows a monogram, no placeholder).
 */
export async function resolveStationLogo(opts: { pi?: string; name: string; iso?: string }): Promise<string | null> {
  // TODO(logos): disabled with the rest of AUTO logo resolution (see
  // logoResolver.AUTO_LOGO_RESOLUTION). The Radio-Browser source was removed for
  // producing wrong images (device test 2026-07-17); a new logo search is pending.
  // The DISK CACHE is skipped too: wrong logos may already be cached on installed
  // devices, and showing them is worse than showing none.
  if (!AUTO_LOGO_RESOLUTION) return null;
  const { pi, name, iso } = opts;
  if (!name) return null;
  const key = keyFor(pi, iso);
  const idx = await loadIndex();

  if (key && idx[key]) {
    const e = idx[key];
    const info = await FileSystem.getInfoAsync(e.path);
    if (info.exists) {
      if (Date.now() - e.ts > REFRESH_MS) refresh(key, name, iso).catch(() => {});
      return e.path;
    }
    delete idx[key];   // file vanished — fall through to re-fetch
  }

  const url = await lookupStationLogo(name, iso, receiverIso() || undefined);
  if (!url) return null;
  if (key) {
    const path = await download(url, key);
    if (path) { idx[key] = { path, url, ts: Date.now() }; await saveIndex(); return path; }
  }
  return url;   // no PI to key on / download failed → remote URL (needs network)
}
