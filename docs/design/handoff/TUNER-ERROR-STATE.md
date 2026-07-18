# Handoff addendum: Tuner‑connection error state

*New feature added on top of the existing FM Radio Face spec. This document covers **only this
feature** — everything else in `README.md` is unchanged. Files updated: `RadioFace.dc.html`
(the display) and `CarFmLive.dc.html` (the owning state + prop).*

## What it is
An **error mode** for when the app **cannot connect to a compatible FM tuner** (no SDR dongle
present, incompatible device, driver/handshake failure, etc.). While in this state the radio has
no signal, RDS, stereo status, genre, or station features to show — so those header indicators
would be meaningless. This feature replaces that whole cluster with a single clear error message.

## Where it appears
The **upper‑left header cluster** of the Radio Face. Normally that cluster holds, left‑to‑right:
- the **signal‑strength** icon + dB reading,
- the **STEREO / MONO** pill,
- the **feature tells** (RDS / HD / TP·TA / AF),
- and (conditionally) the **genre (PTY)** and **out‑of‑band** pills.

When the tuner is not connected, **all of those are hidden** and replaced in‑place by one pill:

> ⚠  **Failure to connect to tuner.**

The **gear / settings button** in the upper‑right stays visible and is the entry point for any
tuner‑connection settings (device/driver selection, reconnect, diagnostics — see below). Nothing
else on the face changes structurally; the rest of the screen (hero, presets, etc.) is out of
scope for this document.

## Visual spec
- **Container:** a pill matching the existing header pills — `height:44`, `padding:0 16px`,
  `border-radius:10`, `1.5px solid amber`, tinted background
  `rgba(255,184,51,0.10)` (dark) / `rgba(201,118,10,0.08)` (light), `gap:11`.
- **Icon:** a warning triangle (rounded, 26×26, `2px` stroke, `stroke:amber`, no fill).
- **Text:** "Failure to connect to tuner." — 17px 700, `color:amber`, `letter-spacing:0.3`,
  `white-space:nowrap`.
- **Color:** uses the existing **amber** accent token (light `#C9760A`, dark `#FFB833`) — the same
  caution color already used for out‑of‑band. It is a fault/attention state, not a normal reading.

## Behavior / state
- Driven by a single boolean. In the prototype it is the prop **`tunerError`** on `CarFmLive`
  (default `false`), passed down to `RadioFace` as **`tuner-error`**. It is exposed as a Tweak so
  the state can be previewed.
- `RadioFace` branches on it: `tunerError` → show the error pill; otherwise (`tunerOk`) → show the
  normal signal/stereo/tells/genre cluster exactly as before. It is a hard either/or — the two
  never show together.
- **In production:** wire `tunerError` to the real tuner/SDR connection status (e.g. device‑absent
  or handshake‑failed). It should be `true` whenever there is no compatible tuner session, and
  clear to `false` once a compatible tuner is connected and streaming. When `true`, signal / RDS /
  stereo / genre values are unavailable and should not be read or shown.

## Settings button
The upper‑right **gear** button is the home for **tuner‑connection settings**. It is currently a
placeholder (no panel wired). When you build the settings panel, this is where tuner setup lives:
choose / detect the tuner device, retry the connection, and show connection diagnostics. The error
pill and this button are the two halves of the same story — the pill reports the fault, the gear
is where the driver goes to fix it. (Designing the panel's contents is out of scope here; only the
entry point and its purpose are specified.)
