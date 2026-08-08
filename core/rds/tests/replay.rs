//! The decoder's trust gates, replayed. A SELECTION ported from
//! `tools/tests/nwdRds.test.mjs` — full TS-vs-Rust equivalence is the
//! differential harness's job (`npm run test:rds-diff`), so what lives here is
//! the gates a refactor is most likely to loosen, plus Rust-specific
//! regressions the TypeScript cannot have. The hex groups are real captures
//! from the drive logs wherever a capture exists. If the Rust decoder disagrees
//! with any assertion here, it has diverged from the behaviour the logs justify
//! and the TypeScript one must stay.

use carfm_rds::RdsDecoder;

fn feed(d: &mut RdsDecoder, groups: &[&str], times: usize) {
    for _ in 0..times {
        for g in groups {
            d.push(g);
        }
    }
}

/// Groups are dropped until a PI has been seen PI_CONFIRM times, and block B is
/// gated separately — the pushes that establish the PI return before block B is
/// ever read, so PTY/TP need their own repeats after that. Five clears both.
fn prime(group: &str) -> RdsDecoder {
    let mut d = RdsDecoder::new();
    for _ in 0..5 {
        d.push(group);
    }
    d
}

/// Real capture, PI a6ff. Four segments assembling "  WERN  ".
const PS_WERN: [&str; 4] = [
    "a6ff02c0e0cd2020", // seg 0 → chars 0,1 = "  "
    "a6ff02c5e0cd5745", // seg 1 → chars 2,3 = "WE"
    "a6ff02c2e0cd524e", // seg 2 → chars 4,5 = "RN"
    "a6ff02c7e0cd2020", // seg 3 → chars 6,7 = "  "
];

#[test]
fn ps_publishes_only_when_two_cycles_agree() {
    let mut d = prime(PS_WERN[0]);
    feed(&mut d, &PS_WERN, 1);
    assert_eq!(d.state().ps, "", "one complete cycle is not enough");
    feed(&mut d, &PS_WERN, 1);
    assert_eq!(d.state().ps, "WERN", "a second agreeing cycle publishes");
    assert_eq!(d.state().pi, Some(0xa6ff), "PI comes from block A");
    assert_eq!(d.state().pty, Some(22), "PTY comes from block B bits 9-5");
    assert!(!d.state().tp, "TP is false for this station");
}

#[test]
fn an_incomplete_assembly_never_publishes() {
    let mut d = prime(PS_WERN[0]);
    feed(&mut d, &PS_WERN[..3], 4);
    assert_eq!(d.state().ps, "");
}

/// REGRESSION — a fast scrolling PS. Station 19e2 cycles its name as advertising
/// copy; the first build showed every frame of it, overwriting the hero card.
#[test]
fn a_ps_that_never_repeats_is_never_published() {
    let mut d = prime("19e202c020204942");
    let scroll: [[&str; 4]; 2] = [
        [
            "19e202c020204942",
            "19e202c1312e3520",
            "19e202c220204942",
            "19e202c3412d3520",
        ],
        [
            "19e202c020204942",
            "19e202c1412d464d",
            "19e202c220203130",
            "19e202c3412d464d",
        ],
    ];
    for i in 0..6 {
        feed(&mut d, &scroll[i % 2], 1);
    }
    assert_eq!(d.state().ps, "");
}

/// Build the four 0A groups that spell an 8-char PS for PI 19e2.
fn ps_groups(text: &str) -> Vec<String> {
    let mut t: Vec<u8> = text.bytes().collect();
    t.resize(8, b' ');
    (0..4u16)
        .map(|seg| {
            let b = 0x04c0u16 | seg;
            let s = seg as usize;
            let d = ((t[s * 2] as u16) << 8) | t[s * 2 + 1] as u16;
            format!("19e2{b:04x}e0cd{d:04x}")
        })
        .collect()
}

/// REGRESSION — a SLOW scrolling PS. The two-cycle rule assumed a scroller never
/// repeats a complete assembly, which holds only if it scrolls fast. WIBA-FM
/// holds each 8-character chunk for about four seconds — many complete assemblies
/// — so every chunk cleared the rule and published. On 2026-08-04 it put "Walk",
/// "This Way", "Aerosmit", "NicoletL", "Law.com" and eleven more onto the hero in
/// place of the station logo.
///
/// Measured that day: WIBA 16 distinct PS values, WERN 1, WWHG 1.
#[test]
fn a_slow_scroller_is_caught_and_retracted() {
    let first = ps_groups("Walk");
    let mut d = prime(&first[0]);

    let hold = |d: &mut RdsDecoder, text: &str| {
        let g = ps_groups(text);
        let refs: Vec<&str> = g.iter().map(String::as_str).collect();
        feed(d, &refs, 3);
    };

    hold(&mut d, "Walk");
    assert_eq!(d.state().ps, "Walk", "the first held chunk still publishes");
    assert!(!d.state().ps_scrolling);

    hold(&mut d, "This Way");
    assert_eq!(d.state().ps, "This Way", "so does the second");

    // The third distinct value is the verdict, and it RETRACTS what was shown —
    // those earlier chunks were never a name either.
    hold(&mut d, "Aerosmit");
    assert!(
        d.state().ps_scrolling,
        "three distinct values means scrolling"
    );
    assert_eq!(d.state().ps, "", "and the earlier chunks are withdrawn");

    hold(&mut d, "NicoletL");
    assert_eq!(d.state().ps, "", "the verdict sticks");
}

/// REGRESSION — PI consensus. On 2026-08-01, WERN's true a6ff arrived alongside
/// a63e, 2631, a699, d86f, c6fe … Treating each as a station change wiped the
/// accumulated PS and RT on every corrupt group.
#[test]
fn scattered_corrupt_pis_do_not_wipe_the_station() {
    let mut d = prime(PS_WERN[0]);
    feed(&mut d, &PS_WERN, 2);
    assert_eq!(d.state().ps, "WERN");

    for bad in ["a63e02c0e0cd2020", "263102c0e0cd2020", "d86f02c0e0cd2020"] {
        d.push(bad);
    }
    assert_eq!(d.state().ps, "WERN", "the name survives the corruption");
    assert_eq!(d.state().pi, Some(0xa6ff), "and so does the trusted PI");
}

/// A PERSISTENT disagreement is a real station change, and takes PI_DISPLACE
/// groups rather than the three it takes to acquire from nothing.
#[test]
fn a_persistent_new_pi_displaces_the_old_one() {
    let mut d = prime(PS_WERN[0]);
    feed(&mut d, &PS_WERN, 2);
    assert_eq!(d.state().pi, Some(0xa6ff));

    for _ in 0..11 {
        d.push("19e202c0e0cd2020");
    }
    assert_eq!(d.state().pi, Some(0xa6ff), "eleven is not enough");
    d.push("19e202c0e0cd2020");
    assert_eq!(d.state().pi, Some(0x19e2), "the twelfth displaces it");
    assert_eq!(d.state().ps, "", "and the old station's text goes with it");
}

/// Block B is corrupted independently of block A: groups carrying the true a6ff
/// reported PTY 22, 15, 6, 8, 17 and 5 on one drive.
#[test]
fn a_burst_of_one_off_ptys_never_reaches_the_label() {
    let mut d = prime(PS_WERN[0]);
    assert_eq!(d.state().pty, Some(22));
    for bad in ["a6ff01e0e0cd2020", "a6ff00c0e0cd2020", "a6ff0220e0cd2020"] {
        d.push(bad);
    }
    assert_eq!(d.state().pty, Some(22), "a single odd PTY is not adopted");
}

#[test]
fn malformed_input_is_refused() {
    let mut d = RdsDecoder::new();
    assert!(d.push("").is_none());
    assert!(d.push("a6ff02c0e0cd20").is_none(), "too short");
    assert!(d.push("zzzz02c0e0cd2020").is_none(), "not hex");
    assert!(d.push("0000000000000000").is_none(), "no group this poll");
    assert_eq!(d.stats().groups, 0, "none of those count as a group");
}

/// The rolling figure stays silent until it has enough outcomes to mean
/// anything. A station delivering almost nothing must not read as flawless.
#[test]
fn quality_is_silent_below_the_floor() {
    let mut d = prime(PS_WERN[0]);
    assert_eq!(
        d.quality().pi_match_pct,
        None,
        "5 groups is under the floor"
    );
    for _ in 0..20 {
        d.push(PS_WERN[0]);
    }
    let q = d.quality();
    assert!(q.samples >= 16);
    assert_eq!(q.pi_match_pct, Some(100.0), "every block A matched");
}

// ── RT+ ──────────────────────────────────────────────────────────────────────
// WIBA's 3A is verbatim from the log of 2026-08-01: 19e2 34d8 0000 4bd7. The
// payload groups are synthesised, because 12A itself was never captured — only
// the announcement that 12A is where RT+ lives.

fn hex(a: u16, b: u16, c: u16, d: u16) -> String {
    format!("{a:04x}{b:04x}{c:04x}{d:04x}")
}

// ── RadioText, the last segment ──────────────────────────────────────────────
// A 0x0D terminator in SEGMENT 15 makes the completeness mask cover all sixteen
// segments. JavaScript computes that as (1 << 16) - 1 = 0xFFFF; the u16 port
// overflowed the shift — a panic under cargo test's debug profile, a phantom
// empty publish in release. Both tests are regressions for that fix.

#[test]
fn a_lone_terminator_in_the_last_segment_neither_panics_nor_publishes() {
    const PI: u16 = 0xa6ff;
    let mut d = prime(&hex(PI, 0x0000, 0x0000, 0x2020));
    // Segment 15, CR at position 62, every earlier segment missing.
    d.push(&hex(PI, 0x200f, 0x2020, 0x0d20));
    assert_eq!(
        d.state().rt,
        "",
        "a lone terminated segment is not a message"
    );
}

#[test]
fn a_message_terminating_in_the_last_segment_publishes_whole() {
    const PI: u16 = 0xa6ff;
    const MSG: &[u8] = b"Whole Lotta Love - Led Zeppelin - Royal Albert Hall, early set";
    let mut d = prime(&hex(PI, 0x0000, 0x0000, 0x2020));
    for seg in 0..16u16 {
        let ch = |k: usize| {
            let at = seg as usize * 4 + k;
            if at == 62 {
                0x0d
            } else {
                *MSG.get(at).unwrap_or(&b' ') as u16
            }
        };
        d.push(&hex(
            PI,
            0x2000 | seg,
            (ch(0) << 8) | ch(1),
            (ch(2) << 8) | ch(3),
        ));
    }
    assert_eq!(
        d.state().rt,
        std::str::from_utf8(MSG).unwrap().trim_end(),
        "first fill publishes on the terminator's own segment"
    );
}

/// Lay down a RadioText the offsets can point into, and let it publish.
fn rt_plus_fixture() -> RdsDecoder {
    const PI: u16 = 0x19e2;
    const RT: &[u8] = b"Led Zeppelin - Kashmir\r";
    let mut d = prime(&hex(PI, 0x0000, 0x0000, 0x2020));
    for _ in 0..2 {
        for seg in 0..6u16 {
            let ch = |k: usize| *RT.get(seg as usize * 4 + k).unwrap_or(&b' ') as u16;
            d.push(&hex(
                PI,
                0x2000 | seg,
                (ch(0) << 8) | ch(1),
                (ch(2) << 8) | ch(3),
            ));
        }
    }
    d
}

#[test]
fn rt_plus_labels_artist_and_title() {
    const PI: u16 = 0x19e2;
    let mut d = rt_plus_fixture();
    assert_eq!(d.state().rt, "Led Zeppelin - Kashmir");
    assert_eq!(
        d.state().rt_artist,
        "",
        "not claimed before it is announced"
    );

    // WIBA's ACTUAL announcement. 0x34d8 → group 3A, and the low five bits
    // (0x18 = 24) say group 12, version A. Group 12 has no use fixed by the
    // standard, so it is a legal ODA carrier — but one announcement is not
    // enough, because the group number rides in block B unprotected.
    d.push("19e234d800004bd7");

    // Group 12A payload: running=1, artist @0 len 12, title @15 len 7.
    let b = 0xc000u16 | (1 << 3);
    // (0 << 7) is the zero start offset — kept so the field layout stays visible.
    #[allow(clippy::identity_op)]
    let c = (0b100u16 << 13) | (0 << 7) | (11 << 1);
    let dd = (1u16 << 11) | (15 << 5) | 6;
    d.push(&hex(PI, b, c, dd));
    d.push(&hex(PI, b, c, dd));
    assert_eq!(
        d.state().rt_artist,
        "",
        "a single announcement does not assign the group"
    );

    d.push("19e234d800004bd7"); // announced again — now the group is assigned

    d.push(&hex(PI, b, c, dd));
    assert_eq!(
        d.state().rt_artist,
        "",
        "nor does a single payload group publish"
    );
    d.push(&hex(PI, b, c, dd));
    assert_eq!(
        d.state().rt_artist,
        "Led Zeppelin",
        "the repeat publishes it"
    );
    assert_eq!(d.state().rt_title, "Kashmir");

    // running=0 means the item ENDED — gated the same way, so a lone corrupt
    // group cannot blank a running item.
    d.push(&hex(PI, 0xc000, c, dd));
    assert_eq!(
        d.state().rt_artist,
        "Led Zeppelin",
        "one group does not end it"
    );
    d.push(&hex(PI, 0xc000, c, dd));
    assert_eq!(d.state().rt_artist, "", "an ended item clears the artist");
    assert_eq!(d.state().rt_title, "", "and the title");

    // A marker running off the end is REJECTED, not clamped — a truncated artist
    // is still a wrong artist.
    d.push(&hex(PI, b, c, dd));
    d.push(&hex(PI, b, c, dd));
    assert_eq!(d.state().rt_artist, "Led Zeppelin");
    let far_c = (0b100u16 << 13) | (60 << 7) | (11 << 1);
    d.push(&hex(PI, b, far_c, dd));
    d.push(&hex(PI, b, far_c, dd));
    assert_eq!(
        d.state().rt_artist,
        "Led Zeppelin",
        "out of range is refused"
    );
}

/// REGRESSION — an ODA announcement naming a group the standard already defines
/// is a corrupted announcement, not a station being unusual.
///
/// Measured: a 3A carrying an intact AID with a corrupted block B pointed RT+ at
/// group 0A. Ordinary PS groups then satisfied the payload branch — M/S set is
/// the "running" bit, and a normal AF pair in block C decodes as an ARTIST
/// marker — so the artist was set from a slice of the RadioText.
#[test]
fn an_oda_announced_on_a_defined_group_is_refused() {
    const PI: u16 = 0x19e2;
    let mut d = rt_plus_fixture();
    assert_eq!(d.state().rt, "Led Zeppelin - Kashmir");

    // 3A, correct AID, low five bits 0 → "RT+ lives in group 0A". Twice, so it
    // is the LEGALITY check being tested and not the repeat check.
    d.push(&hex(PI, 0x3000, 0x0000, 0x4bd7));
    d.push(&hex(PI, 0x3000, 0x0000, 0x4bd7));

    // Ordinary 0A groups: M/S set, a real AF pair (100.3 + 89.6 MHz) in block C.
    let ps = hex(PI, 0x0008, 0x8016, 0x2020);
    d.push(&ps);
    d.push(&ps);
    assert_eq!(d.state().rt_artist, "", "a PS group is not an RT+ payload");
    assert_eq!(d.state().rt_title, "");
}

#[test]
fn a_non_rt_plus_oda_declaration_is_ignored() {
    const PI: u16 = 0x19e2;
    let mut d = rt_plus_fixture();
    d.push(&hex(PI, 0x34d8, 0x0000, 0x1234)); // some other AID in the same slot
    let b = 0xc000u16 | (1 << 3);
    // (0 << 7) is the zero start offset — kept so the field layout stays visible.
    #[allow(clippy::identity_op)]
    let c = (0b100u16 << 13) | (0 << 7) | (11 << 1);
    let dd = (1u16 << 11) | (15 << 5) | 6;
    d.push(&hex(PI, b, c, dd));
    assert_eq!(d.state().rt_artist, "");
}

/// reset() empties the station's text but deliberately KEEPS the trusted PI —
/// clearing it would drop the decoder into the no-incumbent path where any
/// 3-group run of corruption is adopted outright.
#[test]
fn reset_keeps_the_trusted_pi_and_re_asserts_it() {
    let mut d = prime(PS_WERN[0]);
    feed(&mut d, &PS_WERN, 2);
    assert_eq!(d.state().ps, "WERN");

    d.reset();
    assert_eq!(d.state().ps, "", "text is gone");
    assert_eq!(d.state().pi, None, "and the published PI with it");

    d.push(PS_WERN[0]);
    assert_eq!(
        d.state().pi,
        Some(0xa6ff),
        "one matching group re-asserts it"
    );
}

// ─── TP and TA: the guards, one at a time ────────────────────────────────────
// Ported from the current tools/tests/nwdRds.test.mjs. These cover behaviour the
// FIRST cut of this port predates: it was forked at 92a6f0c and the TypeScript
// decoder gained TP's own consensus, TA's three guards, reset_for_retune and
// clear_ta afterwards. Without these the port passes its own suite while quietly
// reintroducing four fixed bugs.

const PI_A6FF: u16 = 0xa6ff;

fn hx(a: u16, b: u16, c: u16, d: u16) -> String {
    format!("{a:04x}{b:04x}{c:04x}{d:04x}")
}
/// Group 0A. TP is bit 10, TA bit 4, PTY bits 9-5, segment in bits 1-0.
fn g0(tp: u16, ta: u16, seg: u16) -> String {
    hx(
        PI_A6FF,
        (tp << 10) | (0x16 << 5) | (ta << 4) | seg,
        0x0000,
        0x2020,
    )
}
/// Group 2A. Bit 4 here is the RadioText A/B flag, NOT TA.
fn g2(tp: u16, bit4: u16) -> String {
    hx(
        PI_A6FF,
        (2 << 12) | (tp << 10) | (0x16 << 5) | (bit4 << 4),
        0x2020,
        0x2020,
    )
}

#[test]
fn tp_needs_its_own_consensus_not_the_pty_fields() {
    let mut d = RdsDecoder::new();
    for i in 0..8 {
        d.push(&g0(0, 0, i % 4));
    }
    assert!(!d.state().tp, "TP starts clear");
    // Bit 10 set, PTY bits untouched: the PTY gate is satisfied throughout, so
    // only TP's own tally can hold this back.
    d.push(&g0(1, 0, 0));
    assert!(!d.state().tp, "one group must not move TP");
    d.push(&g0(1, 0, 1));
    assert!(!d.state().tp, "nor two");
    d.push(&g0(1, 0, 2));
    assert!(d.state().tp, "three consecutive do");
    d.push(&g0(0, 0, 3));
    assert!(d.state().tp, "and one contrary group does not clear it");
}

#[test]
fn ta_is_only_read_from_group_zero() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(1, 0, i % 4));
    }
    assert!(d.state().tp, "TP confirmed");
    assert!(!d.state().ta, "TA starts clear");
    for _ in 0..10 {
        d.push(&g2(1, 1)); // bit 4 set, but in a RadioText group
    }
    assert!(
        !d.state().ta,
        "bit 4 in a 2A is the text A/B flag, never TA"
    );
}

#[test]
fn ta_needs_its_own_consensus() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(1, 0, i % 4));
    }
    d.push(&g0(1, 1, 0));
    assert!(!d.state().ta, "one group-0 with TA does not raise it");
    d.push(&g0(1, 1, 1));
    assert!(!d.state().ta, "nor two");
    d.push(&g0(1, 1, 2));
    assert!(d.state().ta, "three consecutive do");
    d.push(&g0(1, 0, 3));
    assert!(d.state().ta, "one contrary group does not clear it");
    d.push(&g0(1, 0, 0));
    d.push(&g0(1, 0, 1));
    assert!(!d.state().ta, "three consecutive clear it");
}

#[test]
fn ta_is_suppressed_without_a_confirmed_tp() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(0, 0, i % 4)); // TP off, confirmed
    }
    assert!(!d.state().tp);
    for i in 0..6 {
        d.push(&g0(0, 1, i % 4)); // TA claimed anyway
    }
    assert!(
        !d.state().ta,
        "a station carrying no traffic cannot be announcing"
    );
}

#[test]
fn losing_tp_drops_a_latched_ta() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(1, 1, i % 4));
    }
    assert!(d.state().ta, "TA latches on a traffic station");
    for i in 0..4 {
        d.push(&g0(0, 1, i % 4));
    }
    assert!(!d.state().ta, "and drops when TP goes away");
}

#[test]
fn reset_clears_ta_so_a_retune_cannot_inherit_an_announcement() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(1, 1, i % 4));
    }
    assert!(d.state().ta);
    d.reset();
    assert!(!d.state().ta);
}

// ─── reset_for_retune: the PI blackout ───────────────────────────────────────

#[test]
fn reset_for_retune_drops_the_pi_so_the_new_station_acquires_fast() {
    const A: &str = "a6ff02c0e0cd2020"; // PI a6ff
    const B: &str = "57ff02c0e0cd2020"; // a different station
    let acquire = |d: &mut RdsDecoder| {
        let mut n = 0;
        while d.state().pi != Some(0x57ff) && n < 400 {
            d.push(B);
            n += 1;
        }
        n
    };

    let mut fresh = RdsDecoder::new();
    let from_empty = acquire(&mut fresh);
    assert_eq!(
        from_empty, 3,
        "a fresh decoder acquires in PI_CONFIRM groups"
    );

    let mut kept = RdsDecoder::new();
    for _ in 0..8 {
        kept.push(A);
    }
    kept.reset();
    assert_eq!(
        acquire(&mut kept),
        12,
        "reset() keeps the incumbent: displacement"
    );

    let mut cleared = RdsDecoder::new();
    for _ in 0..8 {
        cleared.push(A);
    }
    cleared.reset_for_retune();
    assert_eq!(
        acquire(&mut cleared),
        from_empty,
        "reset_for_retune: fast path"
    );

    let mut wiped = RdsDecoder::new();
    for _ in 0..8 {
        wiped.push(A);
    }
    wiped.reset_for_retune();
    assert_eq!(wiped.state().rt, "", "and it still empties the text");
    assert_eq!(wiped.state().pi, None, "and the PI itself");
}

// ─── clear_ta: the RDS-expiry path ───────────────────────────────────────────

#[test]
fn clear_ta_drops_the_announcement_but_keeps_the_station() {
    let mut d = RdsDecoder::new();
    for i in 0..6 {
        d.push(&g0(1, 1, i % 4));
    }
    assert!(d.state().ta, "set before the expiry");
    d.clear_ta();
    assert!(!d.state().ta, "cleared, so a caller's restore reads false");
    assert!(d.state().tp, "TP is sticky station state and stays");

    // Still running: it must re-confirm rather than stay stuck off.
    let mut back = None;
    for i in 0..5 {
        d.push(&g0(1, 1, i % 4));
        if d.state().ta && back.is_none() {
            back = Some(i + 1);
        }
    }
    assert_eq!(back, Some(3), "re-confirms after PI_CONFIRM group-0s");

    // Ended during the gap: TA=0 groups keep it off.
    let mut d2 = RdsDecoder::new();
    for i in 0..6 {
        d2.push(&g0(1, 1, i % 4));
    }
    d2.clear_ta();
    for i in 0..4 {
        d2.push(&g0(1, 0, i % 4));
    }
    assert!(!d2.state().ta, "an ended announcement stays off");
}
