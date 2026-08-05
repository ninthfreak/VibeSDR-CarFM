# Handoff → Claude Design: the signal icon carries both strength and loss

Supersedes the display half of `signal-quality-handoff.md` and its answer
document, both of which are paused. Those two are still worth reading for the
constraints they record — no unit on the number, nothing moves when a value
changes, no red/green, sub-perfect reception is normal — but the two-numbers
design they describe has been abandoned. **This document is the live brief.**

## SCOPE: the built-in head-unit tuner ONLY

Applies **only when CarFM drives the head unit's own NOWADA (NWD) FM chip**. The
RTL-SDR path measures genuinely different things — a real dB level and a true
error rate across all four RDS blocks — and keeps its own readout. Do not unify
them.

## The decision in one line

**Strength decides how much of the icon is drawn. Data loss converts the
outermost drawn waves from solid to dotted.** The count never shrinks, so a
strong carrier arriving in pieces looks different from a weak carrier arriving
cleanly — which is the entire point, because those two cases sound completely
different and currently render identically.

Nothing is labelled. No percentage appears on the face. The icon and the bare
level number carry it.

## What the icon actually is

`src/components/carfm/icons.tsx` → `SignalWaves`. Please read the real geometry
before redrawing, because it is easy to picture wrongly:

- **There is no tower and there are no bars.** It is a filled circle at the
  centre with concentric arc *pairs* flanking it left and right — a point source
  radiating sideways, bilaterally symmetric. Closer to a Wi-Fi glyph rotated 90°
  than to a mast.
- Currently a 34×24 viewBox: dot at (15,12) r 2.6, then three arc pairs at radii
  5, 8.7 and 12.5. Every arc is a stroked path — `fill="none"`,
  `strokeWidth 2.2`, `strokeLinecap="round"`. Apexes fall at roughly 5-unit
  intervals; chord heights run 8 → 14 → 20.
- Rendered 33dp wide on the wide tracks, 46dp tall-track, height locked to the
  34:24 aspect.

### Two things to fix while redrawing

1. **A fourth arc pair is being added** and the icon grows slightly. Continuing
   the existing 5-unit apex spacing puts the new pair at roughly r 16.3. The
   viewBox has to grow with it.
2. **The current glyph is off-centre and clips.** It is centred on x=15 in a
   34-wide box — two units left of centre. Working the arc geometry through, the
   left outer arc's apex lands at x = −1, and half the 2.2 stroke carries it to
   −2.1, outside the viewBox, which clips. The right outer apex sits at 31 with
   about three units of slack. So the left outer wave should have a flattened tip
   that the right does not. *This is from the path arithmetic, not from looking at
   a render* — but it is asymmetric by construction and worth correcting now.

## Strength → how much is drawn

Five elements, six states. The dot lights first, then each pair outward.

| lit | level |
|---|---|
| nothing | <31 |
| dot | 31–44 |
| + 1st pair | 45–59 |
| + 2nd pair | 60–73 |
| + 3rd pair | 74–88 |
| + 4th pair | 89+ |

**Every element always renders.** Unlit ones are drawn in the off colour, so the
zero state is the full glyph gone dim, not a vanishing icon.

Where these come from: 156 samples on a real commute (2026-08-05), range 30–103,
p50 63, p75 79, p90 92. 31 is the tuner's own local-seek floor — the level below
which the chip refuses to call a frequency a station — so below it the icon
saying "nothing here" is the vendor's own verdict, not ours.

The bands are an even division of the observed range, and they land on the
listening evidence without having been fitted to it: "breaking up" had a median
level of 41, which falls in the dot-only band, and "clean" had a median of 61,
which falls at three elements lit.

**This replaces the old five-state mapping**, under which two of the five states
sat below 31 and were unreachable on a real preset. The icon had five states and
spent three of them.

## Loss → what gets dotted

The outermost *lit pairs* become dotted, from the outside in.

| dotted | data loss |
|---|---|
| none | <30% |
| 1 pair | 30–49% |
| 2 pairs | 50–69% |
| 3 pairs | 70%+ |

Anchored on measurement: audio rated clean ran ~16% loss, audio rated crackle
~44.5%, at matched signal levels. 30% is the midpoint between those two
populations. A boundary at 20% was considered and rejected — it sits on the
shoulder of the clean population, so ordinary variance would break the waves up
during audio that sounds fine.

### Rules the bands do not express

- **Clamp to what is lit.** "Dot two pairs" is impossible when one is lit. Dot
  the outermost N lit pairs, N clamped to the number lit.
- **The dot is the floor and is never dotted.** A filled 2.6-radius circle has no
  dotted form. Worst case is a lone solid dot with every lit pair dotted, which
  reads correctly: barely anything there, and what is there is not clean.
- **No loss figure means nothing is dotted.** Quality is null until ~16 RDS
  groups have arrived, and on any station carrying little or no RDS. A strong
  station with weak RDS must render exactly as it does today — all solid. Absence
  of data is not evidence of loss.

## Dots, not dashes, not hollow

- **Hollow was never available.** The arcs are already strokes with `fill="none"`
  — there is no fill to remove.
- **Dots beat dashes at this size.** `strokeLinecap="round"` is already set, so a
  dasharray with a **zero-length dash** renders true round dots at the full 2.2
  stroke diameter. Full-weight blobs survive a small dim display; elongated
  dashes smear, and a two-dash arc can be misread as a shortened solid one.
- **Specify the dash pattern in viewBox units, not pixels.** The whole icon
  scales from a fixed viewBox, so one pattern renders proportionally identical at
  both the wide and tall sizes with no per-track tuning.
- **Keep the symmetry.** The mirrored arcs of each pair both start at the top of
  their sweep, so an identical pattern puts the gaps at matching heights left and
  right. Worth confirming that still holds at the new radii.

## Colour is spoken for — do not spend it

- **No red/green anywhere.** The driver is red/green colourblind.
- **Amber means "this is a real measurement."**
- **Grey already means "this is a GPS+database estimate, not a reading."** That is
  why loss must not be drawn in grey: two amber waves and two grey ones would
  read as "half of this is estimated," which is meaningless.
- **The real legibility risk in this whole design:** dotted amber dissolving
  toward grey at small size. Each arc now has three states — solid amber, dotted
  amber, off-colour — and if the third and second become confusable on a dim
  dashboard the icon lies. Please check this case first.

## States to cover

1. **Strength only, no loss figure** — the common case, and the boot case. All
   lit elements solid.
2. **Strength and loss** — the normal case once RDS is flowing.
3. **Nothing lit** — level below 31, or before the first reading.
4. **Powered off** — the whole cluster drops to its off state with the rest of
   the face (§4.7).
5. **Scanning, and the five seconds after a retune** — the level is not
   trustworthy in either window. A reading taken immediately after tuning ran a
   mean +17.7 above the same station 20 seconds later, with cases of +45, +48 and
   +57. Please give this a treatment; the current design has none.

## Motion

The two inputs update at very different rates, and this is the thing most likely
to make the icon feel broken:

- **Loss updates every 1.5 seconds.**
- **Level updates every 30 seconds** while parked on a station, plus once 5s
  after each retune. It cannot go faster — each read commands the tuner.

So the dotting will change repeatedly against a wave count that sits perfectly
still, and a loss figure hovering near a band boundary will flip a whole pair
between solid and dotted over and over. **A deadband is required** — cross a
boundary by several points, or hold each state a minimum time, before redrawing.
Please specify which, and any transition between solid and dotted.

## Deliberately not wanted

- **A label on anything.** Tried and rejected: `ID 74%` reads as 74% confidence
  in the station's callsign, and no two- or three-character token can carry
  "share of recent RDS groups whose identity block survived."
- **A second number on the face.** The bare level number stays. The percentage
  moves into debug mode, where the person reading it is the developer.
- **A single blended score.** Strength and loss are different physical
  quantities.
- **Any unit on the level number.** The scale is the vendor's and unidentified.
  Printing dB would be inventing it.

## Status of the numbers

Both tables are provisional and rest on aggregates, not distributions — the loss
bands in particular come from two band means rather than a measured spread. Debug
mode already writes `rate=` and `err=` on the same sample line, so one commute
yields the actual loss distribution per audio rating and the boundaries get set
from data. Design against the structure; expect the numbers to move once.

## Assumption to confirm

This brief assumes the on-face percentage goes away entirely now that the icon
carries loss. It is currently rendered — a small dim figure under the level, from
commit `ed429de`. If it should stay, say so and it gets a place in the layout
instead of being removed.
