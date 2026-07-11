/**
 * asyncStorage.ts — browser stand-in for @react-native-async-storage/async-storage.
 *
 * Aliased in at bundle time (scripts/build-web.mjs) so the web client can import
 * the APP's modules verbatim — src/services/userBookmarks.ts in particular, whose
 * YAML/JSON parsers, kHz heuristic, merge and UberSDR-compatible export are all
 * logic we'd otherwise have to fork and keep in sync.
 *
 * Same async contract, backed by localStorage.
 */

const mem = new Map<string, string>();

function ls(): Storage | null {
  try { return window.localStorage; } catch { return null; }   // private mode etc.
}

export default {
  async getItem(key: string): Promise<string | null> {
    const s = ls();
    return s ? s.getItem(key) : (mem.get(key) ?? null);
  },
  async setItem(key: string, value: string): Promise<void> {
    const s = ls();
    if (s) s.setItem(key, value); else mem.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    const s = ls();
    if (s) s.removeItem(key); else mem.delete(key);
  },
  async multiRemove(keys: string[]): Promise<void> {
    for (const k of keys) await this.removeItem(k);
  },
  async getAllKeys(): Promise<string[]> {
    const s = ls();
    if (!s) return [...mem.keys()];
    return Array.from({ length: s.length }, (_, i) => s.key(i)!).filter(Boolean);
  },
};
