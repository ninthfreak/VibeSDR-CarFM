/**
 * Is a WATCH-DRIVEN boot in charge of where we connect?
 *
 * InstancePicker AUTO-CONNECTS to the default instance when it mounts. That is right
 * when a human opens the app — and wrong when the WATCH woke the phone and has already
 * decided (or is about to decide) which server to use. Without this, the picker's
 * auto-connect races the watch's choice and drags you back to the default: pick OWRX on
 * the wrist, and the phone bounces straight back to UberSDR.
 *
 * A module flag, deliberately: it is a fact about THIS PROCESS, not app state, and both
 * sides need to read it before React has settled.
 */
export const watchTargetPending = { claimed: false };
