// debugMode — the sample line format and the bearing helper.
//
// The format is fixed-column on purpose: a whole drive has to parse to CSV in
// one pass, and a missing value must read as `?` rather than shifting columns.
//
// Run: node tools/tests/debugSample.test.mjs

import { formatSample, bearingDeg, RATING_LABELS, RATING_HINTS } from '../../src/services/debugSample.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};
const check = (name, cond) => { if (!cond) fails++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

const FULL = {
  mhz: 101.5, level: 54, bars: 3,
  lat: 43.07305, lon: -89.40123, accM: 8, speedMs: 27.4, headingDeg: 284, fixAgeS: 2,
  predScore: -12.44, distKm: 31.21, bearingDeg: 118, erpKw: 100, stationClass: 'B', dbCall: 'WIBA-FM',
  rdsGroupsPerSec: 8.13, rdsErrPct: 12, stereoFlips: 3, rdsExpiries: 0,
  sinceTuneS: 118, rating: 'crackle', ratingAgeS: 22,
};

eq('a full sample formats to fixed columns', formatSample(FULL),
  'SMP f=101.5 lvl=54 bars=3 lat=43.07305 lon=-89.40123 acc=8 spd=27.4 hdg=284 fix=2s '
  + 'pred=-12.4 dist=31.2 brg=118 erp=100.0 cls=B call=WIBA-FM '
  + 'rds=8.1/s err=12% flips=3 exp=0 tuned=118s rate=crackle@22s');

// Every unknown becomes `?` and NOTHING is omitted — the column count must not
// change with a missing GPS fix, or the CSV parse shifts.
const EMPTY = {
  mhz: null, level: null, bars: null, lat: null, lon: null, accM: null, speedMs: null,
  headingDeg: null, fixAgeS: null, predScore: null, distKm: null, bearingDeg: null,
  erpKw: null, stationClass: null, dbCall: null, rdsGroupsPerSec: null, rdsErrPct: null,
  stereoFlips: 0, rdsExpiries: 0, sinceTuneS: null, rating: null, ratingAgeS: null,
};
eq('an empty sample keeps every column', formatSample(EMPTY).split(' ').length,
   formatSample(FULL).split(' ').length);
check('and marks the unknowns', formatSample(EMPTY).includes('lat=? lon=? acc=?'));
check('an unrated sample says none', formatSample(EMPTY).includes('rate=none'));
check('a rated one carries its age', formatSample(FULL).includes('rate=crackle@22s'));

// Bearing: due north/east/south/west from a point.
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
check('north is 0',  near(bearingDeg(43, -89, 44, -89), 0));
check('east is 90',  near(bearingDeg(43, -89, 43, -88), 90));
check('south is 180', near(bearingDeg(43, -89, 42, -89), 180));
check('west is 270', near(bearingDeg(43, -89, 43, -90), 270));
// Evansville WWHG from Madison is roughly south-east.
check('WWHG from Madison reads south-east',
  (() => { const b = bearingDeg(43.073, -89.401, 42.780, -89.300); return b > 130 && b < 180; })());

// The vocabulary must stay in step: a label for every hint and vice versa.
eq('four ratings', Object.keys(RATING_LABELS).length, 4);
eq('every label has a hint', Object.keys(RATING_LABELS).sort(), Object.keys(RATING_HINTS).sort());

console.log(fails ? `\ndebugSample: ${fails} FAILED` : '\ndebugSample: ALL PASS');
process.exit(fails ? 1 : 0);
