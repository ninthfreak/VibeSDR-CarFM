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
  // `: boolean | null` must be stripped BEFORE the bare `: boolean` below, or
  // that rule eats the annotation and leaves a dangling `| null`. TP's own
  // consensus tally (tpPending) was the first nullable boolean here and broke
  // this harness exactly that way — the same trap the note below describes.
  .replace(/: boolean \| null/g, '')
  .replace(/: number \| null/g, '').replace(/: string/g, '').replace(/: number/g, '')
  // Same lesson as the generic-constructor rules below: each new annotation
  // shape broke this silently until it was added. RT+ brought `: void`.
  .replace(/: void/g, '').replace(/: boolean/g, '')
  // Generalised rather than one rule per type argument: the decoder has grown
  // new Array<string>, new Array<0 | 1> and new Set<string>, and each new one
  // silently broke this harness until it was added by hand.
  .replace(/new Array<[^>]*>\(/g, 'new Array(')
  .replace(/new Set<[^>]*>\(\)/g, 'new Set()')
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

// REGRESSION — a SLOW scrolling PS. The two-cycle rule assumed a scroller never
// repeats a complete assembly, which is true only if it scrolls fast. WIBA-FM
// holds each 8-character chunk for about four seconds — many complete
// assemblies — so every chunk cleared the rule and published. On 2026-08-04 it
// put "Walk", "This Way", "Aerosmit", "NicoletL", "Law.com" and eleven more onto
// the hero in place of the station logo, because the face resolves its identity
// from PS before the PI-derived callsign.
//
// Measured that day: WIBA 16 distinct PS values, WERN 1, WWHG 1.
{
  // Build the four 0A groups that spell an 8-char PS for PI 19e2, PTY 6.
  const psGroups = (text) => {
    const t = text.padEnd(8, ' ').slice(0, 8);
    return [0, 1, 2, 3].map((seg) => {
      const b = (0x04c0 | seg).toString(16).padStart(4, '0');
      const d = ((t.charCodeAt(seg * 2) << 8) | t.charCodeAt(seg * 2 + 1)).toString(16).padStart(4, '0');
      return `19e2${b}e0cd${d}`;
    });
  };
  // Each chunk is held long enough to satisfy the two-cycle rule, as on air.
  const hold = (d, text) => feed(d, psGroups(text), 3);

  const d = prime(createNwdRdsDecoder(), psGroups('101.5')[0]);
  eq('the first held chunk still publishes', hold(d, '101.5').ps, '101.5');
  eq('  ...and so does a second', hold(d, 'IBA-FM -').ps, 'IBA-FM -');
  // Three distinct values is the verdict: this is a text field, not a name.
  const third = hold(d, 'Walk');
  eq('the third distinct value trips the scroll detector', third.psScrolling, true);
  eq('  ...and PS is retracted, not merely frozen', third.ps, '');
  eq('  ...so later chunks never reach the face',
     [hold(d, 'This Way').ps, hold(d, 'Aerosmit').ps, hold(d, 'Law.com').ps].join('|'), '||');

  // A retune clears the verdict — the next station gets judged on its own.
  d.reset();
  eq('reset clears the scrolling verdict', d.state().psScrolling, false);
}

// ...and a station with ONE fixed name must be untouched by that detector, no
// matter how long it is held. WERN published exactly one value all day.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  for (let i = 0; i < 30; i++) feed(d, PS_WERN, 1);
  eq('a fixed PS survives any amount of repetition', d.state().ps, 'WERN');
  eq('  ...and is never called a scroller', d.state().psScrolling, false);
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

// ── Rolling reception quality ────────────────────────────────────────────────
// A PROXY, and the test says so: this tuner gives no per-block validity, so
// block A is the only block whose correctness can be judged. Errors in C and D
// — where the text lives — are invisible here, which is why RadioText can arrive
// mangled while this figure looks healthy.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  eq('too few groups means no answer, NOT a perfect score',
     d.quality().piMatchPct, null);

  // Feed enough good groups to clear the minimum.
  for (let i = 0; i < 20; i++) d.push(PS_WERN[0]);
  eq('a clean run scores 100', d.quality().piMatchPct, 100);

  // A quarter of the next groups carry a corrupt block A. Those are DROPPED for
  // decoding, but they still count against quality — that is the whole point.
  for (let i = 0; i < 40; i++) d.push(i % 4 === 0 ? '57ff02c0e0cd2020' : PS_WERN[0]);
  const q = d.quality();
  check(`corruption pulls the score down → ${q.piMatchPct.toFixed(1)}%`,
        q.piMatchPct > 70 && q.piMatchPct < 90);
  check('and the sample count is capped by the ring', q.samples <= 64);
}

// A station change must not carry the previous station's quality across.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  for (let i = 0; i < 30; i++) d.push(PS_WERN[0]);
  eq('quality established', d.quality().piMatchPct, 100);
  d.reset();
  eq('reset clears the rolling quality', d.quality().piMatchPct, null);
  eq('  ...and its sample count', d.quality().samples, 0);
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

  // REGRESSION — three is enough to ACQUIRE a PI and must not be enough to
  // DISPLACE one. On 2026-08-04 a fade turned WERN's a6ff into 57ff three times
  // running, three separate times in one commute; under the old threshold that
  // wiped the station and put the formula's rendering of it, "WBGX", on the hero.
  d.push('19e204c0e0cd6c75');
  d.push('19e204c0e0cd6c75');
  eq('three groups no longer displace a trusted PI', d.state().pi, 0xa6ff);
  eq('  ...and the station text survives the burst', d.state().ps, 'WERN');

  // Twelve does displace it: a real new station carries its PI in EVERY group.
  for (let i = 0; i < 9; i++) d.push('19e204c0e0cd6c75');
  eq('a PERSISTENT new PI is a station change', d.state().pi, 0x19e2);
  eq('and it clears the previous station text', d.state().ps, '');
}

// REGRESSION — the burst must not need to be contiguous to be REJECTED, and a
// good group in the middle resets the dissent counter, so an intermittent
// corruption never accumulates its way to a displacement.
{
  const d = prime(createNwdRdsDecoder(), PS_WERN[0]);
  feed(d, PS_WERN, 2);
  for (let i = 0; i < 6; i++) {
    d.push('19e204c0e0cd6c75');   // bad
    d.push('19e204c0e0cd6c75');   // bad
    d.push(PS_WERN[0]);           // the real station, which zeroes the counter
  }
  eq('scattered bursts never add up to a station change', d.state().pi, 0xa6ff);
  eq('  ...and the name is untouched', d.state().ps, 'WERN');
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


// ── RT+ (ODA, AID 0x4BD7) ────────────────────────────────────────────────────
// Raw groups replayed from the drive log of 2026-08-01. WIBA's own 3A is used
// verbatim; the RT+ payload groups are synthesised, because 12A was never
// captured — only the announcement that 12A is where RT+ lives.
{
  const d = createNwdRdsDecoder();
  const PI = 0x19e2;                       // WIBA as transmitted (see piLowBits)
  const hex = (a, b, c, dd) => [a, b, c, dd].map((x) => x.toString(16).padStart(4, '0')).join('');
  // Trust the PI first — every branch below is behind the consensus gate.
  for (let i = 0; i < 4; i++) d.push(hex(PI, 0x0000, 0x0000, 0x2020));

  // Lay down a RadioText the offsets can point into, and let it publish.
  //             0123456789...
  const RT = 'Led Zeppelin - Kashmir\r';
  const put = (seg) => {
    const ch = (k) => (RT.charCodeAt(seg * 4 + k) || 0x20);
    return hex(PI, 0x2000 | seg, (ch(0) << 8) | ch(1), (ch(2) << 8) | ch(3));
  };
  for (let pass = 0; pass < 2; pass++) for (let seg = 0; seg < 6; seg++) d.push(put(seg));
  eq('the RadioText publishes first', d.state().rt, 'Led Zeppelin - Kashmir');

  // WIBA's ACTUAL announcement, byte for byte from the log: 19e2 34d8 0000 4bd7.
  // 0x34d8 -> group 3A, and the low five bits (0x18 = 24) say group 12, version A.
  eq('RT+ is not claimed before it is announced', d.state().rtArtist, '');
  d.push('19e234d800004bd7');

  // Group 12A payload. running=1, then (artist @0 len 12) and (title @15 len 7).
  //   B: 0xC000 group 12A | running bit 3 | top 3 bits of content type 4 = 0b000
  //   C: low 3 bits of ct1 (0b100) <<13 | start 0 <<7 | (len-1) 11 <<1 | ct2 msb 0
  //   D: ct2 remaining 5 bits (1 = TITLE) <<11 | start 15 <<5 | (len-1) 6
  const B = 0xc000 | (1 << 3) | 0b000;
  const C = (0b100 << 13) | (0 << 7) | (11 << 1) | 0;
  const D = (1 << 11) | (15 << 5) | 6;

  // NEITHER HALF OF RT+ ACTS ON ONE GROUP. The group number rides in block B and
  // the offsets in blocks C/D, none of which carry error protection — the same
  // exposure that forced RadioText's two-cycle rule. One 3A pointed RT+ at group
  // 0A once, and one corrupt payload rewrote a correct artist.
  d.push(hex(PI, B, C, D));
  d.push(hex(PI, B, C, D));
  eq('one announcement does not assign the group', d.state().rtArtist, '');

  d.push('19e234d800004bd7');                    // announced again: now assigned
  d.push(hex(PI, B, C, D));
  eq('nor does a single payload group publish', d.state().rtArtist, '');
  d.push(hex(PI, B, C, D));
  eq('RT+ labels the artist', d.state().rtArtist, 'Led Zeppelin');
  eq('RT+ labels the title', d.state().rtTitle, 'Kashmir');

  // running=0 means the item ENDED. Holding the last song over the next one is
  // the staleness the rest of this decoder exists to prevent — but a lone group
  // must not blank a running item either.
  d.push(hex(PI, 0xc000 | 0b000, C, D));
  eq('one group does not end the item', d.state().rtArtist, 'Led Zeppelin');
  d.push(hex(PI, 0xc000 | 0b000, C, D));
  eq('an ended item clears the artist', d.state().rtArtist, '');
  eq('an ended item clears the title', d.state().rtTitle, '');

  // A marker running off the end of the RadioText is REJECTED, not clamped — a
  // truncated artist is still a wrong artist.
  d.push(hex(PI, B, C, D));
  d.push(hex(PI, B, C, D));
  eq('...and a fresh running item restores them', d.state().rtArtist, 'Led Zeppelin');
  const farC = (0b100 << 13) | (60 << 7) | (11 << 1) | 0;
  d.push(hex(PI, B, farC, D));
  d.push(hex(PI, B, farC, D));
  eq('an out-of-range marker is refused, not clamped', d.state().rtArtist, 'Led Zeppelin');

  // A different station's ODA must not be adopted.
  const d2 = createNwdRdsDecoder();
  for (let i = 0; i < 4; i++) d2.push(hex(PI, 0x0000, 0x0000, 0x2020));
  d2.push(hex(PI, 0x34d8, 0x0000, 0x1234));      // some other AID in the same slot
  d2.push(hex(PI, 0x34d8, 0x0000, 0x1234));
  d2.push(hex(PI, B, C, D));
  d2.push(hex(PI, B, C, D));
  eq('a non-RT+ ODA declaration is ignored', d2.state().rtArtist, '');

  // An ODA announced on a group the standard already defines is a corrupted
  // announcement. 0A is PS: believing it turned PS groups into RT+ payloads,
  // because M/S is the running bit and an AF pair decodes as an ARTIST marker.
  const d3 = createNwdRdsDecoder();
  for (let i = 0; i < 4; i++) d3.push(hex(PI, 0x0000, 0x0000, 0x2020));
  for (let pass = 0; pass < 2; pass++) for (let seg = 0; seg < 6; seg++) d3.push(put(seg));
  d3.push(hex(PI, 0x3000, 0x0000, 0x4bd7));      // "RT+ lives in 0A" — refused
  d3.push(hex(PI, 0x3000, 0x0000, 0x4bd7));
  d3.push(hex(PI, 0x0008, 0x8016, 0x2020));      // ordinary 0A: M/S set, AF pair
  d3.push(hex(PI, 0x0008, 0x8016, 0x2020));
  eq('an ODA announced on a defined group is refused', d3.state().rtArtist, '');
}

// ── TP has its own consensus, and TA is not decoded at all ──────────────────
// TP (block B bit 10) used to be published under the PTY field's gate. A
// corruption leaving bits 9-5 intact while flipping bit 10 satisfied that gate
// and moved TP off ONE group. TA (bit 4) had the same hole and additionally
// lifted the user's mute, so it is no longer decoded — a flag that must react
// within a group or two cannot also be consensus-protected.
{
  const d = createNwdRdsDecoder();
  const PI = 0xa6ff;
  const hx = (a, b, c, dd) => [a, b, c, dd].map((x) => x.toString(16).padStart(4, '0')).join('');
  const B_PLAIN = 0x02c0;                 // PTY consensus fodder, TP clear, TA clear
  const B_TP    = 0x06c0;                 // bit 10 set, PTY bits untouched
  const B_TA    = 0x02d0;                 // bit 4 set, PTY bits untouched

  for (let i = 0; i < 8; i++) d.push(hx(PI, B_PLAIN, 0xe0cd, 0x2020));
  eq('TP starts clear', d.state().tp, false);

  d.push(hx(PI, B_TP, 0xe0cd, 0x2020));
  eq('one group does NOT move TP', d.state().tp, false);
  d.push(hx(PI, B_TP, 0xe0cd, 0x2020));
  eq('two do not either', d.state().tp, false);
  d.push(hx(PI, B_TP, 0xe0cd, 0x2020));
  eq('three consecutive do', d.state().tp, true);

  // A single contrary group must not knock it back down, and must reset the tally.
  d.push(hx(PI, B_PLAIN, 0xe0cd, 0x2020));
  eq('one contrary group does not clear TP', d.state().tp, true);

}

// ── TA: three guards, tested one at a time ──────────────────────────────────
// An earlier build read bit 4 from EVERY group under the PTY field's consensus,
// so one corrupt group raised TA — and TA lifts the user's mute. Guards are:
// group-0 only, its own tally, and conditioned on a confirmed TP.
{
  const PI = 0xa6ff;
  const hx = (a, b, c, dd) => [a, b, c, dd].map((x) => x.toString(16).padStart(4, '0')).join('');
  // Group 0A. TP is bit 10, TA is bit 4, PTY bits 9-5, segment in bits 1-0.
  const g0 = (tp, ta, seg) => hx(PI, (0 << 12) | (tp << 10) | (0x16 << 5) | (ta << 4) | seg, 0x0000, 0x2020);
  // Group 2A. Bit 4 here is the RadioText A/B flag, NOT TA.
  const g2 = (tp, bit4) => hx(PI, (2 << 12) | (tp << 10) | (0x16 << 5) | (bit4 << 4), 0x2020, 0x2020);

  // GUARD 1 — bit 4 outside group 0 is not TA.
  const d = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d.push(g0(1, 0, i % 4));      // TP on, TA off, PI+TP confirmed
  eq('TP confirms', d.state().tp, true);
  eq('TA starts clear', d.state().ta, false);
  for (let i = 0; i < 10; i++) d.push(g2(1, 1));            // bit 4 set, but in a 2A
  eq('bit 4 in a RadioText group never raises TA', d.state().ta, false);

  // GUARD 2 — TA needs its OWN consensus, not the PTY field's.
  d.push(g0(1, 1, 0));
  eq('one group-0 with TA does not raise it', d.state().ta, false);
  d.push(g0(1, 1, 1));
  eq('two do not either', d.state().ta, false);
  d.push(g0(1, 1, 2));
  eq('three consecutive do', d.state().ta, true);
  // And it clears the same way, not on a single contrary group.
  d.push(g0(1, 0, 3));
  eq('one contrary group does not clear TA', d.state().ta, true);
  d.push(g0(1, 0, 0)); d.push(g0(1, 0, 1));
  eq('three consecutive clear it', d.state().ta, false);

  // GUARD 3 — no TA on a station that does not carry traffic.
  const d2 = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d2.push(g0(0, 0, i % 4));     // TP OFF, confirmed
  eq('TP is off', d2.state().tp, false);
  for (let i = 0; i < 6; i++) d2.push(g0(0, 1, i % 4));     // TA claimed anyway
  eq('TA is suppressed without a confirmed TP', d2.state().ta, false);

  // Losing TP must drop a latched TA with it.
  const d3 = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d3.push(g0(1, 1, i % 4));
  eq('TA latches on a traffic station', d3.state().ta, true);
  for (let i = 0; i < 4; i++) d3.push(g0(0, 1, i % 4));
  eq('...and drops when TP goes away', d3.state().ta, false);

  // reset() clears the tally, so a retune cannot inherit an announcement.
  const d4 = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d4.push(g0(1, 1, i % 4));
  eq('TA is set before the reset', d4.state().ta, true);
  d4.reset();
  eq('reset clears TA', d4.state().ta, false);

  // clearTa() — the RDS-expiry path. The screen restores decoder.state()
  // wholesale after a stale gap; without dropping TA here a stale announcement
  // came back, and because the tally was still satisfied a genuinely-ongoing one
  // could not re-publish. clearTa handles both: drops it, and forces re-confirm.
  const d5 = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d5.push(g0(1, 1, i % 4));
  eq('TA is set before the expiry', d5.state().ta, true);
  d5.clearTa();
  eq('clearTa drops it (so the restore reads false)', d5.state().ta, false);
  // Sticky station state is untouched — only TA is momentary.
  eq('clearTa keeps TP', d5.state().tp, true);
  // Still running: it must re-confirm from fresh group-0s, not stay stuck off.
  let back = null;
  for (let i = 0; i < 5; i++) { d5.push(g0(1, 1, i % 4)); if (d5.state().ta && back === null) back = i + 1; }
  eq('an ongoing announcement re-confirms after PI_CONFIRM group-0s', back, 3);
  // Ended during the gap: TA=0 groups keep it off.
  const d6 = createNwdRdsDecoder();
  for (let i = 0; i < 6; i++) d6.push(g0(1, 1, i % 4));
  d6.clearTa();
  for (let i = 0; i < 4; i++) d6.push(g0(1, 0, i % 4));
  eq('an ended announcement stays off', d6.state().ta, false);
}

// ── resetForRetune clears the PI; reset does not ────────────────────────────
// push() DROPS every group whose block A does not carry the trusted PI. So a
// retune that leaves the old PI standing blacks out PS, RadioText and PTY for
// as long as displacement takes (PI_DISPLACE consecutive, against 30-35% block
// errors on real air). The dial moved, so the old PI is stale, not an incumbent.
{
  const A = 'a6ff02c0e0cd2020';
  const B = '57ff02c0e0cd2020';
  const acquire = (d) => { let n = 0; while (d.state().pi !== 0x57ff && n < 400) { d.push(B); n++; } return n; };

  const fresh = createNwdRdsDecoder();
  const fromEmpty = acquire(fresh);
  eq('a fresh decoder acquires in PI_CONFIRM groups', fromEmpty, 3);

  const kept = createNwdRdsDecoder();
  for (let i = 0; i < 8; i++) kept.push(A);
  kept.reset();
  eq('reset() keeps the incumbent, so displacement is needed', acquire(kept), 12);

  const cleared = createNwdRdsDecoder();
  for (let i = 0; i < 8; i++) cleared.push(A);
  cleared.resetForRetune();
  eq('resetForRetune() drops it, back to the fast path', acquire(cleared), fromEmpty);

  // ...and it must still clear everything reset() clears.
  const wiped = createNwdRdsDecoder();
  for (let i = 0; i < 8; i++) wiped.push(A);
  wiped.resetForRetune();
  eq('resetForRetune also empties the text', wiped.state().rt, '');
  eq('...and the PI itself', wiped.state().pi, null);
}

console.log(bad ? `\nnwdRds: ${bad} FAILED` : '\nnwdRds: ALL PASS');
process.exit(bad ? 1 : 0);
