# CarFM — handoff

Written 2026-08-08, at the point where development passes to another instance
whose first job is the Rust portable core and whose next is the move to Slint.

This covers what is **not** in the code. The codebase documents its own reasoning
heavily — when you want to know why something is the way it is, the comment above
it is usually the real answer and is usually right. What follows is the context
that has no home in a source file: what the hardware actually does, what the
drive logs established, which decisions were the owner's rather than mine, and
where the traps are.

Read `AGENTS.md` first. It is short and it is binding.

---

## 1. What this is

CarFM is a GPL-3.0 fork of VibeSDR, reshaped into an FM radio for an Android
head unit running NOWADA (NWD) firmware. Expo SDK 56 / React Native 0.85, with
Kotlin native modules and a C++ DSP library inherited from the parent project.

The standing goal is **to strip everything VibeSDR out of the app**. Treat any
surviving VibeSDR machinery as debt, not as furniture. The long-term ambition is
to **target as many tuner types as possible** — that is a stated priority, and it
is why the built-in-tuner path never became the only path.

Two tuner backends exist today: the head unit's built-in NWD tuner (the primary
target) and RTL-SDR over USB/network (inherited, still supported).

---

## 2. The hardware, and what it will and will not do

The unit is a cheap NWD head unit. Almost everything below was established by
decompiling the vendor APKs and confirming on the device; none of it is in any
public documentation.

**The tuner is reached through the vendor service `com.nwd.radio.service`**, an
AIDL service, plus the framework class `com.nwd.app.NwdFmManager` by reflection.
The vendor *app* (`com.nwd.radio`) is separate and is not required — only the
service is. Both APKs are in the session uploads if you need to decompile again.

**The vendor getters are mostly hollow.** This cost days to discover:

| getter | reality |
| --- | --- |
| `getRtMessage()` | hardcoded `""` on one manager, region-gated on the other |
| `psName` | stays empty for a passive bound client |
| `getPTYType()` | returns 0 |
| `isStreroOn()` | stuck true — reads true on dead air |
| `getCurrentFrequency()` | works |

So **RadioText, PS, PTY and RT+ are decoded in the app from raw groups**, read
off `NwdFmManager.getRadioRDSDataArm()` — one already-synchronised group as 16
hex chars. That is the whole reason `src/services/nwdRds.ts` exists.

**Stereo** comes from the `notifyStereo` callback, never the getter.

**Signal level** comes from `seek(freq)`, whose return is a packed int: strength
in the high 16 bits, the frequency it landed on in the low 16. If the landed
frequency is not the one asked about, the reading is discarded — that check is
the app's own, not an error from the tuner.

**There is no per-block validity.** The chip hands over groups with no CRC
information, so block A is the only block whose correctness can be judged (by
whether it carries the trusted PI). Errors in B, C and D are invisible. This is
why RadioText can arrive corrupt while the quality figure looks healthy, and it
is why every field has its own consensus gate.

**MCU broadcasts** the app relies on: `com.nwd.action.ACTION_KEY_VALUE` (steering
wheel), `com.nwd.ACTION_OS_WAKE_UP` (ACC-on), `ACTION_ACCOFF_UPDATE`. The unit
**sleeps** on ACC-off rather than shutting down, and kills the app process while
asleep — so a manifest-declared receiver is the only thing that can wake it.

**`Settings.System` keys that matter**: `mcu_current_source` (4 = FM) is the
MCU's own record of the active audio source and is what the firmware's
restore-on-wake decision reads. Nothing in either vendor APK *writes* it — they
all read it — so it is owned by the MCU bridge or the launcher.

---

## 3. What the drive logs established

The owner drives the unit and uploads logs. This is the only source of truth for
anything behavioural, and several confident theories died against it. The logs
live in the session uploads as `carfmtunerlog*.txt`.

- **The signal scale is unitless and unidentified.** Never print a unit for it.
  A separate vendor class carries `RADIO_LOC_FM_STOP = -65`, which is dBm-shaped
  and is *not* the same scale — the codebase carries two unrelated scales and
  conflating them is a live risk. Observed range 30..103 across 156 samples;
  p50 63, p75 79, p90 92.
- **31 is the vendor's own `LEVEL_LOC_FLOOR`** — below it the tuner refuses to
  call a frequency a station. That is what makes "nothing lit" mean something.
- **A reading taken immediately after tuning is inflated**, mean +17.7 across 24
  paired comparisons, with cases of +45 to +57. Normalised per station, the
  excess sits almost entirely in the **first second**, not the first five — the
  original 5s settle gate was five times longer than the evidence supported.
- **Level does not predict audio quality on its own.** WERN 88.7 sat at 53-55
  while losing RDS fifteen times and flapping stereo across one commute.
  Multipath leaves the carrier strong and destroys the subcarrier. This is the
  entire reason the dotted-arc loss overlay exists.
- **Loss bands were anchored on two measurements**: audio the driver rated clean
  ran ~16% loss, audio rated crackle ~44.5%, at matched signal levels. 30 is the
  midpoint. These are two band means, not a distribution — they are **still
  provisional** and a commute could settle them.
- **TP varies locally**: WIBA 101.5 sets it in every captured group, WERN 88.7 in
  none. TA has essentially no data — one group-0 capture.
- **The estimated-signal system was removed after being measured**: pooled
  correlation against the station database looked strong (r=+0.924) but
  within-station it was **negative** (r=−0.268 on WERN). The pooled figure was
  measuring "big stations are strong", not predicting reception.

A caution that has bitten more than once: **pooled statistics across stations
mislead badly here.** Normalise per station before believing anything.

---

## 4. Decisions that were the owner's, not mine

Do not silently revisit these. Where I recommended otherwise, the owner's call
stands and the reason is recorded.

- **The signal meter's thresholds (31/48/60/70/85) come from a design mock-up**,
  chosen for how the meter *feels*, not from the measured distribution. I offered
  the measured alternative; the mock-up won.
- **Nothing is exempt from dotting except the centre dot.** I had built a clamp
  keeping the innermost pair solid so "strong but lossy" could not read as weak.
  The owner removed it deliberately.
- **The half-step ring stays dottable at 45% opacity** despite Design measuring
  it at 1.69:1 contrast and flagging that loss therefore starts on the least
  visible element. The owner's reasoning: this display is a rough impression, not
  a measurement.
- **TA is decoded and displayed, but does not break the mute.** I removed TA
  entirely at one point on reasoning that turned out to be wrong; it was restored
  with three guards. The mute-lift was then dropped on purpose — overriding a
  mute the driver set is the one TA behaviour whose false-positive cost is high.
- **The level number's ~3dp offset on the wide track is known and accepted.**
  It is a real spec miss; the owner declined the fix.
- **AF is not decoded.** Every 0A group in the logs carries COUNT=0 — each
  station stating it has no alternate frequencies. There is nothing to follow.
- **AM support is deferred** unless the app is distributed. Preset groups, if
  built, should be **mixed-band**, not the old FM1/FM2/FM3/AM bank model.

---

## 5. Working practices that are not optional here

`AGENTS.md` is the binding version; this is what it means in practice.

- **A direct instruction is a standing order.** Do it in the current pass or stop
  and say you are not doing it. Recording a task is not doing the work.
- **Never report something done unless it matches what was asked.** Partial or
  substituted work must be described as such, in the same message. This has been
  violated in this project — a commit message claimed the debug sampler logged
  half-steps as `.5` when the formatter rounded them away, because the producer
  was changed and the formatter was not checked. Say what you verified, and how.
- **Claims need evidence attached.** A command that ran and its output is
  reliable; a characterisation is not. Judging a file by its header or a
  checklist item by its title is the specific failure to avoid. Every substantive
  finding in this project was confirmed by running something.
- **Report in three plain lists**: DONE, NOT done, LEFT. Uniform grammar, no
  narrative, no editorial asides.
- **A false claim in a comment is a defect.** Several rounds of bug-hunting here
  found more stale comments than logic bugs. When you change behaviour, grep for
  the comments that described the old one.

---

## 6. Verification, and what cannot be verified here

**Can be run in the container:**
- `npx tsc --noEmit -p tsconfig.json` — currently clean.
- `npm run test:backend` — 20 suites, currently all passing. Plain node, type
  stripping; tests live in `tools/tests/`.
- `cd core && cargo test` — currently all passing (54 at the time of writing;
  trust the run, not this number).
- `npm run test:rds-diff` and `npm run test:stations-diff` — the differential
  harnesses below. Both need cargo, which is why they are not in test:backend.

**All five are enforced.** `.claude/hooks/verify-before-commit.sh` refuses a
`git commit` unless every one of them passes — the whole gate costs about nine
seconds. It skips the three cargo-dependent checks when no Rust toolchain is
installed, but refuses outright if the commit touches `core/` without one, so
the skip cannot become the silent hole it is meant to avoid. `--no-verify` is
still an explicit human override.

Two limits worth knowing. The hook is Claude Code's `PreToolUse`, so a human
typing `git commit` in a terminal runs nothing; and there is **no CI at all** —
no `.github/`, no installed git hooks (`.git/hooks` holds only samples,
`core.hooksPath` is unset). PRs #84-#88 merged with zero automated checks. A
workflow running these same five commands is the remaining gap.

**Cannot be run in the container:**
- **There is no Kotlin compiler and no Android build.** Native changes are
  verified by delimiter-balance and declaration-vs-reference analysis only. A
  past session shipped a broken build by deleting a declaration that a surviving
  function still referenced; the balance check alone cannot see that, so check
  references explicitly. Note also that a naive balance checker misreads
  `.append(')')` — strip char literals.
- **Nothing renders.** Layout and SVG correctness is reasoning, not observation.
- **The hardware.** Everything behavioural needs the owner to drive.

**The differential harnesses are the strongest tool in the repo.** Each pair
prints the same state shape from the Rust port and the shipped TypeScript, over
a corpus regenerated deterministically on every run:

```
npm run test:rds-diff        # decoder pair — byte-identical, or it fails
npm run test:stations-diff   # station logic pair — structure exact, numbers to 1e-9
```

By hand, the RDS pair is `tools/tests/rdsDump.mjs` against
`cargo run -q -p carfm-rds --example rds-dump` (stdin), fed the output of
`tools/tests/rdsCorpus.mjs`. The step counts are printed each run — do not
record them anywhere, they grow with the corpus. The stations pair is not a
byte comparison because it runs transcendentals; `stationsDifferential.mjs`
opens with the reasoning. **Keep both green.** If you extend a Rust crate,
extend the TypeScript reference or retire it explicitly — do not let them
drift silently, which is exactly what happened to the first cut of this port.

---

## 7. State of the work

**Branches.** `main` is the trunk. PR #85 merged the previous work branch
(`claude/design-audit-handoff-26qnlb`); the portable core lives on THIS branch
(`claude/slint-conversion-carfm-removal-325vh5`), which is where you are
reading this and which is **not on main until its own PR merges** — main's
`core/` holds nothing but stray build artifacts this branch deletes.
`claude/portable-core-rds` was **superseded** — its core was re-ported here
with the four missing behaviours and the differential proof — and has since
been deleted from the remote.

**26 commits have never run on the hardware** — everything after the drive log of
2026-08-06 20:58. That is the v1.14 signal-meter rebuild, the stereo cones, the
TA round-trip, the post-tune read schedule, the startup reordering, and two bug
passes. All verified by tsc, tests and analysis only. (The Rust crates are
libraries with no caller and cannot affect app behaviour — but the stations
port also refactored LIVE app code: `stationDb`/`stationFinder` now delegate to
the extracted `stationRank` and `stationIdentify`. Behaviour-preserving per
tsc, the 18 suites and the differential, and still part of this same
untested-on-hardware pile.) **A commute is the highest-value next action** — it
either confirms a large body of work or produces a short bug list, and it is
cheap.

**Unresolved and known-broken.** Commit `943857e` added an ACC-wake receiver that
brings CarFM forward, gated on a `was_foreground` flag written by
`MainActivity.onPause`. The owner said to drop it; only the uncommitted follow-up
was dropped and the commit remains in `main`. It also carries a confirmed bug:
`onPause` writes `false` for *any* pause — a reverse-camera view or a Bluetooth
call screen before ACC-off — so the wake-forward refuses in exactly the cases it
was meant to admit. **Get a decision before building on it.**

A better mechanism was identified and reverted rather than finished: read
`Settings.System.mcu_current_source` and act only when it is 4 (FM), which
piggybacks on the firmware's own restore rule instead of reimplementing it.

**The trampoline plan.** The idea is to replace the vendor radio app with a
same-named stub that launches CarFM, so the firmware's own restore brings CarFM
forward. A **read-only recon probe is shipped** (Settings → "Probe vendor-app
replacement") and **has never been run**. Everything downstream is blocked on its
output. What is already known: `com.nwd.radio` declares no `sharedUserId` (so no
UID constraint), its launcher activity is `com.nwd.radio.home_horizontalActivity`,
the service checks the top app by **package** name, and nothing in either APK
writes `mcu_current_source`. The risky step is remounting `/system`; the cheap
first experiment is `pm hide com.nwd.radio` plus one ACC cycle, which costs
nothing and answers the main question.

**Unsent.** `docs/design/DESIGN-CORRECTIONS.md` holds four items for Claude
Design — the Android dasharray constraint, cadence/post-tune being outside the
bundle's remit, the live loss source, and how TA should be trusted. Written,
never delivered.

**Unverified findings.** The second adversarial bug pass produced 30 deduped
findings; 14 were verified and 16 were dropped unverified for budget, all
self-rated low or medium.

**Drifting dead code**, flagged repeatedly and never removed, not in the task
list: the `HD` tell is hardcoded `on={false}` and can never light (zero HD
identifiers in the vendor dex), and `nameBlock` survives in the band-theme
registry and `CarFmFace` with **no theme defining it** — it belonged to Talking
Heads, which Led Zeppelin replaced, so the branch is unreachable.

---

## 8. On the road ahead

**The portable core is much larger than one decoder.** `core/rds` was the easy
part, and `core/stations` (PI arithmetic, geo, ranking, identification) is the
second piece. What remains is bigger than both: the database I/O itself, the
logo dark-mode pipeline, presets, the NWD vendor integration and the SDR
backends all still live in TypeScript and Kotlin. Scope the Slint move against
that, not against the decoder.

**Design ships HTML prototypes, not code.** They port to any framework, so the
Slint move does not break that relationship. Read the bundles as structure and
behaviour, and reimplement natively — that is what they ask for. The design
spec line is at v1.14.x — the meter spec is vendored at
`docs/design/SIGNAL-METER.md` — while the vendored prototype bundle at
`docs/design/handoff` is older (its VERSION file reads 1.10.0); trust the
vendored specs over the bundle where they disagree.

**Whatever replaces the face has to reproduce a lot of finished work**: the
signal meter with half-steps, the sub-floor ramp and the dotted-arc overlay; the
speaker-cone stereo pill; the tell strip; nine band themes with their own
typefaces and vector art; and the logo dark-mode adaptation pipeline. None of
that is throwaway, but all of it is React Native today.

**SoapySDR on Android is plausible** via `libusb_wrap_sys_device`, if the
many-tuners ambition goes further.
