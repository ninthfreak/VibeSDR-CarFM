// Corpus generator for the station differential harness.
//
// Emits one file with two sections: every row of the bundled FCC table, then a
// list of scenario lines. Both the TypeScript dump (tools/tests/stationDump.mjs)
// and the Rust dump (core/stations/examples/stations-dump.rs) read this same file, so
// they see byte-identical inputs in byte-identical order — which matters, since
// bestStation and the nearby sort are both STABLE and therefore depend on it.
//
// The row lookups the scenarios need are done by filtering this array, not by
// re-querying SQLite. The SQL is I/O and lives above the portable core; what is
// under test is what the two implementations do with the rows.
//
// Deterministic: the row order is `ORDER BY facility_id` and every scenario is
// either an exhaustive sweep or a fixed list. No RNG, no clock.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const db = new DatabaseSync(join(repo, 'assets/db/stations.sqlite'), { readOnly: true });
const rows = db.prepare(
  `SELECT callsign, callsign_base, frequency_mhz, service, station_class, erp_kw,
          lat, lon, city, state, facility_id
     FROM stations ORDER BY facility_id`).all();

// \N for NULL so it can never collide with a real empty string.
const f = (v) => (v === null || v === undefined ? '\\N' : String(v));

const out = [];
out.push(`#ROWS\t${rows.length}`);
for (const r of rows) {
  out.push([r.callsign, r.callsign_base, r.frequency_mhz, r.service, r.station_class,
    r.erp_kw, r.lat, r.lon, r.city, r.state, r.facility_id].map(f).join('\t'));
}

out.push('#SCENARIOS');

// ── PI decode: EXHAUSTIVE over the whole 16-bit space ────────────────────────
// The PI is block A of an RDS group, so 0..0xFFFF is the entire real domain.
// Sweeping all of it is cheap and leaves no untested value — including every
// boundary the implementation cares about (the K and W block bases, the A-block
// window, 0xFFFF, and the suffix-overflow edge).
for (let pi = 0; pi <= 0xffff; pi++) out.push(`pi ${pi}`);

// ── callsign -> PI, and base normalisation ───────────────────────────────────
// Every distinct base in the table, so the formula is exercised against real
// callsigns rather than invented ones.
const bases = [...new Set(rows.map((r) => r.callsign_base))].sort();
for (const b of bases) out.push(`tocall ${b}`);
// Plus the shapes the normaliser is supposed to cope with. The last three are
// the JavaScript-regex edge cases callsign_base reproduces deliberately.
for (const odd of ['WOLX-FM', 'wolx-fm', 'WGN', 'K', '', 'WOLX-', '-WOLX', 'W0LX',
  'WOLXFM', '  WOLX  ', 'WÖLX', 'WOLX-FM1', 'WOLX-FM-HD2']) {
  out.push(`base ${odd}`);
  out.push(`tocall ${odd}`);
}

// ── geo ──────────────────────────────────────────────────────────────────────
// Real US city coordinates, plus the guard cases (identical points, the poles,
// the antimeridian).
const PLACES = [
  [43.0731, -89.4012], [41.8781, -87.6298], [40.7128, -74.0060], [34.0522, -118.2437],
  [47.6062, -122.3321], [25.7617, -80.1918], [39.7392, -104.9903], [61.2181, -149.9003],
  [21.3069, -157.8583], [44.9778, -93.2650],
];
for (const [lat, lon] of PLACES) {
  for (const [lat2, lon2] of PLACES) out.push(`geo ${lat} ${lon} ${lat2} ${lon2}`);
  for (const r of [1, 25, 100, 160.9344, 500]) out.push(`bbox ${lat} ${lon} ${r}`);
}
for (const [a, b, c, d] of [[0, 0, 0, 0], [90, 0, -90, 0], [0, 179.9, 0, -179.9], [43.07, -89.4, 43.07, -89.4]]) {
  out.push(`geo ${a} ${b} ${c} ${d}`);
}
for (const [lat, r] of [[90, 100], [-90, 100], [89.99, 500], [0, 1]]) out.push(`bbox ${lat} 0 ${r}`);

// ── receivability score ──────────────────────────────────────────────────────
// 652 rows carry a NULL erp_kw and ALL 20,733 carry a NULL station_class, so the
// null paths are the common case on real data, not an edge case. The classes are
// swept anyway because the column exists and a future DB build may fill it.
for (const erp of ['\\N', '0', '0.001', '0.25', '6', '50', '100']) {
  for (const cls of ['\\N', 'A', 'B', 'B1', 'C', 'C0', 'C1', 'C2', 'C3', 'c1', 'LP', '']) {
    for (const dist of [0, 0.5, 1, 15, 96, 300]) out.push(`score ${erp} ${cls} ${dist}`);
  }
}

// ── nearby ranking, over the real table ──────────────────────────────────────
for (const [lat, lon] of PLACES) {
  for (const [radius, limit] of [[25, 100], [100, 100], [100, 5], [160.9344, 200], [500, 1000]]) {
    out.push(`nearby ${lat} ${lon} ${radius} ${limit}`);
  }
}

// ── identification ───────────────────────────────────────────────────────────
// The PI a real station's callsign encodes to, at its own frequency and at a
// wrong one; the two measured encoder faults; and the corrupt-block-A case.
const sample = rows.filter((r) => r.service === 'FM').filter((_, i) => i % 137 === 0).slice(0, 120);
for (const r of sample) {
  out.push(`identify ${piOf(r.callsign_base)} ${r.frequency_mhz} \\N`);
  out.push(`identify ${piOf(r.callsign_base)} ${(r.frequency_mhz + 4.2).toFixed(1)} \\N`);
  out.push(`identify ${piOf(r.callsign_base)} \\N \\N`);
  out.push(`identify ${piOf(r.callsign_base)} ${r.frequency_mhz} ${r.callsign_base}`);
  out.push(`identify ${piOf(r.callsign_base)} ${r.frequency_mhz} WIBA rocks`);
}
// Bases with NO full-power row. 1,757 of them are formula-decodable, and they
// are the only way into the translator/LPFM branch: the "formula unreliable for
// translators" note, confidence dropping to false on a clean decode, and
// bestStation having to order FL against FX. Sampling only FM stations above
// left all of that unexercised — found by perturbing bestStation and watching
// the harness stay green.
const byBase = new Map();
for (const r of rows) {
  const e = byBase.get(r.callsign_base) ?? { fm: 0, rows: [] };
  if (r.service === 'FM') e.fm++;
  e.rows.push(r);
  byBase.set(r.callsign_base, e);
}
const noFm = [...byBase.entries()]
  .filter(([b, e]) => e.fm === 0 && /^[KW][A-Z]{3}$/.test(b))
  .filter((_, i) => i % 23 === 0);
for (const [b, e] of noFm) {
  const freq = e.rows[0].frequency_mhz;
  out.push(`identify ${piOf(b)} ${freq} \\N`);
  out.push(`identify ${piOf(b)} \\N \\N`);
  out.push(`identify ${piOf(b)} ${(freq + 4.2).toFixed(1)} \\N`);
}

// WIBA-FM 101.5 transmits 0x19E2; WZEE 104.1 transmits 0x1718. Both are real
// encoder faults captured on the unit, and both must salvage off the low bits.
for (const [pi, freq] of [[0x19e2, 101.5], [0x1718, 104.1], [0x19e2, 88.7], [0x1718, 101.5]]) {
  out.push(`identify ${pi} ${freq} \\N`);
  out.push(`identify ${pi} ${freq} WIBA`);
}
// 0xA6FF read as 0x57FF by a corrupt block A — decodes to WBGX, absent from the
// whole table, and must be refused rather than shown.
for (const pi of [0xa6ff, 0x57ff, 0xffff, 0x0000, 0xa000, 0xafff, 0x1000, 0x54a8]) {
  out.push(`identify ${pi} 88.7 \\N`);
  out.push(`identify ${pi} \\N \\N`);
}

// ── PS-text word boundaries, unicode included ────────────────────────────────
// The Rust side reproduces /\b([KW][A-Z]{3})\b/ by hand over UTF-8 bytes.
// Embedded runs must NOT read as callsigns; multi-byte neighbours ARE
// boundaries (JS \w is [A-Za-z0-9_] only); input is uppercased first, and ß
// uppercases to SS, which shifts byte offsets. Frequency is \N so the dial
// gate cannot short-circuit the PS check.
const psHost = rows.find((r) => r.service === 'FM' && /^[KW][A-Z]{3}$/.test(r.callsign_base));
const psPi = piOf(psHost.callsign_base);
for (const ps of [
  'KQRZ NEWS',            // a standalone other callsign: contradiction
  'AKQRZX',               // the same run embedded: no match
  'ROCKQRZ',              // embedded at the end of a word
  'KQRZS',                // trailing word char
  'WKQRZ',                // a W then the run — the K is mid-word
  'Ö KQRZ Ö',             // multi-byte neighbours are boundaries
  'ÖKQRZ',                // multi-byte char directly before: still a boundary
  'kqrz calling',         // lowercase reaches toUpperCase first
  'ßKQRZ',                // uppercases to SSKQRZ: no boundary before K
  '_KQRZ', 'KQRZ_',       // underscore is a word char
  `${psHost.callsign_base} FM`, // names ITSELF: not a contradiction
]) {
  out.push(`identify ${psPi} \\N ${ps}`);
}

// ── non-finite inputs ────────────────────────────────────────────────────────
// JavaScript's Math.min/max PROPAGATE NaN where Rust's f64 min/max discard it,
// and `${Infinity}` prints differently from Rust's default "inf". Both parse
// "nan"/"Infinity" identically, so the corpus can carry them as text.
for (const [erp, cls, dist] of [['nan', 'C1', '15'], ['6', '\\N', 'nan'], ['nan', '\\N', 'nan']]) {
  out.push(`score ${erp} ${cls} ${dist}`);
}
out.push('geo nan 0 43.0731 -89.4012');
out.push('bbox nan 0 100');
out.push(`identify ${psPi} Infinity \\N`);
out.push(`identify ${psPi} nan \\N`);

function piOf(base) {
  // The RBDS formula, inline, so the corpus does not depend on the code it tests.
  if (!/^[KW][A-Z]{3}$/.test(base)) return 0;
  const v = (i) => base.charCodeAt(i) - 65;
  return (base[0] === 'W' ? 21672 : 4096) + v(1) * 676 + v(2) * 26 + v(3);
}

process.stdout.write(out.join('\n') + '\n');
