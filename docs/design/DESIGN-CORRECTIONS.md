# Corrections and FYIs for Claude Design

Running list of places where the design bundle asserts something the app knows to
be wrong, or specifies behaviour it has no way to observe. Send these back with
the next round rather than one at a time.

Everything here is about the bundle, not about the design. Where a *design*
decision was taken differently in the app, that is recorded in the code, not
here.

---

## 1. `dasharray 0 4.8` cannot work on Android

**Where:** `SIGNAL-METER.md` § *Dotting — built*.

The spec says zero-length dashes with a round linecap render as round dots. That
is true in SVG and in a browser. On Android it is not: `DashPathEffect` requires
every interval to be positive and **silently drops the effect** when one is zero,
so a lossy arc renders as a **solid** one.

That is the exact failure the 4.8 gap exists to prevent — the icon silently
under-reporting loss — arriving by a different route.

The app ships `[0.01, 4.79]`: same 4.8 period, same visual result, but the first
interval is non-zero so the effect survives. Suggest the spec state the period
and the round cap, and note that a platform needing a non-zero first interval
should split it as `0.01 / 4.79` rather than rounding the gap.

## 2. Cadence and the post-tune window are not the bundle's to specify

**Where:** `SIGNAL-METER.md` § *Dotting — built*, closing paragraph — lists as
open "the deadband for the 1.5s-loss / 30s-level cadence mismatch" and "a
treatment for scanning and the 5s post-tune window".

Both numbers are already stale, and neither is observable from the prototype:

| the bundle says | the app does |
| --- | --- |
| 30s level cadence | **20s** |
| 5s post-tune window | **1s** first read, **4s** correction |

The post-tune delay was 5s and was cut after measuring the settling behaviour:
the inflation a fresh read shows is almost entirely inside the first second, not
the first five. The level is also re-read on a retry when the tuner rejects a
read, which the prototype has no equivalent for.

Please drop both from the spec. Timing that depends on a live tuner belongs in
the app; the bundle should specify what the glyph LOOKS like at a given level and
loss, which it does well.

The deadband is likewise settled on the app side (one-directional hysteresis:
dotting starts at the 30% floor itself and only clears once the figure has fallen
5 points below the boundary it crossed). No action needed beyond removing it from
the open list.

## 3. There is a real loss source now

**Where:** `SIGNAL-METER.md` § *Dotting — built*: "**The prototype has no loss
source.** … Nothing in the tuner path reports loss today."

No longer true. The app computes loss from the RDS decoder's rolling PI-match
figure over the last ~64 groups, updated every 1.5s, and it is live on the head
unit.

Two things follow that are worth knowing when specifying the treatment:

- **It is a proxy, not a block error rate.** This tuner hands over groups with no
  per-block validity, so block A is the only one whose correctness can be judged.
  Errors in B, C and D are invisible to it — which is why RadioText can arrive
  corrupt while the figure looks healthy, since the text lives in C and D.
- **Real values are not the demo values.** Across the drive logs the figure runs
  0% for long stretches and spikes to 30–100% in multipath. The demo's steady 45
  and 80 are plausible, but the live figure is much burstier, which is what makes
  the deadband matter.

The note that "resolution needs two or more drawn arcs" is exactly right and now
has a real consequence: on a weak station the glyph draws one arc, so every loss
from 30 to 100 renders identically.

## 4. FYI — TA is no longer decoded

**Where:** `ANDROID-IMPLEMENTATION.md` § *Tell strip*: "**TA** replaces TP while a
traffic announcement is active and **pulses**."

The app has removed TA end to end and always shows TP. Not a design
disagreement — a data-quality one. TA rode bit 4 of the same block as PTY and was
published under the PTY field's consensus rather than its own, so a single
corrupt group raised it. That drove the pulsing tell *and* lifted the user's
mute.

A flag meaning "an announcement is happening right now" has to react within a
group or two to be useful, which rules out the consensus that would make it
trustworthy — and in poor reception a genuine announcement might never accumulate
three clean groups, so gating it would suppress the true positives along with the
false ones.

TP is unaffected and now has its own consensus.

The spec can keep TA if you want the design to describe an ideal receiver; it
just will not appear in this build. Flagging it so a future reference screenshot
showing a pulsing TA is not read as a build defect.
