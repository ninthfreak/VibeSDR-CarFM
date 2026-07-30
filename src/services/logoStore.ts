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
 * MASTER RULE: `original.bin` is the bytes exactly as downloaded. It is written
 * once per assignment and NEVER altered. Everything else in the folder is
 * derived from a copy of it and can be deleted and rebuilt at any time:
 *
 *   <docs>/carfm-logos/<BASE>/
 *     original.bin        master — never altered
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

async function exists(uri: string): Promise<boolean> {
  try { return (await FileSystem.getInfoAsync(uri)).exists; } catch { return false; }
}
async function ensureDir(dir: string): Promise<void> {
  try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch { /* exists */ }
}

// ── meta ─────────────────────────────────────────────────────────────────────
export async function getMeta(base: string): Promise<LogoMeta | null> {
  try {
    const s = await FileSystem.readAsStringAsync(p(base, 'meta.json'));
    return JSON.parse(s) as LogoMeta;
  } catch { return null; }
}

export async function setMeta(base: string, patch: Partial<LogoMeta>): Promise<void> {
  const cur = (await getMeta(base)) ?? { mime: 'image/png', source: 'manual', fetchedAt: Date.now() };
  const next = { ...cur, ...patch };
  await ensureDir(logoDir(base));
  try { await FileSystem.writeAsStringAsync(p(base, 'meta.json'), JSON.stringify(next)); } catch { /* best effort */ }
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
  await ensureDir(logoDir(base));
  await FileSystem.writeAsStringAsync(p(base, 'original.bin'), bytesToBase64(bytes),
    { encoding: FileSystem.EncodingType.Base64 });
  await setMeta(base, { mime, source, fetchedAt: Date.now(), sizes: [], darkSizes: [], w: undefined, h: undefined, aspect: undefined });
}

export async function hasOriginal(base: string): Promise<boolean> {
  return exists(p(base, 'original.bin'));
}

/** The master as base64 (no data-URI prefix) — the input for every derivation. */
export async function readOriginalBase64(base: string): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(p(base, 'original.bin'), { encoding: FileSystem.EncodingType.Base64 });
  } catch { return null; }
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
      .filter((n) => n !== 'original.bin' && n !== 'meta.json')
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
  const n = ladderFor(boxDp, meta?.sizes);
  if (n != null) return `${p(base, `d-${n}.png`)}`;
  if (await exists(p(base, 'display.png'))) return p(base, 'display.png');
  return (await hasOriginal(base)) ? p(base, 'original.bin') : null;
}

/** The dark-adapted image as a `file://` URI, or null if none is cached. */
export async function darkUri(base: string, boxDp?: number): Promise<{ uri: string; treatment: string } | null> {
  const meta = await getMeta(base);
  if (!meta?.dark) return null;
  const n = ladderFor(boxDp, meta.darkSizes);
  const file = n != null ? `k-${n}.png` : 'dark.png';
  if (!(await exists(p(base, file)))) {
    if (!(await exists(p(base, 'dark.png')))) return null;
    return { uri: p(base, 'dark.png'), treatment: meta.dark.treatment };
  }
  return { uri: p(base, file), treatment: meta.dark.treatment };
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
}

/** Delete every stored logo. Returns how many stations were removed. */
export async function clearAllLogoFiles(): Promise<number> {
  const bases = await listBases();
  try { await FileSystem.deleteAsync(LOGO_ROOT, { idempotent: true }); } catch { /* gone */ }
  await ensureDir(LOGO_ROOT);
  return bases.length;
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
    for (const r of rows) {
      if (!r.img?.length) continue;
      try {
        await putOriginal(r.base, r.img, r.mime || 'image/png', r.source || 'manual');
        await prep.prepareLogoRenditions(r.base);
        moved++;
      } catch { /* skip a bad row */ }
    }
    await db.dropAllLogoBlobs();     // the DB is out of the image business
  } catch { /* DB unreadable — nothing to migrate */ }
  try { await FileSystem.writeAsStringAsync(MIGRATED_MARK, String(Date.now())); } catch { /* retry next launch */ }
  return moved;
}

export { bytesToBase64, base64ToBytes };
