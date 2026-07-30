// Regression test for services/driveLock.ts — the "not while driving" gate.
//
// The rules under test:
//   • stopped  -> the action goes ahead, and NO refusal flash is played
//   • moving   -> the action is refused, and exactly ONE flash is played
//   • a mode already open when the car pulls away closes itself, with a flash
//   • closeOnMotion unsubscribes cleanly (a closed mode can't be re-closed)
//   • one bad listener can't stop the other listeners getting the flash
//
// driveLock imports from motion.ts (which pulls in react-native), so this runs
// the SHIPPED source with the two motion functions injected as fakes.
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../../src/services/driveLock.ts', import.meta.url), 'utf8');
// Strip the import + TS type annotations; the logic itself is plain JS.
const code = src
  .replace(/^import[\s\S]*?;\s*$/m, '')
  .replace(/export function/g, 'function')
  .replace('new Set<() => void>()', 'new Set()')
  .replace(/\): boolean \{/g, ') {')
  .replace(/\): void \{/g, ') {')
  .replace(/\): \(\) => void \{/g, ') {')
  .replace(/onBlocked: \(\) => void/g, 'onBlocked')
  .replace(/cb: \(\) => void/g, 'cb')
  .replace(/\(m: Motion\)/g, '(m)');

const load = (fakes) => new Function('isMoving', 'subscribeMotion',
  code + '\nreturn { signalDriveBlocked, subscribeDriveBlocked, blockedWhileDriving, closeOnMotion };',
)(fakes.isMoving, fakes.subscribeMotion);

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

// ── stopped: allowed, silent ──────────────────────────────────────────────────
{
  const L = load({ isMoving: () => false, subscribeMotion: () => () => {} });
  let flashes = 0;
  L.subscribeDriveBlocked(() => flashes++);
  check('stopped -> action allowed', L.blockedWhileDriving() === false);
  check('stopped -> no refusal flash', flashes === 0);
}

// ── moving: refused, exactly one flash per attempt ───────────────────────────
{
  const L = load({ isMoving: () => true, subscribeMotion: () => () => {} });
  let flashes = 0;
  L.subscribeDriveBlocked(() => flashes++);
  check('moving -> action refused', L.blockedWhileDriving() === true);
  check('moving -> one flash', flashes === 1);
  L.blockedWhileDriving(); L.blockedWhileDriving();
  check('every attempt flashes (3 attempts)', flashes === 3);
}

// ── pulling away closes an open mode, once, with a flash ─────────────────────
{
  let cb = null;
  const L = load({ isMoving: () => false, subscribeMotion: (fn) => { cb = fn; fn({ speedMph: 0, isMoving: false }); return () => { cb = null; }; } });
  let flashes = 0, closes = 0;
  L.subscribeDriveBlocked(() => flashes++);
  const stop = L.closeOnMotion(() => closes++);
  check('stationary -> mode stays open', closes === 0 && flashes === 0);
  cb({ speedMph: 24, isMoving: true });
  check('pulls away -> mode closed', closes === 1);
  check('pulls away -> flash explains it', flashes === 1);
  stop();
  check('unsubscribed cleanly', cb === null);
}

// ── entering while already moving is caught by the immediate replay ──────────
{
  const L = load({ isMoving: () => true, subscribeMotion: (fn) => { fn({ speedMph: 30, isMoving: true }); return () => {}; } });
  let closes = 0;
  L.closeOnMotion(() => closes++);
  check('already moving -> mode closes at once', closes === 1);
}

// ── a throwing listener must not swallow the others ──────────────────────────
{
  const L = load({ isMoving: () => true, subscribeMotion: () => () => {} });
  let second = 0;
  L.subscribeDriveBlocked(() => { throw new Error('bad listener'); });
  L.subscribeDriveBlocked(() => second++);
  L.signalDriveBlocked();
  check('one bad listener does not block the rest', second === 1);
}

console.log(`\ndriveLock: ${bad ? bad + ' FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
