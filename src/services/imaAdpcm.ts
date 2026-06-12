/**
 * Shared IMA ADPCM decoder (v3 brief §3 — the keystone simplification).
 * One 4-bit IMA core serves four streams, but the reference implementations
 * are NOT byte-identical, so this port keeps both flavours exact:
 *
 *  - 'kiwi' (libcsdr/Kientzle, KiwiSDR web/openwebrx/ima_adpcm.js):
 *    step is sampled from the CURRENT index before decoding a nibble; the
 *    index adjusts afterwards. First nibble after reset uses step=7.
 *  - 'owrx' (openwebrx htdocs/lib/AudioEngine.js ImaAdpcmCodec):
 *    index adjusts FIRST, the difference uses the step latched at the END of
 *    the previous nibble. First nibble after reset uses step=0, and a state
 *    load (sync frame) leaves the latched step stale for one nibble.
 *
 * Stream rules (who resets when — brief §3 + source audit):
 *  - Kiwi audio:      'kiwi', s16 clamp, state persists; server may preset it
 *                     via `MSG audio_adpcm_state=<index>,<prev>`.
 *  - Kiwi waterfall:  'kiwi', u8 clamp (0..255 bins!), reset every frame,
 *                     DROP the last 10 decoded samples (decompression tail).
 *  - OWRX FFT:        'owrx', s16 clamp, reset every frame, SKIP the first 10
 *                     samples (COMPRESS_FFT_PAD_N), then dB = int16 / 100.
 *  - OWRX audio:      'owrx', s16 clamp, persistent, with embedded "SYNC"
 *                     framing — codec state (stepIndex, predictor) is
 *                     re-broadcast in-stream every 1000 payload bytes
 *                     (decodeWithSync). Reset on profile change.
 *
 * Nibble order is low-then-high in every stream.
 */

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34,
  37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494,
  544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
  1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026,
  4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
  27086, 29794, 32767,
];

export type AdpcmFlavor = 'kiwi' | 'owrx';

export class ImaAdpcmDecoder {
  private readonly flavor: AdpcmFlavor;
  private index = 0;
  private predictor = 0;
  private step = 0;            // owrx flavour: latched step from previous nibble
  private clampLo: number;
  private clampHi: number;

  constructor(flavor: AdpcmFlavor = 'kiwi', clampLo = -32768, clampHi = 32767) {
    this.flavor = flavor;
    this.clampLo = clampLo;
    this.clampHi = clampHi;
  }

  reset() {
    this.index = 0;
    this.predictor = 0;
    this.step = 0;
  }

  /** Kiwi `MSG audio_adpcm_state=<index>,<prev>` / OWRX sync-frame state. */
  setState(index: number, predictor: number) {
    this.index = Math.min(Math.max(index, 0), 88);
    this.predictor = predictor;
    // owrx flavour deliberately keeps this.step stale — reference behaviour
  }

  decodeNibble(nibble: number): number {
    let step: number;
    if (this.flavor === 'kiwi') {
      step = STEP_TABLE[this.index];
    } else {
      this.index = Math.min(Math.max(this.index + INDEX_TABLE[nibble], 0), 88);
      step = this.step;
    }

    let diff = step >> 3;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 4) diff += step;
    if (nibble & 8) diff = -diff;

    this.predictor = Math.min(Math.max(this.predictor + diff, this.clampLo), this.clampHi);

    if (this.flavor === 'kiwi') {
      this.index = Math.min(Math.max(this.index + INDEX_TABLE[nibble], 0), 88);
    } else {
      this.step = STEP_TABLE[this.index];
    }
    return this.predictor;
  }

  /** Decode a payload (2 samples/byte, low nibble first). */
  decode(data: Uint8Array, out?: Int16Array): Int16Array {
    const output = out ?? new Int16Array(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      output[i * 2]     = this.decodeNibble(data[i] & 0x0f);
      output[i * 2 + 1] = this.decodeNibble((data[i] >> 4) & 0x0f);
    }
    return output;
  }
}

/** Kiwi audio stream decoder — persistent state, s16. */
export function createKiwiAudioDecoder(): ImaAdpcmDecoder {
  return new ImaAdpcmDecoder('kiwi', -32768, 32767);
}

/**
 * Kiwi waterfall frame → u8 bins (dBm = bin − 255 + wf_cal happens upstream).
 * Fresh state per frame; the last 10 samples are a decompression tail.
 */
export function decodeKiwiWaterfallFrame(data: Uint8Array): Uint8Array {
  const dec = new ImaAdpcmDecoder('kiwi', 0, 255);
  const all = dec.decode(data);
  const n = Math.max(all.length - 10, 0);
  const bins = new Uint8Array(n);
  for (let i = 0; i < n; i++) bins[i] = all[i];
  return bins;
}

/**
 * OWRX compressed FFT frame → Float32 dB row.
 * Fresh state per frame; first 10 samples are COMPRESS_FFT_PAD_N padding.
 */
export function decodeOwrxFftFrame(data: Uint8Array): Float32Array {
  const dec = new ImaAdpcmDecoder('owrx');
  const all = dec.decode(data);
  const n = Math.max(all.length - 10, 0);
  const row = new Float32Array(n);
  for (let i = 0; i < n; i++) row[i] = all[i + 10] / 100;
  return row;
}

/**
 * OWRX audio ADPCM stream decoder with embedded "SYNC" framing — a port of
 * AudioEngine.js decodeWithSync. Every sync frame carries the codec state
 * (stepIndex s16 LE, predictor s16 LE) followed by 1000 payload bytes.
 */
export class OwrxAudioDecoder {
  private codec = new ImaAdpcmDecoder('owrx');
  private phase: 0 | 1 | 2 = 0;      // 0=hunt sync word, 1=read state, 2=payload
  private synchronized = 0;
  private syncBuffer = new Uint8Array(4);
  private syncBufferIndex = 0;
  private syncCounter = 0;
  private static SYNC = [0x53, 0x59, 0x4e, 0x43]; // "SYNC"

  reset() {
    this.codec.reset();
    this.phase = 0;
    this.synchronized = 0;
    this.syncBufferIndex = 0;
    this.syncCounter = 0;
  }

  decode(data: Uint8Array): Int16Array {
    const output = new Int16Array(data.length * 2);
    let oi = 0;
    for (let i = 0; i < data.length; i++) {
      switch (this.phase) {
        case 0:
          if (data[i] !== OwrxAudioDecoder.SYNC[this.synchronized++]) this.synchronized = 0;
          if (this.synchronized === 4) { this.syncBufferIndex = 0; this.phase = 1; }
          break;
        case 1:
          this.syncBuffer[this.syncBufferIndex++] = data[i];
          if (this.syncBufferIndex === 4) {
            const s = new Int16Array(this.syncBuffer.buffer.slice(0));
            this.codec.setState(s[0], s[1]);
            this.syncCounter = 1000;
            this.phase = 2;
          }
          break;
        case 2:
          output[oi++] = this.codec.decodeNibble(data[i] & 0x0f);
          output[oi++] = this.codec.decodeNibble(data[i] >> 4);
          if (this.syncCounter-- === 0) { this.synchronized = 0; this.phase = 0; }
          break;
      }
    }
    return output.slice(0, oi);
  }
}
