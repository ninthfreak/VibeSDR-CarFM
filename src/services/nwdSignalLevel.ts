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

/** Top of the useful span. PROVISIONAL — the highest reading observed so far is
 *  73 (105.9 up close), so this sits just above it. The two floors below are the
 *  vendor's; this one is ours and is the number most likely to need revising. */
export const LEVEL_TOP = 75;

/**
 * Level → the face's 0..4 bar icon.
 *
 *   < 10    0 bars   a DX seek would not stop here
 *   10..30  1 bar    above the DX floor, below the local threshold
 *   31..45  2 bars   the vendor calls this a local station
 *   46..60  3 bars
 *   61+     4 bars
 *
 * Checked against the twenty readings of 2026-08-04: WQLF Rockford heard from
 * Wisconsin lands on 2, the Madison locals on 3, and the two stations driven
 * toward reach 4.
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

/** How often to re-read while parked on a station. Each read COMMANDS the tuner,
 *  so this is deliberately slow: the vendor rate-limits its own comparable read
 *  to 900 ms (ArmRadioManager.clearVaildFlag) and this is far below that. */
export const LEVEL_POLL_MS = 30_000;
