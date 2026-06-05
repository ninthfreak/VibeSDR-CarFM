# VibeSDR

A mobile-first SDR receiver app for iOS and Android, built with Expo / React Native. VibeSDR wraps the [UberSDR](https://ubersdr.org) web interface and applies a full custom mobile skin so you get a genuinely great SDR experience on any phone — no matter which UberSDR instance you connect to.

> Built by Stuart Carr (Stuey3D) with AI assistance from Claude (Anthropic).

---

## Features

### Interface & Skins
- **Two skins** selectable on first launch:
  - **Default** — Nixie-tube amber glow meets 60s–70s valve radio, with 80s–90s green/red LED accents
  - **Accessibility** — larger touch targets, Atkinson Hyperlegible font, colours optimised for small or zoomed displays
- All fonts (Nixie One, Atkinson Hyperlegible) and Leaflet maps are embedded in the app — no external CDN requests
- Tested down to 4-inch screens (iPhone SE in Display Zoom mode)

### SDR Controls
- **VFO drum** — smooth inertia scrolling with friction decay; cancel threshold prevents accidental jumps
- **Precise / Normal tuning mode** — tap to switch resolution on the VFO drum
- **Zoom control** — pinch-style dual-drum waterfall zoom
- **Band / mode / filter selectors** — full access to all UberSDR demodulation modes and filter widths
- **Mute pill** — floating overlay shows mute state; tap to toggle
- **Volume control**
- **Noise reduction** — server-side NR accessible from the mobile UI
- **AGC controls**

### Audio
- **Audio-only mode** — disables the waterfall to save battery; all radio controls remain active; landscape layout keeps message and button fully visible
- **Background audio** — app continues receiving when backgrounded (iOS background audio entitlement)
- **iOS Now Playing / AirPods** — Media Session metadata (frequency + station name) shown on lock screen and in Control Centre; next/previous track buttons mapped to VTS station arrows
- **Android media notification** — foreground service with play/pause/next/prev controls; notification updates live as frequency and station change

### Maps & Decoders
- **Digital Spots viewer** — live digital mode activity map
- **CW Spots viewer** — CW activity overlay
- **HFDL aircraft tracking** — live aircraft positions on map (Leaflet, fully embedded)
- **PSKReporter badge** — stats tracking and graphs widget

### Station Management
- **Instance list** — browse and connect to public UberSDR instances
- **Set as default** — auto-connect to a chosen instance on every startup
- **Location sorting** — instances sorted by distance (requires location permission)
- **VTS station arrows** — skip between stations on the current instance

### Menu & Settings
- **Skin settings panel** — switch skin, toggle haptics, adjust preferences
- **Haptic feedback** — configurable; VFO movement uses Rigid impact, zoom uses Light; toggle persists between sessions; shows ❌ icon when off
- **About VibeSDR** — full story, version history, future plans, credits and GPL-3 licence info accessible from the menu
- **Waterfall power saving** — spectrum runs at half-rate; 30-second idle timeout; waterfall fully disconnects when app is backgrounded or a map overlay is active

### Technical
- Expo SDK 56 / React Native 0.85
- Custom skin injected via `injectedJavaScriptBeforeContentLoaded` (WKUserScript on iOS, WebView on Android) — avoids bridge size limits
- Version-guarded injection (`window.__vibeSdrInjected`) prevents double-injection on hot reload
- expo-haptics for native haptic feedback
- expo-keep-awake prevents screen sleep while receiving

---

## Building

### Prerequisites
- Node.js 18+
- Xcode 16+ (iOS)
- EAS CLI (`npm install -g eas-cli`)
- CocoaPods

### iOS (direct device install)
```bash
cd ios && pod install && cd ..
xcodebuild -workspace ios/VibeSDR.xcworkspace \
  -scheme VibeSDR \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=<YOUR_TEAM_ID>
xcrun devicectl device install app --device <DEVICE_UUID> \
  ios/build/Build/Products/Release-iphoneos/VibeSDR.app
```

### Android (EAS APK)
```bash
eas build --platform android --profile preview --non-interactive
```

---

## Credits

| Name | Role |
|---|---|
| **Stuart Carr (Stuey3D)** | UI/UX design, concept & testing |
| **M9PSY** | Creator of UberSDR, whose open architecture made this UI possible |
| **John Seamons (ZL/KF6VO)** | Creator of KiwiSDR, the platform UberSDR is built upon |
| **Claude (Anthropic)** | AI coding and development assistant |
| **Expo & React Native** | Cross-platform app framework |
| **Leaflet.js** | Open-source mapping library |
| **Google Fonts** | Nixie One & Atkinson Hyperlegible typefaces |

---

## Licence

VibeSDR is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3** as published by the Free Software Foundation.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Full licence: <https://www.gnu.org/licenses/gpl-3.0.html>

UberSDR and KiwiSDR are the property of their respective creators and subject to their own licence terms.
