# DUDU OS FM Radio — Android implementation spec

*Bundle v1.10.0 — 2026-07-24 (see `VERSION`).*

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
  - **Driving-status icons** (GPS lock + vehicle-in-motion) sit just left of the gear on
    the **wide / landscape tracks only** — hidden entirely on the tall track (portrait / ⅓
    slice). Spec in §4.6.
  - **Settings** gear button (44dp square, bordered, dim icon).
  - **Nearby-search** button — lives **here on the tall track**; on the wide
    track it sits in the preset band instead (§4.3). Icon spec in §7.

### 4.2 Hero (middle) — the primary readout
A centered column: **station row**, **frequency row** (large amber number, **no "MHz" unit label**), and a **RadioText
strip** beneath the hero card. FM is always MHz, so the unit label is omitted on the
face. The **star save button always sits in the top-right corner of the card** (both tracks),
never inline with the station identity — it is not part of the logo/name centering.

The station row has **two forms**, decided by whether the tuned station has a real logo (§4.5):
- **Real logo present:** the logo image REPLACES the big call-sign text — it sits centered in a
  box sized to a generous share of the card (`ContentScale.Fit`, §4.5). The call sign and frequency
  are **hidden by default** on a logo hero (§6.4), so the logo fills the card; each can be turned
  back on per station, appearing as a small call-sign label beneath the logo and the amber frequency below.
- **No real logo:** **no monogram tile is shown on the hero** — just the big **call sign** (largest
  text; italic-dim "Tuning…" / "Scanning…" when no PS name) and the frequency. The generated cube
  adds no value at hero size, so it is omitted here (it still appears on preset tiles/peek cards).

The call sign and the frequency on the hero are each controlled **per station** by the **Display Call
Sign** / **Display Frequency** options in the logo window (§6.4) — **both default OFF for a station that
has a logo** (logo-only hero), each turnable on individually. These toggles affect the **hero only**,
never the preset tiles, peek cards, or Nearby, and they exist only for stations with a real logo — a
**no-logo** hero always shows its call sign + frequency.
face — it appears **only in the tune numpad** (§6.1).

- **Frequency** — largest element, amber, tabular figures (~52–60sp). Tap opens
  the **tune numpad** (§6.1).
- **Station name** — second largest; italic-dim "Tuning…" / "Scanning…" when no
  program-service name is present. Shown as the **4 core call letters only** (`-FM`/`-AM`
  and hyphens stripped, e.g. `WWHG-FM` → `WWHG`) — this applies everywhere a call sign appears.
- **Logo** — see §4.5 for the real-image model, per-surface fit, and the no-logo behavior.
- **★ save** — toggles the current station as a preset (filled amber when saved); **top-right corner**.
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
**Preset tiles** plus band controls. A tile shows **either** a real logo **or** a call-sign box:
- **Real logo:** the image fills a **borderless, transparent** plate (§4.5, landscape-tolerant so
  wordmarks read); **frequency and call sign are hidden** — the logo carries the identity.
- **No real logo:** a **wide colored box** in the **same landscape aspect as the real-logo plate**,
  with the **4 core call letters centered inside it** (station-color fill), and the **frequency
  beneath** the box — the call sign is inside the box, not repeated below. Active tile shows the amber underline.

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
- **Long-press** (~550ms) any tile → **reorder mode**: tiles wiggle; each shows a blue
  **logo-search badge** (magnifier-over-picture glyph, top-left) and an ✕ remove badge
  (top-right); a **DONE** button appears in the band.
- **Drag to reorder** (one continuous gesture): the long-press flows straight into a
  drag with the same finger — no lift-and-re-press. The picked-up tile lifts (scale
  1.06 + shadow) and tracks the pointer; the wiggle freezes on every tile during the
  drag; the remaining tiles **slide apart to open a real gap** at the insertion point,
  and the gap tracks the pointer. The list is not reordered mid-drag — on release the
  order commits and the dropped tile settles from the finger into the open slot (§8).
  There are no on-screen move arrows.
- **Logo-search badge** → opens the **preset logo-search window** (§6.4) for that
  station. It is the one and only way a logo is assigned (no automatic fetching).
- **Empty state:** dashed placeholder — "No presets yet — tune a station and tap
  the ★".

### 4.4 Prev/Next preset stepper
Step through the preset list and retune by tapping the **peek cards** (§5) that
flank the hero on both tracks.

### 4.5 Station logos — real image assets & per-surface fit

Logos are **real image assets** (transparent or opaque PNG/SVG), not just monogram
tiles. There is **no standard aspect ratio** — expect square badges, wide wordmarks
(up to ~3:1), and tall stacked lockups. Two logo kinds coexist:
- **Real logo** — an image assigned via the logo window (§6.4), with its own intrinsic aspect.
- **Generated monogram** — the colored rounded tile with call letters, used as the fallback
  wherever no real logo exists (preset tiles / peek cards only; never on the hero — see below).

**Containment invariant (every surface, non-negotiable):** a logo renders **fully visible** —
`ContentScale.Fit` (= CSS `object-fit: contain`), **never cropped, never overflowing its box,
centered**. The box has **fixed geometry**; the image scales to the largest size that fits
inside. This single rule handles all aspect ratios automatically: a wide wordmark uses the
box's full width, a square badge or tall lockup uses its full height. **Never size the box from
the logo, and never resize or crop the source to force it into a slot.**

**Separate the plate from the image.** The plate (white tile or transparent container) owns its
own size + padding; the image is width/height 100% with `Fit` **inside** the padded box. That
separation is what mathematically prevents overflow — do **not** hand-tune per-logo pixel heights
(that was the bug we chased before adopting this model).

**Prep on assign.** When a logo is saved, **bounding-box crop** the surrounding transparent/white
margin so the *visible mark* — not baked-in whitespace — fills the box, and **record the intrinsic
aspect ratio** (or bucket it: square / wide wordmark / tall lockup). The hero doesn't need the ratio
to render (Fit handles it), but storing it lets small slots make fallback decisions without re-measuring.

**Per-surface budget (this is how you get max coverage):**
- **Hero — maximum room.** A real logo **replaces the big call sign**; `Fit`. Call sign + frequency
  are **hidden by default** on a logo hero (§6.4), so the box is at its **largest** and the logo fills
  the card regardless of aspect. Turning either back on shrinks the box to leave room for the small
  call-sign label and/or the amber frequency beneath (one on → smaller, both on → smallest). **No real
  logo →** show no monogram on the hero at all (call sign + frequency only). Star always corner.
- **Preset tiles & prev/next peek cards — aspect-tolerant, and identical to each other.** Real logo →
  **borderless, transparent** plate that the image fills; use a **non-square / landscape-ish** plate so
  wide wordmarks read; freq + call sign are **hidden**. No logo → a **wide colored box in that same
  landscape aspect with the 4 call letters inside it**, frequency **beneath** the box. The prev/next
  peek cards use the **exact same treatment** as the bottom preset tiles.
- **Nearby search — no logos.** A small fixed square on a text-baseline row cannot render a detailed
  or wide logo legibly, and Nearby is low-traffic, so **there is no logo column** — the row is
  freq · callsign · city/genre · signal · distance.

**General fallback rule (for the real pipeline, beyond the sample data):** hero always uses the
image; tiles/peek use the image whenever one exists; if a future surface needs a *small fixed box*,
**gate on a legibility budget** — skip the image and show the monogram/callsign when the mark would
render below ~28–32dp tall or its aspect is too extreme — rather than forcing an unreadable shrink.
Brands commonly ship **two marks** (a horizontal lockup and a compact icon/monogram); when both are
available, prefer the **lockup for the hero** and the **icon for small slots**.

**Test with deliberately extreme aspects** — one square badge, one ~3:1 wordmark, one tall stacked
lockup — on every surface, light and dark. A roughly-square sample (like WERN) looks fine everywhere
and **hides** the wide/tall failure modes, so it is not a sufficient test on its own.

### 4.6 Driving-status icons (GPS lock + vehicle in motion)

Two glance indicators in the status bar's **right cluster**, just left of the settings gear.
**Wide / landscape tracks only — both are hidden entirely on the tall track (portrait / ⅓ slice).**

- **GPS lock** — an **angled satellite** glyph (body tilted ~28°, small dish + two downward signal
  arcs toward the ground). **Lit interactive-blue on a GPS fix; with no fix it is not greyed but
  styled like a disabled tell (§4.1) — full text color at ~32% opacity with the same faint 1px
  emboss.** Always present (it communicates lock state); sits a couple of px above the gear's top edge.
- **Vehicle in motion** — a **car with three trailing motion lines**. **Rendered only while the app
  detects motion — absent (not dimmed) when stopped.** It is **amber** (the fixed safety-color family,
  like TA — never the blue accent) and **pulses slowly** (~2.6s opacity + slight-scale, gentler than
  TA's ~1.1s). Centered on the gear's vertical center.

Both are driven by real signals in the build (GPS fix state; motion/speed detection). In the prototype
they are the `gpsLocked` and `inMotion` tweaks on `CarFmLive`.

### 4.7 Audio-priority (on/off) control

DUDU OS shares one audio bus across sources; the FM app either **holds audio priority** or
**releases it** to another source. A **power-symbol button** in the hero card's **top-left
corner** — mirroring the ★ save button top-right — toggles this. Glyph is the universal power
mark (open ring broken by a top stem). **This is NOT a mute** (audio isn't silenced in place);
it claims or releases the tuner's priority on the shared bus.

- **Active (has priority):** the normal face. Button is a **dim outline**, no fill.
- **Inactive (released):** the button turns **solid amber (`#FFAE1A`) with a white glyph and
  pulses** (an expanding amber ring, ~1.8s) to draw the eye back, and the **whole face goes flat
  and "dead":**
  - **Grayscale** — the entire face desaturates, EXCEPT the power button, which is the one
    element that keeps color.
  - **Depth removed** — the hero card drop shadow, the RDS/HD/TP/AF tell emboss, and all text
    shadows drop to none (flat, lifeless).
  - **Veils** — a **light gray veil** over the hero card and a **darker veil** over the rest of
    the screen; the prev/next peek cards dim further (opacity ~0.28).
  - **Indicators to their off states** — signal icon shows **no bars**, dB reads `--`, the
    **STEREO/MONO pill is empty** (outline with no text), RDS/HD/TP/AF all dim, PTY is hidden,
    and the **RadioText strip is fully invisible**.
- **Callbacks:** `claim` (inactive → take priority) and `release` (active → give it up). In the
  prototype: an `audioActive` boolean on `CarFmLive`; the button fires `onClaimAudio` /
  `onReleaseAudio`.
- **Prototype-only implementation note (does NOT port literally):** the grayscale is applied to a
  **static ancestor** of the hero + peek cards, and the power button is rendered **outside** that
  grayscaled subtree so it stays colored — a workaround for a browser GPU-compositing quirk. On
  Android, just desaturate the face content and draw the button in full color above it.
- Preset-change animation is **disabled while inactive** — see §8.

---

## 5. Prev/Next peek cards

Flanking the hero, the previous and next presets show as **smaller cards** that use the **exact same
treatment as the bottom preset tiles** (§4.3): the station's **real logo image** when one exists
(borderless, Fit — §4.5), otherwise a **wide colored call-sign box** (4 letters inside) with the
**frequency beneath**.
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

- **Station row:** frequency (large, tabular, **no "MHz" label**) · call sign · optional service badge (when not "FM"); a second line of
  `city · genre`; a trailing signal icon + distance ("<km> km"); a saved ★ when
  already a preset. **No logo column** — Nearby does not show station logos (§4.5).
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

- **TUNER** — a connection status row (wave icon + "Connected …" / amber "Not
  connected"; **RETRY** when errored, **Details** expands a diagnostics panel: device,
  USB ID, sample rate) above a **source picker** (single-select), each row = name · kind ·
  status badge: **RTL-SDR** (USB software-defined radio; Detected / Not detected) ·
  **NWD / NOWADA built-in radio** (integrated head-unit FM tuner; Detected / Not detected) ·
  **FYT / DuduOS built-in radio** (integrated head-unit FM tuner; **Unavailable — greyed**) ·
  **Auto** (probe all sources; no badge) — `Auto` is the default selection. A **Start radio
  on boot** toggle.
- **APPEARANCE** — **Theme** segmented control: SYSTEM / LIGHT / DARK.
- **SYSTEM** — **Battery optimization** status (amber "Not exempt" with a **FIX**
  action, or blue "EXEMPT"); **Station logos** toggle with a "Clear downloaded
  logos" row when on.
- **ADVANCED** — "Advanced SDR view" row → opens the stock SDR interface.
- Footer about line (app name · version · data snapshot).

The built panel (`SettingsPanel.dc.html`, in this bundle) is the exact reference
for these sections, values, and copy.

### 6.4 Preset logo-search window (`LogoSearchOverlay`)
A **modal card over the radio face** (same dim-scrim + rounded-card pattern as the
numpad/picker/settings), opened by the per-tile logo-search badge in reorder mode. It
is the **only** way a station logo is assigned — there is no automatic/background logo
fetch.

**It opens on a LANDING view, not a search:**
- **Station has a logo:** shows the **current logo** (large, Fit) plus two option rows,
  **Display Call Sign** and **Display Frequency** — both **unchecked by default** (logo-only
  hero) — and a **"Search for a different logo"** button.
- **No logo:** shows a **"No Logo Installed"** message + a **"Search for a logo"** button.

**Display Call Sign / Display Frequency affect the HERO CARD ONLY**, saved per station, and **default
OFF** — a freshly-assigned logo yields a logo-only hero; check either to bring back the small call-sign
label and/or amber frequency. They do not change the preset tiles, peek cards, or Nearby. They persist
with the station.

**Search runs only when the Search button is pressed** (query built from the station; no query
field, no submit).

- **Trigger glyph:** a **magnifier over a picture** (framed image with a tiny sun +
  hill, lens at lower-right) — deliberately distinct from the Nearby magnifier-over-
  tower (§7). White stroke on the blue badge; ≥48dp touch target (hitSlop is fine).
- **Header:** the station's current logo tile, its **name**, and `callsign · frequency
  MHz`, plus a **query chip** showing the exact string searched (e.g. `radio 98.1 wmgn
  logo`) so the driver can trust the results. A close ✕.
- **States, in order:** **Loading** (spinner + "Searching for logos…"); **Results** —
  the first **four** image candidates in a **2×2 grid** (each cell = the candidate art
  on its own background + a caption of source domain and pixel dimensions); **No
  results** and **Error**, each a short message with a **Search again** action; and a
  **Saving** busy state on Confirm.
- **Selection:** tap a cell to select (single-select) — **blue** 2dp border + blue
  fill tint + a blue check badge (never red/green; §6 colourblind rule). Selecting
  enables **Confirm**.
- **Confirm** (enabled on the landing view, or once a cell is selected in results): saves the
  chosen image as this station's **manual logo** (sticky — never overwritten later) together with
  the **Display Call Sign / Display Frequency** choices, refreshes
  every tile showing that station, and closes. **Cancel** / scrim / ✕ closes and
  changes nothing.
- **Responsive:** the 2×2 grid fits the narrow track (phone portrait / ⅓ slice) with
  no horizontal scroll; light/dark themes as elsewhere.
- Backend wiring (search, save-as-manual, tile refresh) is host-side; the design
  supplies the icon + window. `LogoSearchOverlay.dc.html` is the exact reference; its
  `demoState` prop flips between the states for review (`landing` is the default).

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
- **Audio-off:** while audio priority is **released** (§4.7) the preset-change hero animation is
  **disabled** — preset changes swap **instantly** (no morph, no fade). This reinforces the flat
  "dead" feel and avoids animating a desaturated face (it also sidesteps a compositor issue in the
  prototype). Re-enables automatically when priority is reclaimed.
- **Preset reorder (drag):** the picked-up tile lifts (scale 1.06 + shadow,
  `touch-action:none`) and tracks the pointer. The other tiles **slide apart to open a
  gap** at the insertion slot (transform-only, ~160ms ease; the wiggle is frozen for
  the duration). Insertion geometry is computed against the slot rects captured at
  drag start, so the gap does not oscillate as in-flight transforms move. The list is
  NOT reordered mid-drag — on release the order commits and every tile (including the
  dropped one, sliding from the finger) resolves to its new position with a FLIP slide
  (~300ms, decelerate). Committing only on drop avoids the index-churn that live
  reordering causes with an index-keyed list. The long-press→drag is one continuous
  gesture (same pointer); a >12dp move before the long-press fires cancels it, so the
  rail can still be scrolled.
- **Scanning:** frequency ticks through values (~34ms/step) toward the target
  station; small vertical fade on the readout per step.
- **TA flag:** continuous amber scale-pulse (~1.1s) while a traffic announcement
  is active.
- **Vehicle-in-motion icon:** slow amber pulse (~2.6s opacity + slight scale) while the
  vehicle is in motion (§4.6) — gentler and slower than the TA pulse; the icon is absent
  (not dimmed) when stopped.
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
- **Audio priority:** `audioActive` (has priority / released). `release` hands the shared audio
  bus to another source; `claim` takes it back. The released state is **visual-only in the
  prototype** (not persisted) — full off-state visuals in §4.7.
- **Reorder / remove / change logo:** via long-press reorder mode (drag to reorder,
  ✕ to remove, logo-search badge to open the logo-search window §6.4).
- Prototype station metadata is a fixed demo DB (Madison, WI market); the real
  build pulls PS/RT/PTY/flags from the RDS decoder and signal from the tuner, and
  nearby stations from the FCC dataset.

---

## 10. Safety constraints (must hold)
- Frequency readout **always amber**, both themes, never re-themed. (No "MHz" unit
  label on the face — FM is always MHz; the label appears only in the tune numpad.)
- **TA** must be visually loud (pulse) — traffic announcements override.
- **Audio-off must be unmistakable:** when audio priority is released the whole face desaturates
  and flattens, and the power button is the **sole colored, pulsing** element (§4.7), so the
  released state is glanceable at speed.
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
