# CarFM

> **CarFM was originally forked from [VibeSDR](https://github.com/Stuey3D/VibeSDR)** by Stuart (Stuey3D). This is an independent fork under the GPL-3.0 licence; it is not affiliated with or endorsed by the original project.

CarFM is a fork of VibeSDR, a mobile-first software-defined-radio (SDR) receiver for iOS and Android. The codebase connects to remote SDR servers (UberSDR, OpenWebRX/OpenWebRX+, KiwiSDR, FM-DX Webserver) and to local RTL-SDR hardware, with on-device demodulation, a GPU-rendered waterfall, and an Apple Watch companion.

This fork's changes are recorded in the git history. It has no App Store listing or pre-built release downloads — the way to run it is to **build it from source** (see [Building](#building)).

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

CarFM inherits its engine and integrations from VibeSDR and the projects below. Their work is retained and credited here.

| Name | Role |
|---|---|
| **Stuart Carr (Stuey3D)** | Original VibeSDR — UI/UX design, concept & testing |
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

UberSDR, OpenWebRX/OpenWebRX+, KiwiSDR and FM-DX Webserver are the property of their respective creators and subject to their own licence terms.

## Privacy

CarFM collects no personal data and has no analytics, ads, or tracking. Location is optional (used only to sort instances by distance). See [`PRIVACY.md`](PRIVACY.md).
