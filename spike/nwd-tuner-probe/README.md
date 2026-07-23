# NWD built-in FM tuner — proof-of-life probe

A throwaway Android app that binds your head unit's built-in FM tuner service
(`com.nwd.radio.service`) and runs an **exhaustive, guided test** of it. **This is
not the CarFM backend** — it exists only to answer, on real hardware, the open
questions in `docs/BUILTIN-TUNER-FINDINGS.md` (chiefly: can we unlock RadioText by
writing `mcu_current_source`, and does anything change when the stock app is the
active source).

**RUN FULL TEST** drives the whole thing (allow ~15 min): it auto-tunes 88.7 and
101.5, dumps every getter, runs the source-gate write experiment, and pauses to
**ask you button questions** (how does it sound? did text appear?) or **give you a
step to perform** (grant a permission, open the stock app) with a **Done** button.
Your answers and the machine readings all land in one log saved to Downloads.

It also runs several deeper probes automatically:
- **Raw `getCurrentFrequency` parcel dump** — hand-marshals the reply and reports
  any bytes left over after our `{band, ps, freq}`. Leftover = **hidden fields our
  AIDL truncates**; if they differ between a strong and weak station, that's a
  signal reading we've been missing.
- **`search()` full-scan** test (vs the stepping `seek()`), **`getprop`** dump,
  and a **broadcast logger** for `com.nwd.action.*`.

Manual buttons remain for ad-hoc poking: Connect / Tune / Seek / **Search** /
**Near ON/OFF** / **INTRO** / Dump / Source probe / **getprop** / **Raw parcel** /
**Latch FM src** + **Restore src** (hold source=FM indefinitely for slow RDS) /
**sendRadioCommand a,b** (advanced — controlled MCU command).

The AIDL in `app/src/main/aidl/…` is a clean-room reconstruction of the service's
interface (method order = the real transaction codes, Parcel layouts verified
from the service). No decompiled vendor code is included.

## Build

**Easiest — Android Studio:**
1. `File → Open…` and select this folder (`spike/nwd-tuner-probe`).
2. Let it sync; accept any AGP/Gradle upgrade prompt it offers.
3. **Build ▸ Build APK(s)** to produce the APK (see path below), then install it on
   the unit via removable media as described in "Getting the APK onto the unit".
   (Only use **Run ▶** if the unit is actually connected to your computer via adb.)

**Command line — build only.** The Gradle **wrapper is committed** and pins Gradle
8.9, so use `./gradlew` — do **not** run `gradle wrapper` (your system Gradle is
older than AGP 8 needs; that's what the `dependencyResolutionManagement` error
was). You need JDK 17+ (21 is fine) and the Android SDK. If Gradle can't find the
SDK, point it at one:
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

## Running the full test (on the unit)

Do it **parked**; no driving or GPS needed — pick a spot where a couple of
stations come in. Then:

1. Launch **NWD Tuner Probe** → tap **▶ RUN FULL TEST**. It connects on its own.
2. **First run only:** it will ask to write system settings. Tap **Done** to open
   the grant screen, enable *"modify system settings"* for the probe, come back,
   and **press RUN FULL TEST again**. (The permission sticks; later runs skip it.)
3. From then on it runs unattended except for the prompts:
   - **Questions** (buttons): "How does 88.7 sound? Clear / Weak / Silent",
     "Did RadioText appear?", "Did audio play?" — just tap the honest answer; it's
     recorded in the log next to the machine readings.
   - **Steps** (Done button): the **stock-app comparison** — it asks you to open
     the stock radio app, tune it to 88.7, wait ~15s, then come back and tap
     **Done**. Leave the dialog up while you're in the stock app. This is the
     decisive A/B: if RadioText shows up *only* when the stock app is the active
     source, we know the gate is source-driven.
4. When it finishes it **saves the log to Downloads** (`nwdprobe-<timestamp>.txt`).
   Send me that file (or a screenshot).

The two answers I most want from it: does forcing `mcu_current_source=4` make
**RadioText** appear (write test), and does RadioText appear when the **stock app**
is active (A/B step). Together they tell us whether CarFM can get RadioText, and how.

## Safety
It binds the *same* service the stock radio app uses. The only thing it writes is
`mcu_current_source` in `Settings.System`, and it **restores the original value**
after each ~12s hold. That's volatile source-selection state — a reboot fully
resets it, and it never touches firmware, CAN, calibration, or presets
(`saveCurrentFrequency` is never called). Worst realistic case is a brief
source/audio mix-up cleared by switching source or restarting. Run it parked.
