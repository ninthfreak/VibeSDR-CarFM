# VibeSDR

A mobile-first SDR receiver app for iOS and Android — and far more than a single-server client. VibeSDR speaks multiple SDR server protocols, runs **local SDR hardware on-device**, and does its own demodulation with a clean-room, GPL-free DSP engine. It pairs all of that with a GPU-rendered waterfall, native background audio, on-device decoders and maps, voice and in-car control — a genuinely great SDR experience on any phone, regardless of the receiver behind it.

**What VibeSDR connects to:**
- **Remote SDR servers** — native adapters for [UberSDR](https://ubersdr.org), **OpenWebRX / OpenWebRX+**, **KiwiSDR**, and **FM-DX Webserver** (the worldwide network of shared FM broadcast tuners), all behind one interface, with a directory chooser in the instance picker.
- **Local hardware** — plug an **RTL-SDR into an Android phone over USB** ("Local Hardware"), or connect to a networked **rtl_tcp** server from either platform. VibeSDR demodulates the raw IQ itself.
- **VibeServer** *(v8)* — turn an Android phone with an RTL-SDR into a **receiver anyone on your network can use, from a browser**. The phone does the DSP and sends compressed audio and a ready-made waterfall (~25× lighter than raw rtl_tcp), so it works comfortably over Wi-Fi or a hotspot. Point a browser at `vibesdr.local` — no app, no install.
- **Apple Watch** *(new in v9)* — **the waterfall itself, on your wrist.** Not a remote control with a few buttons: the live spectrum, drawn on the watch, with the Digital Crown to tune — while the iPhone stays locked in your pocket.
- **VibeDSP** — its own from-scratch, ARM-NEON-optimised DSP engine for the on-device paths (no SDR++ / FFTW / VOLK), so the local radio is fast, light on battery, and free of bundled third-party GPL DSP.

> Built by Stuart Carr (Stuey3D) with AI assistance from Claude (Anthropic).
> Free software under the GNU GPL-3.0.

## Get VibeSDR

| | | |
|---|---|---|
| **iPhone / iPad** | **[App Store](https://apps.apple.com/gb/app/vibesdr/id6786344049)** — £2.99 | Currently **v6.1**. Newer versions are working their way through review — **v9 is heading to TestFlight**. |
| **iPhone / iPad** | **[`.ipa` from the latest release](https://github.com/Stuey3D/VibeSDR/releases/latest)** — free | Always the newest version, but you must **re-sign it yourself** — see [Installing on iPhone](#installing-on-iphone-signing-the-ipa-with-xcode). |
| **Android** | **[`.apk` from the latest release](https://github.com/Stuey3D/VibeSDR/releases/latest)** — free | Always the newest version. Just install it. |
| **Anyone** | **Build it from this repository** — free, forever | See [Building](#building). |

**Why does the App Store version cost £2.99 when the source is free?** It goes towards Apple's fees — the Developer Programme costs $99 a year, and Apple takes its cut of every sale on top. The £2.99 covers the cost of *being on the App Store at all*; it isn't what VibeSDR is worth, because VibeSDR is GPLv3 free software and always will be.

The App Store build is the same source you see here. If you'd rather not pay, **build it yourself from this repository, free, forever** — same app, no crippled features, no nag screens, no catch. Paying is just the convenient route (and it keeps the certificate alive for everyone who takes it).

> **📱 On iOS, the App Store is behind the releases here.** Apple review has been slow, so the store is still serving **v6.1** — which predates **VibeServer** (v8) and the **Apple Watch app** (v9). To run v9 on an iPhone today, sideload the `.ipa` from the [latest release](https://github.com/Stuey3D/VibeSDR/releases/latest); a **TestFlight build of v9 is on its way**, which will let you install it without re-signing anything.

**Latest release: [v9.0.0 — The Apple Watch companion](https://github.com/Stuey3D/VibeSDR/releases/latest)** — the live waterfall on your wrist, tuned with the Digital Crown, with the phone locked in your pocket. Plus the fix for a waterfall that could freeze for good on mobile data and never come back.

![VibeSDR on an Apple Watch Ultra](screenshots/21-watch-wrist-am.jpeg)
*Not a screenshot of the phone — this is the waterfall running **on the watch**. 648 kHz AM, S8, with the iPhone locked in a pocket.*

![VibeSDR web client](docs/screenshots/v8-web-client.png)
*The VibeServer web client — served by an Android phone with an RTL-SDR, open in Safari at `vibesdr-moto-g35.local`.*

---

## Screenshots

### Apple Watch (new in v9)

| | |
|---|---|
| ![Watch waterfall — 40m](screenshots/22-watch-waterfall-40m.png) | ![Watch FM-DX](screenshots/23-watch-fmdx.png) |
| *The live waterfall on the wrist — 40m Ham Band, S5. Turn the Crown to tune; the ticker marks where the band ends* | *The FM-DX screen — station, RDS RadioText, transmitter site + distance (Bilsdale West Moor, 84 km), and a tuning dial* |

### FM-DX Webserver (new in v7)

| | |
|---|---|
| ![FM-DX tuner](screenshots/19-fmdx-tuner.png) | ![FM-DX lock screen](screenshots/20-fmdx-lockscreen.png) |
| *FM-DX tuner — vintage dial that learns station names, RDS, transmitter info, tap-to-tune AFs, station logo + flag (Newcastle-upon-Tyne)* | *Lock-screen Now Playing — station logo inlay + frequency (BBC R2 · 89.0)* |

| | | |
|---|---|---|
| ![Portrait waterfall](screenshots/03-waterfall-portrait.jpeg) | ![Lock screen](screenshots/05-lockscreen.jpeg) | ![Apple Watch](screenshots/06-apple-watch.jpeg) |
| *GPU waterfall — portrait, AM broadcast* | *Lock-screen Now Playing (frequency · mode · step)* | *Apple Watch media controls* |

| | |
|---|---|
| ![AM broadcast — landscape](screenshots/01-waterfall-am-landscape.png) | ![40m ham — band-aware](screenshots/02-band-aware-40m.jpeg) |
| *Landscape waterfall with spectrum backdrop — Radio Caroline* | *40m ham in LSB / 500 Hz with live band conditions* |

| | |
|---|---|
| ![Menu](screenshots/04-menu-controls.jpeg) | ![In the car](screenshots/07-in-car.jpeg) |
| *Audio menu — passband, server NR, recording, squelch* | *In the car — band-aware tuning + head-unit metadata over Bluetooth* |

### Local SDR hardware (USB RTL-SDR on the phone — no server)

| | |
|---|---|
| ![USB RTL-SDR on a phone](screenshots/08-local-rtlsdr-usb.jpeg) | ![RTL-SDR controls](screenshots/09-rtl-sdr-controls.jpeg) |
| *RTL-SDR Blog V4 plugged straight into the phone — Radio Europe, 6130 kHz AM* | *Hardware controls — sample rate, PPM, bias-T, AGC, direct sampling* |

### Decoders, DAB & in-car

| | | |
|---|---|---|
| ![RTTY decode](screenshots/11-rtty-decode.jpeg) | ![DAB+ via OpenWebRX](screenshots/10-dab-iphone.png) | ![Apple CarPlay](screenshots/12-carplay.jpeg) |
| *On-device RTTY decode (RYRY · CQ DE DDK2)* | *DAB+ via an OpenWebRX server — Radio X, SDL National Multiplex* | *Apple CarPlay — Now Playing with VTS station art* |

| | | |
|---|---|---|
| ![Android Auto Now Playing](screenshots/13-android-auto-nowplaying.jpeg) | ![Android Auto Band Plan](screenshots/14-android-auto-bandplan.jpeg) | ![Android Auto Bookmarks](screenshots/15-android-auto-bookmarks.jpeg) |
| *Android Auto — Now Playing, 648 kHz AM* | *Android Auto — browsable Band Plan (tap to tune)* | *Android Auto — browsable Bookmarks* |

### On iPad

VibeSDR runs full-screen on iPad, with the on-screen decoders available in landscape (which a phone doesn't have the room for).

| | | |
|---|---|---|
| ![iPad decoder in landscape](screenshots/16-ipad-decoder-landscape.jpeg) | ![iPad waterfall landscape](screenshots/17-ipad-waterfall-landscape.jpeg) | ![iPad portrait](screenshots/18-ipad-portrait.jpeg) |
| *iPad — RTTY decoder in landscape* | *iPad — full-screen waterfall (landscape)* | *iPad — portrait* |

---

## Features

### Display & waterfall
- **Custom GPU waterfall and spectrum** — rendered with a Skia runtime shader, with in-shader temporal line synthesis for a smooth, high-frame-rate display independent of the server's own waterfall
- **Portrait and landscape** layouts, ProMotion 120 Hz rendering, haptic tuning feedback
- **Colour palettes** (GQRX, KiwiSDR, CuteSDR, SdrDx, OpenWebRX, matplotlib origins), VFO glow and frost controls, S-meter calibration and selectable signal-meter modes
- **Spectrum backdrop image** with opacity control and station-ID overlay
- **Power saving** — half-rate spectrum, idle timeout, and the waterfall fully disconnects when backgrounded or when a map overlay is active

### Tuning & SDR controls
- **VFO drum** with inertia scrolling and friction decay; precise / normal resolution toggle
- **Dual-drum waterfall zoom**
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
- **It works with the iPhone locked in your pocket** — and it will **start the phone for you**: open the watch app with VibeSDR closed and the phone wakes in the background, connects to your default receiver, and the waterfall arrives on your wrist **without the phone's screen ever coming on**
- **Four screens, chosen by what the receiver actually is** — the spectrum waterfall; the FM-DX tuner (station, distance, RDS); the DAB service list (where the Crown *selects* a service, because DAB is a list, not a continuum); and the ADS-B aircraft table
- **Switch receivers from your favourites**, and **control the iPhone's system volume and mute** from the wrist — mirroring the phone's *real* volume, including changes you make on the phone, so the two can never disagree
- **The band you're in, in words** ("20m Ham Band", "41m Broadcast Band"), from the ITU band plan for wherever the **receiver** is, with ticker marks showing where that band ends
- **Your watch's own battery** next to the clock — a live waterfall costs the watch about a third of a CPU core, and this is an app you might leave running on a hilltop

### Local SDR hardware & on-device DSP
- **USB RTL-SDR on Android** — plug an RTL-SDR (incl. RTL-SDR Blog V4) into the phone and VibeSDR runs the whole radio on-device: full waterfall, drum, audio, decoders and a hardware-control submenu (gain, PPM, bias-T, AGC, sample rate, direct sampling)
- **rtl_tcp** — connect to a networked rtl_tcp server from **both** iOS and Android
- **VibeDSP engine** — a clean-room C++ DSP core written from scratch, hand-optimised with **ARM NEON SIMD** across every hot path; no SDR++ / FFTW / VOLK / GPL third-party DSP bundled. Runs cooler and lighter on the battery, especially on low-end phones and tablets
- **Real demodulation quality** — true single-sideband SSB with proper image rejection (Weaver), genuine FM stereo with a 19 kHz pilot PLL + RDS, audio AGC for AM/SSB/CW, working 50/75 µs de-emphasis, MMSE noise reduction and an adaptive auto-notch

### Voice control
- **Siri (iOS)** — "Hey Siri, tune VibeSDR" then a frequency, a station name, or a band; it tunes with the right demodulator and step, and reads a pick-list when a name matches several bookmarks. Also "change VibeSDR mode" and "set VibeSDR step rate". Works in the background over headphones / CarPlay / the lock screen

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

VibeSDR is sideloaded (not on the Play Store), and Android Auto only trusts Play Store apps by default — so you must turn on **Unknown sources** for it to appear in the car:

1. Install the **`.apk`** from the [latest release](https://github.com/Stuey3D/VibeSDR/releases/latest) on the phone.
2. Open **Android Auto settings** (phone Settings → *Connected devices → Android Auto*; on some phones it's a standalone "Android Auto" app).
3. Scroll to the bottom and tap **"Version"** about **10 times** until developer mode unlocks.
4. Tap the **⋮ menu → Developer settings**, and turn on **"Unknown sources"** (sometimes "Add new cars to Android Auto" / "Add unknown apps").
5. **Open VibeSDR and connect to a server once** — this loads your bookmarks and pushes the browse lists to the car (they're also cached for later).
6. Connect to the head unit; **VibeSDR** appears in the car's media apps with the **Bookmarks** and **Band Plan** folders.

If it doesn't show up, it's almost always step 3–4 (Unknown sources). If it appears but the lists are empty, open the app and connect to a server, then reconnect Android Auto.
- Tested down to 4-inch screens (iPhone SE in Display Zoom mode)

## Installing on iPhone (signing the `.ipa` with Xcode)

VibeSDR isn't on the App Store, so the `.ipa` from the [latest release](https://github.com/Stuey3D/VibeSDR/releases/latest) has to be **re-signed with your own Apple ID** before an iPhone will run it. A free Apple ID works — no paid Developer Programme membership is required, but a free signing certificate **expires after 7 days**, so you'll need to re-sign roughly weekly (a paid account lasts a year).

You'll need a **Mac with Xcode** installed.

1. Download the **`.ipa`** from the [latest release](https://github.com/Stuey3D/VibeSDR/releases/latest) to your Mac.
2. Open **Xcode → Settings → Accounts**, click **+**, and sign in with your Apple ID (this is your free signing account).
3. Rename the file from `VibeSDR.ipa` to `VibeSDR.zip` and unzip it — you'll get a **`Payload`** folder containing **`VibeSDR.app`**.
4. Open **Xcode → Window → Devices and Simulators**, plug in your iPhone via USB, and **Trust** the computer when prompted.

Because the `.ipa` is signed with a different team, the simplest reliable route to re-sign it with your own Apple ID is one of the free tools built for exactly this:

- **[Sideloadly](https://sideloadly.io)** (Mac or Windows) — drag the `.ipa` in, enter your Apple ID, plug in the phone, and click **Start**. It re-signs with your account and installs in one step. **Recommended.**
- **[AltStore](https://altstore.io)** — installs a companion app on your phone that re-signs automatically over Wi-Fi, so you don't have to re-do it manually every 7 days.

**Pure-Xcode route** (no extra tools): open your own copy of the project in Xcode, select your Apple ID under **Signing & Capabilities → Team**, then **Product → Archive → Distribute App → Development** and install to the connected device via **Devices and Simulators → Install App**. This requires the source project, not just the `.ipa`.

After installing, go to **iPhone Settings → General → VPN & Device Management**, tap your Apple ID under *Developer App*, and **Trust** it — otherwise the app won't launch.

---

## Building

VibeSDR is an Expo (SDK 56 / React Native 0.85) app with custom native modules, built directly from the native projects — **do not run `expo prebuild --clean`** (it wipes the custom native code).

### Prerequisites
- Node.js 18+ and `npm install`
- Xcode 16+ and CocoaPods (iOS)
- Android SDK / JDK 17 (Android)

### iOS (release archive + device install)
```bash
cd ios && pod install && cd ..
xcodebuild -workspace ios/VibeSDR.xcworkspace -scheme VibeSDR \
  -configuration Release -sdk iphoneos \
  -archivePath /tmp/VibeSDR.xcarchive archive \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<YOUR_TEAM_ID>
xcodebuild -exportArchive -archivePath /tmp/VibeSDR.xcarchive \
  -exportPath /tmp/VibeSDR-export -exportOptionsPlist <your-export-options.plist>
xcrun devicectl device install app --device <DEVICE_UUID> \
  /tmp/VibeSDR-export/VibeSDR.ipa
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

VibeSDR is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3** as published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Full licence: <https://www.gnu.org/licenses/gpl-3.0.html>

The official App Store / Google Play / TestFlight builds are covered by an additional permission under GPLv3 §7 — see [`APPSTORE-EXCEPTION.md`](APPSTORE-EXCEPTION.md). The complete source for every released build remains available here under the GPLv3.

UberSDR, OpenWebRX/OpenWebRX+, KiwiSDR and FM-DX Webserver are the property of their respective creators and subject to their own licence terms.

## Why no WebSDR support?

Intentional. WebSDR (websdr.org) is closed-source software, and its author has not
sanctioned third-party clients. VibeSDR only implements platforms that welcome
independent clients — every backend it speaks to is either open source or supported
with its creator's blessing (see Credits). Out of respect for that principle,
WebSDR support will not be added.

## Why doesn't VibeSDR natively decode DAB+, DRM, HD Radio, DMR and similar digital modes?

Patents and codec licensing — not technical difficulty. The VibeDSP engine could
implement these demodulators, but the audio codecs behind them are legally encumbered
for distribution in a shipped app:

- **HD Radio** — Xperi's patent portfolio and trademark licensing programme.
- **DAB+ / DRM** — HE-AAC / xHE-AAC codec licensing.
- **DMR, D-STAR, System Fusion, NXDN** — the AMBE/IMBE vocoders (DVSI patents).

Shipping unlicensed implementations of these in App Store / Play Store builds is a
risk VibeSDR will not take. Genuinely open digital voice modes (Codec2-based FreeDV
and M17) are unencumbered and remain candidates for native support.

**The supported route:** many OpenWebRX / OpenWebRX+ servers decode digital modes
**server-side**. When you select such a mode on one of those servers, VibeSDR simply
plays the already-decoded PCM audio stream the server sends — no demodulator or codec
ships in, or runs inside, the app. That is why DAB+ "works" in VibeSDR on some servers
(see the screenshots) despite none of these decoders existing in the app itself.

## Why do the skip buttons vanish on FM-DX?

An FM-DX Webserver is **one physical tuner shared by every connected listener** — tuning
it retunes it for everyone at once. Lock-screen and in-car skip buttons would let you
change the station for people you can't see, so they're disabled out of courtesy while
connected to FM-DX. On the Apple Watch, the Crown is likewise disarmed until you
deliberately arm it. One tuner, many listeners.

## Privacy

VibeSDR collects no personal data and has no analytics, ads, or tracking. Location is optional (used only to sort instances by distance). See [`PRIVACY.md`](PRIVACY.md).
