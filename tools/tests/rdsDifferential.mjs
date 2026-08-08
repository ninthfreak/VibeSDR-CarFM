// Runs the RDS differential: same corpus through the TypeScript decoder and the
// Rust one, then diffs. Exits non-zero on the first divergence, with the step
// number and both states, so a drift is a failing check rather than a discovery
// made months later.
//
//   npm run test:rds-diff
//
// Requires cargo. This is deliberately NOT part of test:backend, which is plain
// node and must keep running where no Rust toolchain exists.
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'rds-diff-'));
const corpusPath = join(work, 'corpus.txt');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

const corpus = run(process.execPath, ['--no-warnings', join(here, 'rdsCorpus.mjs')]);
writeFileSync(corpusPath, corpus);
const steps = corpus.trimEnd().split('\n').length;

const ts = run(process.execPath, ['--no-warnings', join(here, 'rdsDump.mjs'), corpusPath]);
const rs = run('cargo', ['run', '-q', '--example', 'dump'], {
  cwd: join(repo, 'core'),
  input: corpus,
});

if (ts === rs) {
  console.log(`RDS differential: IDENTICAL over ${steps} steps.`);
  process.exit(0);
}

const a = ts.split('\n');
const b = rs.split('\n');
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue;
  console.error(`RDS differential: DIVERGED at step ${i + 1}`);
  console.error(`  input: ${corpus.split('\n')[i]}`);
  console.error(`  ts:    ${a[i] ?? '<no line>'}`);
  console.error(`  rs:    ${b[i] ?? '<no line>'}`);
  break;
}
process.exit(1);
