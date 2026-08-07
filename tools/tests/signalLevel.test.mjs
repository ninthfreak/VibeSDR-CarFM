// nwdSignalLevel — the level→lit map and the loss→dotted overlay, checked
// against the real readings.
//
// The bottom of the scale is the vendor's own local-seek constant, lifted from
// the decompiled NewRdsManager; the bands above it are ours and provisional.
// Every reading below is verbatim from the drive logs of 2026-08-04 / 08-05.
//
// Run: node tools/tests/signalLevel.test.mjs

import { levelToLit, lossToDottedPairs, settleDottedPairs, levelIsTrustworthy,
  LEVEL_LOC_FLOOR, LOSS_BAND_MARGIN }
  from '../../src/services/nwdSignalLevel.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// ── The vendor's anchor ──────────────────────────────────────────────────────
// Below the local-seek floor the tuner itself refuses to call the frequency a
// station, which is what makes "nothing lit" mean something.
eq('just under the LOC floor lights nothing', levelToLit(LEVEL_LOC_FLOOR - 1), 0);
eq('the LOC floor lights the dot', levelToLit(LEVEL_LOC_FLOOR), 1);

// ── Real readings, 2026-08-04 ────────────────────────────────────────────────
const OBSERVED = {
  '88.7 WERN Madison':        [55, 55, 53],
  '94.9 WOLX Baraboo':        [50, 47],
  '101.5 WIBA Sauk City':     [62, 49, 50, 54],
  '102.1 WQLF Rockford IL':   [40, 40, 41, 40, 37],
  '104.1 WZEE Madison':       [51, 58],
  '105.9 WWHG Evansville':    [54, 73, 72, 58],
};
const litFor = (k) => [...new Set(OBSERVED[k].map(levelToLit))].sort();

eq('the distant Rockford station reads weak but present', litFor('102.1 WQLF Rockford IL'), [1]);
eq('Baraboo oldies is mid-scale', litFor('94.9 WOLX Baraboo'), [2]);
eq('Madison public radio is mid-scale', litFor('88.7 WERN Madison'), [2]);
eq('Z104 straddles a boundary', litFor('104.1 WZEE Madison'), [2]);
eq('WIBA climbs in its own city', litFor('101.5 WIBA Sauk City'), [2, 3]);
eq('WWHG climbs on the approach', litFor('105.9 WWHG Evansville'), [2, 3]);

// Every station tested was audible, so none may render as dead air.
const all = Object.values(OBSERVED).flat();
eq('no audible station reads as absent', all.every((v) => levelToLit(v) >= 1), true);

// ── The 2026-08-05 drive: 156 samples, and the driver's own verdicts ─────────
// The bands are an even division of the observed range, NOT fitted to these two
// medians — that they separate is the check, not the construction.
eq('a "breaking up" median lands in the dot-only band', levelToLit(41), 1);
eq('a "clean" median lands three elements up', levelToLit(61), 3);
eq('the drive maximum reaches the top band', levelToLit(103), 5);
// The distribution: min 30, p50 63, p75 79, p90 92, p99 101.
eq('the drive minimum is below the floor', levelToLit(30), 0);
eq('the median of the whole drive is mid-scale', levelToLit(63), 3);
eq('p75 is one below the top', levelToLit(79), 4);
eq('p90 reaches the top', levelToLit(92), 5);

// Every one of the six states must be reachable — the fault in the OLD mapping
// was that two of five sat below 31 and no real preset could ever show them.
eq('all six states are reachable', [...new Set([20, 35, 50, 65, 80, 95].map(levelToLit))], [0, 1, 2, 3, 4, 5]);

// ── Refusals ─────────────────────────────────────────────────────────────────
eq('null level lights nothing knowable', levelToLit(null), null);
eq('undefined level lights nothing knowable', levelToLit(undefined), null);
eq('a non-finite level lights nothing knowable', levelToLit(NaN), null);
eq('zero is below the floor', levelToLit(0), 0);
eq('an absurdly high level clamps to full', levelToLit(9999), 5);

// ── Loss → dotted pairs ──────────────────────────────────────────────────────
// Anchored on measurement: clean audio ran ~16% loss, crackle ~44.5%, at matched
// signal levels. 30 is the midpoint. 20 was rejected as sitting on the shoulder
// of the clean population.
eq('the clean measurement dots nothing', lossToDottedPairs(16), 0);
eq('the crackle measurement dots one pair', lossToDottedPairs(44.5), 1);
eq('just under the first boundary is still clean', lossToDottedPairs(29.9), 0);
eq('the first boundary dots one', lossToDottedPairs(30), 1);
eq('the second boundary dots two', lossToDottedPairs(50), 2);
eq('the third boundary dots three', lossToDottedPairs(70), 3);
eq('total loss dots three, never more', lossToDottedPairs(100), 3);
eq('no figure dots nothing', lossToDottedPairs(null), 0);
eq('a non-finite figure dots nothing', lossToDottedPairs(NaN), 0);
// The strong-but-lossy sample of 2026-08-05: level 96, 42% loss. The whole point
// of the overlay is that this looks different from a weak clean signal.
eq('level 96 lights everything', levelToLit(96), 5);
eq('...and 42% loss breaks the outer pair', lossToDottedPairs(42), 1);

// ── Hysteresis ───────────────────────────────────────────────────────────────
// Nobody counts waves. A pair flipping between solid and dotted every 1.5s
// carries no information to offset the movement.
//
// The margin is ONE-DIRECTIONAL. Dotting starts at the band edge itself, and
// only clears once the figure has fallen a margin below it — fast to warn, slow
// to forgive, which is the right asymmetry for a warning.
eq('a clear move up is adopted', settleDottedPairs(0, 60), 2);
eq('a clear move down is adopted', settleDottedPairs(2, 10), 0);
eq('the boundary itself dots a pair — no margin on the way up', settleDottedPairs(0, 30), 1);
eq('a hair under the boundary does not', settleDottedPairs(0, 29.9), 0);
eq('a hair under it, coming down, is NOT adopted', settleDottedPairs(1, 29), 1);
eq('...but a full margin under it is', settleDottedPairs(1, 30 - LOSS_BAND_MARGIN - 1), 0);
eq('staying inside the current band changes nothing', settleDottedPairs(1, 40), 1);
// Losing the figure entirely is not a boundary crossing — it is the absence of
// evidence, and the waves must go solid at once rather than lag by a margin.
eq('losing the figure goes solid immediately', settleDottedPairs(3, null), 0);

// ── Regression: a multi-band jump must not be refused outright ───────────────
// The first version tested `nudged === next`, which meant "adjacent bands only".
// A two-band jump matched nothing and the glyph did not move at all, so a WORSE
// figure drew FEWER dots — 49% dotted one pair and 50% dotted none. This is the
// exact path a drive takes: an RDS gap forces 0, then the carrier returns in bad
// air with the loss figure already high.
eq('a clean signal dropping straight to 50% dots two', settleDottedPairs(0, 50), 2);
eq('a clean signal dropping straight to 70% dots three', settleDottedPairs(0, 70), 3);
eq('...and 100% still dots three', settleDottedPairs(0, 100), 3);
eq('a three-band collapse down still lets go', settleDottedPairs(3, 0), 0);

// More loss must NEVER draw fewer dots, from any band the glyph is already in.
// This is the property the old shape violated, in six separate places.
let reversals = [];
for (let prev = 0; prev <= 3; prev++)
  for (let x = 0; x < 100; x++)
    if (settleDottedPairs(prev, x + 1) < settleDottedPairs(prev, x))
      reversals.push(`showing ${prev}: ${x}%→${settleDottedPairs(prev, x)} but ${x + 1}%→${settleDottedPairs(prev, x + 1)}`);
eq('monotonic in loss from every starting band', reversals, []);

// ── The safety check ─────────────────────────────────────────────────────────
eq('a reading that stayed put is trusted', levelIsTrustworthy(10150, 10150), true);
eq('a reading that moved is not', levelIsTrustworthy(10150, 10590), false);
eq('a zero request is never trusted', levelIsTrustworthy(0, 0), false);

console.log(fails ? `\nsignalLevel: ${fails} FAILED` : '\nsignalLevel: ALL PASS');
process.exit(fails ? 1 : 0);
