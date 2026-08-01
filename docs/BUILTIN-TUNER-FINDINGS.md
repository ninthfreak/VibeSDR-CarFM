# Built-in FM Tuner (com.nwd) — Scouting FINDINGS

Reverse-engineering scout for **Backend E** (the head unit's built-in FM tuner),
per `docs/design/handoff/TUNER-BACKENDS-ADDENDUM.md §6` and the built-in-tuner
scouting addendum. Interoperability RE of the interface for driving the tuner
from our own UI. Static analysis only — no decompiled code, APKs, or firmware are
redistributed; the map below is a description of the interface, not vendor source.

**Important correction to the scouting brief:** that brief targeted FYT/DUDUOS
`com.syu.ms` (a numeric register/command scheme). This unit is a **different
firmware family — `com.nwd.*`** — and exposes a clean, **named AIDL** service
instead. The whole "find the numeric IDs" problem does not exist here.

## Sources analyzed (from the unit, static only)
- **`com.nwd.radio.service` (v214, 2025-01)** — the module server / bound service. PRIMARY.
- **`com.nwd.radio` (v1103)** — the stock FM app (a known-good client).
- `com.android.mtp` — unrelated (media transfer); ignored.

Tooling: `androguard` 4.1.4 (manifest + AIDL signatures + decompile), `strings`.

---

## VERDICT: **GO** — core path validated on-device ✅

All three feared blockers (bind permission, antenna power, RDS availability) came
back favorable, and the audio path is now **characterized** (MCU-routed analog +
a broadcast source switch — see Q_audio). No architectural risk is outstanding.

**On-device spike result (2026-07-21):** the `nwd-tuner-probe` app bound
`RadioService`, connected to the tuner, and **changed stations successfully** on
the real head unit. The bind/permission model, the AIDL method map, and tuning
are confirmed working against live hardware — not just static analysis. What's
still worth a closer look during the real backend build is the audio-source
switch behaviour and RDS callback fidelity under sustained use; the fundamentals
are proven.

## Wired into CarFM (2026-07-21)

The backend is now integrated (not just the spike). Pieces:
- **`NwdRadioModule.kt`** — RN module `NwdRadio`: `isAvailable` (PackageManager
  probe), `connect`/`disconnect` (bind + registCallback), `tune(mhz)`, `seek`,
  `setRdsEnabled`, `setAudioEnabled`; RadioCallback → DeviceEventEmitter events.
  Self-calibrates freq scale + band from `getCurrentFrequency` on connect.
- **AIDL + parcelables** copied into the app tree; `buildFeatures { aidl true }`
  added (AGP 8); `<queries><package .../></queries>` added for Android 11+ bind
  visibility; module registered in `VibeStreamPackage`.
- **`src/services/nwdRadio.ts`** — typed JS wrapper + event subscriptions.
- **SettingsPanel** — the "NWD / NOWADA built-in radio" row now self-detects.
- **SDRScreen** — on a **tunerless carFm launch** (no dongle), if NWD is present
  it binds, clears the tuner-error pill, and drives the face from the callback
  events; `onTuneHz` routes to `nwdTune` while NWD is active.

**Built but NOT compiled/run here** (no device/Android build in this env) — needs
an on-device build to confirm. What to watch:
- **Audio**: `setAudioEnabled(true)` fires the experimental source-switch
  broadcasts (exact `EXTRA_MEDIA_SOURCE` still unknown) — confirm sound comes out.
- **Signal meter reads low/empty**: NWD's mapped callbacks expose no RSSI, so
  `fmSignalDb` isn't fed on this path. Left honest (not faked). Open item: find a
  signal source (maybe `notifyState`/`getRadioState`, or a poll) on-device.
- **Seek** currently retunes to the next FCC-DB station (via `onTuneHz`), not the
  hardware `seek()` — works, but hardware seek would catch non-DB stations.
- **Picker routing**: NWD auto-activates in the tunerless case; the settings
  picker selection is still cosmetic (doesn't force NWD when a dongle is present).

---

## Q1 — Binding (mechanics)  ✅ clean
- Bind service **`com.nwd.radio.service.RadioService`** via intent action
  **`com.nwd.radio.service.ACTION_RADIO_SERVICE`**.
- The binder implements the AIDL **`com.nwd.radio.service.RadioFeature`**.
- Register **`com.nwd.radio.service.RadioCallback`** via `registCallback(...)` for
  push events. No numeric module/command IDs — named AIDL methods.

## Q6 — Permissions / signature  ✅ GREEN (the hard gate is open)
- `RadioService` declares **no `android:permission`** → an **ordinary,
  unprivileged app can bind it**. No signature/system wall.
- The service itself holds the hardware perms (`ACCESS_FM_RADIO`,
  `MODIFY_AUDIO_ROUTING`, `CAPTURE_AUDIO_OUTPUT`, `RECORD_AUDIO`) — it brokers the
  hardware, so the client doesn't need them to *control* the radio.

## Q2 — Operation map (`RadioFeature`)  ✅ complete
| Operation | Method |
|---|---|
| Tune | `setCurrentFrequency(int freq, byte band, int ?)` |
| Current freq | `getCurrentFrequency() : Frequency` |
| Seek (dir) | `seek(boolean)` |
| Full scan | `search(boolean)` ; `AMS()` (auto-store) ; `INTRO()` (intro scan) |
| Band | `changeBand()` (+ band arg on setCurrentFrequency) |
| Band plan | `getRadioPoint() : RadioPoint[]` (min/max/step) |
| Stereo | `isHasStrero()` `isStreroOn()` `setStreroOn(bool)` |
| RDS state | `getRDSState(int)` `setRDSState(byte, bool)` |
| RadioText | `getRtMessage() : String` |
| PTY | `getPTYType():byte` `setPTYType(byte)` `getPrefabPTYType`/`setPrefabPTYType` |
| Presets | `getPrefabFrequency() : Frequency[]` ; `saveCurrentFrequency(byte)` ; `prefeb(bool)` |
| Local/DX | `isNearOn()` `setNearOn(bool)` |
| Raw command | `sendRadioCommand(byte, byte)` (escape hatch — opcodes TBD) |
| State | `getRadioState():byte` `getRadioType():int` `getCurrentScanState():int` |
| Register | `registCallback(RadioCallback)` / `unRegistCallback(...)` |
| Audio/service | `isRadioBackServiceOn()` `setRadioBackServiceOn(bool)` |

## Callbacks (`RadioCallback`, push)
- `notifyCurrentFrequency(byte band, int freq, String psName, int ?)`
- `notifyRtMessage(String)` — RadioText
- `notifyCurrentPTYType(byte)` · `notifyCurrentIsTA(bool)`
- `notifyStereo(bool)` · `notifyStereoOn(bool)` · `notifyRdsShowState(bool)`
- `notifyRadioScanState(int)` · `notifyRadioPoint(RadioPoint[])`
- `notifyPrefabFrequency(Frequency[])` · `notifyState(byte)` · `notifyNearOn(bool)`
- `notifyRDSStateChange()`

## Data classes
- `Frequency { byte mBandType; int mFrequency; String mPSName }`
- `RadioPoint { int mFrequencyMin; int mFrequencyMax; int mFrequencyStep }`

## Q3 — RDS delivery model  ⚠️ decoded fields; no raw blocks; no PI
- We get **decoded** PS name, RadioText, PTY, TA — as strings/values, pushed via
  `RadioCallback`. The `Frequency` object even carries `mPSName`.
- **No raw 16-bit RDS block groups.** So the app's shared block-level decoder and
  the **RT+ / redsea pipeline cannot run on this backend** — RadioText is only the
  raw RT string (no artist/title split unless the MCU itself does RT+).
- **PI is not exposed** via the AIDL. The service uses PI internally (`pi=`,
  `pi is same`, `pi not match` log strings) to detect station changes, but there
  is no `getPI()`.
- **Impact on our app:** our callsign/logo identity resolves the callsign **from
  the dial frequency via the FCC DB** (already implemented), so station identity +
  logos work here **without** PI. What we lose is RT+ song/artist metadata.

## Q4 — Antenna / hardware enables  ✅ service-brokered (low risk)
- Antenna + amplifier power are **service-side commands**: `CMD_SET_RADIO_ANTENNA`,
  `ATTR_ANTENNA_POWER_SWITCH`, `antenna_power_switch`, `SendMcuAmpAntennaState`,
  `KEY_LOW_POWER_AMPLIFIER`, plus the generic `sendRadioCommand`.
- Because we bind the **same service the stock app uses**, antenna/amp power is
  handled by the MCU/service regardless of which client is bound. The classic
  "third-party FYT radio has bad reception" problem comes from apps that *bypass*
  the service and poke hardware directly — not applicable here. **Confirm reception
  parity on device.**

## Q_audio — Audio path  ✅ characterized (device-confirm needed)
FM audio is **analog, routed by the MCU to the amplifier on the `STREAM_MUSIC`
channel** — not captured/played in software. The stock app controls it with:
- **MCU audio-source switch via broadcast intents** (a "source manager" pattern):
  `com.nwd.action.ACTION_CHANGE_SOURCE` / `ACTION_REQUEST_CHANGE_SOURCE` with
  `EXTRA_MEDIA_SOURCE`, plus `APP_SRC_IN` / `APP_SRC_OUT` and `CURRENT_SOURCE`. An
  app announces itself as the active media/radio source; the MCU then routes the
  tuner audio to the amp. (Stock logs: `FmRadioServiceHandler pre power Up
  current_source =`, `registCallback…InitFM…current_source =`.)
- **Mute/unmute** `STREAM_MUSIC` (`arm radio (un)mutestream STREAM_MUSIC`).
- **Android audio focus** (`requestAudioFocus`/`onAbandon`, `MSGID_AUDIOFOCUS_CHANGED`).

**Recipe for our backend:** become the radio source (broadcast) → `setCurrentFrequency`
(RadioFeature) → unmute + hold audio focus; on teardown, `APP_SRC_OUT` / change
source back. All reachable from an ordinary app — no capture pipeline, no USB
audio. The `ijkplayer`/ffmpeg libs in the stock app are for *other* media, not FM.

**Not a blocker**, but two things need the device: (a) the exact `EXTRA_MEDIA_SOURCE`
value for the radio source, and (b) that the switch actually yields audio when the
source owner is *our* app rather than `com.nwd.radio`.

## Q5 — Arbitration with the stock app  ⏳ mostly mapped
- Acquire: `registCallback` + announce source-in (`APP_SRC_IN`) + audio focus.
- Release: `unRegistCallback` + `APP_SRC_OUT` + abandon focus (`onAbandon`).
- `setRadioBackServiceOn(bool)` keeps radio audio alive in the background.
- Device check: confirm the stock app goes dormant (releases the tuner) while we
  hold it, and there's no scan double-trigger.

---

## OPEN — to resolve (deeper analysis / device)
- **Exact radio source id** (`EXTRA_MEDIA_SOURCE` value) — decompile the stock
  app's start/resume source-switch call.
- **Tune units** — `Frequency.mFrequency` int scale (kHz vs 10 kHz vs MHz×100);
  `getRadioPoint()` reveals it live (also derivable from the stock tune calls).
- **`sendRadioCommand` opcodes** — the byte pairs (antenna, AF, region, …).
- **`setRDSState(byte,…)` selector** — which byte selects RDS vs AF vs TA vs REG.

## Proof-of-life spike (proposed, NOT the full backend)
Smallest app that validates the map on hardware:
1. Bind `ACTION_RADIO_SERVICE`; get `RadioFeature`.
2. `getRadioPoint()` (band plan → confirms units) and `getCurrentFrequency()`.
3. `registCallback(...)`; `setRDSState(...)` on.
4. `setCurrentFrequency(<local station>, FM, …)`; log the callback (freq, PS, RT).
5. **Confirm audio comes out** (and whether a source switch is needed) + reception.
Only after the spike passes should the full `TunerSource` backend be written.

---

# Hardware identity, vendor & compatibility

Written for the eventual product/distribution question: *which head units does the
built-in-tuner backend actually support, and how would a stranger know if theirs
qualifies?* (Web research 2026-07-21; sources at the bottom.)

## What "NWD" is
- **NWD = NOWADA**, a Chinese aftermarket head-unit **firmware/OEM vendor**. It is
  one of a known set of firmware houses (NWD, OH, HDKJ, HR, JYT, …) whose
  three-letter codes appear in head-unit firmware filenames
  (e.g. `K2001N_NWD_S212701`, `t3_k2001_nwd`, build host `NWD-SERVER-N254`).
- The tuner interface we reverse-engineered — **`com.nwd.radio.service`** — is
  **NOWADA firmware's radio service**. So supporting it = supporting head units
  that ship NOWADA firmware exposing that service.

## Chipset correlation (but NOT the compatibility axis — read below)
- NOWADA/NWD units are commonly **Allwinner T3 / T3L** (ARM Cortex-A7 ~1.2 GHz,
  `sun8iw11p1`). Newer NOWADA units also appear on **Rockchip RK3562**.
- Model designations seen in the wild: **K2001, K2001N, K2001O, K2101, P1, P9**,
  and rebrands such as **Seicane NWD-K2101**; Android **4 → 13**. These are
  widespread, cheap, universal double-DIN aftermarket units.

## ⚠️ The compatibility axis is the FIRMWARE VENDOR, not the chipset
This is the single most important finding for distribution. **Do not advertise
"Allwinner support" — it would over-promise.** Two units with the *same* Allwinner
T3 chip expose the FM tuner through *completely different* APIs depending on whose
firmware they run:
- **NOWADA/NWD firmware** → `com.nwd.radio.service` (clean named AIDL — what we support).
- **TopWay firmware** (e.g. MST768 boards) → `android.tw.john.TWUtil` / `TWClient`
  (proven by the open-source `ivvlev/CarRadio` app targeting that platform).
- **FYT / DuduOS firmware** → `com.syu.ms` (a numeric register/command scheme;
  this was the *original* scouting target before we found this unit runs `com.nwd`).

So the true statement is: **"supports head units running NOWADA (NWD) firmware."**
The chipset is a helpful hint for a buyer ("often Allwinner T3 units like the
K2001/K2101"), not the guarantee.

## How the app should decide support at runtime (and how a stranger checks)
- **Runtime capability detection is the mechanism.** The app queries Android for
  whether **`com.nwd.radio.service`** resolves (via `PackageManager` + the
  `<queries>` entry already declared in the probe manifest). If it resolves →
  offer the built-in-radio backend; if not → hide it. No hard-coded model
  whitelist to maintain, and no false promises.
- **For a user figuring out if their unit qualifies:** it qualifies if the
  built-in-radio option lights up in the app. (Under the hood: their firmware
  provides `com.nwd.radio.service`.) A rough pre-check is "does the unit's factory
  radio app / firmware come from NOWADA (NWD)?" — but the app's own detection is
  the authoritative answer.

## Suggested store-listing / README language (drop-in)
> **Built-in FM radio** works on head units running **NOWADA (NWD) firmware** —
> commonly Allwinner T3-based aftermarket units (e.g. K2001, K2101, P1/P9, and
> Seicane NWD-* rebrands). The app auto-detects whether your unit's tuner is
> supported and only shows the built-in-radio option when it is. Units from other
> firmware vendors (FYT/DuduOS, TopWay, …) are not yet supported. RTL-SDR USB
> tuners are supported on any unit.

## Naming decision (locked)
- **serverType id:** `nwd` (names the protocol/firmware — the real compatibility
  line — not the misleading chipset).
- **Adapter class:** `NwdTunerAdapter` (sits alongside `FmdxAdapter` / `OwrxAdapter`).
- **User-facing label:** "Built-in FM radio".
- Referred to informally as **NWD / NOWADA**.

## Expansion roadmap (per-vendor adapters, NavRadio+ model)
The commercial reference app **NavRadio+** covers many units by shipping **one
tuner backend per firmware vendor**. Mirror that: keep `NwdTunerAdapter` as the
first of a family. Candidate next backends, each a distinct interface:
- **FYT / DuduOS** — `com.syu.ms` (numeric register/command). A disabled/greyed
  placeholder is already in the CarFM settings tuner-source picker.
- **TopWay** — `android.tw.john.*` (open-source client exists to crib from).
- Others (OH, HDKJ, HR, JYT firmware) — unknown interfaces; investigate if demand.

## Sources
- Seicane NWD-K2101 (Allwinner T3 NWD unit): https://www.ebay.com/itm/286612639617
- NOWADA RK3562 head unit (vendor confirmation): https://www.amazon.com/Universal-Android-Wireless-CarPlay-Navigation/dp/B0F8HV773F
- NWD G5 car radio: https://www.aliexpress.com/s/wiki-ssr/article/nwd-g5
- XDA — Allwinner quad-core T3 K2001N-NWD: https://xdaforums.com/t/allwinner-quad-core-t3-k2001n-nwd.4240581/
- XDA — firmware K2001_NWD_S212109 (sun8iw11p1): https://xdaforums.com/t/firmware-update-help-allwinner-t3-k2001_nwd_s212109-sun8iw11p1.4507007/
- ivvlev/CarRadio — Allwinner T3 / TopWay `android.tw.john.*`: https://github.com/ivvlev/CarRadio
- NavRadio+ (multi-vendor reference app): https://play.google.com/store/apps/details?id=com.navimods.radio

---

# Deep dive — 2026-07-23 (on-device logs + full decompile)

Combines two things the earlier scouting pass did not have: **real drive logs**
from the target unit, and a **decompile of both the stock app AND the service's
internal managers** (not just the client-facing AIDL). This corrects a couple of
earlier conclusions. Static analysis via androguard on `com.nwd.radio` (stock
app) and `com.nwd.radio.service` (RadioService).

## Chip / stack identity (new)
- The FM tuner is **Spreadtrum / UNISOC** class: native JNI classes
  `SprdFmNative` and an "arm" `RadioNative` in *both* APKs. The active manager on
  this unit is **`ArmRadioManager`** (there are also `AWRadioManager` = Allwinner
  and `SprdFMFeature`/`SprdRadioManager` variants the service can select).
- Closer to a datasheet than we were: search UNISOC/Spreadtrum FM radio HAL
  (`SprdFmNative`, `readRds`, `getLrText`, `readRdsBler`) for chip specifics.

## The service's REAL native capability (service-internal)
`RadioNative` (JNI, inside the service) exposes far more than the AIDL does:
`readRssi()` (true signal), `readRds()` / **`readRdsBler()`** (raw RDS blocks +
block-error rate), `getLrText()` (RadioText), `getPs()`, `stereoMono()` /
`setStereoMono()`, `seek/tune/seeknew/tunenew`, `openDev()`. So the hardware CAN
do real RSSI and raw RDS — this **corrects the earlier "no raw blocks" note**
(they exist natively; they're just not surfaced over the AIDL).

## What the AIDL actually exposes vs. what it doesn't
- `RadioFeature$Stub.onTransact` never calls `readRssi` — **true signal strength
  is NOT reachable over the AIDL we bind.** The stock app gets its meter value by
  calling its *own* bundled `SprdFmNative.getRssi()` native method, which needs
  the vendor `.so` + device access → **not reachable by an unprivileged 3rd-party
  app.** ⇒ CarFM's DB+GPS *estimate* is the correct call; there is no clean live
  signal to be had.
- `notifyRtMessage` / PS / stereo callbacks ARE emitted to bound clients
  (`RadioService.notifyCallBack`) — so RadioText *is* reachable in principle.

## Why we never get PS / RadioText — the gate (KEY finding)
The RDS decode loop is `ArmRadioManager$8::run` → `analyzeBuiltInRadioRds()`,
which early-returns unless:

```
mbRdsEnable && (mbDeviceOpen || isRadioSource())
```

- **`isRadioSource()`** = content-provider setting **`mcu_current_source == 4`**
  (4 = FM). The **MCU writes** this on a real audio-source switch; the service
  only *reads* it, and nothing in the service writes it. So "RDS via being the
  source" requires the actual MCU source switch — the same broadcast that, on
  device, launches the stock app.
- **`mbDeviceOpen`** = set by `openDevice()` → `RadioNative.openDev()`, called
  from `SprdFMFeature.powerUp` / `InitFM` (the FM power-up sequence).

⇒ As a *passive bound client* (not the source, device not powered up for us),
`analyzeBuiltInRadioRds` early-returns every tick → PS/RT never populate and
`getRtMessage()` stays `''`. **This is the wall, and it's a state gate, not a
hardware limit.**

## On-device empirical (drive logs 2026-07-21 … 07-23)
- **`arg`** in `notifyCurrentFrequency` = **1-based FACTORY-preset slot index**
  (`getPrefabFrequency()` order), `-1` if the freq isn't a factory preset.
  Confirmed: 101.5→1, 92.1→2, 102.1→3, 105.9→4, 88.7→6; 104.1 (real, non-preset)
  and all dead channels → −1. **NOT signal, NOT a lock indicator.**
- **`isStreroOn()`** getter is **stuck `true`** (reads true even on dead air).
  The **`notifyStereo` callback is the trustworthy source** — it flaps with the
  real signal — but is intermittent (fires on change; silent on a stable signal).
  CarFM now drives stereo from the debounced callback, not the poll.
- **`radioState`** is a global flag (0 idle / 1 active-session), not per-channel;
  useless as a lock metric. No per-channel lock metric exists at the AIDL level.
- Enabling RDS selectors 0..3 (`setRDSState`): only 1 & 2 stick; still no text —
  consistent with the source/device gate above, not a selector problem.

## Levers still worth trying (for RadioText)
Ranked; all need on-device testing:
1. **Open the device without becoming the source** — find a client-reachable
   call that triggers `openDevice()`/`InitFM` (→ `mbDeviceOpen=true`), which
   unlocks `analyzeBuiltInRadioRds` even when `mcu_current_source != 4`. Best
   case: RadioText with no stock-app hand-off.
2. **Read `mcu_current_source`** (content provider) to *detect* when FM is the
   live source, and only then expect RDS.
3. **Write `mcu_current_source = 4`** — likely permission-gated and/or instantly
   overwritten by the MCU (it owns the real routing), but cheap to test.
- **Signal (RSSI) and raw RDS/BLER** are native-only (vendor `.so` + device
  access) → out of reach without root; not worth chasing for a normal app.

# Deep dive — 2026-07-25 (drive log `nwdprobe-20260725-205108`)

Two concrete findings from the latest probe run, and the probe was refocused to
chase what's still open (it no longer re-runs the known-good path).

## RadioText: we DID become the source, yet still no text
The RUNG-1 trigger (`ACTION_APP_IN_OUT app_id=8`) drove `mcu_current_source → 4`
and audio played — i.e. **we satisfied `isRadioSource()`** — but every
`NewRdsManager.setCurrentFrequency` callback still logged **`mRdsEnable=false`**,
and PS/RT/PTY stayed empty for 24s on two strong stations. So on THIS unit
(AllWinner `AWRadioManager`/`NewRdsManager` path, not the Spreadtrum
`ArmRadioManager` the earlier decompile covered) the live blocker is the **RDS
enable flag**, not the source gate. Next levers to try (now in the probe,
Investigation A): `setRadioBackServiceOn(true)` + re-assert source; and finding a
client-reachable call that sets `mRdsEnable`/opens the device.

## Audio-off: EXIT_ARM_FM does not stick — the MCU re-powers FM
`ACTION_EXIT_ARM_FM_RAIDO` stopped audio only briefly; within ~1s
`isMusicActive` went true again because **`mcu_current_source` stayed `4`
(Radio)** — the MCU re-inits FM. ⇒ Stopping FM requires the active **source** to
be released/switched, not just an FM exit.

# CONFIRMED — 2026-07-26 (probe `nwdprobe-20260726-122129`, focused run)

Three decisive results from the refocused probe:

- **RadioText — still walled.** Even as the FM source (`mcu_current_source=4`),
  both levers (as-is; `setRadioBackServiceOn(true)` + re-assert source) left
  `mRdsEnable=false` and PS/RT/PTY empty. RadioText is not reachable by a bound
  client on this unit through any lever we have. CarFM stays on FCC-DB identity
  (no RT) — this is settled, not worth more chasing without root/native `.so`.
- **Seek — use `search()`, not `seek()`.** `radio.seek()` only nudges one 0.2 MHz
  step (landed on noise). **`radio.search()` is the real on-demand seek**: it scans
  and STOPS on the next station both ways (88.7→91.1, 91.1→88.7, clear audio), and
  it is NOT the preset auto-search (AMS). ⇒ `NwdRadioModule.seek()` now calls
  `search()`.
- **Audio-off — `REQUEST_CHANGE_SOURCE → 0` is the ONLY thing that sticks.**
  `EXIT_ARM_FM` ❌ (stayed on, src=4); `APP_IN_OUT operation=0` ❌ (stayed on,
  src=4); **`ACTION_REQUEST_CHANGE_SOURCE extra_source_id=0` ✅** → `music=false`,
  `src=0`, stayed off. ⇒ `setAudioEnabled(false)` now sends that; ON re-claims via
  `APP_IN_OUT app_id=8 operation=1` (src→4). (My earlier app-OUT guess was wrong;
  corrected to the proven winner.)

**App fixes shipped (now device-backed):** the CarFM power button never called
`nwdSetAudio` (only flipped the visual `off` state) — now wired. `setAudioEnabled`
ON = app-IN claim; OFF = source→0. `seek()` = `search()`.

## Ethics/scope
Interoperability RE of our own device's interface, read-only, local. Do not
redistribute decompiled code, modified APKs, or firmware.

---

# Steering wheel SOLVED — it is a BROADCAST, not a media/input key (2026-07-30)

Static analysis of `com.nwd.radio.service` v2.1.4 (`RadioService`, `ArmRadioManager`).
This overturns the whole earlier capture effort: two rounds of MediaSession work
(active+PLAYING session, then an audio-focus grab) and an
`Activity.dispatchKeyEvent` interceptor all logged **zero** events on-device,
because **the wheel never enters Android's input pipeline at all.**

## The real path
```
MCU  ──broadcast──►  com.nwd.action.ACTION_KEY_VALUE   (byte extra_key_value)
                     com.nwd.action.ACTION_TEST_KEY    (int  extra_key_value)
                          │
     RadioService.onCreate: registerReceiver(mPanelKeyListener, filter)
                          │        ^^^ NO permission argument — unprotected
                          ▼
     RadioService$4.onReceive → RadioFeatureAbs.handlePanelKey(byte)
                          ▼
     ArmRadioManager.handlePanelKey  — gated on
                          Settings.System "mcu_current_source" == 4 (FM)
```
Because the receiver is registered with **no permission**, any app can both
RECEIVE and SEND these broadcasts. CarFM now registers for them
(`NwdRadioModule.startPanelKeyWatch`) and can fire them (`sendPanelKey`).

## Panel-key dispatch table (verbatim from handlePanelKey)
| Key | Action | Key | Action |
|---|---|---|---|
| 4 | `changeBand()` | 46 | `AMS()` (auto-store) |
| 5, 60 | `search(up)` | 61 | `INTRO()` |
| 6, 59 | `search(down)` | **62** | **`prefeb(true)` — preset NEXT** |
| 16 | `seek(up)` | **63** | **`prefeb(false)` — preset PREV** |
| 17 | `seek(down)` | 72 / 73 | `changeFmBand()` / `changeAmBand()` |

## What `prefeb(boolean)` actually is
Not a mystery method: it is **preset next/previous**. It steps `mCurPrefNum`
(1..6), wraps into the next/previous BAND at the ends, then
`tuneStation(mPrefFrequency[mBandType][num-1])` and `saveRadioData()`. So the
wheel walks the **hardware** preset banks — 3 banks × 6 slots — which is exactly
the reported symptom (scrolling past the user's stations into unwanted ones).

## Presets are SOFTWARE, not MCU firmware
`ArmRadioManager` holds `mPrefFrequency[[Frequency]` plus a
`SharedPreferences mPreferences` and `saveRadioData()`. So the banks are Java-side
state persisted in the service's private prefs — not tuner firmware.

- `CleanFMPreFreData()` / `CleanAMPreFreData()` exist only on
  `com.nwd.radio.arm.allwinner.AWFMFeature` (Allwinner variant — NOT the
  `ArmRadioManager` this unit runs), and its sole caller is that class's own
  `startScanAsync()`. `SprdFMFeature` has `CleanPreFreData()`. **None is reachable
  over the AIDL**, and on this unit's manager they are not even the active code.
- ⇒ Blanking the banks from a 3rd-party app remains unavailable. But it is now
  moot AND undesirable: `prefeb` tunes `mPrefFrequency[..]` unconditionally, so a
  zeroed slot would tune to garbage rather than be skipped.

## The fix that follows
We cannot cancel a normal broadcast, so the service still jumps to its own slot.
But CarFM receives the SAME key and immediately steps ITS preset list
(`fmHwStepRef` → animated hero swap), so the app's order wins and it refuses to
walk past the end of the user's list. Verify: the diag line `panel key 62 (preset
next)` should appear on every wheel press.

## Ethics/scope
Interoperability RE of our own device's interface, read-only, local. Do not
redistribute decompiled code, modified APKs, or firmware.

## Cross-check against public prior art (web search, 2026-07-30)

Searched for independent confirmation of the panel-key broadcast and the wider
NWD/MCU picture. Summary: **the panel-key path above is not publicly documented
anywhere I could find**, but the surrounding architecture and — importantly — a
better answer to the wheel-suppression problem both are.

**No hits.** `com.nwd.action.ACTION_KEY_VALUE`, `extra_key_value`,
`handlePanelKey`, and the 62/63 preset codes return nothing relevant. Our
decompile appears to be an independent finding.

**Confirmed by others.** `kapi21/OpenRadioFM` (Apache-2.0) targets the same
family incl. "QS NWD" and independently uses `ACTION_CHANGE_SOURCE` /
`ACTION_REQUEST_CHANGE_SOURCE` for source switching (exactly our audio claim/
release), reports **18 preset slots**, and had to add retry/`DeadObjectException`
handling plus a broadcast-monitoring "shadow motor" because *"the AIDL service
collapses unpredictably"* — a robustness gap CarFM does not yet cover.

**New leads from that project, worth trying on our unit:**
- Settings keys `nwd_radio_current_freq` and `nwd_radio_current_source` — a
  cheaper, more reliable frequency feed than our 1.5s `getCurrentFrequency` poll,
  and a direct read of the source state (we currently read `mcu_current_source`).
- Their NWD MCU-frame work is explicitly *"proprietary/under research"*, so
  direct MCU framing is unsolved publicly too — consistent with our conclusion
  that tuner control is only reachable through the vendor service.

**The wheel-suppression answer we were missing: an AccessibilityService.**
OpenRadioFM's K706 path uses an accessibility service (`FactoryRadioHijackerService`)
to intercept physical radio-button and KeyEvent broadcasts, gated by a
`pref_a11y_forward_media_keys` preference. Android's `AccessibilityService.onKeyEvent`
receives key events **before** applications and **consumes** them when it returns
true (`android:canRequestFilterKeyEvents="true"` +
`accessibilityFlag="flagRequestFilterKeyEvents"`).

⇒ Our broadcast receiver *observes* the wheel but cannot cancel a normal
broadcast, so the vendor service still jumps to its own slot. An accessibility
service is the one documented mechanism that could actually **suppress** the
event. Caveat: it filters *key events*, and on this unit the wheel arrives as a
**broadcast**, not a key event — so it may not apply here at all. It is worth
testing only if the panel-key receiver proves insufficient, and it costs the user
a manual accessibility-permission grant.

Sources: github.com/kapi21/OpenRadioFM · developer.android.com AccessibilityService
· source.android.com/docs/automotive/displays/key_input · XDA NavRadio+ threads.

## Hardware preset sync REMOVED (2026-07-31)

With the wheel captured via the panel-key broadcast, CarFM drives its own preset
list and never reads the head unit's banks. The one-way sync (Settings → "Program
head unit") and the 18-slot ceiling are gone.

The argument for keeping it — "matching banks make the vendor service's
intermediate jump land on the same station, so there's no second tune" — does not
hold. The service's `mCurPrefNum` advances one slot per press and wraps through
ITS 18; CarFM's index advances one and wraps through the USER'S list length. They
only stay aligned if the list is exactly 18 AND both start at the same slot. With
6 presets the app wraps after 6 while the service sits at slot 7 — they diverge on
the first wrap, and never re-align. So programming the banks cannot reliably make
the two tunes match, "18" is not a meaningful boundary for anything, and the
seamless audio observed on-device comes from the correction being fast, not from
the banks agreeing.

Removed: SettingsPanel section + props, SDRScreen sync/compare state and the
`@carfm/nwd_preset_sig_v1` record, `nwdSyncPresets`, `NwdRadioModule.syncPresets`
and its orphaned `gotoBand` helper. There is now NO app-side preset cap — the
count is the user's choice; the only soft costs are one wheel press per preset
when cycling, and one logo resolve per preset at startup.

## Signal + RadioText: a channel that BYPASSES the AIDL (2026-07-31)

Re-examined the service for anything genuinely unexplored. Everything below is
static analysis of `com.nwd.radio.service` v2.1.4.

### Closed off for good
- **The AIDL is exactly what we reconstructed.** `RadioFeature$Stub`'s
  TRANSACTION_* constants are 1..30 in our declared order — no hidden method, no
  mis-ordering. Nothing on it exposes signal.
- **`RadioCallback` is complete too** — all 14 notify* methods, matching ours.
  There is **no signal/RSSI callback at all**, so signal was never going to be
  pushed to us.
- **Outgoing broadcasts carry no signal or RT.** `ACTION_SEND_RADIO_FREQUENCE`
  (+`_NEW`), `ACTION_SEND_SCAN_RADIO_FREQUENCE` and `ACTION_RADIO_STATE` carry
  only frequency, band, preset number and state. `nwd_radio_state` is written to
  the settings table; no signal/RT key exists.

### Why RadioText has always been empty
`ArmRadioManager.getRtMessage()` is `return "";` — **hardcoded**. The other three
managers (`AWRadioManager`, `SprdRadioManager`, `RadioManager`) return a real
`mRtMessage`. RT was never gated behind a setting we failed to flip; on this
unit's manager the method is a stub. Also note `setRDSState(byte which, bool)`
only acts on which==1 (AF) and which==2 (TA) — our `which=0` call sets no flag.

### The unexplored channel — and it has both
`RadioService.onCreate` picks `ArmRadioManager` when
`RadioJsonNative.getRadioIc().equals("SI47925")` — a **Silicon Labs Si4792x**
tuner. `RadioJsonNative` does NOT use the AIDL or JNI: it talks to the MCU in
JSON through a **vendor framework class**, by reflection:

```java
ReflectUtil.invokeStatic(android.os.Hardware, "parseJson", String.class, json)
  {"MODULE":"radio","ACTION":"get","IC":"query"}    -> "SI47925"
  {"MODULE":"radio","ACTION":"get","RSSI":"query"}  -> signal strength (string int)
  {"MODULE":"radio","ACTION":"get","RDS":"query"}   -> 16 hex chars = ONE raw RDS
      group (4 blocks x 2 bytes); "0000000000000000" means no data this poll
```
(also `tune`, `setRadioBand`, `setRadioPower`, `setStereoMono`, `setRadioVolume`.)

`android.os.Hardware` is a ROM addition, not AOSP — so it is likely ABSENT from
the hidden-API blocklist (which is generated from AOSP), and the framework is
loaded into every app process. If reflection reaches it, this gives the two
things the AIDL cannot: **true signal strength**, and **raw RDS groups** from
which RadioText can be decoded ourselves.

**DISPROVEN ON DEVICE, 2026-07-30 21:23 — this route is closed.** The probe ran
read-only against `android.os.Hardware` twice:

- Run 1: `getMethod("parseJson")` → `NoSuchMethodException`. Inconclusive on its
  own, since `getMethod` sees only public methods while the vendor's own
  `ReflectUtil` uses `getDeclaredMethod` + `setAccessible`.
- Run 2: added the `getDeclaredMethod` fallback **and** dumped every method the
  class declares. `getDeclaredMethod("parseJson", String)` → `NoSuchMethodException`
  (that call searches the class's own declarations at every visibility), and the
  180-method dump contained nothing JSON-shaped. The only String-in method is
  `setDSP_ak7604_status(String)`, an AK7604 DSP setter.

The class itself EXISTS (the lookup succeeded — the failure was the method, not
`ClassNotFoundException`). `parseJson` simply is not on it on this ROM.

See the 2026-07-31 section below for why: that channel belongs to the Si4792x
code path, which this unit does not take. Do NOT re-add speculative `parseJson`
calls without new evidence.

---

# The REAL transport found — `com.nwd.app.NwdFmManager` (2026-07-31)

Static analysis of `com.nwd.radio.service` v2.1.4 with androguard 4.1.4, run after
the `android.os.Hardware` probe came back negative. This resolves the open "find
the real MCU transport" question and explains every earlier dead end.

## Why the JSON channel was never going to answer

`RadioJsonNative.parseJson()` does call
`ReflectUtil.invokeStatic(android.os.Hardware, "parseJson", …)` — the earlier
reading of that call was correct. What matters is how `ReflectUtil` fails:

```java
public static Object invokeStatic(Class, String name, Class[], Object[]) {
    Method m = ReflectUtil.getMethod(cls, name, argTypes);
    if (m == null) { Log.d(TAG, "Can't find " + name + " interface"); }   // returns null
    else { m.setAccessible(true); return m.invoke(null, args); }
    return null;
}
```

It does **not** throw when the method is absent — it logs and returns `null`. So
on this ROM `RadioJsonNative.getRadioIc()` returns `""`, `RadioService.onCreate`'s
`getRadioIc().equals("SI47925")` test fails, and **`ArmRadioManager` is never
selected**. The service falls through to the Allwinner path
(`AWRadioManager` + `NewRdsManager`) — which is exactly what the 2026-07-25 drive
log observed live.

⇒ The JSON/`android.os.Hardware` channel is the **Si4792x** variant's transport.
This unit is not that variant. Both facts are consistent; neither is a mystery.

⇒ It also retires the "`ArmRadioManager.getRtMessage()` is hardcoded `return ""`"
worry: true, but irrelevant here — that manager is not the one running.

## The transport this unit actually uses

`NewRdsManager` reads RDS through `com.nwd.radio.arm.allwinner.AWNative`, and
`AWNative` is a thin reflection shim over a **vendor framework class**,
`com.nwd.app.NwdFmManager`:

```java
AWNative.getRdsData()   -> ReflectUtil.invokeStatic(com.nwd.app.NwdFmManager,
                                                    "getRadioRDSDataArm", null, null)  // String
AWNative.isSupportRds() -> ReflectUtil.invokeStatic(com.nwd.app.NwdFmManager,
                                                    "getRadioRDSFunArm",  null, null)  // Integer, 1 = yes
```

Every other `AWNative` method is a direct static call on the same class:

| AWNative | NwdFmManager | Note |
|---|---|---|
| `getFreq()` | `getCurrentFrequency()` | |
| `getFreAndStrength(v, sel)` | (packs both) | **hi 16 bits = strength, lo 16 = freq**; `sel` picks |
| `getStationStereoState()` | `getStationStereoState()` | a real per-station stereo read |
| `getStereo()` / `setStereo(i)` | `getStereo()` / `setStereo(i)` | |
| `seek(i)` / `seekDown(i)` | `seek` / `seekDown` | |
| `setFrequency(i)` | `setFrequency(i)` | |
| `powerUp()` / `powerDown()` | `setEnable()` / `setDisable()` | |
| `setFMBand()` / `setAMBand(ctx)` | `setRadioAreaBandArm(0/1)` | |
| `setLoc(i)` / `getLoc()` | `setLoc` / `getLoc` | local/DX |
| `isMute()` / `setMute(i)` | `isMute()` / `mute(i)` | |
| `getVolume()` / `setVolume(i)` | `getVolue()` / `setVolue(i)` | vendor's spelling |
| `getSupportAM(ctx)` | `getRadioModuleArm()` | |

`com.nwd.app.*` is a ROM framework package, not AOSP — the same shape as the
`android.os.Hardware` guess, and the same reason to think it is off the
hidden-API blocklist and present in every app process. **This is the class the
probe should have been pointed at.** Signal strength, raw RDS, and a real stereo
state are all on it.

**UNPROVEN from our process** — the service reaches it as a system app. Repoint
`probeJsonHardware()` at `com.nwd.app.NwdFmManager` and report the verbatim
result or exact exception type per method. The exception type is the diagnosis:
`ClassNotFoundException` = not in our classloader, `NoSuchMethodException` =
different signature, `SecurityException`/`InvocationTargetException` = reachable
but refused.

## Why RDS is off — the actual gate (`NewRdsManager.updateRdsState`)

```java
if (mbRdsSupport) {
    int v1 = 0;
    int area = SettingTableKey.getIntValue(cr, "mcu_radio_area_current");
    if ((area == 0 || area == 5) && mbRdsOpen && isFmBand(freq)) v1 = 1;
    if (mRdsEnable != v1) { mRdsEnable = v1; /* starts read + analyse threads */ }
} else LOG.print("not support rds");
```

`mRdsEnable` needs **four** things: `mbRdsSupport` (from
`getRadioRDSFunArm`), the FM band, `mbRdsOpen`, and — the one nobody was
looking at — **`mcu_radio_area_current` ∈ {0, 5}**. That is the tuner's
region/area setting, read from the content-provider settings table.

This is a better explanation of the 07-25 and 07-26 results than any lever tried
so far. Both runs confirmed `mRdsEnable=false` *while* we were the FM source, and
concluded the source gate was satisfied but something else was wrong. The area
setting is that something else, and it is the only input in the expression that
was never inspected.

**Cheapest next test, read-only:** read `mcu_radio_area_current` via
`SettingTableKey`/the settings provider and log it. If it is not 0 or 5, RDS is
regionally disabled on this unit and no amount of source-claiming will turn it
on. Writing it is a separate question (likely MCU-owned — `AWNative.setArea`
and `NwdFmManager.setRadioAreaBandArm` are the vendor's own writers).

## Two side findings

- **`getStationStereoState()`** is a per-station stereo read on `NwdFmManager`,
  distinct from the AIDL's `isStreroOn()` that is stuck true. If the reflection
  probe answers, this is a candidate real source for the stereo pill, which
  currently shows blank until `notifyStereo` fires.
- **`NewRdsManager.transformFlagToFreq`** maps flag 0..205 → `8750 + n*10` and
  206..210 → `8700 + (n-206)*10`, i.e. a **0.1 MHz** grid over 87.5–108.0. That is
  indirect evidence for the open "0.1 or 0.2 MHz tune step" question — it is the
  MCU's preset-flag encoding, not necessarily the tune step, so treat it as a
  lead rather than an answer.

## Ethics/scope

Interoperability RE of our own device's interface, read-only, local. Do not
redistribute decompiled code, modified APKs, or firmware.

---

# RDS IS REACHABLE — confirmed on device 2026-08-01

Drive log `carfmtunerlog20260801111008`. `probeNwdFmManager` answered, and the
answer was the good one.

```
class resolves? = YES (53 declared methods)
getRadioRDSFunArm()   = 1
getRadioRDSDataArm()  = a80b20d057686f6c      <- a live RDS group
getStationStereoState() = 1
getCurrentFrequency() = 0
mcu_radio_area_current = 1 (system)
mcu_current_source     = 4 (system)
```

## What this settles

- **`com.nwd.app.NwdFmManager` is reachable from an ordinary app.** The vendor
  framework class resolves and its static getters invoke by reflection. The
  earlier `android.os.Hardware` failure was that class, not the technique.
- **Raw RDS flows.** `getRadioRDSDataArm()` returns one already-synchronised
  group as 16 hex chars, exactly as the decompile predicted.
- **The region gate does not stop us.** `mcu_radio_area_current = 1` is outside
  the {0, 5} that `NewRdsManager.updateRdsState` requires, which is why the
  vendor service never decodes RDS on this unit — but that check lives in the
  service's Java layer. Reading the getter directly bypasses it entirely. The
  MCU emits groups regardless.
- **A real stereo read exists.** `getStationStereoState() = 1`.
- **RSSI is still out of reach.** `getCurrentFrequency()` returns 0, so the
  strength-in-the-high-16-bits idea taken from `AWNative.getFreAndStrength` is
  disproven. The DB+GPS estimate stays.

## The groups decode

Hand-decoded from the log before any code was written, which is what confirmed
the block order and bit layout:

```
a80b 20d0 5768 6f6c   PI=a80b  group 2A seg 0   "Whol"
a80b 20d1 6520 4c6f            2A seg 1         "e Lo"
a80b 20d2 7474 6120            2A seg 2         "tta "
a80b 20d3 4c6f 7665            2A seg 3         "Love"
a80b 20d4 2062 7920            2A seg 4         " by "
a80b 20d5 4c65 6420            2A seg 5         "Led "
```
→ **"Whole Lotta Love by Led "** — RadioText, on a unit where it was believed
impossible.

```
a6ff 02c0 e0cd 2020   PI=a6ff  group 0A seg 0   PS chars 0,1 = "  "
a6ff 02c5 e0cd 5745            0A seg 1         PS chars 2,3 = "WE"
a6ff 02c2 e0cd 524e            0A seg 2         PS chars 4,5 = "RN"
a6ff 02c7 e0cd 2020            0A seg 3         PS chars 6,7 = "  "
```
→ **"WERN"**, a real Wisconsin Public Radio callsign.

Layout, as used by the decoder: block A = PI; block B = group type (15-12),
version (11), TP (10), PTY (9-5); 0A/0B = TA (4) + PS segment (1-0) with chars
in block D; 2A = RT segment (3-0) with chars in blocks C and D, 2B = block D
only and block C repeats PI.

## Implementation

- **`NwdRadioModule.startRdsPump()`** — a daemon thread polling
  `getRadioRDSDataArm()` every 90 ms (RDS runs ~11.4 groups/s ≈ 87 ms/group),
  dropping consecutive duplicates, emitting `NwdRdsGroup`. It refuses to start
  unless `getRadioRDSFunArm()` returns 1 and one read comes back 16 chars, so a
  unit without this transport never spins the thread.
- **`src/services/nwdRds.ts`** — group decoder: PI, PTY, TP/TA, PS, RadioText.
  Decoded in TS rather than through the C++ `RdsDecoder::pushGroup`, which is
  reachable only via `local_sdr_shim.h` — a seam whose contract is an SDR
  session. Routing head-unit groups through it would couple the chip path to the
  SDR engine for no gain; the two take data at different levels anyway.
- **`tools/tests/nwdRds.test.mjs`** — replays the exact groups above and asserts
  "WERN" and "Whole Lotta Love by Led".

RT+ and AF are deliberately NOT decoded: no evidence this tuner emits them.

## Still open

- **RSSI.** No path found. `readRssi()` remains native-only.
- **PI is decoded but not driving identity.** Callsign and logo still resolve
  from frequency + GPS, so a null GPS fix still means "Tuning…". Rewiring that
  onto PI is the obvious next win.
