// nwdRds.test.mjs — RDS group decoding for the NWD head-unit tuner.
//
// The groups below are VERBATIM from the drive log of 2026-08-01
// (carfmtunerlog20260801111008.txt), captured by probeNwdFmManager reading
// com.nwd.app.NwdFmManager.getRadioRDSDataArm(). They are the first raw RDS this
// unit has ever produced for us, so the decoder is written against real data
// rather than a reading of the spec.
//
// Two of them decode to things that independently confirm the bit layout is
// right: the PS groups spell WERN (a real Wisconsin Public Radio callsign) and
// the RadioText groups spell "Whole Lotta Love by Led ".

import { readFileSync } from 'fs';

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };
const eq = (name, got, want) =>
  check(`${name} → ${JSON.stringify(got)}`, got === want) ||
  (got === want ? 0 : console.log(`      wanted ${JSON.stringify(want)}`));

// The decoder is TS; strip the types the same way the other backend tests do.
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

// ── Group 0A: Programme Service name ─────────────────────────────────────────
// Real capture, station PI a6ff. Segments arrive out of order, as they did live.
const PS_GROUPS = [
  'a6ff02c0e0cd2020',   // seg 0 → chars 0,1 = "  "
  'a6ff02c5e0cd5745',   // seg 1 → chars 2,3 = "WE"
  'a6ff02c2e0cd524e',   // seg 2 → chars 4,5 = "RN"
  'a6ff02c7e0cd2020',   // seg 3 → chars 6,7 = "  "
];

{
  const d = createNwdRdsDecoder();
  PS_GROUPS.slice(0, 3).forEach((g) => d.push(g));
  eq('PS stays empty until every segment has landed', d.state().ps, '');
  d.push(PS_GROUPS[3]);
  eq('PS assembles to the real callsign', d.state().ps, 'WERN');
  eq('PI comes from block A', d.state().pi, 0xa6ff);
  eq('PTY comes from block B bits 9-5', d.state().pty, 22);
  eq('TP is false for this station', d.state().tp, false);
}

// ── Group 2A: RadioText ──────────────────────────────────────────────────────
// Real capture, station PI a80b. Segments 0-5 carry the message; the log only
// caught 0-5 plus 14-15, so the tail below is synthesised spaces to complete a
// 64-char message. The message segments themselves are untouched device data.
const RT_REAL = [
  'a80b20d057686f6c',   // seg 0  → "Whol"
  'a80b20d165204c6f',   // seg 1  → "e Lo"
  'a80b20d274746120',   // seg 2  → "tta "
  'a80b20d34c6f7665',   // seg 3  → "Love"
  'a80b20d420627920',   // seg 4  → " by "
  'a80b20d54c656420',   // seg 5  → "Led "
];

{
  const d = createNwdRdsDecoder();
  RT_REAL.forEach((g) => d.push(g));
  eq('RadioText stays empty while segments are still missing', d.state().rt, '');

  // Complete the message: segments 6-15, all spaces (0x20202020). Segment index
  // is the low 4 bits of block B, so 0x20d6 … 0x20df.
  for (let seg = 6; seg <= 15; seg++) {
    d.push(`a80b20d${seg.toString(16)}20202020`);
  }
  eq('RadioText assembles to the real message', d.state().rt, 'Whole Lotta Love by Led');
  eq('RadioText PTY', d.state().pty, 6);
}

// A carriage return ends the message early, without needing all 16 segments.
{
  const d = createNwdRdsDecoder();
  d.push('a80b20d057686f6c');            // "Whol"
  d.push('a80b20d165200d20');            // "e " then CR → terminate
  eq('a CR terminator publishes without the remaining segments', d.state().rt, 'Whole');
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
  PS_GROUPS.forEach((g) => d.push(g));
  eq('PS is set before the station changes', d.state().ps, 'WERN');
  // A different PI is a different station — the old name must not linger.
  d.push('19e204c0e0cd6c75');
  eq('a PI change clears the previous station text', d.state().ps, '');
  eq('and adopts the new PI', d.state().pi, 0x19e2);
}

{
  const d = createNwdRdsDecoder();
  PS_GROUPS.forEach((g) => d.push(g));
  check('a repeated group reports no change', d.push(PS_GROUPS[3]) === null);
  d.reset();
  eq('reset clears accumulated text', d.state().ps, '');
}

// ── TP flag, from a group that actually sets it ──────────────────────────────
{
  const d = createNwdRdsDecoder();
  d.push('19e224d46f6d6520');   // block B 0x24d4 → TP bit set
  eq('TP is read from block B bit 10', d.state().tp, true);
}

console.log(bad ? `\nnwdRds: ${bad} FAILED` : '\nnwdRds: ALL PASS');
process.exit(bad ? 1 : 0);
