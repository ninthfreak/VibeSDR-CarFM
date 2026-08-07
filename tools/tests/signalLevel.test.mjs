// nwdSignalLevel — what the glyph draws for a level, and the dotted-arc loss
// overlay, checked against SIGNAL-METER.md v1.14.
//
// The bottom of the scale is the vendor's own local-seek constant, lifted from
// the decompiled NewRdsManager. The bands above it (48/60/70/85) come from a
// design mock-up, chosen for how the meter FEELS rather than for how the
// measured samples distribute — so the table below is transcribed from the spec,
// not derived from the drive logs. Where a log value appears it is verbatim from
// 2026-08-04 / 08-05.
//
// Run: node tools/tests/signalLevel.test.mjs

import { levelToLit, discreteLit, drawnArcs, lossToDottedArcs, settleDottedPairs,
  levelIsTrustworthy, LEVEL_LOC_FLOOR, LEVEL_FIRST_READ_MS, LEVEL_CORRECTION_MS,
  LEVEL_RETRY_MS, LEVEL_RETRY_MAX, LEVEL_POLL_MS }
  from '../../src/services/nwdSignalLevel.ts';

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// ── The vendor's anchor ──────────────────────────────────────────────────────
// Below the local-seek floor the tuner itself refuses to call the frequency a
// station. The glyph does not go dark there any more — the dot RAMPS — but the
// floor is still where the first arc pair becomes possible.
const lit = (n) => levelToLit(n);
eq('just under the LOC floor lights no pairs', lit(LEVEL_LOC_FLOOR - 1).fullPairs, 0);
eq('...but the dot is not dark', lit(LEVEL_LOC_FLOOR - 1).dotOpacity > 0.8, true);
eq('the LOC floor is a full dot', lit(LEVEL_LOC_FLOOR).dotOpacity, 1);

// ── SIGNAL-METER v1.14 "Strength → elements lit", row by row ─────────────────
// Thresholds 31/48/60/70/85, plus a half-step ring past each band's midpoint.
// This table IS the spec table; if it disagrees, the code is wrong.
const shown = (n) => { const l = lit(n); return l == null ? null : `${l.fullPairs}${l.half ? '+half' : ''}`; };
const TABLE = [
  [0, '0'], [1, '0'], [30, '0'],          // sub-floor: dot only, ramped
  [31, '0'], [39, '0'],                    // dot
  [40, '0+half'], [47, '0+half'],          // dot + pair 1 @ 45%
  [48, '1'], [53, '1'],                    // + pair 1
  [54, '1+half'], [59, '1+half'],          // + pair 2 @ 45%
  [60, '2'], [64, '2'],                    // + pair 2
  [65, '2+half'], [69, '2+half'],          // + pair 3 @ 45%
  [70, '3'], [77, '3'],                    // + pair 3
  [78, '3+half'], [84, '3+half'],          // + pair 4 @ 45%
  [85, '4'], [103, '4'], [999, '4'],       // + pair 4
];
for (const [level, want] of TABLE) eq(`level ${level}`, shown(level), want);
eq('the top band never half-lights a fifth pair', lit(999).half, false);

// ── Sub-floor dot ramp ───────────────────────────────────────────────────────
// 0.25 + 0.6·√f, f = level/31. Levels the glyph used to render identically —
// 12 against 30 — are now told apart.
eq('level 0 draws nothing at all', lit(0).dotOpacity, 0);
eq('level 1 is about 36%', Math.round(lit(1).dotOpacity * 100), 36);
eq('level 30 is about 84%', Math.round(lit(30).dotOpacity * 100), 84);
eq('12 and 30 are no longer identical', lit(12).dotOpacity !== lit(30).dotOpacity, true);
eq('the ramp only rises', [1, 5, 12, 20, 30].every((v, i, a) => i === 0 || lit(v).dotOpacity > lit(a[i - 1]).dotOpacity), true);
eq('and never reaches a full dot before the floor', lit(30).dotOpacity < 1, true);

// ── Refusals ─────────────────────────────────────────────────────────────────
eq('null level lights nothing knowable', lit(null), null);
eq('undefined level lights nothing knowable', lit(undefined), null);
eq('a non-finite level lights nothing knowable', lit(NaN), null);

// ── The discrete path (RTL-SDR, Nearby, settings preview) ───────────────────
// No unitless level, so no half-steps and no ramp — five steps only.
eq('discrete 0 lights nothing', `${discreteLit(0).fullPairs}/${discreteLit(0).dotOpacity}`, '0/0');
eq('discrete 1 is the dot alone', `${discreteLit(1).fullPairs}/${discreteLit(1).dotOpacity}`, '0/1');
eq('discrete 5 is every pair', discreteLit(5).fullPairs, 4);
eq('discrete never half-lights', [0,1,2,3,4,5].every((n) => !discreteLit(n).half), true);
eq('discrete clamps above 5', discreteLit(99).fullPairs, 4);

// ── Dotting: spread inward from the LEADING drawn arc ───────────────────────
// The pool is what is DRAWN, half-step ring included. Nothing below 30%.
// max(1, round((loss-30)/70 × dottable)) — anchored at 1 so 30% is never dead.
eq('nothing dots below the floor', lossToDottedArcs(29.9, 4), 0);
eq('the floor dots exactly the leading arc', lossToDottedArcs(30, 4), 1);
eq('total loss dots every drawn arc', lossToDottedArcs(100, 4), 4);
eq('...and with three drawn, all three', lossToDottedArcs(100, 3), 3);
eq('the demo case: 45% of four drawn', lossToDottedArcs(45, 4), 1);
eq('80% of four drawn', lossToDottedArcs(80, 4), 3);
eq('nothing drawn, nothing dots', lossToDottedArcs(100, 0), 0);
eq('no figure dots nothing', lossToDottedArcs(null, 4), 0);
eq('a non-finite figure dots nothing', lossToDottedArcs(NaN, 4), 0);
// Presence, not resolution: one drawn arc renders every loss identically.
eq('one drawn arc cannot resolve loss', [30, 50, 70, 100].map((v) => lossToDottedArcs(v, 1)).join(','), '1,1,1,1');
// The clamp that kept the innermost pair solid is GONE by decision.
eq('the innermost drawn arc is not exempt', lossToDottedArcs(100, 4) === 4, true);

// ── Hysteresis ───────────────────────────────────────────────────────────────
// One-directional: dotting starts at the floor itself and only clears once the
// figure has fallen a margin below the boundary it crossed.
eq('the floor itself dots — no margin on the way up', settleDottedPairs(0, 30, 4), 1);
eq('a hair under the floor does not', settleDottedPairs(0, 29.9, 4), 0);
eq('a clear move up is adopted', settleDottedPairs(1, 80, 4), 3);
eq('a clear move down is adopted', settleDottedPairs(3, 0, 4), 0);
eq('staying put changes nothing', settleDottedPairs(2, 60, 4), 2);
eq('losing the figure goes solid immediately', settleDottedPairs(3, null, 4), 0);

// More loss must NEVER draw fewer dots, from any starting count, at any pool
// size. This is the property the pre-7cf6ece shape violated in six places.
let reversals = [];
for (let dottable = 1; dottable <= 4; dottable++)
  for (let prev = 0; prev <= dottable; prev++)
    for (let x = 0; x < 100; x++)
      if (settleDottedPairs(prev, x + 1, dottable) < settleDottedPairs(prev, x, dottable))
        reversals.push(`pool ${dottable}, showing ${prev}: ${x}%→${settleDottedPairs(prev, x, dottable)} but ${x + 1}%→${settleDottedPairs(prev, x + 1, dottable)}`);
eq('monotonic in loss, every pool size and starting count', reversals, []);

// A multi-count jump must move, not be refused outright.
eq('a clean signal dropping straight to 100% dots everything', settleDottedPairs(0, 100, 4), 4);

// The pool shrinks when the LEVEL drops a band. A count held over from a bigger
// pool must not outlive the arcs it referred to.
eq('a held count is clamped to the pool that now exists', settleDottedPairs(4, 100, 2), 2);
eq('...and to zero when nothing is drawn', settleDottedPairs(3, 100, 0), 0);

// ── drawnArcs — the pool the dotting works over ─────────────────────────────
eq('a bare dot draws no arcs', drawnArcs(lit(31)), 0);
eq('a half-step ring counts as drawn', drawnArcs(lit(40)), 1);
eq('the top of the scale draws four', drawnArcs(lit(103)), 4);
eq('null draws nothing', drawnArcs(null), 0);
// The bundle ships every reference screenshot at level 79 / loss 45.
eq('the reference frame draws four arcs', drawnArcs(lit(79)), 4);
eq('...with the leading one a half-step', lit(79).half, true);
eq('...and dots exactly that leading arc', lossToDottedArcs(45, drawnArcs(lit(79))), 1);

// ── Post-tune read schedule ──────────────────────────────────────────────────
// Order is the invariant worth protecting: the first read has to land before the
// correction, and a retry has to fit between them or it is not a retry — it just
// races the correction it was meant to stand in for.
eq('the first read comes before the correction', LEVEL_FIRST_READ_MS < LEVEL_CORRECTION_MS, true);
eq('a retry fits inside that gap', LEVEL_FIRST_READ_MS + LEVEL_RETRY_MS < LEVEL_CORRECTION_MS, true);
eq('every retry fits, not just the first', LEVEL_FIRST_READ_MS + LEVEL_RETRY_MAX * LEVEL_RETRY_MS <= LEVEL_CORRECTION_MS, true);
// The correction re-phases the periodic watch, and the native side floors the
// cadence at 5s to protect the chip — a cadence under that would be silently
// overridden, so the constant must not claim a rate it will not get.
eq('the cadence clears the native 5s floor', LEVEL_POLL_MS >= 5_000, true);
eq('the correction lands well inside one cadence period', LEVEL_CORRECTION_MS < LEVEL_POLL_MS, true);

// ── The safety check ─────────────────────────────────────────────────────────
eq('a reading that stayed put is trusted', levelIsTrustworthy(10150, 10150), true);
eq('a reading that moved is not', levelIsTrustworthy(10150, 10590), false);
eq('a zero request is never trusted', levelIsTrustworthy(0, 0), false);

console.log(fails ? `\nsignalLevel: ${fails} FAILED` : '\nsignalLevel: ALL PASS');
process.exit(fails ? 1 : 0);
