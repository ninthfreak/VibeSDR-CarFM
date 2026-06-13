# VibeSDR — TestFlight / App Store Connect

Bundle ID: **`com.vibesdr.app`** · Team: `6PV2X6THHM` · Marketing version: `2.2.2`

## What's already set up
- `ios/ExportOptions-appstore.plist` — App Store distribution export config.
- Release archive pipeline (clean DerivedData → archive → export) — see
  [`build-pipeline`](../CLAUDE.md) / memory.
- GPL App Store exception + privacy policy already in the repo.

---

## A. One-time setup (you, in the browser) — do these once the paid membership is active

1. **Enrol** in the Apple Developer Program ($99/yr) with your Apple ID. Approval is
   usually quick (minutes–hours, occasionally up to ~2 days). The Team ID should stay
   `6PV2X6THHM` (same Apple ID → same team, now paid).

2. **Register the App ID** (if not auto-created): developer.apple.com → Certificates,
   IDs & Profiles → Identifiers → **+** → App IDs → App → Bundle ID
   `com.vibesdr.app` (explicit). Capabilities: nothing special needed (Background
   Modes/audio is in the build; App Intents need no capability).

3. **Create the app record:** appstoreconnect.apple.com → My Apps → **+ New App**
   - Platform iOS, Name **VibeSDR**, Primary language English (UK), Bundle ID
     `com.vibesdr.app`, SKU `vibesdr` (any unique string).

4. **Create an App Store Connect API key** (lets us upload from the command line):
   App Store Connect → **Users and Access → Integrations → App Store Connect API**
   → **+** → name "VibeSDR CI", Access **App Manager** → **Generate**.
   - Download the **`AuthKey_XXXXXXXXXX.p8`** (you can only download it ONCE).
   - Note the **Key ID** (the XXXX) and the **Issuer ID** (shown at the top).
   - Give me: the `.p8` file path, the Key ID, and the Issuer ID — then I run the
     upload. (Alternatively, just drag the IPA into the **Transporter** app from the
     Mac App Store — no key needed.)

---

## B. Build + upload (me, from here) — once A is done

```bash
# 1. Clean + archive (Release)
rm -rf ~/Library/Developer/Xcode/DerivedData/VibeSDR-* /tmp/VibeSDR.xcarchive /tmp/VibeSDR-appstore
xcodebuild -workspace ios/VibeSDR.xcworkspace -scheme VibeSDR \
  -configuration Release -sdk iphoneos -archivePath /tmp/VibeSDR.xcarchive archive \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=6PV2X6THHM

# 2. Export an App Store IPA (distribution-signed)
xcodebuild -exportArchive -archivePath /tmp/VibeSDR.xcarchive \
  -exportPath /tmp/VibeSDR-appstore \
  -exportOptionsPlist ios/ExportOptions-appstore.plist

# 3. Upload to App Store Connect (API key)
xcrun altool --upload-app -f /tmp/VibeSDR-appstore/VibeSDR.ipa -t ios \
  --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
#   (the AuthKey_<KEY_ID>.p8 must be in ~/.appstoreconnect/private_keys/ or ./private_keys/)
```

Build number: each upload needs a **unique** `CFBundleVersion`. It's currently `1`
(`ios/VibeSDR/Info.plist`). Bump it by 1 for every new TestFlight upload (marketing
version `2.2.2` can stay).

---

## C. After the build appears in App Store Connect (5–30 min processing)

1. **TestFlight tab** → the build shows "Processing", then ready.
2. **Export compliance:** answer **"No"** (uses non-exempt encryption) — matches
   `ITSAppUsesNonExemptEncryption=false`. One-time per app.
3. **Internal testing:** add yourself / up to 100 internal testers (App Store Connect
   users) → they get it **instantly, no review**.
4. **External testing (optional, up to 10,000):** create a group, add a build, fill
   the **Test Information** (what to test, the demo instance
   `https://stuey3d.tunnel.ubersdr.org/`, contact `stuey3dttb@icloud.com`). First
   external build needs a quick **Beta App Review** (usually < a day). **No 12/14
   gate** — unlike Google.
5. Share the TestFlight public link (external) in Discord — anyone with the
   **TestFlight app** can join. Much simpler than Play.

## Notes vs Google
- No closed-test tester minimum, no 14-day wait.
- Reviewers (for external + eventual App Store) DO open the app — keep the demo
  instance up.
- For full App Store release later: fill the store listing, screenshots (already in
  `screenshots/`), privacy labels (Location → App Functionality only), submit.
