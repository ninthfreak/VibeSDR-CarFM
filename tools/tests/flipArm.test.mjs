// Regression test for the hero-swap FLIP arming (CarFmFace `flip` / `flipArmed`).
//
// The bug, caught by frame-stepping the 31 July video rather than from a log:
// on a NEXT press the LEFT peek card grew into the centre and the old hero shrank
// to the RIGHT. That is the PREV motion. Partway through, the content snapped to
// the correct arrangement — which is what "a card slides in and then becomes a
// different station" looks like.
//
// The transforms were never wrong. A FLIP places every card at its PRE-swap
// geometry at progress 0 and morphs it to its resting geometry, so it is only
// meaningful once the slots already hold the POST-swap content. The morph is
// native-driven and starts on the UI thread the moment .start() is called, while
// the new card content was still being mounted — so it played out on the old
// cards.
//
// Reconstruction from the video, first transition (t=1.5s), a NEXT press with
// hero 105.9, left peek 102.1, right peek WPR. Every element on screen is
// accounted for by "transforms new, content old":
//   left slot   = landing, held the STALE prev (102.1), starting at hero size
//                 -> a large 102.1 sweeping left      [seen]
//   centre slot = held the STALE hero (105.9), starting at the right peek
//                 -> a small 105.9 at the right, growing  [seen]
//   clone       = the leaving far card (102.1) fading at the left peek
//                 -> the small chip at the far left   [seen]
// Under "transforms and content both new" the left slot would have shown 105.9
// sweeping left, which is NOT what the video shows.
//
// Halves of differing strength, as in the sibling tests:
//   * SOURCE GUARDS read CarFmFace.tsx and fail if the arming is removed.
//   * The MODEL encodes what each slot displays for a given (dir, content) pair
//     and asserts that the stale pairing reproduces the video while the armed
//     pairing does not. It does not execute React.
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../../src/components/CarFmFace.tsx', import.meta.url), 'utf8');

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

// ── SOURCE GUARDS ────────────────────────────────────────────────────────────
check('the descriptor carries the target it is morphing toward',
  /targetMhz: number/.test(src) && /cloneRect: landing, cloneName, targetMhz/.test(src));
check('the morph is armed separately from the descriptor',
  /const \[flipArmed, setFlipArmed\] = useState\(false\)/.test(src)
  && /setFlipArmed\(false\);\s*\n\s*setFlip\(\{/.test(src));
check('arming waits for the dial to reach the target',
  /if \(Math\.abs\(mhz - flip\.targetMhz\) < 0\.05\)/.test(src));
check('arming also yields one frame for the native mount',
  /requestAnimationFrame\(\(\) => setFlipArmed\(true\)\)/.test(src));
check('the animation refuses to run unarmed',
  /if \(!flip \|\| !flipArmed\) return;/.test(src));
// The guard above passed on a build where the morph never ran at all: the effect
// READ flipArmed but did not DEPEND on it, so it fired once (unarmed, early
// return) and never again. Descriptor set, progress stuck at 0, cards frozen in
// pre-swap positions. Testing that the guard exists is not testing that the
// effect observes it.
check('the animation effect re-runs when arming flips',
  /\}, \[flip, flipArmed, flipProg\]\);/.test(src));
check('a target that never arrives drops the flip instead of freezing it',
  /FLIP dropped/.test(src) && /setFlip\(null\);\s*\n\s*\}, 400\);/.test(src));
check('the target is computed before the descriptor is built',
  src.indexOf('const n = ((i + dir)') < src.indexOf('startFlip(dir, items[n].frequencyMhz)'));

// ── MODEL ────────────────────────────────────────────────────────────────────
// Presets as they were in the video, and the slot each card occupies.
const ITEMS = ['105.9', 'WPR', '101.5', '94.9', 'Z104', '102.1'];
const at = (i) => ITEMS[((i % ITEMS.length) + ITEMS.length) % ITEMS.length];

// What the three slots display, given the index the CONTENT currently reflects.
const slots = (idx) => ({ left: at(idx - 1), centre: at(idx), right: at(idx + 1) });

// Where each slot STARTS its morph, given the direction. This is the FLIP: the
// centre comes from the source peek, the old hero lands on the far side.
const startsAt = (dir) => ({
  centre: dir > 0 ? 'right-peek' : 'left-peek',   // source
  landing: dir > 0 ? 'left' : 'right',            // far side
});

// The video, replayed. Hero 105.9 (index 0), NEXT pressed.
const FROM = 0, DIR = 1, TARGET = 1;
const geo = startsAt(DIR);

// STALE pairing: transforms for the new step, content still on the old index.
{
  const c = slots(FROM);
  check('stale: a large 102.1 sweeps toward the landing side',
    c.left === '102.1' && geo.landing === 'left');
  check('stale: a small 105.9 sits at the right, growing',
    c.centre === '105.9' && geo.centre === 'right-peek');
  check('stale: the fading clone is 102.1', c.left === '102.1');
}

// ARMED pairing: content has caught up before the morph runs.
{
  const c = slots(TARGET);
  check('armed: the card sweeping to the landing side is 105.9', c.left === '105.9');
  check('armed: the card growing from the right peek is WPR', c.centre === 'WPR');
  check('armed: the old hero lands on the correct side', geo.landing === 'left');
  // The distinguishing observation: under the armed pairing the left slot can
  // never show 102.1, which is exactly what the video does show.
  check('armed pairing cannot reproduce the video', c.left !== '102.1');
}

// A PREV press is the mirror image, and must not be confusable with the above.
{
  const geoPrev = startsAt(-1);
  check('prev sources the centre from the left peek', geoPrev.centre === 'left-peek');
  check('prev lands the old hero on the right', geoPrev.landing === 'right');
  check('prev and next are genuine mirrors',
    geoPrev.centre !== geo.centre && geoPrev.landing !== geo.landing);
}

console.log(`\nflipArm: ${bad ? bad + ' FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
