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

There is **one button, ▶ RUN ALL TESTS**. It now runs a **focused investigation**,
not the old full sweep: it no longer re-tests what we've already confirmed (audio
starts via `app_id=8`, tuning lands on the right station, presets overwrite). It
drives the three still-**open** questions, reading objective signals
(`isMusicActive` / `mcu_current_source` / frequency) instead of asking — the only
ear-check is the one genuinely-open seek question. The old full phases (audio
ladder, tune-confirm, overwrite presets, reclaim) are **preserved under Advanced**
— nothing was deleted, just taken off the default run.

**Setup (silent).** Bind the service and power FM up via the confirmed trigger
(`ACTION_APP_IN_OUT extra_app_id=8`), verified with `AudioManager.isMusicActive()`
— no "can you hear it?".

**A — RadioText.** A passive bound client sees `rt=''`. The last drive log showed
we reached `mcu_current_source=4` (we're the FM source) yet the decoder stayed off
(`mRdsEnable=false`). This walks the client-reachable levers (back-service on,
re-assert source) and watches whether PS/RT/PTY ever populate.

**B — Seek, outside the preset auto-search.** Characterizes **both** on-demand
primitives: `seek()` (a single frequency step) and `search()` (scans and stops on
the next station — the real on-demand seek). Reports exactly what each does, with
one ear-check on whether they land on a clear station.

**C — Audio-off that STAYS off.** The "comes back on" bug: exiting FM doesn't stick
while the active source is still Radio (the MCU re-powers it). Walks stop methods —
`EXIT_ARM_FM`, `APP_IN_OUT operation=0` (leave the source), `REQUEST_CHANGE_SOURCE`
away from Radio — watching `isMusicActive` for 6s each, and names the one that
sticks. That winner is the exact signal CarFM's power button must send.

> **Not tested here:** writing `mcu_current_source` directly. The decompile shows
> that's a dead end — it needs system permission and the MCU re-asserts it — and
> it's exactly what made the previous probe fail. This one triggers the service
> instead of fighting the setting.

Questions are answered with **inline buttons in the app's own screen** (a dialog
would lock up). Under **Advanced** are the three phases as individual buttons plus
manual controls: **Connect**, the **MHz/band** box, **Tune**, **Dump banks**,
**Rich dump**, **logcat**, **Save log**, and one-tap **APP_IN_OUT 8 / MEDIA_PLAY 8
/ REQ SRC 4 / EXIT FM**. (To use a specific RadioText station in phase 2, set the
MHz box under Advanced before starting.)

So a *No* is still diagnosable, each rung is heavily instrumented (all read-only):
- the service's **own log trail** (`InitFM` / `powerUp = true` / `requestAudioFocus,result` / `setForceUseSpeaker` …) via `logcat` — only if the ROM lets an app read others' logs (root / permissive); it reports "unreadable" otherwise, which is itself useful.
- a **per-second time-series** of tuner + audio state through each wait;
- an **AudioManager** snapshot (music active / volume / route);
- a **baseline dump** (every getter, presets, band plan, RDS states, `getprop`) and a **hidden-parcel-field hunt** on `getCurrentFrequency` (RSSI/stereo we may be truncating);
- **was the service already running** before we bound it;
- an end-of-run **summary table**.

Everything — machine readings and your answers — lands in one log saved to Downloads.

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

Do it **parked**. Expected state before you start: **stock radio app closed, CarFM
not running, volume up, nothing else playing** (no Bluetooth audio / music app).
Then:

1. Launch **NWD Tuner Probe** → tap **▶ RUN ALL TESTS**. It re-states the expected
   state on screen, then binds the service and runs the three phases back to back
   (~4–5 min). No permission grant needed.
2. Follow the on-screen prompts. Each phase opens with a bold banner saying what
   it proves, so they don't blur together. **The only questions you're asked are the
   ones only your ears can answer** — "is audio playing?" and "are you hearing the
   right station?". RDS and seek results are read straight from the tuner's own
   variables and printed to the log; the probe does **not** ask you to eyeball them.
   The more intrusive steps (source switch, preset overwrite) ask for a confirm first.
3. At the very end it offers **Stop FM / Leave it playing** as the *last* action
   (nothing is written after it, so audio won't pop back on behind a file save) and
   **saves the log to Downloads** (`nwdprobe-<timestamp>.txt`). If Stop FM is chosen
   it watches a few seconds and records whether the MCU re-powers FM on its own.
   Send me that file (or a screenshot).

(Individual phases can be run alone from **Advanced** — including a
**Reclaim-after-loss** test that guides you through losing the source to another
app and recovering it.)

The answer I most want: **which rung, if any, makes sound come out with the stock
app closed.** That tells us whether CarFM can drive its own audio, and how.

### RUN RADIO FUNCTIONS (tune · seek · RDS)

Runs **after** audio is up (it powers FM up first anyway). It proves the rest of a
real radio: **tunes to WIBA 101.5 and WERN 88.7** (asking you to confirm by ear you
hear each), then for each station **reads RDS for ~24s** — PS / RadioText / PTY are
sampled from the tuner's own getters and the probe prints a verdict (`RDS PRESENT …`
or `NO RDS reached the client …`). It does **not** ask you whether text appeared;
the app can see the variables before anything would ever hit a screen.

Then **seek**: for each of `search up`, `search down`, and a single `step up`, it
records the frequency **before**, fires the call, **polls until the tuner stops
moving**, and prints `start → landed` with a verdict (real hop vs. one tick vs. no
change). So you see exactly what it did instead of just hearing the audio change,
and it never "keeps slowly seeking" while waiting on you — it settles first, then
moves on, and parks back on 101.5 at the end. Note the AIDL is named backwards on
this AllWinner unit — `search()` is the real seek-to-next-station (scans and stops),
`seek()` is a single manual step — and seek is gated on the tuner being powered,
which is why it did nothing before we could power FM up ourselves.

### OVERWRITE BUILT-IN PRESETS (app → unit)

Testing **one-way sync from the app INTO the head unit's preset banks** (never the
reverse). It writes the app's 8-station list into FM1 (6) + FM2 (2) by, for each
slot: switching to the bank (`changeBand`), tuning to the frequency, and calling
`saveCurrentFrequency(slot)` (0–5, zero-based, writes the current station into
`mPrefFrequency[bank][slot]`). It dumps all banks before and after so you can
confirm the overwrite. Capacity is 18 FM presets (`CleanFMPreFreData` clears
exactly 3 banks × 6). **It replaces the built-in presets** — that's the point, and
confirmed intended.

## Safety
It binds the *same* service the stock radio app uses and sends the *same*
broadcasts the stock app sends. It does **not** write any system setting, touch
firmware, CAN, or calibration. It **does** overwrite the built-in FM **presets** in
Phase 3 (`saveCurrentFrequency`) — one-way, app→unit, and only after you confirm;
that's the whole point of that phase, and it's reversible by re-running the stock
app's auto-store or overwriting again. Rung 4 changes the active audio source
(reversible — **Stop FM** restores it, and a reboot fully resets it). Worst
realistic case is a brief source/audio mix-up cleared by switching source or
restarting. Run it parked.
