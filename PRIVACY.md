# VibeSDR — Privacy Policy

_Last updated: 13 June 2026_

VibeSDR is a client app for listening to public Software-Defined Radio (SDR)
receivers. This policy explains what the app does and does not do with your data.

## Summary

**VibeSDR does not collect, store, or transmit any personal information to the
developer.** There are no analytics, no advertising, no tracking, and no developer
servers that receive your data. Everything the app stores stays on your device.

## Information the app uses

### Location (optional)
If you grant location permission, VibeSDR uses your device location **only** to
sort and filter the list of available SDR instances by distance (nearest first).

- Your location is sent **only** to the public instance directory
  (`instances.ubersdr.org`) as latitude/longitude **at the moment you refresh the
  list**, so it can return instances ordered by distance. It is not stored by the
  app or by the developer.
- Location is **entirely optional**. If you deny or disable it, every other feature
  of the app continues to work normally — you can still browse and use every
  instance; the list simply won't be sorted by distance.
- VibeSDR never accesses your location in the background.

### Connections to SDR receivers
When you select an SDR instance, the app connects directly from your device to
that third-party receiver to stream audio and spectrum data. Your device's IP
address is necessarily visible to the receiver you connect to, as with any network
connection. These receivers are operated by independent third parties and are not
controlled by the developer; their own logging and privacy practices are their
responsibility.

### On-device data
The following are stored **only on your device** and are never transmitted to the
developer:

- Your saved bookmarks, favourite instances, and a default instance.
- App settings and preferences.
- Audio recordings you choose to make (saved to your device; shared only when you
  explicitly use the share button).

You can remove all of this by deleting the app.

## Permissions

- **Location** (optional) — sort/filter instances by distance, as described above.
- **Local network** (iOS) — to discover and connect to SDR receivers on your local
  network.
- **Notifications / media controls** — to show now-playing controls and run audio
  in the background while you listen.

VibeSDR does **not** use the microphone, camera, contacts, or any other personal
data. (Audio "recording" records the radio stream you are listening to, not your
microphone.)

## Children

VibeSDR is not directed at children and does not knowingly collect any data from
anyone.

## Changes

If this policy changes, the updated version will be published at this URL with a new
"last updated" date.

## Contact

Questions about privacy: **stuey99@googlemail.com**

Source code: <https://github.com/Stuey3D/VibeSDR>
