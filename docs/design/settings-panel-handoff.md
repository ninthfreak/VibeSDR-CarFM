# Handoff → Claude Design: CarFM Settings pop-up

Companion to the FM Radio Face handoffs (same fork, same design language). The
**gear button** in the face's upper-right opens this pop-up. A functional
placeholder is implemented (`src/components/carfm/SettingsPanel.tsx`) — treat
its content list as the requirements and its layout as a first draft to
redesign. All backend wiring exists; the design only needs to present it.

## Context

- Renders as a **modal card over the radio face** (same pattern as the Nearby
  picker: dim scrim, rounded card, ✕ close). Canvas/tokens identical to the
  face handoff: 1024×614 (5:3) head unit, Atkinson Hyperlegible, light
  "Simple" / dark "Enthusiast" palettes, §6 colourblind rules (amber =
  caution/hot, blue = interactive, never red-vs-green).
- Per the TUNERERRORSTATE addendum: *"the [tuner-error] pill reports the
  fault, the gear is where the driver goes to fix it"* — this pop-up is that
  destination, so the TUNER section leads.
- Driver context: big touch targets; may be used at a stoplight.

## Current organization (as built — the draft to improve on)

Card: 560 wide (max 94%), radius 24, `bg` colour; header row (68 high,
bottom border): title **"Settings"** left, 48×48 ✕ button right. Then three
labelled sections, each a 12px over-line label (dim, letterspaced) above a
rounded `raised` container with 58-high rows:

1. **TUNER**
   - *Status row:* icon + text. Connected → 4-wave signal icon (amber) +
     "Connected — Local Hardware (RTL-SDR)". No tuner → amber warning
     triangle + "Not connected — no USB tuner found" + a **RETRY** button
     (blue border/fill pill) that fires an immediate reconnect attempt.
   - *(divider)*
   - *"Start radio on boot"* — system Switch (blue when on). Backed by the
     persisted autostart setting.
2. **APPEARANCE**
   - *"Theme"* — three segmented chips: SYSTEM / LIGHT / DARK (active chip =
     blue border + blueFill). Persisted; overrides the OS scheme on the face.
3. **ADVANCED**
   - *"Advanced SDR view ›"* — full-width tappable row; the ONE deliberate
     escape into the stock SDR interface (waterfall etc.). Closes the panel,
     opens the stock UI.

## Requirements for the redesign (what must be present)

Everything above, plus these items the backend already supports (or is
specced for) that the placeholder does not yet surface:

- **Tuner backend picker** *(tuner-backends addendum §7)* — when more than
  one tuner class is available: RTL-SDR (SDR), Si470x USB FM dongle
  (hardware tuner), rtl_tcp (network/dev). Requirement: manual override +
  "remember last choice per device"; default is auto-probe. Native surface
  for Si470x exists (`si470xTuner.ts`) but is deliberately unwired until
  hardware verification — design the picker now, expect it to enable later.
  Show each backend's presence state (detected / not detected).
- **Tuner diagnostics** *(TUNERERRORSTATE addendum)* — the error pill's
  companion: device/driver detail for the connected tuner (device name,
  VID:PID) and a lightweight "connection diagnostics" affordance. Content can
  be minimal; the addendum only fixes the entry point here.
- **Battery optimization status** — a row showing exempt / not-exempt with a
  "Fix" action (native `isIgnoringBatteryOptimizations` /
  `requestIgnoreBatteryOptimizations` exist; today there's only a one-time
  boot prompt). Matters for the permanent install: Doze can kill the
  boot-started radio.
- **Station logos (future placeholder)** — automatic logo downloading is
  DISABLED pending redesign (it fetched wrong images; see `TODO(logos)` in
  `logoResolver.ts`). Manual assignment still works from the Nearby/station
  context (in-app search + browser share-back). Reserve a "Station logos"
  row/section for when the redesigned auto system lands (likely an on/off
  toggle + "clear downloaded logos"). Do not design the logo pipeline itself.

Nice-to-have if it fits naturally: an About row (app version, FCC data
snapshot date — `getStationDataDate()` exists).

## Wiring contract (what the component receives — design to these)

```ts
visible: boolean
tunerError: boolean            // drives the TUNER status row state
autostart: boolean;  onSetAutostart(on)
theme: 'system'|'light'|'dark';  onSetTheme(t)
onRetryTuner?()                // present only when a retry makes sense
onAdvanced()                   // Advanced SDR view row
onClose()
// future (backend ready): backend list + selection, battery status/fix,
// diagnostics payload
```

## Constraints / don'ts

- No red-green state encoding anywhere (driver is red/green colourblind).
- The panel must never be required for normal radio use — everything in it is
  setup/recovery. Tune/seek/presets stay on the face.
- "Advanced SDR view" must remain visually de-emphasised relative to the
  car-relevant controls — it's an escape hatch, not a feature.
- Keep it one screen at 1024×614 if possible; if it must scroll, TUNER stays
  above the fold.
