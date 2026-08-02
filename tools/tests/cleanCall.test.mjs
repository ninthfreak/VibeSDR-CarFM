// cleanCall must drop a TRAILING band suffix and nothing else.
//
// The previous version matched /(fm|am)\b/ anywhere and then stripped every
// space, so it amputated real callsigns (WHAM -> WH) and collapsed the hero's
// "callsign · city" hint into "WKSC·Chicago" at 94dp.
import { readFileSync } from 'fs';
let bad = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} → ${JSON.stringify(got)}${ok ? '' : `  wanted ${JSON.stringify(want)}`}`);
};

const src = readFileSync(new URL('../../src/components/carfm/tokens.ts', import.meta.url), 'utf8');
const m = src.match(/export const cleanCall[\s\S]*?;\n/);
const js = m[0].replace('export ', '').replace(/\(s\?: string\): string/, '(s)');
const { cleanCall } = await import(`data:text/javascript,${encodeURIComponent(js + '\nexport { cleanCall };')}`);

// Suffix removal — the actual job.
eq('WWHG-FM',   cleanCall('WWHG-FM'), 'WWHG');
eq('WJJO FM',   cleanCall('WJJO FM'), 'WJJO');
eq('WIBA-AM',   cleanCall('WIBA-AM'), 'WIBA');
eq('lowercase', cleanCall('wwhg-fm'), 'wwhg');

// Callsigns that merely CONTAIN am/fm must survive intact.
eq('WHAM', cleanCall('WHAM'), 'WHAM');
eq('KJFM', cleanCall('KJFM'), 'KJFM');
eq('KAFM', cleanCall('KAFM'), 'KAFM');
eq('WFMT', cleanCall('WFMT'), 'WFMT');

// Names and hints keep their spacing.
eq('TEAM 1300',      cleanCall('TEAM 1300'),      'TEAM 1300');
eq('SLAM FM',        cleanCall('SLAM FM'),        'SLAM');
eq('hero hint',      cleanCall('WKSC · Chicago'), 'WKSC · Chicago');
eq('spaced name',    cleanCall('THE WAVE'),       'THE WAVE');

eq('empty',     cleanCall(''),        '');
eq('undefined', cleanCall(undefined), '');

console.log(bad ? `\ncleanCall: ${bad} FAILED` : '\ncleanCall: ALL PASS');
process.exit(bad ? 1 : 0);
