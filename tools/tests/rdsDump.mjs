// Differential harness, TypeScript side. Mirrors core/rds/examples/rds-dump.rs.
import { createNwdRdsDecoder } from '../../src/services/nwdRds.ts';
import { readFileSync } from 'fs';
const d = createNwdRdsDecoder();
const q = (s) => JSON.stringify(s);
for (const raw of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const g = raw.trim();
  if (!g) continue;
  if (g === '!reset') d.reset();
  else if (g === '!retune') d.resetForRetune();
  else if (g === '!clearta') d.clearTa();
  else d.push(g);
  const s = d.state();
  const t = d.stats();
  const ql = d.quality();
  console.log(
    `pi=${s.pi == null ? '-' : s.pi.toString(16).padStart(4,'0')} ` +
    `pty=${s.pty == null ? '-' : s.pty} tp=${s.tp} ta=${s.ta} ` +
    `ps=${q(s.ps)} rt=${q(s.rt)} scroll=${s.psScrolling} art=${q(s.rtArtist)} tit=${q(s.rtTitle)} ` +
    `g=${t.groups} x=${t.piMismatch} q=${ql.piMatchPct == null ? '-' : ql.piMatchPct} n=${ql.samples}`);
}
