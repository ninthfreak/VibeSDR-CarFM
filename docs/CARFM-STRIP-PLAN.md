# CarFM strip-down plan

Goal: reduce the VibeSDR codebase to the CarFM car-FM-radio experience. Ranked by
**harm** = how likely removing the item breaks CarFM (its FM pipeline / build) or
demands risky surgery. Work top-down (🟢 first). Scope decisions already made:
**keep all receiver backends for now**; **full iOS removal**.

## Status
- ✅ **Items 1–9 DONE** (commits `a2d7a91`, `592f91f`): dead files, iOS project +
  pod, app.json ios block, `Platform.OS==='ios'` branches, BrowserOverlay, Apple
  Watch (watchProvider/watchBoot + all call sites), Siri + CarPlay (Android Auto
  kept).
- **Items 10–19: SIX done, FOUR part-done** (2026-07-30) — per-item marks below.
  Done outright: 14 decoders, 15 chat, 16 maps/aircraft, 17 waterfall, 19 the
  advanced-SDR UI (24 components, and `carFm` collapsed to always-true so the
  `!fmFaceActive` tree is gone with its dev entry points). Part-done: 10, 11, 12,
  13, 18 — in each case the UI went and something deliberate or load-bearing
  stayed. SDRScreen 4,898 → 2,747 lines.
- ⬜ **Other open items** from earlier in the project — see the last section so
  they aren't lost.

## The one structural fact that drives everything
- `CarFmFace.tsx` is **purely presentational** — 23-file import closure, zero SDR
  backends; it gets frequency/RDS/signal/stereo as **props**.
- `SDRScreen.tsx` (5182 LOC) is its **host**: it wires the tuner → CarFmFace props
  AND renders every non-FM feature inline. So `SDRScreen` is **core — never
  deleted**; removing features = **surgery inside it**.
- `InstancePickerScreen.tsx` is the **launcher** (navigates in with `carFm:true`) —
  keep, trim.

## CORE — never remove (the CarFM keep-set)
- `CarFmFace.tsx` + all `src/components/carfm/*`
- `SDRScreen.tsx` (host — trim, don't delete), `InstancePickerScreen.tsx` (trim)
- FM/RDS/station/logo services: stationFinder, stationDb, stationTypes, stationGeo,
  stationLogo, stationLogoCache, logoResolver, logoWikidata, logoSiteFavicon,
  radioBrowser, piCallsign, rdsCountry, callsignCountry, ptyLabels, base64
- Pipeline/output: UberSDRClient, UberSDRAdapter, SDRBackend, localSession,
  nowPlaying, carMode, sdrTypes, instancesApi (`getUserLocation`), favourites,
  defaultInstance, AudioPlayer/`VibePowerModule`, LocalAudioPlayer, imaAdpcm
- All `android/` native (Kotlin + cpp) + `sdr-kit/` (29 MB, Android runtime dep)

---

## 🟢 LOW harm — safe, do first (isolated / dead / iOS-inert on Android)
1. **VTSDisplay.tsx** — orphaned, imported nowhere. Pure delete.
2. ✅ **Si470x — REMOVED completely** (2026-07-21). It was NOT just a JS stub: real
   native code existed (`vibe_si470x_rds_jni.cpp`, `Si470xTuner.kt`,
   `Si470xSession.kt`) wired into CMake (`vibelocalsdr` lib), `VibeLocalSdrModule`
   (list/start/stop/tune/seek ReactMethods), the USB `device_filter.xml`, and the
   settings tuner-source picker. All removed atomically; the generic hardware-RDS
   parser entry (`RdsDecoder::pushGroup`) was KEPT (backend-agnostic, reusable).
   Rationale (per owner): SiLabs' reference USB dongle is discontinued and no one
   else shipped a USB variant — remaining Si470x parts are I²C Arduino/SBC boards
   with analog audio jacks that don't integrate.
3. **`app.json` → `expo.ios` block** — config only.
4. **`ios/` directory** (incl. `VibeSDRWatch/` Apple-Watch app, 3 MB) — Android build never touches it; JS native names are satisfied by the Kotlin modules.
5. **`modules/vibe-local-sdr/`** — the iOS pod + prebuilt `.a` + `build_ios.sh`. iOS-only. (Keep `android/.../cpp` — `build_ios.sh` referenced it, but Android needs it.)
6. **`Platform.OS === 'ios'` cosmetic branches** — App.tsx, modals (ChatDrawer, FreqModal, PasswordModal), `mdns.ts`. Simplify to the `else` path. Mechanical.
7. **BrowserOverlay.tsx** — one small SDRScreen-only overlay. Clean lift-out.

## 🟡 MODERATE harm — bounded surgery (inline overlays / shared screens / iOS wiring)
8. **Apple Watch** — `watchProvider.ts` (~45 KB) + `watchBoot.ts`. iOS-only, but invoked from App.tsx **boot logic**, SDRScreen (~30 calls), TunerScreen (~15), WaterfallView; `watchBoot.claimed` is also read by the **Android carFm boot branch** (App.tsx:288). Untangle the boot gate carefully.
9. **Siri + CarPlay** — iOS voice/car blocks in SDRScreen (~186–262, 1491, 1904, 1910). Bounded, but the **Android Auto** side is shared — keep that when cutting CarPlay.
10. 🟨 **Recording — UI gone, native pipeline still there.** RecordingsOverlay,
    AudioSheet and TunerScreen are deleted, so nothing can start a recording. The
    Kotlin side (`startRecordingNative`/`stopRecordingNative`, the MediaStore
    publish, `VibeStreamModule.startRecording`) is untouched and now unreachable.
    Original item: RecordingsOverlay.tsx + AudioSheet.tsx (12 SDRScreen refs). Shared with **TunerScreen** — edit both call sites. Keep AudioPlayer/`VibePowerModule`.
11. 🟨 **Server-sharing — screens gone, services KEPT by decision.**
    ServerModeScreen and RtlTcpServerScreen are deleted; `rtlTcpServer`,
    `vibeServer`, `vibeAuth` and `mdns` stay (owner: "Server sharing: keep for
    now"), which leaves them present but unreachable from the UI.
    Original item: ServerModeScreen + RtlTcpServerScreen (+ rtlTcpServer, vibeServer, vibeAuth, mdns). Clean screen deletes, but **backend-adjacent** (you deferred backend decisions) → confirm before cutting.
12. 🟨 **FM-DX — screen gone, adapter KEPT by decision.** TunerScreen, FmdxDial
    and `fmdxDirectory` are deleted; `FmdxAdapter` stays (owner: "Remote SDR
    backends: keep").
    Original item: TunerScreen + FmdxDial (+ FmdxAdapter, fmdxDirectory). Clean screen-level removal, but FM-DX is a **reception source you deferred** → decide as a set.
13. 🟨 **VTS + HF bookmarks — only the BAR went.** VTSBar.tsx is deleted, but
    `stations`, `eibi` and `userBookmarks` are all still live in SDRScreen —
    and `userBookmarks` IS the preset store, so it can never go. Treat this item
    as "retire the HF/shortwave parts of stations + eibi", not a delete.
    Original item: VTSBar.tsx + services `stations`, `eibi` (shortwave schedules), `userBookmarks`. HF/ham band-plan engine, no FM role.

## 🔴 HIGH harm — deep SDRScreen surgery / shared pipeline (do last, carefully)
14. ✅ **Decoders — DONE** (JS, native `cpp/decoders` + ft8_lib, and the web client's panel). **Decoders** — DecoderPanel + DecoderImageCanvas + `DecoderClient` + native `cpp/decoders`. **76 SDRScreen refs** — the most coupled subsystem. `DecoderClient` is the shared backbone for **decoders + chat + map spots**, so items 14/15/16 must be planned together.
15. ✅ **Chat — DONE** (drawer, SDRScreen state, OWRX + FM-DX transports). **Chat** — ChatDrawer.tsx + DecoderClient chat transport. Shared with TunerScreen; rides on DecoderClient.
16. ✅ **Maps & aircraft — DONE.** **Maps & aircraft** — MapOverlay.tsx + AircraftPanel.tsx. Shares DecoderClient spot rows.
17. ✅ **GPU waterfall — DONE** (2026-07-21). **GPU waterfall** — WaterfallView.tsx (1353 LOC, inline Skia shaders). **39 SDRScreen refs**, ~40 wired props; also read by watchProvider. Hidden under the CarFM overlay anyway.
18. 🟨 **Non-FM demod modes — only the pickers went.** ModeSelector and
    StepPicker are deleted, but the mode/step state machine in SDRScreen and
    `dataModes` (DAB/ADS-B predicates) are untouched — that's the state-machine
    surgery this item warned about, still outstanding.
    Original item: ModeSelector + StepPicker + the mode/step **state machine** in SDRScreen + `dataModes` (DAB/ADS-B). CarFM forces `wfm`; stripping the rest is state-machine surgery.
19. **The whole "Advanced SDR view"** — ControlsBar (978) + MenuSheet (1691) + DrumWheel + the entire non-car UI branch of SDRScreen. Only visible when NOT in CarFM. Biggest cut: means splitting SDRScreen's FM-wiring from its SDR-UI. Highest harm; likely the final step.
   - 🟨 **Escape hatch REMOVED** (2026-07-21): the CarFM→advanced route is gone —
     `advancedOpen` state, `onOpenAdvanced` prop, the SettingsPanel "Advanced SDR
     view" row, and the `◂ FM` return button are all deleted; `fmFaceActive` is
     now just `carFm`. Confirmed: CarFM can no longer reach the stock SDR UI.
   - ✅ **DONE (2026-07-30) — the component deletion.** All 24 components are
     gone and the `carFm` route param with them, so there is no longer a launch
     path that renders anything but the face. Superseded note follows.
   - 🗄️ **(superseded)** The SDR-UI branch
     (`!fmFaceActive`: ControlsBar, MenuSheet, DrumWheel, ModeSelector, VTSBar,
     CenterVfoButton, waterfall-appearance state) still EXISTS and still renders
     for **non-carFm / dev launches** (InstancePicker's remote-server connect
     paths — `InstancePickerScreen.tsx` navigate('SDR') without `carFm:true`, and
     TunerScreen/ServerMode). Deleting it means also cutting those dev entry
     points. Large, tsc+build-gated, on-device smoke test after. Noted, not done.

---

## Removal-order notes
- Do 🟢 first (each is independent and low-risk), then 🟡, then 🔴.
- **DecoderClient cluster (14–16)** must go together — chat + maps + decoders share it.
- **Backend-adjacent items (11, 12)** are parked pending your "decide backends later".
- After each cut: `tsc --noEmit` + a harness render of the CarFM face to confirm the FM pipeline still feeds it.

---

# Other open items (carried over — do not lose)

Threads raised across the project that are NOT part of the strip list.

## A. Design — device-only verification (a still harness can't check these)
- ⬜ **The three animations** on an on-device screen recording: hero prev/next
  swap FLIP (LOSSY #9, 520ms), preset-reorder FLIP (300ms), seek-digit slide
  (±14 / 0.25→1, ~200ms). Built to spec but never verified in motion.
- ⬜ **Font-scale ×1.3 / ×1.5** — no overlap; frequency stays amber (§10/§11).
- ⬜ **Peek-card callsign exposure** at true 360dp portrait (renders fine on wide;
  the tall sliver is just too narrow to read in a still).
- ⬜ **Post-strip smoke test** — after items 8/9, confirm Android Auto + app boot
  on a real APK (removed code was iOS/watch no-ops, but SDRScreen wasn't run).

## B. Rebrand / separation loose ends
- ⬜ **Rename/remove the internal `Vibe*` functional names** — `VibeDSP`,
  `VibeLocalSDR`, `VibeStream*`, `VibeServer`, `VibePowerModule`, `VibeMDNS`, the
  `vibedsp/` + `spyserver/` C++ trees, `vibesdr.local` mDNS host, the lowercase
  `vibeserver` detection marker. These were left as-is during the rebrand; it was
  NOT confirmed you wanted them kept (assistant assumed it). LARGE + risky: the
  Android package rename showed the JNI symbols must move atomically or the app
  crashes (UnsatisfiedLinkError), and the `vibeserver`/`vibesdr.local` markers are
  load-bearing for server detection. Do as a deliberate, tsc+build-gated pass.
- ✅ **DONE — EAS `projectId` + `owner: stuey3d`** removed from `app.json`. They
  pointed at the original author's Expo account. Local gradle builds don't care;
  run your own `eas init` if you ever want cloud builds.
- ⬜ **Internal docs still say "VibeSDR"** — the remaining root `BRIEF-*.md`
  (SpyServer ×2, FM-DX adapter, the two URI-scheme briefs) and
  `BUGFIX-vibeserver-squelch-indication.md`. These describe subsystems that are
  still here, so they're kept; only the naming is inconsistent. The store notes,
  `files/*.md` and the three feature briefs for things CarFM doesn't do were
  deleted 2026-07-30.
- ✅ **DONE — served web-page branding.** `web/client/index.html` title, the
  MediaSession album and the recording filename prefix now say CarFM;
  `vibe_web_page.h` is regenerated from them by `scripts/build-web.mjs`.
- ⬜ **`APPSTORE-EXCEPTION.md`** — Stuart's GPLv3 §7 store-distribution exception;
  moot for an Android-only fork. Decide keep vs remove.
- ⬜ **README positioning** — currently "a fork of VibeSDR, a mobile SDR receiver"
  (what the code is). If CarFM is really the *car FM radio* product, give the
  positioning and it gets refocused.

## C. About screen — REPLACED, not just edited
`AboutOverlay.tsx` was deleted with the SDR chrome on 2026-07-30: it was only ever
reachable from the SDR menu, which CarFM never shows. That disposed of the
inherited content (Stuart's first-person origin story, VibeSDR's App Store /
TestFlight changelog) without anyone having to rewrite it.
- ⬜ **Credits + GPL-3.0 notice have nowhere to live.** The settings panel shows
  `CarFM · v0.9.2 · FCC station data as of …` — a version line, not a licence
  notice or an upstream attribution. For a GPL fork that's worth an About row in
  the CarFM settings sheet. Needs your call on wording.

## D. Logos — future polish (feature works; these are refinements)
- ⬜ **Logo sizing / fit** — better optimize how fetched logos are sized and laid
  out in the tiles (wide wordmarks vs square marks, padding, `resizeMode`, upscale
  of small hits). Deferred by request; the search + assign + display pipeline is
  working as of 2026-07-20.

## E. Performance / "disconnect what we aren't using" — future review
Findings from the 2026-07-21 perf pass. What was safe was done; the rest is here
so it isn't lost.
- ✅ **DONE — live-station equality gate.** `setLiveStation` now returns `prev`
  when nothing displayed changed (`liveStationEqual`), so redundant RDS-RadioText
  ticks (several/sec) no longer re-render the SVG-heavy face. (SDRScreen.tsx.)
- ⚠️ **The spectrum WebSocket CANNOT be disconnected in CarFM — it carries RDS.**
  Important correction: for the local-hardware FM path the `type:"rds"` control
  messages (station name, RadioText, PTY, TP/TA, PI, stereo) are multiplexed on
  the **same spectrum WS** that carries the FFT waterfall frames
  (`UberSDRClient.ts` `_handleSpectrumMessage`, ~L993–1035). Killing the socket
  would gut the face. The socket stays.
- ⬜ **FFT-frame throttle (the real, bounded lever).** The FFT *frames* are still
  waste behind the face (no waterfall). The existing `set_rate` divisor
  (`UberSDRClient.setRateDivisor`) can throttle them toward zero **while keeping
  the socket open for RDS**. Unverified assumption: the shim keeps emitting
  `type:"rds"` when FFT is throttled (server-side `user_spectrum_websocket.go` —
  not in this repo). Needs an on-device check before trusting. Smaller win than a
  disconnect; the per-frame decode/GC cost drops in proportion to the divisor.
- ⬜ **Background-timer audit under carFm.** Most candidates are already off or
  are actually used, so DON'T gate blindly: learned-bookmarks poll (30s,
  `if (isLocal)` — RUNS in carFm, but feeds the "what this aerial hears" list, may
  be used by NearbyPicker); server-bookmarks (10min) and EiBi (10min) are gated
  off for local/disabled; decoder spot-flush only starts with a decoder active.
  Confirm each is genuinely unused in carFm before touching.
- ⬜ **Child React.memo pass ("Fix 2").** Redraw only the changed leaf when the
  face does re-render (Tell/SignalWaves/StereoWave/LogoTile). Parked pending an
  on-device profile after the equality gate — riskier (silent memo failures,
  stale-UI bugs) and not verifiable in a still harness.
