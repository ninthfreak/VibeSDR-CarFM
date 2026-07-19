# DUDU OS FM Radio — Android implementation spec

*Bundle v1.5.0 — 2026-07-19 (see `VERSION`).*

A complete build spec for the DUDU OS FM radio front-end on Android (Jetpack
Compose primary; View/XML notes where helpful). It describes **intent, structure,
tokens, and behavior** so the app can be built natively — not by translating web
CSS. Every measurement is a **starting value in dp/sp** to confirm on device.

The HTML prototype is the reference for exact values when this document is silent:
`RadioFace` (main face), `CarFmLive` (state host + surface framing),
`NearbyPicker`, `SettingsPanel`. Treat those as visual/behavioral truth; treat
this document as the plan for expressing them in Android idioms.

---

## 0. Non-negotiable: build a real responsive layout, NOT scale-to-fit

**Do not lay the face out at one fixed design-canvas size and `Modifier.scale()` /
`transform: scale()` the whole thing to fit the screen. That approach is banned.**
It looks faithful only at the exact reference resolutions and fails everywhere
else, and it breaks three things this product must have:

- **Font-scale** — a uniformly-scaled block can't let text grow with the OS
  setting; `allowFontScaling={false}` (RN) or fixed `.sp`→`.dp` freezing is a
  direct violation. Type must size in `sp` and respond to system font-scale.
- **Touch targets** — scaling the canvas down shrinks buttons below the **48dp**
  floor. Targets are specified in real dp and must stay ≥48dp at every surface.
- **Reflow** — the design has **two layout tracks** and sub-modes precisely so it
  *rearranges* per surface. Uniform zoom never reflows; it just shrinks one frozen
  picture.

Build it the Android way: real `dp`/`sp`, Compose layouts (`Row`/`Column`/`Box`/
`LazyGrid`) that reflow, track chosen from `WindowSizeClass` (§2). The reference
screenshots are **per-surface proportional targets** (match the composition and
relative sizing at each surface's own density) — **not a master canvas to zoom to
fit.** If your output is pixel-identical to a reference only because you scaled a
fixed canvas, you built the wrong thing.

---

## 1. What this is

A head-unit / phone FM radio front-end for DUDU OS: one primary screen (the
**radio face**) plus three modal overlays (**tune numpad**, **nearby-stations
picker**, **settings**). Architecture splits cleanly into **ViewModel** (tuner +
preset state, station metadata) feeding a **stateless face composable** that
renders and raises callbacks.

### Design language
- **DUDU OS, light-first.** Light ("Simple") is the default theme; dark
  ("Enthusiast") is a first-class alternate, user-selectable, and follows the
  system scheme when set to "system".
- **Interactive blue** is the system accent — selection, active preset, primary
  actions. DUDU blue fallback given in §3.
- **Frequency amber is a fixed safety color — never themed, never restyled.** The
  tuned frequency is always amber in both themes so the driver
  finds the readout instantly. Amber is not part of the accent/theming system.

---

## 2. Target surfaces & layout tracks

DUDU OS splits the head-unit screen into **vertical thirds**, and the app also
runs on a phone (Galaxy S21) in portrait and landscape. All five surfaces are
first-class — none is a fallback, none may be dropped:

| Surface | Representative content area (dp) | Track |
|---|---|---|
| Dudu7 full | 1024 × 614 | wide |
| Dudu7 ⅔ slice | 900 × 810 (near-square) | wide, **twoRows** presets |
| Dudu7 ⅓ slice | 470 × 845 (narrow tall) | **tall** |
| Galaxy S21 landscape | 800 × 360 | wide, **landscape** density |
| Galaxy S21 portrait | 360 × 800 | **tall** |

Galaxy S21 panel is 1080 × 2400 px @ ~421 dpi ≈ **xxhdpi (density 3.0)** →
~360 × 800 dp portrait. **Design in dp; never hardcode 1080/2400.**

### Selecting the track
Two layout tracks, chosen from the available window size:
- **tall** — narrow, portrait-like surfaces (S21 portrait, Dudu7 ⅓ slice).
- **wide** — landscape and near-square surfaces (Dudu7 full / ⅔ slice, S21
  landscape).

Derive the track from **`WindowSizeClass`** (`Compact` width → tall;
`Medium`/`Expanded` → wide) or `BoxWithConstraints` on the available width.
Orientation is a fine proxy on the phone (portrait → tall, landscape → wide). Use
Android's own size signals rather than a raw width/height aspect test, so the app
composes correctly inside a DUDU OS third as well as full-screen.

Two wide sub-modes are density tweaks, not separate layouts: **twoRows** (Dudu7 ⅔
— presets become a 2-row horizontal grid) and **landscape** (S21 landscape —
slightly smaller type/tiles for the shorter height).

---

## 3. Design tokens

Font: **Atkinson Hyperlegible** (400/700) — an accessibility face for
glance-legibility in a moving car. Bundle both weights; honor system font-scale
(size in `sp`).

### Light ("Simple", default)
| Role | Hex |
|---|---|
| Screen bg | `#EEF1F5` |
| Panel (cards) | `#FFFFFF` |
| Raised (tiles/inputs) | `#F5F7FA` |
| Text | `#1B222C` |
| Dim text | `#67717F` |
| **Amber (frequency — fixed)** | `#C9760A` |
| Blue (accent) | `#2E86FF` |
| Blue fill (accent wash) | `rgba(46,134,255,0.12)` |
| Border | `rgba(20,30,45,0.13)` |
| Meter empty | `rgba(20,30,45,0.10)` |

### Dark ("Enthusiast")
| Role | Hex |
|---|---|
| Screen bg | `#161E29` |
| Panel | `#212B38` |
| Raised | `#2A3644` |
| Text | `#E9EEF4` |
| Dim text | `#8B97A7` |
| **Amber (frequency — fixed)** | `#FFB833` |
| Blue (accent) | `#4A9EFF` |
| Blue fill | `rgba(74,158,255,0.18)` |
| Border | `rgba(255,255,255,0.13)` |
| Meter empty | `rgba(255,255,255,0.10)` |

Amber differs by theme only for contrast against the two backgrounds; it is not a
themeable brand color — keep it out of accent/theming logic.

Card radius ≈ 28dp (hero), 16–18dp (tiles/cards/overlay panels), 12–14dp
(pills/inputs/keys); station-logo tiles ≈ 15–20dp (circle = fully round); the
nearby disc is fully round. Spacing: page padding ≈ 18–24dp, hero gap ≈ 20dp,
general gaps 8–12dp. Shadow: soft and large — hero ≈ `0 20dp 44dp`, modal/overlay
≈ `0 20dp 50dp`, ~16% opacity light / ~50% dark.

---

## 4. Radio face — structure

A vertical stack of three regions. Region behavior differs by track.

### 4.1 Status bar (top, fixed height, does not scroll)
Three zones — **left** (signal), **center** (stereo + tells + genre), **right**
(controls) — but the arrangement is **track-specific** (see "Track layout" below).

- **Signal** — concentric broadcast-arc icon + center dot, lit 0–4 by signal
  strength (amber when lit, meter-empty when not) with the signal **dB** value
  (dim, tabular figures). **Wide:** dB sits **beside** the icon (row). **Tall:**
  dB sits **below** the icon (column, centered).
- **STEREO / MONO pill** — blue outline + blue-fill when stereo, else dim
  outline. Small speaker-wave glyphs flank the label when stereo.
- **Tell strip** — four flags: `RDS`, `HD`(+level, e.g. `HD2`), `TP`/`TA`,
  `AF`. On = full weight + subtle raised shadow; off = ~32% opacity. **TA**
  replaces TP while a traffic announcement is active and **pulses** (amber,
  ~1.1s scale pulse). The tell strip sits directly **below** the STEREO pill.
- **PTY** — program-type / genre text (e.g. "Classic Rock"), dim, ellipsized;
  sits **below** the tell strip.
- **OUT OF FM BAND** warning pill (amber) when tuned outside 87.5–108.0 (pill text
  carries no "MHz" label).

**Track layout:**
- **Wide / landscape:** the signal cluster, the STEREO pill (with its tell strip
  and PTY beneath), and any OUT-OF-BAND pill all sit together in a **left cluster**;
  the controls are the right cluster. This is the default inline arrangement.
- **Tall (portrait / ⅓ slice):** the STEREO pill is **horizontally centered** in the
  status bar, with the **tell strip centered directly beneath it** and the **PTY /
  genre centered directly below the tells**. The signal icon + stacked dB stay in the
  **left** zone; settings + nearby stay in the **right** zone. Build as three flex
  zones (left `weight(1f)` · center wrap-content · right `weight(1f)`) so the center
  column is truly centered regardless of the side widths.
  - **Tuner-error pill** — when no compatible tuner is connected, one pill
    **replaces the entire OK cluster** (signal / stereo / tells / PTY / out-of-band);
    the two never show together. Amber warning triangle (≈26dp, 2dp stroke, no
    fill) + "Failure to connect to tuner." (≈17sp/700, amber, `letter-spacing 0.3`,
    nowrap) in an amber pill (height ≈44dp, padding 0 16dp, radius 10–12dp, 1.5dp
    amber border, amber-tint fill ≈ `rgba(201,118,10,0.08)` light /
    `rgba(255,184,51,0.10)` dark, gap 11dp). Wire to real tuner/SDR connection
    status: `true` whenever there is no compatible tuner session, clearing once one
    is connected and streaming — while `true`, signal / RDS / stereo / PTY are
    unavailable and must not be shown. The settings gear (right cluster) stays
    visible; its TUNER section (§6.3) is where the driver recovers.
- **Right cluster:**
  - **Settings** gear button (44dp square, bordered, dim icon).
  - **Nearby-search** button — lives **here on the tall track**; on the wide
    track it sits in the preset band instead (§4.3). Icon spec in §7.

### 4.2 Hero (middle) — the primary readout
A centered column: **station row** (logo tile · station name · save ★ button),
**frequency row** (large amber number, **no "MHz" unit label**), and a **RadioText
strip** beneath the hero card. FM is always MHz, so the unit label is omitted on the
face — it appears **only in the tune numpad** (§6.1).

- **Frequency** — largest element, amber, tabular figures (~52–60sp). Tap opens
  the **tune numpad** (§6.1).
- **Station name** — second largest; italic-dim "Tuning…" / "Scanning…" when no
  program-service name is present.
- **Logo tile** — rounded square with station brand bg/fg; initials fallback.
- **★ save** — toggles the current station as a preset (filled amber when saved).
- **RadioText strip** — raised rounded bar. Long text (> ~46 chars)
  **marquee-scrolls** (continuous left ticker, ~16s loop); short text is centered
  static; dim italic placeholder when empty.

**Vertical behavior:**
- **Tall:** the leftover height is **distributed, not pooled**. The hero sits in the
  upper-middle (roughly a third down from the status bar) at a **slightly enlarged**
  size, and the **RadioText strip** is **centered in the gap between the hero and the
  preset shelf** — equal space above and below it. (Three equal flexible gaps: above
  the hero, hero→RadioText, RadioText→presets; in Compose, three `weight(1f)` spacers
  or equivalent `Arrangement`.) The prev/next **peek cards** (§5) still flank the hero
  here, tucked in tighter against it (a smaller negative overlap than on the wide track).
- **Wide:** hero is a fixed-proportion centered card (~62% width, clamped
  470–720dp) flanked by the prev/next **peek cards**.

### 4.3 Preset band (bottom)
**Preset tiles** (logo · call sign · active underline) plus band controls.

- **Wide (default):** a horizontal **scroll rail** of tiles with `‹ ›` page-nav
  buttons on each end, a thin drag scrollbar beneath, and the **nearby-search**
  disc button at the right end. Band height ~140dp (~104dp landscape). The
  **active** tile is emphasized (blue border, enlarged).
- **twoRows (Dudu7 ⅔):** the rail becomes a **2-row** horizontal grid with fixed
  tile width; taller band (~250dp).
- **Tall:** a **3-column vertical grid** (`LazyVerticalGrid(columns = Fixed(3))`)
  that scrolls vertically, pinned as a **bottom shelf**: content-height, **capped
  at ~45% of screen height** (`heightIn(max = screenHeight * 0.45f)`), placed last
  in the column with the hero's `weight(1f)` above providing separation; grid
  aligns to the **top** of the cap. Nearby-search is not in this band on the tall
  track (it's in the status bar).

**Interactions:**
- **Tap** a tile → tune to it.
- **Long-press** (~550ms) any tile → **reorder mode**: tiles wiggle; each shows
  `‹ ›` move handles and an ✕ remove badge; a **DONE** button appears in the band.
  Moves animate with a FLIP slide (§8).
- **Empty state:** dashed placeholder — "No presets yet — tune a station and tap
  the ★".

### 4.4 Prev/Next preset stepper
Step through the preset list and retune by tapping the **peek cards** (§5) that
flank the hero on both tracks.

---

## 5. Prev/Next peek cards

Flanking the hero, the previous and next presets show as **smaller cards**
(≈ scale 0.88, ≈ 60% opacity, outer edge softened by a fade gradient) that peek in
from the sides and sit slightly behind the hero. Tapping one steps to that preset.
They flank the hero on **both** tracks whenever a previous/next preset exists —
tucked in tighter on the tall track than on wide. Build them as real sibling
composables at the smaller size/alpha, clipped by the screen edges.
Scale/alpha values are starting points.

---

## 6. Overlays (modal: scrim + centered card)

Each overlay dims the face with a scrim and centers a rounded card (`Dialog`, or a
scrim `Box` + centered `Surface`).

**Sizing — fit every surface.** Each overlay has a *design* size but must never
exceed the surface it opens on. Cap to the available area with a margin, then
center, and let the body scroll:
`width = min(designW, screenW − 32dp)`, `height = min(designH, screenH − 32dp)`.
The card body (station list / settings groups / keypad) scrolls, so a smaller cap
scrolls internally rather than truncating. Design sizes: numpad ~440dp wide
(height wraps content), nearby picker 900 × 600, settings 700 × 576. Overlays must
never carry a hard-coded pixel size on a real surface.

### 6.1 Tune numpad
Title "TUNE", a large amber display (current or typed value) + MHz, a **SEEK ‹‹ /
SEEK ››** row (scan to the next/previous strong station), a 12-key pad
(`1–9 . 0 ⌫`), and CANCEL / TUNE actions. Validates the **87.5–108.0 MHz** band
with an inline amber error when outside it. Uses a **compact variant** on short
surfaces (< ~560dp tall): smaller keys/gaps, title hidden.

### 6.2 Nearby-stations picker (`NearbyPicker`)
Header (title "Nearby stations" + subtitle "Tap to tune · hold to save a preset ·
best signal first") with a close ✕, a filter area, a scrolling **station list**,
and a footer ("FCC data as of <snapshot date>").

- **Station row:** brand logo tile · frequency (large, tabular, **no "MHz"
  label**) · call sign · optional service badge (when not "FM"); a second line of
  `city · genre`; a trailing signal icon + distance ("<km> km"); a saved ★ when
  already a preset; a `›` chevron. **Tap** tunes; **long-press** (~550ms) saves it
  as a preset. Rows are sorted best-signal-first. On a **narrow** picker (phone
  portrait / ⅓ vertical slice, i.e. when the picker is clamped below ~620dp wide)
  the row uses **compact metrics** — smaller logo, freq, callsign, gaps and padding,
  with the info column taking the row's slack — so the callsign never wraps and the
  columns don't cram. Wide surfaces keep the full-size metrics.
- **Filter — two levels:**
  - **Bucket row:** `All` · `Music` · `Talk` (Music/Talk shown only when the list
    actually contains such stations), shown **only while All is active**. Selecting
    **Music** or **Talk** hides this row entirely and shows the genre row below (the
    genre row's leading chip is the way back — see below).
  - **Genre row** (shown only inside Music/Talk when >1 genre exists): genre chips
    laid out in **exactly two rows**, flowing column-by-column and scrolling
    horizontally when they overflow. When drilled into Music/Talk there is **no
    separate bucket row** — an **icon-only back-arrow reset** chip (raised fill,
    spanning both rows) followed by a thin vertical **divider** leads the genre
    row and returns to the All/Music/Talk buckets. Selecting a genre filters the
    list; tapping it again clears it.
- **Alternate states:** **no-GPS** (crosshair glyph, "Waiting for GPS…") and
  **empty** ("Station database not installed yet" with install guidance) replace
  the list. Both are placeholder scaffolding for edge cases, not built-out flows.

### 6.3 Settings (`SettingsPanel`)
A header ("Settings" + close ✕) over a scrolling body of grouped sections:

- **TUNER** — connection status row (wave icon + "Connected …" or amber warning +
  "Not connected"; **RETRY** when errored, **Details** to expand a diagnostics
  panel: device, USB ID, sample rate). A **Tuner source** radio list: Auto
  (recommended), RTL-SDR, Si470x FM dongle, rtl_tcp — each with a
  detected/not-detected/unavailable badge; unavailable rows are disabled. A
  **Start radio on boot** toggle.
- **APPEARANCE** — **Theme** segmented control: SYSTEM / LIGHT / DARK.
- **SYSTEM** — **Battery optimization** status (amber "Not exempt" with a **FIX**
  action, or blue "EXEMPT"); **Station logos** toggle with a "Clear downloaded
  logos" row when on.
- **ADVANCED** — "Advanced SDR view" row → opens the stock SDR interface.
- Footer about line (app name · version · data snapshot).

The built panel (`SettingsPanel.dc.html`, in this bundle) is the exact reference
for these sections, values, and copy.

---

## 7. Nearby-search icon (match exactly — do not improvise)

A **magnifier whose lens contains a broadcast tower**: a circular lens (thin
stroke) over a faint glass fill; inside it a narrow **A-frame tower** with a
single low cross-brace and a short antenna mast; a tip dot; and **two broadcast-
wave arcs on each side** of the tip. A subtle barrel / lens-refraction warp bows
the tower slightly. A magnifier **handle** runs off the lower-right at ~45°
(~5 o'clock, stubby butt cap).
Default is themeable, but **as shipped (via `CarFmLive`) it is dark strokes
(`#111111`) on a white disc (`#FFFFFF`)**, with a light-gray border (`#D5DAE1`) and
a faint blue-tinted lens (`#DCE7F5`). In **dark** theme the shipped colors are
light strokes (`#E9EEF4`) on a raised disc (`#2A3644`), lens `#2A3644`, border
`#3A4655`. Disc / line / glass / border colors are themeable — a blue disc is
available but is not the default. Render as a vector drawable and reproduce the
tower + waves precisely — `RadioFace` (`lensTower` / `nearbyIcon`) is the exact
reference geometry.

---

## 8. Motion

- **Preset-change hero animation (both tracks):** the current hero **shrinks and
  translates into the previous peek slot** while the next card **grows and moves
  into center** — a real position/size morph (FLIP), not a slide or crossfade. The
  dropped far card fades out (0.6 → 0); a new far card fades in (0 → 0.6). Scale
  settles slightly ahead of translation so cards reach the right size before
  landing; ~520ms total, translation on an ease-out cubic, scale on a faster
  ease-out quint. Each moving card ends at its **resting transform** (peek cards
  keep their 0.88 base scale — never identity), so nothing pops. Express as
  animated bounds/scale/alpha transitions between the two card slots.
  **This is the one animation most likely to be skipped — build it from the exact
  FLIP procedure (capture bounds → tune → morph, two easings, resolve to the 0.88
  peek base) in LOSSY-ELEMENTS.md #9. Verify against a screen recording, not a still.**
- **Preset reorder move:** FLIP slide (~300ms, decelerate) as tiles swap.
- **Scanning:** frequency ticks through values (~34ms/step) toward the target
  station; small vertical fade on the readout per step.
- **TA flag:** continuous amber scale-pulse (~1.1s) while a traffic announcement
  is active.
- **Marquee RadioText:** continuous horizontal ticker (~16s loop) for long text.

Respect reduced-motion / driving-restriction settings if DUDU OS exposes them —
these are glance UIs and none of the motion is essential to function.

---

## 9. Tuner / state model

The ViewModel owns: current `freq`, `presets[]` (name + freq, persisted), and
derived per-station metadata (PS name, logo, PTY, RDS/TP/TA/AF flags, HD level,
signal). Persist `freq` + `presets` (DataStore/prefs).

- **Band:** 87.5–108.0 MHz, 0.1 step, wraps at the ends.
- **Seek/scan:** jump to the next/previous station with signal.
- **Save (★):** toggle the current station in/out of presets.
- **Reorder / remove:** via long-press reorder mode.
- Prototype station metadata is a fixed demo DB (Madison, WI market); the real
  build pulls PS/RT/PTY/flags from the RDS decoder and signal from the tuner, and
  nearby stations from the FCC dataset.

---

## 10. Safety constraints (must hold)
- Frequency readout **always amber**, both themes, never re-themed. (No "MHz" unit
  label on the face — FM is always MHz; the label appears only in the tune numpad.)
- **TA** must be visually loud (pulse) — traffic announcements override.
- **No scale-to-fit.** Real responsive dp/sp layout that reflows per surface
  (§0) — never a fixed canvas uniformly scaled to the screen.
- Hit targets **≥ 48dp** in real dp (not a scaled-down canvas); honor font-scale
  to ×1.5 without overlap.
- Glance-legible type; nothing critical below ~15sp.

## 11. Verify on device
- Portrait (360×800): hero upper-middle and slightly enlarged; RadioText centered
  in the gap between hero and presets; 3-col preset shelf pinned bottom, scrolls
  past the ~45% cap; peek cards flank the hero, tucked tight.
- Landscape (800×360): hero + peek cards + preset rail fit with no vertical
  clipping.
- Dudu7 full, ⅔ slice (twoRows) and ⅓ slice (narrow tall) all hold up.
- Font-scale ×1.3 / ×1.5: no overlap; frequency stays readable and amber.
- Theme light↔dark: amber unchanged; accent blue and surfaces swap.
- Overlays (numpad / picker / settings) on every surface: card fits with a margin
  and scrolls internally — never clipped on the narrow or short surfaces.
- Picker filter: selecting Music/Talk collapses the bucket row to All; genre chips
  sit in two rows and scroll horizontally.
