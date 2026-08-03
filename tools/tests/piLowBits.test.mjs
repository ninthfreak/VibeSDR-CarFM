// piLowBitsCandidates — the salvage that survives a mis-encoded PI top nibble.
//
// Fixtures are real rows lifted from the bundled FCC table (assets/db/stations.sqlite),
// including the two Madison stations that provoked this and the three that must
// NOT be disturbed by it. Raw PIs come from the drive log of 2026-08-03.
//
// Run: node tools/tests/piLowBits.test.mjs

import { piLowBitsCandidates, callsignToPi, piToCallsign, PI_LOW_MASK }
  from '../../src/services/piCallsign.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// Stations on each dial frequency, service='FM' only (translators are excluded
// from the query because the RBDS formula does not apply to them).
const ON_101_5 = [
  { callsignBase: 'WIBA' }, { callsignBase: 'KALV' }, { callsignBase: 'KPLZ' },
  { callsignBase: 'WLYF' }, { callsignBase: 'WYNK' },
];
const ON_104_1 = [
  { callsignBase: 'WZEE' }, { callsignBase: 'KAFE' }, { callsignBase: 'KNAB' },
  { callsignBase: 'WHTT' }, { callsignBase: 'WZKS' },
];
const ON_105_9 = [
  { callsignBase: 'WWHG' }, { callsignBase: 'KAAQ' }, { callsignBase: 'KRAZ' },
  { callsignBase: 'WKHQ' }, { callsignBase: 'WXYK' },
];
const ON_94_9 = [
  { callsignBase: 'WOLX' }, { callsignBase: 'KAGO' }, { callsignBase: 'KPKY' },
  { callsignBase: 'WKOR' }, { callsignBase: 'WZTU' },
];
const ON_88_7 = [
  { callsignBase: 'WERN' }, { callsignBase: 'KISL' }, { callsignBase: 'KAGU' },
  { callsignBase: 'WJCU' }, { callsignBase: 'WYTF' },
];

// ── The fault this exists for ────────────────────────────────────────────────
// WIBA-FM transmits 0x19E2. The formula says that is KDTI, a real 90.3 in
// Rochester Hills MI. The low 12 bits are WIBA's.
eq('0x19e2 decodes to the wrong station', piToCallsign(0x19e2).callsign, 'KDTI');
eq('  ...and WIBA computes to 0x69e2', callsignToPi('WIBA'), 0x69e2);
eq('  ...differing only above the low 12 bits',
   (0x19e2 & PI_LOW_MASK) === (0x69e2 & PI_LOW_MASK), true);
eq('  ...so the dial recovers WIBA', piLowBitsCandidates(0x19e2, ON_101_5), ['WIBA']);

eq('Z104 sends 0x1718, which decodes to KCRW', piToCallsign(0x1718).callsign, 'KCRW');
eq('  ...and the dial recovers WZEE', piLowBitsCandidates(0x1718, ON_104_1), ['WZEE']);

// ── Stations whose PI is already right must round-trip ───────────────────────
eq('WWHG 0x8f7c is its own callsign', piToCallsign(0x8f7c).callsign, 'WWHG');
eq('  ...and matches itself on 105.9', piLowBitsCandidates(0x8f7c, ON_105_9), ['WWHG']);
eq('WOLX 0x7ad5 is its own callsign', piToCallsign(0x7ad5).callsign, 'WOLX');
eq('  ...and matches itself on 94.9', piLowBitsCandidates(0x7ad5, ON_94_9), ['WOLX']);

// ── The false positive this must never produce ───────────────────────────────
// WERN sends 0xa6ff, a network PI with no callsign in it. Its low 12 bits
// coincide with KISL in Avalon CA, 2,700 km away and also on 88.7. The salvage
// is only reachable after a CLEAN decode, and 0xa6ff has none — piToCallsign
// refuses the whole A-block — so identifyByPi returns before ever asking.
eq('0xa6ff has no callsign at all', piToCallsign(0xa6ff).callsign, null);
eq('  ...though its low bits would have hit KISL',
   piLowBitsCandidates(0xa6ff, ON_88_7), ['KISL']);

// ── Refusals ─────────────────────────────────────────────────────────────────
eq('no station on the dial matches → empty',
   piLowBitsCandidates(0x19e2, ON_88_7), []);
eq('an ambiguous pair returns both, and the caller must refuse',
   piLowBitsCandidates(callsignToPi('KAIQ'), [{ callsignBase: 'KAIQ' }, { callsignBase: 'KMLS' }]),
   ['KAIQ', 'KMLS']);
eq('zero PI matches nothing', piLowBitsCandidates(0, ON_101_5), []);
eq('an empty dial matches nothing', piLowBitsCandidates(0x19e2, []), []);
eq('a three-letter base is skipped, not guessed',
   piLowBitsCandidates(0x19e2, [{ callsignBase: 'WGN' }]), []);

console.log(fails ? `\npiLowBits: ${fails} FAILED` : '\npiLowBits: ALL PASS');
process.exit(fails ? 1 : 0);
