// Local-hardware (RTL-SDR / RTL-TCP) session generation guard.
//
// The native shim (LocalSdrShim) is a SINGLETON, but the JS that STARTS a session
// (InstancePickerScreen) and the JS that STOPS it (SDRScreen unmount cleanup) live
// in different components. When switching instances the old screen's unmount can
// run AFTER the new session has already started, and its stopSpectrum() would tear
// down the NEW session. (V5's much faster native start re-exposed this — the old
// engine's slow start used to hide the ordering.)
//
// Each successful start bumps the generation; a screen captures the generation it
// owns and only stops if it's still the latest — so a stale screen can never stop
// a newer session.

let gen = 0;

/** Call right after a successful startSpectrum/startTcp; returns the new gen. */
export function newLocalSession(): number {
  return ++gen;
}

/** The current (latest) local-session generation. */
export function localSessionGen(): number {
  return gen;
}
