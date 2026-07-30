/**
 * Filesystem logo store — the single source of truth for station logo IMAGES.
 *
 * WHY FILES, NOT DB BLOBS: the images used to live as SQLite blobs, which meant
 * every render handed React Native a base64 `data:` URI. That inflates the bytes
 * ~33%, ships the whole image across the JS bridge as a string, and re-decodes it
 * on every load because the native image cache can't key a data URI. A `file://`
 * URI is read and cached by Android's own image loader — no base64, no bridge
 * payload, decoded bitmaps reused across screens. The DB is out of the image
 * path entirely (its blob tables are migrated once, then emptied).
 *
 * MASTER RULE: `original.<ext>` is the bytes exactly as downloaded (extension
 * from its mime, so it stays a renderable last-resort source). It is written once
 * per assignment and NEVER altered. Everything else in the folder is derived from
 * a copy of it and can be deleted and rebuilt at any time:
 *
 *   <docs>/carfm-logos/<BASE>/
 *     original.<ext>      master — never altered
 *     display.png         trimmed master (baked-in margin removed, §4.5)
 *     dark.png            dark-adapted master
 *     d-<N>.png           display size ladder (N = longest edge in px)
 *     k-<N>.png           dark size ladder
 *     meta.json           mime, source, timestamps, aspect, dark treatment
 *
 * Pre-rendering the ladder is what makes screen loads cheap: a preset strip of
 * 18 tiles decodes 18 small PNGs instead of 18 full-resolution ones.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { PixelRatio } from 'react-native';

import { bytesToBase64, base64ToBytes } from './base64';

export const LOGO_ROOT = `${FileSystem.documentDirectory}carfm-logos/`;

/** Longest-edge sizes pre-rendered for every logo. Covers the chip (~85dp box)
 *  through the hero (256dp tall, up to ~470dp wide) at up to 2× density. */
export const SIZE_LADDER = [128, 256, 512] as const;

export interface LogoMeta {
  /** Master's filename, e.g. "original.png" (older folders: "original.bin"). */
  file?: string;
  mime: string;
  source: string;                 // 'manual' | 'ddg' | …
  fetchedAt: number;
  /** Trimmed-master pixel size + aspect (w/h), recorded at prep time (§4.5). */
  w?: number;
  h?: number;
  aspect?: number;
  /** Ladder sizes actually written, for display and dark. */
  sizes?: number[];
  darkSizes?: number[];
  dark?: { treatment: string; chosen: boolean };
}

const safe = (base: string) => base.toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
export const logoDir = (base: string) => `${LOGO_ROOT}${safe(base)}/`;
const p = (base: string, file: string) => `${logoDir(base)}${file}`;

// Meta is read on every logo lookup (18 preset tiles per frame pass), so cache
// it in memory — the point of this store is fewer I/O round-trips per render.
const metaCache = new Map<string, LogoMeta | null>();

/** Subscribers re-read the store after it changes (migration, assign, clear). */
const storeListeners = new Set<() => void>();
export function subscribeLogoStore(l: () => void): () => void {
  storeListeners.add(l);
  return () => { storeListeners.delete(l); };
}
export function notifyLogosChanged(): void { storeListeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }

async function exists(uri: string): Promise<boolean> {
  try { return (await FileSystem.getInfoAsync(uri)).exists; } catch { return false; }
}
async function ensureDir(dir: string): Promise<void> {
  try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch { /* exists */ }
}

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(base: string): Promise<LogoMeta | null> {
  const k = safe(base);
  if (metaCache.has(k)) return metaCache.get(k)!;
  let meta: LogoMeta | null = null;
  try { meta = JSON.parse(await FileSystem.readAsStringAsync(p(base, 'meta.json'))) as LogoMeta; }
  catch { meta = null; }
  metaCache.set(k, meta);
  return meta;
}

export async function setMeta(base: string, patch: Partial<LogoMeta>): Promise<void> {
  const cur = (await getMeta(base)) ?? { mime: 'image/png', source: 'manual', fetchedAt: Date.now() };
  await writeMeta(base, { ...cur, ...patch });
}

/** Replace meta wholesale (no merge) — used when a new master lands. */
async function writeMeta(base: string, meta: LogoMeta): Promise<void> {
  await ensureDir(logoDir(base));
  metaCache.set(safe(base), meta);
  try { await FileSystem.writeAsStringAsync(p(base, 'meta.json'), JSON.stringify(meta)); } catch { /* best effort */ }
}

// ── master ───────────────────────────────────────────────────────────────────
/**
 * Store the ORIGINAL bytes for a station. Writes the master and wipes every
 * derived file (they belong to the previous original). Never called again for
 * the same image — nothing in the app rewrites a master in place.
 */
export async function putOriginal(
  base: string, bytes: Uint8Array, mime: string, source = 'manual',
): Promise<void> {
  await clearDerived(base);
  await removeMasters(base);
  await ensureDir(logoDir(base));
  // Keep the master's real extension so it is still a renderable <Image> source
  // if prep ever fails (a ".bin" makes the loader guess at the format).
  const file = `original.${extFor(mime)}`;
  await FileSystem.writeAsStringAsync(p(base, file), bytesToBase64(bytes),
    { encoding: FileSystem.EncodingType.Base64 });
  // OVERWRITE meta, never merge: a replaced logo must not inherit the previous
  // one's dark treatment (a stale chosen=true would force the OLD treatment onto
  // the NEW image) or its recorded aspect/ladder.
  await writeMeta(base, { file, mime, source, fetchedAt: Date.now(), sizes: [], darkSizes: [] });
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
};
function extFor(mime: string): string { return EXT[mime.toLowerCase()] ?? 'png'; }

/** Delete any existing master file(s) so a mime change can't leave two behind. */
async function removeMasters(base: string): Promise<void> {
  const dir = logoDir(base);
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(names.filter((n) => n.startsWith('original.'))
      .map((n) => FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})));
  } catch { /* no folder yet */ }
}

/** Absolute path of the master, honouring the extension recorded in meta (older
 *  folders wrote `original.bin`). */
async function masterPath(base: string): Promise<string | null> {
  const meta = await getMeta(base);
  const cands = [meta?.file, 'original.png', 'original.jpg', 'original.webp', 'original.bin']
    .filter((f): f is string => !!f);
  for (const f of cands) if (await exists(p(base, f))) return p(base, f);
  return null;
}

export async function hasOriginal(base: string): Promise<boolean> {
  return (await masterPath(base)) != null;
}

/** The master as base64 (no data-URI prefix) — the input for every derivation. */
export async function readOriginalBase64(base: string): Promise<string | null> {
  const path = await masterPath(base);
  if (!path) return null;
  try { return await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 }); }
  catch { return null; }
}

/** The master as a data URI (only for pipelines that need encoded bytes). */
export async function readOriginalDataUri(base: string): Promise<string | null> {
  const b64 = await readOriginalBase64(base);
  if (!b64) return null;
  const mime = (await getMeta(base))?.mime || 'image/png';
  return `data:${mime};base64,${b64}`;
}

// ── derived files ────────────────────────────────────────────────────────────
/** Write a derived PNG (given as bare base64) into the station's folder. */
export async function putDerivedPng(base: string, file: string, pngBase64: string): Promise<void> {
  await ensureDir(logoDir(base));
  await FileSystem.writeAsStringAsync(p(base, file), pngBase64, { encoding: FileSystem.EncodingType.Base64 });
}

/** Delete every derived file, keeping the master + meta. */
export async function clearDerived(base: string): Promise<void> {
  const dir = logoDir(base);
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(names
      .filter((n) => !n.startsWith('original.') && n !== 'meta.json')
      .map((n) => FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})));
  } catch { /* no folder yet */ }
}

// ── read paths (what the UI renders) ─────────────────────────────────────────
/** Pick the smallest pre-rendered ladder size that still covers `boxDp` at the
 *  screen's density; null → use the full-size master. */
function ladderFor(boxDp: number | undefined, available: number[] | undefined): number | null {
  if (!boxDp || !available?.length) return null;
  const need = boxDp * Math.min(2, PixelRatio.get());
  for (const s of SIZE_LADDER) if (s >= need && available.includes(s)) return s;
  return null;
}

/**
 * The image to DISPLAY, as a `file://` URI: the smallest pre-rendered size that
 * covers `boxDp`, else the trimmed master, else the untouched original.
 * `boxDp` is the longest edge of the box it renders into.
 */
export async function displayUri(base: string, boxDp?: number): Promise<string | null> {
  const meta = await getMeta(base);
  if (!meta) return null;                       // no folder → no logo, no I/O
  const n = ladderFor(boxDp, meta.sizes);
  if (n != null) return p(base, `d-${n}.png`);  // prep wrote it; no need to stat
  // `w` is only set once display.png has been written (prepareLogoRenditions).
  if (meta.w != null) return p(base, 'display.png');
  return masterPath(base);
}

/** The dark-adapted image as a `file://` URI, or null if none is cached. */
export async function darkUri(base: string, boxDp?: number): Promise<{ uri: string; treatment: string } | null> {
  const meta = await getMeta(base);
  if (!meta?.dark) return null;   // meta.dark is only set once dark.png is written
  const n = ladderFor(boxDp, meta.darkSizes);
  return { uri: p(base, n != null ? `k-${n}.png` : 'dark.png'), treatment: meta.dark.treatment };
}

export async function getDarkInfo(base: string): Promise<{ treatment: string; chosen: boolean } | null> {
  return (await getMeta(base))?.dark ?? null;
}

/** Store the dark-adapted master (bare base64 PNG) + its treatment. */
export async function putDark(base: string, treatment: string, pngBase64: string, chosen: boolean): Promise<void> {
  await putDerivedPng(base, 'dark.png', pngBase64);
  await setMeta(base, { dark: { treatment, chosen }, darkSizes: [] });
}

export async function clearDark(base: string): Promise<void> {
  const dir = logoDir(base);
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(names.filter((n) => n === 'dark.png' || n.startsWith('k-'))
      .map((n) => FileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})));
  } catch { /* none */ }
  const meta = await getMeta(base);
  if (meta) { delete meta.dark; meta.darkSizes = []; await setMeta(base, meta); }
}

// ── maintenance ──────────────────────────────────────────────────────────────
export async function listBases(): Promise<string[]> {
  try {
    // Skip bookkeeping dotfiles (the migration marker) — they aren't stations.
    return (await FileSystem.readDirectoryAsync(LOGO_ROOT)).filter((n) => !n.startsWith('.'));
  } catch { return []; }
}

export async function removeLogo(base: string): Promise<void> {
  try { await FileSystem.deleteAsync(logoDir(base), { idempotent: true }); } catch { /* gone */ }
  metaCache.delete(safe(base));
  notifyLogosChanged();
}

/** Delete every stored logo. Returns how many stations were removed. */
export async function clearAllLogoFiles(): Promise<number> {
  const bases = await listBases();
  try { await FileSystem.deleteAsync(LOGO_ROOT, { idempotent: true }); } catch { /* gone */ }
  await ensureDir(LOGO_ROOT);
  metaCache.clear();
  notifyLogosChanged();
  return bases.length;
}

/** Which of these stations DO have a stored logo — one directory listing, no
 *  per-station stat. Callers resolving many rows should filter with this first. */
export async function basesWithLogo(bases: string[]): Promise<string[]> {
  const have = new Set((await listBases()).map((s) => s.toUpperCase()));
  return bases.filter((b) => have.has(safe(b)));
}

/** Which of these stations have NO stored logo. */
export async function basesWithoutLogo(bases: string[]): Promise<string[]> {
  const have = new Set((await listBases()).map((s) => s.toUpperCase()));
  return bases.filter((b) => !have.has(safe(b)));
}

// ── one-time migration off the SQLite blob tables ────────────────────────────
const MIGRATED_MARK = `${LOGO_ROOT}.migrated-v1`;

/**
 * Move any logos still living in the DB onto disk, then EMPTY the blob tables —
 * images are a filesystem concern now and the DB must not keep a stale second
 * copy. Runs once (marker file); safe to call on every launch.
 *
 * Each migrated blob becomes that station's MASTER, and its renditions are built
 * from it — so logos assigned before the trim existed get the trim too, instead
 * of staying small until reassigned. Dark variants are dropped rather than
 * carried: they are cheap to regenerate from the master and the old ones were
 * derived from an untrimmed image.
 */
export async function migrateLogosFromDb(): Promise<number> {
  if (await exists(MIGRATED_MARK)) return 0;
  await ensureDir(LOGO_ROOT);
  let moved = 0;
  try {
    const db = await import('./stationDb');
    const rows = await db.allStoredLogos();
    const prep = await import('./logoPrep');
    let failed = 0;
    for (const r of rows) {
      if (!r.img?.length) continue;
      try {
        await putOriginal(r.base, r.img, r.mime || 'image/png', r.source || 'manual');
        // Only drop the blob once its bytes are safely on disk — dropping the
        // whole table regardless would destroy any logo that failed to migrate.
        await db.dropLogoBlob(r.base);
        moved++;
        // Renditions are rebuildable, so a prep failure must not fail the row.
        await prep.prepareLogoRenditions(r.base);
        await new Promise((res) => setTimeout(res, 0));   // don't hog the JS thread
      } catch { failed++; }
    }
    // Marker only on a clean pass: a transient write error then retries next
    // launch instead of orphaning those logos forever.
    if (failed === 0) {
      await db.dropAllLogoBlobs();   // sweeps recorded misses / stale dark rows
      try { await FileSystem.writeAsStringAsync(MIGRATED_MARK, String(Date.now())); } catch { /* retry */ }
    }
  } catch { /* DB unreadable — retry next launch */ }
  // The first render happens before this finishes, so nothing would show the
  // migrated logos until some other event invalidated the tiles.
  if (moved > 0) notifyLogosChanged();
  return moved;
}

export { bytesToBase64, base64ToBytes };
