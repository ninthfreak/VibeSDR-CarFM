# Reply → Claude Design: answers to the gaps in `signal-quality-handoff.md`

All nine answered from the code, not from memory. Two of your blockers turned up
things worse than you suspected; one is already solved and I failed to point at
it. Read this alongside the original brief — where they disagree, this wins.

---

## 1. The backend set — you are right, and the real situation is worse

There are four picker entries, exactly as you list. But:

**The picker's choice is stored and nothing reads it.** `BACKEND_KEY`
(`@carfm/tuner_backend_v1`) is written and read *only inside*
`SettingsPanel.tsx`. No other file touches it. The live backend is decided
somewhere else entirely — by a launch parameter (`route.params.tunerless`) plus
the NWD availability probe.

So, correcting the premises in your questions:

- **`auto` is not the current default, and selecting it does nothing.** The
  picker's local default is `'rtl'`, and whichever row you tap, the stored value
  drives no behaviour. There is no probe sequence to design around because there
  is no probe.
- **`fyt` is hard-coded `available: false`** with no implementation anywhere. It
  is a placeholder for a platform we have never run on. Do not design for it.
- **Functionally there are two live sources**: the built-in NWD tuner, and the
  SDR path. That is why the brief said two — but I stated it as the design's
  world rather than as a defect, which misled you.

That the picker is decorative is a real bug. It is now on the task list; it is
not yours to solve and it does not block this mock-up.

**On the driver being told which readout they are looking at:** at present, no —
and with only one selectable-in-practice source there has been nothing to
confuse. Once the picker actually works, two variants rendering different
quantities in the same position with no unit and no source tell would be
genuinely ambiguous, and you are right that it needs one. Please treat "a source
tell may be needed later" as a known future requirement rather than designing it
now.

## 2. The state contract — this already exists and I should have linked it

`src/services/tunerCapabilities.ts`. It is exactly the object you asked for, and
its own header says it is **not yet wired**. Design against this, not against a
backend id:

```ts
signal:          'measured' | 'estimated' | 'none'
radioText:       'live' | 'unsupported'
stereo:          'live' | 'on-change' | 'none'
stationIdentity: 'rds-pi' | 'frequency-db'
lockState:       'reported' | 'none'
metadataSettleMs: number
```

Answers to your three sub-questions:

- **Interim contract: the capability object.** Not a backend id. That is the
  whole point of the file and the reason it was written.
- **Who owns it:** nothing yet — the branches still test source identity
  (`nwdActive ? … : …`, in 59 places in RadioScreen alone). Wiring it is mine.
- **It has no field for reception quality yet.** I will add one, and it should
  be a capability rather than a number the face has to interpret — something
  like `receptionQuality: 'block-errors' | 'pi-match-only' | 'none'`, so the
  face can render "a real error rate" and "one block's worth of evidence"
  differently, or refuse to show the second at all.
- **Level and quality are two independent nullable fields**, not one object.
  Level can be present while quality is unknown, which is the common case.

## 3. Quality's time behaviour — specified now

Implemented in `nwdRds.ts` as a ring of recent group outcomes:

- **Window: the last 64 groups**, not a duration. At the ~5 groups/sec that
  actually reach us that is roughly 12 seconds, but it stretches when reception
  is poor — which is deliberate, since a fixed time window would thin out to
  meaninglessness exactly when things are worst.
- **Minimum 16 outcomes** before any percentage is quoted. Below that, null.
- **Resets on station change**, and only on station change. It is deliberately
  *not* reset by the 15-second debug sampler, which has its own counters —
  otherwise the display would blank every time a sample closed.
- **Yes, it can return to null mid-listen.** Not from the ring emptying, but
  because the screen clears all RDS-derived state after 25 seconds without a
  group. So present → absent → present is reachable on a real drive and you
  should design the transition, not just the two end states.
- **Update cadence:** quality is read on the existing 1.5 s poll. Level updates
  far more slowly — every 30 s while parked on a station, plus once 5 s after
  each retune. That asymmetry is itself worth designing around: the small number
  moves while the big one sits still. You may specify damping or a slower
  quality cadence; I will implement whatever you pick.

## 4. Thresholds versus the data — you are right, here are the counts

Across the 156 samples:

| bars | samples | share |
|---|---|---|
| 0 | 0 | 0% |
| 1 | 1 | 0% |
| 2 | 49 | 31% |
| 3 | 71 | 45% |
| 4 | 35 | 22% |

Minimum seen: **30**. So in practice it is a three-state icon, exactly as you say.

**Can a tuned station read below 30?** Rarely, and not by accident. The two low
floors are the tuner's own seek-stop constants: a DX seek will not *stop* below
10, a local seek not below 31. Every sample here was on a preset — a real
station — so the low bands represent "the chip would not consider this a
station", which a driver on presets essentially never sees. It is reachable by
dialling to an empty channel, and one sample did land at 30.

**My position:** the two vendor floors are semantically load-bearing and I would
keep them as the definition of "not a station". But the *displayed resolution*
is yours. If the honest answer is that the icon should spread its states across
30–103, where life actually happens, propose that — I will keep the floors
internally and remap the presentation. Say explicitly which you have done so it
does not get re-derived later.

## 5. Level's not-live states — specified now

Both of your suspicions are correct.

- **During a scan/seek: invalid.** The dial is sweeping and the reading belongs
  to whatever it swept past. The face already receives a `scanning` flag.
- **Immediately after tuning: invalid, and measurably so.** Across 24 paired
  comparisons the first reading after a retune ran a mean **+17.7** above the
  same station 20 seconds later, with individual cases of +45, +48 and +57. The
  code now waits 5 seconds before believing a post-tune level.

So the level needs its own not-live treatment for those two windows, and the
brief's state list was incomplete. Add: **level suppressed/settling** as a state.

## 6. Off versus unknown — confirmed collision, and it is yours to resolve

- `--` was chosen when the number was a dB figure; it carries no meaning now and
  you should replace it.
- **Powered off, the quality line should not render at all.** Off means the
  radio is not receiving; a quality figure would be asserting something about a
  signal we are not listening to.
- Off and unknown **must be distinguishable**, and the brief created the clash by
  mandating a real unknown state without saying what off looks like. Your call
  on both tokens.

## 7. RT+ / now-playing — **no, out of scope**

Confirmed: this task is the header cluster only.

The capability difference is real and I should not have put it in a table that
read as a work list. For the record so it is not lost: the now-playing line is
already backend-dependent in code — the face prefers `rtArtist`/`rtTitle` when
present, and only the SDR path ever fills them. On this tuner the driver gets
the station's raw RadioText, and the station's own field order is inconsistent
(`Whole Lotta Love - Led Zeppelin` and `Led Zeppelin - Kashmir` within the same
hour), so artist and title cannot be separated here at all.

That is a separate brief when it happens.

## 8. Size and the § references

- **Quality line size:** use **11** in wide and **13** in tall, pre-scaling,
  against level's 15 and 19. That is a starting point, not a constraint —
  overrule it if the hierarchy needs more separation. Everything passes through
  the responsive `s()` helper and small status type floors at legibility rather
  than proportion.
- **The § numbers are from `docs/design/handoff/ANDROID-IMPLEMENTATION.md`**,
  which I failed to name. Your inferences were right: §6 is the colourblind
  rule, §10 the small-type legibility floor, §4.7 the audio-priority/off state.

## 9. `PI 84%` — agreed, drop it

You are right that it is jargon that buys precision nobody can spend. Propose
whatever keeps the honesty — the constraint is only that the label must not
imply the number says anything about the blocks carrying the *text*, because it
structurally cannot. That limitation is why RadioText was visibly corrupt on a
station whose error rate looked fine.

---

## Summary of what changed

Design against **capabilities**, not backend ids — the object exists. Two live
sources, not four; the picker is broken and that is my problem. Quality has a
64-group window, a 16-outcome floor, resets only on station change, and **can**
go null mid-listen. Level is invalid during scan and for 5 s after tuning, so it
needs a not-live state too. The bar icon really is a three-state icon on real
data and you may remap the presentation. RT+ is out of scope. Sizes and the §
source are above.
