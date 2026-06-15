# VibeSDR V4 — Local SDR Implementation Brief

Turns the Fable architecture (`VibeSDR_v4_LocalSDR_Plan_Fable.md`) into a buildable,
atomic plan. **Architecture = a native Android "local UberSDR shim": link SDR++
Brown's DSP + RTL-SDR driver, run the radio on-device, and emulate the UberSDR
server protocol on 127.0.0.1.** VibeSDR connects to `ws://localhost` exactly like a
remote UberSDR → zero RN/client protocol changes. Android only (iOS has no USB host).
SDR++ Brown source: `Reference/SDRPlusPlusBrown-master`.

GPLv3 is fine — VibeSDR is already GPL3 (App-Store-modified) + open source.

---
## 0. Target UX (recap)
Plug RTL-SDR (Blog V4) into the phone over USB-C OTG → open VibeSDR → pick
**"Local Hardware"** (pinned top of the instance picker, Android only) → everything
fires up like a server (waterfall/drum/audio/decoders). ONE new UI piece: a
hardware-control submenu (SDR model, sample rate, **direct sampling I/Q/Off**, **HF
upconverter offset**, **gain**, PPM, bias-T). v1 = RTL-SDR + gain + PPM only.

---
## 1. The seam — VibeSDR's UberSDR protocol (what the shim must emit/accept)
From `src/services/UberSDRClient.ts` (+ native VibePowerModule audio):
- **Spectrum WS** `ws://HOST/ws/user-spectrum?user_session_id=<uuid>&mode=binary8`.
  Binary **SPEC** frame: 22-byte header `magic "SPEC"(0x43455053 LE) | ver 0x01 |
  flags u8 | ts u64 LE | freq u64 LE`, then body. flags: 0x01 full f32, 0x02 delta
  f32, **0x03 full u8**, 0x04 delta u8. u8 mapping: `dBFS = u8 - 256` (0=-256, 255=-1).
  v1 shim: emit **full u8** every frame (simplest; client supports it).
- **Audio WS** (native-owned): 21-byte header + Opus. Pick **Opus @ 12 kHz** to match
  the existing native decoder path. (Later optimisation: a raw-PCM passthrough flag.)
- **Control plane** = JSON over the spectrum WS + native tune:
  `{type:"zoom",frequency,...}`, `{type:"set_rate",divisor}`, `{type:"reset"}`,
  `{type:"ping"}`; tune/mode/bandwidth via `VibePowerModule.sendTuneCommand`/JSON.
  Server replies `{type:"config",...}` (center_freq, samp_rate, fft_size, …).
- **/status.json** — `{receiver:{gps:{lat,lon},location,name}, max_clients, version,
  sdrs:[{name,profiles:[{name,center_freq,sample_rate}]}]}`. The shim serves this so
  the picker shows it + ITU region works (point gps at the device location).

---
## 2. What to TAKE from SDR++ Brown (don't fork the ImGui frontend)
- **RTL-SDR driver** `source_modules/rtl_sdr_source/src/main.cpp` — Android path is
  `#ifdef __ANDROID__` (libusb over a passed fd). Setters we expose:
  `rtlsdr_set_sample_rate / set_center_freq / set_tuner_gain(+gain_mode) /
  set_direct_sampling(0/1/2) / set_bias_tee / set_freq_correction(ppm)`. IQ via
  `rtlsdr_read_async(dev, asyncHandler, ctx, 0, count)`.
- **DSP** `core/src/dsp/` — pure C++ (demods, filters, AGC, NR, resamplers), no GUI.
- **Radio demod** `decoder_modules/radio/src/` — usb/lsb/am/dsb/nfm/raw demods; audio
  output is a **`dsp::stream<dsp::stereo_t>`** registered via
  `sigpath::sinkManager.registerStream(name, stream)`. The shim adds a custom sink
  that `read()`s this stream → PCM → Opus instead of an audio device.
- **FFT tap** `core/src/signal_path/iq_frontend.h` — UI-agnostic callbacks
  `float* acquireFFTBuffer(ctx)` / `releaseFFTBuffer(ctx)` give the f32 dB row. Map
  to SPEC u8 (`u8 = clamp(dB,-256,0)+256`), resample bins to display width, emit.
- **USB Kotlin** `android/app/src/main/java/.../MainActivity.kt` — `UsbManager →
  requestPermission(ACTION_USB_PERMISSION) → openDevice → getFileDescriptor()` → pass
  fd to libusb. Lift ~verbatim into VibeSDR's MainActivity.
- **Build** `android/app/build.gradle` — CMake `externalNativeBuild`, `-DSDR_KIT_ROOT
  -DOPT_BACKEND_ANDROID=ON -DOPT_BACKEND_GLFW=OFF`, NDK 25.2. We are **ARM only**
  (arm64-v8a + armeabi-v7a; x86 dropped).

---
## 3. Hardware-control submenu (the one new RN/UI piece)
Localhost-backend menu section (Android), same pattern as the OWRX squelch/NR
sliders. Shim advertises device + ranges on connect (extend /status.json or a
`local_hw` config msg). v1 controls → JSON control msg → shim → rtlsdr setter:
`gain` (0..49 dB, +auto), `ppm`. Later: sample-rate picker, **direct sampling I/Q/Off**,
**HF upconverter offset** (frequency shift applied to tune), bias-T, AGC.

---
## 4. Staged build plan (atomic, testable)
1. **NDK/CMake skeleton** — get SDR++ Brown core + rtl_sdr building inside the
   VibeSDR APK for arm64 (the time-sink; SDR_KIT_ROOT prebuilt deps are the map).
2. **USB** — port MainActivity USB-permission/fd; enumerate RTL-SDR, open, log device.
3. **IQ → FFT → SPEC** — wire iq_frontend FFT tap → localhost spectrum WS emitting
   full-u8 SPEC frames. VibeSDR waterfall renders local hardware.
4. **Audio** — radio demod stereo stream → Opus @12k → 21-byte frames on the audio
   WS. Tune/mode/bandwidth from JSON control → vfo_manager + demod.
5. **/status.json + picker entry** — shim serves status (gps=device loc); add
   Android-only "Local Hardware" pinned top of the instance picker → ws://localhost.
6. **Hardware submenu** — gain + PPM (v1 cut).
7. Polish: direct sampling, HF upconverter, sample-rate, bias-T; other sources later.

**Demo target (Stuart):** must work convincingly with the **RTL-SDR Blog V4** on a
phone, for an RTL-SDR Blog writeup. Polished single-device demo > breadth.

See [[project_v4_local_sdr]].
