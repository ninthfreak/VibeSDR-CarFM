// Differential harness, TypeScript side. Mirrors core/stations/examples/dump.rs
// line for line — if you change what one prints, change the other.
//
// Imports the REAL modules the app ships, not a transcription of them. That is
// the whole value: a divergence here means the Rust port and the running app
// disagree, not that two test fixtures drifted.
import { readFileSync } from 'fs';

import { haversineKm, boundingBox, receivabilityScore } from '../../src/services/stationGeo.ts';
import { piToCallsign, callsignToPi, callsignBase } from '../../src/services/piCallsign.ts';
import { rankNearby } from '../../src/services/stationRank.ts';
import { identifyFromSource } from '../../src/services/stationIdentify.ts';

const text = readFileSync(process.argv[2], 'utf8').split('\n');
const q = (s) => JSON.stringify(s);
const n = (v) => String(v);
const un = (s) => (s === '\\N' ? null : s);
const unum = (s) => (s === '\\N' ? null : Number(s));

// ── load the row table ───────────────────────────────────────────────────────
let i = 0;
if (!text[0].startsWith('#ROWS')) throw new Error('corpus does not start with #ROWS');
const rowCount = Number(text[0].split('\t')[1]);
i = 1;
const rows = [];
for (; i <= rowCount; i++) {
  const c = text[i].split('\t');
  rows.push({
    callsign: c[0], callsignBase: c[1], frequencyMhz: Number(c[2]), service: c[3],
    stationClass: un(c[4]), erpKw: unum(c[5]), lat: Number(c[6]), lon: Number(c[7]),
    city: un(c[8]), state: un(c[9]), facilityId: Number(c[10]),
  });
}
if (text[i] !== '#SCENARIOS') throw new Error(`expected #SCENARIOS at line ${i}`);
i++;

// The two lookups identification needs, over the in-memory table. These mirror
// stationDb's SQL: an exact match on the base, and full-power only within the
// dial tolerance. Filtering preserves file order, so the stable sorts downstream
// see the same order on both sides.
const source = {
  async forCallsignBase(base) {
    if (!base) return [];
    const k = base.toUpperCase();
    return rows.filter((r) => r.callsignBase === k);
  },
  async atFrequency(mhz) {
    if (!Number.isFinite(mhz) || mhz <= 0) return [];
    return rows.filter((r) => r.service === 'FM' && Math.abs(r.frequencyMhz - mhz) < 0.05);
  },
};

const lines = [];
for (; i < text.length; i++) {
  const line = text[i];
  if (line === '') continue;
  const sp = line.indexOf(' ');
  const cmd = sp === -1 ? line : line.slice(0, sp);
  const rest = sp === -1 ? '' : line.slice(sp + 1);
  const a = rest.split(' ');

  switch (cmd) {
    case 'pi': {
      const d = piToCallsign(Number(a[0]));
      lines.push(`pi ${a[0]} call=${q(d.callsign)} method=${d.method} conf=${d.confident} note=${q(d.note ?? null)}`);
      break;
    }
    case 'tocall':
      lines.push(`tocall ${q(rest)} -> ${n(callsignToPi(rest))}`);
      break;
    case 'base':
      lines.push(`base ${q(rest)} -> ${q(callsignBase(rest))}`);
      break;
    case 'geo':
      lines.push(`geo ${rest} -> ${n(haversineKm(+a[0], +a[1], +a[2], +a[3]))}`);
      break;
    case 'bbox': {
      const b = boundingBox(+a[0], +a[1], +a[2]);
      lines.push(`bbox ${rest} -> ${n(b.minLat)} ${n(b.maxLat)} ${n(b.minLon)} ${n(b.maxLon)}`);
      break;
    }
    case 'score':
      lines.push(`score ${rest} -> ${n(receivabilityScore({
        erpKw: unum(a[0]), stationClass: un(a[1]), distanceKm: +a[2],
      }))}`);
      break;
    case 'nearby': {
      const [lat, lon, radius, limit] = [+a[0], +a[1], +a[2], +a[3]];
      const b = boundingBox(lat, lon, radius);
      // The bounding box is the SQL prefilter; applying it here keeps the harness
      // honest about what rankNearby actually receives in the app.
      const inBox = rows.filter((r) => r.lat >= b.minLat && r.lat <= b.maxLat
        && r.lon >= b.minLon && r.lon <= b.maxLon);
      const ranked = rankNearby(lat, lon, radius, limit, inBox);
      lines.push(`nearby ${rest} -> ${ranked.length}`);
      for (const s of ranked) {
        lines.push(`  ${s.callsign} ${s.callsignBase} ${n(s.frequencyMhz)} ${s.service} d=${n(s.distanceKm)} s=${n(s.score)}`);
      }
      break;
    }
    case 'identify': {
      const pi = Number(a[0]);
      const freq = a[1] === '\\N' ? undefined : Number(a[1]);
      const ps = a.slice(2).join(' ') === '\\N' ? undefined : a.slice(2).join(' ');
      const id = await identifyFromSource(pi, ps, freq, source);
      lines.push(`identify ${rest} -> call=${q(id.callsign)} conf=${id.confident} `
        + `st=${q(id.station ? `${id.station.callsign}|${n(id.station.frequencyMhz)}|${id.station.service}` : null)} `
        + `note=${q(id.note ?? null)}`);
      break;
    }
    default:
      throw new Error(`unknown scenario "${cmd}" at line ${i}`);
  }
}
process.stdout.write(lines.join('\n') + '\n');
