//! RDS group decoder for the NWD head-unit tuner.
//!
//! A faithful port of `src/services/nwdRds.ts`, which it is intended to replace.
//! Every threshold, every trust gate and every refusal below was established
//! against real drive logs, and the reasons are kept with them — this is not a
//! clean-room rewrite and must not drift from the behaviour the logs justify.
//!
//! The vendor framework class `com.nwd.app.NwdFmManager` exposes
//! `getRadioRDSDataArm()`, which returns ONE already-synchronised RDS group as 16
//! hex characters — 4 blocks × 2 bytes, A/B/C/D. All zeros means no group that
//! poll.
//!
//! Scope is what the device actually sends: PI, PTY, TP/TA, PS (group 0A/0B),
//! RadioText (2A/2B) and RT+ (3A plus the group the station assigns it to). AF is
//! NOT decoded — every 0A group in the logs carries COUNT=0, which is each
//! station stating outright that it has no alternate frequencies.
//!
//! Reference: EN 50067 / IEC 62106.
//!
//! ## Why this is in Rust
//!
//! It was in TypeScript because the app was built on React Native, not because
//! that was the right home for it. Groups arrive in Kotlin, cross the bridge as
//! strings at 5–11 per second, get decoded in JavaScript, and the results cross
//! back to be rendered. Here it sits on the same side as the data, and it
//! compiles for anything.

/// Everything the decoder publishes. Cloned out on every change, so a caller can
/// hold a snapshot without borrowing the decoder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RdsState {
    /// Programme Identification — the broadcast's own station id.
    pub pi: Option<u16>,
    /// Programme Type, 0-31.
    pub pty: Option<u8>,
    /// Traffic Programme flag — "this station carries traffic announcements at
    /// all". Static per station, and consensus-gated on its OWN bit.
    pub tp: bool,
    /// Traffic Announcement in progress — "one is happening RIGHT NOW".
    ///
    /// THREE GUARDS, because an earlier build had none of them and a single
    /// corrupt group could raise this:
    ///   1. read only from group type 0 — bit 4 is TA there, but the RadioText
    ///      A/B flag in a 2A, so reading it everywhere reads noise;
    ///   2. its own consensus tally, not the PTY field's;
    ///   3. gated on a CONFIRMED TP — a station that carries no traffic cannot
    ///      be announcing any.
    ///
    /// Consensus is affordable despite TA needing to react promptly: an
    /// announcement runs tens of seconds, so three groups is well under a second
    /// against the length of the event.
    pub ta: bool,
    /// Programme Service name, 8 chars, trimmed. Empty until fully assembled.
    pub ps: String,
    /// RadioText, up to 64 chars, trimmed. Empty until a terminator or full fill.
    pub rt: String,
    /// This station uses PS as a scrolling text field rather than as its name, so
    /// `ps` is not an identity and must not reach the hero.
    pub ps_scrolling: bool,
    /// RT+ artist, sliced out of `rt` by the station's own offsets. Empty unless
    /// the station broadcasts RT+ AND an item is currently running.
    pub rt_artist: String,
    /// RT+ title, same.
    pub rt_title: String,
}

/// RT+ ODA Application Identifier. A 16-bit exact match, which is what makes a
/// single declaration trustworthy: a corrupt block landing on this value by
/// chance is a 1-in-65536 event, on top of the group already having to be a
/// well-formed 3A carrying the confirmed PI.
const RTPLUS_AID: u16 = 0x4bd7;

/// RT+ content-type codes. The full class list runs to 63; these are the two the
/// face has fields for.
const RTPLUS_TITLE: u8 = 1;
const RTPLUS_ARTIST: u8 = 4;

/// The decoded RT+ payload — the running flag and both (content type, start,
/// length) triplets. Compared whole, so "it repeated" means every field did.
type RtPlusPayload = (bool, u8, usize, usize, u8, usize, usize);

/// Whether an ODA may legally ride in this group.
///
/// 0A/0B (PS), 1A/1B (PIN, slow labelling), 2A/2B (RadioText), 3A (the ODA
/// announcement itself), 4A (clock time), 10A (programme type name) and 15B
/// (fast basic tuning) all have uses fixed by the standard. An announcement
/// naming one of them is a corrupted announcement, not a station being unusual —
/// and believing it turns the groups this decoder already parses into RT+
/// payloads.
fn oda_group_is_legal(group: u8, ver_b: bool) -> bool {
    !matches!(
        (group, ver_b),
        (0, _) | (1, _) | (2, _) | (3, false) | (4, false) | (10, false) | (15, true)
    )
}

/// Distinct published PS values, on ONE station, that mean the PS is a scrolling
/// text field rather than a name.
///
/// The two-cycle rule was supposed to make this impossible: a scrolling PS never
/// repeats a complete assembly, so it never publishes. That holds for a FAST
/// scroller and fails for a slow one. WIBA-FM holds each 8-character chunk for
/// about four seconds — several complete assemblies — so consecutive assemblies
/// agree and every chunk publishes.
///
/// Measured on 2026-08-04 the separation is not subtle: WIBA published 16
/// distinct values in half an hour ("Walk", "This Way", "Aerosmit", "erosmith",
/// "NicoletL", "Law.com" …), while WERN published exactly one and WWHG exactly
/// one. Three is comfortably clear of both.
const PS_SCROLL_DISTINCT: usize = 3;

/// Identical PIs required before a value is trusted, or before a disagreement is
/// accepted as a real station change. RDS runs ~11.4 groups/s, so 3 is about a
/// quarter-second — fast enough to feel instant, long enough that scattered
/// block corruption never clears it.
const PI_CONFIRM: u32 = 3;

/// Identical PIs required to DISPLACE a PI already trusted — much higher than the
/// three it takes to acquire one, and deliberately so.
///
/// Acquisition should be fast: there is no incumbent to protect. Displacement
/// should be slow, because the decoder is almost never the thing that notices a
/// station change — the screen calls `reset()` on every frequency event, so a
/// retune has already emptied this decoder before a single group of the new
/// station arrives. What is left for this path to catch is a station changing
/// UNDER a stationary dial, which happens over many seconds.
const PI_DISPLACE: u32 = 12;

/// Rolling quality window, in groups. At the ~5 groups/s that actually reach us
/// that is roughly a dozen seconds: long enough to be steady, short enough to
/// follow a drive under a bridge.
const QUALITY_RING: usize = 64;

/// Fewest outcomes before a percentage is worth quoting. Below this the answer is
/// "not enough data", NOT 100% — the failure mode to avoid is a station with
/// almost no groups reading as perfectly intact, which is exactly what the
/// "barely there" samples of 2026-08-05 did: 0% errors on 0.5 groups/s.
const QUALITY_MIN: usize = 16;

/// Reception quality since the last `reset_stats()`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Well-formed, non-empty groups.
    pub groups: u32,
    /// Of those, the ones whose block A did not carry the trusted PI.
    pub pi_mismatch: u32,
}

/// Rolling reception quality over the last ~64 groups, for a live display.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Quality {
    /// Share of recent groups whose block A carried the trusted PI. NOT a block
    /// error rate: this tuner hands over groups with NO per-block validity, so
    /// block A is the only one whose correctness can be judged at all. Errors in
    /// B, C and D are invisible — which is why RadioText arrives corrupt while
    /// this figure looks healthy, since the text lives in C and D. A proxy for
    /// channel quality, never "% intact".
    pub pi_match_pct: Option<f64>,
    pub samples: usize,
}

/// One-line rendering of everything the decoder publishes, in exactly the shape
/// the differential harness compares.
///
/// It lives in the library rather than in the dump example because there are now
/// two consumers — the harness and the Android JNI adapter — and a format that
/// exists twice is a format that drifts. The whole value of the differential is
/// that both implementations print identically; a second, hand-copied formatter
/// would quietly break that the first time a field was added.
pub fn format_state(s: &RdsState, t: &Stats, q: &Quality) -> String {
    format!(
        "pi={} pty={} tp={} ta={} ps={:?} rt={:?} scroll={} art={:?} tit={:?} g={} x={} q={} n={}",
        s.pi.map(|v| format!("{v:04x}")).unwrap_or("-".into()),
        s.pty.map(|v| v.to_string()).unwrap_or("-".into()),
        s.tp,
        s.ta,
        s.ps,
        s.rt,
        s.ps_scrolling,
        s.rt_artist,
        s.rt_title,
        t.groups,
        t.pi_mismatch,
        q.pi_match_pct.map(|v| v.to_string()).unwrap_or("-".into()),
        q.samples
    )
}

/// Fold every non-printable byte to a space. Must NOT be applied before the
/// RadioText terminator test — see the note at that call site.
fn chr(byte: u8) -> char {
    if (0x20..=0x7e).contains(&byte) {
        byte as char
    } else {
        ' '
    }
}

pub struct RdsDecoder {
    st: RdsState,
    // Segment buffers. Held separately from `st` so a partially-assembled name is
    // never shown — a half-filled PS reads as a different station.
    ps_buf: [char; 8],
    ps_seen: u8,                 // bitmask of the 4 PS segments seen
    ps_candidate: String,        // previous COMPLETE assembly; must repeat to publish
    ps_seen_values: Vec<String>, // distinct published names — see PS_SCROLL_DISTINCT
    ps_scrolling: bool,          // ...and the verdict once there are too many
    rt_buf: [char; 64],
    rt_seen: u16,              // bitmask of the 16 RT segments seen
    rt_end: Option<usize>,     // index of the 0x0D terminator, once seen
    rt_end_seg: Option<u16>,   // and which segment carried it
    rt_ab: Option<u8>,         // A/B flag; a flip means a new message
    rt_candidate: String,      // previous COMPLETE assembly, corrupt or not
    rt_published: bool,        // has THIS message ever reached the face?
    pi_confirmed: Option<u16>, // the PI we trust; groups not carrying it are dropped
    pi_pending: Option<u16>,
    pi_pending_count: u32,
    stat_groups: u32,
    stat_pi_mismatch: u32,
    q_ring: [u8; QUALITY_RING],
    q_at: usize,
    q_count: usize,
    pty_pending: Option<u8>, // block B is corrupted independently of block A
    pty_count: u32,
    // TP rides in the SAME block as PTY but in its own bit, so the PTY consensus
    // says nothing about it: a corruption leaving bits 9-5 intact while flipping
    // bit 10 satisfied that gate and published a wrong TP off one group. Cheap to
    // fix properly because TP is static per station.
    tp_pending: Option<bool>,
    tp_count: u32,
    // TA is counted only on group 0, where bit 4 actually means TA — so this
    // tally advances far more slowly than TP's.
    ta_pending: Option<bool>,
    ta_count: u32,
    // RT+ (ODA, AID 0x4BD7). The group it rides in is NOT fixed by the standard —
    // the station announces it in a 3A group and may pick any type. WIBA uses 12A;
    // another station may use 11A. So the assignment is learned from the air per
    // station rather than hard-coded.
    rt_plus_group: Option<u8>,
    rt_plus_ver_b: bool,
    // An ODA assignment awaiting its repeat, and the last payload seen — both
    // gates exist because block B and blocks C/D carry no error protection.
    rt_plus_pending: Option<(u8, bool)>,
    rt_plus_last: Option<RtPlusPayload>,
}

impl Default for RdsDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl RdsDecoder {
    pub fn new() -> Self {
        Self {
            st: RdsState::default(),
            ps_buf: [' '; 8],
            ps_seen: 0,
            ps_candidate: String::new(),
            ps_seen_values: Vec::new(),
            ps_scrolling: false,
            rt_buf: [' '; 64],
            rt_seen: 0,
            rt_end: None,
            rt_end_seg: None,
            rt_ab: None,
            rt_candidate: String::new(),
            rt_published: false,
            pi_confirmed: None,
            pi_pending: None,
            pi_pending_count: 0,
            stat_groups: 0,
            stat_pi_mismatch: 0,
            q_ring: [0; QUALITY_RING],
            q_at: 0,
            q_count: 0,
            pty_pending: None,
            pty_count: 0,
            tp_pending: None,
            tp_count: 0,
            ta_pending: None,
            ta_count: 0,
            rt_plus_group: None,
            rt_plus_ver_b: false,
            rt_plus_pending: None,
            rt_plus_last: None,
        }
    }

    /// Drop all accumulated text and per-station tallies. NOT the retune call —
    /// that is `reset_for_retune`, and the app calls it on every frequency event.
    /// This one is the building block: `push` uses it when a persistent new PI
    /// displaces the old one, and `reset_for_retune` builds on it.
    ///
    /// `pi_confirmed` is deliberately NOT cleared, which is exactly why this is
    /// wrong for a retune on its own: the old PI would stand as an incumbent the
    /// new station has to outvote. Clearing it here instead would drop the
    /// decoder into the no-incumbent path where any 3-group run of corruption is
    /// adopted outright, with no trusted PI to outvote it. `st.pi` is re-asserted
    /// from `pi_confirmed` by the next matching group — see the equality branch in
    /// `push`.
    pub fn reset(&mut self) {
        self.st = RdsState::default();
        self.ps_buf = [' '; 8];
        self.ps_seen = 0;
        self.ps_candidate = String::new();
        self.ps_seen_values.clear();
        self.ps_scrolling = false;
        self.rt_buf = [' '; 64];
        self.rt_seen = 0;
        self.rt_end = None;
        self.rt_end_seg = None;
        self.rt_ab = None;
        self.rt_candidate = String::new();
        self.rt_published = false;
        self.pty_pending = None;
        self.pty_count = 0;
        self.tp_pending = None;
        self.tp_count = 0;
        self.ta_pending = None;
        self.ta_count = 0;
        // The ODA assignment belongs to the station, so it goes with the rest of
        // the station's state on a retune.
        self.rt_plus_group = None;
        self.rt_plus_ver_b = false;
        self.rt_plus_pending = None;
        self.rt_plus_last = None;
        self.q_ring = [0; QUALITY_RING];
        self.q_at = 0;
        self.q_count = 0;
    }

    pub fn state(&self) -> RdsState {
        self.st.clone()
    }

    pub fn stats(&self) -> Stats {
        Stats {
            groups: self.stat_groups,
            pi_mismatch: self.stat_pi_mismatch,
        }
    }

    /// Drop everything INCLUDING the trusted PI. For a RETUNE, where the dial
    /// moved and the old PI is known-stale rather than an incumbent worth
    /// defending.
    ///
    /// `reset()` deliberately keeps `pi_confirmed`, which is right for the
    /// station change `push` detects itself (it overwrites it on the next line
    /// anyway). It is wrong for a retune: the new station's PI became DISSENT
    /// needing PI_DISPLACE consecutive matches rather than the three it takes to
    /// acquire from nothing. Measured on the TypeScript original: 12 groups
    /// against 3 on a clean signal, and far worse on real air, where the pending
    /// count resets on any differing block A and the drive logs run 30-35%
    /// block-A errors. Worse than slow — `push` DROPS every group whose PI does
    /// not match the incumbent, so PS, RadioText, PTY and RT+ were all discarded
    /// for the whole window.
    ///
    /// The exposure this leaves — a three-group run of corruption adopted with no
    /// incumbent to outvote it — is exactly what the app already accepts every
    /// time it starts up on a station.
    pub fn reset_for_retune(&mut self) {
        self.reset();
        self.pi_confirmed = None;
        self.pi_pending = None;
        self.pi_pending_count = 0;
    }

    /// Drop TA only, keeping all sticky station state. For an RDS EXPIRY (the
    /// carrier went quiet), not a retune.
    ///
    /// Everything else the decoder holds is station identity worth restoring when
    /// the carrier returns — PS, RadioText, PI, PTY, TP. TA is the exception: it
    /// means "an announcement is happening RIGHT NOW", and after a multi-second
    /// gap that is no longer safe to assume. Dropping the tally too forces it to
    /// re-confirm from fresh group-0s rather than a caller's restore path
    /// resurrecting a `ta` left over from before the gap — and without clearing
    /// the tally, a still-running announcement could not re-publish either.
    pub fn clear_ta(&mut self) {
        self.st.ta = false;
        self.ta_pending = None;
        self.ta_count = 0;
    }

    pub fn reset_stats(&mut self) {
        self.stat_groups = 0;
        self.stat_pi_mismatch = 0;
    }

    /// Separate from `stats` on purpose: those counters are reset every 15s by the
    /// debug sampler, and a display sharing them would blank on every sample.
    pub fn quality(&self) -> Quality {
        if self.q_count < QUALITY_MIN {
            return Quality {
                pi_match_pct: None,
                samples: self.q_count,
            };
        }
        let good: u32 = self.q_ring[..self.q_count].iter().map(|&v| v as u32).sum();
        // f64, and `(100 * good)` FIRST — the TypeScript computes
        // `(100 * good) / qCount` in doubles, and the differential compares the
        // printed value, so the width and the operation order both matter.
        Quality {
            pi_match_pct: Some((100.0 * good as f64) / self.q_count as f64),
            samples: self.q_count,
        }
    }

    /// Feed one group as 16 hex chars. Returns the new state when a user-visible
    /// field changed, or `None` when nothing did — the common case, since the same
    /// group repeats many times per second.
    pub fn push(&mut self, hex: &str) -> Option<RdsState> {
        if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        if hex.bytes().all(|b| b == b'0') {
            return None; // "no group this poll"
        }
        self.stat_groups += 1; // well-formed and carrying something

        let word = |i: usize| u16::from_str_radix(&hex[i..i + 4], 16).unwrap_or(0);
        let (a, b, c, d) = (word(0), word(4), word(8), word(12));

        let before = self.st.clone();

        // ── PI consensus ────────────────────────────────────────────────────
        //
        // These groups arrive with NO error correction applied. On a real drive
        // (2026-08-01, WERN 88.7, true PI a6ff) block A came back as a6ff, a63e,
        // 2631, a699, a6b8, d86f, c6fe, 47ff, 26f5 … — most groups corrupt.
        //
        // PI is repeated in EVERY group precisely so a receiver can use it to
        // reject bad blocks, and treating each new value as a station change was
        // the single cause of four separate faults: accumulated PS/RT wiped on
        // every corrupt group, PTY republished from garbage, and a corrupt PI
        // reaching the callsign lookup (WIBA showing "KDTI-ROCHE…").

        // Ring the block-A outcome for the rolling quality figure. Done here
        // because this is where the decision already exists; no incumbent means
        // there is nothing to judge against yet, so those groups are not counted.
        if let Some(pi) = self.pi_confirmed {
            self.q_ring[self.q_at] = u8::from(a == pi);
            self.q_at = (self.q_at + 1) % QUALITY_RING;
            if self.q_count < QUALITY_RING {
                self.q_count += 1;
            }
        }

        match self.pi_confirmed {
            None => {
                if Some(a) == self.pi_pending {
                    self.pi_pending_count += 1;
                } else {
                    self.pi_pending = Some(a);
                    self.pi_pending_count = 1;
                }
                if self.pi_pending_count < PI_CONFIRM {
                    return None; // not yet trusted
                }
                self.pi_confirmed = Some(a);
                self.st.pi = Some(a);
            }
            Some(pi) if a != pi => {
                self.stat_pi_mismatch += 1;
                if Some(a) == self.pi_pending {
                    self.pi_pending_count += 1;
                } else {
                    self.pi_pending = Some(a);
                    self.pi_pending_count = 1;
                }
                if self.pi_pending_count < PI_DISPLACE {
                    return None; // corrupt block — drop it
                }
                // Persistent disagreement: a real station change.
                self.reset();
                self.pi_confirmed = Some(a);
                self.pi_pending = Some(a);
                self.pi_pending_count = PI_DISPLACE;
                self.st.pi = Some(a);
            }
            Some(pi) => {
                self.pi_pending_count = 0; // a good group resets the dissent counter
                                           // Re-assert after an external reset(), which rebuilds st from
                                           // blank but deliberately keeps pi_confirmed. Without this, every
                                           // later group carrying the same PI lands here and never rewrites
                                           // st.pi, so PI stays null for the rest of the session — and the
                                           // screen calls reset() on EVERY frequency event.
                if self.st.pi.is_none() {
                    self.st.pi = Some(pi);
                }
            }
        }

        // Block B needs the SAME treatment, independently. A correct PI does not
        // mean a correct header: on the same drive, groups carrying the true a6ff
        // reported PTY 22, 15, 6, 8, 17 and 5 — block A survived while block B did
        // not. That is the genre label flickering between random genres, and PI
        // consensus alone does not touch it.
        let group_type = ((b >> 12) & 0xf) as u8;
        let version_b = (b >> 11) & 1 == 1;
        let pty = ((b >> 5) & 0x1f) as u8;
        if Some(pty) == self.pty_pending {
            self.pty_count += 1;
        } else {
            self.pty_pending = Some(pty);
            self.pty_count = 1;
        }
        if self.pty_count >= PI_CONFIRM {
            self.st.pty = Some(pty);
        }

        // Voted separately — see tp_pending. Same threshold, its own tally.
        let tp = (b >> 10) & 1 == 1;
        if Some(tp) == self.tp_pending {
            self.tp_count += 1;
        } else {
            self.tp_pending = Some(tp);
            self.tp_count = 1;
        }
        if self.tp_count >= PI_CONFIRM {
            self.st.tp = tp;
            // TA is conditioned on TP, so losing TP has to drop a latched TA with
            // it — otherwise a retune onto a non-traffic station could inherit the
            // previous one's announcement until the next group 0 arrives.
            if !tp {
                self.st.ta = false;
            }
        }

        if group_type == 0 {
            self.push_ps(b, d);
        } else if group_type == 2 {
            self.push_rt(b, c, d, version_b);
        }

        self.push_rt_plus(b, c, d, group_type, version_b);

        if self.st == before {
            None
        } else {
            Some(self.st.clone())
        }
    }

    /// 0A / 0B — Programme Service name. Two chars per group in block D, and the
    /// segment index is the low 2 bits. TA rides in bit 4 of the same block as
    /// PTY, so it inherits the same trust gate.
    fn push_ps(&mut self, b: u16, d: u16) {
        // Bit 4 carries TA here, and ONLY here: the same bit in a 2A group is the
        // RadioText A/B flag.
        let ta = (b >> 4) & 1 == 1;
        if Some(ta) == self.ta_pending {
            self.ta_count += 1;
        } else {
            self.ta_pending = Some(ta);
            self.ta_count = 1;
        }
        // st.tp, not the raw bit: a station that carries no traffic cannot be
        // announcing any. An unconfirmed TP suppresses TA too, which costs
        // nothing — TP is static and confirms off any three groups.
        if self.ta_count >= PI_CONFIRM {
            self.st.ta = self.st.tp && ta;
        }
        let seg = (b & 0x3) as usize;
        self.ps_buf[seg * 2] = chr((d >> 8) as u8);
        self.ps_buf[seg * 2 + 1] = chr((d & 0xff) as u8);
        self.ps_seen |= 1 << seg;
        if self.ps_seen != 0b1111 {
            return;
        }
        // Publish only when two CONSECUTIVE complete assemblies agree.
        //
        // Without this the display churns: segments keep arriving after the first
        // complete fill, so each one republishes a buffer that is half the old name
        // and half the new. Observed on device 2026-08-01 — "The load", "The cyad",
        // "Aue cy", "Auda94.9", "WOda94.9" before settling on "WOLX94.9".
        let cand: String = self.ps_buf.iter().collect();
        if cand == self.ps_candidate {
            // A repeated complete assembly. That used to be proof of a name; on a
            // slow scroller it only proves the chunk was held for a few seconds.
            // Count the distinct ones and stop trusting PS entirely once there are
            // too many — including retracting what was already shown, because those
            // earlier chunks were never a name either.
            let val = cand.trim().to_string();
            if !self.ps_scrolling {
                if !self.ps_seen_values.contains(&val) {
                    self.ps_seen_values.push(val.clone());
                }
                if self.ps_seen_values.len() >= PS_SCROLL_DISTINCT {
                    self.ps_scrolling = true;
                    self.st.ps_scrolling = true;
                    self.st.ps = String::new();
                } else {
                    self.st.ps = val;
                }
            }
        }
        self.ps_candidate = cand;
        // Start a clean cycle so the next assembly cannot inherit stale chars.
        self.ps_seen = 0;
        self.ps_buf = [' '; 8];
    }

    /// 2A / 2B — RadioText. 2A carries 4 chars (blocks C and D) at segment×4; 2B
    /// carries 2 chars (block D only) at segment×2, with block C repeating PI.
    fn push_rt(&mut self, b: u16, c: u16, d: u16, version_b: bool) {
        let seg = b & 0xf;
        let ab = ((b >> 4) & 1) as u8;
        if self.rt_ab.is_some() && Some(ab) != self.rt_ab {
            // A/B flipped: the broadcaster is starting a new message. Any RT+
            // markers we hold point into the OLD string and are meaningless
            // against the new one, so they go with it.
            self.st.rt_artist = String::new();
            self.st.rt_title = String::new();
            self.rt_buf = [' '; 64];
            self.rt_seen = 0;
            self.rt_end = None;
            self.rt_end_seg = None;
            self.rt_candidate = String::new();
            self.rt_published = false; // a genuinely new message shows at once
        }
        self.rt_ab = Some(ab);

        let bytes: &[u8] = &if version_b {
            vec![(d >> 8) as u8, (d & 0xff) as u8]
        } else {
            vec![
                (c >> 8) as u8,
                (c & 0xff) as u8,
                (d >> 8) as u8,
                (d & 0xff) as u8,
            ]
        };
        let base = if version_b { seg * 2 } else { seg * 4 } as usize;

        for (i, &byte) in bytes.iter().enumerate() {
            let at = base + i;
            if at >= 64 {
                continue;
            }
            // 0x0D ends the message. This MUST be tested on the RAW byte: chr()
            // folds every non-printable to a space, so sanitising first would
            // erase the terminator and the message would never publish.
            if byte == 0x0d {
                if self.rt_end.is_none() || at < self.rt_end.unwrap() {
                    self.rt_end = Some(at);
                    self.rt_end_seg = Some(seg);
                }
                continue;
            }
            self.rt_buf[at] = chr(byte);
        }
        self.rt_seen |= 1 << seg;

        // Same two-cycle rule as PS, and for the same reason. A terminator only
        // means "the message ends here" — it says nothing about whether the
        // segments BEFORE it ever arrived. Acquisition genuinely lands mid-cycle,
        // so publishing on the terminator alone put a fragment on the plate after
        // every retune: segments 2,3 then a CR in segment 4 rendered as "tta
        // Love". Require every segment up to the terminator's own.
        // In u32: a terminator in segment 15 makes the shift amount 16, which
        // overflows a u16 — JavaScript's `(1 << 16) - 1` is what this mirrors.
        let end_mask = match self.rt_end_seg {
            None => 0u16,
            Some(s) => ((1u32 << (s + 1)) - 1) as u16,
        };
        let terminated_and_complete =
            self.rt_end_seg.is_some() && (self.rt_seen & end_mask) == end_mask;
        if !terminated_and_complete && self.rt_seen != 0xffff {
            return;
        }
        let upto = self.rt_end.unwrap_or(64);
        let msg: String = self.rt_buf[..upto]
            .iter()
            .collect::<String>()
            .trim_end()
            .to_string();
        // FIRST FILL IS INSTANT, REPLACEMENTS MUST REPEAT.
        //
        // Blocks C and D carry the text itself and nothing protects them: PI
        // consensus guards block A, PTY consensus guards block B, and the
        // characters have no error check at all. On 2026-08-03, 44 of WERN's 83
        // RadioText publishes were corrupt — "Wisconsin PuAoic Radio", "Wisc h yn
        // Public Radio" — every one shown to the driver.
        //
        // Requiring two agreeing cycles for EVERYTHING was the previous rule and
        // it was the "RadioText took forever" complaint, so it only applies to
        // replacements. Corruption is random, so a corrupt assembly essentially
        // never repeats; a real message change costs one extra cycle.
        if !self.rt_published {
            self.st.rt = msg.clone();
            self.rt_published = true;
        } else if msg != self.st.rt && msg == self.rt_candidate {
            self.st.rt = msg.clone();
        }
        // Always the LAST assembly seen, agreeing or not — otherwise a stale
        // candidate could later be confirmed by an unrelated repeat.
        self.rt_candidate = msg;
        self.rt_seen = 0;
        self.rt_end = None;
        self.rt_end_seg = None;
        self.rt_buf = [' '; 64];
    }

    /// RT+ — 3A announces which group carries an ODA and which application it is.
    /// The five low bits of block B are the application group type: four bits of
    /// group number and one of version. Block D is the AID.
    fn push_rt_plus(&mut self, b: u16, c: u16, d: u16, group_type: u8, version_b: bool) {
        if group_type == 3 && !version_b {
            if d == RTPLUS_AID {
                let agt = (b & 0x1f) as u8;
                let group = agt >> 1;
                let ver_b = agt & 1 == 1;
                // THE AID PROVES BLOCK D, NOT BLOCK B. The 1-in-65536 argument
                // for trusting a single announcement covers the application id
                // only; the group NUMBER rides in block B's low bits with no
                // protection at all. A 3A with an intact AID and a corrupted
                // block B pointed RT+ at group 0A, after which ordinary PS
                // groups were parsed as RT+ payloads and set the artist from a
                // slice of the RadioText. Two guards, matching what every other
                // field here already has:
                if !oda_group_is_legal(group, ver_b) {
                    return; // the standard defines that group; it cannot be an ODA
                }
                if self.rt_plus_pending == Some((group, ver_b)) {
                    self.rt_plus_group = Some(group);
                    self.rt_plus_ver_b = ver_b;
                } else {
                    self.rt_plus_pending = Some((group, ver_b));
                }
            }
            return;
        }
        if self.rt_plus_group != Some(group_type) || version_b != self.rt_plus_ver_b {
            return;
        }
        // The payload is 37 bits spread across the five spare bits of B and all of
        // C and D: a toggle, a running flag, then two (content type, start,
        // length) triplets. Length markers are one less than the real length.
        let running = (b >> 3) & 1 == 1;
        let ct1 = ((((b & 0x7) << 3) | (c >> 13)) & 0x3f) as u8;
        let start1 = ((c >> 7) & 0x3f) as usize;
        let len1 = ((c >> 1) & 0x3f) as usize + 1;
        let ct2 = ((((c & 0x1) << 5) | (d >> 11)) & 0x3f) as u8;
        let start2 = ((d >> 5) & 0x3f) as usize;
        let len2 = (d & 0x1f) as usize + 1;
        // THE PAYLOAD NEEDS THE SAME TREATMENT. Blocks C and D carry the offsets
        // and nothing protects them — the very reason RadioText requires two
        // agreeing cycles. Unguarded, one corrupt group rewrote the artist from
        // "LED ZEPPELIN" to "EPPELIN", and a corrupt running bit blanked both
        // tags. Act only on a payload that has repeated, which costs one group
        // (~a second) against an item that runs for minutes.
        let payload = (running, ct1, start1, len1, ct2, start2, len2);
        if self.rt_plus_last != Some(payload) {
            self.rt_plus_last = Some(payload);
            return;
        }
        if !running {
            // The item has ENDED. Keeping the last song on screen over the next
            // one is the same staleness the rest of this decoder works to avoid.
            self.st.rt_artist = String::new();
            self.st.rt_title = String::new();
            return;
        }
        if !self.rt_published || self.st.rt.is_empty() {
            return;
        }
        // Offsets index into the RadioText AS TRANSMITTED. Applying them to a
        // half-assembled or corrupt string yields confident nonsense, so this only
        // ever runs against text that has passed the publish gate — and even then
        // a marker running off the end is rejected rather than clamped, because a
        // truncated artist is still a wrong artist.
        for (ct, start, len) in [(ct1, start1, len1), (ct2, start2, len2)] {
            let Some(v) = self.rt_slice(start, len) else {
                continue;
            };
            if ct == RTPLUS_ARTIST {
                self.st.rt_artist = v;
            } else if ct == RTPLUS_TITLE {
                self.st.rt_title = v;
            }
        }
    }

    fn rt_slice(&self, start: usize, len: usize) -> Option<String> {
        if start + len > self.st.rt.len() {
            return None;
        }
        let v = self.st.rt.get(start..start + len)?.trim().to_string();
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }
}
