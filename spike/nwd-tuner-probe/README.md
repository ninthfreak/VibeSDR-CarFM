# NWD built-in FM tuner — proof-of-life probe

A tiny throwaway Android app that binds your head unit's built-in FM tuner
service (`com.nwd.radio.service`) and lets you tune + watch RDS + try to get
audio out. **This is not the CarFM backend** — it exists only to confirm, on real
hardware, the interface mapped in `docs/BUILTIN-TUNER-FINDINGS.md`.

The AIDL in `app/src/main/aidl/…` is a clean-room reconstruction of the service's
interface (method order = the real transaction codes, Parcel layouts verified
from the service). No decompiled vendor code is included.

## Build

**Easiest — Android Studio:**
1. `File → Open…` and select this folder (`spike/nwd-tuner-probe`).
2. Let it sync; accept any AGP/Gradle upgrade prompt it offers.
3. Plug in the head unit (or use its network `adb`), press **Run ▶**.

**Command line** (needs a local Android SDK + JDK 17):
```bash
cd spike/nwd-tuner-probe
gradle wrapper            # once, if you don't have ./gradlew
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Test sequence (on the unit)

Launch **NWD Tuner Probe**, then, in order:

1. **CONNECT** — should log `bindService(...) returned true` then `CONNECTED`.
   - `false` / no `CONNECTED` = the service isn't bindable from a normal app
     (would contradict the static finding — tell me).
2. **READ STATE** (auto-runs on connect) — logs `getCurrentFrequency`,
   `getRadioPoint`, `getRtMessage`. This reveals the **frequency units** and the
   **band byte** (the app auto-detects both and fills the fields).
3. **TUNE (MHz)** — type a strong local FM station in the MHz box, tap it. Watch
   for a `cb FREQ … PS='…'` callback with the new frequency + station name.
   - If the tune lands on the wrong frequency, the unit uses different units than
     auto-detected — use **TUNE (raw)** and type the raw integer you saw in
     `getCurrentFrequency` (± a bit) instead.
4. **SEEK ▲ / ▼** — should step to the next station (callbacks update).
5. Watch the log for **`cb RT '…'`** (RadioText) and **`cb PTY`** — that's RDS working.
6. **AUDIO ON** — the experimental part. Fires the source-switch broadcasts +
   `setRadioBackServiceOn(true)` + unmutes music. **Do you hear the station?**

## What the outcomes mean

- **CONNECT + tune + `cb FREQ`/`cb RT` all work:** control + RDS confirmed — the
  high-confidence half. The backend's UI/tuning/station-info will work.
- **AUDIO ON → you hear it:** full win; the whole backend is viable as-is.
- **AUDIO ON → silence:** audio is likely gated to the stock app. Not fatal —
  known fallbacks (keep the stock app dormant-but-alive to hold the audio route,
  or find the exact source id). We'd chase that next.

## What to send me back

The **on-screen log** (or `adb logcat | grep -i nwdprobe`), especially:
- the **READ STATE** lines (units + band + PS), and
- whether **TUNE** changed the station, and
- whether **AUDIO ON** produced sound.

That tells us exactly which world we're in.

## Safety
It binds the *same* service the stock radio app uses and only tunes / toggles the
audio source — all reversible, nothing persistent is written (it never calls
`saveCurrentFrequency`). Close the app / tap AUDIO OFF to hand the radio back.
