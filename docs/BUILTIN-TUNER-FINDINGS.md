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
