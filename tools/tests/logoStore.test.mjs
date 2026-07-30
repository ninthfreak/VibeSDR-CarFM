// Regression test for the pre-rendered size-ladder selection in
// services/logoStore.ts (ladderFor): pick the smallest pre-rendered file that
// covers the box at screen density, else fall back to the full-size master.
// ladderFor is module-private, so this extracts it from the SHIPPED source.
import { readFileSync } from 'fs';
const src = readFileSync('/home/user/VibeSDR-CarFM/src/services/logoStore.ts','utf8');
// extract the pure selection logic exactly as shipped
const ladder = src.match(/export const SIZE_LADDER = \[[^\]]*\]/)[0].replace('export ','')+';';
const fn = src.match(/function ladderFor[\s\S]*?\n}\n/)[0];
const code = (ladder+fn).replace(/ as const/,'').replace(/:\s*number \| undefined/g,'').replace(/:\s*number\[\] \| undefined/g,'').replace(/:\s*number \| null/,'');
const ladderFor = new Function('PixelRatio', code+'\nreturn ladderFor;')({get:()=>2});
const cases = [
  ['chip 128dp, full ladder',   128, [128,256,512], 256],
  ['peek 184dp, full ladder',   184, [128,256,512], 512],
  ['hero 470dp, full ladder',   470, [128,256,512], null],  // needs 940 -> master
  ['chip, only 128 written',    128, [128],          null],  // 256 needed, absent -> master
  ['no size hint (hero)',  undefined, [128,256,512], null],
  ['no ladder written',        128, [],              null],
];
let bad=0;
for (const [name, box, avail, want] of cases) {
  const got = ladderFor(box, avail);
  const ok = got === want;
  if(!ok) bad++;
  console.log(`${ok?'ok  ':'FAIL'} ${name.padEnd(26)} -> ${got===null?'master':got+'px'} (expected ${want===null?'master':want+'px'})`);
}
console.log(bad? `\nlogoStore: ${bad} FAILED` : '\nlogoStore: ALL PASS');
process.exit(bad?1:0);
