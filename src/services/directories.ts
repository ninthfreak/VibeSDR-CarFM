// SDR directory providers — separate receiver lists the picker presents as
// distinct "directories" (like different websites). Each is fetched on demand
// and normalised to SDRInstance[]; duplicates ACROSS directories are fine (they
// are independent lists). Unsupported server types (WebSDR/Nova/Phantom) are
// filtered out — we only handle UberSDR / OpenWebRX / KiwiSDR.

import { SDRInstance, fetchInstances } from './instancesApi';

export type DirectoryId = 'ubersdr' | 'receiverbook' | 'kiwisdr';

export interface DirectoryMeta {
  id:    DirectoryId;
  name:  string;
  desc:  string;
  /** which backends this directory yields — drives the footer logo/labels. */
  kinds: ('ubersdr' | 'owrx' | 'kiwi')[];
}

export const DIRECTORIES: DirectoryMeta[] = [
  { id: 'ubersdr',     name: 'UberSDR',     desc: 'Official UberSDR instances',                 kinds: ['ubersdr'] },
  { id: 'receiverbook', name: 'Receiverbook', desc: 'OpenWebRX + KiwiSDR (receiverbook.de)',     kinds: ['owrx', 'kiwi'] },
  { id: 'kiwisdr',     name: 'KiwiSDR',     desc: 'Public KiwiSDR network (kiwisdr.com)',        kinds: ['kiwi'] },
];

const RECEIVERBOOK_URL = 'https://www.receiverbook.de/map';
const KIWI_LIST_URL    = 'http://rx.linkfanel.net/kiwisdr_com.js';

/** Pull a `var <name> = [ … ];` array out of a JS/HTML blob by walking balanced
 *  brackets (string-aware) — the arrays are large and nested, so a regex can't
 *  reliably find the closing bracket. */
function extractJsArray(text: string, varName: string): any[] | null {
  const start = text.indexOf(varName);
  if (start < 0) return null;
  const open = text.indexOf('[', start);
  if (open < 0) return null;
  let depth = 0, inStr = false, quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) {
      // These arrays are generated JS, not strict JSON — the KiwiSDR list ends
      // every object/array with a trailing comma (`},\n]`), which JSON.parse
      // rejects. Strip trailing commas before parsing.
      const slice = text.slice(open, i + 1).replace(/,(\s*[\]}])/g, '$1');
      try { return JSON.parse(slice); } catch { return null; }
    } }
  }
  return null;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

const blank = (over: Partial<SDRInstance>): SDRInstance => ({
  name: '', url: '', location: '', callsign: '', users: 0, maxUsers: 0,
  online: true, version: null, latitude: null, longitude: null, countryCode: null,
  distance: null, bestSnr: null, ...over,
});

/** receiverbook.de — its /map page embeds `var receivers = [ {label, url,
 *  location:{coordinates:[lng,lat]}, receivers:[{type,version,url,label}]} ]`.
 *  Flatten to individual receivers, keep only OWRX/Kiwi (drop WebSDR/unknown). */
async function fetchReceiverbook(lat?: number, lon?: number): Promise<SDRInstance[]> {
  const res = await fetch(RECEIVERBOOK_URL);
  const html = await res.text();
  const sites = extractJsArray(html, 'var receivers');
  if (!sites) return [];
  const out: SDRInstance[] = [];
  for (const site of sites) {
    const coords = site?.location?.coordinates;
    const slat = Array.isArray(coords) ? Number(coords[1]) : null;
    const slon = Array.isArray(coords) ? Number(coords[0]) : null;
    for (const ro of site?.receivers ?? []) {
      const t = String(ro?.type ?? '').toLowerCase();
      const kind: SDRInstance['serverType'] | null =
        t === 'openwebrx' ? 'owrx' : t === 'kiwisdr' ? 'kiwi' : null;
      if (!kind) continue;                                   // drop WebSDR etc.
      const url = ro?.url ?? site?.url;
      if (!url) continue;
      out.push(blank({
        name: String(ro?.label ?? site?.label ?? 'Unknown').replace(/<[^>]*>/g, '').slice(0, 120),
        url: String(url).replace(/\/+$/, ''),
        latitude: Number.isFinite(slat) ? slat : null,
        longitude: Number.isFinite(slon) ? slon : null,
        distance: (lat != null && lon != null && Number.isFinite(slat) && Number.isFinite(slon))
          ? haversineKm(lat, lon, slat as number, slon as number) : null,
        version: ro?.version ?? null,
        serverType: kind,
      }));
    }
  }
  return out;
}

/** kiwisdr.com public list (via linkfanel's snapshot) — `var kiwisdr_com = [ … ]`
 *  with name/url/loc/gps/users/users_max/snr per receiver. */
async function fetchKiwiList(lat?: number, lon?: number): Promise<SDRInstance[]> {
  const res = await fetch(KIWI_LIST_URL);
  const js = await res.text();
  const arr = extractJsArray(js, 'var kiwisdr_com');
  if (!arr) return [];
  return arr
    .filter((r) => r?.url && String(r?.offline ?? '').toLowerCase() !== 'yes')
    .map((r) => {
      const gps = /\(([-\d.]+),\s*([-\d.]+)\)/.exec(String(r.gps ?? ''));
      const glat = gps ? Number(gps[1]) : null;
      const glon = gps ? Number(gps[2]) : null;
      // "snr":"46,47" → best of the pair
      const snr = String(r.snr ?? '').split(',').map(Number).filter((n) => Number.isFinite(n));
      return blank({
        name: String(r.name ?? 'KiwiSDR').replace(/<[^>]*>/g, '').slice(0, 120),
        url: String(r.url).replace(/\/+$/, ''),
        location: String(r.loc ?? ''),
        users: Number(r.users) || 0,
        maxUsers: Number(r.users_max) || 0,
        latitude: glat, longitude: glon,
        distance: (lat != null && lon != null && glat != null && glon != null)
          ? haversineKm(lat, lon, glat, glon) : null,
        bestSnr: snr.length ? Math.max(...snr) : null,
        serverType: 'kiwi',
      });
    });
}

/** Fetch a directory's instances, normalised + distance-sorted when located. */
export async function fetchDirectory(id: DirectoryId, lat?: number, lon?: number): Promise<SDRInstance[]> {
  let list: SDRInstance[];
  if (id === 'ubersdr')      list = await fetchInstances(lat, lon);
  else if (id === 'receiverbook') list = await fetchReceiverbook(lat, lon);
  else                       list = await fetchKiwiList(lat, lon);
  // distance ascending when we have it, else leave source order
  if (lat != null && lon != null) {
    list = [...list].sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  }
  return list;
}
