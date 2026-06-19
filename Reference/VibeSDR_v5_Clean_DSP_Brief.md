# VibeSDR V5 — Clean-Room GPL-Free DSP Brief

**Status:** Planned (post-v4.1 / post-TestFlight). Drafted 2026-06-19.
**Goal:** Remove every GPL dependency from the on-device DSP so VibeSDR can ship
on the **public iOS App Store** without the GPLv3-vs-App-Store takedown risk —
while keeping the project itself GPLv3/open-source by *choice*, and keeping every
feature, including **Broadcast FM stereo + RDS**.

> VibeSDR stays GPLv3 and open-source on purpose (it fronts free/open SDR servers
> and open decoders). A nominal store fee is GPL-compliant. The problem is purely
> that **third-party GPL code in the IPA** is incompatible with Apple's App Store
> terms (the VLC precedent). V5 removes that code. See memory `project_v5_clean_dsp`.

---

## 1. What actually has to change (audited, 2026-06-19)

GPL code lives in **one place only**: the local-SDR native pipeline.

| Component | Where | Licence | V5 action |
|---|---|---|---|
| SDR++ Brown DSP (VFO, demods, resampler, de-emphasis, IQFrontEnd) | `android/app/src/main/cpp/local_sdr_shim.cpp` (+ iOS `libvibelocalsdr_ios.a`) | GPLv3 | **Replace** |
| SDR++ `rds_demod` (radio module) | included by `local_sdr_shim.cpp` | GPLv3 | **Replace (redsea)** |
| FFTW (`libfftw3f.a`) | iOS pod libs | GPLv2+ | **Replace** |
| VOLK (`libvolk.a`) | iOS pod libs | GPLv3 | **Drop** (not needed without SDR++) |
| zstd | iOS pod libs | BSD | keep / drop with SDR++ |

**Already clean — NO change needed (this is the good news):**

- `cpp/decoders/audio_nr.cpp` — **our** MMSE noise reduction
- `cpp/decoders/auto_notch.cpp` — **our** adaptive notch (line enhancer)
- `cpp/decoders/ft8_decoder.cpp` + `cpp/ft8_lib/*` — **MIT** (Kārlis Goba)
- `cpp/decoders/sstv_decoder.cpp`, `wefax_decoder.cpp`, `fsk_decoder.cpp` — **ours**
- The localhost WebSocket servers (spectrum / audio / dxcluster), the Kotlin/USB
  layer, the RTL-TCP networking, and the **entire JS/TS app**.

These all consume **demodulated PCM** through the shim, so they are downstream of
the swap and untouched.

### The contract that makes this safe
`modules/vibe-local-sdr/include/local_sdr_shim.h` (the `vibe::LocalSdrShim` public
interface) **does not change**. Same `start()/startTcp()/stop()`, same setters
(`setGain/setPpm/setBiasTee/setAgc/setDirectSampling/setSampleRate/setDeemphasis/
setSquelch/setNR/setNrStrength/setNotch/getTunerGains/...`), same WS protocol.
V5 reimplements only the *body* of `local_sdr_shim.cpp`. App + decoders + JS are
byte-for-byte unaffected.

---

## 2. Replacement DSP stack (all permissive, attribution-only)

| Function | Replacement | Licence |
|---|---|---|
| FFT (waterfall) | **vDSP/Accelerate** (iOS), **PFFFT** or **KissFFT** (Android) | System / BSD |
| Frequency translation + decimation (DDC/VFO) | **liquid-dsp** `nco_crcf` + `firdecim` / `msresamp`, or own | MIT |
| AM demod | liquid `ampmodem`, or `sqrt(I²+Q²)` envelope | MIT / own |
| SSB/CW demod | liquid Hilbert (`firhilbf`) / Weaver, CW = BFO mix | MIT / own |
| NFM demod | quadrature discriminator `atan2(conj(prev)*cur)` (liquid `freqdem`) | MIT / own |
| WFM mono | liquid `freqdem` wideband | MIT |
| **WFM stereo (MPX)** | **own**: 19 kHz pilot PLL → 38 kHz coherent decode → L±R matrix → de-emphasis | ours |
| **RDS** | **redsea** (Oona Räisänen) fed the 57 kHz subcarrier | **MIT** |
| Audio resample to 48 kHz | liquid `msresamp_rrrf` | MIT |
| De-emphasis (50/75 µs) | one-pole IIR (own) | ours |

**Pipeline shape (per backend):**
```
IQ source (RTL/USB  or  rtl_tcp socket)
   → IQFrontEnd replacement: DC block + IQ balance + FFT(window) → spectrum WS
   → DDC: NCO mix to 0 Hz + low-pass + decimate to channel rate
   → per-mode demod → audio resample to 48 kHz
        → audio WS (PCM)         → app audio engine
        → decoders/NR/notch tap  → existing decoder/NR/notch (UNCHANGED)
   WFM only: MPX → {L+R, 38k stereo, 57k → redsea RDS}
```

---

## 3. Will we gain performance / control vs SDR++ Brown?

**Yes — real, concrete wins, plus we shed several documented landmines.** Honest
trade-offs noted too.

### Gains
- **Smaller binary / faster cold start.** Drops the SDR++ core static libs + FFTW
  + VOLK. On iOS, vDSP/Accelerate is a *system* framework (NEON/AMX-tuned on Apple
  silicon, frequently beats FFTW) — less code shipped, less to load.
- **Lower latency.** A direct `DDC → demod → PCM` path avoids SDR++'s general-purpose
  buffered block scheduler. We control buffer sizes for exactly the 5 modes we use.
- **Finer waterfall zoom, no hacks.** Today we FFT-crop in `onFFT` because SDR++
  decimation aborts (`core::setInputSampleRate "Not a bool"`). Owning the FFT lets
  us pick size/overlap/hop directly — proper zoom resolution, no workaround.
- **No more re-init / teardown landmines.** Owning lifecycle removes the SDR++
  pain already in our notes: `dsp::block::registerInput()` aborting on re-init
  ("never init() a block twice"; heap-recreate resamp+sink each `buildAudio`),
  and the SIGSEGV-in-`rtlsdr_close` / teardown-hang races. Deterministic thread
  ownership end-to-end.
- **Full control of the chain.** Exact filter shapes, custom AGC, precise bandwidth,
  per-mode tuning, easy to add modes/features SDR++ doesn't expose cleanly.
- **One codebase, two platforms.** Same C++ DSP on Android + iOS (no GPL split,
  no two demod paths to keep in sync).

### Trade-offs (be honest)
- **Matching mature quality is work.** SDR++ Brown's demods — especially **WFM
  stereo separation + RDS lock robustness** — are well-tuned. Our first cut may be
  noisier / lock less aggressively; expect an iteration pass on the wideband path.
- **Engineering time + new bugs.** Multi-week effort; the easy 80% (AM/SSB/CW/NFM)
  is fast, the wideband 20% (MPX + RDS) is the real cost.
- We give up SDR++'s breadth (other modules/modes) — but we only ever used the 5
  modes above, so that breadth was unused weight anyway.

**Verdict:** net win on size, latency, zoom, robustness of lifecycle, and control;
the only thing we must consciously protect is WFM-stereo/RDS audio quality.

---

## 4. Phased plan

- **Phase 0 — Harness.** Build a permissive DSP scratch target + offline IQ
  capture (record a few seconds of RTL/rtl_tcp IQ per band now, while SDR++ still
  works, as golden reference). A/B new demod output vs current build.
- **Phase 1 — FFT/waterfall.** Replace `IQFrontEnd`/FFTW with vDSP (iOS) / PFFFT
  (Android) + window. Spectrum WS pixel-compatible with today.
- **Phase 2 — DDC + narrowband demods.** NCO+decimate; AM/SSB/CW/NFM via liquid.
  Wire to audio WS + decoder/NR/notch tap. Verify NR/notch/FT8/SSTV unchanged.
- **Phase 3 — WFM mono + de-emphasis.** Match audio level/tone.
- **Phase 4 — WFM stereo (MPX).** Pilot PLL, 38 kHz decode, L±R, de-emphasis.
  A/B separation vs SDR++.
- **Phase 5 — RDS via redsea.** Feed 57 kHz subcarrier; map redsea PI/PS/RT to the
  existing VTS station-label + RDS UI (OWRX path already renders these).
- **Phase 6 — Strip GPL.** Remove SDR++ Brown / FFTW / VOLK from both builds;
  update `VibeLocalSDR.podspec` licence → MIT/BSD set; rewrite About credits
  (drop the SDR++-is-why-we're-GPL line; keep gracious thanks); confirm no GPL in
  IPA/AAB. App can now go public on iOS App Store.
- **Phase 7 — On-device shakeout.** All modes / all HW controls / both platforms /
  RTL-TCP + USB, on the usual rigs (Moto G35, Galaxy Tab A9, iPhone 17PM/SE).

## 5. Acceptance criteria
- No GPL-licensed code in either shipped artifact (verify the libs + sources).
- Feature parity: AM/SSB/CW/NFM/WFM, WFM **stereo + RDS**, NR, auto-notch, squelch,
  all decoders, waterfall zoom, all HW controls — all working on device.
- Audio quality ≥ v4.1 (esp. WFM stereo separation, RDS lock time).
- `local_sdr_shim.h` interface unchanged; JS/app diff = none.
- Binary size and cold-start no worse (target: better).

## 6. Branching
- `v4` stays master; **v4.1.0 is the GitHub latest release** (TestFlight when access
  granted; already on Play test track).
- V5 work on a `v5` branch; merge to `main` only after Phase 7 on-device sign-off.
- Tag golden-reference IQ captures / known-good points as we go.

## 7. Open items to resolve at kickoff
- Pick FFT lib per platform (vDSP iOS confirmed; PFFFT vs KissFFT on Android).
- Decide liquid-dsp vs hand-rolled per demod (liquid faster to ship; own = smaller
  dep). liquid-dsp is itself MIT, so either is clean.
- redsea integration shape (link as lib vs vendor the decoder core).
- Confirm `setSquelch`/`setDeemphasis` current implementation site (shim vs ours)
  and reproduce in the new path.
