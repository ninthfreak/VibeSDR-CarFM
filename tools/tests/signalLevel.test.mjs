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
eq('Baraboo oldies is solid', barsFor('94.9 WOLX Baraboo'), [2]);
// WERN's 53-55 now sits just under the 2/3 boundary at 56. That is arguably the
// more honest reading: WERN is the station that lost RDS fifteen times and
// flapped stereo across a commute while its level looked healthy.
eq('Madison public radio sits just under the boundary', barsFor('88.7 WERN Madison'), [2]);
eq('Z104 is solid', barsFor('104.1 WZEE Madison'), [2, 3]);
eq('WIBA climbs in its own city', barsFor('101.5 WIBA Sauk City'), [2, 3]);
eq('WWHG climbs on the approach', barsFor('105.9 WWHG Evansville'), [2, 3]);

// Nothing observed should ever land on 0 or 1 — every station tested was audible.
const all = Object.values(OBSERVED).flat();
eq('no audible station reads as absent', all.every((v) => levelToBars(v) >= 2), true);

// ── The 2026-08-05 drive: 156 samples, and the driver's own verdicts ─────────
// Medians of the FRESH ratings (given within 20s of the sample). The 2/3
// boundary has to fall between "breaking up" and "clean" or the bars disagree
// with the ear on the only two verdicts with clear separation.
eq('a "breaking up" median lands in the weak band', levelToBars(41), 2);
eq('a "clean" median lands higher', levelToBars(61), 3);
eq('the drive maximum reaches the top band', levelToBars(103), 4);
eq('...and does not overflow it', levelToBars(103), 4);
// The distribution: p50 63, p90 92, p99 101.
eq('the median of the whole drive is mid-scale', levelToBars(63), 3);
eq('p90 is near the top', levelToBars(92), 4);

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
