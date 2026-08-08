// Corpus generator for the RDS differential harness. Prints one input line per
// step on stdout: a raw hex group, or one of the !reset / !retune / !clearta
// control commands. Feed the same file to tools/tests/rdsDump.mjs and to
// core/rds/examples/rds-dump.rs and the outputs must match byte for byte.
//
// The corpus is DETERMINISTIC — the interleave runs off a fixed-seed LCG, not
// Math.random — so a divergence is always reproducible. Regenerating it on a
// later commit and diffing again is the whole point: the previous port drifted
// from the TypeScript reference silently while its own tests stayed green.
//
// Four sources, because no one of them covers the decoder:
//   1. every raw group captured in the drive logs, lifted from the test suite;
//   2. a sweep of synthesised 0A/0B/2A/3A groups over PI × PTY × TP × TA;
//   3. a full RadioText + RT+ story, which the sweep cannot assemble;
//   4. targeted passages for what neither reaches: a terminator in the LAST
//      segment (the case that overflowed the Rust end-mask shift), version-B
//      RadioText, a slow-scrolling PS crossing PS_SCROLL_DISTINCT, and the
//      replacement gate (corrupt-once must not replace, two agreeing cycles must).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const real = [...readFileSync(join(here, 'nwdRds.test.mjs'), 'utf8')
  .matchAll(/'([0-9A-Fa-f]{16})'/g)].map(m => m[1].toLowerCase());

const hex4 = n => (n & 0xffff).toString(16).padStart(4, '0');
const grp = (pi, b, c, d) => hex4(pi) + hex4(b) + hex4(c) + hex4(d);

// Block B layout: [15:12] type, [11] version, [10] TP, [9:5] PTY, [4:0] group-specific.
const blockB = (type, ver, tp, pty, low) =>
  ((type & 0xf) << 12) | ((ver & 1) << 11) | ((tp & 1) << 10) | ((pty & 0x1f) << 5) | (low & 0x1f);

const ch = s => (s.charCodeAt(0) << 8) | s.charCodeAt(1);

const out = [];
const PIS = [0xa6ff, 0x19e2, 0x5445];
const PTYS = [0, 5, 12, 31];

// A deterministic LCG so the interleave is reproducible without Math.random.
let seed = 20260808;
const next = n => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);

for (const pi of PIS) {
  for (const pty of PTYS) {
    for (const tp of [0, 1]) {
      for (const ta of [0, 1]) {
        // 0A: PS segments 0..3, TA in bit 4. Sent twice — PS publishes only when
        // two complete cycles agree, so one pass would never clear the gate.
        for (let cycle = 0; cycle < 2; cycle++) {
          for (let seg = 0; seg < 4; seg++) {
            const ps = ['CA', 'RF', 'M ', 'HD'][seg];
            out.push(grp(pi, blockB(0, 0, tp, pty, (ta << 4) | seg), 0xe0cd, ch(ps)));
          }
        }
        // 2A: RadioText segments 0..7, A/B flag in bit 4. These deliberately do
        // NOT assemble — the flag flips mid-message — which exercises the
        // discard path. The story below covers assembly.
        for (const ab of [0, 1]) {
          for (let seg = 0; seg < 8; seg++) {
            const t = 'ROCK ANTHEM - LED ZEPPELIN      '.slice(seg * 4, seg * 4 + 4).padEnd(4, ' ');
            out.push(grp(pi, blockB(2, 0, tp, pty, (ab << 4) | seg), ch(t.slice(0, 2)), ch(t.slice(2, 4))));
          }
        }
        // 3A: RT+ ODA announcement, and a 0B version-B variant for coverage
        // (version-B RadioText has its own passage below — this line is 0B only).
        out.push(grp(pi, blockB(3, 0, tp, pty, 0), 0x0000, 0x4bd7));
        out.push(grp(pi, blockB(0, 1, tp, pty, (ta << 4) | 1), pi, ch('OK')));
      }
    }
  }
}

// A full RadioText + RT+ story, which the sweep above never assembles: 2A
// segments must arrive in order under a stable A/B flag, the message needs its
// 0x0D terminator, and RT+ only applies once the text has passed the publish
// gate. 3A announces RT+ on group 11A; the 11A payload marks ARTIST 0..11 and
// TITLE 15..30 of the assembled string.
const RT_MSG = 'LED ZEPPELIN - WHOLE LOTTA LOVE';   // 31 chars, 0x0D at 31
for (const pi of PIS) {
  for (const ab of [0, 1]) {
    out.push(grp(pi, blockB(3, 0, 1, 10, 22), 0x0000, 0x4bd7));       // RT+ on 11A
    for (let pass = 0; pass < 3; pass++) {
      for (let seg = 0; seg < 8; seg++) {
        const at = seg * 4;
        const byte = i => (at + i === 31 ? 0x0d : (RT_MSG.charCodeAt(at + i) || 0x20));
        out.push(grp(pi, blockB(2, 0, 1, 10, (ab << 4) | seg),
          (byte(0) << 8) | byte(1), (byte(2) << 8) | byte(3)));
      }
    }
    out.push(grp(pi, blockB(11, 0, 1, 10, 0b01000), 0x8016, 0x09ef)); // running
    out.push(grp(pi, blockB(11, 0, 1, 10, 0b01000), 0x8016, 0x09ef));
    out.push(grp(pi, blockB(11, 0, 1, 10, 0b00000), 0x8016, 0x09ef)); // item ended
  }
}

// ── Targeted stories, appended AFTER the interleave ──────────────────────────
// The LCG interleave injects !reset/!retune at ~11% per line, which is right
// for shaking state transitions but wrong for these: each needs its internal
// sequence intact (a reset mid-story wipes the assembly or the distinct-PS
// tally it exists to build). So they run un-interleaved, each opening with a
// !retune plus three priming groups so the PI is re-acquired in PI_CONFIRM
// steps instead of eating the story's own head as displacement dissent.
const stories = [];
const primeStory = (pi) => {
  stories.push('!retune');
  for (let i = 0; i < 3; i++) stories.push(grp(pi, blockB(0, 0, 1, 10, 0), 0xe0cd, ch('CA')));
};

// A message whose 0x0D lands in SEGMENT 15 (position 62). The end mask must
// then cover all sixteen segments — (1 << 16) - 1 in JavaScript, and the shift
// that overflowed a u16 in the first Rust cut. Full assembly first; then, after
// a reset, the seg-15 group ALONE, which must publish nothing on either side.
const LONG_MSG = 'WHOLE LOTTA LOVE - LED ZEPPELIN - ROYAL ALBERT HALL, EARLY SET'; // 62 chars
for (const pi of PIS) {
  primeStory(pi);
  for (let pass = 0; pass < 2; pass++) {
    for (let seg = 0; seg < 16; seg++) {
      const at = seg * 4;
      const byte = i => (at + i === 62 ? 0x0d : (LONG_MSG.charCodeAt(at + i) || 0x20));
      stories.push(grp(pi, blockB(2, 0, 1, 10, seg), (byte(0) << 8) | byte(1), (byte(2) << 8) | byte(3)));
    }
  }
  stories.push('!reset');
  stories.push(grp(pi, blockB(2, 0, 1, 10, 15), 0x2020, 0x0d20)); // lone terminated seg 15
}

// Version-B RadioText: 2 chars per group in block D at seg×2, block C repeating
// the PI. Terminator at position 30 — segment 15 again, via the 2B addressing.
const MSG_2B = 'KASHMIR - LED ZEPPELIN ON WERN'; // 30 chars
for (const pi of PIS) {
  primeStory(pi);
  for (let pass = 0; pass < 2; pass++) {
    for (let seg = 0; seg < 16; seg++) {
      const at = seg * 2;
      const byte = i => (at + i === 30 ? 0x0d : (MSG_2B.charCodeAt(at + i) || 0x20));
      stories.push(grp(pi, blockB(2, 1, 1, 10, seg), pi, (byte(0) << 8) | byte(1)));
    }
  }
}

// A SLOW scroller: four distinct PS values, each held for two complete agreeing
// assemblies, so each one clears the two-cycle gate — exactly the WIBA case.
// The third distinct publish must flip the scrolling verdict and retract the
// name; the fourth must change nothing.
for (const pi of PIS) {
  primeStory(pi);
  for (const val of ['WALK    ', 'THIS WAY', 'AEROSMIT', 'NICOLETL']) {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let seg = 0; seg < 4; seg++) {
        stories.push(grp(pi, blockB(0, 0, 1, 10, seg), 0xe0cd, ch(val.slice(seg * 2, seg * 2 + 2))));
      }
    }
  }
}

// RT+ carried by a VERSION-B group. The 3A announcement's low bit selects the
// version and the decoder must honour it: after 11B is assigned, an 11B payload
// applies while an 11A payload — same group number, wrong version — must be
// ignored. The decoy swaps the artist and title fields, so a decoder that stops
// checking the version shows swapped tags rather than nothing.
for (const pi of PIS) {
  primeStory(pi);
  stories.push(grp(pi, blockB(3, 0, 1, 10, 23), 0x0000, 0x4bd7));   // RT+ on 11B
  for (let pass = 0; pass < 2; pass++) {
    for (let seg = 0; seg < 8; seg++) {
      const at = seg * 4;
      const byte = i => (at + i === 31 ? 0x0d : (RT_MSG.charCodeAt(at + i) || 0x20));
      stories.push(grp(pi, blockB(2, 0, 1, 10, seg), (byte(0) << 8) | byte(1), (byte(2) << 8) | byte(3)));
    }
  }
  stories.push(grp(pi, blockB(11, 1, 1, 10, 0b01000), 0x8016, 0x09ef)); // 11B: applies
  stories.push(grp(pi, blockB(11, 0, 1, 10, 0b01000), 0x2016, 0x21ef)); // 11A decoy: ignored
}

// The replacement gate. Publish M, then a corrupt assembly ONCE (must not
// replace), then a genuinely new message ONCE (must not replace either — it has
// not repeated), then that message AGAIN (two agreeing cycles: replace).
const RT_SEQ = [
  ['ROCKIN INTO THE NIGHT - 38 SPECIAL', 2],
  ['ROCKIN INTO T#E NIGHT - 38 SPECIAL', 1],
  ['AGAINST THE WIND - BOB SEGER', 1],
  ['AGAINST THE WIND - BOB SEGER', 1],
];
for (const pi of PIS) {
  primeStory(pi);
  for (const [msg, passes] of RT_SEQ) {
    for (let pass = 0; pass < passes; pass++) {
      const segs = Math.ceil((msg.length + 1) / 4);
      for (let seg = 0; seg < segs; seg++) {
        const at = seg * 4;
        const byte = i => (at + i === msg.length ? 0x0d : (msg.charCodeAt(at + i) || 0x20));
        stories.push(grp(pi, blockB(2, 0, 1, 10, seg), (byte(0) << 8) | byte(1), (byte(2) << 8) | byte(3)));
      }
    }
  }
}

// Malformed / edge inputs the decoders must both refuse identically.
const bad = ['', 'zzzz', 'a6ff02c0e0cd20', 'a6ff02c0e0cd2020ff', 'A6FF02C0E0CD2020', '0000000000000000'];

const lines = [];
const pool = [...real, ...out];
for (let i = 0; i < pool.length; i++) {
  lines.push(pool[i]);
  const r = next(37);
  if (r === 0) lines.push('!reset');
  else if (r === 1) lines.push('!retune');
  else if (r === 2) lines.push('!clearta');
  else if (r === 3) lines.push(bad[next(bad.length)]);
}
lines.push(...stories);
process.stdout.write(lines.filter(l => l !== '').join('\n') + '\n');
