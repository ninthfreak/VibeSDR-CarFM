/**
 * test-web-client.mjs — protocol regression test for the VibeSDR web client.
 *
 *   node scripts/mock-vibeserver.mjs &     # PIN 123456
 *   node scripts/test-web-client.mjs
 *
 * Drives the mock VibeServer using the web client's OWN auth + decode code, so
 * a break in the wire format fails here rather than on the bench. Covers the
 * things that actually went wrong during VibeServer bring-up:
 *   - the '?' vs '&' auth-suffix rule (a malformed /ws/audio query = 401 = the
 *     single bug that killed BOTH audio and waterfall-follow last time)
 *   - SPEC bins arriving in FFT order (must be rotated to draw left→right)
 *   - the u8 -> dBFS scaling (dB = u8 - 256)
 *   - ADPCM audio decode
 *   - zoom -> config echo
 */

import { build } from 'esbuild';
import assert from 'node:assert';

const res = await build({
  stdin: {
    contents: `
      export { resolveAuth, withAuth } from './web/client/src/auth';
      export { decodeVibeAdpcmFrame } from './src/services/imaAdpcm';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
});
const { resolveAuth, withAuth, decodeVibeAdpcmFrame } =
  await import('data:text/javascript;base64,' + Buffer.from(res.outputFiles[0].text).toString('base64'));

const HOST = process.argv[2] || 'localhost:48000';
const PIN = process.argv[3] || '123456';
let pass = 0;
const ok = (m) => { console.log('  ✓ ' + m); pass++; };

// ── 1. Auth handshake ────────────────────────────────────────────────────────
const auth = await resolveAuth(`http://${HOST}`, PIN);
assert.ok(auth.required, 'server demands a PIN');
assert.match(auth.query, /^vs_nonce=[0-9a-f]{32}&vs_auth=[0-9a-f]{64}$/, 'auth query shape');
ok('auth: nonce fetched, HMAC-SHA256 token computed');

// ── 2. The '?' vs '&' rule ───────────────────────────────────────────────────
const specPath  = withAuth('/ws/user-spectrum?user_session_id=abc&mode=binary8', auth);
const audioPath = withAuth('/ws/audio', auth);
assert.ok(specPath.includes('&vs_nonce='), 'spectrum path already had a query -> &');
assert.ok(audioPath.includes('?vs_nonce='), 'audio path had NO query -> must use ?');
assert.ok(!audioPath.includes('/ws/audio&'), 'audio path must NOT be /ws/audio&vs_nonce');
ok("auth suffix uses '?' on /ws/audio and '&' on /ws/user-spectrum");

// ── 3. Spectrum: config, hwinfo, SPEC frames ─────────────────────────────────
const specWs = new WebSocket(`ws://${HOST}${specPath}`);
specWs.binaryType = 'arraybuffer';
const seen = { config: null, hwinfo: null, frames: 0, lastCenter: 0, lastFrame: null };
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('spectrum: timed out')), 6000);
  specWs.onerror = () => reject(new Error('spectrum: WS error (401?)'));
  specWs.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'config') seen.config = m;
      if (m.type === 'hwinfo') seen.hwinfo = m;
    } else {
      const dv = new DataView(e.data);
      if (dv.getUint32(0, true) === 0x43455053) {
        seen.frames++;
        seen.lastCenter = Number(dv.getBigUint64(14, true));
        seen.lastFrame = e.data;
      }
    }
    if (seen.config && seen.hwinfo && seen.frames >= 5) { clearTimeout(t); resolve(); }
  };
});
assert.strictEqual(seen.config.binCount, 4096, 'config binCount');
ok(`spectrum: config (${(seen.config.totalBandwidth / 1e6).toFixed(2)} MHz span, ${seen.config.binCount} bins)`);
assert.ok(seen.hwinfo.gains.length > 10 && seen.hwinfo.rates.length >= 1, 'hwinfo lists');
ok(`hwinfo: ${seen.hwinfo.gains.length} gains, ${seen.hwinfo.rates.length} sample rates`);
ok(`SPEC frames streaming (${seen.frames} received, centre ${(seen.lastCenter / 1e6).toFixed(1)} MHz)`);

// Decode a frame the way the client does, and check the carrier lands correctly.
{
  const buf = seen.lastFrame;
  const n = buf.byteLength - 22;
  const u8 = new Uint8Array(buf, 22, n);
  const half = n >> 1;
  const bins = new Float32Array(n);
  for (let i = 0; i < n; i++) bins[i] = u8[(i + half) % n] - 256;   // fftshift + dBFS

  const span = seen.config.totalBandwidth;
  const lo = seen.lastCenter - span / 2;
  const idxOf = (hz) => Math.max(0, Math.min(n - 1, Math.round(((hz - lo) / span) * n)));

  // Mock band: carriers at 99.3 / 100.0 / 100.7 / 101.5 MHz. 100.35 sits in a gap.
  const carrier = bins[idxOf(100_000_000)];
  const floor = bins[idxOf(100_350_000)];
  assert.ok(carrier > floor + 20,
    `carrier ${carrier.toFixed(0)} dBFS should tower over floor ${floor.toFixed(0)} dBFS`);
  ok(`frame decodes: carrier ${carrier.toFixed(0)} dBFS vs floor ${floor.toFixed(0)} dBFS, at the right bin`);

  // The peak of the whole frame must be at one of the carriers, not at DC —
  // which is exactly what a missing fftshift would produce.
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (bins[i] > bins[peakIdx]) peakIdx = i;
  const peakHz = lo + (peakIdx / n) * span;
  const nearestCarrier = [99.3e6, 100e6, 100.7e6, 101.5e6]
    .reduce((a, c) => Math.abs(c - peakHz) < Math.abs(a - peakHz) ? c : a);
  assert.ok(Math.abs(peakHz - nearestCarrier) < 200_000,
    `peak at ${(peakHz / 1e6).toFixed(2)} MHz is not on a carrier — fftshift wrong?`);
  ok(`fftshift correct: frame peak at ${(peakHz / 1e6).toFixed(2)} MHz sits on a real carrier`);
}

// ── 4. Zoom -> config echo ───────────────────────────────────────────────────
const beforeBb = seen.config.binBandwidth;
const zoomed = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('zoom: no config echo')), 4000);
  specWs.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data);
    if (m.type === 'config') { clearTimeout(t); resolve(m); }
  };
  specWs.send(JSON.stringify({ type: 'zoom', frequency: 100_700_000, binBandwidth: beforeBb / 4 }));
});
assert.ok(Math.abs(zoomed.binBandwidth - beforeBb / 4) < 1e-6, 'binBandwidth quartered');
assert.strictEqual(zoomed.centerFreq, 100_700_000, 'view recentred');
ok(`zoom: span ${(beforeBb * 4096 / 1e6).toFixed(2)} -> ${(zoomed.totalBandwidth / 1e6).toFixed(2)} MHz, centre followed`);

// ── 5. Audio: ADPCM decode ───────────────────────────────────────────────────
const audioWs = new WebSocket(`ws://${HOST}${audioPath}`);
audioWs.binaryType = 'arraybuffer';
const audio = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('audio: timed out (401 on /ws/audio?)')), 6000);
  audioWs.onerror = () => reject(new Error('audio: WS error — 401?'));
  let frames = 0, peak = 0, rate = 0, ch = 0;
  audioWs.onmessage = (e) => {
    const d = decodeVibeAdpcmFrame(e.data);
    rate = d.rate; ch = d.channels;
    for (const s of d.pcm) peak = Math.max(peak, Math.abs(s));
    if (++frames >= 20) { clearTimeout(t); resolve({ frames, peak, rate, ch }); }
  };
});
assert.strictEqual(audio.rate, 48000, 'audio rate 48k');
assert.ok(audio.peak > 1000, `audio should carry signal, peak was ${audio.peak}`);
ok(`audio: ${audio.frames} ADPCM frames decoded, ${audio.rate} Hz, ${audio.ch}ch, peak ${audio.peak}`);

// ── 6. Audio-DSP controls reach the server ───────────────────────────────────
// These are the ones that needed a shim change: the engines existed but were
// only reachable via JNI, so no remote client could touch them.
specWs.send(JSON.stringify({ type: 'squelch', db: -60 }));
specWs.send(JSON.stringify({ type: 'nr', on: true, strength: 0.5 }));
specWs.send(JSON.stringify({ type: 'notch', on: true }));
specWs.send(JSON.stringify({ type: 'deemph', tau: 50e-6 }));
specWs.send(JSON.stringify({ type: 'stereo', on: false }));
specWs.send(JSON.stringify({ type: 'gain', value: 297 }));
await new Promise((r) => setTimeout(r, 300));

const ctl = await (await fetch(`http://${HOST}/debug/controls`)).json();
assert.strictEqual(ctl.squelch?.db, -60, 'squelch db');
assert.strictEqual(ctl.nr?.on, true, 'nr on');
assert.strictEqual(ctl.nr?.strength, 0.5, 'nr strength');
assert.strictEqual(ctl.notch?.on, true, 'notch on');
assert.ok(Math.abs(ctl.deemph?.tau - 50e-6) < 1e-9, 'deemph tau in seconds');
assert.strictEqual(ctl.stereo?.on, false, 'stereo off');
assert.strictEqual(ctl.gain?.value, 297, 'gain in tenths of dB');
ok('audio-DSP + hardware controls reach the server (squelch, nr, notch, deemph, stereo, gain)');

// ── 7. Wrong PIN must be rejected ────────────────────────────────────────────
const bad = await resolveAuth(`http://${HOST}`, '000000');
const rejected = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://${HOST}${withAuth('/ws/audio', bad)}`);
  ws.onopen = () => { ws.close(); resolve(false); };
  ws.onerror = () => resolve(true);
});
assert.ok(rejected, 'a wrong PIN must NOT get a socket');
ok('wrong PIN is rejected (401), correct PIN is not');

specWs.close();
audioWs.close();
console.log(`\n${pass}/${pass} passed`);
process.exit(0);
