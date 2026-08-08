# Second review pass — bugs, consistency, missed opportunities

Run 2026-08-08 against `main` at `4154295` (everything from the first review
merged). Method: five parallel investigations plus a hand pass, with every
load-bearing claim re-verified by running a command. Findings marked
**[verified here]** were reproduced directly for this document; the rest carry
the quoted evidence that established them.

Baseline at the time of writing, all green: `cargo test` 52, `cargo clippy` 0
warnings, `cargo fmt --check` clean, `tsc --noEmit` clean, `test:backend` 18
suites, `test:rds-diff` identical over 2170 steps, `test:stations-diff`
equivalent over 87,622 scenarios.

---

## The headline

The first review proved the Rust port equals the TypeScript. This pass looked
at what that proof *cannot* see, and found four things:

1. **A real decoder bug that lives in both implementations.** RT+ is the only
   part of the RDS decoder with no consensus gate. Because the fault is
   identical on both sides, both differentials stay green over it forever.
2. **The first review introduced a way to abort the process.** Making the geo
   clamps propagate NaN like JavaScript closed a cosmetic gap and opened a path
   into a sort comparator that is not a total order, which Rust panics on in
   release. Not reachable from the shipped database; reachable from the public
   API. See §1.4 — that one is mine.
3. **A comment that inverts the exact fault the code exists to handle**, copied
   into both ports.
4. **Nothing enforces the differentials.** No CI, no git hooks, and the one
   commit gate runs neither `cargo test` nor either differential — which is
   precisely the mechanism the handoff says already let this port drift once.

A methodological note, because it nearly cost a correct finding: two of the
items below survived only because they were checked by code point and by
randomised input rather than by reading output. §1.5 prints identically in a
terminal whether or not the bug is present, and §1.4 does not reproduce on
tidily-structured data.

---

## 1. Bugs

### 1.1 RT+ has no consensus gate anywhere — MAJOR **[verified here]**

Every other field in the decoder is consensus-gated, and the file's comments
explain at length why: PI needs 3 groups to acquire and 12 to displace, PTY 3,
TP 3, TA 3 plus a confirmed-TP gate, PS two agreeing complete assemblies,
RadioText two agreeing cycles for any replacement. RT+ has none — in two
separate places.

**(a) The ODA group assignment is adopted from one unvalidated group.**
`nwdRds.ts:531-534` / `core/rds/src/lib.rs:655-658` take the group number from
block B's low 5 bits of a single 3A, with no check that the announced group can
legally carry an ODA. Groups 0A, 0B, 1A, 2A, 2B, 3A, 4A and 15B have defined
uses and cannot.

Fed a 3A whose AID was intact but whose low bits were corrupt to zero — i.e.
"RT+ lives in group 0A" — the very next ordinary PS group was parsed as an RT+
payload. Both decoders, after PI confirmation and a published RadioText:

```
a6ff354000004bd7   3A, AID intact, group bits corrupt -> announces 0A
a6ff054880162020   ordinary 0A group, M/S=1, normal AF pair in block C
  TS   -> rt="LED ZEPPELIN - WHOLE LOTTA LOVE"  art="E"
  Rust -> rt="LED ZEPPELIN - WHOLE LOTTA LOVE"  art="E"
```

`0x8016` in block C is a legitimate AF pair (100.3 + 89.6 MHz), and M/S=1 is
what any music station transmits — the "running" bit RT+ reads is the same bit.

**(b) The payload is applied from one group.** After a legitimate 3A announcing
RT+ on 11A, one corrupt payload group rewrites the artist instantly:

```
a6ffb548801609ef   correct payload -> art="LED ZEPPELIN"  tit="WHOLE LOTTA LOVE"
a6ffb548828e0000   ONE corrupt group -> art="EPPELIN"     tit="WHOLE LOTTA LOVE"
```

**(c) The comment justifying the gap reasons about the wrong block.**
`nwdRds.ts:77-80`:

> RT+ ODA Application Identifier. A 16-bit exact match, which is what makes a
> single declaration trustworthy: a corrupt block landing on this value by
> chance is a 1-in-65536 event…

That protects block D, the AID. The *group number* comes from block B, which
has no such protection at all. Blocks C and D — which carry the RT+ offsets —
are exactly the unprotected blocks that forced RadioText's two-cycle rule.

The tags reach the driver through `nowPlaying.ts:46` `fmNowPlaying`, which
does no validation. Misassignment self-heals on the next clean 3A and a wrong
tag is replaced by the next good payload, so the exposure is a wrong artist or
title for a second or two — which is the same failure the rest of this decoder
was hardened to prevent.

**Cheapest fix:** reject an ODA assignment to a group the standard defines
(0/1/2/3/4/15 at minimum), and give the assignment its own repeat counter like
every neighbouring field. Optionally require a payload's `(content type, start,
length)` to repeat before publishing, matching the RadioText rule.

### 1.2 `carfm://` deep links are dead on a stale regex — MAJOR **[verified here]**

`AndroidManifest.xml:59` and `app.json:6-9` both register the `carfm` scheme,
and `DeepLinkHandler.ts:58` parses `/^carfm:\/\//i`. But the guard every
incoming URL passes through first, `useDeepLinks.ts:122`, reads:

```ts
if (!url || !/^(vibesdr|sdr):\/\//i.test(url)) return;
```

`vibesdr` is not registered anywhere, so it can never arrive; `carfm` is
registered but rejected here before reaching its parser. A rename missed this
line. Only `sdr://` (SpyServer) works end to end, which makes
`DeepLinkHandler.ts` (180 lines) unreachable as shipped.

This is a fork in the road, not just a fix: repairing the regex makes
`DeepLinkHandler` live again and re-enables the `kiwi`/`owrx` server types,
which in turn un-kills ~2,100 lines currently unreachable (see §5).

### 1.3 Ranking ties are decided by unordered SQL — MINOR **[verified here]**

`stationRank.ts:47-49` and `stationIdentify.ts:31-32` both document that a
stable sort makes equal scores "keep the order SQLite returned them in". None
of `stationDb`'s three station SELECTs has an `ORDER BY` — the only one in the
file is on the logo queue (`stationDb.ts:420`). SQLite does not guarantee row
order without one; a query-plan change reorders the list.

Measured on the shipped table: **882 groups covering 1,996 rows** tie on
`(lat, lon, erp_kw, station_class)`, so they score identically at every query
point. Identification is unaffected today (zero ties on either identify path),
but the Nearby list's order among those rows is unspecified behaviour.

Worth noting alongside: the differential's corpus feeds rows `ORDER BY
facility_id`, which is *not* the order the app's SQL produces — so the harness
verifies ordering under an input order production never generates.

### 1.4 `rank_nearby` aborts the process on a NaN score — MAJOR, and it is a regression from the first review **[verified here]**

`core/stations/src/nearby.rs:38-44` sorts with
`b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal)`. That faithfully
reproduces JavaScript's rule that a NaN comparison result coerces to +0 — but it
is **not a total order**: with `a = NaN`, `b = 1`, `c = 2` it claims `a == b` and
`a == c` while `b < c`. Rust's sort detects this and panics, in **release builds
too** (the check lives in `core`, it is not a debug assertion).

Reproduced over randomised tables (20–320 rows, random NaN fraction, release
profile): **393 panics in 3,000 trials**, first at 61 rows with 32% NaN. A
structured arrangement does not trigger it — my first attempt with NaN every
third row and monotonic scores returned cleanly — so the detection is
data-dependent, which is exactly what makes it a bad thing to leave in place.
The TypeScript on equivalent input returns a list and never throws.

**This is my regression.** Before `be1521f`, `geo.rs` read
`erp_kw.unwrap_or(0.05).max(0.0001)`, and `f64::max` *discards* NaN — so a score
could never be NaN and the sort never saw one. The first review changed that to
`clamp_min`, to reproduce JavaScript's NaN *propagation*, and closed a cosmetic
parity gap by opening a path to a process abort. `nearby.rs:28`
(`if distance_km > radius_km { continue; }`) deliberately keeps NaN-distance
rows for the same parity reason, so two faithful choices funnel NaN into a sort
that aborts.

Not reachable from the shipped table **[verified here]**: 0 rows with NULL or
non-numeric `lat`/`lon`, 0 with non-numeric `erp_kw`, and the 652 NULL `erp_kw`
rows become `None → 0.05`. It needs caller-supplied NaN — and `rank_nearby` is a
public export on a crate whose whole design is to be fed rows by platform glue
above it. The differential cannot catch it, because the corpus is built from the
same NaN-free table.

**Fix:** `sort_by(|a, b| b.score.total_cmp(&a.score))`, which is a total order;
or map NaN to `NEG_INFINITY` before sorting. Either way the "ties resolve
identically" comment must stop claiming an equivalence it does not have.

### 1.5 `callsign_base` trims U+0085 where JavaScript does not — MINOR **[verified here]**

`core/stations/src/pi.rs:103-105` implements `js_trim` as
`c.is_whitespace() || c == '\u{feff}'`. Rust's `char::is_whitespace` is the
Unicode `White_Space` property, which includes **U+0085 NEXT LINE**;
ECMAScript's `WhiteSpace` does not, and NEL is not a JS `LineTerminator` either.

```
raw             [85,57,4f,4c,58]
JS  raw.trim()  [85,57,4f,4c,58]   (unchanged, length 5)
JS  callsignBase[85,57,4f,4c,58]   -> callsignToPi = null
Rust callsign_base = "WOLX"        -> callsign_to_pi = Some(31445)
```

A caution for whoever confirms this: `JSON.stringify` does not escape U+0085
(it is above 0x1F) and terminals render it invisibly, so the JS result *prints*
as `"WOLX"` and looks identical. I nearly refuted this finding on that basis —
compare code points, not rendered strings.

Harmless today (FCC callsigns are ASCII), but `callsign_base` is a public export
whose own doc says "the differential harness compares these two functions byte
for byte and an approximation would show up as a divergence rather than as a
shrug". It is an approximation. Fix: drop U+0085 from the predicate. The two
neighbouring reproductions were checked and are correct — `to_uppercase` matches
JS across all 1,114,112 scalars, and `is_js_line_terminator` is exactly the
right four code points.

### 1.6 The RDS harness aborts on a non-UTF-8 byte — MINOR **[verified here]**

`core/rds/examples/rds-dump.rs:10` — `let l = line.unwrap();`. `BufRead::lines()`
yields `Err(InvalidData)` on invalid UTF-8, so one stray byte panics the run
mid-corpus, while `tools/tests/rdsDump.mjs` reads with `readFileSync(path,
'utf8')`, substitutes U+FFFD and continues. The differential would report this
as a crashed subprocess rather than as malformed input. `unwrap_or_default()`
restores parity.

### 1.7 Two latent hazards, currently harmless **[verified here]**

- **Song titles match the callsign pattern.** `Walk`, `Wind`, `King` and `Kiss`
  all satisfy `/\b([KW][A-Z]{3})\b/`. On a scrolling-PS station the chunk
  reaches `identifyByPi` as `psText` and drops confidence with a nonsense note.
  Masked today because the only consumer of `confident`
  (`RadioScreen.tsx:2259`) is gated on `liveStation.name` being empty — the
  same condition that triggers the false match. A second consumer surfaces it.
- **`boundingBox` never wraps the antimeridian.** `minLon`/`maxLon` can exceed
  ±180 and the SQL `lon BETWEEN` then misses the far side. Unreachable with the
  current data: the table spans −171.73° to +155.08°, a 33° gap around 180°,
  against a 7.3° largest radius. Reachable if the radius grows or Pacific
  stations are added.

---

## 2. Consistency

### 2.1 The PI/callsign example is inverted, in both ports — MAJOR **[verified here]**

`piCallsign.ts:151-152` and `core/stations/src/pi.rs:203-205`:

> WIBA-FM 101.5 sends 0x19E2, callsign arithmetic gives 0x69E2 -> "KDTI"
> WZEE    104.1 sends 0x1718, callsign arithmetic gives 0x9718 -> "KCRW"

Running the file's own function:

```
0x19e2 -> "KDTI"     0x69e2 -> "WIBA"
0x1718 -> "KCRW"     0x9718 -> "WZEE"
```

`0x69E2` is WIBA's *own* arithmetic value and decodes to WIBA; KDTI is what the
**transmitted** `0x19E2` renders as. The arrow points at the wrong number. As
written, a reader concludes the arithmetic is broken — the opposite of the
actual fault, which is a wrong top nibble, and the opposite of what
`PI_LOW_MASK` and the low-bits salvage exist to repair. `pi.rs`'s own tests
state it correctly 100 lines below the comment, and
`docs/BUILTIN-TUNER-FINDINGS.md:872-873` already holds the correct table.

This is the highest-value single correction in the pass: it is the same wrong
sentence in both implementations, describing the exact fault the salvage path
handles.

### 2.2 The retune claim the TypeScript refutes is alive in the Rust — MAJOR

`core/rds/src/lib.rs:103-107` states "the screen calls `reset()` on every
frequency event, so a retune has already emptied this decoder". `nwdRds.ts:123-132`
exists specifically to record that this is false, and `reset_for_retune`'s own
doc 200 lines below contradicts it. `RadioScreen` never calls `reset()` —
`rdsDecoder.current` is only ever sent `stats`, `resetStats`, `resetForRetune`,
`push`, `state`, `clearTa`, `quality`. The same claim recurs at `lib.rs:432-433`
and in the TypeScript at `nwdRds.ts:356-357`.

(The first review fixed the `reset()` doc comment; this is a different comment
that the same commit only re-indented.)

### 2.3 Documentation that contradicts the tree — MAJOR in aggregate

The checkable ones, each with the correction:

| Claim | Reality |
|---|---|
| `AGENTS.md:51` — read the Expo **v56.0.0** docs | installed is `expo@57.0.2` / `react-native@0.86.0` **[verified here]** |
| `HANDOFF.md:20` — "Expo SDK 56 / React Native 0.85" | same **[verified here]** |
| `LICENSING.md:102` — a `BAND_FONTS_READY` kill switch | no such identifier; the real thing is a runtime latch tracking font loading, not a policy switch — and this is the documented mitigation for a distribution blocker |
| `LICENSING.md:95` — 12 bundled fonts | 11 on disk and tracked |
| `HANDOFF.md:294` — "nine band themes" | five themes; nine is the *font* count |
| `NWD-RADIO-INTEGRATION.md §10` — proposes the `seek()` experiment, warns not to put it on a timer, names the DB+GPS estimate as current | experiment ran 2026-08-04, `seek()` is on a 20 s watch, the estimate was removed |
| `NWD-RADIO-INTEGRATION.md:279` — `nwdRds.ts` is "~150 lines" | 616 |
| `CARFM-STRIP-PLAN.md:25` — `SDRScreen.tsx` is "core — never deleted" | no such file; it is `RadioScreen.tsx` |
| `SPEC-AUDIT-HANDOFF.md:47-56` — six spec files under `docs/design/handoff/` | absent; the document's method is unexecutable against them |
| `docs/backend/nearby-stations-api.md` | wrong `identifyByPi` signature (missing `freqMhz`, the parameter that stops a mis-encoded PI renaming the station); describes the removed in-DB base64 logo model |
| `README.md:40`, `LICENSING.md:88` — radio-browser.info is the logo source | removed; chain is DuckDuckGo → Wikidata → favicon |

### 2.4 Config vs reality **[verified here]**

- **`tools/tests/nowPlaying.test.ts` is orphaned.** 19 test files on disk, 18
  wired into `test:backend`. It passes (`NOWPLAYING: ALL PASS`) and guards the
  MediaSession contract with the ESP32 display. One `&&` fixes it.
- **`expo-asset` is imported but not declared.** `stationDb.ts:26` imports it;
  `package.json` declares it nowhere, so it resolves only as a transitive of
  `expo`. It is what copies the FCC database out of the APK — a hoisting change
  breaks station lookup, Nearby and PI identification with no build-time error.
- **The version a user sees is wrong.** `SettingsPanel.tsx:32`
  `APP_VERSION = '0.9.2'` feeds the About line, against `app.json` `9.0.1` and
  `build.gradle` `versionName "9.0.1"`.
- **A dead iOS patch runs on every install.** `patches/expo-modules-jsi+57.0.0.patch`
  patches Swift and hardcodes `/Users/stuey3d/VibeSDR/ios/...`; there is no
  `ios/` directory. `patch-package` runs it on `postinstall`.

### 2.5 Kotlin↔TypeScript seam

`NwdRadioModule.kt:267-270` justifies dropping consecutive identical RDS reads
with "the JS decoder is idempotent for repeats anyway". It is the exact
opposite: repeats *are* the error-correction mechanism (PI needs 3, PTY 3, PS
two agreeing assemblies). Anyone raising `rdsPollMs` on that rationale would
starve every consensus counter. Also `NwdRadioModule.kt:730-733` says the level
watch runs "every 30 seconds"; JS passes 20 s, or 15 s in debug.

---

## 3. The infrastructure gap **[verified here]**

Nothing enforces the differentials:

- `.github/` does not exist; no `.husky`; `.git/hooks/` holds only `.sample`
  files; `core.hooksPath` is unset. PRs #84–#88 merged with zero automated
  checks.
- The one gate, `.claude/hooks/verify-before-commit.sh`, runs exactly
  `npx tsc --noEmit` and `npm run test:backend`. It does **not** run
  `cargo test`, `test:rds-diff`, or `test:stations-diff` — the three checks that
  prove the Rust core still matches the shipped TypeScript.

`HANDOFF.md` §6 records that the first cut of this port "drifted from the
TypeScript reference silently while its own tests stayed green". The
differentials were built as the answer to that. Leaving them manual leaves the
answer unapplied. The three missing suites cost **~2.8 s** against a gate that
already costs ~11 s.

Note for whoever wires it: the differentials need `cargo`, which is why they sit
outside `test:backend`. A CI job can install it; a commit hook should skip them
gracefully when `cargo` is absent rather than blocking a commit.

---

## 4. Missed opportunities

### 4.1 The port is far closer to done than the handoff implies

`HANDOFF.md` §8 scopes the remaining port as "much larger than one decoder" and
names five items. Measured, two of the five are wrong: the station database is
423 lines of mostly Expo I/O with its pure parts **already ported**, and
"presets" is not a module at all — it is ~120 lines inside `RadioScreen.tsx`.

Excluding the SDR backends (a strip target, not a port target), the genuinely
portable remainder is roughly **2,400 lines** against **1,080** already ported —
about **31% done**. That reframes finishing the core as a bounded job that could
land *before* the Slint move rather than alongside it.

### 4.2 Port `nwdSignalLevel.ts` next (305 lines)

Best remaining candidate on every axis: zero imports, pure arithmetic, and a
finite input domain (level × loss × dottable) so its differential can be
**exhaustive and byte-exact** — no tolerance argument, unlike `core/stations`.
It is also the most Slint-critical logic in the repo (the meter, half-steps,
sub-floor ramp, dotted-arc overlay) and it encodes five owner decisions that a
differential would make impossible to revisit by accident. Its most branch-dense
function, `levelToLit`, currently has the thinnest test coverage.

Then, in order: `logoDark/stages.ts` + `pipeline.ts` (447), `bandPlan` +
`bandThemes` (393), `rdsCountry` + `callsignCountry` (251), `rtStation` +
`nowPlaying` (141).

### 4.3 Extract the JS-semantics helpers before a third crate lands

There are six independent reproductions of JavaScript semantics in the Rust
core, in four files. **Four of the six needed a review pass to catch** —
`fmt_mhz`, the three NaN clamp sites, and the `\b` reproduction were all first-
review findings. That is the signature of scaffolding that wants one home and
one test suite.

The harnesses duplicate more: `jstr`/`jnum` exist in the stations dump while the
RDS dump uses Rust's `{:?}` for the same job. Those agree **only** because both
decoders clamp RDS bytes to `0x20..=0x7e` — a silent coupling between the
decoder's character clamp and the harness's escaping, documented nowhere. The
`\N` NULL sentinel is written three times; the corpus reader twice.

A `js_compat` module (unit-tested against pinned node output) plus a
`testutil` dev-dependency is ~200 lines moved and ~150 new. Cheapest now.

### 4.4 446 untested lines are testable today

`tools/tests/logoDark.test.ts` says the stages and orchestrator "can't run under
bare Node". That stopped being true when `tools/tests/tsResolve.mjs` was added
for the stations differential. **[verified here]** — `route()` from
`logoDark/stages.ts` runs under bare node with that hook:

```
$ node --no-warnings --import ./tools/tests/tsResolve.mjs probe-stages.mjs
route(0.10) = ["remap","halo"]
```

`stages.ts` (367) + `pipeline.ts` (79) is the largest untested module in the
keep-set, and the uncovered functions are the decision-making ones (`route`,
`gate`, `keyBackground`, `remap`, `flattenCheckerboard`). `summarize()` already
returns a flat record of exactly those decisions, so the harness is nearly free
— and it is the same shape a Rust differential would take later. The false
comment should go with it.

### 4.5 Presets deserve a module

The preset engine is ~120 lines inside a 3,331-line React component that holds
186 hooks. It is pure list arithmetic — dedupe by channel, apply a persisted
order, stable sort — and **none of it survives the Slint move**. Worse, presets
are persisted as `UserBookmark` records whose field set exists "so the JSON
export is directly importable by desktop UberSDR", carrying `mode`,
`bandwidth_low`, `bandwidth_high`, `extension`, `group` and `scope` — six fields
meaningless on a head unit. `CARFM-STRIP-PLAN.md` item 13 concluded
`userBookmarks` "can never go" *because* of this. Giving presets their own model
turns an unstrippable dependency into a strippable one and unblocks ~710 lines.

### 4.6 The station DB can fail silently

The builder writes `meta.schema_version = "2"`; nothing in `src/` ever reads it.
The app instead has two unrelated version mechanisms (`DB_ASSET_VERSION` sidecar
and `PRAGMA user_version`) that never cross-check. Every query swallows its own
failure (`catch { console.warn(...); return []; }`), so a renamed column
produces "no stations near you" — indistinguishable from a bad GPS fix, on a
device the developer cannot inspect. A ~40-line test asserting the column set,
`schema_version`, and `row_count` vs `COUNT(*)` closes it.

Related: **176 MB of FCC source zips are tracked in git** (7 files), which is
most of the 263 MB `.git`. Build inputs, not runtime assets. Worth a decision.

---

## 5. Deletion inventory (the standing VibeSDR-strip goal)

**Safe now, ~500 lines**, nothing else references them: `favourites.ts` (91) and
`mdns.ts` (96) have zero importers repo-wide; plus in-file dead code — 20
waterfall/spectrum state variables in `RadioScreen` that are written and
restored but never read (~85), the VTS notification chain (~90, but `vtsCheck`
itself is live and must stay), four unread refs from the deleted chat-sync
engine, the iOS half of `LocalAudioPlayer` (~55), the `HD` tell hardcoded
`on={false}`, and the `nameBlock` branch no theme defines.

**Needs your decision, ~3,100 lines**, all provably unreachable but recorded as
deliberate keeps: the three network-SDR adapters (`OwrxAdapter` 1,071,
`KiwiAdapter` 718, `FmdxAdapter` 302) are unreachable because `serverType` can
only ever be `'ubersdr'`; the server-sharing stack (736) cannot be started since
its screens were deleted; `DeepLinkHandler` (180) is unreachable via §1.2.
`CARFM-STRIP-PLAN.md` records "keep" decisions for the first two.

**Live but questionable:** `eibi.ts` (203) fetches **shortwave** broadcast
schedules from `http://www.eibispace.de` **every 10 minutes, over cleartext**,
on a car FM radio. **[verified here]** — the `lsv_eibi_enabled` flag defaults
`true` and *nothing in the app ever writes it*, so it cannot be turned off;
`usesCleartextTraffic="true"` in the manifest means the request does go out.
Cheapest real win in the survey.

**`tunerCapabilities.ts` (183) needs a decision, not a deletion.** **[verified
here]** — no importers, but it is dated today and aims squarely at the "many
tuner types" ambition. Its header's evidence is stale: it claims 59/21/10
identity branches in RadioScreen/SettingsPanel/CarFmFace; actual counts are
**16/5/3**, so wiring it is *cheaper* than the file itself claims.

**Two droppable dependencies:** `expo-audio` (declared and an `app.json` plugin,
zero importers) and `react-native-reanimated` (zero JS usage; animation goes
through RN core `Animated` and `LayoutAnimation`) — the latter needs a real APK
build to confirm.

---

## Addendum — four fixes applied

Landed after the pass, each closed and then re-broken on purpose to prove the
guard sees it.

**1.4 the NaN sort.** Both implementations now map a NaN score to a single
sentinel before sorting, giving a real total order in Rust and a consistent
comparator in JavaScript, with unrankable rows sunk and left tied so the stable
sort keeps their input order. The two agree independently: over a
hundred-row fixture with scattered NaN, both put the first NaN at index 86.
Pinned by a Rust regression test and a new `tools/tests/stationRank.test.mjs`
(wired into `test:backend`); reverting the comparator makes the Rust test panic
with "user-provided comparison function does not correctly implement a total
order".

**1.1 the RT+ gates.** Both halves are closed, in both ports. An ODA
announcement is refused outright when it names a group the standard already
defines (0A/0B, 1A/1B, 2A/2B, 3A, 4A, 10A, 15B), and is otherwise adopted only
when it repeats. The payload is acted on only when the whole decoded triplet set
repeats, which also stops a lone corrupt group blanking a running item. The two
original exploits now produce empty tags instead of `art="E"` and
`art="EPPELIN"`, while a legitimately announced and repeated payload still
publishes `"LED ZEPPELIN"` / `"WHOLE LOTTA LOVE"`. The corpus gained a story for
each failure shape, and the existing RT+ passages were extended so the change
did not silently delete the coverage that was already there — artist and title
still publish 17 times across the corpus.

**2.1 the inverted PI comment.** Corrected in `piCallsign.ts` and `pi.rs`: the
transmitted code is what renders as KDTI/KCRW, the arithmetic values 0x69E2 and
0x9718 are the stations' own and decode correctly, and the fault is the top
nibble rather than the formula.

**1.2 the deep-link regex.** The guard now tests `carfm|sdr`, matching what
`app.json` and `AndroidManifest.xml` register. A new
`tools/tests/deepLinkSchemes.test.mjs` cross-checks the manifest, `app.json`,
the runtime guard and both parsers against each other, and fails if they drift
again. **Consequence worth stating:** this makes `DeepLinkHandler` reachable for
the first time, which also makes the `kiwi`/`owrx` server types selectable — so
the ~2,100 lines of SDR adapters listed as unreachable in §5 are no longer
unreachable. Nothing else was changed to suit that; it is a live consequence of
repairing the link path rather than deleting it.

After all four: `cargo test` 54, `cargo clippy` 0 warnings, `cargo fmt` clean,
`tsc` clean, `test:backend` 20 suites, `test:rds-diff` identical over 2411
steps, `test:stations-diff` equivalent over 87,622 scenarios.

One process note, recorded because it nearly slipped through: the TypeScript RDS
test was failing while a `grep`-based check of the suite output reported success.
`tools/tests/nwdRds.test.mjs` builds the decoder from source through a
hand-written regex type-stripper, so an unfamiliar type annotation surfaced as a
`SyntaxError` rather than as a failed assertion. Verify suites by exit code.

## Appendix — checked and clean

Recorded so the next pass need not redo them: the logos `LEFT JOIN` cannot
duplicate rows (`callsign_base` is a PRIMARY KEY) and the table is populated at
runtime, so the join is live; `nearbyStations` has no SQL `LIMIT`, so "the cap
never hides a better station" holds; all five runtime tables use
`CREATE TABLE IF NOT EXISTS`; `discreteLit`'s rounding and `levelToLit`'s
midpoint are correct as specified; the half-step logging regression named in the
handoff is genuinely fixed; RT+ `length = field + 1` is validated by the fixture
producing natural strings; the low-bits statistic quoted in both ports (10,646
FM rows, 10,487 distinct pairs, 130 with two holders, none with three)
reproduces exactly against the shipped table; PTY labels exist in exactly one
place; the signal thresholds `31/48/60/70/85`, the amber tokens and the
dotted-arc dasharray agree across code, specs and prototypes; and the TS→Rust
refactor's side effect fires on the same condition with the same arguments
across 176,960 scenarios with zero mismatches.
