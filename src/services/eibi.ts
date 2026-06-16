/**
 * eibi.ts — local EiBi shortwave-schedule bookmarks (parity with the network
 * servers, which augment /api/bookmarks with the *currently active* EiBi set).
 *
 * Local SDR has no server doing this, so we fetch the EiBi season schedule
 * (eibispace.de, plain CSV) once a day, cache it, and time-filter client-side:
 * a station only appears while it's scheduled to broadcast (current UTC time +
 * weekday inside its entry's window) and drops off when it's done — exactly how
 * the server feed behaves.
 *
 * CSV columns (semicolon-separated):
 *   kHz ; Time(UTC) ; Days ; ITU ; Station ; Lng ; Target ; Remarks ; P ; Start ; Stop
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ServerBookmark } from './stations';

interface EibiEntry {
  freqHz: number;
  time:   string;   // "HHMM-HHMM"
  days:   string;   // EiBi day code ("", "12345", "1-5", "Mo-Fr", "Sa", …)
  station: string;
  lang:   string;
}

let _entries: EibiEntry[] | null = null;
let _season  = '';
let _date    = '';

// ── Season file: A = summer (≈ last Sun Mar → last Sun Oct), B = winter ──────
function seasonFile(d = new Date()): { file: string; season: string } {
  const m = d.getUTCMonth() + 1, day = d.getUTCDate(), y = d.getUTCFullYear();
  let summer: boolean;
  if (m > 3 && m < 10) summer = true;
  else if (m < 3 || m > 10) summer = false;
  else if (m === 3) summer = day >= 25;   // ~last Sunday of March
  else /* m === 10 */ summer = day < 25;  // ~last Sunday of October
  // EiBi labels a season by the year it started; Jan/Feb belong to the
  // previous year's winter (B) season.
  let yy = y;
  if (!summer && m <= 2) yy = y - 1;
  const season = (summer ? 'a' : 'b') + String(yy).slice(-2);
  return { file: `sked-${season}.csv`, season };
}

function utcDateStr(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function parse(csv: string): EibiEntry[] {
  const out: EibiEntry[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line) continue;
    const f = line.split(';');
    const khz = parseFloat(f[0]);
    if (!isFinite(khz) || khz <= 0) continue;   // skips the header row too
    const station = (f[4] || '').trim();
    if (!station) continue;
    out.push({
      freqHz: Math.round(khz * 1000),
      time:  (f[1] || '').trim(),
      days:  (f[2] || '').trim(),
      station,
      lang:  (f[5] || '').trim(),
    });
  }
  return out;
}

function timeActive(t: string, nowMin: number): boolean {
  const m = t.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return true;                       // unknown format → don't hide
  const s = (+m[1]) * 60 + (+m[2]);
  const e = (+m[3]) * 60 + (+m[4]);          // 2400 → 1440
  if (s === e) return true;                  // 0000-0000 = continuous
  return s < e ? (nowMin >= s && nowMin < e) // normal window
               : (nowMin >= s || nowMin < e); // wraps past midnight
}

const DAYCODE = ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAYNUM: Record<string, number> = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 7 };

function dayActive(days: string, eibiDay: number): boolean {
  const d = days.trim();
  if (!d) return true;                                   // daily
  if (/^[1-7]+$/.test(d)) return d.includes(String(eibiDay));   // "12345"
  let m = d.match(/^([1-7])-([1-7])$/);                  // "1-5"
  if (m) { const a = +m[1], b = +m[2]; return a <= b ? (eibiDay >= a && eibiDay <= b) : (eibiDay >= a || eibiDay <= b); }
  const code = DAYCODE[eibiDay];
  m = d.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)-(Mo|Tu|We|Th|Fr|Sa|Su)$/);  // "Mo-Fr"
  if (m) { const a = DAYNUM[m[1]], b = DAYNUM[m[2]]; return a <= b ? (eibiDay >= a && eibiDay <= b) : (eibiDay >= a || eibiDay <= b); }
  if (/^(Mo|Tu|We|Th|Fr|Sa|Su)(,(Mo|Tu|We|Th|Fr|Sa|Su))*$/.test(d)) return d.includes(code);
  return true;   // dates / "irr" / "alt" / Ramadan etc. → don't hide
}

function activeNow(entries: EibiEntry[]): ServerBookmark[] {
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const eibiDay = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
  const out: ServerBookmark[] = [];
  for (const e of entries) {
    if (!timeActive(e.time, nowMin)) continue;
    if (!dayActive(e.days, eibiDay)) continue;
    out.push({ name: e.station, frequency: e.freqHz, mode: 'am', group: 'EiBi', comment: e.lang || undefined });
  }
  return out;
}

async function ensureLoaded(): Promise<void> {
  const { file, season } = seasonFile();
  const today = utcDateStr();
  if (_entries && _season === season && _date === today) return;

  // Warm from cache first (instant, even if stale) so stations show offline.
  if (!_entries || _season !== season) {
    try {
      const [cs, csv, cd] = await Promise.all([
        AsyncStorage.getItem('lsv_eibi_season'),
        AsyncStorage.getItem('lsv_eibi_csv'),
        AsyncStorage.getItem('lsv_eibi_date'),
      ]);
      if (csv && cs === season) { _entries = parse(csv); _season = season; _date = cd || ''; }
    } catch {}
  }

  // Refresh once a day (or if the season rolled over).
  if (_date !== today || _season !== season) {
    try {
      const res = await fetch(`http://www.eibispace.de/dx/${file}`);
      if (res.ok) {
        const csv = await res.text();
        const parsed = parse(csv);
        if (parsed.length > 0) {
          _entries = parsed; _season = season; _date = today;
          AsyncStorage.setItem('lsv_eibi_csv', csv).catch(() => {});
          AsyncStorage.setItem('lsv_eibi_season', season).catch(() => {});
          AsyncStorage.setItem('lsv_eibi_date', today).catch(() => {});
        }
      }
    } catch { /* keep whatever cache we have */ }
  }
}

/** Currently-active EiBi entries as bookmarks (time + weekday filtered). */
export async function loadActiveEibi(): Promise<ServerBookmark[]> {
  await ensureLoaded();
  return _entries ? activeNow(_entries) : [];
}
