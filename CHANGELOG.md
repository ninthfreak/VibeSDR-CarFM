# VibeSDR — Changelog

VibeSDR is free software under the **GNU GPL v3**. Source: https://github.com/Stuey3D/VibeSDR

---

## v5.1.0 — Unlocked VFO + waterfall panning, recordings player (2026-06-23)

### Waterfall panning & the VFO Lock
- **Waterfall panning is back, as an opt-in.** A new **VFO Lock** toggle in the
  menu (replacing the old centre button) controls it. **Locked is the default and
  is byte-for-byte the previous behaviour** — the VFO stays pinned to the centre.
  Unlock it and you can **drag the waterfall to pan around the band while staying
  tuned**; the VFO needle can sit off-centre or off-screen.
- A floating **CENTRE ON VFO** button appears (above the controls) whenever the
  VFO is unlocked and off-screen — one tap snaps the view back to the VFO without
  re-locking.
- **Gestures are now: tap = tune, drag = pan, pinch = zoom.** The old vertical
  drag-to-zoom is gone (it fought panning). Panning runs **on the UI thread**, so
  the grab/drag stays responsive even when the connection is laggy or busy with
  incoming data.
- Discrete jumps (frequency entry, bookmarks, VTS, Siri, lock-screen skip) always
  re-centre on the target, regardless of the lock.

### Second VFO for the RF (dongle) centre — Local Hardware / RTL-TCP
- On the on-device backends the **dongle centre is now a true second VFO**, drawn
  as a dashed **RF-CENTRE** marker with its own frequency readout.
- With the VFO unlocked you can **pan the view across the entire captured
  bandwidth at full resolution** while a station stays tuned. The dongle follows
  your pan until the tuned station nears the capture edge, then **locks** — and the
  view keeps scrolling, the RF-CENTRE marker sliding off to the side, up to the
  hard **walls** at the capture-band edges.
- The pan limits track the **actual sample-rate / bandwidth mode** the device
  reports (so 250 kHz, 1 MHz, 2.4 MHz etc. each get the right walls), keeping the
  tuned station clear of the anti-alias rolloff.

### Saved Recordings player
- New **Recordings** screen (from the menu) lists every audio recording you've
  made — **play them back in-app** with a scrub bar, **share**, or **delete**.
  Previously a recording you didn't immediately save from the share sheet was
  stranded in app storage with no way to reach it.
- Recordings are now kept in the app on **both platforms** (Android no longer
  pushes them straight to the Music library), so the browser is identical on iOS
  and Android. The live SDR is paused while a recording plays so the two don't
  fight over the audio session.

---

## v5.0.1 — CW fix on local hardware (2026-06-20)

### Fixed
- **CW now demodulates correctly on the Local Hardware (USB RTL-SDR) backend.**
  The beat-note offset and the actual filter width had drifted apart: the client
  applies a narrow CW passband, but the demodulator was placing the carrier
  outside it, so a signal tuned dead-on produced silence and you could only hear
  morse when tuned well off the signal. The CW filter and beat note are now kept
  in sync — tune straight onto a CW signal and you get a clear, audible ~600 Hz
  tone with readable morse.
- The mode pill now reads **CW** (matching the single CW button) instead of the
  internal sideband id.

---

## v5.0.0 — Native, GPL-free on-device DSP (2026-06-20)

**The headline: the on-device radio no longer uses any third-party GPL DSP.**

VibeSDR's Local Hardware (USB RTL-SDR on Android) and RTL-TCP (Android + iOS)
backends used to demodulate IQ with a bundled copy of the **SDR++ Brown** DSP core
(plus **FFTW** and **VOLK**). V4 was built on SDR++ Brown to get on-device SDR up
and running quickly — and we're grateful for it. **In V5 that has been removed
entirely** and replaced with **VibeDSP**, VibeSDR's own clean-room signal-processing
engine, written from scratch.

Why it matters: VibeSDR stays GPLv3 (its own choice — it fronts free/open SDR
servers and decoders, so FOSS is the right fit), but because **no SDR++ / FFTW /
VOLK code is bundled anymore**, the app can ship on the public App Store and Play
Store without the GPL-on-store concerns that bundled third-party GPL code can raise.

### New DSP engine (VibeDSP)
- Clean-room, from-scratch C++ engine — only permissively-licensed **KissFFT**
  (BSD-3) is vendored; everything else is original VibeSDR code.
- **Hand-optimised with ARM NEON SIMD** across every hot path (FFT power/dB,
  channel filters, FIR decimator + resampler, IQ conversion) plus trig-free
  recursive oscillators. Runs **noticeably cooler and lighter on the battery**,
  especially on low-end phones and tablets.

### DSP improvements over the old engine
- **True single-sideband SSB** with proper image rejection (Weaver method) — the
  unwanted sideband is silent instead of bleeding through (was effectively DSB).
- **Genuine FM stereo**: 19 kHz pilot PLL with a smooth stereo blend, a reliable
  stereo indicator, RDS station name / RadioText, and a **force-mono** switch.
- **Audio AGC** for AM / SSB / CW — steady level, no fading or crackle.
- **Working FM de-emphasis** (50 µs / 75 µs / off) — the control now takes effect.
- RDS no longer flickers, and clears immediately when you retune.

### Reliability / UX
- Fixed a USB-teardown crash and a session-switch race that could stop a new
  RTL-TCP session from connecting.
- Local-USB sample-rate selector hides sub-1 MHz rates (a dongle is sluggish
  there); RTL-TCP keeps the low rates for sources like UberSDR.
- About page and menus updated; honest credit retained for SDR++ Brown (bootstrap
  + colour palettes) and the other open projects VibeSDR builds on.

### Platforms
- Android: Moto G35, Galaxy Tab A9 and similar — smoother and cooler than V4.
- iOS: RTL-TCP retained; the IPA is now free of bundled GPL DSP.

---

## v4.1.0 and earlier

See the in-app **About → Changelog** for the full V1–V4 history (first-run tutorial,
bookmark overhaul, multi-backend support — UberSDR / OpenWebRX / KiwiSDR — Android
Auto, Siri voice control, local SDR hardware, and more).
