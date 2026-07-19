# Lossy web→RN translation — the elements that will NOT port by copying values

Most of this design is flexbox + solid fills + radii and ports cleanly. The
drift comes from a **small, specific set** of elements that use CSS features RN
doesn't have (mask, CSS grid, gradients, SVG-in-string, marquee, `::-webkit`).
Re-typing their CSS values will always approximate. For each one below: what it
is, why it's lossy, and the RN strategy that actually reproduces it. Fix these
against the reference images, not against the source values.

Source anchors are `RadioFace.dc.html` / `NearbyPicker.dc.html` line numbers at
time of writing — search the nearby code if they've shifted.

---

## 1. Preset peek-card fade (carousel side cards)
**Where:** `RadioFace` ~L532–533 `prevCardStyle` / `nextCardStyle`.
**CSS:** `mask-image: linear-gradient(to right/left, #000 55%, rgba(0,0,0,0.1) 100%)`
plus a negative margin that tucks the peek card under the active card.
**Why lossy:** RN has no `maskImage`. Copying the gradient does nothing.
**RN strategy:** overlay a `LinearGradient` (react-native-linear-gradient or
expo-linear-gradient) from the container background color → transparent on the
peek card's outer edge, matching the 55%→100% falloff. The peek card must sit
*under* the active card by the same negative offset (−72 wide / −46 tall). Diff
the fade edge against `surface-head-unit-light.png` and `01-radio-face-light.png`.

## 2. Nearby / magnifier icon (SVG built in JS)
**Where:** `RadioFace` ~L458–496 `magBase` / `lensTower` / `nearbyIcon`
(a `React.createElement('svg', …)` — lens circle + glaze fill + radio tower +
broadcast waves + handle). This is the **approved** look; keep it exactly.
**Why lossy:** it's an inline SVG assembled in code; there is no CSS to copy, and
RN can't render an HTML `<svg>`.
**RN strategy:** rebuild with `react-native-svg` (`Svg`, `Circle`, `Path`,
`Line`) using the same coordinates (viewBox `0 0 32 32`, lens `cx14.8 cy14.3
r12`, handle `x1 21.3 y1 25.6 → x2 24.5 y2 31.1`), OR rasterize the rendered icon
to a PNG asset at 1×/2×/3×. Colors are themed via `nearbyLine` / `nearbyGlass`.
Diff against the disc in the status row (portrait) and preset band (wide).

## 3. Preset grid — CSS Grid in three modes
**Where:** `RadioFace` ~L699–703 `presetGridStyle`.
- tall: `grid-template-columns: repeat(3, 1fr)`, vertical scroll.
- ⅔ slice (`twoRows`): `grid-template-rows: repeat(2, auto)`,
  `grid-auto-flow: column`, `grid-auto-columns: 150px`, horizontal scroll.
- wide: horizontal flex row, horizontal scroll.
**Why lossy:** RN has no CSS grid. Naively porting drops the 3-up wrap and the
two-row horizontal flow, collapsing everything to one row.
**RN strategy:**
- tall → `FlatList`/`View` with `flexWrap: 'wrap'`, three columns via fixed item
  width `(W - 2*gap)/3`.
- ⅔ slice two-row → horizontal `ScrollView` whose content is a `flexWrap:'wrap'`
  column-flow of fixed 150-wide items pinned to 2 rows (or two stacked
  horizontal rows fed alternating items).
- wide → horizontal `ScrollView` row.
Diff each against `surface-portrait-light` (3-up), `surface-slice-two-thirds`
(two rows), `surface-head-unit-light` (single row).

## 4. Nearby picker genre sub-bar — two-row grid
**Where:** `NearbyPicker` ~L230 `subBarStyle`:
`grid-template-rows: repeat(2, auto)`, `grid-auto-flow: column`,
`grid-auto-columns: max-content`, horizontal scroll.
**Why lossy:** same CSS-grid gap as above; genres must lay out in **two rows**
that scroll horizontally, not one long row.
**RN strategy:** horizontal `ScrollView` with a two-row wrapped content view
(fixed row height, `flexWrap`), chips sized to content. Remember the bucket row
(All/Music/Talk) **collapses to nothing** once a genre bucket is selected, and a
back-arrow + divider restores it. Diff against `02-nearby-picker.png`.

## 5. RadioText marquee
**Where:** `RadioFace` ~L672 `rtMarqueeStyle`:
`animation: carfm-ticker 16s linear infinite` (keyframe translateX 0 → −50%,
content duplicated for a seamless loop).
**Why lossy:** RN has no CSS keyframes.
**RN strategy:** `Animated.loop` on a translateX from 0 to −contentWidth/2 over
16s linear, with the text duplicated. Only scrolls when text overflows
(`scroll` flag / `rtText.length > 46`); otherwise centered and static.

## 6. Other keyframe animations
**Where:** `RadioFace` ~L15–19: `carfm-wiggle` (reorder tiles),
`carfm-scan-up`/`carfm-scan-down` (seek digit slide), `carfm-ta-pulse` (TA chip).
**RN strategy:** `Animated`/Reanimated equivalents. Low visual priority but the
TA pulse and reorder wiggle are noticeable — match feel, not exact easing.

## 7. Text shadows on tell-tale chips
**Where:** `RadioFace` ~L608–609: `textShadow: '0 1px 2px rgba(0,0,0,0.30)'` on
RDS/TP/TA/AF labels.
**RN strategy:** `textShadowColor` / `textShadowOffset` / `textShadowRadius` on
the `Text`. Minor, but skipping it flattens the chips vs. the reference.

## 8. Scrollbars / scroll affordance
**Where:** `RadioFace` ~L20 `[data-preset-grid]::-webkit-scrollbar{display:none}`
and the custom `scrollBarTrackStyle` (~L704).
**RN strategy:** `showsHorizontalScrollIndicator={false}` etc.; if the design's
custom thin track is shown, rebuild it as a small `View` indicator. Low priority.

## 9. Hero carousel prev/next swap (THE preset-change animation) ⚠ not yet built
**Where:** `RadioFace` `snapHero()` + `componentDidUpdate()` (~L200–277) and
`navPrev`/`navNext` (~L216–217). ANDROID §8 describes the feel; this is the exact
procedure. **This is the animation currently missing from the Android build** —
tapping a peek card / next-preset just hard-cuts the hero. It must morph.

**What it is:** three cards are on screen — `prev` peek (left, tucked under hero),
`hero` (center), `next` peek (right). Tuning to the adjacent preset shifts the whole
strip one slot with a real position+size morph (FLIP), not a slide or crossfade.

**Why lossy:** it's a hand-rolled FLIP driven by `getBoundingClientRect()` +
`element.animate()` keyframes captured across a React re-render. No CSS to copy;
RN needs `onLayout` bounds + `Animated`/Reanimated shared transitions.

**Direction semantics** (`dir = +1` for NEXT, `-1` for PREV; mirror everything):
NEXT → the whole strip travels LEFT. Current hero shrinks + slides into the **left
(prev)** slot; the **right (next)** peek grows + slides into center; the far **left**
card fades out; a brand-new **right** card fades in. PREV is the mirror image.

**Exact procedure — do NOT approximate this:**
1. **Before** state changes (in the tap handler), capture the resting bounds of all
   three slots (`prevRect`, `centerRect`, `nextRect`) and the stage scale factor
   `sf`. Snapshot the far card that will leave as an absolutely-positioned overlay
   (`fadeClone`) so it can fade in place after the data moves on. THEN fire the tune.
2. Let the data update: the three slots now hold the new prev/hero/next content in
   their **natural resting positions** (this is the FLIP "last").
3. Immediately run four animations, **duration 520ms**:
   - **New center** (was the source peek): morph FROM the source-slot rect TO the
     center rect — grows and slides inward. Source slot = `next` for NEXT, `prev` for PREV.
   - **Old hero** (now in the landing peek slot): morph FROM `centerRect` TO the
     landing-slot rect — shrinks and slides outward. Landing = `prev` for NEXT, `next` for PREV.
   - **fadeClone** (card leaving the far edge): opacity 0.6 → 0, then remove.
   - **New far card** (freshly appeared in the source slot): opacity 0 → 0.6, **delayed 120ms**.
4. **Two easings, applied per-frame (they are NOT the same curve):**
   - translation → ease-out cubic `1 - (1-p)^3`
   - scale → ease-out quint `1 - (1-p)^5` (size settles slightly *ahead* of position,
     so a card reaches its final size just before it lands).
5. **Resolve to the resting transform, never identity.** Peek cards sit at **base
   scale 0.88** at rest; the morph must end at 0.88 (× the FLIP scale ratio), or the
   card visibly pops to full size on the last frame. Bake the 0.88 base into both the
   start and end of each keyframe track.

**RN strategy:** measure the three card slots with `onLayout` (keep last-known
bounds in refs). On tune, run a FLIP: compute delta bounds old→new, drive
`translateX/translateY` + `scale` with two `Animated.timing`s (or one Reanimated
`withTiming` per property) using the cubic/quint easings above over 520ms; animate
the leaving clone's and entering card's `opacity` (0.6↔0, entering delayed 120ms).
Reanimated shared-element / layout transitions (`entering`/`exiting` + `Layout`) can
express this if you pin the peek base scale. **Diff the mid-transition** against a
screen recording of `CarFmLive.dc.html` — a single still won't catch a pop or a
wrong direction. Both layout tracks (wide and tall) animate; the peek cards flank
the hero on both, so the swap runs on both.

---

## Elements that DO port by copying values (don't over-engineer these)
Solid background fills, `borderRadius`, `borderWidth`/`borderColor`, flex row/
column + `gap` (RN 0.71+ supports `gap`), `padding`/`margin`, font size/weight,
`letterSpacing`, `opacity`, box shadows (→ `elevation` / `shadow*` — approximate
is fine), `tabular-nums` (→ `fontVariant:['tabular-nums']`). Match these from the
spec; spend the loop budget on items 1–7 above.
