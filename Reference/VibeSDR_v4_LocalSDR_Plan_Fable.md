# VibeSDR V4 — Local SDR (Android) — Architecture Plan (Fable, Claude web)

Captured 2026-06-15. This is the V4 architecture analysis from the Fable model.
V4 = local USB SDR hardware on Android, exposed to the existing VibeSDR client.

## What SDR++ Brown Android actually is
Not a normal Android app — a **NativeActivity**: a single C++ binary rendering
ImGui via EGL/OpenGL ES (`core/backends/android/backend.cpp`), with one Kotlin
file (`MainActivity.kt`) doing plumbing: USB permission flow, handing the USB
file descriptor to libusb, httpGet helpers. There is **no Android view hierarchy
to host React Native inside**, and ImGui calls are woven through every module's
menu code (radio module header alone = 35 `ImGui::` calls). So "fork and reskin"
= gutting the entire frontend of a large C++ codebase = **worst path**.

**But the parts you want are well separated:**
- **Drivers:** `source_modules/` — rtl_sdr, airspy, airspyhf, hackrf, plutosdr,
  hydrasdr etc., already building for Android with the USB-fd-via-Kotlin pattern.
- **DSP:** `core/src/dsp/` is pure C++ (demodulators, filters, AGC, NR,
  resamplers), no GUI dependency.
- **FFT tap:** `iq_frontend.h` exposes the spectrum via
  `acquireFFTBuffer`/`releaseFFTBuffer` callbacks — deliberately UI-agnostic.
  Exactly the hook the waterfall needs.
- **SmGui:** server mode already serialises module settings UIs into draw-step
  commands → proves modules can run headless.

## What VibeSDR brings
- `WaterfallView` consumes rows through `frameSink` — plain arrays + status
  object, nothing UberSDR-specific.
- The client speaks a small documented protocol: **SPEC-framed spectrum WS,
  21-byte-header Opus audio WS, JSON control messages.** That protocol is the seam.

## RECOMMENDED ARCHITECTURE: a local UberSDR shim
Build a **native Android service (C++ via NDK**, in the VibeSDR APK or a companion
APK) that links SDR++ Brown's core + chosen source modules + radio demodulators,
and **emulates the UberSDR server protocol on 127.0.0.1**. VibeSDR connects to
`ws://localhost` exactly as it connects to a remote UberSDR today.

Shim responsibilities map ~1:1 onto existing things:
- **Tuning/mode/bandwidth** — VibeSDR JSON control → `vfo_manager` + radio demod selection.
- **Spectrum** — FFT buffer callback → bin to display width → emit SPEC frames
  (client already supports float32 + uint8, full + delta).
- **Audio** — demod PCM → libopus encode → 21-byte header frames. (Opus-encode +
  MediaCodec-decode on the same phone is silly; later optimisation = a "PCM
  passthrough" flag in VibeStreamService. For v1 keep wire format identical = zero
  client changes.)
- **USB** — lift permission/fd code from their `MainActivity.kt` ~verbatim.

Beats direct JNI embedding: VibeSDR stays a protocol client with two backends
(remote UberSDR, local hardware) selected per-instance in the existing instance
picker. Same waterfall, drum, decoders, auto-range; decoder panel keeps working
(consumes demodulated audio). Two codebases evolve independently — borrowing
SDR++'s libraries, not forking it.

## Eyes-open caveats
- **Licensing:** SDR++ is **GPLv3**. Linking its core into the app makes the
  combined work GPLv3 → must open-source VibeSDR (or at least the Android build).
  Shipping the shim as a **separate APK over localhost** is the traditional
  arms-length boundary — but it's grey. Decide early; it shapes packaging.
- **Android-only:** SDR++ has no iOS; iOS has no general USB host API for RTL
  dongles. So this is VibeSDR's Android-exclusive "direct hardware" mode. iPhone
  17 stays a network client; Moto G35 + OTG dongle = test rig. Coherent product story.
- **C++/NDK project:** different beast from TS/Kotlin/Swift. Claude-Code-shaped
  (well-scoped, spec-driven, atomic) but CMake/NDK build wrangling eats the first
  chunk before any DSP runs. Their `android/app/build.gradle` + `SDR_KIT_ROOT`
  prebuilt-dependency setup is the map.
- **v1 scope cut:** RTL-SDR source only, USB OTG, fixed sample rate, gain + PPM as
  the only device settings (hard-coded JSON extensions on existing menu — client
  already probes server extensions at runtime, so a `local_hw` extension slots in),
  SSB/AM/FM/CW demod from the radio module. SmGui generic settings UI + exotic
  sources come later.

## PRODUCT DECISION (Stuart, 2026-06-15)
- **Both iOS + Android ship as v4, ONE shared codebase.** Bug fixes apply to both.
  (NOT an iOS-v3 / Android-v4 fork.)
- **Local hardware is an Android-only ADDITIVE backend** — the SDR++ Brown core +
  localhost UberSDR shim are bundled only in the Android build; iOS v4 = same app
  minus local hardware.
- **Instance picker:** a "Local Hardware" option pinned at the VERY TOP (above
  Favourites/Default and the Directory cards), shown only on Android
  (Platform.OS === 'android'). Tapping it connects to ws://localhost (the shim) →
  reuses the existing UberSDR backend, zero new client protocol.
- Implication: the only RN/TS change is the picker entry + Android-gated connect
  to localhost. ALL the heavy lifting is the C++/NDK shim on the Android side.

### Target UX (Stuart, concrete)
Plug RTL-SDR v4 into the phone (USB-C OTG) → open VibeSDR → choose "Local Hardware"
instance → everything fires up exactly like a server (waterfall/drum/audio/
decoders/auto-range, because the shim emulates UberSDR on localhost). The ONLY new
UI = a **hardware-control button → submenu** for device settings not in the server
protocol:
  - **SDR model** (RTL-SDR v3/v4 for v1; Airspy/HackRF/etc. later)
  - **Sample rate / bandwidth**
  - **Direct sampling: I / Q / Off** (HF without an upconverter)
  - **HF upconverter offset** (e.g. −125 MHz for Ham It Up → tune real HF freqs)
  - **Gain** (auto/manual RF gain; range advertised by shim per device)
  - **PPM correction, bias-T, AGC**
Each control → JSON control msg → shim → SDR++ source-module setter
(setGain/setPPM/setDirectSampling/setBiasT/setSampleRate). Tuning/mode/filter-
bandwidth ride the EXISTING UberSDR protocol untouched. Shim advertises device +
gain range on connect so sliders get correct limits. RTL-SDR Blog V4 is supported
by SDR++ Brown's rtl_sdr source module.

## NEXT STEP (Fable's suggestion)
Crystallise into a **VibeSDR_LocalSDR_Brief.md** — protocol mapping table (VibeSDR
JSON control schema ↔ SDR++ calls), FFT callback wiring, Opus framing spec, v1 cut
list — ready to hand to Claude Code.

Reference checkout: `Reference/SDRPlusPlusBrown-master`.
