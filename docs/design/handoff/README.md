# Handoff: Android Car Head‑Unit — FM Radio Face

**Bundle v1.10.0 — 2026-07-24.** Version is tracked in `VERSION`; check it matches
your copy before building (stale downloads were the source of earlier drift).

## Overview
The permanent **FM radio "face"** for an Android car head‑unit app. It tunes broadcast FM
via an SDR dongle, decodes RDS, and plays through the car audio. This is the primary screen
the driver sees, so it must be readable **at a glance, in a moving car, in sunlight**. The
package also includes the **Nearby stations** picker (GPS/FCC‑data driven) and a **direct‑entry
numpad**.

The look, layout, and interaction model are settled. What remains for production is real data
wiring (SDR/RDS tuning, GPS + FCC station data) behind the finished UI — see §9. Treat this as
the visual + behavioral spec to build against.

> **Authoritative build spec: `ANDROID-IMPLEMENTATION.md`.** That document is the source of
> truth for **surfaces, layout tracks, responsive behavior, and per-screen structure** written in
> Android terms. This README is a **component-level reference** (exact values, token tables, icon
> anatomy, assets). Where the two differ, follow `ANDROID-IMPLEMENTATION.md`.

> **Build by closing a visual loop, not by copying CSS values.** Read
> **`CORRECTION-LOOP.md`** first: it defines the render → screenshot → diff-against-reference →
> fix-to-the-picture process, and lists every target surface with its reference image in
> `screenshots/`. Then read **`LOSSY-ELEMENTS.md`** — the specific elements (mask fades, CSS
> grid, marquee, SVG icons) that will *not* port by re-typing values, each with the RN/Compose
> strategy that reproduces them. Every surface is "done" only when the built screen matches its
> reference PNG — "compiles" and "values copied" are not done.

## About the Design Files
The files in this bundle are **design references authored in HTML** (a component framework we
use for high‑fidelity prototypes). They are **not production code to copy**. Your task is to
**recreate these designs in the target app's real environment** — for an Android head‑unit that
most likely means **native Android (Jetpack Compose or Views)**, or whatever framework the
existing codebase uses — following its established patterns, theming, and libraries. If no app
scaffold exists yet, pick the most appropriate stack for an automotive Android head‑unit and
implement there.

The `.dc.html` files use a small custom runtime (`support.js`); you do **not** need to port that
runtime. Read the templates for structure/markup and the logic classes for state & behavior,
and reimplement natively.

## Fidelity
**High‑fidelity (hifi).** Colors, typography, spacing, sizing, and interactions are final and
should be reproduced closely. Exact values are listed under **Design Tokens** and per‑component
below.

**The face is responsive across five surfaces, not one fixed canvas.** DUDU OS can split the
head-unit screen into vertical thirds, and the app also runs on a phone (Galaxy S21) in portrait
and landscape. There are **two layout tracks** — **wide** (Dudu7 full / ⅔ slice, S21 landscape)
and **tall** (Dudu7 ⅓ slice, S21 portrait) — selected from the available window size. All five
surfaces are first-class; none may be dropped or treated as a scaled version of another. Build
responsively (Compose `WindowSizeClass` / `BoxWithConstraints`); do **not** author a single
aspect and scale it uniformly. See `ANDROID-IMPLEMENTATION.md` §2 for the surface table and
track-selection rules, and §4 for how each region reflows between tracks.

## Screens / Views

### 1. Radio Face (main) — `RadioFace.dc.html`
**Purpose:** Show the currently tuned station and let the driver tune, seek, recall/reorder
presets, and open Nearby search.

**Layout** (vertical stack; reflows between the **wide** and **tall** tracks — see
`ANDROID-IMPLEMENTATION.md` §4):
1. **Status bar** — left: signal icon (concentric broadcast waves) + dB, STEREO/MONO pill, and a
   tell strip (RDS / HD / TP·TA / AF flags), with PTY/genre; right: **driving-status icons** (GPS
   lock + vehicle-in-motion, **wide/landscape only** — hidden on tall; §4.6) then the settings gear
   button.
   Nearby-search sits here on the **tall** track (in the preset band on the wide track). No FM
   badge. **Wide/landscape:** signal + STEREO + tells + genre share the left cluster (inline).
   **Tall (portrait / ⅓ slice):** the STEREO pill is horizontally **centered**, with the tell
   strip centered beneath it and the genre centered below that; the signal icon keeps its dB
   **stacked below the icon** in the left zone.
2. **Hero band** — the tuned station, centered:
   - **Center hero card:** the station identity + frequency (amber, **no "MHz" label**), with the
     **save star pinned to the top-right corner** and a **power-symbol button in the top-left
     corner** (mirrors the star) that claims/releases audio priority (§4.7). Identity has two forms (see §4.5 for the logo
     model): a **real logo replaces the call sign** (call sign shown small beneath it); with **no
     real logo**, no monogram is drawn here — just the big **4-letter call sign** + frequency. The
     **RadioText strip** sits below the hero (marquee when text > 46 chars). The hero call sign and
     frequency are controlled per station via the logo window options (§6.4 / surface 5) — **both
     default OFF for a station with a logo** (logo-only hero); a no-logo station always shows them.
   - **Prev/Next peek cards** flank the hero: the previous and next presets rendered as smaller,
     ~0.88-scale, ~60%-opacity cards that peek in from the sides and sit slightly behind the hero;
     tapping one steps to that preset. Shown on **both** tracks whenever a prev/next preset exists,
     tucked in tighter on the tall track. On the tall track the hero is also vertically centered in
     the leftover height.
3. **Presets band** — **wide:** **‹** nav button · horizontally scrolling preset rail · **›** nav
   button · **NEARBY** round button (→ **DONE** in reorder mode). **twoRows** (Dudu7 ⅔): a 2-row
   horizontal grid. **tall:** a 3-column vertical grid pinned as a bottom shelf, capped at ~45% of
   screen height, scrolling vertically.

**Key components**
- **Station logo (hero):** a **real logo image** fills a generous share of the card (borderless,
  `ContentScale.Fit`); with no real logo, no tile is drawn on the hero (call sign + frequency only). See §4.5.
- **Call letters:** 66px, 700, `color:text` (italic `dim` when tuning/unknown), `letter-spacing:-1`.
  Shown as the **4 core letters only** — `-FM`/`-AM` + hyphens stripped (e.g. `WWHG-FM` → `WWHG`), everywhere.
- **Frequency:** 60px, 700, `color:amber`, `font-variant-numeric:tabular-nums`, tap opens numpad.
- **Star save button:** 56×56, `border-radius:16`; filled amber star when the freq is saved, else
  outline in `dim`.
- **Power (audio-priority) button:** 52×52, `border-radius:16`, hero top-left, mirrors the star.
  Power-symbol glyph (open ring + top stem). Active = dim outline; **released = solid amber
  (`#FFAE1A`) + white glyph + pulsing ring (~1.8s)**, and the whole face goes grayscale/flat
  except this button. Claims/releases audio priority — not a mute. Full off-state spec in
  `ANDROID-IMPLEMENTATION.md` §4.7.
- **Preset tile:** width **148**, full height; `border-radius:16`, `bg:panel`,
  border `2px solid blue` when active else `1px solid border`. Shows **either** a real logo
  (borderless, transparent, fills the tile — §4.5; **freq + call sign hidden**) **or** a **wide
  colored call-sign box** (landscape aspect matching the logo plate, the **4 call letters inside it**
  on a station-color fill) with the **frequency beneath the box**. Active tile shows a 26×3
  amber bar at bottom. Long‑press enters reorder mode.
- **SEEK controls:** now inside the tap‑to‑tune / numpad window (in `CarFmLive.dc.html`), not on
  the main face. Scan icon = a vertical bar + chevron (down/up variants).
- **Prev/Next peek cards:** stepping to the previous/next preset is driven by the **peek cards**
  flanking the hero — smaller (~0.88 scale, ~60% opacity) cards showing the prev and next presets,
  edge-softened with a fade gradient, peeking in from the sides and sitting slightly behind the
  hero; tap to step. Shown on both tracks (tucked tighter on tall). Build as real sibling
  composables clipped by the screen edges. They use the **same treatment as the preset tiles** (real-logo
  image, or the colored call-sign box + frequency beneath).
- **Custom scrollbar** (under the preset grid): 6px track (`bg:meterEmpty`, `radius:999`), thumb
  `rgba(128,134,144,0.6)`, width = viewport/scrollWidth, left = scroll fraction. **No arrows.**
  Track/thumb are draggable (pointer maps x → scrollLeft). Native scrollbar is hidden.
- **NEARBY button:** round disc (92×92, `border-radius:50%`). Icon is a **magnifying glass with a
  radio tower inside** — see "Nearby icon" tweaks below for its color anatomy.

### 2. Nearby Stations picker (modal) — `NearbyPicker.dc.html`
**Purpose:** List FM stations near the current GPS location (FCC dataset). Tap a row to tune;
**hold (550ms)** to save it as a preset.

**Layout:** design size 900×600, but **responsive** — the card caps to the surface
(`min(design, screen − 32dp)`) and its body scrolls, so it fits the narrow/short surfaces
instead of clipping (never hard-code the pixel size). Header (78px) with title "Nearby stations",
subtitle ("Tap to tune · hold to save a preset · best signal first"), and ✕ close (52×52).
Scrollable list (rows, 10px gap, 16/22px padding). Footer (48px): "FCC data as of &lt;date&gt;".
Also has `nogps` ("Waiting for GPS…") and `empty` states — placeholder scaffolding, not built-out flows.

**Two-level filter:**
- **Bucket row** — `All · Music · Talk` (Music/Talk only appear when the list contains such
  stations), shown **only while All is active**. Selecting **Music** or **Talk** replaces this row
  with the genre row below (no standalone bucket row remains).
- **Genre row** (inside Music/Talk) — genre chips laid out in **exactly two rows**, flowing
  column-by-column and scrolling horizontally on overflow. In this drilled-in state there is **no
  separate bucket row**: an **icon-only back-arrow reset** chip (raised fill, spanning both rows)
  plus a thin vertical **divider** leads the row and returns to All/Music/Talk. Select a genre to
  filter; tap again to clear.

**Row anatomy** (min‑height 92, `bg:raised`, `1px solid border`, `radius:16`, 18px gap;
**compact metrics on a narrow picker** — phone portrait / ⅓ slice, clamped below ~620dp wide —
smaller freq/callsign/gaps/padding so the callsign never wraps). **No logo column** (§4.5):
- **Main info block** (sizes to content on wide, takes the row's slack on narrow): line 1 =
  frequency (32px 700; **no "MHz" label**) + callsign (20px 700) + **service badge only when the
  station has a non‑FM
  service** (small bordered pill; hidden otherwise). Line 2 = "City · Genre" meta (15px `dim`).
- **Saved star:** amber filled star (26×26) shown **only if this station is already a preset**,
  placed **directly to the right of the info block**.
- **Flexible spacer** keeps the trailing block right‑aligned regardless of the star.
- **Trailing block** (right): three‑wave signal icon (amber wave count by strength) + distance
  ("N km", 15px 700 `dim`).
- Chevron "›" (26px `dim`).

### 3. Direct‑entry Numpad (modal) — in `CarFmLive.dc.html`
**Purpose:** Type a frequency directly. ~440px card (responsive: caps to the surface and uses a
**compact variant** — smaller keys/gaps, title hidden — on short surfaces < ~560dp tall),
`bg:panel`. Display row (78px, amber 46px value + "MHz"), a SEEK ‹‹ / SEEK ›› row, 3×4 keypad
(1–9, ".", 0, ⌫ — keys `calc((100% - 24px)/3)` × 64, `bg:raised`), and CANCEL / TUNE actions.
Input capped at 4 digits, one decimal; commit parses and rounds to 0.1, validating the
87.5–108.0 band.

### 4. Settings (modal) — `SettingsPanel.dc.html`
**Purpose:** Tuner source + connection status, appearance (theme), and system options. Design
size ~700×576, **responsive** (caps to the surface, body scrolls). Grouped sections: **TUNER**
(connection status with RETRY when errored + expandable diagnostics; a **Tuner source** radio list
— Auto / RTL-SDR / NWD·NOWADA built-in / FYT·DuduOS built-in, each with a detected / not-detected /
unavailable badge; **Start radio on boot** toggle), **APPEARANCE** (SYSTEM / LIGHT / DARK segmented control),
**SYSTEM** (battery-optimization status with FIX/EXEMPT; station-logos toggle), **ADVANCED**
(Advanced SDR view row). `SettingsPanel.dc.html` is the exact reference; see also
`ANDROID-IMPLEMENTATION.md` §6.3.

### 5. Preset logo search (modal) — `LogoSearchOverlay.dc.html`
**Purpose:** View/replace a station's brand logo and set its hero display options. Opened by the
per‑tile **logo‑search badge** (magnifier‑over‑picture) in reorder mode; the **only** way a logo is
assigned (no auto‑fetch). Design size ~720×560, **responsive** (caps to the surface; the 2×2 grid
fits the narrow track with no horizontal scroll).

- **Opens on a landing view**, not a search:
  - *Has a logo* → the current logo (large) + two option rows **Display Call Sign** and **Display
    Frequency** (both **OFF by default** — logo-only hero) + a **"Search for a different logo"** button.
  - *No logo* → **"No Logo Installed"** + a **"Search for a logo"** button.
- **Display Call Sign / Display Frequency** affect the **hero card only**, saved per station,
  **default OFF** (check either to bring back the small call sign / amber frequency on the hero).
- **Search** (button‑triggered) → **loading** → **results** (four candidates in a 2×2 grid; each cell =
  the candidate art on its own bg + `domain` and `w×h` caption) → **no‑results** / **error** (short
  message + **Search again**) → **saving**.
- **Select** a cell = **blue** 2dp border + fill + check badge (single‑select; never red/green).
  **Confirm** saves the logo + display options and closes; **Cancel** / scrim / ✕ changes nothing.
  Backend (search/save/refresh) is host‑side; `demoState` prop flips the states for review
  (`landing` default). See `ANDROID-IMPLEMENTATION.md` §6.4 and the logo model in §4.5.

## Interactions & Behavior
- **Tune up/down:** ±0.1 MHz, wraps at the 87.5–108.0 band edges.
- **Seek (scan):** steps to the next/previous station in the local station DB. Presented as a
  **fast text sweep** through 0.1‑MHz frequencies (~34ms/step) with a direction arrow; the logo
  tile, star, and RadioText are hidden during the sweep, then it settles on the target.
- **Presets:**
  - Tap → tune to that preset.
  - **Long‑press 550ms** → reorder mode: tiles **wiggle** (`carfm-wiggle`, ±1.1° 0.42s loop) and each
    shows a blue **logo‑search badge** (magnifier‑over‑picture glyph, top‑left) and an ✕ remove badge
    (top‑right); the NEARBY button becomes **DONE**.
  - **Drag to reorder** — one continuous gesture: the long‑press flows straight into a drag with the
    same finger (no lift‑and‑re‑press). The dragged tile lifts (scale 1.06 + shadow) and follows the
    pointer; the wiggle **freezes** on all tiles during the drag; the remaining tiles **slide apart to
    open a real gap** at the insertion slot (transform‑only, ~160ms; geometry locked to slot rects
    captured at drag start so it doesn't oscillate). The order commits **on release**, then tiles
    resolve via a **FLIP** transform (300ms `cubic-bezier(.2,.8,.2,1)`) — the dropped tile slides from
    the finger into its slot. Replaces the old ‹ › arrows.
  - **Logo‑search badge** → opens the **logo‑search window** (`LogoSearchOverlay`, surface 5) for that
    station; the one and only way a logo is assigned (no automatic fetch).
  - **PREV/NEXT** step through presets **in their displayed order** (wrapping), not by frequency.
  - Selecting a preset **auto‑scrolls** the strip to bring the active tile into view (centered).
- **Star:** toggles the current frequency in/out of presets (persisted).
- **Power / audio priority:** hero top-left power button toggles audio priority — `release` hands
  the shared audio bus to another source, `claim` takes it back. When released the face goes
  grayscale + flat and the button pulses amber; the **preset-change hero animation is disabled**
  (instant swaps) while released. Not a mute. See `ANDROID-IMPLEMENTATION.md` §4.7.
- **Nearby picker:** tap row = tune; hold 550ms = save preset. Rows already saved show the amber
  star. "Best signal first" ordering.
- **Numpad:** digit entry with validation; TUNE commits.
- **RadioText:** if text > 46 chars it marquees (`carfm-ticker`, 16s linear loop, doubled spans);
  otherwise static, centered.
- **Scan/tune entry animations:** `carfm-scan-up` / `carfm-scan-down` (14px translate + fade, for
  the swept frequency text).

## State Management
Top‑level (owned by `CarFmLive`):
- `freq` (string, e.g. "88.7") — current tuned frequency; persisted to `localStorage`
  key `carfm-live-v2` as `{freq, presets}`.
- `presets` — ordered array of `{name, freq}`; persisted.
- `reordering` (bool), `numpadOpen` (bool), `pickerOpen` (bool), `npBuf`/`npError` (numpad),
  `scanning`/`scanDir`/`scanDisplay` (seek sweep).
- Derived per render: active/logo metadata for each preset, `saved` flag, `outOfBand`,
  `scroll` (RadioText marquee), and the nearby list annotated with `saved`.

`RadioFace` local state: `canPrev`/`canNext` and custom‑scrollbar `thumbW`/`thumbL`/`showBar`
(computed from grid scroll metrics on scroll/resize/update).

**Data sources to wire in production:** real SDR tuning + RDS decode (station name, RadioText,
stereo, signal dBm) replacing the mock `DB`; GPS + FCC station dataset replacing the mock
`nearby` list. In the prototype these are hard‑coded Madison, WI stations.

## Design Tokens

**Typography:** Atkinson Hyperlegible (400/700 + italic), fallback `system-ui, sans-serif`;
tabular figures for numbers. Palettes: light "Simple" / dark "Enthusiast"; **frequency amber is
fixed and never themed.**

All exact values — the light/dark color tokens, radii, spacing, and shadows — are defined once in
`ANDROID-IMPLEMENTATION.md` **§3 (Design tokens)**, and the nearby-icon colors + anatomy in **§7**.
This README deliberately does not restate them, so the two documents can't drift; read §3/§7 for
the numbers.

## Assets
- **Font:** Atkinson Hyperlegible via Google Fonts. Bundle it in‑app.
- **Icons:** all custom, drawn inline as SVG (signal waves, magnifier/tower, star, chevrons).
  No external icon files. Recreate as vector drawables / SVG.
- **Station brand logos:** **real image assets** (transparent or opaque), assigned via the logo
  window (§6.4) and fitted per surface (§4.5); a colored **call-sign box** (4 call letters on a
  brand-color fill, landscape aspect) is the fallback on preset tiles / peek cards when no real logo
  exists. Three sample logos ship
  under `logos/` (WERN, WWHG, WIBA) exercising square and wide-wordmark aspects.
- No other raster images are required by the design.

## Files (design references in this bundle)
- `CarFmLive.dc.html` — the interactive prototype: owns state, mock SDR/RDS/GPS data, numpad,
  persistence, and mounts the other two. **Best single source for behavior.**
- `RadioFace.dc.html` — the main radio face UI (hero, presets, prev/next peek cards, custom
  scrollbar, drag‑reorder gap‑opening + FLIP animation, nearby icon, logo‑search badge, real-logo fit).
- `NearbyPicker.dc.html` — the Nearby stations modal (list/nogps/empty states).
- `SettingsPanel.dc.html` — the Settings modal (tuner source/status, theme, system, advanced).
- `LogoSearchOverlay.dc.html` — the preset logo‑search modal (landing / loading / results / empty / error / saving).
- `logos/` — sample real logo image assets referenced by the prototype (WERN, WWHG, WIBA).
- `support.js` — prototype runtime only; **do not port** (reference for reading the files if
  needed).

To view the prototype, open `CarFmLive.dc.html` in a browser. The exposed tweak controls are
**aspect** (which surface to preview), **theme** (light/dark), **tuner-error**, **GPS locked**, and
**In motion** (toggle the two driving-status icons, §4.6). Nearby‑icon
colors and seek style are fixed style parameters in the prototype, not user‑facing controls.

## Screenshots
`screenshots/` holds the per-surface reference captures to diff the built app against. **`CORRECTION-LOOP.md`
maps every target surface (head unit, portrait, slices, landscape, light/dark, tuner-error) to its
reference image** — use that as the checklist; the clean full head-unit face is `surface-head-unit-light.png`.

**Overlay states (numpad, nearby picker, settings, reorder, logo search) are not shipped as static screenshots** —
render them live by opening `CarFmLive.dc.html` (tap the frequency for the numpad, the NEARBY disc for
the picker, the gear for settings, long-press a preset for reorder, then the logo‑search badge for the
logo window) and check against `ANDROID-IMPLEMENTATION.md`
§6. `NearbyPicker.dc.html`, `SettingsPanel.dc.html` and `LogoSearchOverlay.dc.html` also open standalone.
