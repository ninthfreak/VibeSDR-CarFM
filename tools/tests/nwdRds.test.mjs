// nwdRds.test.mjs — RDS group decoding for the NWD head-unit tuner.
//
// Every group below is VERBATIM from a drive log (2026-08-01). They are real
// device output, so the decoder is pinned to what the hardware actually sends
// rather than to a reading of the spec.
//
// Two decode to things that independently confirm the bit layout: the PS groups
// spell WERN (a real Wisconsin Public Radio callsign) and the RadioText groups
// spell "Whole Lotta Love by Led ".
//
// TRUST GATES, in the order a group passes them:
//   1. PI consensus — a PI must repeat before it is believed, and groups not
//      carrying the believed PI are DROPPED. These groups have no error
//      correction; on air, most of them are corrupt.
//   2. PTY consensus — block B corrupts independently of block A, so the header
//      needs its own repeats or the genre label flickers.
//   3. PS needs two agreeing complete assemblies (a scrolling PS never settles,
//      and should not: it is advertising copy, not a name). RadioText needs one,
//      because its buffer is cleared per cycle so a completed message cannot be
//      a mix of two.
// Every rule above exists because of something observed on a real drive; the
// regression cases at the bottom replay those exact captures.

import { readFileSync } from 'fs';

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };
const eq = (name, got, want) => {
  check(`${name} → ${JSON.stringify(got)}`, got === want);
  if (got !== want) console.log(`      wanted ${JSON.stringify(want)}`);
};

const src = readFileSync(new URL('../../src/services/nwdRds.ts', import.meta.url), 'utf8');
const js = src
  .replace(/^import[^\n]*\n/gm, '')
  .replace(/^export (interface|type)[\s\S]*?^}/gm, '')
  .replace(/: RdsState \| null/g, '').replace(/: RdsState/g, '')
  .replace(/: NwdRdsDecoder/g, '').replace(/: string \| null/g, '')
  .replace(/: number \| null/g, '').replace(/: string/g, '').replace(/: number/g, '')
  .replace(/new Array<string>\(/g, 'new Array(')
  .replace(/export interface [\s\S]*?\n}\n/g, '')
  .replace(/export /g, '');
const { createNwdRdsDecoder } = await import(
  `data:text/javascript,${encodeURIComponent(js + '\nexport { createNwdRdsDecoder };')}`
);

const feed = (d, groups, times = 1) => {
  for (let i = 0; i < times; i++) groups.forEach((g) => d.push(g));
  return d.state();
};
// Groups are dropped until a PI has been seen PI_CONFIRM times, and block B is
// gated separately — the pushes that establish the PI return before block B is
// ever read, so PTY/TP need their own repeats after that. Five clears both.
const prime = (d, group) => { for (let i = 0; i < 5; i++) d.push(group); return d; };

// ── Group 0A: Programme Service name ─────────────────────────────────────────
// Real capture, PI a6ff. Four segments assembling "  WERN  ".
const PS_WERN = [
  'a6ff02c0e0cd2020',   // seg 0 → chars 0,1 = "  "
  'a6ff02c5e0cd5745',   // seg 1 → chars 2,3 = "WE"
  'a6ff02c2e0cd524e',   // seg 2 → chars 4,5 = "RN"
  'a6ff02c7e0cd2020',   // seg 3 → chars 6,7 = "  "
];

{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  eq('PS is empty after one complete cycle', feed(d, PS_WERN, 1).ps, '');
  eq('PS publishes once a second cycle agrees', feed(d, PS_WERN, 1).ps, 'WERN');
  eq('PI comes from block A', d.state().pi, 0xa6ff);
  eq('PTY comes from block B bits 9-5', d.state().pty, 22);
  eq('TP is false for this station', d.state().tp, false);
}

{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN.slice(0, 3), 4);
  eq('an incomplete assembly never publishes, however often it repeats', d.state().ps, '');
}

// REGRESSION — a scrolling PS. Station 19e2 cycles its name as advertising copy;
// the first build showed every frame of it, overwriting the hero card.
{
  const d = prime(createNwdRdsDecoder(), '19e202c020204942');
  const scroll = [
    ['19e202c020204942', '19e202c1312e3520', '19e202c220204942', '19e202c3412d3520'],  // "IB1.5" ish
    ['19e202c020204942', '19e202c1412d464d', '19e202c220203130', '19e202c3412d464d'],  // "IBA-FM" ish
  ];
  for (let i = 0; i < 6; i++) feed(d, scroll[i % 2], 1);
  eq('a PS that never repeats is never published', d.state().ps, '');
}

// ── Group 2A: RadioText ──────────────────────────────────────────────────────
const RT_LED = [
  'a80b20d057686f6c',   // seg 0 → "Whol"
  'a80b20d165204c6f',   // seg 1 → "e Lo"
  'a80b20d274746120',   // seg 2 → "tta "
  'a80b20d34c6f7665',   // seg 3 → "Love"
  'a80b20d420627920',   // seg 4 → " by "
  'a80b20d54c656420',   // seg 5 → "Led "
];
// Segments 6-15, all spaces, completing a 64-char message.
const RT_PAD = Array.from({ length: 10 }, (_, i) => `a80b20d${(i + 6).toString(16)}20202020`);
const RT_FULL = [...RT_LED, ...RT_PAD];

{
  const d = prime(createNwdRdsDecoder(), RT_LED[0]);
  eq('RadioText publishes on one complete cycle', feed(d, RT_FULL, 1).rt,
    'Whole Lotta Love by Led');
  eq('RadioText PTY', d.state().pty, 6);
}

{
  const d = prime(createNwdRdsDecoder(), RT_LED[0]);
  feed(d, RT_LED, 4);
  eq('a partly-received RadioText is never shown', d.state().rt, '');
}

// A carriage return ends the message without needing all 16 segments — but only
// when everything BEFORE it arrived.
{
  const d = prime(createNwdRdsDecoder(), 'a80b20d057686f6c');
  eq('CR terminates without the remaining segments',
    feed(d, ['a80b20d057686f6c', 'a80b20d165200d20'], 1).rt, 'Whole');
}

// REGRESSION — joining mid-message must not publish the fragment. Acquisition
// really does land mid-cycle, since PI consensus burns groups before any RT group
// is admitted. This used to render "        tta Love" on the plate, which the
// screen treats as truthy (leading spaces) and the face trims to "tta Love".
{
  const d = prime(createNwdRdsDecoder(), 'a80b20d274746120');   // primes on SEGMENT 2
  d.push('a80b20d34c6f7665');                                   // seg 3
  d.push('a80b20d4200d2020');                                   // seg 4 carries the CR
  eq('a terminator with segments 0-1 missing publishes nothing', d.state().rt, '');
  // Supply the missing head; now the message is whole and may publish.
  d.push('a80b20d057686f6c');                                   // seg 0
  d.push('a80b20d165204c6f');                                   // seg 1
  d.push('a80b20d4200d2020');                                   // CR again
  eq('once the head arrives it publishes in full', d.state().rt, 'Whole Lotta Love');
}

// REGRESSION — corrupt characters must not reach the plate. Blocks C and D carry
// the text and nothing protects them: PI consensus guards block A and PTY
// consensus guards block B, but the characters themselves have no error check.
// On the drive of 2026-08-03, 44 of WERN's 83 RadioText publishes were corrupt
// ("Wisconsin PuAoic Radio", "Wisc h yn Public Radio"), every one of them shown.
//
// So: the first fill of a message publishes at once, and anything that would
// REPLACE it has to arrive twice. Random corruption never repeats.
{
  // Segment 2 with one byte flipped: "tta " becomes "tAa ".
  const RT_BAD = RT_FULL.map((g) => (g === 'a80b20d274746120' ? 'a80b20d274416120' : g));
  const CLEAN = 'Whole Lotta Love by Led';

  const d = prime(createNwdRdsDecoder(), RT_LED[0]);
  eq('the first complete message still shows immediately', feed(d, RT_FULL, 1).rt, CLEAN);
  eq('a corrupt cycle does not replace it', feed(d, RT_BAD, 1).rt, CLEAN);
  eq('nor does a second, differently corrupt cycle', feed(d,
    RT_FULL.map((g) => (g === 'a80b20d34c6f7665' ? 'a80b20d34c6f7645' : g)), 1).rt, CLEAN);
  eq('and the clean text survives the whole run', feed(d, RT_FULL, 1).rt, CLEAN);
}

// The flip side: a message that really did change must still get through, and
// the same corruption twice would be indistinguishable from a change — which is
// why this rule is about repetition, not about detecting corruption.
{
  const d = prime(createNwdRdsDecoder(), RT_LED[0]);
  feed(d, RT_FULL, 1);
  const NEXT = RT_FULL.map((g) => (g === 'a80b20d54c656420' ? 'a80b20d55a657020' : g));
  eq('one cycle of a new message is not believed', feed(d, NEXT, 1).rt,
    'Whole Lotta Love by Led');
  eq('the repeat publishes it', feed(d, NEXT, 1).rt, 'Whole Lotta Love by Zep');
}

// An A/B flip is the broadcaster saying "new message", so it does not wait.
{
  const d = prime(createNwdRdsDecoder(), RT_LED[0]);
  feed(d, RT_FULL, 1);
  // Same groups with the A/B bit TOGGLED in block B (bit 4; it is already 1 in
  // this capture, so 0x20dX becomes 0x20cX).
  const FLIPPED = RT_FULL
    .map((g) => (g === 'a80b20d54c656420' ? 'a80b20d55a657020' : g))
    .map((g) => g.slice(0, 4) + (parseInt(g.slice(4, 8), 16) ^ 0x0010).toString(16).padStart(4, '0') + g.slice(8));
  eq('an A/B flip publishes on its first complete cycle', feed(d, FLIPPED, 1).rt,
    'Whole Lotta Love by Zep');
}

// ── Housekeeping ─────────────────────────────────────────────────────────────
{
  const d = createNwdRdsDecoder();
  check('an all-zero group is "no data", not a group',
    d.push('0000000000000000') === null && d.state().pi === null);
  check('a short or non-hex string is ignored',
    d.push('abc') === null && d.push('zzzzzzzzzzzzzzzz') === null);
}

{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  eq('PS is set before the station changes', d.state().ps, 'WERN');
  d.push('19e204c0e0cd6c75');
  eq('ONE group with a new PI is not believed', d.state().ps, 'WERN');
  d.push('19e204c0e0cd6c75');
  d.push('19e204c0e0cd6c75');
  eq('a PERSISTENT new PI is a station change', d.state().pi, 0x19e2);
  eq('and it clears the previous station text', d.state().ps, '');
}

{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  d.reset();
  eq('reset clears accumulated text', d.state().ps, '');
  eq('reset clears PI too', d.state().pi, null);
}

// REGRESSION — PI must come BACK after an external reset() onto the same station.
// reset() keeps piConfirmed while nulling st.pi, and there is no setter on the
// exported interface, so a same-PI group used to fall through the equality branch
// and never restore it: PI was null for the rest of the session. RadioScreen calls
// reset() on every frequency event, so re-pressing the active preset triggers it.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  eq('PI acquired', d.state().pi, 0xa6ff);
  d.reset();
  eq('reset nulls it', d.state().pi, null);
  d.push(PS_WERN[0]);
  eq('the very next same-PI group restores it', d.state().pi, 0xa6ff);
  feed(d, PS_WERN, 2);
  eq('and the name re-acquires normally', d.state().ps, 'WERN');
}

// ── TP flag, from a group that actually sets it ──────────────────────────────
{
  const d = prime(createNwdRdsDecoder(), '19e224d46f6d6520');   // B 0x24d4 → TP set
  eq('TP is read from block B bit 10', d.state().tp, true);
}

// ── REGRESSION: block corruption, verbatim from the 16:12 drive log ──────────
// WERN 88.7, true PI a6ff. Most groups came back corrupt. Before PI consensus
// every one of these was treated as a station change, wiping the accumulated
// text — RadioText never filled in, and the corrupt PI reached the callsign
// lookup, putting "KDTI-ROCHE…" on WIBA's hero card.
{
  const CORRUPT_PIS = ['a63e', '2631', 'a699', 'a6b8', 'd86f', 'c6fe', '47ff', '26f5'];
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  eq('name acquired before the noise', d.state().ps, 'WERN');
  // Interleave corrupt groups the way they actually arrived.
  for (const pi of CORRUPT_PIS) { d.push(`${pi}02c5e0cd5745`.padEnd(16, '0')); d.push(PS_WERN[1]); }
  eq('scattered corrupt PIs do not wipe the station', d.state().ps, 'WERN');
  eq('and the trusted PI is unchanged', d.state().pi, 0xa6ff);
}

// Block B corrupts independently of block A: these all carry the TRUE PI but
// wrong PTYs, which is what made the genre label flicker.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  const settled = d.state().pty;
  for (const pty of [15, 30, 23, 14, 2, 20, 10, 17, 4]) {
    d.push(`a6ff${(0x0000 | (pty << 5)).toString(16).padStart(4, '0')}e0cd2020`);
  }
  eq('a burst of one-off PTYs never reaches the label', d.state().pty, settled);
}

console.log(bad ? `\nnwdRds: ${bad} FAILED` : '\nnwdRds: ALL PASS');
process.exit(bad ? 1 : 0);
