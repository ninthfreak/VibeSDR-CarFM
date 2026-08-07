/**
 * Start the built-in tuner as early as the JavaScript can reach it.
 *
 * THE PROBLEM. Audio used to begin at the end of a long chain: bundle executes,
 * two fonts register, the navigation container mounts, InstancePicker mounts and
 * runs its async init, it navigates to Radio, RadioScreen mounts, its effect
 * awaits isNwdAvailable(), then binds the vendor service, and only then enables
 * audio. Every one of those steps is in front of the first sound, and none of
 * them is something the tuner needs.
 *
 * WHAT MAKES THIS SAFE. `NwdRadioModule.connect` is idempotent — if the service
 * is already bound it resolves immediately with the current state. So starting
 * the bind here does not race RadioScreen's own connect; that call simply
 * returns what this one already established, and the retry logic there still
 * covers the case where the vendor service was not up yet.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. RDS, the media-button session, the level
 * watch and every piece of screen state stay with RadioScreen. This does the two
 * things that make sound — bind, and enable audio — and nothing else. Widening
 * it would put startup ordering and screen lifecycle in two places at once.
 *
 * Runs at import time from index.ts, so it is in flight while React is still
 * starting up rather than after it has finished.
 */
import { isNwdAvailable, nwdConnect, nwdSetAudio } from './nwdRadio';
import { loadTunerBackend } from './tunerBackend';
import { diag } from './diag';

let started = false;

/**
 * Kick off the tuner. Fire-and-forget by design: nothing may await this, because
 * anything that awaited it would put the bind back in front of first paint,
 * which is the whole thing being removed.
 */
export function warmStartNwd(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      // Only on a path that WANTS the built-in tuner. On an RTL-SDR selection,
      // claiming FM audio here would be taking a source the user did not ask
      // for — and the MCU records the current source, which is what the
      // firmware restores on the next ignition cycle.
      const backend = await loadTunerBackend();
      if (backend !== 'nwd' && backend !== 'auto') return;

      if (!(await isNwdAvailable())) return;
      await nwdConnect();
      nwdSetAudio(true);
      diag('warm start: tuner bound and audio enabled before the UI mounted');
    } catch (e) {
      // A failure here is not an error state — RadioScreen's own connect runs
      // regardless, with three attempts and its own reporting. This is an
      // optimisation, and it must never be the reason the radio does not work.
      diag(`warm start: skipped (${String(e)})`);
    }
  })();
}
