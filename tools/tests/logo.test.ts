// node --no-warnings tools/tests/logo.test.ts
// Pure-helper tests for the layered logo sources (network calls not exercised).
import { buildSparql, parseSparqlLogo } from '../../src/services/logoWikidata.ts';
import { pickIconUrl } from '../../src/services/logoSiteFavicon.ts';
import { fmFrequencyField, gccFromPiEcc, buildFmFqdn, parseSpiLogo } from '../../src/services/logoRadioDns.ts';

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

// RadioDNS construction (format VERIFY-marked; test the mechanics)
eq('freq field 95.8MHz -> 09580', fmFrequencyField(95_800_000), '09580');
eq('freq field 100.3MHz -> 10030', fmFrequencyField(100_300_000), '10030');
eq('gcc from pi/ecc', gccFromPiEcc('C586', 0xE1), 'ce1');
eq('fm fqdn shape', buildFmFqdn('C586', 95_800_000, 'ce1'), '09580.c586.ce1.fm.radiodns.org');
eq('spi logo picks largest',
  parseSpiLogo('<multimedia url="s.png" width="32" height="32"/><multimedia url="big.png" width="320" height="240"/>'),
  'big.png');
eq('spi no logo', parseSpiLogo('<programme>nothing</programme>'), null);

console.log(fail === 0 ? '\nLOGO: ALL PASS' : `\nLOGO: ${fail} FAILURES`);
if (fail) process.exit(1);
