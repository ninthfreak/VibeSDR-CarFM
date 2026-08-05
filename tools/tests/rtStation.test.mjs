// stripStationFromRt — trimming a station's own name off its RadioText.
//
// Every input is verbatim from the drive log of 2026-08-04, which is also where
// the decision NOT to split artist from title comes from: WIBA sends both orders.
//
// Run: node tools/tests/rtStation.test.mjs

import { stripStationFromRt } from '../../src/services/rtStation.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

const WIBA = { mhz: 101.5, callsign: 'WIBA' };

// ── The case this exists for: a leading station identifier ───────────────────
eq('leading station id is trimmed',
  stripStationFromRt('101.5 IBA-FM - Walk This Way - Aerosmith', WIBA),
  'Walk This Way - Aerosmith');
eq('both field orders survive equally, unlabelled',
  stripStationFromRt('101.5 IBA-FM - Led Zeppelin - Kashmir', WIBA),
  'Led Zeppelin - Kashmir');
eq('corrupt text is trimmed but not repaired',
  stripStationFromRt('101.5 IBA-FM - Led Zeppelin - Ka  t r', WIBA),
  'Led Zeppelin - Ka  t r');

// ── Trailing, as the adverts carry it ────────────────────────────────────────
eq('a trailing station id is trimmed too',
  stripStationFromRt('NicoletLaw.com  Injured? Get Nicolet! - 101.5 IBA-FM', WIBA),
  'NicoletLaw.com  Injured? Get Nicolet!');

// ── Everything else passes through ───────────────────────────────────────────
eq('a slogan is left alone', stripStationFromRt("Madison's Classic Rock", WIBA),
  "Madison's Classic Rock");
eq('another station\'s slogan is left alone',
  stripStationFromRt('Wisconsin Public Radio', { mhz: 88.7, callsign: 'WERN' }),
  'Wisconsin Public Radio');
eq('prose naming the station mid-sentence is left alone',
  stripStationFromRt('Bad Man by Bobaflex on The Hog', { mhz: 105.9, callsign: 'WWHG' }),
  'Bad Man by Bobaflex on The Hog');
eq('a station id alone is shown, not blanked',
  stripStationFromRt('101.5 IBA-FM', WIBA), '101.5 IBA-FM');
eq('...even when it is the only segment on both sides',
  stripStationFromRt('101.5 IBA-FM - WIBA', WIBA), '101.5 IBA-FM - WIBA');

// ── The trap: PS is NOT an input ─────────────────────────────────────────────
// WIBA scrolls song titles through PS. Had PS been used to identify the station,
// a PS of "Walk" would have cut "Walk This Way" out of its own RadioText.
eq('a song title is never mistaken for the station',
  stripStationFromRt('101.5 IBA-FM - Walk This Way - Aerosmith',
    { mhz: 101.5, callsign: 'WIBA' }),
  'Walk This Way - Aerosmith');

// ── Only the ends ────────────────────────────────────────────────────────────
eq('a station id in the MIDDLE is not removed',
  stripStationFromRt('Now - 101.5 IBA-FM - Later', WIBA), 'Now - 101.5 IBA-FM - Later');

// ── Refusals ─────────────────────────────────────────────────────────────────
eq('no identity to match on → unchanged',
  stripStationFromRt('101.5 IBA-FM - Walk This Way', {}), '101.5 IBA-FM - Walk This Way');
eq('empty input', stripStationFromRt('', WIBA), '');
eq('null input', stripStationFromRt(null, WIBA), '');
eq('no separator → unchanged', stripStationFromRt('101.5 IBA-FM Walk This Way', WIBA),
  '101.5 IBA-FM Walk This Way');
eq('a hyphen without spaces is not a separator',
  stripStationFromRt('Hard-Boiled - Someone', { mhz: 99.9, callsign: 'KXXX' }),
  'Hard-Boiled - Someone');

console.log(fails ? `\nrtStation: ${fails} FAILED` : '\nrtStation: ALL PASS');
process.exit(fails ? 1 : 0);
