import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'vsdr_favourites';

export type Favourite = { name: string; url: string; serverType?: 'ubersdr' | 'kiwi' | 'owrx' };

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

export type TcpFav = { name: string; host: string; port: number };

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

/** Persist a learned serverType onto an existing favourite (after detection). */
export async function setFavouriteServerType(url: string, serverType: 'ubersdr' | 'kiwi' | 'owrx'): Promise<void> {
  const favs = await getFavourites();
  let changed = false;
  const next = favs.map(f => {
    if (f.url === url && f.serverType !== serverType) { changed = true; return { ...f, serverType }; }
    return f;
  });
  if (changed) await saveFavourites(next);
}
