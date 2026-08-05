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

/**
 * Level → the face's 0..4 bar icon.
 *
 *   < 10     0 bars   a DX seek would not stop here
 *   10..30   1 bar    above the DX floor, below the local threshold
 *   31..55   2 bars   the vendor calls this a local station
 *   56..80   3 bars
 *   81+      4 bars
 *
 * Against the fresh driver ratings of 2026-08-05: "breaking up" had a median
 * level of 41 and "clean" a median of 61, so the 2/3 boundary at 56 falls
 * between them. The bands are wide because the level ALONE cannot do better —
 * see the note above about multipath.
 */
export function levelToBars(level: number | null | undefined): number | null {
  if (level == null || !Number.isFinite(level)) return null;
  if (level < LEVEL_DX_FLOOR) return 0;
  if (level < LEVEL_LOC_FLOOR) return 1;
  const band = (LEVEL_TOP - LEVEL_LOC_FLOOR) / 3;
  return Math.min(4, 2 + Math.floor((level - LEVEL_LOC_FLOOR) / band));
}

/** A reading is only trustworthy when the tuner stayed on the frequency we asked
 *  about — the same check `AWNative.seek` makes before it believes a level. */
export function levelIsTrustworthy(asked: number, landed: number): boolean {
  return asked > 0 && asked === landed;
}

/**
 * How long to wait after a retune before believing a level.
 *
 * A reading taken immediately after tuning is systematically inflated. Across 24
 * paired comparisons on 2026-08-05 — first reading after a tune against the same
 * station 20 seconds later — the mean excess was +17.7, with cases of +45, +48
 * and +57. Banded by age: 0-5s mean 70.3, 5-15s mean 51.8.
 *
 * The value is the return of seek(), the chip's own scan primitive, so a read
 * taken while the tune is still completing plausibly reports that operation
 * rather than the settled channel. Five seconds clears the inflated band.
 *
 * Samples still carry `tuned=` so an analysis can discard anything too early
 * regardless of this delay.
 */
export const LEVEL_SETTLE_MS = 5_000;

/** How often to re-read while parked on a station. Each read COMMANDS the tuner,
 *  so this is deliberately slow: the vendor rate-limits its own comparable read
 *  to 900 ms (ArmRadioManager.clearVaildFlag) and this is far below that. */
export const LEVEL_POLL_MS = 30_000;
