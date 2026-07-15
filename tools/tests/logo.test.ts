// node --no-warnings tools/tests/logo.test.ts
// Pure-helper tests for the layered logo sources (network calls not exercised).
import { buildSparql, parseSparqlLogo } from '../../src/services/logoWikidata.ts';
import { pickIconUrl } from '../../src/services/logoSiteFavicon.ts';
import { base64ToBytes, bytesToBase64 } from '../../src/services/base64.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

// Wikidata (decode the URL-encoded query before matching)
eq('sparql contains callsign + P2317/P154',
  /P2317 "WABC"/.test(decodeURIComponent(buildSparql('WABC-FM'))) && /P154/.test(decodeURIComponent(buildSparql('WABC'))),
  true);
eq('parse sparql logo', parseSparqlLogo({ results: { bindings: [{ logo: { value: 'https://commons/x.svg' } }] } }), 'https://commons/x.svg');
eq('parse sparql empty', parseSparqlLogo({ results: { bindings: [] } }), null);

// Site favicon precedence: apple-touch-icon > og:image > icon > /favicon.ico
eq('apple-touch-icon wins, made absolute',
  pickIconUrl('<link rel="icon" href="/i.png"><link rel="apple-touch-icon" href="/a.png">', 'https://k.example/x'),
  'https://k.example/a.png');
eq('og:image when no apple icon',
  pickIconUrl('<meta property="og:image" content="https://cdn/o.jpg">', 'https://k.example'),
  'https://cdn/o.jpg');
eq('falls back to /favicon.ico', pickIconUrl('<html>no icons</html>', 'https://k.example/deep/page'), 'https://k.example/favicon.ico');

// base64 round-trip (native shares images as base64 → bytes for the blob store)
for (const len of [0, 1, 2, 3, 4, 5, 255, 1000]) {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 255;
  const back = base64ToBytes(bytesToBase64(bytes));
  eq(`base64 round-trip len=${len}`, Array.from(back), Array.from(bytes));
}
// decode tolerates padded input (native uses NO_WRAP with '=')
eq('base64 decodes "TWFu" -> Man', Array.from(base64ToBytes('TWFu')), [77, 97, 110]);

console.log(fail === 0 ? '\nLOGO: ALL PASS' : `\nLOGO: ${fail} FAILURES`);
if (fail) process.exit(1);
