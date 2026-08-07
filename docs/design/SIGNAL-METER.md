# Signal meter — as built

Design description for `signal-icon-handoff.md`. Everything below is implemented and
measured in the mock-up unless a section says otherwise.

## Scope

The NWD path. The RTL-SDR path shares the same cluster and geometry but appends its
unit to the number; nothing else differs.

## Geometry

One SVG, `viewBox="0 0 58 32"`, centre at (29,16).

- **Dot** — filled circle, r 2.6, at the centre. Never dotted, never omitted. Below the
  first threshold it is not dark: see the sub-floor ramp under *Strength*.
- **Four arc pairs**, elliptical, `fill="none"`, `stroke-width="2.2"`,
  `stroke-linecap="round"`. Left arc of each pair uses sweep 0, right uses sweep 1.

  | pair | rx | ry | x (L / R) | y span |
  | ---- | ---- | ----- | ----------- | -------- |
  | 1 | 6.5 | 5.5 | 23.8 / 34.2 | 11.6 → 20.4 |
  | 2 | 11.31 | 9.57 | 19.25 / 38.75 | 8.3 → 23.7 |
  | 3 | 16.25 | 13.75 | 14.7 / 43.3 | 5 → 27 |
  | 4 | 21.19 | 17.93 | 10.15 / 47.85 | 1.7 → 30.3 |

The arcs are **elliptical, not circular** — rx is 1.3× and ry 1.1× the radii of the
older circular glyph. This was done in the path data rather than by scaling the SVG
box, because a non-uniform transform would thin the horizontal strokes and thicken
the vertical ones and break the even 2.2 weight. Every edge including the round caps
falls inside the viewBox (extremes: x 0.64, y 0.6 / 31.4), so nothing clips and the
glyph is symmetric — the flattened left tip described in your brief is not needed,
that asymmetry came from the old off-centre 34×24 box and is gone.

Rendered **54.6 × 30.25** on the wide tracks, **74.75 × 41.25** on the tall tracks
(⅓ slice, portrait). Default `preserveAspectRatio`, so the scale is uniform.

## Colour

Every element always renders. Unlit ones use the off token, so the zero state is the
full glyph gone dim rather than a vanishing icon.

| | light | dark |
| --- | --- | --- |
| lit | `#C9760A` | `#FFB833` |
| unlit | `rgba(20,30,45,0.10)` | `rgba(255,255,255,0.10)` |

## Strength → elements lit

Thresholds are **31 / 48 / 60 / 70 / 85**. They are deliberately not evenly spread:
two of the five steps fall in the 48–70 zone, where stereo lock and multipath actually
change. An even spread spends steps on high levels that all sound the same.

31 is the vendor's `LEVEL_LOC_FLOOR`, the local-seek floor — which is what makes the
bottom edge meaningful rather than an arbitrary cutoff.

Two mechanisms give the five-element glyph more resolution than five states, neither
of which adds a sixth wave.

**Half-step opacity.** Once the level passes the midpoint of the band it is in, the
next ring up lights at **45% opacity** in the lit colour. Five states become nine.

**Sub-floor dot ramp.** Below 31 the dot is not dark. It eases up by
`0.25 + 0.6 × √f`, where *f* is the fraction of the way from 0 to 31 — about **36%**
at level 1, rising to **85%** just under the threshold. (The 0.25 floor in the formula
is only reached at level 0, where nothing draws at all.) Levels the glyph used to
render identically — 12 vs 30 — are now told apart.

| level | lit |
| ------- | ------------------------ |
| 0 | nothing |
| 1–30 | dot, ~36% → 85% |
| 31–39 | dot |
| 40–47 | dot + pair 1 @ 45% |
| 48–53 | + pair 1 |
| 54–59 | + pair 2 @ 45% |
| 60–64 | + pair 2 |
| 65–69 | + pair 3 @ 45% |
| 70–77 | + pair 3 |
| 78–84 | + pair 4 @ 45% |
| 85+ | + pair 4 |

The RTL-SDR path has no unitless level and takes none of this: it derives its state
from the segment count and renders the five discrete steps only.

## The level number

Sits **inside the glyph**, in the column below the dot — every arc bows outward
toward the flanks and none crosses the vertical centreline, so that column is clear
ink-free space.

- 15px wide track, 19px tall track, weight 700, `font-variant-numeric: tabular-nums`,
  `line-height: 1`, colour `t.dim`.
- Absolutely positioned, centred, `top` 23 (wide) / 32.1 (tall) from the icon's top
  edge. The top of the digits sits at what was their vertical mid-point when the
  baseline rested on the outermost wave; the baseline now clears that wave by about
  5px, so the number hangs slightly below the glyph.
- **No unit** on the NWD path. The SDR path appends ` dB` inline.
- **Glow:** four stacked `text-shadow` rings in the theme background colour at
  2/3/4/6px. It separates the digits from any arc ink behind them. Note this is
  perceptual only — `text-shadow` does not count toward contrast.
- Powered off: an em-dash, nothing lit. The old `--` token is gone.

**Nothing reflows.** The icon is a fixed width and the number is an absolutely
positioned, centred overlay, so digit-count changes (2 → 3 digits) move nothing in
the cluster or anything to its right.

## Dotting — built

Loss is a 0–100 percentage on the `signalLoss` prop. It dots lit arcs to say the
reading is degraded, without changing how many are lit.

- **Dasharray `0 4.8`** with the round linecap — zero-length dashes render as round
  dots. 4.8 is a floor, not a preference: at shipping size the stroke renders 2.02px
  wide and the originally specified 3.4-unit gap leaves only **1.1px** between dots,
  closer together than they are wide, so the arc reads solid and the icon silently
  under-reports loss. 4.8 gives 2.38px and reads clearly dotted.
- **Nothing dots below 30%.** Under that the reading counts as clean. This is a hard
  floor, not a rounding artefact.
- **Dots spread from the leading arc inward.** The leading arc is the half-step ring
  when one is lit, otherwise the outermost fully-lit pair. At exactly 30% only that
  arc dots; 30 → 100% spreads dots inward across the remaining pairs by
  `max(1, round((loss − 30) / 70 × dottable))`. The count is anchored at 1 so the
  control is never dead — but anchoring gives it *presence*, not *resolution*. With
  only one arc drawn, every loss from 30 to 100 renders identically; resolution needs
  two or more drawn arcs. The 102.1 demo station is exactly this case.
- **The dot never dots.** It is a filled circle, not a stroke.
- **Dotted amber against off-grey is safe** — dotting thins amber without shifting its
  hue, so the two differ in colour, not just density. This was the first thing tested
  and it is not the risk.

Open on both sides: a clamp so the innermost pair always stays solid (recommended
earlier, not implemented — at 100% every drawn pair dots); the deadband for the
1.5s-loss / 30s-level cadence mismatch; and a treatment for scanning and the 5s
post-tune window.

**The prototype has no loss source.** `signalLoss` is fed demo values from
`CarFmLive` — 45 on 88.7 and 80 on 102.1, zero everywhere else — purely so the
treatment can be reviewed. Nothing in the tuner path reports loss today.

## Contrast — three measured failures

All three are palette decisions, so none has been changed.

- **Light theme, lit amber vs unlit grey: 2.51:1**, under the 3:1 floor for non-text
  graphics. This is the lit/unlit discrimination itself, in the shipping default
  theme. Dark is fine at 7.19:1. Lit amber against the header is 3.05:1, barely over.
- **The level number: 4.37:1** against a 4.5:1 requirement. 15px bold is not large
  text — that threshold is 18.66px for bold — so the small-text floor applies and the
  number is marginally under it. The levers are the level moving to `t.text`, or a
  darker `t.dim`.
- **The half-step ring at 45% opacity: 1.69:1 light, 2.83:1 dark.** Blended, that is
  `#C9760A` @ 0.45 over `#FFFFFF` → `rgb(231,193,145)`, and `#FFB833` @ 0.45 over
  `#212B38` → `rgb(133,107,54)`. Both are under the 3:1 floor and the light figure is
  materially worse than the lit/unlit failure above.

**The third failure compounds with dotting, and this is the sharper problem.** Dots
spread from the leading arc inward, and the leading arc *is* the half-step ring
whenever one is lit — so the first element to carry the loss signal is the least
visible thing on the glyph: 2.07px dots at 45% opacity, read at arm's length in a
car. The justification for the 4.8 gap is that a too-tight dasharray makes the icon
silently under-report loss; dotting the 45% ring reintroduces that failure by a
different route.

Two levers, neither applied: raise the half-step opacity (0.45 was chosen to read as
half, not for contrast), or make the half-step ring **not** dottable so loss always
starts on a fully-lit arc.
