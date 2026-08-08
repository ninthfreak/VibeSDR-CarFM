// The URL schemes this app accepts must match the ones it registers.
//
// This exists because they drifted apart and nobody noticed. The fork's rename
// left the runtime guard in useDeepLinks.ts testing `vibesdr|sdr` while
// AndroidManifest.xml and app.json registered `carfm|sdr`, so every carfm://
// intent was dropped one line short of the parser written to handle it, and
// `vibesdr://` — registered nowhere — could never arrive at all. Nothing failed;
// the feature was simply dead. A static cross-check is the cheapest guard
// against that shape of bug, because there is no way to deliver an Android
// intent in this test environment.
//
// Run: node tools/tests/deepLinkSchemes.test.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`ok   ${name} → ${g}`);
  else { console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`); fails++; }
};

// ── what the app REGISTERS ───────────────────────────────────────────────────
const appJson = JSON.parse(readFileSync(join(repo, 'app.json'), 'utf8'));
const declared = [...appJson.expo.scheme].sort();

const manifest = readFileSync(
  join(repo, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const manifestSchemes = [...manifest.matchAll(/<data android:scheme="([^"]+)"\/>/g)]
  .map((m) => m[1])
  .filter((s) => s !== 'https')   // the App Links host filter, not a custom scheme
  .sort();

// ── what the app ACCEPTS at runtime ──────────────────────────────────────────
const hook = readFileSync(join(repo, 'src/linking/useDeepLinks.ts'), 'utf8');
const guard = /\/\^\(([a-z|]+)\):\\\/\\\/\/i/.exec(hook);
if (!guard) {
  console.log('FAIL could not find the scheme guard regex in useDeepLinks.ts');
  process.exit(1);
}
const accepted = guard[1].split('|').sort();

eq('app.json and AndroidManifest register the same schemes', declared, manifestSchemes);
eq('useDeepLinks accepts exactly the registered schemes', accepted, declared);

// ── and the parser each scheme routes to must recognise it ───────────────────
// DeepLinkHandler owns carfm://, SdrLinkHandler owns sdr://; both are asserted
// by source, since DeepLinkHandler pulls in the instances API and cannot be
// imported here.
const deep = readFileSync(join(repo, 'src/linking/DeepLinkHandler.ts'), 'utf8');
const sdr = readFileSync(join(repo, 'src/linking/SdrLinkHandler.ts'), 'utf8');
eq('DeepLinkHandler parses the carfm scheme', /\^carfm:\\\/\\\//.test(deep), true);
eq('SdrLinkHandler parses the sdr scheme', /\^sdr:\\\/\\\//.test(sdr), true);
// Matched against the parse patterns only, not against prose: the guard's own
// comment names the retired scheme on purpose, to explain what went wrong.
eq('no handler still parses the pre-fork vibesdr scheme',
  /vibesdr:\\\/\\\//.test(deep) || /vibesdr:\\\/\\\//.test(sdr), false);

console.log(fails === 0 ? '\ndeepLinkSchemes: ALL PASS' : `\ndeepLinkSchemes: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
