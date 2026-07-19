# CarFM strip-down plan

Goal: reduce the VibeSDR codebase to the CarFM car-FM-radio experience. Ranked by
**harm** = how likely removing the item breaks CarFM (its FM pipeline / build) or
demands risky surgery. Work top-down (🟢 first). Scope decisions already made:
**keep all receiver backends for now**; **full iOS removal**.

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
2. **si470xTuner.ts** — dead (zero importers; only a disabled SettingsPanel row names `'si470x'`). Delete unless Si470x USB tuner is on the roadmap.
3. **`app.json` → `expo.ios` block** — config only.
4. **`ios/` directory** (incl. `VibeSDRWatch/` Apple-Watch app, 3 MB) — Android build never touches it; JS native names are satisfied by the Kotlin modules.
5. **`modules/vibe-local-sdr/`** — the iOS pod + prebuilt `.a` + `build_ios.sh`. iOS-only. (Keep `android/.../cpp` — `build_ios.sh` referenced it, but Android needs it.)
6. **`Platform.OS === 'ios'` cosmetic branches** — App.tsx, modals (ChatDrawer, FreqModal, PasswordModal), `mdns.ts`. Simplify to the `else` path. Mechanical.
7. **BrowserOverlay.tsx** — one small SDRScreen-only overlay. Clean lift-out.

## 🟡 MODERATE harm — bounded surgery (inline overlays / shared screens / iOS wiring)
8. **Apple Watch** — `watchProvider.ts` (~45 KB) + `watchBoot.ts`. iOS-only, but invoked from App.tsx **boot logic**, SDRScreen (~30 calls), TunerScreen (~15), WaterfallView; `watchBoot.claimed` is also read by the **Android carFm boot branch** (App.tsx:288). Untangle the boot gate carefully.
9. **Siri + CarPlay** — iOS voice/car blocks in SDRScreen (~186–262, 1491, 1904, 1910). Bounded, but the **Android Auto** side is shared — keep that when cutting CarPlay.
10. **Recording** — RecordingsOverlay.tsx + AudioSheet.tsx (12 SDRScreen refs). Shared with **TunerScreen** — edit both call sites. Keep AudioPlayer/`VibePowerModule`.
11. **Browser/server-sharing screens** — ServerModeScreen + RtlTcpServerScreen (+ rtlTcpServer, vibeServer, vibeAuth, mdns). Clean screen deletes, but **backend-adjacent** (you deferred backend decisions) → confirm before cutting.
12. **FM-DX client** — TunerScreen + FmdxDial (+ FmdxAdapter, fmdxDirectory). Clean screen-level removal, but FM-DX is a **reception source you deferred** → decide as a set.
13. **VTS + HF bookmarks** — VTSBar.tsx + services `stations`, `eibi` (shortwave schedules), `userBookmarks`. HF/ham band-plan engine, no FM role.

## 🔴 HIGH harm — deep SDRScreen surgery / shared pipeline (do last, carefully)
14. **Decoders** — DecoderPanel + DecoderImageCanvas + `DecoderClient` + native `cpp/decoders`. **76 SDRScreen refs** — the most coupled subsystem. `DecoderClient` is the shared backbone for **decoders + chat + map spots**, so items 14/15/16 must be planned together.
15. **Chat** — ChatDrawer.tsx + DecoderClient chat transport. Shared with TunerScreen; rides on DecoderClient.
16. **Maps & aircraft** — MapOverlay.tsx + AircraftPanel.tsx. Shares DecoderClient spot rows.
17. **GPU waterfall** — WaterfallView.tsx (1353 LOC, inline Skia shaders). **39 SDRScreen refs**, ~40 wired props; also read by watchProvider. Hidden under the CarFM overlay anyway.
18. **Non-FM demod modes** — ModeSelector + StepPicker + the mode/step **state machine** in SDRScreen + `dataModes` (DAB/ADS-B). CarFM forces `wfm`; stripping the rest is state-machine surgery.
19. **The whole "Advanced SDR view"** — ControlsBar (978) + MenuSheet (1691) + DrumWheel + the entire non-car UI branch of SDRScreen. Only visible when NOT in CarFM. Biggest cut: means splitting SDRScreen's FM-wiring from its SDR-UI. Highest harm; likely the final step (and gated on whether CarFM keeps an "advanced" escape hatch at all).

---

## Removal-order notes
- Do 🟢 first (each is independent and low-risk), then 🟡, then 🔴.
- **DecoderClient cluster (14–16)** must go together — chat + maps + decoders share it.
- **Backend-adjacent items (11, 12)** are parked pending your "decide backends later".
- **watchProvider (8)** is the trickiest 🟡 because of the App.tsx boot gate — treat it as its own careful pass.
- After each cut: `tsc --noEmit` + a harness render of the CarFM face to confirm the FM pipeline still feeds it.
