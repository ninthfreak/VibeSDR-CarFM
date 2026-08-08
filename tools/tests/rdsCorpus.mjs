// Corpus generator for the RDS differential harness. Prints one input line per
// step on stdout: a raw hex group, or one of the !reset / !retune / !clearta
// control commands. Feed the same file to tools/tests/rdsDump.mjs and to
// core/rds/examples/dump.rs and the outputs must match byte for byte.
//
// The corpus is DETERMINISTIC — the interleave runs off a fixed-seed LCG, not
// Math.random — so a divergence is always reproducible. Regenerating it on a
// later commit and diffing again is the whole point: the previous port drifted
// from the TypeScript reference silently while its own tests stayed green.
//
// Three sources, because no one of them covers the decoder:
//   1. every raw group captured in the drive logs, lifted from the test suite;
//   2. a sweep of synthesised 0A/0B/2A/3A groups over PI × PTY × TP × TA;
//   3. a full RadioText + RT+ story, which the sweep cannot assemble.
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
        // 3A: RT+ ODA announcement, and a 0B/2B version-B variant for coverage.
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
process.stdout.write(lines.filter(l => l !== '').join('\n') + '\n');
