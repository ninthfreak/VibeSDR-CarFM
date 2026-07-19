import type { BackendType } from './sdrTypes';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vsdr_favourites';

// SpyServer favourites carry url = spyserver://host:port (the protocol has no
// web UI to point a browser at); the picker routes on serverType.
export type Favourite = { name: string; url: string; serverType?: BackendType };

export async function getFavourites(): Promise<Favourite[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveFavourites(favs: Favourite[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(favs));
}

export async function toggleFavourite(fav: Favourite, current: Favourite[]): Promise<Favourite[]> {
  const exists = current.some(f => f.url === fav.url);
  const next = exists
    ? current.filter(f => f.url !== fav.url)
    : [...current, { name: fav.name, url: fav.url, serverType: fav.serverType }];
  await saveFavourites(next);
  return next;
}

// ── RTL-TCP named favourites (host:port + friendly name) ──────────────────────
const TCP_KEY = 'vsdr_rtltcp_favs';

// `proto` is optional for backwards compatibility: favourites saved before
// SpyServer support existed have no field and must keep resolving to rtl_tcp.
export type TcpFav = { name: string; host: string; port: number; proto?: BackendType };

export async function getTcpFavs(): Promise<TcpFav[]> {
  try {
    const raw = await AsyncStorage.getItem(TCP_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveTcpFavs(favs: TcpFav[]): Promise<void> {
  await AsyncStorage.setItem(TCP_KEY, JSON.stringify(favs));
}

/**
 * One-shot repair for the v8.0.0 mis-detection.
 *
 * detectServerType() matched "vibesdr" as well as "vibeserver" — but "vibesdr"
 * is the CLIENT's name: UberSDR instances carry carfm:// deep-link banners, so
 * genuine UberSDR pages matched the VibeServer rule. The picker treats detection
 * as authoritative, so it wrote 'vibeserver' back over the saved favourite: the
 * corruption is PERSISTED, and fixing the detector alone would not undo it.
 *
 * So: strip the type from any favourite v8 marked 'vibeserver'. We clear rather
 * than force to 'ubersdr' because a few of them may be real VibeServers — the
 * (now fixed) detector re-derives the correct type on the next connect, and an
 * unreachable host falls back to 'ubersdr', which is right for the vast majority.
 */
const VIBESERVER_FIX_KEY = 'vsdr_fav_vibeserver_fix_v1';

export async function repairVibeserverFavourites(): Promise<void> {
  try {
    if (await AsyncStorage.getItem(VIBESERVER_FIX_KEY)) return;   // already run
    const favs = await getFavourites();
    if (favs.some(f => f.serverType === 'vibeserver')) {
      await saveFavourites(favs.map(f =>
        f.serverType === 'vibeserver' ? { name: f.name, url: f.url } : f));
    }
    await AsyncStorage.setItem(VIBESERVER_FIX_KEY, '1');
  } catch {
    // Never block startup on the repair — a failed pass retries next launch.
  }
}

/** Persist a learned serverType onto an existing favourite (after detection). */
export async function setFavouriteServerType(url: string, serverType: BackendType): Promise<void> {
  const favs = await getFavourites();
  let changed = false;
  const next = favs.map(f => {
    if (f.url === url && f.serverType !== serverType) { changed = true; return { ...f, serverType }; }
    return f;
  });
  if (changed) await saveFavourites(next);
}
