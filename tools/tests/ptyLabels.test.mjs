// PTY labels must use the RBDS table in the Americas. Every code below is real:
// captured 2026-08-01 in Madison, Wisconsin, with the station it came from.
import { readFileSync } from 'fs';
let bad = 0;
const check = (n, c) => { if (!c) bad++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); };

const src = readFileSync(new URL('../../src/services/ptyLabels.ts', import.meta.url), 'utf8');
const js = src.replace(/^export /gm, '').replace(/: string\[\]/g, '')
  .replace(/: number \| undefined/g, '').replace(/: boolean/g, '').replace(/: string/g, '');
const { ptyLabel } = await import(`data:text/javascript,${encodeURIComponent(js + '\nexport { ptyLabel };')}`);

// pty, station, what RBDS should say, what the European table wrongly said
const CASES = [
  [22, 'WERN 88.7 Wisconsin Public Radio', 'Public',       'Travel'],
  [ 6, '101.5 Madison\'s Classic Rock',    'Classic Rock', 'Drama'],
  [ 9, 'Z104 #1 Hit Music',                'Top 40',       'Varied'],
  [11, 'WOLX 94.9 oldies',                 'Oldies',       'Rock Music'],
  [ 5, '105.9 The Hog rock',               'Rock',         'Education'],
];
for (const [pty, station, rbds, rds] of CASES) {
  check(`PTY ${pty} (${station}) = "${rbds}" in region 2`, ptyLabel(pty, true) === rbds);
  check(`  ...and the old wrong label was "${rds}"`, ptyLabel(pty, false) === rds);
}
console.log(bad ? `\nptyLabels: ${bad} FAILED` : '\nptyLabels: ALL PASS');
process.exit(bad ? 1 : 0);
