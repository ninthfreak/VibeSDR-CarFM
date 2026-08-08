# Review: the Rust portable core branch, against main

Reviewed 2026-08-08. Subject: `claude/slint-conversion-carfm-removal-325vh5`
(4 commits ahead of `main`, merge-base exactly `main`). Method: every claim
below was established by running something or opening the file — commands and
outputs are quoted inline. Two independent passes (one manual, one fanned out
across six review dimensions with adversarial verification of each non-minor
finding) were merged into this document.

## Verdict

The port is close to exemplary — and it ships one real bug. The Rust decoder,
the PI arithmetic, the geo maths, the ranking and the identification rules are
line-for-line faithful to the TypeScript references; the TS refactor that
extracted the pure halves is behaviour-preserving including the enrichment
side-effect's firing condition; the differential harnesses are deterministic,
non-circular, and genuinely fail on drift (verified by mutation, not by
reading); and the commit messages are accurate on every figure that could be
re-derived. Against that standard, three things need fixing before the next
pass builds on this branch: a proven panic/divergence in the RadioText
terminator handling that none of the branch's own tests can see, a cluster of
differential blind spots (2B RadioText, the slow-scroller verdict,
`quality()`/`stats()`), and a handoff document whose own branch falsified
several of its claims after it was written.

## What was verified and held

Every mechanical claim in the branch's commit messages reproduced exactly:

- `cd core && cargo test` — 50/50 pass (20 rds replay + 30 stations).
- `npm run test:backend` — 18 suites, 427 assertions, no failures.
- `npx tsc --noEmit -p tsconfig.json` — clean.
- `npm run test:rds-diff` — `RDS differential: IDENTICAL over 1630 steps.`
- `npm run test:stations-diff` — `EQUIVALENT over 87603 scenarios (98420
  output lines, 132878 numbers). skeletons identical; worst numeric deviation
  1.097e-15 (tolerance 1e-9)`.

Structural findings that held under adversarial checking:

- **RDS port fidelity**: every threshold (PI_CONFIRM=3, PI_DISPLACE=12,
  PS_SCROLL_DISTINCT=3, QUALITY_MIN=16), every consensus tally (PI, PTY, TP,
  TA), the PS two-cycle rule with slow-scroller retraction, the RadioText
  first-fill-instant/replacements-must-repeat rule, RT+ AID matching with
  off-the-end rejection, and the reset / reset_for_retune / clear_ta split all
  match the TS decoder. Probes beyond the corpus (A/B flip, full 16-segment
  fill, terminator in segment 14, mid-join fragments) were byte-identical.
- **Stations port fidelity, both hops**: `identifyFromSource` is a verbatim
  move of main's `identifyByPi` rules (the early-return restructures drop only
  guards made unreachable by those returns), and `identify.rs`/`pi.rs`
  reproduce it including JS-only semantics — the `-.*$` line-terminator
  behaviour, `String.prototype.trim`'s U+FEFF, `\b` word-boundary scanning,
  insertion-ordered dedupe. `noteEncountered` fires on exactly the condition
  it did on main (non-null station), with equivalent arguments.
- **Geo/rank fidelity**: identical constants, identical operation order,
  matching sort-stability and NaN-comparator outcomes (JS NaN→0 keeps order;
  Rust `unwrap_or(Equal)` keeps order).
- **Harness validity**: the corpus is generated independently of both
  implementations (the RBDS formula is inlined in the generator "so the corpus
  does not depend on the code it tests"), the interleave runs off a fixed-seed
  LCG, the stations skeleton/numbers split is sound (structural drift is a
  hard failure; 1e-9 relative tolerance cannot mask integer-scale drift on any
  value printed), and both failure arms were re-broken and re-observed to fail
  during this review, independently of the commit message's own account of
  doing the same.
- **Hygiene**: both crates are dependency-free (the 11-line `Cargo.lock` is
  the workspace itself), `core/.gitignore` covers `/target`, and the branch
  deletes the `core/target` build artifacts that PR #81 (`ed7d844`)
  accidentally committed to main — no binaries remain anywhere in the branch
  tree.

## Critical

### 1. RadioText terminator in segment 15: panic in debug, silent drift in release

`core/rds/src/lib.rs:600`:

```rust
let end_mask = match self.rt_end_seg {
    None => 0u16,
    Some(s) => (1u16 << (s + 1)).wrapping_sub(1),
};
```

`s` is the 2A segment index (`b & 0xf`), so a 0x0D terminator byte landing in
segment 15 — any 60–63-character CR-terminated RadioText, or one corrupt
block B on a decoder that ingests raw uncorrected groups — makes the shift
amount 16 on a `u16`. The `wrapping_sub` guards the subtraction; nothing
guards the shift. The TS reference is safe here because JS numbers make
`(1 << 16) - 1` = 0xFFFF (`nwdRds.ts:489`).

Reproduced both ways, after three PI-confirming groups on `a6ff`:

- **Debug** (the profile `cargo test` and `rdsDifferential.mjs` both run):
  feeding `a6ff254f0d202020` → `thread 'main' panicked at rds/src/lib.rs:600:
  attempt to shift left with overflow`, exit 101.
- **Release**: the shift wraps to `1 << 0`, `end_mask` becomes 0, and
  `terminated_and_complete` goes true with only segment 15 seen — the decoder
  publishes a phantom empty message and consumes the first-fill-is-instant
  credit. Demonstrated divergence: after the probe group, a real
  CR-terminated message shows immediately on the TS side and one full extra
  cycle later on the Rust side.

Neither harness can see this: the corpus's synthesized 2A sweep stops at
segment 7 and its RT story terminates at position 31 (segment 7), and
`replay.rs`'s fixtures terminate at segment 5. Fix is one line (saturate the
mask at segment 15, or compute it in u32); the corpus should gain 2A segments
8–15 and a terminator past segment 7 in the same commit, so the fix is pinned.

## Major

### 2. The differential's blind spots, on the branch whose central claim is the differential

The equivalence proof is real for what it covers, but three decoder behaviours
are outside it, verified by mutation (a deliberately broken port still prints
`IDENTICAL` / `EQUIVALENT`):

- **2B (version-B) RadioText is never exercised.** The corpus comment says
  "a 0B/2B version-B variant for coverage" but the emitted group is
  `blockB(0, 1, …)` — type 0 only. No type-2 version-B group exists in the
  corpus, so the whole 2-chars-at-seg×2 path (`lib.rs:561-571`) is unproven;
  deleting it entirely stays green. The comment claims coverage that is not
  there — in this project's own terms, a false claim in a comment is a defect.
- **The PS slow-scroller verdict is never reached.** The sweep publishes one
  distinct PS value per station and the drive-log captures never push a third
  distinct assembly through the two-cycle gate, so `PS_SCROLL_DISTINCT` drift
  (or deleting the retraction) passes the differential. Only `replay.rs` unit
  tests pin it, on the Rust side alone.
- **`stats()` and `quality()` are outside the dump surface entirely — and
  `quality()` already diverges.** Rust computes `pi_match_pct` in f32
  (`lib.rs:341`), TS in f64: 13-good-of-17 is 76.47059 vs 76.47058823529412.
  Cosmetic today (a display proxy), but it is exactly the kind of silent
  drift the harness exists to make impossible, sitting in the one corner the
  harness does not print.

### 3. `replay.rs` overclaims its provenance

The header says "Ported from tools/tests/nwdRds.test.mjs", but the TS suite's
entire RadioText replacement discipline has no Rust counterpart: the
partly-received-never-shown case, the "tta Love" terminator-with-missing-
segments regression, corrupt-cycle-does-not-replace (twice, differently),
new-message-needs-one-repeat, A/B-flip-publishes-instantly. The differential
covers some of this incidentally; the named regressions the TS file exists to
pin are not in the Rust suite that claims descent from it. Either port the
missing tests or reword the header to what it is (a selection).

### 4. `reset()`'s doc comment gives a future caller the recanted advice

`lib.rs:237`: "Drop all accumulated text. **Call on retune**: PS/RT belong to
the old station." Directly below it, `reset_for_retune`'s comment explains at
length why calling `reset()` on a retune is wrong — it is the measured
PI-blackout fault (12-group displacement against 30-35% block-A error rates)
that `reset_for_retune` exists to fix. The TS file carries the correction;
the Rust doc resurrects the mistake on the API a Slint caller will read
first. One sentence to fix.

### 5. Both crates name their example `dump`

`cargo` already warns (the issue-6313 output-filename collision note on every
build, "this may become a hard error in the future"), and the plain
`cargo run -q --example dump` that `docs/HANDOFF.md` §6 quotes now fails with
"can run at most one executable". The harnesses survived only because they
pass `-p`. Rename the examples (`rds-dump` / `stations-dump`) and update the
handoff's command.

### 6. HANDOFF.md was falsified by its own branch and never updated

Written at `95cbec1`, then two more commits landed on the same branch without
touching it. As shipped at the branch tip:

- **§6 "cargo test — 20 tests"**: the tip has 50.
- **§6 "byte-identical over a 4024-step corpus"**: the shipped deterministic
  corpus is 1630 steps, and the stations side is deliberately not
  byte-identical (skeleton + 1e-9), which §6 predates entirely.
- **§7 "`claude/portable-core-rds` … its core has been re-ported onto
  main"**: false — the core exists only on this unmerged branch; main's
  `core/` contains nothing but the orphaned build artifacts this branch
  deletes. A successor starting from main on the strength of this sentence
  finds no core. (The superseded branch also no longer exists on the remote.)
- **§7 "the work branch has been merged into it (PR #85)"**: PR #85 merged
  `claude/design-audit-handoff-26qnlb`. True of that branch, misleading in a
  document that ships on this one — this branch's four commits are unmerged.
- **§7 "the Rust core … is a library with no caller and cannot affect app
  behaviour"**: true when written, falsified by `430851b` on this same
  branch, which refactors live app code (`stationDb.ts`, `stationFinder.ts`)
  to delegate to the extracted modules. The refactor is behaviour-preserving
  (verified), but the doc's risk assurance no longer describes the branch.
- **§8 "the station database … still live[s] in TypeScript"**: §8's scoping
  advice predates `core/stations` and never mentions it.

The handoff is otherwise a genuinely valuable document; it needs one updating
pass at the branch tip, not a rewrite.

## Minor

- `fmt_mhz` (`identify.rs:95-97`) claims JS-identical float formatting;
  diverges for exponent-range values, −0 and infinities — all unreachable for
  real frequencies.
- The stations corpus never exercises non-ASCII PS text against the
  hand-rolled `\b` reproduction in `callsign_in_ps` (removing the boundary
  checks entirely still passes); `WÖLX` covers only `callsign_base`.
- NaN clamp semantics differ silently at three sites (`Math.max` propagates
  NaN; `f64::max` discards it) — unreachable from the bundled DB.
- `rt_plus_ver_b` (a station assigning RT+ to a version-B group) is never
  exercised by any test or the corpus.
- The identify/nearby dumps print `callsign|frequency|service` per row, so a
  tie-pick among rows identical in those three fields could drift invisibly.
- `cargo fmt --check` produces 45 diff hunks across all 9 new .rs files;
  `cargo clippy` reports 5 warnings (3 `doc_lazy_continuation`,
  2 `identity_op`). Neither tool appears to have been run.
- `FREQ_EPS` is exported but both harness `StationSource` impls and the SQL
  hardcode `0.05` for the dial-match tolerance beside it.
- Commit `6211f46` says the corpus interleaves "119 control commands"; the
  shipped generator emits 139.
- HANDOFF §8 cites design bundle "v1.14.4"; the vendored bundle's VERSION
  file reads 1.10.0.
- The RadioText byte-staging `vec!` allocates per group (`lib.rs:561`); a
  fixed array and slice would do.
- Branch-name note: `…carfm-removal…` removes no VibeSDR code — the branch is
  purely the portable-core port plus harnesses. The VibeSDR strip remains
  entirely ahead.

## Recommended order

1. Fix the segment-15 mask (one line), extend the corpus to 2A segments 8–15
   with a late terminator, re-run both differentials.
2. Add a 2B RadioText passage and a third distinct slow-scroller value to the
   corpus; print `stats()`/`quality()` in both dumps; make `quality()` f64.
3. Rename the duplicate examples; run `cargo fmt` and fix the 5 clippy lints.
4. One updating pass over HANDOFF.md §6–§8 and the two comment defects
   (`reset()` retune advice, corpus "0B/2B" claim, `replay.rs` header).

## Addendum, same day: fixes applied

All four items above landed on the work branch as `a9a5475` (code and
harness) and `d315251` (handoff), verified the same way the review was done —
each closed hole was re-opened on purpose and observed to fail:

- Segment-15 mask computed in u32; two `replay.rs` regressions pin it; the
  corpus gained four un-interleaved, `!retune`-primed stories (seg-15
  terminator, 2B RadioText terminating in segment 15, slow scroller crossing
  the verdict, replacement gate). Reverting the mask fix panics the harness;
  breaking 2B addressing, `PS_SCROLL_DISTINCT`, or reverting `quality()` to
  f32 each print DIVERGED with a step number.
- Both dumps print `stats()`/`quality()` per line; `quality()` is f64 with
  the TypeScript's operation order.
- Examples renamed `rds-dump`/`stations-dump`; the issue-6313 warning is
  gone; `cargo fmt --check` and `cargo clippy --all-targets` are clean.
- `reset()`'s doc, the corpus "0B/2B" comment and the `replay.rs` header now
  say true things; HANDOFF §6–§8 rewritten against the branch tip.
- After all of it: RDS differential IDENTICAL over 2101 steps, stations
  differential unchanged (worst deviation 1.097e-15), cargo test 52/52,
  test:backend 18/18, tsc clean.

Still open, deliberately (minors, in the list above): the `fmt_mhz` edge
cases, unicode PS text in the stations corpus, the NaN clamp-site semantics,
`rt_plus_ver_b` coverage, the tie-pick dump columns, the hardcoded 0.05
beside `FREQ_EPS`, and the unfixable commit-message figure in `6211f46`.

## Second addendum: the minors, closed

Six of the seven landed in a follow-up commit on this branch, each verified
by breaking it and watching the harness object:

- `fmt_mhz` handles the non-finite spellings and −0 and documents its true
  domain; a new `identify … Infinity` scenario pins it (mutant prints "inf"
  vs "Infinity" — STRUCTURAL DIVERGENCE).
- The stations corpus feeds the hand-rolled `\b` reproduction embedded runs,
  multi-byte neighbours, ß-expansion and underscores; stripping the boundary
  checks now diverges (caught on `AKQRZX`).
- All four Rust clamp sites reproduce `Math.min`/`Math.max` NaN propagation
  via explicit comparisons; NaN `score`/`geo`/`bbox` scenarios pin them
  (reverting one clamp: NaN vs −59.02… — STRUCTURAL DIVERGENCE).
- An RT+ version-B story assigns 11B and sends an 11A decoy with swapped
  artist/title fields; removing the version check swaps the tags and
  diverges at the decoy.
- Both station dumps print `facility_id` on nearby rows and the identify
  station triple, so a tie-pick among identically-printed rows can no longer
  drift invisibly.
- The dial tolerance references `FREQ_EPS` everywhere it was hardcoded: the
  SQL in `stationDb.ts`, both harness sources, and the crate's test fixture.

The seventh — commit `6211f46` quoting 119 control commands where the
generator emits 139 — is committed history; this document is its correction.
After the fixes: RDS differential IDENTICAL over 2170 steps, stations
differential EQUIVALENT over 87,622 scenarios (worst deviation unchanged),
cargo test 52/52, clippy and fmt clean, test:backend 18/18, tsc clean.
