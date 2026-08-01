/**
 * RDS group decoder for the NWD head-unit tuner.
 *
 * The vendor framework class `com.nwd.app.NwdFmManager` exposes
 * `getRadioRDSDataArm()`, which returns ONE already-synchronised RDS group as 16
 * hex characters — 4 blocks × 2 bytes, A/B/C/D. All zeros means no group that
 * poll. This is the raw data the bound AIDL never exposes, and it is why
 * RadioText is reachable on this unit after all.
 *
 * We decode here in TS rather than feeding the C++ `RdsDecoder::pushGroup` in
 * vibedsp. That decoder is reached only through `local_sdr_shim.h`, whose
 * contract is an SDR session (start/stop/tune) — pushing head-unit groups
 * through it would mean widening a seam we deliberately keep stable, and would
 * couple the chip path to the SDR engine. The two paths take data at different
 * levels anyway: vibedsp recovers a bitstream, this receives whole groups.
 *
 * Scope is what the device actually sends, verified by hand against the drive
 * log of 2026-08-01 (see nwdRds.test.mjs, which replays those exact groups):
 * PI, PTY, TP/TA, PS (group 0A/0B) and RadioText (2A/2B). RT+ and AF are NOT
 * decoded — no evidence yet that this tuner emits them, and guessing is how the
 * earlier fabricated diagnostics happened.
 *
 * Reference: EN 50067 / IEC 62106.
 */

export interface RdsState {
  /** Programme Identification — the broadcast's own station id. */
  pi: number | null;
  /** Programme Type, 0-31. */
  pty: number | null;
  /** Traffic Programme flag. */
  tp: boolean;
  /** Traffic Announcement in progress. */
  ta: boolean;
  /** Programme Service name, 8 chars, trimmed. Empty until fully assembled. */
  ps: string;
  /** RadioText, up to 64 chars, trimmed. Empty until a terminator or full fill. */
  rt: string;
}

const BLANK: RdsState = { pi: null, pty: null, tp: false, ta: false, ps: '', rt: '' };

/** RDS uses a restricted character set; anything unprintable becomes a space so
 *  a corrupt block degrades the text rather than injecting control codes. */
function chr(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ' ';
}

export interface NwdRdsDecoder {
  /** Feed one group as 16 hex chars. Returns the new state when a user-visible
   *  field changed, or null when nothing did (the common case — the same group
   *  repeats many times per second). */
  push(hex: string): RdsState | null;
  /** Drop all accumulated text. Call on retune: PS/RT belong to the old station. */
  reset(): void;
  state(): RdsState;
}

export function createNwdRdsDecoder(): NwdRdsDecoder {
  let st: RdsState = { ...BLANK };
  // Segment buffers. Held separately from `st` so a partially-assembled name is
  // never shown — a half-filled PS reads as a different station.
  let psBuf = new Array<string>(8).fill(' ');
  let psSeen = 0;                       // bitmask of the 4 PS segments seen
  let rtBuf = new Array<string>(64).fill(' ');
  let rtSeen = 0;                       // bitmask of the 16 RT segments seen
  let rtEnd: number | null = null;      // index of the 0x0D terminator, once seen
  let rtAb: number | null = null;       // A/B flag; a flip means a new message
  let rtDone = false;                   // terminator seen, or all segments filled

  const reset = () => {
    st = { ...BLANK };
    psBuf = new Array<string>(8).fill(' ');
    psSeen = 0;
    rtBuf = new Array<string>(64).fill(' ');
    rtSeen = 0;
    rtEnd = null;
    rtAb = null;
    rtDone = false;
  };

  const push = (hex: string): RdsState | null => {
    if (typeof hex !== 'string' || hex.length !== 16) return null;
    if (/^0+$/.test(hex)) return null;                 // "no group this poll"
    if (!/^[0-9a-fA-F]{16}$/.test(hex)) return null;

    const a = parseInt(hex.slice(0, 4), 16);
    const b = parseInt(hex.slice(4, 8), 16);
    const c = parseInt(hex.slice(8, 12), 16);
    const d = parseInt(hex.slice(12, 16), 16);

    const before = JSON.stringify(st);

    // Block A is PI. A PI change means a different station: everything
    // accumulated belongs to the previous one.
    if (st.pi !== null && st.pi !== a) reset();
    st.pi = a;

    // Block B carries the same header in every group.
    const groupType = (b >>> 12) & 0xf;
    const versionB = ((b >>> 11) & 1) === 1;
    st.tp = ((b >>> 10) & 1) === 1;
    st.pty = (b >>> 5) & 0x1f;

    if (groupType === 0) {
      // 0A / 0B — Programme Service name. Two chars per group in block D, and
      // the segment index is the low 2 bits. TA rides in bit 4.
      st.ta = ((b >>> 4) & 1) === 1;
      const seg = b & 0x3;
      psBuf[seg * 2] = chr((d >>> 8) & 0xff);
      psBuf[seg * 2 + 1] = chr(d & 0xff);
      psSeen |= 1 << seg;
      // Only publish once all four segments have landed.
      if (psSeen === 0b1111) st.ps = psBuf.join('').trim();
    } else if (groupType === 2) {
      // 2A / 2B — RadioText. 2A carries 4 chars (blocks C and D) at segment×4;
      // 2B carries 2 chars (block D only) at segment×2, with block C repeating PI.
      const seg = b & 0xf;
      const ab = (b >>> 4) & 1;
      if (rtAb !== null && ab !== rtAb) {
        // A/B flipped: the broadcaster is starting a new message.
        rtBuf = new Array<string>(64).fill(' ');
        rtSeen = 0;
        rtEnd = null;
        rtDone = false;
      }
      rtAb = ab;

      const bytes = versionB
        ? [(d >>> 8) & 0xff, d & 0xff]
        : [(c >>> 8) & 0xff, c & 0xff, (d >>> 8) & 0xff, d & 0xff];
      const base = versionB ? seg * 2 : seg * 4;

      bytes.forEach((byte, i) => {
        const at = base + i;
        if (at >= 64) return;
        // 0x0D ends the message. This MUST be tested on the raw byte: chr()
        // folds every non-printable to a space, so sanitising first would erase
        // the terminator and the message would never publish.
        if (byte === 0x0d) { if (rtEnd === null || at < rtEnd) rtEnd = at; return; }
        rtBuf[at] = chr(byte);
      });
      rtSeen |= 1 << seg;

      // Publish when the broadcaster says the message ended, or once every
      // segment of a full-length message has been seen. Without this a
      // half-received RadioText would flicker on screen a few chars at a time.
      if (rtEnd !== null || rtSeen === 0xffff) rtDone = true;
      if (rtDone) {
        st.rt = (rtEnd !== null ? rtBuf.slice(0, rtEnd) : rtBuf).join('').trimEnd();
      }
    }

    const after = JSON.stringify(st);
    return after === before ? null : { ...st };
  };

  return { push, reset, state: () => ({ ...st }) };
}
