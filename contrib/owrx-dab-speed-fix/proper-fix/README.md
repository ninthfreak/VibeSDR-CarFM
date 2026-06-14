# Proper fix: honour the DAB service's real audio rate

The root cause is that the Dablin chain reports a **constant** 48 kHz audio rate
to the rest of OpenWebRX+, even though `dablin` decodes each service at its
native rate (often 32 kHz or 24 kHz). Fixing this server-side corrects the audio
for **every** client at once, with no user interaction.

`csdr/chain/dablin.py`:

```python
class Dablin(BaseDemodulatorChain, FixedIfSampleRateChain, FixedAudioRateChain, ...):
    def getFixedAudioRate(self) -> int:
        return self.outputRate        # always 48000
```

`dablin` already knows the true rate — it's in the decoded audio format. The fix
is to surface that rate instead of assuming 48 kHz. There are three ways to do
it, smallest-change first.

---

## Option A (minimal, highest value): expose the rate in DAB metadata

Add the decoded `audio_rate` (and optionally `channels`) to the DAB metadata that
already flows to clients via the `MetaProcessor` / `metadata` message. Clients can
then auto-correct (compute `48000 / audio_rate` and resample), exactly the way
VibeSDR's manual factors map (×0.6667 = 32 kHz, ×0.5 = 24 kHz).

`DablinModule` (csdr-eti side) reads dablin's output format, so it knows the rate.
Pass it into the metadata stream. Conceptually, in `MetaProcessor.process`:

```python
# dablin/DablinModule already reports the decoded service's audio format;
# include it so it reaches the client `metadata` message:
#   result["audio_rate"] = <decoded sample rate, e.g. 32000>
#   result["audio_channels"] = <1 or 2>
```

This is non-invasive (no DSP change), unblocks every client that resamples its
own audio, and is the single most useful thing for third-party clients. VibeSDR
would consume `audio_rate` and drop its manual control entirely.

## Option B (complete server-side fix): report the real rate / resample to 48 k

Make the chain honour the true rate so even naive clients are correct:

1. Have `DablinModule` expose the decoded sample rate (it has it).
2. Either:
   - return that rate from `Dablin.getFixedAudioRate()` instead of the hardcoded
     `outputRate`, and let the existing downstream resampler convert to the
     client's requested `hd_output_rate`; **or**
   - insert a resampler (e.g. a `Fractional`/`Resampler` csdr module) right after
     `DablinModule` keyed to `decodedRate → outputRate`, so the chain truly emits
     a constant `outputRate` of *correct-speed* audio.

The first sub-option is cleaner if `FixedAudioRateChain` can report a value that
only becomes known after the first decoded frame; the second guarantees a fixed
output rate at the cost of one resample.

## Option C (decoder-level): force dablin to a fixed output rate

If `dablin`/`dablin-eti` can be invoked to resample its PCM output to a fixed rate
(48 kHz), the chain's `getFixedAudioRate = 48000` assumption becomes true and the
bug disappears with no Python changes. Worth checking the `DablinModule`
invocation flags; if a resample-on-output option exists, this is the smallest
change of all.

---

## Why this matters / evidence

Confirmed on real UK DAB+ multiplexes with VibeSDR's manual correction:

| Observed correction | True rate | 48000 / rate |
|---------------------|-----------|--------------|
| ×0.6667             | 32 kHz    | 1.5          |
| ×0.5000             | 24 kHz    | 2.0          |

Services already at 48 kHz need no correction — which is exactly why some
services on a mux are fine and others chipmunk: it's **per-service**, driven by
each service's audio sampling rate, which `dablin` decodes correctly but the
chain currently discards.

Happy to help test against a real mux or compare client behaviour — just ask.
