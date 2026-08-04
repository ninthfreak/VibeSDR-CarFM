// nwdSignalLevel — the level→bars map, checked against the real readings.
//
// The two floors are the vendor's own seek-stop constants, lifted from the
// decompiled NewRdsManager; the top of the span is ours and provisional. Every
// reading below is verbatim from the drive logs of 2026-08-04.
//
// Run: node tools/tests/signalLevel.test.mjs

import { levelToBars, levelIsTrustworthy, LEVEL_DX_FLOOR, LEVEL_LOC_FLOOR }
  from '../../src/services/nwdSignalLevel.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// ── The vendor's anchors ─────────────────────────────────────────────────────
eq('below the DX floor is no station at all', levelToBars(LEVEL_DX_FLOOR - 1), 0);
eq('the DX floor itself is one bar', levelToBars(LEVEL_DX_FLOOR), 1);
eq('just under the LOC floor is still one bar', levelToBars(LEVEL_LOC_FLOOR - 1), 1);
eq('the LOC floor is where "local" starts', levelToBars(LEVEL_LOC_FLOOR), 2);

// ── Real readings, 2026-08-04 ────────────────────────────────────────────────
const OBSERVED = {
  '88.7 WERN Madison':        [55, 55, 53],
  '94.9 WOLX Baraboo':        [50, 47],
  '101.5 WIBA Sauk City':     [62, 49, 50, 54],
  '102.1 WQLF Rockford IL':   [40, 40, 41, 40, 37],
  '104.1 WZEE Madison':       [51, 58],
  '105.9 WWHG Evansville':    [54, 73, 72, 58],
};
const barsFor = (k) => [...new Set(OBSERVED[k].map(levelToBars))].sort();

eq('the distant Rockford station reads weak but present', barsFor('102.1 WQLF Rockford IL'), [2]);
eq('Baraboo oldies is solid', barsFor('94.9 WOLX Baraboo'), [3]);
eq('Madison public radio is solid', barsFor('88.7 WERN Madison'), [3]);
eq('Z104 is solid', barsFor('104.1 WZEE Madison'), [3]);
eq('WIBA climbs to full in its own city', barsFor('101.5 WIBA Sauk City'), [3, 4]);
eq('WWHG climbs to full on the approach', barsFor('105.9 WWHG Evansville'), [3, 4]);

// Nothing observed should ever land on 0 or 1 — every station tested was audible.
const all = Object.values(OBSERVED).flat();
eq('no audible station reads as absent', all.every((v) => levelToBars(v) >= 2), true);
eq('and none saturates below the top band', Math.max(...all.map(levelToBars)), 4);

// ── Refusals ─────────────────────────────────────────────────────────────────
eq('null level has no bars', levelToBars(null), null);
eq('undefined level has no bars', levelToBars(undefined), null);
eq('a non-finite level has no bars', levelToBars(NaN), null);
eq('zero is below the DX floor', levelToBars(0), 0);
eq('an absurdly high level clamps to full', levelToBars(9999), 4);

// ── The safety check ─────────────────────────────────────────────────────────
eq('a reading that stayed put is trusted', levelIsTrustworthy(10150, 10150), true);
eq('a reading that moved is not', levelIsTrustworthy(10150, 10590), false);
eq('a zero request is never trusted', levelIsTrustworthy(0, 0), false);

console.log(fails ? `\nsignalLevel: ${fails} FAILED` : '\nsignalLevel: ALL PASS');
process.exit(fails ? 1 : 0);
