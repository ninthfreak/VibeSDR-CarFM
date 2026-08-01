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
// THE TWO-CYCLE RULE: PS and RadioText publish only when two consecutive
// COMPLETE assemblies agree. The first build published on the first complete
// fill and then republished on every later segment, so the user watched
// half-rewritten buffers churn across the screen — "The load", "Aue cy",
// "WOda94.9" before "WOLX94.9", and "Z104son's #1 Hit Music Station" where one
// message bled into the next. The regression cases below replay exactly that.

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

// ── Group 0A: Programme Service name ─────────────────────────────────────────
// Real capture, PI a6ff. Four segments assembling "  WERN  ".
const PS_WERN = [
  'a6ff02c0e0cd2020',   // seg 0 → chars 0,1 = "  "
  'a6ff02c5e0cd5745',   // seg 1 → chars 2,3 = "WE"
  'a6ff02c2e0cd524e',   // seg 2 → chars 4,5 = "RN"
  'a6ff02c7e0cd2020',   // seg 3 → chars 6,7 = "  "
];

{
  const d = createNwdRdsDecoder();
  eq('PS is empty after one complete cycle', feed(d, PS_WERN, 1).ps, '');
  eq('PS publishes once a second cycle agrees', feed(d, PS_WERN, 1).ps, 'WERN');
  eq('PI comes from block A', d.state().pi, 0xa6ff);
  eq('PTY comes from block B bits 9-5', d.state().pty, 22);
  eq('TP is false for this station', d.state().tp, false);
}

{
  const d = createNwdRdsDecoder();
  feed(d, PS_WERN.slice(0, 3), 4);
  eq('an incomplete assembly never publishes, however often it repeats', d.state().ps, '');
}

// REGRESSION — a scrolling PS. Station 19e2 cycles its name as advertising copy;
// the first build showed every frame of it, overwriting the hero card.
{
  const d = createNwdRdsDecoder();
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
  const d = createNwdRdsDecoder();
  eq('RadioText is empty after one complete cycle', feed(d, RT_FULL, 1).rt, '');
  eq('RadioText publishes once a second cycle agrees', feed(d, RT_FULL, 1).rt,
    'Whole Lotta Love by Led');
  eq('RadioText PTY', d.state().pty, 6);
}

{
  const d = createNwdRdsDecoder();
  feed(d, RT_LED, 4);
  eq('a partly-received RadioText is never shown', d.state().rt, '');
}

// A carriage return ends the message without needing all 16 segments.
{
  const d = createNwdRdsDecoder();
  const withCr = ['a80b20d057686f6c', 'a80b20d165200d20'];
  eq('CR: nothing after one cycle', feed(d, withCr, 1).rt, '');
  eq('CR terminates without the remaining segments', feed(d, withCr, 1).rt, 'Whole');
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
  const d = createNwdRdsDecoder();
  feed(d, PS_WERN, 2);
  eq('PS is set before the station changes', d.state().ps, 'WERN');
  d.push('19e204c0e0cd6c75');
  eq('a PI change clears the previous station text', d.state().ps, '');
  eq('and adopts the new PI', d.state().pi, 0x19e2);
}

{
  const d = createNwdRdsDecoder();
  feed(d, PS_WERN, 2);
  d.reset();
  eq('reset clears accumulated text', d.state().ps, '');
  eq('reset clears PI too', d.state().pi, null);
}

// ── TP flag, from a group that actually sets it ──────────────────────────────
{
  const d = createNwdRdsDecoder();
  d.push('19e224d46f6d6520');   // block B 0x24d4 → TP bit set
  eq('TP is read from block B bit 10', d.state().tp, true);
}

console.log(bad ? `\nnwdRds: ${bad} FAILED` : '\nnwdRds: ALL PASS');
process.exit(bad ? 1 : 0);
