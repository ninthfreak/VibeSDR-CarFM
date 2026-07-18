# Handoff: Android Car Head‑Unit — FM Radio Face (Alpha)

## Overview
The permanent **FM radio "face"** for an Android car head‑unit app. It tunes broadcast FM
via an SDR dongle, decodes RDS, and plays through the car audio. This is the primary screen
the driver sees, so it must be readable **at a glance, in a moving car, in sunlight**. The
package also includes the **Nearby stations** picker (GPS/FCC‑data driven) and a **direct‑entry
numpad**.

This is an **Alpha** design: the look, layout, and interaction model are settled, but more
work remains (real SDR/RDS/GPS backends, error/edge states, additional settings). Treat it as
the visual + behavioral spec to build against, not a finished feature set.

> **Authoritative build spec: `ANDROID-IMPLEMENTATION.md`.** That document is the source of
> truth for **surfaces, layout tracks, responsive behavior, and per-screen structure** written in
> Android terms. This README is a **component-level reference** (exact values, token tables, icon
> anatomy, assets). Where the two differ, follow `ANDROID-IMPLEMENTATION.md` — it reflects the
> current design; older phrasing in this README has been corrected inline below.

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
   tell strip (RDS / HD / TP·TA / AF flags); right: settings gear button. Nearby-search sits here
   on the **tall** track (in the preset band on the wide track). No FM badge. Wraps to a second
   line on the tall track.
2. **Hero band** — the tuned station, centered:
   - **Center hero card:** station logo tile + call letters + star save button, then frequency
     (amber) + "MHz". The **RadioText strip** sits below the hero (marquee when text > 46 chars).
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
- **Station logo tile:** 92×92, `border-radius:20` (or 46 if circle), station brand bg/fg, 34px 700.
- **Call letters:** 66px, 700, `color:text` (italic `dim` when tuning/unknown), `letter-spacing:-1`.
- **Frequency:** 60px, 700, `color:amber`, `font-variant-numeric:tabular-nums`, tap opens numpad.
- **Star save button:** 56×56, `border-radius:16`; filled amber star when the freq is saved, else
  outline in `dim`.
- **Preset tile:** width **148**, full height; `border-radius:16`, `bg:panel`,
  border `2px solid blue` when active else `1px solid border`. Contents: brand logo (58×58,
  `radius:15`) + **full call sign** (18px 700, centered, wraps — **no frequency shown**). Active
  tile shows a 26×3 amber bar at bottom. Long‑press enters reorder mode.
- **SEEK controls:** now inside the tap‑to‑tune / numpad window (in `CarFmLive.dc.html`), not on
  the main face. Scan icon = a vertical bar + chevron (down/up variants).
- **Prev/Next peek cards:** stepping to the previous/next preset is driven by the **peek cards**
  flanking the hero — smaller (~0.88 scale, ~60% opacity) cards showing the prev and next presets,
  edge-softened with a fade gradient, peeking in from the sides and sitting slightly behind the
  hero; tap to step. Shown on both tracks (tucked tighter on tall). Build as real sibling
  composables clipped by the screen edges.
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

**Row anatomy** (min‑height 92, `bg:raised`, `1px solid border`, `radius:16`, 18px gap):
- Brand logo (60×60).
- **Main info block** (sizes to content, not stretched): line 1 = frequency (32px 700) + "MHz"
  (15px `dim`) + callsign (20px 700) + **service badge only when the station has a non‑FM
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
— Auto / RTL-SDR / Si470x FM dongle / rtl_tcp, each with a detected/not-detected/unavailable
badge; **Start radio on boot** toggle), **APPEARANCE** (SYSTEM / LIGHT / DARK segmented control),
**SYSTEM** (battery-optimization status with FIX/EXEMPT; station-logos toggle), **ADVANCED**
(Advanced SDR view row). See `ANDROID-IMPLEMENTATION.md` §6.3 and `uploads/settingspanelhandoff.md`
for the tuner-backend detail.

## Interactions & Behavior
- **Tune up/down:** ±0.1 MHz, wraps at the 87.5–108.0 band edges.
- **Seek (scan):** steps to the next/previous station in the local station DB. Presented as a
  **fast text sweep** through 0.1‑MHz frequencies (~34ms/step) with a direction arrow; the logo
  tile, star, and RadioText are hidden during the sweep, then it settles on the target.
- **Presets:**
  - Tap → tune to that preset.
  - **Long‑press 550ms** → reorder mode: tiles **wiggle** (`carfm-wiggle`, ±1.1° 0.42s loop), show
    ‹ ›  move controls and a ✕ remove badge; the NEARBY button becomes **DONE**.
  - Moving a tile animates all tiles to their new position via a **FLIP** transform
    (300ms `cubic-bezier(.2,.8,.2,1)`), composited with the wiggle.
  - **PREV/NEXT** step through presets **in their displayed order** (wrapping), not by frequency.
  - Selecting a preset **auto‑scrolls** the strip to bring the active tile into view (centered).
- **Star:** toggles the current frequency in/out of presets (persisted).
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

**Typography:** Atkinson Hyperlegible (400/700, + 400 italic), fallback `system-ui, sans-serif`.
Numeric fields use `font-variant-numeric: tabular-nums`.

**Colors — Light**
| token | value |
|---|---|
| bg | `#EEF1F5` |
| panel | `#FFFFFF` |
| raised | `#F5F7FA` |
| text | `#1B222C` |
| dim | `#67717F` |
| amber (accent/freq) | `#C9760A` (radio face) / `#2E86FF` interactive blue |
| blue (interactive) | `#2E86FF` |
| border | `rgba(20,30,45,0.13)` |
| blueFill | `rgba(46,134,255,0.12)` |
| page backdrop | `#DCE0E6` |

**Colors — Dark**
| token | value |
|---|---|
| bg | `#161E29` |
| panel | `#212B38` |
| raised | `#2A3644` |
| text | `#E9EEF4` |
| dim | `#8B97A7` |
| amber | `#FFB833` |
| blue | `#4A9EFF` |
| border | `rgba(255,255,255,0.13)` |
| blueFill | `rgba(74,158,255,0.18)` |
| page backdrop | `#0C1218` |

**Radii:** tiles 16, logo 15/20 (46 = circle), buttons 14–18, pills 999, disc 50%.
**Spacing:** page padding 18/24; hero gap 20; general gaps 8–12.
**Shadows:** stage `0 24px 70px rgba(0,0,0,0.4)`; modals `0 20px 50px rgba(0,0,0,0.35)`.
**Signal icon:** three concentric broadcast waves; amber wave count encodes strength (0–4).

### Nearby icon (magnifier + radio tower) — tweakable
The NEARBY disc icon is a thin‑line magnifying glass (large lens, ~5 o'clock stubby butt‑capped
handle) containing a radio tower (A‑frame legs + a single X‑brace low in the body + antenna mast
with radiating waves). A subtle barrel warp bows the tower slightly (lens refraction). It exposes
per‑theme color controls; build them as themeable style props:
- **Line color** (strokes, lens ring, handle) — light default `#111111`, dark `#E9EEF4`.
- **Icon fill** (disc / negative space) — light default = interactive blue; dark `#212B38`.
- **Glass fill** (lens interior tint) — light `rgba(255,255,255,0.16)`; dark `#2A3644`.
- **Border** on/off + **border color** (independent) — light default `#111111`
  (incl. a light‑gray `#D5DAE1` option); dark `#3A4655`.

## Assets
- **Font:** Atkinson Hyperlegible via Google Fonts. Bundle it in‑app.
- **Icons:** all custom, drawn inline as SVG (signal waves, magnifier/tower, star, chevrons).
  No external icon files. Recreate as vector drawables / SVG.
- **Station brand logos:** represented as colored monogram tiles (text on brand bg), not image
  assets — real brand art would replace these later.
- No raster images are required by the design.

## Files (design references in this bundle)
- `CarFmLive.dc.html` — the interactive prototype: owns state, mock SDR/RDS/GPS data, numpad,
  persistence, and mounts the other two. **Best single source for behavior.**
- `RadioFace.dc.html` — the main radio face UI (hero, presets, seek/prev/next, custom scrollbar,
  reorder + FLIP animation, nearby icon).
- `NearbyPicker.dc.html` — the Nearby stations modal (list/nogps/empty states).
- `SettingsPanel.dc.html` — the Settings modal (tuner source/status, theme, system, advanced).
- `support.js` — prototype runtime only; **do not port** (reference for reading the files if
  needed).

To view the prototype, open `CarFmLive.dc.html` in a browser. Tweak controls (theme, seek style,
nearby‑icon colors) are exposed as component props.

## Screenshots
See `screenshots/` for reference captures of the built prototype (light theme, 1024×614 / 5:3):
- `01-radio-face-light.png` — main radio face (tuned station, presets, seek/prev/next, custom scrollbar, NEARBY icon).
- `02-nearby-picker.png` — Nearby stations modal (saved‑preset stars, signal + distance, right‑aligned).
- `03-numpad.png` — direct frequency entry.
- `04-reorder-mode.png` — preset reorder mode (move ‹ ›, remove ✕, DONE button).
