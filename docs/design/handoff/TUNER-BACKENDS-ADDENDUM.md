# Addendum — Multi-Tuner Backend Support

Companion to `car-fm-app-spec.md` and the station-database addendum. Same fork.

---

## 1. Goal

Support multiple FM tuner hardware classes behind one abstraction, so the app
works with whatever tuner is present: the current RTL-SDR path, cheap Si470x
USB FM dongles (hardware demod, near-zero CPU), an optional TEF6686 serial
module, and — researched but explicitly deprioritized — the head unit's
built-in tuner.

**Architecture rule:** every backend reduces to the same two streams plus a
small control surface. All RDS decoding (PI, PS, RT, RT+, PTY, CT, AF, TP/TA)
happens ONCE, downstream, in the app's existing block-level decoder. Backends
never parse RDS themselves; they deliver raw 16-bit block groups.

```
TunerSource (interface)
 ├─ audio:    PCM stream (or "audio arrives via USB audio device X")
 ├─ rds:      stream of RDS block groups (A,B,C,D + per-block error flags)
 ├─ control:  tune(freqKHz), seekUp/Down(), setBand(US), setDeEmphasis(75us)
 ├─ metrics:  RSSI / SNR / stereo pilot state (whatever the backend has)
 └─ caps:     hasHardwareDemod, hasHardwareRDS, canSeekInHardware, tuneLatency
```

UI must consume only this interface. Adding a backend must not touch UI code.

---

## 2. Backend A — RTL-SDR (existing, baseline)

Already implemented in VibeSDR. Software demod, RDS in software. Keep as the
reference backend and the most flexible one (it's also the only backend that
can ever do HD Radio via nrsc5 later). No work beyond refactoring behind
`TunerSource`.

## 3. Backend B — rtl_tcp remote (dev/testing)

Same demod path as A with a TCP sample source. Used for emulator development
per the main spec (§8). Keep it wired into the same abstraction.

---

## 4. Backend C — Si470x USB FM dongles  ⟵ the new work

### What these are
Old USB FM radio sticks built on the Silicon Labs Si470x reference design.
One design, several brandings. Known VID/PID (from the mainline Linux driver
id table):

| Device | VID | PID |
|---|---|---|
| SiLabs FM Radio Reference Design | 0x10C4 | 0x818A |
| ADS/Tech Instant FM Music (RDX-155-EF) | 0x06E1 | 0xA155 |
| KWorld SnapMusic Mobile 700 (FM700) | 0x1B80 | 0xD700 |
| Sanei / DealExtreme "PCear" | 0x10C5 | 0x819A |
| Axentia ALERT FM | 0x12CF | 0x7111 |

Each enumerates as a **composite device: USB Audio Class interfaces (the
radio audio, as a capture stream) + one HID interface (chip control)**. That
composite is exactly what an unprivileged Android app can drive via the USB
Host API — no root, no kernel driver, same permission pattern as the RTL-SDR.

### Control path (HID)
- Claim the HID interface with `UsbDeviceConnection.claimInterface(iface, /*force=*/true)`
  to detach any kernel/system claim.
- The Si470x is a bank of 16-bit registers; the USB variant maps register
  reads/writes onto HID GET_REPORT / SET_REPORT, and delivers async status +
  RDS via the HID **interrupt-IN endpoint**.
- **Sourcing the register map:** implement from the public Silicon Labs
  documentation — the Si4702/03 datasheet and AN230 (programming guide).
  Registers of interest: POWERCFG (power-up, mute, mono), CHANNEL (tune +
  TUNE bit), SYSCONFIG1 (RDS enable, de-emphasis), SYSCONFIG2 (band, channel
  spacing, volume, seek threshold), SYSCONFIG3 (seek SNR/impulse thresholds),
  STATUSRSSI (STC, RDSR, RSSI, stereo), READCHAN, RDSA–RDSD.
- **License caution:** the mainline `radio-si470x-usb.c` driver is GPL-2.0.
  Use it to understand the HID report framing and endpoint behavior, but
  write our implementation from the datasheet/AN230; do not port GPL code
  into the app unless the fork's license is compatible. Flag for a human
  decision if unclear.

### Init sequence (US profile)
1. Enable internal oscillator (XOSCEN), wait per datasheet, power up.
2. Band = 87.5–108 MHz, spacing = 200 kHz, de-emphasis = 75 µs.
3. RDS enable; verbose RDS mode if using RDSM.
4. Volume to max in-chip; app controls loudness in Android.
5. Tune = write CHANNEL + TUNE, poll/await STC, clear.
6. Seek = SEEK bit with SKMODE/SEEKTH; report the landed frequency from
   READCHAN. Hardware seek satisfies the main spec's seek-first UX.

### RDS path
Poll RDSR or consume the interrupt endpoint; on each ready event, read
RDSA–RDSD + error bits and emit one block group into the shared decoder.
Do not decode in the backend.

### Audio path
The dongle is a standard USB audio *capture* device to Android:
- Enumerate via `AudioManager.getDevices(GET_DEVICES_INPUTS)`, find
  `TYPE_USB_DEVICE` matching our VID/PID.
- Open `AudioRecord` (or AAudio) with `setPreferredDevice(...)` on that
  device, at the sample rate its descriptor advertises (typically 44.1/48 k).
- Pipe to an `AudioTrack`/AAudio output on the head unit's default output.
  Latency target: < 100 ms buffer; this is radio, not a call.
- The dongle has no playback endpoint, so Android's USB auto-routing of
  *output* should not engage; verify on the DUDU7 anyway.

### Antenna
These sticks use the headphone/whip lead as the antenna. For the car,
plan the same adapter path as the RTL-SDR: feed from the vehicle FM antenna.

### Practical notes
- These products are discontinued; sourcing is eBay/AliExpress/thrift. Cheap
  (~$10–20) but availability is the weak point. Support them because the code
  is small and the CPU win is large, not because they're the future.
- CPU: hardware demod + hardware RDS ≈ near-zero load vs. the SDR path —
  meaningful on a head unit that's also running maps.

### Definition of done (Backend C)
- [ ] Dongle hot-plug detected via USB_DEVICE_ATTACHED with "use by default".
- [ ] Tune, hardware seek up/down, RSSI + stereo indicator working.
- [ ] RDS block groups flow into the shared decoder; PS/RT/PTY appear.
- [ ] Audio: USB capture → head unit output, survives app restart & replug.
- [ ] Backend selectable/auto-selected via the TunerSource registry.

---

## 5. Backend D (optional) — TEF6686 serial module

Enthusiast path, natural fit for this project's builder. The NXP TEF6686 is
the same car-grade DSP tuner used inside better head units (excellent
sensitivity/selectivity, hardware RDS); the FM-DX community sells/builds
ESP32-driven TEF6686 boards with open firmware (PE5PVB lineage) controllable
over serial.

Shape of the work: a `TunerSource` speaking that serial protocol over
USB-CDC (usb-serial-for-android, already planned in the main spec). Audio
would come in via the board's I²S→USB audio or line-in — decide when/if this
backend is attempted. **Scope: after C ships, only if wanted.** It exists in
this doc so the abstraction accounts for a serial-controlled hardware tuner.

---

## 6. Backend E (research only, deprioritized) — built-in head unit tuner

**Reality check:** on these units Android never touches the tuner chip. The
tuner (TEF6686 on better units; TEF6851 or ST TDA7786x — both WITHOUT RDS —
on cheaper ones) hangs off the proprietary MCU; Android talks to the MCU
over a vendor serial protocol that differs per firmware family (MTC, TopWay,
FYT/DUDUOS, ROCO, ...). Supporting "the chip" is the wrong abstraction;
you support a firmware family's protocol, one reverse-engineering effort each.

**Existence proof:** NavRadio+ (Navimods/KoTiX) does exactly this and lists
DUDUOS + UIS7870 — the DUDU7 — as supported. It drives the built-in tuner by
talking to the MCU.

**Recommendation:** do NOT attempt this for v1, and possibly ever. The cost
is a per-platform RE project; the benefit on our own unit is already
purchasable (NavRadio+), and our app's differentiators (SDR, USB tuners,
RT+/redsea pipeline, MediaSession contract) don't depend on it.

If it is ever attempted, target FYT/DUDUOS only, and start with discovery,
not code:
1. Decompile the stock FM app + the vendor service layer; map the control
   surface (binder service, broadcast intents, or a /dev/tty* serial).
2. logcat + strace while operating the stock radio.
3. Mine XDA's FYT dev threads (NavRadio, DAB-Z authors) for prior art.
4. Only then design a backend — and expect RDS to be limited to whatever the
   MCU forwards (on many units, AF handling is broken at the MCU level;
   plan to disable AF).

---

## 7. Backend selection & coexistence

- Registry probes in order: Si470x USB present → C; RTL-SDR present → A;
  rtl_tcp configured → B; else show "no tuner" state with guidance.
- Manual override in settings; remember last choice per device.
- Only one backend owns the antenna/audio at a time; switching = clean
  teardown then init.
- The MediaSession contract (main spec §5b) is backend-agnostic: same
  metadata mapping regardless of tuner.

## 8. Test plan deltas

- Backend C can be developed on any Android phone with USB-OTG before the
  head unit: dongle + phone is a complete test rig.
- The shared RDS decoder gets a replay harness: recorded block-group logs
  (from either backend) played back deterministically — same idea as the
  captured-IQ regression tests in the main spec, one layer up.
