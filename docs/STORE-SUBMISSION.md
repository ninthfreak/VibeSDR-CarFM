# VibeSDR — Store Submission Notes

Practical, paste-ready answers for the App Store and Google Play consoles.
Package name / bundle ID / applicationId: **`com.vibesdr.app`**
Privacy policy URL: **https://github.com/Stuey3D/VibeSDR/blob/main/PRIVACY.md**

> ⚠️ Fill in the **demo instance** placeholder below with a stable, always-on public
> SDR instance before submitting — reviewers must be able to hear audio immediately.

---

## 1. Apple App Store — "App Review Information" → Notes

```
VibeSDR is a client for listening to public Software-Defined Radio (SDR) receivers
over the internet. It is a radio receiver — there is no login, no account, and no
user-generated content.

GETTING STARTED (no account needed):
1. Launch the app. It opens on the instance picker (a list of public SDR receivers).
2. Tap any instance with a green "online" indicator to connect — audio and a live
   spectrum/waterfall will start within a few seconds.
   • Suggested instance for review: <DEMO_INSTANCE_NAME> (pre-set as the default).
3. Drag the tuning dial or tap the waterfall to change frequency; use the AUDIO menu
   to change demodulator (AM/FM/SSB) and bandwidth.

LOCATION (optional): On first launch the app asks for location. This is ONLY used to
sort the instance list by distance. You may DENY it — every feature still works and
all instances remain usable. Please test once denied to confirm.

BACKGROUND AUDIO: Audio continues when the screen locks or the app is backgrounded
(UIBackgroundModes: audio), with lock-screen / Control Centre now-playing controls.

SIRI VOICE CONTROL (optional, iOS): Add the shortcut phrases automatically appear in
Settings > Siri. While connected, say:
  • "Hey Siri, Tune VibeSDR" → Siri asks for a frequency/station → e.g. "7150" or
    "BBC Radio 5" (if a name matches several frequencies Siri reads a pick-list).
  • "Hey Siri, Change VibeSDR mode" → e.g. "AM".
  • "Hey Siri, Set VibeSDR step rate" → e.g. "9 kHz".
These use the standard App Intents framework (no special entitlement) and run in the
background so tuning works over headphones/CarPlay without unlocking.

LICENSING: VibeSDR is open-source under GPLv3, with an explicit App Store
distribution exception granted by the sole copyright holder (see
github.com/Stuey3D/VibeSDR/blob/main/APPSTORE-EXCEPTION.md).

PRIVACY: No data is collected; no analytics, ads, or tracking. The microphone is
NOT used ("recording" records the radio stream you are listening to).

Contact: stuey99@googlemail.com
```

### Apple — other fields
- **Sign-in required?** No.
- **Demo account?** Not applicable (no accounts).
- **Export compliance / encryption:** `ITSAppUsesNonExemptEncryption = false` is set —
  answer "No" to the "uses non-exempt encryption" question (standard HTTPS/TLS only).
- **Age rating:** 4+ (a radio receiver). Note: live radio is third-party content the
  developer does not control — if asked, "Infrequent/Mild" is unnecessary; choose
  None. If the questionnaire has "Unrestricted Web Access", answer **No** (the app is
  not a web browser; the only external links are the licence/privacy/credits pages).
- **Category:** Primary **Utilities** (or **Music**); Secondary optional.
- **Privacy "Nutrition" labels (App Privacy):**
  - Data **Used to Track You:** None.
  - Data **Linked to You:** None.
  - Data **Not Linked to You:** **Coarse/Precise Location** → purpose **App
    Functionality** only (sorting instances by distance), **not** used for tracking,
    **not** linked to identity. Everything else: None.

---

## 2. Google Play — Data Safety form

**Does your app collect or share any of the required user data types?**
→ The app **does not collect or share** data with the developer. It has no backend.

If the form requires per-type answers, use:

| Question | Answer |
|---|---|
| **Location → Approximate location** | Collected? **No*** / Shared? **No** |
| **Location → Precise location** | Collected? **No*** / Shared? **No** |
| Personal info, financial, health, messages, contacts, calendar, photos, files, etc. | **No** to all |
| App activity, web history, device IDs | **No** |
| **Data encrypted in transit?** | **Yes** (HTTPS/WSS to instances) |
| **Users can request data deletion?** | Data is on-device only; uninstalling removes it |

> *“Collected” in Play’s definition = transmitted off the device to you (the
> developer) or a third party you control. VibeSDR sends location only to the public
> instance directory (instances.ubersdr.org) **at the moment the list is refreshed**,
> purely to order instances by distance, and you (the developer) do not receive or
> store it. That is **ephemeral processing**, which Play lets you exclude from
> "collected". If you prefer to be conservative, you may instead declare Approximate
> **and** Precise Location as **Collected → not shared**, purpose **App
> functionality**, **not** for tracking — both readings are defensible; the
> conservative one avoids any "undisclosed collection" risk.

**Recommended:** declare **Approximate + Precise Location → Collected, Not shared,
Purpose: App functionality, Not used for tracking/advertising.** It's the safest and
matches the runtime permission users see.

### Google Play — Permissions declaration
- **Location (ACCESS_FINE/COARSE_LOCATION):** "Sort the list of SDR receivers by
  distance from the user. Optional — the app is fully functional if denied."
- **Foreground service (FOREGROUND_SERVICE_MEDIA_PLAYBACK):** required — VibeSDR
  plays audio in a media-playback foreground service so listening continues when the
  app is backgrounded / screen is off, with a media-style notification.
  - Play may require the **Foreground Service** declaration + a short screen-recording
    showing: app playing → home/lock → audio continues with notification controls.
- **READ/WRITE_EXTERNAL_STORAGE (maxSdkVersion=32):** legacy save/share of audio
  recordings on Android ≤12 only.

### Google Play — listing
- **App category:** Music & Audio (or Tools).
- **Content rating (IARC questionnaire):** Everyone — no violence, no UGC, no
  purchases. If asked about user communication/sharing: **No**.
- **Target audience:** not for children (13+).
- **Ads:** No ads. **In-app purchases:** None.
- **Privacy Policy URL:** as above.

---

## 3. Both stores — quick checklist
- [ ] Set a stable **default/demo instance** that's reliably online for review.
- [ ] Privacy Policy URL pasted in both consoles.
- [ ] Screenshots (already in `screenshots/`).
- [ ] Apple: encryption = No (non-exempt). Location label = App Functionality only.
- [ ] Google: Data Safety submitted; foreground-service declaration (+ demo video).
- [ ] Mention in both review notes that **location is optional** and the app works
      fully when denied (avoids a "permission gate" rejection).
