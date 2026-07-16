// Runnable with: node tools/tests/nowPlaying.test.ts   (Node >= 22 strips types)
// Verifies the FM MediaSession mapping — the app's contract with Gadgetbridge →
// ESP32 (RT→TITLE, PS→ARTIST, freq→ALBUM), including the RT+ title upgrade.
import { fmNowPlaying, formatFmFreq } from '../../src/services/nowPlaying.ts';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok   ' : 'FAIL ') + name +
    (ok ? '' : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
  if (!ok) fail++;
};

eq('freq format', formatFmFreq(94_100_000), '94.1 MHz');

// Plain RT (no RT+): the whole line goes to TITLE, PS to ARTIST — the original contract.
eq('plain RT', fmNowPlaying({ ps: 'WJJO', rt: 'Now Playing: Metallica - Enter Sandman!', freqHz: 94_100_000 }),
  { title: 'Now Playing: Metallica - Enter Sandman!', artist: 'WJJO', album: '94.1 MHz' });

// RT+ present: TITLE becomes the clean "Artist – Title"; ARTIST slot STAYS the PS
// (the ESP32 reads slots positionally — RT+ must never displace the station name).
eq('RT+ composes title, keeps PS in artist',
  fmNowPlaying({ ps: 'WJJO', rt: 'Now Playing: Metallica - Enter Sandman!',
                 rtArtist: 'Metallica', rtTitle: 'Enter Sandman', freqHz: 94_100_000 }),
  { title: 'Metallica – Enter Sandman', artist: 'WJJO', album: '94.1 MHz' });

// RT+ with only one tag still improves the title; empty tags fall back to raw RT.
eq('RT+ title only', fmNowPlaying({ ps: 'WJJO', rt: 'x', rtTitle: 'Enter Sandman', freqHz: 94_100_000 }).title,
  'Enter Sandman');
eq('RT+ cleared falls back to RT', fmNowPlaying({ ps: 'WJJO', rt: 'slogan', rtArtist: '', rtTitle: '', freqHz: 94_100_000 }).title,
  'slogan');

// Pre-RDS fallbacks unchanged: never a blank card.
eq('no RDS yet', fmNowPlaying({ freqHz: 101_100_000 }),
  { title: '101.1 MHz', artist: 'FM 101.1 MHz', album: '101.1 MHz' });

console.log(fail ? `\nNOWPLAYING: ${fail} FAILURE(S)` : '\nNOWPLAYING: ALL PASS');
process.exit(fail ? 1 : 0);
