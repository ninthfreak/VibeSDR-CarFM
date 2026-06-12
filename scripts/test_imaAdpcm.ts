/**
 * IMA ADPCM port validation — byte-exact equivalence against BOTH reference
 * implementations (v3 brief §8 phase 0 step 3):
 *   - KiwiSDR web/openwebrx/ima_adpcm.js   (libcsdr/Kientzle flavour)
 *   - openwebrx htdocs/lib/AudioEngine.js  (ImaAdpcmCodec flavour + SYNC)
 * The reference sources are eval'd directly from reference/ so we test against
 * the real upstream code, not a re-typed copy.
 *
 * Run: npx tsx scripts/test_imaAdpcm.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ImaAdpcmDecoder, createKiwiAudioDecoder, decodeKiwiWaterfallFrame,
  decodeOwrxFftFrame, OwrxAudioDecoder,
} from '../src/services/imaAdpcm';

const REF = join(__dirname, '..', 'reference');

// ── Load reference implementations ─────────────────────────────────────────

const kiwiSrc = readFileSync(join(REF, 'KiwiSDR-master/web/openwebrx/ima_adpcm.js'), 'utf8');
const kiwiRef = new Function(`${kiwiSrc};
  return { ImaAdpcmDecode, decode_ima_adpcm_e8_i16, decode_ima_adpcm_e8_u8 };`)();

const owrxSrc = readFileSync(join(REF, 'openwebrx-master/htdocs/lib/AudioEngine.js'), 'utf8');
// AudioEngine.js top level is declarations only; browser APIs are touched
// inside constructors we never call.
const owrxRef = new Function(`${owrxSrc}; return { ImaAdpcmCodec };`)();

// ── Helpers ─────────────────────────────────────────────────────────────────

let seed = 0x1234567;
function rnd(): number { // deterministic LCG so failures reproduce
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed >> 16 & 0xff;
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = rnd();
  return b;
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// ── 1. Kiwi audio (i16, persistent state) ───────────────────────────────────
{
  const ours = createKiwiAudioDecoder();
  const state = { index: 0, previousValue: 0, pos_clamp: 0, neg_clamp: 0 };
  let diffAt = -1;
  for (let frame = 0; frame < 20 && diffAt === -1; frame++) {
    const payload = randomBytes(512);
    const expect: number[] = [];
    const unsq: number[] = [];
    kiwiRef.decode_ima_adpcm_e8_i16(
      new DataView(payload.buffer), expect, unsq, false, payload.length, state);
    const got = ours.decode(payload);
    diffAt = firstDiff(got, Int16Array.from(expect));
  }
  check('Kiwi audio i16 — 20 frames, persistent state', diffAt === -1, diffAt >= 0 ? `first diff @${diffAt}` : '');
}

// ── 2. Kiwi audio with server ADPCM state preset ────────────────────────────
{
  const ours = createKiwiAudioDecoder();
  ours.setState(37, -1234); // MSG audio_adpcm_state=37,-1234
  const state = { index: 37, previousValue: -1234, pos_clamp: 0, neg_clamp: 0 };
  const payload = randomBytes(256);
  const expect: number[] = []; const unsq: number[] = [];
  kiwiRef.decode_ima_adpcm_e8_i16(new DataView(payload.buffer), expect, unsq, false, payload.length, state);
  const d = firstDiff(ours.decode(payload), Int16Array.from(expect));
  check('Kiwi audio — audio_adpcm_state preset', d === -1, d >= 0 ? `first diff @${d}` : '');
}

// ── 3. Kiwi waterfall (u8 clamp, reset per frame, drop last 10) ─────────────
{
  let ok = true; let detail = '';
  for (let frame = 0; frame < 10 && ok; frame++) {
    const payload = randomBytes(517); // 1024 bins + 10 tail = 1034 samples
    const expect: number[] = [];
    kiwiRef.decode_ima_adpcm_e8_u8(payload, expect, payload.length, { index: 0, previousValue: 0 });
    const expectBins = expect.slice(0, expect.length - 10);
    const got = decodeKiwiWaterfallFrame(payload);
    const d = firstDiff(got, expectBins);
    if (d !== -1) { ok = false; detail = `frame ${frame} diff @${d}`; }
  }
  check('Kiwi waterfall u8 — fresh state, tail-10 dropped', ok, detail);
}

// ── 4. OWRX FFT (reset per frame, skip first 10, /100) ──────────────────────
{
  let ok = true; let detail = '';
  for (let frame = 0; frame < 10 && ok; frame++) {
    const payload = randomBytes(261);
    const codec = new owrxRef.ImaAdpcmCodec();
    const raw: Int16Array = codec.decode(payload);
    const expect = Array.from(raw.slice(10), (v: number) => v / 100);
    const got = decodeOwrxFftFrame(payload);
    const d = firstDiff(got, Float32Array.from(expect));
    if (d !== -1) { ok = false; detail = `frame ${frame} diff @${d}`; }
  }
  check('OWRX FFT — fresh state, pad-10 skipped, dB scale', ok, detail);
}

// ── 5. OWRX continuous audio flavour (no sync) ──────────────────────────────
{
  const ours = new ImaAdpcmDecoder('owrx');
  const codec = new owrxRef.ImaAdpcmCodec();
  let diffAt = -1;
  for (let frame = 0; frame < 20 && diffAt === -1; frame++) {
    const payload = randomBytes(512);
    diffAt = firstDiff(ours.decode(payload), codec.decode(payload));
  }
  check('OWRX audio — persistent state across frames', diffAt === -1, diffAt >= 0 ? `first diff @${diffAt}` : '');
}

// ── 6. OWRX decodeWithSync framing ──────────────────────────────────────────
{
  // Synthetic stream: garbage, then SYNC + state + payload, repeated.
  const parts: number[] = [];
  parts.push(...randomBytes(17)); // pre-sync garbage the hunter must skip
  for (let block = 0; block < 3; block++) {
    parts.push(0x53, 0x59, 0x4e, 0x43); // "SYNC"
    const st = new Int16Array([5 + block * 7, (block - 1) * 333]);
    parts.push(...new Uint8Array(st.buffer));
    parts.push(...randomBytes(1001)); // counter reaches 0 then next hunt
  }
  const stream = Uint8Array.from(parts);

  const ref = new owrxRef.ImaAdpcmCodec();
  const expect: Int16Array = ref.decodeWithSync(stream);
  const ours = new OwrxAudioDecoder();
  const got = ours.decode(stream);
  const d = firstDiff(got, expect);
  check('OWRX decodeWithSync — hunt/state/payload phases', d === -1,
        d === -2 ? `len ${got.length} vs ${expect.length}` : d >= 0 ? `first diff @${d}` : '');

  // Split the same stream at awkward boundaries — state must carry across calls
  const ref2 = new owrxRef.ImaAdpcmCodec();
  const expect2: Int16Array = ref2.decodeWithSync(stream);
  const ours2 = new OwrxAudioDecoder();
  const out2: number[] = [];
  for (let off = 0; off < stream.length; ) {
    const n = Math.min(1 + (rnd() % 97), stream.length - off);
    out2.push(...ours2.decode(stream.subarray(off, off + n)));
    off += n;
  }
  const d2 = firstDiff(Int16Array.from(out2), expect2);
  check('OWRX decodeWithSync — split across packet boundaries', d2 === -1,
        d2 === -2 ? `len ${out2.length} vs ${expect2.length}` : d2 >= 0 ? `first diff @${d2}` : '');
}

console.log(failures === 0 ? '\nAll IMA ADPCM ports byte-exact against upstream references.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
