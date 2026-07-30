// driveLock.ts — actions that must not happen while the vehicle is moving.
//
// Some things in the face are two-handed, look-at-it tasks. Those are refused
// while the car is rolling, and the refusal has to be VISIBLE or it just reads
// as the app being broken: every block fires the same feedback — the §4.6
// motion-car glyph briefly swelling to a few times its size.
//
// This is a plain event bus rather than React state on purpose. The only
// response to a block is one leaf glyph running an animation; routing it
// through the face's state would re-render the whole face to play it.

import { isMoving, subscribeMotion, type Motion } from './motion';

const listeners = new Set<() => void>();

/** Play the "not while driving" feedback. Also used when a mode the user was
 *  already in has to close itself because the car pulled away — the flash is
 *  what explains the mode vanishing. */
export function signalDriveBlocked(): void {
  listeners.forEach((l) => { try { l(); } catch { /* a bad listener must not stop the rest */ } });
}

/** Subscribe to blocked-action events (the glyph that draws the feedback). */
export function subscribeDriveBlocked(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** True when the vehicle is moving — and fires the feedback as it says so, so
 *  call sites read as a guard: `if (blockedWhileDriving()) return;` */
export function blockedWhileDriving(): boolean {
  if (!isMoving()) return false;
  signalDriveBlocked();
  return true;
}

/** Watch for the car pulling away while a drive-locked mode is open, and close
 *  it. Returns an unsubscribe, so it drops straight out of a useEffect that is
 *  only mounted while the mode is active. Fires immediately with the current
 *  motion, which also covers "somehow entered while already moving".
 *
 *  `onBlocked` should close the mode; the flash is played here so every exit
 *  route looks the same to the driver. */
export function closeOnMotion(onBlocked: () => void): () => void {
  return subscribeMotion((m: Motion) => {
    if (!m.isMoving) return;
    onBlocked();
    signalDriveBlocked();
  });
}
