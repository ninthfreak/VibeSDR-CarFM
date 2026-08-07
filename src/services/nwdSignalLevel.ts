/**
 * Signal level for the NWD head-unit tuner — scale, and the map onto the face's
 * five-state bar icon.
 *
 * UNDER DEVELOPMENT. The reading is real (see below) but the presentation is
 * provisional: the raw number is shown on the face on purpose so a drive log and
 * a glance at the screen can be compared, and the top three bands are guesses
 * that only more drives can settle.
 *
 * ── Where the number comes from ────────────────────────────────────────────────
 * `NwdFmManager.seek(rawCurrentFrequency)` returns a packed int: strength in the
 * high 16 bits, the frequency it landed on in the low 16. Verified on device
 * 2026-08-04 over twenty presses — landedOk true every time, no audio
 * interruption, and the value tracks both station and position (105.9 read 54 in
 * a Madison driveway and 73 approaching Evansville; 101.5 fell 62 → ~50 leaving
 * Madison).
 *
 * ── What the number MEANS is unresolved ────────────────────────────────────────
 * It is treated here as an ORDINAL, never as a unit. Printing "55 dB" would be
 * inventing a unit, which is the fabricated-diagnostics failure the audit
 * flagged. The evidence does not distinguish:
 *   - dBµV — 10 is very weak, 31 a fair local threshold, 73 a strong local; or
 *   - an arbitrary chip register, 0..100 or 0..127.
 * A DIFFERENT class in the same service, RadioConstant, carries
 * RADIO_LOC_FM_STOP = -65 and RADIO_DX_FM_STOP = -70 — negative, dBm-shaped.
 * Those are not what this value is compared against, so they do not decide it,
 * but they prove the vendor codebase carries two unrelated scales. No chip part
 * number appears anywhere in the service APK, so there is no datasheet to reach.
 *
 * ── What a level CANNOT tell you ───────────────────────────────────────────────
 * WERN 88.7 read a healthy 53-55 while losing RDS fifteen times and flapping
 * stereo across one commute. That is not an error in the reading: multipath
 * leaves the carrier strong and destroys the 57 kHz subcarrier and the stereo
 * pilot. This meter will show three solid bars straight through it. A meter that
 * matches what the driver HEARS wants the RDS-quality signals folded in — group
 * arrival rate and block error rate, both already flowing.
 */

/** Weakest level a DX seek will stop on — `NewRdsManager.RADIO_FM_DX_STOP`.
 *  Below this the tuner itself does not consider the frequency a station. */
export const LEVEL_DX_FLOOR = 10;

/** Weakest level a LOCAL seek will stop on — `NewRdsManager.RADIO_FM_LOC_STOP`.
 *  The vendor's own weak/solid boundary, and the anchor that matters most. */
export const LEVEL_LOC_FLOOR = 31;

/**
 * Top of the useful span.
 *
 * Was 75, set from twenty manual presses whose highest was 73. The drive of
 * 2026-08-05 sampled 156 readings and reached 103, so 75 was badly short and
 * nearly a third of the drive would have pinned to four bars.
 *
 * 105 comes from that distribution: p50 63, p75 79, p90 92, p99 101, max 103.
 * The scale evidently runs to about 100, so the top band starts at 81 and only a
 * genuinely close, strong station reaches it.
 *
 * Still empirical rather than specified — no chip datasheet is reachable — but
 * it now rests on 156 samples across a commute instead of twenty presses in two
 * car parks.
 */
export const LEVEL_TOP = 105;

/** The bands, from SIGNAL-METER.md v1.14. Deliberately NOT evenly spread: two of
 *  the five steps fall in 48-70, where stereo lock and multipath actually change.
 *  An even spread spends steps on high levels that all sound the same.
 *
 *  Replaces 31/45/60/74/89, which were an even division of the observed range
 *  (30..103, p50 63, p75 79, p90 92). These came from a mock-up instead — chosen
 *  for how the meter FEELS in use rather than for how the samples distribute.
 *
 *  31 stays the bottom either way: it is the vendor's own LEVEL_LOC_FLOOR, which
 *  is what makes "nothing lit" mean "the tuner would not call this a station". */
const BANDS = [31, 48, 60, 70, 85];

/** Opacity of the half-step ring — the next pair up, lit once the level passes
 *  the midpoint of the band it is in. Five states become nine without a sixth
 *  wave being added.
 *
 *  Design measured this at 1.69:1 (light) / 2.83:1 (dark) against the 3:1 floor
 *  for non-text graphics, and flagged that dotting starts on this ring — so the
 *  first element carrying the loss signal is the least visible thing on the
 *  glyph. Kept at 0.45 by decision: this display is a rough impression, not a
 *  measurement, and 0.45 is what reads as "half". */
export const HALF_STEP_OPACITY = 0.45;

/** What the glyph draws for a level. */
export interface SignalLit {
  /** Fully-lit arc pairs, 0-4, innermost first. */
  fullPairs: number;
  /** Is the NEXT pair up drawn at HALF_STEP_OPACITY? Never true at the top band. */
  half: boolean;
  /** Centre dot opacity, 0-1. 0 only at level 0. */
  dotOpacity: number;
}

/**
 * Level → what lights (SIGNAL-METER.md v1.14 "Strength → elements lit").
 *
 *   0        nothing at all
 *   1-30     dot only, ramped ~36% → 85%
 *   31-39    dot
 *   40-47    dot + pair 1 @ 45%
 *   48-53    + pair 1
 *   54-59    + pair 2 @ 45%
 *   60-64    + pair 2
 *   65-69    + pair 3 @ 45%
 *   70-77    + pair 3
 *   78-84    + pair 4 @ 45%
 *   85+      + pair 4
 *
 * SUB-FLOOR DOT RAMP. Below 31 the dot is not dark; it eases up by
 * 0.25 + 0.6·√f where f is the fraction of the way from 0 to 31. Levels the
 * glyph used to render identically — 12 against 30 — are now told apart.
 *
 * On THIS hardware it will rarely show: across the 156 samples of 2026-08-05 the
 * minimum was 30 and exactly one sample fell below 31. Built anyway, because it
 * costs nothing and the app is meant to reach other tuners.
 */
export function levelToLit(level: number | null | undefined): SignalLit | null {
  if (level == null || !Number.isFinite(level)) return null;
  if (level <= 0) return { fullPairs: 0, half: false, dotOpacity: 0 };
  if (level < LEVEL_LOC_FLOOR) {
    const f = level / LEVEL_LOC_FLOOR;
    return { fullPairs: 0, half: false, dotOpacity: 0.25 + 0.6 * Math.sqrt(f) };
  }
  // Which band, and therefore how many pairs are FULLY lit.
  let band = 0;
  while (band + 1 < BANDS.length && level >= BANDS[band + 1]) band++;
  const fullPairs = band;
  // Past the midpoint of the band, the next ring up half-lights. The top band
  // has no next ring, so it never half-lights.
  const lo = BANDS[band];
  const hi = band + 1 < BANDS.length ? BANDS[band + 1] : null;
  const half = hi != null && level > Math.floor((lo + hi - 1) / 2);
  return { fullPairs, half, dotOpacity: 1 };
}

/**
 * The five discrete steps, for paths with no unitless level: the RTL-SDR readout,
 * the Nearby list's per-station strength, and the settings preview.
 *
 * SIGNAL-METER is explicit that these take none of the richer model — no
 * half-steps and no sub-floor ramp — because they have no level to place inside a
 * band. `steps` is 0-5: 0 lights nothing, 1 the dot, 2-5 the dot plus that many
 * pairs outward.
 */
export function discreteLit(steps: number): SignalLit {
  const n = Math.max(0, Math.min(5, Math.round(steps)));
  return { fullPairs: Math.max(0, n - 1), half: false, dotOpacity: n >= 1 ? 1 : 0 };
}

/** How many arcs the glyph is drawing at all — the pool dotting works over. */
export function drawnArcs(lit: SignalLit | null): number {
  if (!lit) return 0;
  return lit.fullPairs + (lit.half ? 1 : 0);
}

/**
 * Reception loss → how many of the DRAWN arcs are dotted, spreading inward from
 * the leading arc (SIGNAL-METER.md v1.14 "Dotting").
 *
 * The leading arc is the half-step ring when one is lit, otherwise the outermost
 * fully-lit pair — completely unlit pairs are not in the pool. Nothing dots below
 * 30%: a hard floor, not a rounding artefact. From 30 to 100 the dots spread
 * inward by round((loss-30)/70 × dottable), anchored at 1 so the control is never
 * dead at exactly 30.
 *
 * NOTHING IS EXEMPT but the centre dot, which is a filled circle with no dotted
 * form. An earlier build clamped this so the innermost pair always stayed solid,
 * on the reasoning that "strong but lossy" should never collapse into reading as
 * weak; that clamp is gone by decision. At 100% every drawn arc dots.
 *
 * Anchoring at 1 gives the control PRESENCE, not resolution: with a single arc
 * drawn, every loss from 30 to 100 renders identically. Resolution needs two or
 * more drawn arcs.
 */
export function lossToDottedArcs(lossPct: number | null | undefined, dottable: number): number {
  if (lossPct == null || !Number.isFinite(lossPct)) return 0;
  if (dottable <= 0 || lossPct < LOSS_DOT_FLOOR) return 0;
  const spread = Math.round(((lossPct - LOSS_DOT_FLOOR) / (100 - LOSS_DOT_FLOOR)) * dottable);
  return Math.min(dottable, Math.max(1, spread));
}

/** Below this the reading counts as clean and nothing dots. Anchored on
 *  measurement: audio rated clean ran ~16% loss and audio rated crackle ~44.5%,
 *  at matched signal levels, and 30 is the midpoint between those populations. */
export const LOSS_DOT_FLOOR = 30;

/**
 * Hysteresis for the loss figure, so a value sitting near a rounding boundary
 * cannot flip an arc between solid and dotted every poll.
 *
 * ONE-DIRECTIONAL, and deliberately: it applies only on the way DOWN. Dotting
 * starts at the floor itself — 30% dots the leading arc, as specified — and only
 * clears once the figure has fallen this far below the boundary it crossed.
 *
 * That asymmetry is the right one for a warning. Flicker is what the margin
 * exists to stop, and the falling side alone stops it: a figure oscillating
 * around a boundary latches on and holds. Applying it on the way up as well
 * bought no extra stability and cost 5 points of sensitivity — it silently moved
 * the documented 30% floor to 35%.
 *
 * Design lists this deadband as an open question on its side. It is settled on
 * ours; the design bundle does not need to model it.
 */
export const LOSS_BAND_MARGIN = 5;

/**
 * Apply the margin. `prev` is the count currently drawn, `lossPct` the current
 * figure, `dottable` the number of arcs the glyph is drawing right now.
 *
 * The margin decides HOW FAR to move, never WHETHER to move. An earlier version
 * tested whether the nudged figure landed on the SAME count, which quietly meant
 * "adjacent counts only": a figure jumping two counts in one poll matched
 * nothing and the glyph refused to move at all, so a WORSE figure drew FEWER
 * dots. That failed from every starting count, in both directions.
 *
 * `dottable` is passed rather than captured because the pool changes with the
 * LEVEL, not with the loss — a level crossing a band boundary adds or removes an
 * arc under a perfectly steady loss figure. The result is clamped to the current
 * pool so a stale higher count cannot outlive the arcs it referred to.
 *
 * Pure so it can be tested without a renderer.
 */
export function settleDottedPairs(
  prev: number,
  lossPct: number | null | undefined,
  dottable: number,
): number {
  const next = lossToDottedArcs(lossPct, dottable);
  const held = Math.min(prev, dottable);            // the pool may have shrunk
  if (next === held) return held;
  if (lossPct == null || !Number.isFinite(lossPct)) return next;   // no figure → solid, at once
  // Rising: adopt at once, so the leading arc dots at 30% and not at 30 + margin.
  if (next > held) return next;
  // Falling: the figure has to drop the full margin below the boundary before an
  // arc goes solid again. Clamped, so a multi-count fall still moves.
  const nudged = lossToDottedArcs(lossPct + LOSS_BAND_MARGIN, dottable);
  return Math.min(held, Math.max(next, nudged));
}

/** A reading is only trustworthy when the tuner stayed on the frequency we asked
 *  about — the same check `AWNative.seek` makes before it believes a level. */
export function levelIsTrustworthy(asked: number, landed: number): boolean {
  return asked > 0 && asked === landed;
}

/**
 * Post-retune reads: show something fast, then correct it.
 *
 * ── The bump ─────────────────────────────────────────────────────────────────
 *
 * A reading taken immediately after tuning is systematically inflated. Across 24
 * paired comparisons on 2026-08-05 — first reading after a tune against the same
 * station 20 seconds later — the mean excess was +17.7, with cases of +45, +48
 * and +57, and the excess was positive on all five frequencies independently
 * (+7.9 to +25.3). The value is the return of seek(), the chip's own scan
 * primitive, so a read taken while the tune is still completing plausibly
 * reports that operation rather than the settled channel.
 *
 * ── How long it actually lasts ───────────────────────────────────────────────
 *
 * The first version of this waited 5s, on the reasoning that the drive's banded
 * means (0-5s 70.3, 5-15s 51.8) showed the inflation clearing around there.
 * Those pooled bands are confounded by which stations they contain — 105.9 is
 * strong and supplies 55 of the late samples, which drags the 15s+ pooled mean
 * back up to 65.0. Normalising each reading against its OWN station's settled
 * level instead puts the excess almost entirely in the 0-1s bucket (+20.0
 * median, n=29); from 2s on every band scatters around zero with no trend. So
 * 5s was about five times longer than the evidence supports.
 *
 * ── Why two reads rather than one later one ──────────────────────────────────
 *
 * A blank meter for even a second reads as broken, and the whole point of this
 * cluster is a fast impression. So: read at 1s and show whatever comes back,
 * then read again at 4s and correct it. 1s is not necessarily past the bump —
 * the sampler pools `tuned=0s` and `tuned=1s`, so it cannot be split — which
 * means the first number may still be high and the second is what settles it.
 * That trade is deliberate: a brief wrong number beats a long dash.
 */
export const LEVEL_FIRST_READ_MS = 1_000;

/** The correction, and the point the periodic cadence is re-phased from. */
export const LEVEL_CORRECTION_MS = 4_000;

/**
 * A rejected read is not a reading — it is the absence of one.
 *
 * `ok` is false when the chip reports landing on a frequency other than the one
 * queried, which on the drive logs was overwhelmingly `landed=0`: the tuner
 * saying it was not ready. Eight of the ten rejections observed were that, and
 * the two others landed on a genuinely different frequency mid-tune.
 *
 * Without a retry the handler simply returns, and immediately after a retune
 * there is no previous reading to fall back on — so the meter stays blank until
 * the next periodic read, which is the long dash this whole change removes.
 */
export const LEVEL_RETRY_MS = 1_000;
export const LEVEL_RETRY_MAX = 2;

/** How often to re-read while parked on a station. Each read COMMANDS the tuner,
 *  so this stays well clear of the vendor's own rate limit on the comparable
 *  read (900 ms, ArmRadioManager.clearVaildFlag). */
export const LEVEL_POLL_MS = 20_000;
