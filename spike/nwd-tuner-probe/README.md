# NWD built-in FM tuner — standalone-audio probe

A throwaway Android app that pokes your head unit's built-in FM tuner service
(`com.nwd.radio.service`) to answer **one question on real hardware:**

> **Can FM audio be brought up WITHOUT launching the stock radio app?**

**This is not the CarFM backend** — it exists only to test that one thing.

## What it does

Decompiling the service (Spreadtrum path, `SprdRadioManager$1.onReceive`) showed
that all the privileged audio work — power up the tuner, grab audio focus, route
via `AudioSystem.setForceUse`, unmute — runs **inside the service**, and the
service starts it in response to broadcasts the stock app fires *on itself*, with
**no permission or caller check**. So a third-party app doesn't need audio
permissions; it just needs to send the same broadcast to the running service.

**▶ RUN AUDIO TEST** climbs a ladder of bring-up attempts and stops at the first
one that produces sound, asking you a single yes/no per rung:

1. `com.nwd.action.ACTION_APP_IN_OUT` with `extra_app_id=8` → service `InitFM()` — the stock app's own trigger.
2. `com.nwd.ACTION_MEDIA_PLAY` with `extra_app_id=8` → the same `InitFM()` path.
3. Bind + `setCurrentFrequency` (on the Spreadtrum build, tuning powers up the tuner on its own).
4. `com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE` (`extra_source_id=4`, then `8`) — asks the MCU to *physically* switch the head unit's audio source to Radio. Needed if this unit is a true external-MCU analog tuner rather than a SoC tuner.
5. `MediaPlayer("THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM")` — a public-API long shot.

Before the ladder it wakes/binds the service (the receivers are registered
dynamically, so the service must be alive) and clears competing media. As a
**bonus**, if a rung makes FM the active source it may also unlock **RadioText** —
the probe logs `getRtMessage`/callbacks throughout, so we'd catch that too.

> **Not tested here:** writing `mcu_current_source` directly. The decompile shows
> that's a dead end — it needs system permission and the MCU re-asserts it — and
> it's exactly what made the previous probe fail. This one triggers the service
> instead of fighting the setting.

Questions are answered with **inline buttons in the app's own screen** (the old
version used a dialog that could lock up). Manual buttons remain for ad-hoc use:
**Connect**, **Tune**, **Dump**, and one-tap **APP_IN_OUT 8 / MEDIA_PLAY 8 /
REQ SRC 4 / EXIT FM**. Everything — machine readings and your answers — lands in
one log saved to Downloads.

The AIDL in `app/src/main/aidl/…` is a clean-room reconstruction of the service's
interface (method order = the real transaction codes). No decompiled vendor code
is included.

## Build

**Easiest — Android Studio:**
1. `File → Open…` and select this folder (`spike/nwd-tuner-probe`).
2. Let it sync; accept any AGP/Gradle upgrade prompt it offers.
3. **Build ▸ Build APK(s)** to produce the APK (see path below), then install it on
   the unit via removable media as described in "Getting the APK onto the unit".
   (Only use **Run ▶** if the unit is actually connected to your computer via adb.)

**Command line — build only.** The Gradle **wrapper is committed** and pins Gradle
8.9, so use `./gradlew` — do **not** run `gradle wrapper` (your system Gradle is
older than AGP 8 needs). You need JDK 17+ (21 is fine) and the Android SDK. If
Gradle can't find the SDK, point it at one:
```bash
cd spike/nwd-tuner-probe
export ANDROID_HOME=$HOME/Android/Sdk      # or wherever your SDK is
#   ...or create local.properties with:  sdk.dir=/home/you/Android/Sdk
./gradlew assembleDebug                     # downloads Gradle 8.9 on first run
```
This just **produces the APK**; it does not put it anywhere. The build output is:
```
app/build/outputs/apk/debug/app-debug.apk
```

## Getting the APK onto the unit

The head unit does not have to be connected to your computer. Pick whichever fits:

- **Removable media (no connection needed):** copy `app-debug.apk` onto a USB
  stick / SD card, plug it into the unit, open it with the unit's file manager,
  and tap to install (allow "install from unknown sources" once).
- **adb — only if your unit is actually reachable** (USB-debugging cable, or
  `adb connect <unit-ip>:5555`): `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
  If your unit isn't networked/connected, ignore this.

## Running the test (on the unit)

Do it **parked**. Then:

1. **Turn the volume up**, and make sure the **stock radio app is closed**.
2. Launch **NWD Tuner Probe** → tap **▶ RUN AUDIO TEST**. It binds the service on
   its own. No permission grant is needed.
3. After each rung it asks, with buttons: **"is FM audio playing through the
   speakers now?" → YES — audio! / No.** Answer honestly; it climbs to the next
   rung only on *No*, and stops as soon as you say *Yes*.
   - Rung 4 first warns you (with an **OK** button) that it will switch the whole
     unit's source to Radio — that one is more intrusive, like pressing *Radio* on
     the head unit.
4. At the end it reports which rung (if any) produced audio, then offers **Stop FM
   / Leave it playing**, and **saves the log to Downloads** (`nwdprobe-<timestamp>.txt`).
   Send me that file (or a screenshot).

The answer I most want: **which rung, if any, makes sound come out with the stock
app closed.** That tells us whether CarFM can drive its own audio, and how.

## Safety
It binds the *same* service the stock radio app uses and sends the *same*
broadcasts the stock app sends. It does **not** write any system setting, touch
firmware, CAN, calibration, or presets (`saveCurrentFrequency` is never called).
Rung 4 changes the active audio source (reversible — **Stop FM** restores it, and
a reboot fully resets it). Worst realistic case is a brief source/audio mix-up
cleared by switching source or restarting. Run it parked.
