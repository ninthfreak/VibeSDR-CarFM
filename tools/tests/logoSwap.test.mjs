// Regression test for the hero logo swap (LogoTile.useStationLogo / useDarkLogo).
//
// The bug this locks down, reported from the car on 30 July: stepping presets
// with the steering wheel made logos "swap around erratically" — the outgoing
// station's logo showing under the incoming station, flipping back and forth,
// and sometimes a THIRD station's logo appearing (one the vendor service merely
// transited while stepping its own preset list).
//
// Cause: `base` and `uri` were separate useState. `base` updated when
// callsignForFreq resolved; `uri` kept the previous station's image until
// getStationLogo came back. And a superseded async resolve could land late and
// repaint a station the dial had already left.
//
// There is no React runtime here, so this file has two halves with very
// different strength, and it is worth being blunt about which is which:
//   * The SOURCE GUARD checks below are the actual regression detector — they
//     read the shipped files and fail if the fix is reverted. Those are what will
//     catch a revert.
//   * The MODEL cases are hand-written from the fixed machine, so they pass on
//     broken source too. They are executable documentation of the intended
//     semantics — they pin down what "correct" means so a future rewrite has a
//     target — not coverage of the component.
// If the hooks are ever restructured, update the guard patterns; do not delete
// them, or this file silently stops testing anything.
import { readFileSync } from 'fs';

const src = readFileSync(new URL('../../src/components/carfm/LogoTile.tsx', import.meta.url), 'utf8');

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

// ── SOURCE GUARDS: these fail on the pre-fix file ────────────────────────────
check('light: identity is derived during render, not adopted in an effect',
  /const base = syncBase \?\? \(lateBase\.freq === \(freqMhz \?\? null\) \? lateBase\.base : null\)/.test(src)
  && !/\badopt\s*\(/.test(src));
check('light: uri is derived from base, so the two can never disagree',
  /const key = base \? ck\(base\) : null/.test(src)
  && /cache\.has\(key\) \? cache\.get\(key\)! : \(lateUri\?\.key === key \? lateUri\.uri : null\)/.test(src));
check('light: awaited values are tagged with the input they answer',
  /setLateBase\(\{ freq: f, base: b \}\)/.test(src) && /setLateUri\(\{ key, uri: u \}\)/.test(src));
check('light: the callsign is read synchronously when the map is loaded',
  /callsignForFreqSync\(freqMhz\)/.test(src));
check('prefs are read synchronously so the size tier is picked once',
  /getStationPrefsSync\(base\)/.test(src));
check('the hero size (no boxDp -> key |0) is warmed',
  /const sizes: Array<number \| undefined> = \[undefined, 128, 192\]/.test(src));
check('dark: value stored with its key',
  /setSt\b/.test(src) && /st\.key === key \? st\.val/.test(src));
check('dark: late resolve guarded by key identity',
  /prev\.key === key \|\| prev\.key === null/.test(src));

// ── MODEL: documents intended semantics; passes on broken source too ─────────
const cache = new Map();
const mk = () => {
  let s = { base: null, uri: null };
  return {
    get: () => s,
    // adopt(): one write; uri comes from the warm cache or starts null
    adopt: (b) => { if (s.base !== b) s = { base: b, uri: b && cache.has(b) ? cache.get(b) : null }; },
    // a resolve landing for `forBase` — only paints if still current
    land: (forBase, uri) => { cache.set(forBase, uri); if (s.base === forBase) s = { base: forBase, uri }; },
  };
};

// 1. A→B swap must never render B's identity with A's logo.
{
  cache.clear(); cache.set('WERN', 'wern.png');
  const h = mk();
  h.adopt('WERN'); h.land('WERN', 'wern.png');
  h.adopt('WIBA');                       // cold: no cached logo yet
  const s = h.get();
  check('swap A→B never shows A logo under B', !(s.base === 'WIBA' && s.uri === 'wern.png'));
  check('swap A→B shows B with no logo until it loads', s.base === 'WIBA' && s.uri === null);
}

// 2. A late resolve for a TRANSITED station must not repaint.
{
  cache.clear();
  const h = mk();
  h.adopt('WERN');                       // dial passes through WERN
  h.adopt('WIBA');                       // ...and moves on before WERN resolved
  h.land('WERN', 'wern.png');            // WERN's lookup lands late
  const s = h.get();
  check('late resolve for a transited station is dropped', s.base === 'WIBA' && s.uri === null);
}

// 3. A warm-cached swap is seamless — logo present on the very first frame.
{
  cache.clear(); cache.set('WIBA', 'wiba.png');
  const h = mk();
  h.adopt('WERN');
  h.adopt('WIBA');
  check('warm-cached swap is seamless', h.get().uri === 'wiba.png');
}

// 4. Rapid stepping A→B→C→B settles on the LAST station, not a stale one.
{
  cache.clear();
  const h = mk();
  h.adopt('A'); h.adopt('B'); h.adopt('C'); h.adopt('B');
  h.land('A', 'a.png'); h.land('C', 'c.png');   // both late, both superseded
  h.land('B', 'b.png');
  const s = h.get();
  check('rapid stepping settles on the last station', s.base === 'B' && s.uri === 'b.png');
}

// ── The hero SIZE TIER through a swap ────────────────────────────────────────
// Reported 31 July: "it flickers between a couple different sizes ... overshooting
// the size ... back and forth sizing". The hero's logo height is picked from how
// many of (call sign, frequency) are hidden, and BOTH inputs used to settle
// asynchronously and separately, so the tier was chosen up to three times per
// swap. Wide track: 0 hidden = 144, 1 = 205, 2 = 256.
const TIER = (showCall, showFreq) => {
  const hidden = (showCall ? 0 : 1) + (showFreq ? 0 : 1);
  return hidden === 0 ? 144 : hidden === 1 ? 205 : 256;
};
const dflt = (hasLogo) => (hasLogo ? { showCall: false, showFreq: false } : { showCall: true, showFreq: true });

// The station in the video: a logo, and an explicit pref to show the call sign.
const STORED = { showCall: true, showFreq: false };

// OLD: identity, logo and prefs each land on their own tick.
{
  const seen = [];
  let p = dflt(false); seen.push(TIER(p.showCall, p.showFreq));   // no base, no logo yet
  p = dflt(true);      seen.push(TIER(p.showCall, p.showFreq));   // logo arrives
  p = STORED;          seen.push(TIER(p.showCall, p.showFreq));   // SQLite answers
  check('OLD machine walked three tiers in one swap', new Set(seen).size === 3);
  check('OLD machine overshot, then came back down',
    seen[1] > seen[2] && seen[2] > seen[0]);
}

// NEW: warm logo cache + prefs memo, so everything is known on the first frame.
{
  const warmLogo = true, memo = STORED;
  const p = memo ?? dflt(warmLogo);
  const seen = [TIER(p.showCall, p.showFreq)];
  check('warm swap picks exactly one tier', new Set(seen).size === 1);
  check('warm swap never overshoots', seen[0] === 205);
}

// A station with NO stored pref must still settle in one step, on the default.
{
  const warmLogo = true, memo = null;   // null = known to have no explicit choice
  const p = memo ?? dflt(warmLogo);
  check('unset prefs still settle in one step', TIER(p.showCall, p.showFreq) === 256);
}

console.log(`\nlogoSwap: ${bad ? bad + ' FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
