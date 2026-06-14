# OpenWebRX+ DAB / DAB+ sample-rate ("chipmunk") fix

This package documents the long-standing DAB/DAB+ playback-speed bug — where some
UK (and other) DAB+ services play back too fast and high-pitched ("chipmunk"),
while other services on the *same* multiplex are fine — and offers two ways to
address it: a quick client-side workaround, and the proper server-side fix.

It was put together by the developer of **VibeSDR** (a native iOS/Android client
that speaks the OpenWebRX+ protocol). We hit the exact same bug building our DAB
support against OpenWebRX+ v1.2.115, root-caused it, and added a working
client-side correction. Sharing it here in case it's useful upstream — no
criticism intended, just trying to give back a concrete fix with evidence.

---

## Symptom

- Some DAB+ services play ~1.5× too fast / high-pitched; some ~2× too fast.
- Other services on the same ensemble are perfect.
- Identical in every client (the OpenWebRX+ web UI and third-party clients),
  because the audio is already wrong-speed by the time it leaves the server.

## Root cause

DAB/DAB+ services are broadcast at different audio sampling rates — commonly
**48 kHz, 32 kHz, or 24 kHz** (legacy MP2 and low-bitrate DAB+ frequently use 32
or 24 kHz; HE-AAC at 48 kHz internal is the other common case).

`dablin` decodes each service at **its native rate**. But in OpenWebRX+, the
Dablin chain reports a **fixed** audio rate to the rest of the DSP pipeline:

`csdr/chain/dablin.py`:

```python
class Dablin(BaseDemodulatorChain, FixedIfSampleRateChain, FixedAudioRateChain, ...):
    def __init__(self, outputRate: int = 48000):
        self.outputRate = outputRate
        ...
    def getFixedAudioRate(self) -> int:
        return self.outputRate        # <-- always 48000, regardless of the service
```

So a 32 kHz service is decoded as 32 kHz PCM but labelled 48 kHz all the way to
the client. The client resamples/plays it as 48 kHz → 48000/32000 = **1.5× too
fast**. A 24 kHz service → 48000/24000 = **2× too fast**.

## Our evidence (VibeSDR)

We added a manual per-station speed control and confirmed the exact ratios on
real UK muxes:

| Correction factor | Implied true rate | Example                          |
|-------------------|-------------------|----------------------------------|
| ×1.000 (none)     | 48 kHz            | most services — already fine     |
| ×0.6667           | 32 kHz            | confirmed on UK DAB+ services    |
| ×0.5000           | 24 kHz            | confirmed on a UK DAB+ service   |
| ×0.3333           | 16 kHz            | confirmed on a UK DAB+ service   |
| ×0.2500           | 12 kHz            | confirmed (a low-bitrate HE-AACv2 service) |

`factor = trueRate / 48000`. The fix is simply to honour the service's real
sampling rate instead of assuming 48 kHz. All four lower rates (32/24/16/12 kHz)
are HE-AAC core/output rates that occur at lower DAB+ bitrates.

> Note on HE-AAC v2 / Parametric Stereo: very-low-bitrate services use PS, where
> a mono core carries side-parameters to rebuild stereo. If the decoder mishandles
> PS the audio is structurally corrupted (not merely sped up), and a speed factor
> can only get it *close*. Those are a decoder-correctness issue, separate from the
> rate-labelling bug above — but most affected services are plain rate misreads
> that this fixes exactly.

---

## Contents

- `plugin/dab_speed/` — a **drop-in OpenWebRX+ web-UI plugin** (0xaf plugin
  system, no core-file edits). Adds a "DAB Speed" selector to the DAB panel and
  time-stretches HD audio by the chosen factor while a DAB service is tuned —
  exactly mirroring what VibeSDR ships, remembered per ensemble+programme. A
  client-side band-aid that works today; good if the dablin side is hard to touch.

- `proper-fix/` — the **correct** fix: have the Dablin chain report the service's
  real audio rate (which `dablin` already knows), so every client gets correct
  audio automatically with zero user interaction. Includes the minimal,
  highest-value variant (surface the rate in DAB metadata) so even clients that
  can't change their resampling can self-correct.

## Installing the plugin (test it now)

1. Copy `plugin/dab_speed/` to `htdocs/plugins/receiver/dab_speed/` on your
   OpenWebRX+ server.
2. Add this line inside the `.then(...)` block of
   `htdocs/plugins/receiver/init.js` (copy from `init.js.sample` if you don't
   have one yet):

   ```js
   Plugins.load('dab_speed');
   ```
3. Hard-refresh the receiver page (Ctrl/Cmd-Shift-R). Tune a DAB service, open
   the DAB panel, and pick a speed (×0.67 for the common 32 kHz chipmunk).

No server restart needed — it's pure browser-side. Confirmed correction factors:
×0.6667 (32 kHz) and ×0.5 (24 kHz) on UK DAB+ muxes.

See each folder's README for details.
