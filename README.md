# VibeSDR

A mobile-first SDR receiver app for iOS and Android. VibeSDR is a fully native client for [UberSDR](https://ubersdr.org) receivers, with its own GPU-rendered waterfall, native background audio, and on-device decoders — so you get a genuinely great SDR experience on any phone, no matter which UberSDR instance you connect to and whether or not its owner has installed any mobile UI.

> Built by Stuart Carr (Stuey3D) with AI assistance from Claude (Anthropic).
> Free software under the GNU GPL-3.0.

**Latest release: [v2.0.1](https://github.com/Stuey3D/VibeSDR/releases/latest)** — iOS `.ipa` and Android `.apk`.

---

## Screenshots

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
- **Full mode set** — USB, LSB, AM, SAM, FM, NFM, CW (upper/lower)
- **Bandwidth / passband sliders** mirrored around the carrier, matched to the server's limits
- **Noise reduction** — on-device NR, NR2 and noise blanker, plus server-side NR with a dynamic filter list and live parameter control
- **Squelch** (SNR and FM), AGC, volume and mute

### Audio
- **Native audio engines** on both iOS and Android (Opus over WebSocket) running outside any WebView, so playback survives JS suspension
- **Background audio** — keeps receiving when backgrounded on **both** platforms
- **Lock-screen / Now Playing / car / watch controls** — media-session metadata (frequency + station) with next/previous mapped to station or bookmark skip
- **AAC recorder** with share sheet

### Decoders & maps
- **On-device decoders** — RTTY, NAVTEX, WEFAX, SSTV, Morse, and speech-to-text
- **Server maps** — HFDL aircraft, digital, and CW activity maps (Leaflet, fully embedded — no external CDN)
- **Spots tables** for digital and CW activity

### Stations, bookmarks & social
- **Instance picker** — browse public UberSDR receivers, location-aware sorting, country flags, favourites, and an auto-connect default
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

### Android (release APK)
```bash
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

---

## Credits

| Name | Role |
|---|---|
| **Stuart Carr (Stuey3D)** | UI/UX design, concept & testing |
| **madpsy (M9PSY)** | Creator of UberSDR — protocol, DSP algorithms (NR2 / noise blanker / WebSDR-NR), colour palettes, band plans and bookmark format |
| **Phil Karn (KA9Q)** | ka9q-radio (radiod), the SDR engine underneath UberSDR |
| **John Seamons (ZL/KF6VO)** | Creator of KiwiSDR |
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

UberSDR and KiwiSDR are the property of their respective creators and subject to their own licence terms.

## Privacy

VibeSDR collects no personal data and has no analytics, ads, or tracking. Location is optional (used only to sort instances by distance). See [`PRIVACY.md`](PRIVACY.md).
