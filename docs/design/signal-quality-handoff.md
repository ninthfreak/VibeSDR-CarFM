# Handoff → Claude Design: signal + reception-quality readout

> **PAUSED 2026-08-05, at the user's direction.** This brief and its answer
> document grew into a capability/state-contract negotiation when what was wanted
> was placement and sizing. Both numbers are now on the face with provisional
> sizes so they can be adjusted directly against the real screen. Keep these two
> documents for the constraints they record — no unit, nothing moves, no
> red/green, sub-100% is healthy — but do not treat them as an open work item.

Companion to the FM Radio Face handoffs (same fork, same design language). This
covers **one cluster** on the face — the signal meter in the header row — which
now has a second value to show.

## SCOPE: the built-in head-unit tuner ONLY

This design applies **only when CarFM is driving the head unit's own NOWADA
(NWD) FM chip**. It must not be designed as the universal signal readout, for a
concrete reason: the other backend measures genuinely different things.

| | built-in NWD tuner (**this design**) | RTL-SDR dongle (not this design) |
|---|---|---|
| Signal | unitless ordinal from the chip's scan primitive | real measured dB |
| Reception quality | one block of four can be checked | true error rate across all four blocks |
| Now-playing | station's raw RadioText only | RT+ — artist and title separated |

The SDR path already renders a real `dB` figure and amber "live" bars, and it
keeps doing that. Please design this cluster as the **built-in-tuner variant**,
and assume a sibling variant exists for SDR. Do not unify them — a later task
routes both through a capabilities layer, and the numbers do not mean the same
thing.

## What is being displayed

Two values, stacked, in the existing signal cluster:

1. **Signal level — prominent.** The larger, primary number.
2. **Reception quality — subordinate.** Smaller, visually secondary, directly
   beneath the level.

The relationship to imply is **containment, not ratio**: level is how much
signal is arriving, quality is how much of it survives to be decoded. "Of the
signal you have, this much is usable." They are not two peer statistics and
should not read as a row of equals.

## The data, as it actually behaves

Measured across 156 samples on a real commute (2026-08-05), plus 20 stationary
readings the day before.

**Signal level** — integer, unitless, no suffix.
- Observed range **30 to 103**. Distribution: p50 63, p75 79, p90 92, p99 101.
- **Three digits happen.** The third digit is always `1`.
- Drives the existing 0–4 bar icon. Thresholds: `<10` none, `10–30` 1 bar,
  `31–55` 2, `56–80` 3, `81+` 4. The two lowest come from the tuner's own
  seek-stop constants, so they are not ours to move.
- **No unit may be printed.** It is not dB and not dBµV; the scale is the
  vendor's and unidentified. Printing a unit would be a fabrication.

**Reception quality** — percentage, 0–100, **or absent**.
- It is *not* "% intact". It is the share of recent RDS groups whose PI block
  matched. This tuner supplies no per-block validity, so that is the only block
  whose correctness can be judged; errors in the two blocks carrying the *text*
  are invisible to it.
- Typical values: **~84% when the driver calls the audio clean**, ~55% when
  they report pops and crackles, at the *same* signal level. That separation is
  the reason it is on screen at all.
- **84% is the good case.** A design that makes anything under 100% look like a
  fault will read as permanently broken. Sub-100 is normal and healthy.
- **Frequently absent** — null until ~16 groups have arrived, and on any station
  with weak or no RDS. A weak station must not be able to show a high quality
  figure; "we don't know" is a required state, not an edge case.

## Hard constraints

- **Nothing may move when a value changes.** This is a stated pet peeve and a
  standing rule for the face. `63` and `103` must occupy identical space, and
  the quality line appearing or vanishing must not shift the stereo pill beside
  it or anything else in the row. Reserve the space; do not reflow.
- **Tabular figures.** A proportional `1` is much narrower than `0` and the
  number would jitter as it counts.
- **No red/green** anywhere (§6 — the driver is red/green colourblind). Amber =
  live/measured/hot, blue = interactive, grey/dim = not live.
- Amber currently signals "this is a real measurement" on this cluster, as
  opposed to the grey it used when the value was a database estimate.

## Where it sits

`CarFmFace.tsx`, header row, in the existing `signalPill`. It shares that row
with the **STEREO/MONO pill** — the element most at risk from any width change.

Two layout modes already exist and both need to work:
- **Wide** (1024×614 and 1280×720 head units): the cluster is a horizontal row,
  bar icon then the numbers. Icon 33, level text 15.
- **Tall** (portrait): the cluster is a vertical column, icon above numbers.
  Icon 46, level text 19.

Sizes are pre-scaling; everything scales with the responsive `s()` helper, and
small status type floors at legibility rather than proportion (§10).

## States to cover

1. **Both values** — the normal case.
2. **Level only, quality unknown** — common; a station with little RDS, or the
   first seconds after tuning. Must not look broken or imply 0%.
3. **No reading at all** — before the first measurement.
4. **Powered off** (§4.7) — the whole cluster drops to its off state with the
   rest of the face; currently zero bars and `--`.

## Deliberately not wanted

- **A single blended score.** Level and quality are different physical
  quantities; combining them into one number implies a linear trade-off that
  nothing supports.
- **A unit on either number.**
- **Framing quality as a fault indicator.** It is a normal, always-imperfect
  reading.

## Note on the label

The wording of the quality figure is unresolved and is the open question this
mock-up can help settle. Candidates: label it precisely for what it measures
(`PI 84%`), show it unlabelled and coarse so it reads as an indicator rather
than a claim, or invert it to the failure (`16% err`) so it asserts nothing
about the blocks it cannot see. Feel free to propose better.

## Current state of the code

Implemented and on device: the level, the bars, the fixed-width number, **and now
the quality figure beneath it** — 11pt wide / 13pt tall, dim, unlabelled, in its
own reserved box. `—` when unknown, blank when the radio is off, absent entirely
on the SDR path. Placement and size are provisional and meant to be adjusted from
what the head unit actually looks like; the label wording is still unresolved.
