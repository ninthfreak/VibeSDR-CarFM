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
//   * The SOURCE GUARD checks below are the actual regression detector. Run
//     against the pre-fix LogoTile.tsx all four fail; against the fixed file all
//     four pass. Those are what will catch a revert.
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
check('base+uri stored as ONE state object',
  /setResolved\b/.test(src) && !/\bsetUri\s*\(/.test(src));
check('light: late resolve guarded by base identity',
  /prev\.base === base \? \{ base, uri: u \} : prev/.test(src));
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

console.log(`\nlogoSwap: ${bad ? bad + ' FAILED' : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
