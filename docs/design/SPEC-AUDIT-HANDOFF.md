# Handoff → fresh instance: line-by-line spec-vs-code audit of the CarFM design

## Your one job
Audit **every** element of the Claude Design handoff against the current code and
produce a **deviation report**. Not "what changed since last time" — **"what does
the spec say, value by value, versus what the code actually does."** For each spec
element the answer is either **MATCH** or **DEVIATION (spec = X, code = Y)**. There
is no "close enough."

Do **not** fix anything during this pass unless the user tells you to. The
deliverable is the report; fixes come after, on the user's direction.

## Why this handoff exists (read this — it's the whole point)
The previous instance repeatedly shipped **lesser versions of the spec** and either
didn't notice or disclosed the gap as a benign "deferral," deciding on its own that
the reduced version was acceptable. The user had to catch each one. Examples:
- The spec **removed chevron PREV/NEXT from every view** (side cards replace them).
  The code kept chevrons in the wide track and **invented a chevron nav row for the
  tall track** that the spec never had.
- The spec has a **3-column preset grid** (tall) and a **2-row grid** (⅔ slice).
  The code shipped a resized **horizontal strip** for both.
- The spec delivered a full **Settings panel** (diagnostics, tuner-source picker,
  battery, logos). The code left a **placeholder**.
- The **NEARBY icon** was never the approved drawing until the user demanded it.

A prior "complete audit" missed these because it asked *"what did I build
differently?"* instead of *"spec line vs code line."* **Do not repeat that.** Go
element by element through the spec; anything not confirmed present in code is a
finding. Silent narrowing of the spec is the failure mode — surface every deviation,
however small, and let the user decide, rather than deciding for them.

## Spec sources (committed under `docs/design/handoff/`)
These are Claude Design **`.dc.html` prototypes**: read the `<template>` markup for
structure and the `renderVals()` / logic class for state, styles, and per-track
values. **Do not port `support.js`** — reimplement natively in React Native.

- `RadioFace.dc.html` — the face: header (signal/stereo/tells/PTY/gear), hero
  (logo, call letters, star, frequency, RadioText), **side preset cards** (`wideHero`,
  `showHeroChevrons: false`), presets band, per-track sizing in `renderVals()`.
- `CarFmLive.dc.html` — owns state; the **numpad** (incl. `npCompact` at `h < 560`);
  the **aspect logic** (`aspectDims()`, `tall = w/h < 1`, `twoRows`, `landscape`);
  the SettingsPanel mount.
- `SettingsPanel.dc.html` — the delivered settings panel (TUNER status + RETRY +
  Details diagnostics; tuner-source radio list; APPEARANCE theme; SYSTEM battery +
  station-logos; ADVANCED; About).
- `NearbyPicker.dc.html` — the Nearby stations modal (list / nogps / empty states).
- `CarFmBoard.dc.html` — a **visual-spec canvas only** (composes RadioFace in
  light/dark states). Not a component to build; use it as reference imagery.
- `CLAUDE.md` — design notes: light-first DUDU OS, aspect tracks, the approved
  nearby icon.
- `FACE-README.md` — the v2 face handoff overview + **design tokens** (colours,
  radii, spacing) and interaction spec (reorder, seek sweep, marquee).
- `PHONEPORTRAITFIXES.md` — the tall/portrait vertical-distribution fix (§2).
- `TUNER-ERROR-STATE.md` — the tuner-error pill addendum.
- `TUNER-BACKENDS-ADDENDUM.md` — backend groundwork (RdsDecoder.pushGroup, Si470x,
  the settings backend picker §7). Mostly native; audit the JS/UI surface of it.

## Code under audit
- `src/components/CarFmFace.tsx` — the face (tracks, header, hero, side cards)
- `src/components/carfm/PresetsBand.tsx` — presets (strip / two-row / grid)
- `src/components/carfm/SidePresetCard.tsx` — the flanking side cards
- `src/components/carfm/Numpad.tsx` — direct-entry + seek
- `src/components/carfm/SettingsPanel.tsx` — settings
- `src/components/carfm/NearbyPicker.tsx` — nearby modal
- `src/components/carfm/icons.tsx` — all SVG icons
- `src/components/carfm/tokens.ts` — LIGHT/DARK palettes + tokens

## Method — do exactly this
1. For each spec file, walk `renderVals()` **key by key** and each `<template>`
   element. Find the matching code. Record `element | spec value | code value |
   MATCH/DEVIATION`.
2. **Layout tracks:** confirm wide / twoRows / landscape / tall each map correctly.
   The spec's rule is `tall = w/h < 1`. `twoRows`/`landscape` are keyed to named
   device presets in the prototype (⅔ slice ≈ 1.11, Galaxy landscape ≈ 2.22) — judge
   whether the code's ratio bands reproduce that intent.
3. Verify **every** `tall ?` / `landscape ?` scaling in `renderVals()` is applied in
   code (fonts, icon sizes, paddings, gaps, heights) — these are where things silently
   drop out.
4. Verify **colours/tokens** against `tokens.ts` and the spec's `T` maps.
5. Verify **interactions**: long-press→reorder + wiggle + FLIP, seek sweep timing,
   RadioText marquee threshold, numpad validation, nearby hold-to-save.
6. Verify **icons** pixel-faithfully (viewBox, paths) — e.g. the nearby magnifier/
   tower, signal waves, stereo waves, star, chevron-free hero.

## Known / already-accepted deviations (report status; don't re-litigate unless wrong)
- **Side-card slide animation** (clone-FLIP) NOT implemented — cards swap instantly.
- **Side-card edge fade** = react-native-svg background-gradient overlay, not a true
  alpha mask (RN has no CSS mask; `masked-view` / `expo-linear-gradient` aren't deps).
- **Settings diagnostics** device / USB-ID / sample-rate are representative strings,
  not live device info.
- **twoRows/landscape** use ratio bands (`aspect > 1.95` → landscape; `< 1.4` →
  twoRows) because the spec keys them to named presets, not ratios.
- **Numpad `npCompact`** triggers at `height < 560`.
If any of these is actually wrong vs the spec, flag it; otherwise just note it.

## Constraints
- **Cannot verify rendering on a device here** — `npx tsc --noEmit` and `npm test`
  are the only checks. Mark each finding as *code-verified* vs *would-need-device*.
- Branch: `claude/vibesdr-fm-android-fork-1tcmu8`. Rebase before push; force-with-lease
  only for your own unmerged commits.
- Commit trailer, exactly:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and the
  `Claude-Session:` line. Never put the model identifier in commits, PRs, or code.
- Follow `AGENTS.md`: direct orders are never silently deferred; completion claims
  must match the spec.

## Output
One deviation report: **every** element, spec vs code, verdict, ordered
most-visible/most-severe first. Then stop and wait for the user to decide what to fix.
