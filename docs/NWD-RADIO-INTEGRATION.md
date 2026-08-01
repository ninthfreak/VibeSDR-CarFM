# Driving a NOWADA (NWD) head-unit FM tuner from your own app

A standalone integration guide. Everything here is verified against a real unit;
where something is inferred rather than observed it says so. You do not need
CarFM to use any of it — the recipes below are plain Android.

`docs/BUILTIN-TUNER-FINDINGS.md` is the investigation log, in chronological
order, including the wrong turns. **This file is the answer without the journey.**

Interoperability work on our own device: read-only, local, no redistribution of
decompiled code, modified APKs or firmware.

---

## 1. Does this unit qualify?

Runtime detection, not a model whitelist:

```kotlin
val intent = Intent("com.nwd.radio.service.ACTION_RADIO_SERVICE")
    .setPackage("com.nwd.radio.service")
val supported = packageManager.resolveService(intent, 0) != null
```

If that resolves, the unit runs NOWADA firmware and everything below applies.
Commonly Allwinner T3 boards (K2001, K2101, P1/P9, Seicane NWD-*), but **the
firmware vendor is the compatibility axis, not the chipset** — the same Allwinner
chip under TopWay or FYT firmware exposes a completely different interface.

Android 11+ needs visibility of the package:

```xml
<queries><package android:name="com.nwd.radio.service" /></queries>
```

---

## 2. Binding — the AIDL service

The service declares **no `android:permission`**, so an ordinary unprivileged app
can bind it. The service itself holds `ACCESS_FM_RADIO`, `MODIFY_AUDIO_ROUTING`
and friends and brokers the hardware for you.

Copy these AIDL declarations into your app tree under the vendor's package path
and enable `buildFeatures { aidl true }`:

```
com/nwd/radio/service/RadioFeature.aidl      # the interface
com/nwd/radio/service/RadioCallback.aidl     # push events
com/nwd/radio/service/data/Frequency.aidl    # parcelable
com/nwd/radio/service/data/RadioPoint.aidl   # parcelable
```

```kotlin
bindService(intent, conn, Context.BIND_AUTO_CREATE)
// in onServiceConnected:
val radio = RadioFeature.Stub.asInterface(binder)
radio.registCallback(myRadioCallback)
```

### Operation map (`RadioFeature`)

| Operation | Method |
|---|---|
| Tune | `setCurrentFrequency(int freq, byte band, int)` |
| Read dial | `getCurrentFrequency(): Frequency` |
| Seek one step | `seek(boolean up)` — **not what you want, see §4** |
| Scan to next station | `search(boolean up)` |
| Auto-store / intro scan | `AMS()` / `INTRO()` |
| Band | `changeBand()` |
| Band plan | `getRadioPoint(): RadioPoint[]` (min/max/step) |
| Stereo | `isHasStrero()` `isStreroOn()` `setStreroOn(bool)` — note the vendor's spelling |
| RDS enable | `getRDSState(int)` `setRDSState(byte which, bool)` |
| RadioText | `getRtMessage(): String` — **see §8, usually useless** |
| PTY | `getPTYType(): byte` `setPTYType(byte)` |
| Presets | `getPrefabFrequency(): Frequency[]` `saveCurrentFrequency(byte)` `prefeb(bool)` |
| Local/DX | `isNearOn()` `setNearOn(bool)` |
| State | `getRadioState(): byte` `getRadioType(): int` `getCurrentScanState(): int` |
| Escape hatch | `sendRadioCommand(byte, byte)` — opcodes unknown |

### Callbacks (`RadioCallback`)

`notifyCurrentFrequency(byte band, int freq, String psName, int arg)` ·
`notifyRtMessage(String)` · `notifyCurrentPTYType(byte)` ·
`notifyCurrentIsTA(bool)` · `notifyStereo(bool)` · `notifyStereoOn(bool)` ·
`notifyRdsShowState(bool)` · `notifyRadioScanState(int)` ·
`notifyRadioPoint(RadioPoint[])` · `notifyPrefabFrequency(Frequency[])` ·
`notifyState(byte)` · `notifyNearOn(bool)` · `notifyRDSStateChange()`

There is **no signal-level callback**. See §9.

---

## 3. Frequency units — calibrate, never hard-code

`Frequency.mFrequency` is an integer whose scale differs between units. Derive it
from the first `getCurrentFrequency()` instead of assuming:

```kotlin
val f = radio.getCurrentFrequency()
val mult = when {
    f.freq > 50000 -> 1000   // kHz
    f.freq > 5000  -> 100    // 10 kHz
    f.freq > 500   -> 10
    else           -> 1
}
val mhz = f.freq.toDouble() / mult
```

Take the **FM band byte from the same object** (`f.band`) rather than assuming 0.
On the reference unit it is 1.

---

## 4. Seek — use `search()`, not `seek()`

Measured 2026-07-26:

- `seek(up)` nudges **one 0.2 MHz step** and lands on noise. Not a seek.
- `search(up)` scans and **stops on the next real station** in both directions.
  It is not the same as `AMS()`, which auto-stores presets.

---

## 5. Audio — you must claim the MCU source

FM audio is **analog, routed by the MCU to the amplifier**. Nothing streams to
your app; there is no capture pipeline. You must tell the MCU you are the radio
source or you get silence.

**Claim** (this is what makes sound come out):

```kotlin
sendBroadcast(Intent("com.nwd.action.ACTION_APP_IN_OUT")
    .putExtra("extra_app_id", 8)
    .putExtra("extra_app_operation", 1))     // 1 = IN
```

**Release** — only one thing sticks:

```kotlin
sendBroadcast(Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE")
    .putExtra("extra_source_id", 0.toByte()))
```

Measured 2026-07-26: `ACTION_EXIT_ARM_FM_RAIDO` (the vendor's typo) and
`ACTION_APP_IN_OUT` with `operation=0` **both fail** — audio returns within ~1 s
because `mcu_current_source` stays 4 and the MCU re-inits FM. Releasing requires
switching the *source*, not exiting FM.

You can read the current source from settings:

```kotlin
Settings.System.getString(contentResolver, "mcu_current_source")   // "4" = FM
```

---

## 6. Steering wheel and panel keys

**The wheel is not an input event.** It never enters Android's input pipeline, so
MediaSession capture and `Activity.dispatchKeyEvent` both see nothing. The MCU
broadcasts it, and the vendor service registers for that broadcast **without a
permission** — so you can receive it too.

```kotlin
IntentFilter().apply {
    addAction("com.nwd.action.ACTION_KEY_VALUE")   // byte  extra_key_value
    addAction("com.nwd.action.ACTION_TEST_KEY")    // int   extra_key_value
}
// Android 13+: registerReceiver(r, f, Context.RECEIVER_EXPORTED)
```

You can also *send* these to drive the service's own dispatch table.

| Key | Action | Key | Action |
|---|---|---|---|
| 4 | `changeBand()` | 46 | `AMS()` |
| 5, 60 | `search(up)` | 61 | `INTRO()` |
| 6, 59 | `search(down)` | **62** | **preset NEXT** (`prefeb(true)`) |
| 16 | `seek(up)` | **63** | **preset PREV** (`prefeb(false)`) |
| 17 | `seek(down)` | 72 / 73 | `changeFmBand()` / `changeAmBand()` |

The service's dispatch is gated on `mcu_current_source == 4`.

**Note on presets:** `prefeb()` walks the *service's* banks — 3 bands × 6 slots,
held in the service's own `SharedPreferences`, not tuner firmware. You cannot
blank them from a third-party app, and a zeroed slot would tune to garbage rather
than be skipped. If you keep your own preset list, expect the service to jump to
its slot as well; you cannot cancel a normal broadcast, so correct afterwards.

---

## 7. Headlights → day/night

```kotlin
IntentFilter("com.nwd.ACTION_ILL_STATE_CHANGE")   // byte extra_ill_state, 1 = lights on
```

**Measured 2026-08-01: this ROM does NOT set Android's `uiMode` night flag.**
`extra_ill_state` toggles 1/0 with the headlights while
`Configuration.UI_MODE_NIGHT_MASK` stays `UI_MODE_NIGHT_NO` throughout. So
`useColorScheme()` / `AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM` will never fire
— drive your own day/night from this broadcast.

(Other candidates seen in the vendor strings, untested:
`ACTION_BACKLIGHT_SWITCH_CHANGE`, `BACKLIGHT_STATUS`, `BK_NIGHT`.)

---

## 8. RDS — the AIDL lies, go around it

**Do not rely on `getRtMessage()` or the RDS callbacks.** Two independent reasons
they come back empty:

- On `ArmRadioManager` units, `getRtMessage()` is literally `return "";`.
- On Allwinner units, `NewRdsManager.updateRdsState()` only enables decoding when
  `mcu_radio_area_current` ∈ {0, 5} — a **region setting**. On a North American
  unit it is 1, so the service never decodes RDS at all.
- `setRDSState(byte which, …)` only acts on `which == 1` (AF) and `which == 2`
  (TA). Calling it with `which = 0` sets nothing.

### The way that works: raw groups from the vendor framework

`com.nwd.app.NwdFmManager` is a ROM framework class — not AOSP, so not on the
hidden-API blocklist, and present in every app process. Reach it by reflection:

```kotlin
val cls = Class.forName("com.nwd.app.NwdFmManager")
fun call(name: String): Any? =
    (runCatching { cls.getMethod(name) }
        .getOrElse { cls.getDeclaredMethod(name).apply { isAccessible = true } })
        .invoke(null)

call("getRadioRDSFunArm")    // Int, 1 = hardware supports RDS
call("getRadioRDSDataArm")   // String, 16 hex chars = ONE RDS group
call("getStationStereoState")// Int, real per-station stereo
```

**The region gate does not apply here.** It lives in the service's Java layer;
reading the getter directly bypasses it. The MCU emits groups regardless.

Poll `getRadioRDSDataArm()` at about **90 ms** — RDS runs ~11.4 groups/s (~87 ms
per group). `"0000000000000000"` means no group this poll. Drop consecutive
duplicates.

### Group format

16 hex chars = 4 blocks × 2 bytes: **A B C D**.

- **Block A** = PI (programme identification).
- **Block B** = header, in every group:
  - bits 15–12: group type (0 = PS, 2 = RadioText)
  - bit 11: version (0 = A, 1 = B)
  - bit 10: TP
  - bits 9–5: PTY
- **Group 0A/0B — Programme Service name (8 chars):** bit 4 = TA, bits 1–0 =
  segment. Two chars in **block D**, at `segment × 2`.
- **Group 2A — RadioText (64 chars):** bits 3–0 = segment, bit 4 = A/B flag
  (a flip means a new message — clear your buffer). Four chars from **blocks C
  and D**, at `segment × 4`.
- **Group 2B:** two chars from **block D** only, at `segment × 2`; block C
  repeats PI.
- `0x0D` terminates RadioText. **Test this on the raw byte** — if you sanitise
  unprintables to spaces first, you destroy the terminator and the message never
  completes.

Worked example, straight off the unit:

```
a80b 20d0 5768 6f6c   PI=a80b, 2A seg 0 -> "Whol"
a80b 20d1 6520 4c6f            2A seg 1 -> "e Lo"
a80b 20d2 7474 6120            2A seg 2 -> "tta "
a80b 20d3 4c6f 7665            2A seg 3 -> "Love"
a80b 20d4 2062 7920            2A seg 4 -> " by "
a80b 20d5 4c65 6420            2A seg 5 -> "Led "
```

A working decoder is `src/services/nwdRds.ts` (~150 lines, no dependencies);
`tools/tests/nwdRds.test.mjs` replays real device groups against it.

Reference: EN 50067 / IEC 62106.

---

## 9. What is NOT available

Do not spend time on these; each was chased and closed.

| Want | Status |
|---|---|
| **Signal strength / RSSI** | **Not reachable so far.** No AIDL method, no callback, and the outgoing broadcasts carry only frequency/band/preset/state. `RadioNative.readRssi()` exists but is native-only (vendor `.so` + device access). `NwdFmManager.getCurrentFrequency()` returns **0** on the reference unit, so the strength-packed-in-the-high-16-bits scheme implied by `AWNative.getFreAndStrength` is a dead end. **Still open — see §10.** |
| Per-channel lock / tuned indicator | Does not exist. `getRadioState()` is a global idle/active flag. |
| PI over the AIDL | No `getPI()`. Get it from block A of the raw groups instead (§8). |
| Clearing the hardware preset banks | `CleanFMPreFreData()` exists only on a manager variant this unit does not run, and is not on the AIDL. |
| The `android.os.Hardware` JSON channel | **Absent.** `parseJson` is not declared on that class on this ROM. It belongs to the Si4792x variant; Allwinner units never take that path. |

### Gotchas that cost real time

- **`isStreroOn()` is stuck `true`** — it reads true on dead air. Use the
  `notifyStereo` callback (fires only on *change*) or
  `NwdFmManager.getStationStereoState()`.
- **`arg` in `notifyCurrentFrequency` is the 1-based factory-preset slot index**,
  `-1` when the frequency is not a factory preset. It is **not** signal and not a
  lock indicator.
- **`ReflectUtil.invokeStatic` returns `null` rather than throwing** when a method
  is missing, so vendor code fails silently and falls through to another path.

---

## 10. Open: is a real signal level reachable?

Not yet, and not abandoned. `NwdFmManager` declares **~53 methods** and only nine
have been called. The unexplored remainder is the last plausible place a level
could live.

`NwdRadioModule.probeNwdFmManager()` now dumps every declared method name with
its signature. If a candidate appears — anything RSSI, level, quality or
strength shaped — call it read-only and compare a strong station against dead
air. That is the next concrete step.

If nothing turns up there, the honest conclusion is that signal strength is not
available to an unprivileged app on this firmware, and an estimate (station
database + GPS) rendered visibly as an estimate is the correct design.
