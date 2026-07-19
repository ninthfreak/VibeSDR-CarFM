# CarFM

> **CarFM was originally forked from [VibeSDR](https://github.com/Stuey3D/VibeSDR)** by Stuart (Stuey3D). This is an independent fork under the GPL-3.0 licence; it is not affiliated with or endorsed by the original project.

### Designed for your thumbs.

**Two large weighted drums with real inertia. Spin them, flick them, let them coast. It feels like tuning a radio, because that's what it's modelled on.**


### And a waterfall you can wear.

The live RF spectrum, on your wrist, tuned with the Digital Crown — as far as I can tell, the only SDR waterfall on Apple Watch on either app store. It draws its own pixels on the watch, at about a third of one CPU core.

---

I'm not a licensed amateur and I don't transmit. I'm a listener, fascinated by radio and by its history — and CarFM is the receiver I'd have loved to own, with a dial that feels like the ones that got me interested in the first place.

It started as a mobile skin for my own UberSDR instance, which went through **500+ tests** before I was happy with it. Every feature in this app has been designed and personally tested by me, on real hardware, across five devices — from an iPhone 17 Pro Max down to a **Moto G35 and an iPhone SE**, because if the GPU waterfall and the NEON DSP hold up on those, they hold up anywhere. I don't ship things I wouldn't use myself. I once spent hours chasing a clock that jumped a few pixels on cold start, once per session, that nobody would ever have consciously noticed. I'd have known.

**The code was written with AI assistance (Claude), and that's said up front.** I designed it, I broke it, I tested it, I filed the bugs and I signed off every release. Full source is public under GPL-3.0, mistakes and dead ends included. Nothing about how this app was made is hidden, because the honest thing to do is say it on the tin and then let people check. → [On AI, honestly](#on-ai-honestly)

---

A mobile-first SDR receiver app for iOS, Android **and Apple Watch** — and far more than a single-server client. CarFM speaks multiple SDR server protocols, runs **local SDR hardware on-device**, and does its own demodulation with a clean-room, GPL-free DSP engine. It pairs all of that with a GPU-rendered waterfall, native background audio, on-device decoders and maps, voice and in-car control — a genuinely great SDR experience on any phone, regardless of the receiver behind it.

**What CarFM connects to:**
- **Remote SDR servers** — native adapters for [UberSDR](https://ubersdr.org), **OpenWebRX / OpenWebRX+**, **KiwiSDR**, and **FM-DX Webserver** (the worldwide network of shared FM broadcast tuners), all behind one interface, with a directory chooser in the instance picker.
- **Local hardware** — plug an **RTL-SDR into an Android phone over USB** ("Local Hardware"), or connect to a networked **rtl_tcp** server from either platform. CarFM demodulates the raw IQ itself.
- **VibeServer** *(v8)* — turn an Android phone with an RTL-SDR into a **receiver anyone on your network can use, from a browser**. The phone does the DSP and sends compressed audio and a ready-made waterfall (~25× lighter than raw rtl_tcp), so it works comfortably over Wi-Fi or a hotspot. Point a browser at `vibesdr.local` — no app, no install.
- **Apple Watch** *(new in v9)* — **the waterfall itself, on your wrist.** Not a remote control with a few buttons: the live spectrum, drawn on the watch, with the Digital Crown to tune — while the iPhone stays locked in your pocket.
- **VibeDSP** — its own from-scratch, ARM-NEON-optimised DSP engine for the on-device paths (no SDR++ / FFTW / VOLK), so the local radio is fast, light on battery, and free of bundled third-party GPL DSP.

> Built by Stuart Carr (Stuey3D) with AI assistance from Claude (Anthropic).
> Free software under the GNU GPL-3.0.

---

## What actually sets CarFM apart

Plenty of apps can open a socket to a remote SDR and show you a picture of a waterfall. Two things here are not like that, and they're where the work went: **the controls** and **the waterfall**.

### The controls are built for a thumb, and they're meant to feel like an analogue tuner

Radios used to have a *weighted flywheel dial*. You could spin it and let it coast, feel it click through the detents, and slow it to a crawl to nail the last hundred hertz. That feeling is what CarFM's **VFO drum** is chasing — and it's a real simulation, not a slider with a texture on it:

- **It's a cylinder, not a strip.** The tick marks are projected onto a rotating drum — position follows `sin(d/R)`, brightness and width follow `cos(d/R)` — so it reads as something turning, not something sliding.
- **It has mass.** Flick it and it coasts under **friction (0.974 per 60th of a second)**, frame-rate normalised so it decays identically at 60 Hz and 120 Hz. Flicks below 50 px/s don't coast at all — lift means stop, exactly as a real dial with your finger still on it. The zoom drum runs much heavier friction (0.90), because you want zoom to *arrive* and stop, not drift.
- **It has detents you can feel.** A haptic tick every 22 px of travel, capped to ~35/second so a fast spin ratchets instead of buzzing. **The intensity adapts to how you're turning it:** deliberate, slow movements get a firm mechanical *click*; a fast spin gets a light ratchet tick; and when a coasting flick finally comes to rest, you feel a soft *thunk*.
- **It knows the difference between hunting and searching.** Thumb speed is tracked as a rolling average and the ratio changes *continuously* with it: move slowly and it takes up to **4× more travel per tuning step** — up to 176 px per step in precise mode — so fine-tuning a weak SSB signal is genuinely fine. Spin it fast and it gets out of your way. There's no mode switch for this; it's just how it responds to your thumb.
- **It always lands on the grid.** Tuning is quantised to whole steps and snapped, so you land on 7,153.0 kHz — never 7,153.437.
- **Zoom is a drum too** — one octave per 40 px, anchored on the frequency you're *tuned to* rather than the middle of the screen, so zooming in doesn't slide your signal off the display.

None of that is decoration. It's what makes the radio usable one-handed, on a phone, with a thumb, while you're standing on a hill.

### The waterfall is *our* pixels, not the server's picture

CarFM does **not** take the ready-made waterfall image the server draws and show it to you. It takes the **raw FFT bins**, and paints every pixel itself in a **Skia GPU runtime shader (SkSL)**:

- **The history is stored as raw intensity**, not as coloured pixels — so changing the palette, sharpness or contrast **restyles the entire waterfall you've already seen, instantly**. All 26 palettes (GQRX, Kiwi, CuteSDR, SdrDx, OpenWebRX, turbo, viridis, Night Vision…) repaint your history, not just the next line.
- **The shader invents the lines between the data.** Servers send spectrum frames about ten times a second; a waterfall that only scrolls when data arrives looks like a slideshow. So the shader **interpolates between adjacent FFT frames on the GPU**, synthesising 2 or 3 display lines per real frame, and scrolls them by moving a *uniform* rather than shifting any pixels (the history is a ring buffer — the pixels never move at all).
- **It glides at 120 Hz while you're touching it.** During interaction the scroll is driven on the UI thread at panel rate — no JavaScript in the frame loop at all — so tuning stays liquid on ProMotion. When you settle, it deliberately drops to discrete whole-pixel rows so the display idles and the battery stops paying for smoothness you're not looking at.
- Sharpening (unsharp mask) and an S-curve contrast run in the same shader pass, on the GPU, for free.

That's the difference between *displaying* a waterfall and *rendering* one — and it's why the waterfall could move to the Apple Watch at all: the watch computes its own pixels too.

### "Another app that does the same thing as the other 50"

It's a fair thing to be tired of, so here is the specific answer.

Most SDR clients are a socket and a picture: they ask the server for a waterfall image and put it on the screen, and the tuning is a slider or a numeric keypad. If that's the category, CarFM isn't in it.

- **It doesn't display the server's waterfall — it renders its own**, from raw FFT bins, in a GPU shader that synthesises the lines between the data frames and repaints your entire history the instant you change a palette.
- **It doesn't just demodulate somewhere else.** Plug an RTL-SDR into an Android phone and the whole radio runs *on the phone* — through a clean-room ARM-NEON DSP engine written from scratch (no SDR++, no FFTW, no VOLK), with true Weaver SSB, real FM stereo with a 19 kHz pilot PLL and RDS, and MMSE noise reduction.
- **It turns your phone into a server.** VibeServer shares your radio to anyone with a browser, ~25× lighter than raw rtl_tcp.
- **The waterfall runs on your watch.** Not media buttons — the live spectrum, tuned with the Digital Crown, phone locked in your pocket.
- **The tuning is a flywheel with mass, detents and speed-adaptive haptics**, not a slider.
- **It's GPLv3 and the source is right here.** Build it yourself, free, forever.

Judge it on the feel — that's the part a screenshot can't show, and it's the part we care most about getting right.

### On AI, honestly

**Said up front.** CarFM is vibe-coded — written by one curious listener working with Claude — and there's no attempt to hide that. You're reading it here, plainly, rather than having to discover it, suspect it, or be told it by someone else in a comments section. If you'd rather not run AI-assisted software, consider this your heads-up.

The scepticism is earned, though, and worth being precise about. There's a pattern doing the rounds: a closed-source app, an AI-generated feature list longer than any one person could have tested, decoders that "work" with no antenna plugged in, someone else's GPL code quietly folded in without credit, and a price tag on the end of it. **That's not a tooling problem — it's an honesty problem.** Every one of those failures is a choice the developer made, and the AI didn't make any of them.

So the fix isn't to hide the tooling. It's to be checkable:

- **The source is open.** GPLv3, all of it, right here. Not a demo, not a crippled build — what you build from this tree is the whole app. Read it, fork it, tell me where it's wrong.
- **Everyone who contributed is credited**, and the licences are honoured — see [Credits](#credits). Where the app leans on someone else's protocol or work, it says so by name.
- **Nothing is claimed that isn't there.** Every feature in this README exists, on a device, and has been used on the air. If you find one that doesn't work, that's a bug and I want the report — [open an issue](https://github.com/Stuey3D/VibeSDR/issues).
- **It leaves features on the table on purpose.** No native DAB+, DRM, HD Radio or DMR — those codecs are patent-encumbered, and shipping them would be a licensing violation dressed up as a feature list. No WebSDR — its author doesn't sanction third-party clients, so CarFM doesn't have one. Both decisions cost real features, and both are [written down](#why-doesnt-vibesdr-natively-decode-dab-drm-hd-radio-dmr-and-similar-digital-modes) with the reasoning. Saying no is the expensive option. It's also the one nobody bothers to fake.
- **It isn't a wrapper.** The DSP is a clean-room ARM-NEON engine written from scratch, the waterfall is an original shader, the controls are a hand-tuned physical simulation. That work is in the commit history, in the open, with its mistakes still visible.

### Tested on

Not a spec sheet — the actual devices every feature has been driven on, by me, on the air:

| | |
|---|---|
| **iPhone 17 Pro Max** | the easy one, where everything works |
| **iPhone SE (2nd gen)** | a 2020 A13 with a 4.7″ screen — the layout floor |
| **Moto G35** | a budget Android phone — the thermal and DSP floor |
| **Galaxy Tab A9** | Android tablet layout |
| **iPad Air 13″** | full-screen iPad, landscape decoders |
| **Apple Watch Ultra** | the wrist waterfall |
| **VibeServer web client** | Safari and Chrome, macOS and Windows |

The two that matter are the SE and the G35. Anyone can test on a Pro Max — that's testing where everything already works. If the GPU waterfall and the NEON DSP survive a budget Unisoc phone and a 2020 four-inch-class screen, they'll survive your phone.

### Every codec in here is one I'm entitled to ship

No patent-encumbered vocoders. No HD Radio, no DAB+, no DRM, no DMR/AMBE. Those decoders would be *easy* features to claim and hard ones to ship legally — the codecs behind them belong to Xperi and DVSI, and shipping them in a store build would be a licensing violation dressed up as a feature list. So they're not here, and [the reasons are written down](#why-doesnt-vibesdr-natively-decode-dab-drm-hd-radio-dmr-and-similar-digital-modes). Same with WebSDR: its author doesn't sanction third-party clients, so CarFM doesn't have one.

Both decisions cost real features, and I made them anyway. **That's the part you can check.**

**Use of AI isn't the thing worth judging.** Whether the result is honest, credited, open, and actually *works on a radio* is — and all four of those you can verify here rather than take my word for.

And if it turns out a vibe-coded app can give you a waterfall on your wrist and a tuning dial that feels like a real one, then the tool was never the interesting part of the argument.

## Get CarFM

CarFM is an independent fork and does not have its own App Store listing or pre-built release downloads. The way to run it is to **build it from this repository** — see [Building](#building). It's GPL-3.0, free, forever, with no crippled features and no nag screens.

---


## Features

### Display & waterfall
- **Our own pixels, not the server's picture** — the waterfall is rendered from raw FFT bins in a Skia GPU runtime shader (SkSL), never by displaying a server-supplied waterfall image
- **In-shader temporal line synthesis** — the GPU interpolates between spectrum frames to invent the display lines between them, so the scroll is smooth even though the data arrives ~10× a second. Scrolling moves a shader uniform over a ring buffer; no pixels are ever shifted
- **120 Hz while you're touching it** — the scroll runs on the UI thread at panel rate with no JavaScript in the frame loop, then drops to discrete rows when you settle so the display can idle and save battery
- **26 colour palettes** (GQRX, KiwiSDR, CuteSDR, SdrDx, OpenWebRX, turbo/viridis/inferno, Night Vision, Sonar…) — and because the history is stored as raw intensity, **switching palette, sharpness or contrast restyles the whole waterfall you've already seen, instantly**
- **Portrait and landscape** layouts, VFO glow and frost controls, S-meter calibration and selectable signal-meter modes
- **Spectrum backdrop image** with opacity control and station-ID overlay
- **Power saving** — half-rate spectrum, idle timeout, and the waterfall fully disconnects when backgrounded or when a map overlay is active

### Tuning & SDR controls — *thumb-first, analogue-feeling*
- **VFO drum** — a weighted-flywheel simulation: cylinder projection, momentum, friction decay, and **haptic detents whose intensity adapts to how fast you're turning** (a firm click when you're deliberate, a light ratchet when you spin, a soft thunk when it settles)
- **Velocity-adaptive ratio** — move slowly and it gives you up to **4× more travel per step** for genuinely fine tuning; spin fast and it gets out of the way. No mode switch needed
- **Precise / normal** toggle on top of that, doubling the finger travel per step when you want it
- **Zoom drum** — one octave per flick-length, anchored on the frequency you're tuned to (so zooming never slides your signal off-screen)
- **Everything lands on the step grid** — 7,153.0 kHz, never 7,153.437
- **Full mode set** — USB, LSB, AM, SAM, FM, NFM, CW
- **Bandwidth / passband sliders** mirrored around the carrier, matched to the server's limits
- **Noise reduction** — on-device NR, NR2 and noise blanker, plus server-side NR with a dynamic filter list and live parameter control
- **Squelch** (SNR and FM), AGC, volume and mute

### Audio
- **Native audio engines** on both iOS and Android (Opus over WebSocket) running outside any WebView, so playback survives JS suspension
- **Background audio** — keeps receiving when backgrounded on **both** platforms
- **Lock-screen / Now Playing / car / watch controls** — media-session metadata (frequency + station) with next/previous mapped to station or bookmark skip
- **AAC recorder** with share sheet

### On the wrist (Apple Watch) — new in v9
- **The waterfall itself, on the watch** — not a remote control with a few buttons. The live spectrum is drawn on the watch from the same data and the same palette as the phone
- **Turn the Digital Crown to tune**; tap the frequency to type one on a passcode-style pad; press and hold the waterfall for the menu (demodulator, tuning step, zoom, brightness, contrast, saved servers)
- **It works with the iPhone locked in your pocket** — and it will **start the phone for you**: open the watch app with CarFM closed and the phone wakes in the background, connects to your default receiver, and the waterfall arrives on your wrist **without the phone's screen ever coming on**
- **Four screens, chosen by what the receiver actually is** — the spectrum waterfall; the FM-DX tuner (station, distance, RDS); the DAB service list (where the Crown *selects* a service, because DAB is a list, not a continuum); and the ADS-B aircraft table
- **Switch receivers from your favourites**, and **control the iPhone's system volume and mute** from the wrist — mirroring the phone's *real* volume, including changes you make on the phone, so the two can never disagree
- **The band you're in, in words** ("20m Ham Band", "41m Broadcast Band"), from the ITU band plan for wherever the **receiver** is, with ticker marks showing where that band ends
- **Your watch's own battery** next to the clock — a live waterfall costs the watch about a third of a CPU core, and this is an app you might leave running on a hilltop

### Local SDR hardware & on-device DSP
- **USB RTL-SDR on Android** — plug an RTL-SDR (incl. RTL-SDR Blog V4) into the phone and CarFM runs the whole radio on-device: full waterfall, drum, audio, decoders and a hardware-control submenu (gain, PPM, bias-T, AGC, sample rate, direct sampling)
- **rtl_tcp** — connect to a networked rtl_tcp server from **both** iOS and Android
- **VibeDSP engine** — a clean-room C++ DSP core written from scratch, hand-optimised with **ARM NEON SIMD** across every hot path; no SDR++ / FFTW / VOLK / GPL third-party DSP bundled. Runs cooler and lighter on the battery, especially on low-end phones and tablets
- **Real demodulation quality** — true single-sideband SSB with proper image rejection (Weaver), genuine FM stereo with a 19 kHz pilot PLL + RDS, audio AGC for AM/SSB/CW, working 50/75 µs de-emphasis, MMSE noise reduction and an adaptive auto-notch

### Voice control
- **Siri (iOS)** — "Hey Siri, tune CarFM" then a frequency, a station name, or a band; it tunes with the right demodulator and step, and reads a pick-list when a name matches several bookmarks. Also "change CarFM mode" and "set CarFM step rate". Works in the background over headphones / CarPlay / the lock screen

### Decoders & maps
- **On-device decoders** — RTTY, NAVTEX, WEFAX, SSTV, Morse, and speech-to-text
- **Server maps** — HFDL aircraft, digital, and CW activity maps (Leaflet, fully embedded — no external CDN)
- **Spots tables** for digital and CW activity

### Stations, bookmarks & social
- **Instance picker** — a directory chooser across UberSDR, OpenWebRX/OpenWebRX+, KiwiSDR and FM-DX Webserver receivers (plus Receiverbook), with location-aware sorting, country flags, favourites, and an auto-connect default. **Local Hardware** is pinned to the top on Android.
- **FM-DX Webserver tuner** — connect to the worldwide network of shared FM broadcast tuners (`servers.fmdx.org`). A vintage analogue tuning dial that learns station names as you tune, full RDS (PS, RadioText, PI, PTY, TP/TA, stereo), a dBf signal meter, transmitter details (site, power, distance, bearing), tap-to-tune alternative frequencies, station logos and country flags. Because the tuner is shared, there's built-in chat, a listener counter, and the lock-screen skip controls are disabled. Station logos and country flags also carry over to local RTL-SDR and networked WFM via the RDS PI code, cached on-device for offline use.
- **Bookmark & band-plan search** with live (session-dynamic) EiBi schedules, in a scrollable result list
- **User bookmarks** — per-instance or global, UberSDR-compatible import/export
- **Visual Tuning System (VTS)** — on-screen nearby-station bar, band-crossing and on-tune popups, and station/bookmark skipping
- **Live chat** with user list, mute, and zoom/tune sync
- **Share** a tuned station as a tappable deep link
- **Admin pages in-app** — Admin, Noise Floor, Band Conditions, Listeners

### In the car
- **Android Auto** — browsable **Bookmarks** and **Band Plan** lists on the head unit (tap to tune), plus Now Playing + skip controls
- **Band-aware tuning** — picking a band, or crossing a band edge via remote controls, sets the right demodulator and step (e.g. 20m → USB/500 Hz, AM broadcast → AM/9–10 kHz by region)
- **Data Saver** — after a chosen spell muted (lock screen / AirPods out / pause) the stream disconnects to save mobile data and battery; the media controls show a countdown, then reconnect on Play
- CarPlay browsing is built and ready, pending Apple's CarPlay-audio entitlement

### Accessibility
- Atkinson Hyperlegible UI typeface and an accessibility-oriented menu with larger touch targets

## Enabling Android Auto

CarFM is sideloaded (not on the Play Store), and Android Auto only trusts Play Store apps by default — so you must turn on **Unknown sources** for it to appear in the car:

1. Build and install the **`.apk`** on the phone (see [Building](#building)).
2. Open **Android Auto settings** (phone Settings → *Connected devices → Android Auto*; on some phones it's a standalone "Android Auto" app).
3. Scroll to the bottom and tap **"Version"** about **10 times** until developer mode unlocks.
4. Tap the **⋮ menu → Developer settings**, and turn on **"Unknown sources"** (sometimes "Add new cars to Android Auto" / "Add unknown apps").
5. **Open CarFM and connect to a server once** — this loads your bookmarks and pushes the browse lists to the car (they're also cached for later).
6. Connect to the head unit; **CarFM** appears in the car's media apps with the **Bookmarks** and **Band Plan** folders.

If it doesn't show up, it's almost always step 3–4 (Unknown sources). If it appears but the lists are empty, open the app and connect to a server, then reconnect Android Auto.
- Tested down to 4-inch screens (iPhone SE in Display Zoom mode)

## Installing on iPhone (signing the `.ipa` with Xcode)

CarFM isn't on the App Store, so you build the `.ipa` yourself (see [Building](#building)) and sign it with your own Apple ID before an iPhone will run it. Building in Xcode signs it with your team directly; the steps below are for signing an already-built `.ipa` (e.g. one you built on another Mac). A free Apple ID works — no paid Developer Programme membership is required, but a free signing certificate **expires after 7 days**, so you'll need to re-sign roughly weekly (a paid account lasts a year).

You'll need a **Mac with Xcode** installed.

1. Build the **`.ipa`** (see [Building](#building)) and copy it to your Mac.
2. Open **Xcode → Settings → Accounts**, click **+**, and sign in with your Apple ID (this is your free signing account).
3. Rename the file from `CarFM.ipa` to `CarFM.zip` and unzip it — you'll get a **`Payload`** folder containing **`CarFM.app`**.
4. Open **Xcode → Window → Devices and Simulators**, plug in your iPhone via USB, and **Trust** the computer when prompted.

Because the `.ipa` is signed with a different team, the simplest reliable route to re-sign it with your own Apple ID is one of the free tools built for exactly this:

- **[Sideloadly](https://sideloadly.io)** (Mac or Windows) — drag the `.ipa` in, enter your Apple ID, plug in the phone, and click **Start**. It re-signs with your account and installs in one step. **Recommended.**
- **[AltStore](https://altstore.io)** — installs a companion app on your phone that re-signs automatically over Wi-Fi, so you don't have to re-do it manually every 7 days.

**Pure-Xcode route** (no extra tools): open your own copy of the project in Xcode, select your Apple ID under **Signing & Capabilities → Team**, then **Product → Archive → Distribute App → Development** and install to the connected device via **Devices and Simulators → Install App**. This requires the source project, not just the `.ipa`.

After installing, go to **iPhone Settings → General → VPN & Device Management**, tap your Apple ID under *Developer App*, and **Trust** it — otherwise the app won't launch.

---

## Building

CarFM is an Expo (SDK 56 / React Native 0.85) app with custom native modules, built directly from the native projects — **do not run `expo prebuild --clean`** (it wipes the custom native code).

### Prerequisites
- Node.js 18+ and `npm install`
- Xcode 16+ and CocoaPods (iOS)
- Android SDK / JDK 17 (Android)

### iOS (release archive + device install)
```bash
cd ios && pod install && cd ..
xcodebuild -workspace ios/CarFM.xcworkspace -scheme CarFM \
  -configuration Release -sdk iphoneos \
  -archivePath /tmp/CarFM.xcarchive archive \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<YOUR_TEAM_ID>
xcodebuild -exportArchive -archivePath /tmp/CarFM.xcarchive \
  -exportPath /tmp/CarFM-export -exportOptionsPlist <your-export-options.plist>
xcrun devicectl device install app --device <DEVICE_UUID> \
  /tmp/CarFM-export/CarFM.ipa
```

### Android (release APK / AAB)
```bash
cd android && ./gradlew assembleRelease     # APK; use bundleRelease for a Play Store .aab
adb install -r app/build/outputs/apk/release/app-release.apk
```
The Android native DSP (C++/NDK) is rebuilt automatically by Gradle.

### iOS native DSP
iOS links the VibeDSP engine as a **prebuilt static library** (`modules/vibe-local-sdr/libs/libvibelocalsdr_ios.a`). If you change any shared C++ under `android/app/src/main/cpp/`, rebuild it before archiving iOS, or the IPA will ship the old engine:
```bash
cd modules/vibe-local-sdr && ./build_ios.sh
```

---

## Credits

| Name | Role |
|---|---|
| **Stuart Carr (Stuey3D)** | UI/UX design, concept & testing |
| **madpsy (M9PSY)** | Creator of UberSDR — protocol, DSP algorithms (NR2 / noise blanker / WebSDR-NR), colour palettes, band plans and bookmark format |
| **Phil Karn (KA9Q)** | ka9q-radio (radiod), the SDR engine underneath UberSDR |
| **John Seamons (ZL/KF6VO)** | Creator of KiwiSDR |
| **Jakob Ketterl (DD5JFK) & the OpenWebRX+ project** | OpenWebRX / OpenWebRX+ servers |
| **NoobishSVK & contributors** | FM-DX Webserver + the servers.fmdx.org receiver map — protocol reference for the FM-DX backend and its 3LAS MP3 audio (GPL-3.0) |
| **radio-browser.info** | Community station directory used to look up FM-DX / RDS station logos |
| **Konrad Kosmatka** | librdsparser — reference for the RDS PI + ECC → country mapping (IEC 62106) behind the RDS country flags |
| **Osmocom / librtlsdr** | RTL-SDR USB driver (Android local hardware + rtl_tcp) |
| **Mark Borgerding (KissFFT)** | BSD-licensed FFT vendored in the VibeDSP engine |
| **Karlis Goba (ft8_lib)** | FT8 / FT4 decoding |
| **Xiph.Org Foundation** | Opus audio codec |
| **EiBi** | Shortwave broadcast schedules for live station bookmarks |
| **Leaflet, OpenStreetMap & CARTO** | Map rendering and tiles |
| **Braille Institute** | Atkinson Hyperlegible typeface |
| **Claude (Anthropic)** | AI coding and development assistant |
| **Expo, React Native, Hermes, Skia, Reanimated, Gesture Handler, OkHttp** | App framework and native stack |

---

## Licence

CarFM is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3** as published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Full licence: <https://www.gnu.org/licenses/gpl-3.0.html>

The official App Store / Google Play / TestFlight builds are covered by an additional permission under GPLv3 §7 — see [`APPSTORE-EXCEPTION.md`](APPSTORE-EXCEPTION.md). The complete source for every released build remains available here under the GPLv3.

UberSDR, OpenWebRX/OpenWebRX+, KiwiSDR and FM-DX Webserver are the property of their respective creators and subject to their own licence terms.

## Why no WebSDR support?

Intentional. WebSDR (websdr.org) is closed-source software, and its author has not
sanctioned third-party clients. CarFM only implements platforms that welcome
independent clients — every backend it speaks to is either open source or supported
with its creator's blessing (see Credits). Out of respect for that principle,
WebSDR support will not be added.

## Why doesn't CarFM natively decode DAB+, DRM, HD Radio, DMR and similar digital modes?

Patents and codec licensing — not technical difficulty. The VibeDSP engine could
implement these demodulators, but the audio codecs behind them are legally encumbered
for distribution in a shipped app:

- **HD Radio** — Xperi's patent portfolio and trademark licensing programme.
- **DAB+ / DRM** — HE-AAC / xHE-AAC codec licensing.
- **DMR, D-STAR, System Fusion, NXDN** — the AMBE/IMBE vocoders (DVSI patents).

Shipping unlicensed implementations of these in App Store / Play Store builds is a
risk CarFM will not take. Genuinely open digital voice modes (Codec2-based FreeDV
and M17) are unencumbered and remain candidates for native support.

**The supported route:** many OpenWebRX / OpenWebRX+ servers decode digital modes
**server-side**. When you select such a mode on one of those servers, CarFM simply
plays the already-decoded PCM audio stream the server sends — no demodulator or codec
ships in, or runs inside, the app. That is why DAB+ "works" in CarFM on some servers
despite none of these decoders existing in the app itself.

## Why do the skip buttons vanish on FM-DX?

An FM-DX Webserver is **one physical tuner shared by every connected listener** — tuning
it retunes it for everyone at once. Lock-screen and in-car skip buttons would let you
change the station for people you can't see, so they're disabled out of courtesy while
connected to FM-DX. On the Apple Watch, the Crown is likewise disarmed until you
deliberately arm it. One tuner, many listeners.

## Privacy

CarFM collects no personal data and has no analytics, ads, or tracking. Location is optional (used only to sort instances by distance). See [`PRIVACY.md`](PRIVACY.md).
