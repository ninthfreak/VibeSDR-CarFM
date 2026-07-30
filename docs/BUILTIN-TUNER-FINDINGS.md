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
