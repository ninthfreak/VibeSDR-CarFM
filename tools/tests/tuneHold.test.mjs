// Regression test for the commit-to-target hold (CarFmFace `pending`).
//
// The bug this locks down, from the 30 July drive log: every preset step showed
// the target for an instant, then jumped to a station the user never asked for,
// then landed. Six steps, six times.
//
// Cause: onTuneHz (RadioScreen) writes the REQUESTED frequency into
// status.frequency synchronously, before the tuner has moved. The face's hold
// compared its target against that same value — its own echo — so the hold
// released in the very commit that opened it. The log is unambiguous: six
// "settled" lines fired instantly and not one "holding" line ever appeared.
// With the hold gone, the vendor service's own preset walk (it steps ITS list on
// the same wheel press, transiting 98.1, 100.7, 100.9, 101.1, 101.5) painted
// straight onto the hero for about a second per step.
//
// Fix: the hold releases only on a DEVICE report — and only one that arrived
// after the commit, tracked by a sequence number.
//
// As in logoSwap.test.mjs, the two halves differ in strength and it is worth
// being blunt about which is which:
//   * The SOURCE GUARDS are the regression detector — they read the shipped
//     files and fail if the fix is reverted.
//   * The MODEL replays the real log through a hand-written machine. It is
//     executable documentation of intended behaviour; it does not read the
//     component, so it passes on broken source too. The one exception is the
//     OLD-MACHINE case, which encodes the pre-fix rule directly and proves the
//     replay actually discriminates between the two.
import { readFileSync } from 'fs';

const face = readFileSync(new URL('../../src/components/CarFmFace.tsx', import.meta.url), 'utf8');
const screen = readFileSync(new URL('../../src/screens/RadioScreen.tsx', import.meta.url), 'utf8');

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

// ── SOURCE GUARDS: these fail if the fix is reverted ─────────────────────────
check('pending records the device seq at commit time',
  /sinceSeq: deviceSeqRef\.current/.test(face));
check('hold ignores reports older than the commit',
  /device\.seq <= pending\.sinceSeq/.test(face));
check('hold settles on device.mhz, not the optimistic rawMhz',
  /Math\.abs\(device\.mhz - pending\.mhz\) < 0\.05/.test(face));
check('cap is keyed on pending alone so churn cannot extend it',
  /setPending\(null\);\s*\n\s*\}, 2000\);\s*\n\s*return \(\) => clearTimeout\(t\);\s*\n\s*\}, \[pending\]\);/.test(face));
// The optimistic write must NOT masquerade as a device report: exactly one
// definition plus the two genuine device sources (callback + getter poll).
check('device reports come only from the tuner (1 def + 2 call sites)',
  (screen.match(/reportDeviceMhz/g) || []).length === 3
  && !/const onTuneHz[\s\S]{0,900}?reportDeviceMhz/.test(screen));

// ── MODEL: replays the real log; documents intended behaviour ────────────────
const mk = ({ old = false } = {}) => {
  let pending = null, raw = 0, dev = null, seq = 0;
  const settle = () => {
    if (!pending) return;
    // OLD rule: any frequency match releases — including our own optimistic echo.
    if (old) { if (Math.abs(raw - pending.mhz) < 0.05) pending = null; return; }
    if (!dev || dev.seq <= pending.sinceSeq) return;
    if (Math.abs(dev.mhz - pending.mhz) < 0.05) pending = null;
  };
  return {
    shown: () => (pending ? pending.mhz : raw),
    holding: () => pending !== null,
    // stepPreset: commit the face, then ask for the tune — which echoes straight
    // back into status.frequency before the tuner has moved an inch.
    commit: (target) => { pending = { mhz: target, sinceSeq: seq }; raw = target; settle(); },
    // a genuine report from the tuner (NwdRadioFrequency callback or the poll)
    report: (mhz) => {
      if (!dev || Math.abs(dev.mhz - mhz) >= 0.005) dev = { mhz, seq: ++seq };
      raw = mhz;
      settle();
    },
    capExpire: () => { pending = null; },
  };
};

// 1. The exact 21:23:14 step: 101.5 → target 94.9, vendor transits 100.9.
{
  const h = mk();
  h.report(101.5);
  h.commit(94.9);
  check('hold survives the optimistic echo', h.holding());
  h.report(100.9);
  check('transit frequency never reaches the hero', h.shown() === 94.9);
  h.report(94.9);
  check('target lands and the hold releases', h.shown() === 94.9 && !h.holding());
}

// 2. The SAME sequence on the pre-fix rule must fail — proving the replay
//    discriminates rather than passing whatever it is given.
{
  const h = mk({ old: true });
  h.report(101.5);
  h.commit(94.9);
  check('OLD machine released on its own echo', !h.holding());
  h.report(100.9);
  check('OLD machine showed the transit frequency', h.shown() === 100.9);
}

// 3. Full six-step replay of the drive log. Not one transit may ever show.
{
  const STEPS = [
    { target: 88.7,  reports: [98.1, 88.7] },
    { target: 101.5, reports: [100.7, 101.5] },
    { target: 94.9,  reports: [100.9, 94.9] },
    { target: 104.1, reports: [101.1, 104.1] },
    { target: 102.1, reports: [101.5, 102.1] },
    { target: 104.1, reports: [101.1, 104.1] },
    { target: 102.1, reports: [101.5, 102.1] },
  ];
  const h = mk();
  h.report(105.9);
  const seen = [];
  for (const s of STEPS) {
    h.commit(s.target); seen.push(h.shown());
    for (const r of s.reports) { h.report(r); seen.push(h.shown()); }
  }
  const transits = [98.1, 100.7, 100.9, 101.1];
  check('drive-log replay never shows a transit frequency',
    !seen.some((m) => transits.includes(m)));
  check('drive-log replay ends on the last target', h.shown() === 102.1 && !h.holding());
}

// 4. Committing to the station the tuner is ALREADY on still waits for the round
//    trip, because the vendor transits away and back even in that case.
{
  const h = mk();
  h.report(102.1);
  h.commit(102.1);
  check('already-on-target still holds', h.holding());
  h.report(101.5);
  check('holds through the transit', h.shown() === 102.1);
  h.report(102.1);
  check('releases on the return', !h.holding() && h.shown() === 102.1);
}

// 5. A tune the tuner ignores must not freeze the face: the cap frees it.
{
  const h = mk();
  h.report(105.9);
  h.commit(88.1);
  check('holds a target the tuner never reaches', h.holding() && h.shown() === 88.1);
  h.capExpire();
  h.report(105.9);
  check('cap expiry returns the face to reality', !h.holding() && h.shown() === 105.9);
}

console.log(`\ntuneHold: ${bad ? bad + ' FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
