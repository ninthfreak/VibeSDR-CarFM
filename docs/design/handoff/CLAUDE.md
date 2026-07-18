# Android car FM radio face — project notes

## Known issues / next handoff
- **Nearby-search magnifier icon**: the version in `RadioFace.dc.html` (the `lensTower`/`nearbyIcon` — magnifier lens with a radio tower + broadcast waves inside) is the approved look. When regenerating the design handoff, the radio tower inside the lens got mangled — the handoff copy needs to be fixed to match `RadioFace.dc.html` exactly.

## Design language
- DUDU OS light-first. Simple (light) is default; Enthusiast (dark) is a first-class alternate via the `theme` tweak.
- Interactive blue = system accent (DUDU blue fallback); frequency amber is fixed for safety and never themed.

## Layout / aspect ratios (CarFmLive `aspect` tweak)
- Dudu7 full (default), Dudu7 ⅔ slice, Dudu7 ⅓ slice, Galaxy S landscape, Galaxy S portrait.
- `RadioFace` fills its stage 100%×100%. It has two layout tracks chosen by aspect ratio (`tall` prop, true when w/h < 1): wide (landscape/near-square) and tall (portrait / ⅓ vertical slice) where the hero stacks and PREV/NEXT preset buttons wrap below.
- DuduOS can split the head-unit screen into vertical thirds, so ⅓ and ⅔ slices must stay supported alongside full screen.
