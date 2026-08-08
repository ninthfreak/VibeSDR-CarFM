// Runs the station differential: same corpus through the TypeScript modules the
// app ships and through the Rust port, then compares.
//
//   npm run test:stations-diff
//
// Requires cargo. Deliberately NOT part of test:backend, which is plain node and
// must keep running where no Rust toolchain exists.
//
// WHY THIS ONE IS NOT A BYTE COMPARISON, unlike the RDS harness.
//
// The RDS decoder is integer and string work, so its two implementations agree
// bit for bit. This one runs sin, cos, asin and log10. IEEE-754 does not require
// correctly-rounded transcendentals, so V8's libm and Rust's disagree in the
// last unit in the last place — measured here at ~1.5e-12 km on a 7982 km leg,
// which is 1.5 nanometres. Rounding both to fixed decimals would hide it but
// makes the test flaky: with values 2e-12 apart and a 1e-9 grid, roughly one
// value in five hundred straddles a rounding boundary, and over ~90,000 printed
// numbers that is a coin-flip failure every run.
//
// So the contract is stated properly instead. Every line is split into a
// SKELETON (all the non-numeric text — callsigns, notes, service codes, ordering,
// list lengths) and its NUMBERS. Skeletons must match EXACTLY: any difference in
// identity, ranking order, membership or wording is a hard failure. Numbers must
// agree to a relative 1e-9, a thousand times looser than the libm noise and
// still far tighter than anything that could change behaviour. The maximum
// deviation actually observed is printed, so the margin is visible rather than
// assumed.
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const TOLERANCE = 1e-9;
const NUM = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'stations-diff-'));
const corpusPath = join(work, 'corpus.txt');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 29, ...opts });

const corpus = run(process.execPath, ['--no-warnings', join(here, 'stationCorpus.mjs')]);
writeFileSync(corpusPath, corpus);
const scenarios = corpus.slice(corpus.indexOf('\n#SCENARIOS\n')).trimEnd().split('\n').slice(1);

const ts = run(process.execPath,
  ['--no-warnings', '--import', join(here, 'tsResolve.mjs'), join(here, 'stationDump.mjs'), corpusPath]);
const rs = run('cargo',
  ['run', '-q', '--release', '-p', 'carfm-stations', '--example', 'dump', '--', corpusPath],
  { cwd: join(repo, 'core') });

const a = ts.trimEnd().split('\n');
const b = rs.trimEnd().split('\n');

const skeleton = (l) => l.replace(NUM, '#');
const numbers = (l) => (l.match(NUM) ?? []).map(Number);
const deviation = (x, y) => (x === y ? 0 : Math.abs(x - y) / Math.max(1, Math.abs(x), Math.abs(y)));

const fail = (why, i, extra = []) => {
  console.error(`Station differential: ${why}`);
  console.error(`  output line ${i + 1}`);
  console.error(`  ts: ${a[i] ?? '<no line>'}`);
  console.error(`  rs: ${b[i] ?? '<no line>'}`);
  for (const e of extra) console.error(`  ${e}`);
  let c = i;
  while (c >= 0 && !/^(pi|tocall|base|geo|bbox|score|nearby|identify) /.test(a[c] ?? '')) c--;
  if (c >= 0 && c !== i) console.error(`  under: ${a[c]}`);
  process.exit(1);
};

if (a.length !== b.length) {
  fail(`LINE COUNT DIFFERS (ts ${a.length}, rs ${b.length})`, Math.min(a.length, b.length) - 1);
}

let worst = 0;
let worstAt = -1;
let numCount = 0;
for (let i = 0; i < a.length; i++) {
  if (a[i] === b[i]) { numCount += numbers(a[i]).length; continue; }
  if (skeleton(a[i]) !== skeleton(b[i])) fail('STRUCTURAL DIVERGENCE', i);
  const na = numbers(a[i]);
  const nb = numbers(b[i]);
  if (na.length !== nb.length) fail('NUMBER COUNT DIFFERS', i);
  numCount += na.length;
  for (let k = 0; k < na.length; k++) {
    const d = deviation(na[k], nb[k]);
    if (d > worst) { worst = d; worstAt = i; }
    if (d > TOLERANCE) {
      fail('NUMERIC DIVERGENCE beyond tolerance', i,
        [`field ${k + 1}: ${na[k]} vs ${nb[k]} (rel ${d.toExponential(3)})`]);
    }
  }
}

console.log(`Station differential: EQUIVALENT over ${scenarios.length} scenarios `
  + `(${a.length} output lines, ${numCount} numbers).`);
console.log(`  skeletons identical; worst numeric deviation ${worst.toExponential(3)} `
  + `(tolerance ${TOLERANCE.toExponential(0)})`);
if (worstAt >= 0) console.log(`  worst at line ${worstAt + 1}: ${a[worstAt].trim().slice(0, 110)}`);
