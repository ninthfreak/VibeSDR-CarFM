# Correction loop — match the picture, not the CSS

Every fix so far has been open-loop: read a CSS value, re-type it into a
`StyleSheet`, verify with `tsc` + inspection, ship "not verified on device."
That never converges, because the signal that matters — **what the built screen
actually looks like** — was never in the loop. This document defines the loop
that closes that gap. Do not "fix more style properties." Render, compare, fix
to the image.

## The loop (run it per surface, every round)

1. **Build and render** the RN screen at the target surface size (below).
2. **Screenshot the running app** at that surface.
3. **Put it side by side** with the matching reference PNG in `screenshots/`.
4. **List the visible deltas** — position, size, spacing, weight, color, radius,
   truncation, overflow. Deltas you can *see*, not deltas you can *read in code*.
5. **Fix to the picture.** Change whatever makes the pixels match, even if the
   CSS said something else (web→RN is lossy; see `LOSSY-ELEMENTS.md`).
6. **Re-render and re-diff the same surface.** Only when it matches move on.
7. A surface is done when the screenshot matches the reference. "Compiles" and
   "values copied" are not done.

If you have not produced a side-by-side image this round, you have not closed
the loop — regardless of how many properties you changed.

## Target surfaces and their reference images

The design has **two layout tracks** chosen by aspect ratio (`w/h < 1` → tall):

| Reference PNG (`screenshots/`)      | Surface / aspect        | px (design) | track     |
|-------------------------------------|-------------------------|-------------|-----------|
| `surface-head-unit-light.png`       | Dudu7 full (head unit)  | 1024 × 614  | wide      |
| `surface-head-unit-dark.png`        | Dudu7 full, dark theme  | 1024 × 614  | wide      |
| `surface-landscape-light.png`       | Galaxy S landscape      | 1080 × 486  | wide      |
| `surface-portrait-light.png`        | Galaxy S portrait       | 486 × 1080  | tall      |
| `surface-portrait-dark.png`         | Galaxy S portrait, dark | 486 × 1080  | tall      |
| `surface-slice-two-thirds.png`      | Dudu7 ⅔ slice           | 900 × 810   | wide*     |
| `surface-slice-one-third.png`       | Dudu7 ⅓ slice           | 470 × 845   | tall      |
| `surface-tuner-error.png`           | Full, tuner-error state | 1024 × 614  | wide      |

**Overlay states are not shipped as screenshots** (numpad, nearby picker, settings,
reorder). Render them live from `CarFmLive.dc.html` (they open over the face) and
check against ANDROID §6; `NearbyPicker.dc.html` and `SettingsPanel.dc.html` open
standalone too.

\* ⅔ slice is a wide track with a **two-row** preset grid (`twoRows` flag).

### px vs dp — match proportion, not the number

The reference px are the *design canvas*. On device you work in dp/sp. A phone
you'd call "360 × 800 dp" portrait has the same ~0.45 aspect as the 486 × 1080
design canvas, so it uses the **same tall track** — match the proportions and
relative sizing you see in `surface-portrait-*`, not the literal pixel counts.
Pick the reference whose aspect ratio matches your device surface and diff
against that.

**These PNGs are per-surface proportional targets, NOT a master canvas to scale
to fit.** Do not lay the face out once at a reference size and `Modifier.scale()`
it — that's banned (ANDROID §0). A screenshot that matches only because you zoomed
a frozen canvas has *failed* this loop even though the pixels line up: font-scale
is dead, touch targets shrank below 48dp, and nothing reflowed. Match each surface
with a real dp/sp layout that reflows, then diff its screenshot against the
reference at that surface.

## What to diff, in priority order

1. **Track correctness** — did the right track render? Tall must stack the hero
   with the preset grid as a bottom shelf below (peek cards stay tucked tight on
   each side of the hero); wide keeps the hero row horizontal. On the **tall**
   status bar the STEREO pill is centered with the tell strip and genre centered
   beneath it, and the signal dB is stacked below the signal icon — wide keeps all
   of these inline in the left cluster. A wrong track is a structural miss, fix it
   before anything cosmetic.
2. **Overall composition** — is each zone (status row, hero, RadioText strip,
   preset carousel) in the right place and proportion?
3. **The hero** — station logo tile, callsign, big amber frequency (no "MHz"
   label), save star. Amber (`#C9760A` light / `#FFB833` dark) is fixed and never themed.
4. **Preset carousel** — active card highlight, peek cards on both sides with
   their fade (see `LOSSY-ELEMENTS.md`).
5. **Overlays** — nearby picker (collapsed bucket row + two-row genres), numpad,
   settings, reorder — render each live from `CarFmLive.dc.html` and check against
   ANDROID §6 (no shipped screenshot for these states).
6. **Cosmetics last** — radii, shadows, exact spacing, weights.

## Dark theme

Diff `surface-head-unit-dark.png` and `surface-portrait-dark.png` separately —
dark is a first-class theme, not an inversion. Tokens are in `RadioFace`
`renderVals()` (`light`/`dark` objects). Amber frequency is the same intent in
both but uses a brighter value in dark.

## Common self-deceptions to avoid

- "Values match the spec" — the spec is web; matching it can still look wrong.
- "It compiles / `tsc` passes" — says nothing about pixels.
- "Fixed on full screen" — the bug may only show in tall/slice; diff all surfaces.
- **"It matches the reference pixel-for-pixel"** — check *how*. If you scaled one
  fixed canvas to fit, the match is fake: font-scale is off, targets are sub-48dp,
  and nothing reflowed (§0). A real layout matches proportionally, not by zoom.
- Declaring done without a fresh screenshot from *this* round.
