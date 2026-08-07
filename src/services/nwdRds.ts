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
 * PI, PTY, TP/TA, PS (group 0A/0B), RadioText (2A/2B) and RT+ (3A + the group
 * the station assigns it to). AF is NOT decoded: every 0A group in the logs
 * carries COUNT=0, which is each station stating outright that it has no
 * alternate frequencies, so there is nothing to follow.
 *
 * Reference: EN 50067 / IEC 62106.
 */

export interface RdsState {
  /** Programme Identification — the broadcast's own station id. */
  pi: number | null;
  /** Programme Type, 0-31. */
  pty: number | null;
  /** Traffic Programme flag — "this station carries traffic announcements at
   *  all". Static per station, and consensus-gated on its own bit (see push). */
  tp: boolean;
  /** Traffic Announcement in progress — "one is happening RIGHT NOW".
   *
   *  THREE GUARDS, because an earlier build had none of them and a single
   *  corrupt group could raise this:
   *
   *  1. Read only from group type 0. Bit 4 is TA there; in a 2A RadioText group
   *     the same bit is the text A/B flag, so reading it everywhere is reading
   *     noise. (This one was always right.)
   *  2. Its own consensus tally, not the PTY field's. The old gate voted on bits
   *     9-5 and then published bit 4 from whichever group satisfied it, so a
   *     corruption leaving PTY intact moved TA off one group.
   *  3. Gated on a CONFIRMED TP. A station that does not carry traffic cannot be
   *     making a traffic announcement, so TP being false suppresses TA outright —
   *     which on the local stations measured rules out most of them.
   *
   *  Consensus is affordable here despite TA being the one field that has to
   *  react promptly: an announcement runs tens of seconds — hundreds of groups —
   *  so three agreeing groups is well under a second against the length of the
   *  event.
   *
   *  TA drives a tell and NOTHING else — it does not break the user's mute, by
   *  decision. The guards still earn their keep without that: an unguarded TA
   *  flickered a pulsing tell off single corrupt groups, which is the kind of
   *  motion that trains a driver to stop reading an indicator. */
  ta: boolean;
  /** Programme Service name, 8 chars, trimmed. Empty until fully assembled. */
  ps: string;
  /** RadioText, up to 64 chars, trimmed. Empty until a terminator or full fill. */
  rt: string;
  /** This station uses PS as a scrolling text field rather than as its name, so
   *  `ps` is not an identity and must not reach the hero. See PS_SCROLL_DISTINCT. */
  psScrolling: boolean;
  /** RT+ artist, sliced out of `rt` by the station's own offsets. Empty unless
   *  the station broadcasts RT+ AND an item is currently running. */
  rtArtist: string;
  /** RT+ title, same. */
  rtTitle: string;
}

const BLANK: RdsState = { pi: null, pty: null, tp: false, ta: false, ps: '', rt: '',
  psScrolling: false, rtArtist: '', rtTitle: '' };

/** RT+ ODA Application Identifier. A 16-bit exact match, which is what makes a
 *  single declaration trustworthy: a corrupt block landing on this value by
 *  chance is a 1-in-65536 event, on top of the group already having to be a
 *  well-formed 3A carrying the confirmed PI. */
const RTPLUS_AID = 0x4bd7;

/** RT+ content-type codes. The full class list runs to 63; these are the two the
 *  face has fields for. */
const RTPLUS_TITLE = 1;
const RTPLUS_ARTIST = 4;

/**
 * Distinct published PS values, on ONE station, that mean the PS is a scrolling
 * text field rather than a name.
 *
 * The two-cycle rule was supposed to make this impossible: a scrolling PS never
 * repeats a complete assembly, so it never publishes. That reasoning holds for a
 * FAST scroller and fails for a slow one. WIBA-FM holds each 8-character chunk
 * for about four seconds — several complete assemblies — so consecutive
 * assemblies agree and every chunk publishes.
 *
 * Measured on the drive of 2026-08-04 the separation is not subtle: WIBA
 * published 16 distinct values in half an hour ("Walk", "This Way", "Aerosmit",
 * "erosmith", "NicoletL", "Law.com" …), while WERN published exactly one and
 * WWHG exactly one. Three is comfortably clear of both.
 *
 * Once set the verdict sticks until the station changes, because a station that
 * scrolls its PS keeps doing it, and the PI-derived identity is better anyway.
 */
const PS_SCROLL_DISTINCT = 3;

/** Identical PIs required before a value is trusted, or before a disagreement is
 *  accepted as a real station change. RDS runs ~11.4 groups/s, so 3 is about a
 *  quarter-second — fast enough to feel instant, long enough that scattered
 *  block corruption never clears it. */
const PI_CONFIRM = 3;

/**
 * Identical PIs required to DISPLACE a PI already trusted — much higher than the
 * three it takes to acquire one from nothing, and deliberately so.
 *
 * Acquisition should be fast: there is no incumbent to protect and the sooner PI
 * lands the sooner the station has a name. Displacement should be slow, because
 * what this path catches is a station changing UNDER a stationary dial, which
 * happens on a long drive and happens over many seconds.
 *
 * This comment used to claim a retune never reaches this path, "because the
 * screen calls reset() on every frequency event, so a retune has already emptied
 * this decoder". reset() deliberately does NOT clear piConfirmed, so every
 * retune DID reach it: the new station's PI was dissent against the old
 * station's, needing twelve consecutive rather than three. Measured, 12 groups
 * against 3 from an empty decoder on a clean signal — and far worse in practice,
 * because piPendingCount resets to 1 on any differing block A and the drive logs
 * run 30-35% block-A errors. Worse than slow: push() DROPS every group whose PI
 * does not match the incumbent, so PS, RadioText, PTY and RT+ were all discarded
 * for the whole window. resetForRetune() is what closes that.
 *
 * Three was not enough. On 2026-08-04, WERN's 0xA6FF was misread as 0x57FF three
 * times in a row during a fade, three separate times in one commute — enough to
 * clear the old threshold, wipe the accumulated PS and RadioText, and put the
 * formula's rendering of that number, "WBGX", on the hero in place of the logo.
 * Twelve groups is a little over a second of solid contradicting data, which a
 * fade-induced burst does not sustain and a genuine new station does trivially.
 */
const PI_DISPLACE = 12;

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
  /** Drop all accumulated text, KEEPING the trusted PI. For a station change the
   *  decoder detected itself — piConfirmed is overwritten by the caller on the
   *  next line, and keeping it in the meantime avoids the no-incumbent path. */
  reset(): void;
  /** Drop everything INCLUDING the trusted PI. For a retune, where the dial moved
   *  and the old PI is known-stale rather than an incumbent worth defending.
   *  Without this the new station has to displace the old one (see PI_DISPLACE),
   *  which blocks all RDS for as long as that takes. */
  resetForRetune(): void;
  state(): RdsState;
  /** Reception quality since the last resetStats(). `groups` counts well-formed
   *  non-empty groups; `piMismatch` counts those whose block A did not carry the
   *  trusted PI, i.e. the block error rate. Untouched by reset(). */
  stats(): { groups: number; piMismatch: number };
  resetStats(): void;
  /**
   * Rolling reception quality over the last ~64 groups, for a live display.
   *
   * `piMatchPct` is the share of recent groups whose block A carried the trusted
   * PI. NOT a block error rate: this tuner hands over groups with NO per-block
   * validity, so block A is the only one whose correctness can be judged at all.
   * Errors in B, C and D are invisible to it — which is precisely why RadioText
   * arrives corrupt while this figure looks healthy, since the text lives in C
   * and D. Treat it as a PROXY for channel quality, never as "% intact".
   *
   * Null until there are enough groups to mean anything. A station with almost
   * no RDS would otherwise read as flawless — the "barely there" case of
   * 2026-08-05 scored 0% errors on 0.5 groups/s.
   *
   * Separate from stats() on purpose: those counters are reset every 15s by the
   * debug sampler, and a display sharing them would blank on every sample.
   */
  quality(): { piMatchPct: number | null; samples: number };
}

export function createNwdRdsDecoder(): NwdRdsDecoder {
  let st: RdsState = { ...BLANK };
  // Segment buffers. Held separately from `st` so a partially-assembled name is
  // never shown — a half-filled PS reads as a different station.
  let psBuf = new Array<string>(8).fill(' ');
  let psSeen = 0;                       // bitmask of the 4 PS segments seen
  let psCandidate = '';                 // previous COMPLETE assembly; must repeat to publish
  let psSeenValues = new Set<string>();  // distinct published names — see PS_SCROLL_DISTINCT
  let psScrolling = false;               // ...and the verdict once there are too many
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
  // Reception-quality counters. The decoder already has to decide whether each
  // group's block A carries the trusted PI in order to drop the bad ones; it just
  // threw the tally away. Kept here because block error rate is the most direct
  // measure of what multipath does to a signal, and nothing else in the app can
  // see it. Reset independently of the decode state — these belong to a
  // measurement window, not to a station.
  let statGroups = 0;
  let statPiMismatch = 0;
  // ROLLING quality, for the face. Deliberately separate from the counters above:
  // those are reset every 15s by the debug sampler, and a display sharing them
  // would blank each time a sample closed. A ring of recent outcomes instead —
  // never reset on a schedule, only when the station changes.
  //
  // 64 entries at the ~5 groups/s that actually reach us is roughly a dozen
  // seconds: long enough to be steady, short enough to follow a drive under a
  // bridge.
  const QUALITY_RING = 64;
  /** Fewest outcomes before a percentage is worth quoting. Below this the answer
   *  is "not enough data", NOT 100% — the failure mode to avoid is a station with
   *  almost no groups reading as perfectly intact, which is exactly what the
   *  "barely there" samples of 2026-08-05 did: 0% errors on 0.5 groups/s. */
  const QUALITY_MIN = 16;
  let qRing = new Array<0 | 1>(QUALITY_RING).fill(0);
  let qAt = 0;
  let qCount = 0;
  let ptyPending: number | null = null; // block B is corrupted independently of block A
  let ptyCount = 0;
  // TP rides in the SAME block as PTY but in its own bit, so the PTY consensus
  // says nothing about it: a corruption that leaves bits 9-5 intact while
  // flipping bit 10 satisfied that gate and published a wrong TP off one group.
  // Cheap to fix properly because TP is static per station — it costs three
  // groups once, and then never moves.
  let tpPending: boolean | null = null;
  let tpCount = 0;
  // TA gets the same treatment as TP but is only counted on group 0, where bit 4
  // actually means TA — so this tally advances far more slowly than TP's.
  let taPending: boolean | null = null;
  let taCount = 0;
  // RT+ (ODA, AID 0x4BD7). The group it rides in is NOT fixed by the standard —
  // the station announces it in a 3A group and may pick any type. WIBA uses 12A;
  // another station may use 11A. So the assignment has to be learned from the air
  // per station rather than hard-coded, which is also why no amount of probing
  // could have short-circuited this: the app must discover it at runtime anyway.
  let rtPlusGroup: number | null = null;   // group TYPE carrying RT+
  let rtPlusVerB = false;                  // ...and its version

  const reset = () => {
    st = { ...BLANK };
    psBuf = new Array<string>(8).fill(' ');
    psSeen = 0;
    psCandidate = '';
    psSeenValues = new Set<string>();
    psScrolling = false;
    rtBuf = new Array<string>(64).fill(' ');
    rtSeen = 0;
    rtEnd = null;
    rtEndSeg = null;
    rtAb = null;
    rtCandidate = '';
    rtPublished = false;
    ptyPending = null;
    ptyCount = 0;
    tpPending = null;
    tpCount = 0;
    taPending = null;
    taCount = 0;
    // The ODA assignment belongs to the station, so it goes with the rest of the
    // station's state on a retune.
    rtPlusGroup = null;
    rtPlusVerB = false;
    qRing = new Array<0 | 1>(QUALITY_RING).fill(0);
    qAt = 0;
    qCount = 0;
    // piConfirmed is deliberately NOT cleared. Clearing it would drop the decoder
    // into the no-incumbent path where any 3-group run of corruption is adopted
    // outright, with no trusted PI to outvote it. st.pi is re-asserted from
    // piConfirmed by the next matching group — see the equality branch in push().
  };

  const push = (hex: string): RdsState | null => {
    if (typeof hex !== 'string' || hex.length !== 16) return null;
    if (/^0+$/.test(hex)) return null;                 // "no group this poll"
    if (!/^[0-9a-fA-F]{16}$/.test(hex)) return null;
    statGroups++;   // well-formed and carrying something — counted before any trust gate

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
    // Ring the block-A outcome for the rolling quality figure. Done here because
    // this is where the decision already exists; `piConfirmed === null` means we
    // have no incumbent to judge against yet, so those groups are not counted.
    if (piConfirmed !== null) {
      qRing[qAt] = a === piConfirmed ? 1 : 0;
      qAt = (qAt + 1) % QUALITY_RING;
      if (qCount < QUALITY_RING) qCount++;
    }

    if (piConfirmed === null) {
      if (a === piPending) piPendingCount++;
      else { piPending = a; piPendingCount = 1; }
      if (piPendingCount < PI_CONFIRM) return null;   // not yet trusted
      piConfirmed = a;
      st.pi = a;
    } else if (a !== piConfirmed) {
      statPiMismatch++;
      if (a === piPending) piPendingCount++;
      else { piPending = a; piPendingCount = 1; }
      if (piPendingCount < PI_DISPLACE) return null;  // corrupt block — drop it
      // Persistent disagreement: a real station change.
      reset();
      piConfirmed = a;
      piPending = a;
      piPendingCount = PI_DISPLACE;
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
    if (ptyCount >= PI_CONFIRM) st.pty = pty;

    // Voted separately — see tpPending. Same threshold, its own tally.
    const tp = ((b >>> 10) & 1) === 1;
    if (tp === tpPending) tpCount++;
    else { tpPending = tp; tpCount = 1; }
    if (tpCount >= PI_CONFIRM) {
      st.tp = tp;
      // TA is conditioned on TP, so losing TP has to drop a latched TA with it —
      // otherwise a retune onto a non-traffic station could inherit the previous
      // one's announcement and hold it until the next group 0 arrives.
      if (!tp) st.ta = false;
    }

    if (groupType === 0) {
      // 0A / 0B — Programme Service name. Two chars per group in block D, and
      // the segment index is the low 2 bits. Bit 4 carries TA here, and ONLY
      // here: the same bit in a 2A group is the RadioText A/B flag.
      const ta = ((b >>> 4) & 1) === 1;
      if (ta === taPending) taCount++;
      else { taPending = ta; taCount = 1; }
      // st.tp, not the raw bit: a station that does not carry traffic at all
      // cannot be announcing any. An unconfirmed TP suppresses TA too, which
      // costs nothing — TP is static and confirms off any three groups.
      if (taCount >= PI_CONFIRM) st.ta = st.tp && ta;
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
        if (cand === psCandidate) {
          // A repeated complete assembly. That used to be proof of a name; on a
          // slow scroller it only proves the chunk was held for a few seconds.
          // Count the distinct ones and stop trusting PS entirely once there are
          // too many — including retracting what was already shown, because those
          // earlier chunks were never a name either.
          const val = cand.trim();
          if (!psScrolling) {
            psSeenValues.add(val);
            if (psSeenValues.size >= PS_SCROLL_DISTINCT) {
              psScrolling = true;
              st.psScrolling = true;
              st.ps = '';
            } else {
              st.ps = val;
            }
          }
        }
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
        // A/B flipped: the broadcaster is starting a new message. Any RT+ markers
        // we hold point into the OLD string and are meaningless against the new
        // one, so they go with it.
        st.rtArtist = '';
        st.rtTitle = '';
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

    // ── RT+ ─────────────────────────────────────────────────────────────────
    //
    // 3A announces which group carries an ODA and which application it is. The
    // five low bits of block B are the application group type: four bits of group
    // number and one of version. Block D is the AID.
    if (groupType === 3 && !versionB) {
      if (d === RTPLUS_AID) {
        const agt = b & 0x1f;
        rtPlusGroup = agt >>> 1;
        rtPlusVerB = (agt & 1) === 1;
      }
    } else if (rtPlusGroup !== null && groupType === rtPlusGroup && versionB === rtPlusVerB) {
      // The payload is 37 bits spread across the five spare bits of B and all of
      // C and D: a toggle, a running flag, then two (content type, start, length)
      // triplets. Length markers are one less than the real length.
      const running = ((b >>> 3) & 1) === 1;
      const ct1 = (((b & 0x7) << 3) | (c >>> 13)) & 0x3f;
      const start1 = (c >>> 7) & 0x3f;
      const len1 = ((c >>> 1) & 0x3f) + 1;
      const ct2 = (((c & 0x1) << 5) | (d >>> 11)) & 0x3f;
      const start2 = (d >>> 5) & 0x3f;
      const len2 = (d & 0x1f) + 1;
      if (!running) {
        // The item has ENDED. Keeping the last song on screen over the next one
        // is the same staleness the rest of this decoder works to avoid.
        st.rtArtist = '';
        st.rtTitle = '';
      } else if (rtPublished && st.rt) {
        // Offsets index into the RadioText AS TRANSMITTED. Applying them to a
        // half-assembled or corrupt string yields confident nonsense, so this
        // only ever runs against text that has already passed the publish gate —
        // and even then a marker running off the end is rejected rather than
        // clamped, because a truncated artist is still a wrong artist.
        const slice = (start: number, len: number): string | null => {
          if (start + len > st.rt.length) return null;
          const v = st.rt.slice(start, start + len).trim();
          return v || null;
        };
        const apply = (ct: number, start: number, len: number): void => {
          const v = slice(start, len);
          if (v === null) return;
          if (ct === RTPLUS_ARTIST) st.rtArtist = v;
          else if (ct === RTPLUS_TITLE) st.rtTitle = v;
        };
        apply(ct1, start1, len1);
        apply(ct2, start2, len2);
      }
    }

    const after = JSON.stringify(st);
    return after === before ? null : { ...st };
  };

  return {
    push,
    reset,
    // The dial MOVED, so the previous station's PI is not an incumbent to
    // protect — it is known to be wrong. Clearing it puts the decoder back on
    // the 3-group acquisition path. The exposure that leaves (a 3-group run of
    // corruption being adopted outright, with no trusted PI to outvote it) is
    // exactly the exposure the app already accepts every time it starts up on a
    // station; the alternative was a total RDS blackout on every retune.
    resetForRetune: () => {
      reset();
      piConfirmed = null;
      piPending = null;
      piPendingCount = 0;
    },
    state: () => ({ ...st }),
    stats: () => ({ groups: statGroups, piMismatch: statPiMismatch }),
    resetStats: () => { statGroups = 0; statPiMismatch = 0; },
    quality: () => {
      if (qCount < QUALITY_MIN) return { piMatchPct: null, samples: qCount };
      let good = 0;
      for (let i = 0; i < qCount; i++) good += qRing[i];
      return { piMatchPct: (100 * good) / qCount, samples: qCount };
    },
  };
}
