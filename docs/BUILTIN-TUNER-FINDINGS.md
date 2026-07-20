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

## VERDICT: **GO** — pending on-device validation only

All three feared blockers (bind permission, antenna power, RDS availability) came
back favorable, and the audio path is now **characterized** (MCU-routed analog +
a broadcast source switch — see Q_audio). Nothing left is a *design* unknown;
what remains is confirming the mapped recipe on real hardware (audio actually
comes out, reception matches the stock app) — which only you can run. No
architectural risk is outstanding.

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
