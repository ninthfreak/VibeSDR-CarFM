# CarFM — Licensing Inventory

A tracking record of everything CarFM ships and what it is licensed under.

**Why this exists:** the app is currently private, built from source for one head
unit, and nothing here is presented to a user. That is the only reason the open
items below are not blockers. If CarFM is ever distributed — a release build
handed to anyone, a Play listing, an APK on a forum — the ⚠️ rows have to be
resolved first. This file is the checklist for that day.

This is a record of facts and open questions, not legal advice.

Last audited: **2026-07-31**. Re-audit whenever a dependency, font, or asset is
added. See `docs/BUILTIN-TUNER-FINDINGS.md` for the vendor-interface scope note.

---

## The app itself

| Item | Licence |
|---|---|
| CarFM source | **GPL-3.0** (`LICENSE`, full text) |
| Upstream | Fork of [VibeSDR](https://github.com/Stuey3D/VibeSDR) by Stuart Carr (Stuey3D), also GPL-3.0 |

Attribution for inherited work lives in the README **Credits** table. That table
is the human-facing artifact; this file is the audit behind it.

---

## Native code — ✅ clean

The V5 clean-room DSP swap has **shipped** in this tree. This corrects a stale
belief that the GPL DSP was still linked.

| Component | Provenance | Licence | Evidence |
|---|---|---|---|
| `cpp/vibedsp/` | Clean-room, ours | GPL-3.0 (ours) | `vibedsp.h` header: "clean-room, GPL-free" |
| KissFFT (vendored in vibedsp) | Mark Borgerding | **BSD-3-Clause** | `vibedsp.h` header |
| `cpp/local_sdr_shim.cpp` | Ours | GPL-3.0 (ours) | header: "NATIVE-ONLY, GPL-free… SDR++ Brown / FFTW / VOLK all removed as of V5" |
| `cpp/spyserver/` | Clean-room from the wire protocol | Ours | `spyserver_protocol.h` records provenance: protocol v2.0.1922 + two real clients, 2026-07-09 |
| `cpp/ft8_lib/` | Kārlis Goba | **MIT** | credited in README |
| SDR++ Brown / FFTW / VOLK | — | — | **NOT LINKED.** `build.gradle:164` |

### ⚠️ Prebuilt binaries under `cpp/sdr-kit/` — needs verification

Two `.so` files ship per ABI (`arm64-v8a`, `armeabi-v7a`) with **no LICENSE or
COPYING file alongside them**:

| Binary | Upstream | Expected licence | Open question |
|---|---|---|---|
| `librtlsdr.so` | Osmocom rtl-sdr | GPL-2.0 (usually *or-later*) | GPL-2.0-**only** would conflict with our GPL-3.0. Confirm the upstream version's exact grant. |
| `libusb1.0.so` | libusb | LGPL-2.1-or-later | Compatible; needs the LGPL relinking offer if distributed as a binary. |

**To resolve:** identify the exact upstream commit/version these were built from
and vendor the corresponding licence texts into `cpp/sdr-kit/`.

---

## JavaScript dependencies — ✅ clean

536 packages surveyed from `node_modules` (`package.json` `license` field):

| Licence | Count |
|---|---|
| MIT | 456 |
| ISC | 23 |
| Apache-2.0 | 14 |
| BSD-2-Clause | 12 |
| BSD-3-Clause | 10 |
| BlueOak-1.0.0 | 6 |
| MIT-0 / Unlicense / MPL-2.0 / 0BSD / Python-2.0 / CC-BY-4.0 / Public Domain | 1–2 each |

One dual-licensed package offers `(BSD-3-Clause OR GPL-2.0)` — take the BSD-3
branch. No AGPL, no SSPL, no non-commercial terms, no UNKNOWN.

**Method note:** this reads declared `license` fields only. It does not catch a
package whose field disagrees with its actual LICENSE file. Good enough for
tracking; a real pre-distribution pass wants `license-checker` or an SBOM.

---

## Data and generated assets

| Asset | Source | Status |
|---|---|---|
| `assets/fcc_source` (176 MB) | FCC public database | US federal government work — public domain |
| `assets/db` (2.5 MB) | Derived from the above | Ours, derived from public-domain input |
| Station logos | radio-browser.info | Fetched at runtime, not bundled. Credited in README. Per-logo rights belong to the stations. |
| EiBi shortwave schedules | EiBi | Credited. Retire with the HF code (task #29) if that lands. |

---

## ⚠️ Fonts — the largest open item

12 files in `assets/fonts`, bundled into the APK. No licence file accompanies any
of them, so the evidence below is the **embedded name-table metadata**, read with
`strings -e b` (the table is UTF-16, which plain `strings` misses).

**✅ Cleared — licence embedded in the file:**

| Font | Evidence |
|---|---|
| `AtkinsonHyperlegible-{Regular,Bold}` | "licensed under the SIL Open Font License" + scripts.sil.org/OFL |
| `NixieOne-Regular` | same OFL text embedded |
| `Squealer` | "Released in 2022 under CC0 license. No rights reserved." |

`Squealer` being CC0 is a correction in the favourable direction — an earlier
pass listed it with the risky band faces on the assumption that an AC/DC-styled
face must be fan-made.

**🟡 Probably fine, but not proven by the file:**

| Font | Embedded string | Gap |
|---|---|---|
| `Anton-Regular` | "Copyright 2020 The Anton Project Authors (github.com/googlefonts/AntonFont)" | Google Fonts project, so OFL in practice, but no licence grant is embedded |
| `PermanentMarker` | "Copyright (c) 2010 by Font Diner, Inc. **All rights reserved.**" | Google Fonts distributes it under Apache-2.0, but THIS file carries no grant — only a reservation. An earlier pass recorded it as Apache-2.0; that was inference, not evidence. |

**⚠️ Confirmed commercial — foundry copyright, no grant:**

| Font | Embedded string |
|---|---|
| `Gridnik` | "The digitally encoded machine readable outline data for producing…" — the standard restrictive foundry EULA boilerplate |
| `Onyx` | "The Monotype Corporation plc/Type Solutions, Inc. 1990-1991 All Rights Reserved" |
| `MadieRoger` | "7NTypes. 2023. All Rights Reserved" |

These are not "unverified" — they are commercial faces carrying an explicit
rights reservation and no distribution grant.

**⚠️ No metadata at all:**

`BeatlesYellowSub` · `SgtPeppers` · `Singothic`

Stripped name tables are characteristic of fan-made or re-distributed rips.
Absence of a claim is not a grant.

**To resolve:** clear or replace the six in the last two groups. `bandThemes.ts`
has a `BAND_FONTS_READY` flag that drops the whole band-theme system back to
Atkinson — that is the kill switch if they cannot be cleared.

---

## ⚠️ Band artwork — trademark, not just copyright

`assets/bandart/` — 7 SVGs, plus `assets/fan-l2.png` / `fan-r2.png`:

`acdc-bolt` · `acdc-horn-left` · `acdc-horn-right` · `beatles-drum-gear` ·
`nin-spiral-gear` · `nirvana-smiley-gear` · `talkingheads-bigsuit-gear`

These reproduce **registered band trademarks and logo designs**. Distinct from
the font question: trademark exposure does not depend on who drew the SVG, and
"I redrew it myself" is not a defence. The easter-egg system that uses them keys
off RadioText matches, so it is separable from core function.

**To resolve:** treat as private-build-only. Gate behind a build flag before any
distribution, or remove.

---

## ⚠️ Vendor interface code (NWD / NOWADA)

Copied into the app tree to bind the head unit's radio service:

```
android/app/src/main/aidl/com/nwd/radio/service/{RadioFeature,RadioCallback}.aidl
android/app/src/main/aidl/com/nwd/radio/service/data/{Frequency,RadioPoint}.aidl
android/app/src/main/java/com/nwd/radio/service/data/{Frequency,RadioPoint}.java
```

The AIDL files are **interface declarations** reconstructed for interoperability
— the weakest form of copyright exposure, and the well-trodden interop case. The
two `.java` parcelables are more substantive: they are implementations sitting in
the vendor's own package namespace.

`docs/BUILTIN-TUNER-FINDINGS.md` sets the standing scope rule — interoperability
RE of our own device, read-only, local, **no redistribution of decompiled code,
modified APKs or firmware**. Shipping these files is in tension with that rule's
spirit even though they were hand-reconstructed.

**To resolve before distribution:** confirm each `.java` file is genuinely
hand-written from the interface rather than decompiler output, and document that.

---

## Summary — what blocks distribution today

| # | Item | Severity |
|---|---|---|
| 1 | Band fonts — 3 confirmed commercial, 3 with no metadata | ⚠️ High — bundled in the APK |
| 2 | Band artwork, trademarked logos | ⚠️ High — trademark, not just copyright |
| 3 | Vendor `.java` parcelables in `com.nwd.*` | ⚠️ Medium — confirm provenance |
| 4 | `sdr-kit` prebuilts, no licence texts, GPL-2.0-only risk | ⚠️ Medium — mechanical to fix |
| 5 | Native code, JS deps, data assets | ✅ Clear |

Items 1 and 2 both come from the band-themes feature and share one mitigation:
it can be disabled wholesale (`BAND_FONTS_READY`, plus gating `bandart`) without
touching anything else the app does.
