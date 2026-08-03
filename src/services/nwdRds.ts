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

/** Identical PIs required before a value is trusted, or before a disagreement is
 *  accepted as a real station change. RDS runs ~11.4 groups/s, so 3 is about a
 *  quarter-second — fast enough to feel instant, long enough that scattered
 *  block corruption never clears it. */
const PI_CONFIRM = 3;

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
  let psCandidate = '';                 // previous COMPLETE assembly; must repeat to publish
  let rtBuf = new Array<string>(64).fill(' ');
  let rtSeen = 0;                       // bitmask of the 16 RT segments seen
  let rtEnd: number | null = null;      // index of the 0x0D terminator, once seen
  let rtEndSeg: number | null = null;   // and which segment carried it
  let rtAb: number | null = null;       // A/B flag; a flip means a new message
  let rtCandidate = '';                 // previous COMPLETE assembly, corrupt or not
  let rtPublished = false;              // has THIS message ever reached the face?
  let piConfirmed: number | null = null;// the PI we trust; groups not carrying it are dropped
  let piPending: number | null = null;  // candidate PI awaiting repeats
  let piPendingCount = 0;
  let ptyPending: number | null = null; // block B is corrupted independently of block A
  let ptyCount = 0;

  const reset = () => {
    st = { ...BLANK };
    psBuf = new Array<string>(8).fill(' ');
    psSeen = 0;
    psCandidate = '';
    rtBuf = new Array<string>(64).fill(' ');
    rtSeen = 0;
    rtEnd = null;
    rtEndSeg = null;
    rtAb = null;
    rtCandidate = '';
    rtPublished = false;
    ptyPending = null;
    ptyCount = 0;
    // piConfirmed is deliberately NOT cleared. Clearing it would drop the decoder
    // into the no-incumbent path where any 3-group run of corruption is adopted
    // outright, with no trusted PI to outvote it. st.pi is re-asserted from
    // piConfirmed by the next matching group — see the equality branch in push().
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

    // ── PI consensus: the error check this decoder was missing ──────────────
    //
    // These groups arrive with NO error correction applied. On a real drive
    // (2026-08-01 16:12, WERN 88.7, true PI a6ff) block A came back as a6ff,
    // a63e, 2631, a699, a6b8, d86f, c6fe, 47ff, 26f5 … — most groups corrupt.
    //
    // PI is repeated in EVERY group precisely so a receiver can use it to reject
    // bad blocks, and treating each new value as a station change was the single
    // cause of four separate faults: accumulated PS/RT wiped on every corrupt
    // group (RadioText never filled in), PTY republished from garbage (the genre
    // label flickering through random genres), and a corrupt PI reaching the
    // callsign lookup (WIBA showing "KDTI-ROCHE…").
    //
    // So: adopt a PI only after it repeats, and DISCARD every group that does not
    // carry the adopted PI. A genuine station change is persistent — every group
    // carries the new PI — so it clears the threshold in a fraction of a second,
    // while scattered corruption never does.
    if (piConfirmed === null) {
      if (a === piPending) piPendingCount++;
      else { piPending = a; piPendingCount = 1; }
      if (piPendingCount < PI_CONFIRM) return null;   // not yet trusted
      piConfirmed = a;
      st.pi = a;
    } else if (a !== piConfirmed) {
      if (a === piPending) piPendingCount++;
      else { piPending = a; piPendingCount = 1; }
      if (piPendingCount < PI_CONFIRM) return null;   // corrupt block — drop it
      // Persistent disagreement: a real station change.
      reset();
      piConfirmed = a;
      piPending = a;
      piPendingCount = PI_CONFIRM;
      st.pi = a;
    } else {
      piPendingCount = 0;   // a good group resets the dissent counter
      // Re-assert after an external reset(). reset() rebuilds st from BLANK, which
      // nulls st.pi, but deliberately keeps piConfirmed — and the exported surface
      // is { push, reset, state } with no setter, so the comment claiming "the
      // caller sets it immediately after" was wrong: no caller can.
      //
      // Without this, every later group carrying the same PI lands in this branch
      // and never rewrites st.pi, so PI stays null for the rest of the session.
      // RadioScreen calls reset() on EVERY frequency event, so re-pressing the
      // preset you are already on is enough to trigger it.
      //
      // Re-asserting here rather than clearing piConfirmed in reset() is
      // deliberate: clearing would drop the decoder into the no-incumbent path
      // where any 3-group run of corruption is adopted outright, with no trusted
      // PI to outvote it.
      if (st.pi === null) st.pi = piConfirmed;
    }

    // Block B needs the SAME treatment, independently. A correct PI does not mean
    // a correct header: on the same drive, groups carrying the true a6ff reported
    // PTY 22, 15, 6, 8, 17 and 5 — block A survived while block B did not. That is
    // the genre label flickering between random genres, and PI consensus alone
    // does not touch it.
    const groupType = (b >>> 12) & 0xf;
    const versionB = ((b >>> 11) & 1) === 1;
    const pty = (b >>> 5) & 0x1f;
    if (pty === ptyPending) ptyCount++;
    else { ptyPending = pty; ptyCount = 1; }
    if (ptyCount >= PI_CONFIRM) {
      st.pty = pty;
      st.tp = ((b >>> 10) & 1) === 1;
    }

    if (groupType === 0) {
      // 0A / 0B — Programme Service name. Two chars per group in block D, and
      // the segment index is the low 2 bits. TA rides in bit 4.
      // TA rides in the same block as PTY, so it inherits the same trust gate.
      if (ptyCount >= PI_CONFIRM) st.ta = ((b >>> 4) & 1) === 1;
      const seg = b & 0x3;
      psBuf[seg * 2] = chr((d >>> 8) & 0xff);
      psBuf[seg * 2 + 1] = chr(d & 0xff);
      psSeen |= 1 << seg;
      if (psSeen === 0b1111) {
        // Publish only when two CONSECUTIVE complete assemblies agree.
        //
        // Without this the display churns: segments keep arriving after the first
        // complete fill, so each one republishes a buffer that is half the old
        // name and half the new. Observed on device 2026-08-01 — "The load",
        // "The cyad", "Aue cy", "Auda94.9", "WOda94.9" before settling on
        // "WOLX94.9", every one of them shown to the user.
        //
        // A station that SCROLLS its PS (101.5 cycling "101.5"/"IBA-FM"/"10A-FM")
        // never repeats an assembly, so it never publishes. That is correct: a
        // scrolling PS is advertising copy, not a station name, and RadioText
        // carries the same content properly.
        const cand = psBuf.join('');
        if (cand === psCandidate) st.ps = cand.trim();
        psCandidate = cand;
        // Start a clean cycle so the next assembly cannot inherit stale chars.
        psSeen = 0;
        psBuf = new Array<string>(8).fill(' ');
      }
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
        rtEndSeg = null;
        rtCandidate = '';
        rtPublished = false;   // a genuinely new message shows at once, as below
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
        if (byte === 0x0d) { if (rtEnd === null || at < rtEnd) { rtEnd = at; rtEndSeg = seg; } return; }
        rtBuf[at] = chr(byte);
      });
      rtSeen |= 1 << seg;

      // Same two-cycle rule as PS, and for the same reason. Latching on the first
      // complete fill meant every later segment republished a partly-rewritten
      // buffer: on device this showed "        blic Radio", "Wisc    blic Radio",
      // and "Z104son's #1 Hit Music Station" — one message bleeding into the next
      // because many stations change RadioText without toggling the A/B flag.
      // A terminator only means "the message ends here" — it says nothing about
      // whether the segments BEFORE it ever arrived. Acquisition genuinely lands
      // mid-cycle (PI consensus burns groups before any RT group is admitted), so
      // publishing on the terminator alone put a fragment on the plate after every
      // retune: segments 2,3 then a CR in segment 4 rendered as "tta Love".
      // Require every segment up to the terminator's own.
      const endMask = rtEndSeg === null ? 0 : (1 << (rtEndSeg + 1)) - 1;
      const terminatedAndComplete = rtEndSeg !== null && (rtSeen & endMask) === endMask;
      if (terminatedAndComplete || rtSeen === 0xffff) {
        const msg = (rtEnd !== null ? rtBuf.slice(0, rtEnd) : rtBuf).join('').trimEnd();
        // FIRST FILL IS INSTANT, REPLACEMENTS MUST REPEAT.
        //
        // Blocks C and D carry the text itself and nothing protects them: PI
        // consensus guards block A, PTY consensus guards block B, and the
        // characters have no error check at all. On the drive of 2026-08-03,
        // 44 of WERN's 83 RadioText publishes were corrupt — "Wisconsin PuAoic
        // Radio", "Wisc h yn Public Radio", "Wisconsin Public Rad 5" — every one
        // of them shown to the driver. Same fault produced the trailing junk on
        // "Everything That Rocks          \"", where the terminator was lost and
        // the 16-segment fallback published corrupt padding along with the text.
        //
        // Requiring two agreeing cycles for EVERYTHING was the previous rule and
        // it was the "RadioText took forever" complaint, so it only applies to
        // replacements. Corruption is random, so a corrupt assembly essentially
        // never repeats and never reaches the face; a real message change costs
        // one extra cycle, a few seconds on a song title. An A/B flip is the
        // broadcaster saying the message changed, so that path stays instant.
        if (!rtPublished) {
          st.rt = msg;
          rtPublished = true;
        } else if (msg !== st.rt && msg === rtCandidate) {
          st.rt = msg;
        }
        // Always the LAST assembly seen, agreeing or not — otherwise a stale
        // candidate could later be confirmed by an unrelated repeat.
        rtCandidate = msg;
        rtSeen = 0;
        rtEnd = null;
        rtEndSeg = null;
        rtBuf = new Array<string>(64).fill(' ');
      }
    }

    const after = JSON.stringify(st);
    return after === before ? null : { ...st };
  };

  return { push, reset, state: () => ({ ...st }) };
}
