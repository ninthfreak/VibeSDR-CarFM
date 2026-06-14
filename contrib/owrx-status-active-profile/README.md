# OpenWebRX: expose the active profile in `/status.json`

**What:** add the currently-tuned profile name to each SDR in the public
`/status.json` response.

**Why:** `/status.json` already lists every *active* SDR and its *available*
profiles, but not **which profile each SDR is currently tuned to**. The server
knows it (`SdrSource.getProfileName()`), it's just not surfaced. Exposing it lets
a client show not only *which SDR is in use* but *which profile* — so a user can
choose to **join the in-use profile** (no disturbance) instead of switching the
SDR to a different profile and booting another listener / a background decoder.

This is purely additive (one new optional key), needs no auth, and changes no
existing behaviour. Clients that don't know the field ignore it.

## The patch — `owrx/controllers/status.py`

In `StatusController.getReceiverStats`, add `active_profile`:

```python
    def getReceiverStats(self, receiver):
        stats = {
            "name": receiver.getName(),
            "type": type(receiver).__name__,
            "profiles": [self.getProfileStats(p) for p in receiver.getProfiles().values()],
        }
        # Surface the currently-tuned profile so clients can show which profile
        # (not just which SDR) is in use, and let users join it instead of
        # switching the SDR out from under another listener.
        try:
            stats["active_profile"] = receiver.getProfileName()
        except Exception:
            # an SDR with no profile selected yet — just omit the key
            pass
        return stats
```

A ready-to-apply unified diff is in [`status-active-profile.patch`](status-active-profile.patch).

## Result

```jsonc
"sdrs": [
  {
    "name": "SDRPlay RSP1A",
    "type": "SdrplaySource",
    "active_profile": "VHF 143.5MHz - 148.5MHz: 2m HAM Band",   // ← new
    "profiles": [ /* … unchanged … */ ]
  }
]
```

`active_profile` matches the corresponding entry's `name` in that SDR's
`profiles` list, so a client maps it straight back to its profile.

## Notes
- Tested against OpenWebRX+ v1.2.116 (`/status.json` is identical to upstream
  openwebrx-master there — the field is absent on both, hence this patch).
- Submitted alongside the DAB decode-rate fix (see `../owrx-dab-speed-fix`).
