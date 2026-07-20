# Handoff → Claude Design: Preset logo-search window

Companion to the FM Radio Face handoffs (same fork, same design language). This
is a **new surface**: a small window for finding and assigning a station's brand
logo. All backend wiring exists and works; the design only needs to present it.

A **functional placeholder** is implemented — treat it as the requirements, NOT
the look:

- Window: `src/components/carfm/LogoSearchOverlay.tsx` (bare, neutral styling,
  stamped "PLACEHOLDER — pending Claude Design"). Redesign its render output to
  match your handoff. **Preserve the logic** (auto-search, pick-one-of-four,
  Confirm/Cancel, save-as-manual). Do not change behavior.
- Trigger: a placeholder **`LOGO`** button on each preset tile in reorder mode
  (`src/components/carfm/PresetsBand.tsx`). Replace it with your real icon.

## Why this exists

Station logos can't be looked up reliably from any structured source for much of
the US. What *does* work is an image search on `radio <freq> <lowercase-callsign>
logo` — it returned the correct logo as the #1 result for all 7 test-market
stations. So logo assignment is **driver-in-the-loop**: the app runs that search,
shows a few candidates, and the person picks the right one. This window is the
**one and only way** a logo gets assigned. There is no automatic/background logo
fetching (a wrong auto-pick is worse than a clean monogram).

## 1. The trigger icon (you design this)

- Lives on **each preset tile while the presets band is in reorder mode** (the
  same mode that shows the ✕ remove badge and ‹ › move arrows — long-press a
  tile to enter it). One per tile, alongside those controls.
- Tapping it opens the logo-search window **for that preset's station**.
- You own the glyph and its placement among the existing reorder badges. It
  should read as "find/replace this station's logo" (a magnifier-over-image, a
  picture/photo glyph, etc.). Must meet the ≥48dp touch floor (hitSlop is fine).
- The tile itself already shows the current logo (real art if assigned, else a
  colored monogram) via `LogoTile` — the icon is how you *change* it.

## 2. The window — behavior contract (do NOT change; design around it)

Opens as a **modal card over the radio face** (same pattern as the Nearby picker
and Settings pop-up: dim scrim, rounded card). On open it **immediately runs the
search** — no query field, no submit; the query is built from the station.

States to design, in order of appearance:

1. **Loading** — the search is running (one network round-trip). Spinner / skeleton.
2. **Four results** — the first **4** image candidates, shown as a grid (2×2 is
   the natural fit; you decide). Each cell shows the candidate image on its own
   background. **Tap a cell to select it** (single-select; show a clear selected
   state — remember §6 colourblind rules, so selection can't be red/green alone;
   blue border + fill is the house style). Selecting enables Confirm.
3. **No results** — the search returned nothing. Short message + a way out
   (Cancel). A "search again" affordance is welcome but optional.
4. **Error** — the search or the save failed. Short message; let them retry or Cancel.
5. **Saving** — after Confirm, the chosen image downloads. Brief busy state on
   the Confirm button.

**Confirm** (enabled only once a cell is selected): downloads the chosen image,
saves it as this station's **manual logo** (sticky — never overwritten by
anything later), refreshes every tile showing that station, and closes.
**Cancel**: closes, changes nothing.

## 3. Data available to display

Header, per target station: **preset name** (e.g. `WMGN` or `Magic 98`),
**callsign**, **frequency** (MHz), and the exact **query string** that was
searched (`radio 98.1 wmgn logo`) — showing the query helps the driver trust the
results. Per result: a **thumbnail** URL (what to render in the cell), the
full-size **image** URL (saved on Confirm), the source **domain**, and pixel
**width/height** if you want to hint quality.

## 4. Design constraints (same system as the face)

- **Canvas / tokens:** identical to the face handoff — 1024×614 (5:3) head unit
  reference, responsive dp/sp (ANDROID §0: no fixed scale; reflow; ≥48dp targets;
  sp text honoring font-scale), **Atkinson Hyperlegible** (bold = the real
  `AtkinsonHyperlegible-Bold` cut), light "Simple" / dark "Enthusiast" palettes.
- **§6 colourblind rule:** amber = caution/hot, blue = interactive, **never
  red-vs-green** (the user is red/green colourblind). Applies to the selected
  state and any error styling.
- **Driver context:** big touch targets; usable at a stoplight; legible at a glance.
- **Responsive:** the window must work across the same tracks the face uses
  (portrait phone through wide head unit) — a 2×2 grid that fits the narrow track
  without horizontal scroll.

## 5. What's already wired (so you can trust the contract)

- 4-result search: `ddgStationLogoResults(freqMhz, callsign, 4)` and the query
  builder `stationLogoQuery` — `src/services/logoDuckDuckGo.ts`.
- Save-as-manual: `setStationLogoFromUrl(base, url)` — `src/services/stationFinder.ts`.
- Tile refresh after save: `invalidateLogoTile(base)` — `src/components/carfm/LogoTile.tsx`.
- Trigger plumbing: `PresetsBand` `onSearchLogo(index)` → `CarFmFace` opens
  `LogoSearchOverlay` with the target station.

Ship the visual handoff (icon + window) and I'll implement it against this wiring.
