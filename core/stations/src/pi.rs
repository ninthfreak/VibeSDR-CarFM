//! RBDS PI code <-> callsign (North America), per NRSC-4-B.
//!
//! Ported from src/services/piCallsign.ts, which stays the reference. Read that
//! file's header for why a PI-derived callsign is a HINT and not truth — three
//! letter callsigns use a table, translators are not compatible with the formula
//! at all, and some encoders transmit a default or plainly wrong code.
//!
//! Verify against the reference calculators when changing this:
//!   https://caseymediallc.com/rds   and   https://db.wtfda.org/rds2.html
//! and against NRSC-4-B itself.

/// K/W block bases (decimal), NRSC-4-B.
const K_BASE: u16 = 4096; // 0x1000
const W_BASE: u16 = 21672; // 0x54A8
/// Max offset a 4-letter suffix can encode: 25*676 + 25*26 + 25.
const MAX_SUFFIX: u16 = 25 * 676 + 25 * 26 + 25; // 17575
/// The "second nibble = 0" PI values are reassigned into the 0xA000 block by the
/// standard; we detect but do not invert that remap — flagged low-confidence.
const A_BLOCK_LO: u16 = 0xa000;
const A_BLOCK_HI: u16 = 0xafff;

/// Three-letter callsigns (KOB, WHO, WGN) carry fixed PI codes from NRSC-4-B
/// Annex D, not the formula. Intentionally empty, matching the TypeScript: until
/// it is filled from the authoritative Annex D a three-letter PI decodes as
/// "unknown" rather than guessing a wrong callsign.
pub const THREE_LETTER_PI: &[(u16, &str)] = &[
    // (0x____, "KOB"), ...
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiMethod {
    Formula,
    ThreeLetter,
    None,
}

impl PiMethod {
    /// The wire spelling the TypeScript uses, so the two dumps can be diffed.
    pub fn as_str(self) -> &'static str {
        match self {
            PiMethod::Formula => "formula",
            PiMethod::ThreeLetter => "three-letter",
            PiMethod::None => "none",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PiDecode {
    /// Computed callsign (4- or 3-letter), or None if the PI can't be decoded.
    pub callsign: Option<String>,
    pub method: PiMethod,
    /// True only for a clean formula/table decode.
    pub confident: bool,
    /// Human-readable reason when not confident.
    pub note: Option<String>,
}

impl PiDecode {
    fn none(note: &str) -> Self {
        PiDecode {
            callsign: None,
            method: PiMethod::None,
            confident: false,
            note: Some(note.to_string()),
        }
    }
}

/// `/^[KW][A-Z]{3}$/` — four ASCII chars, K or W then three A-Z.
fn is_valid_callsign(cs: &str) -> bool {
    let b = cs.as_bytes();
    b.len() == 4 && (b[0] == b'K' || b[0] == b'W') && b[1..].iter().all(|c| c.is_ascii_uppercase())
}

/// `callsignRaw.toUpperCase().replace(/-.*$/, '').trim()`.
///
/// The regex is reproduced rather than approximated. JavaScript's `.` does not
/// match a line terminator and `$` (no /m) only matches end of input, so
/// `-.*$` truncates at the first hyphen whose remainder holds no line
/// terminator — a hyphen followed by a newline leaves the string untouched. No
/// real callsign reaches that branch, but the differential harness compares
/// these two functions byte for byte and an approximation would show up as a
/// divergence rather than as a shrug.
pub fn callsign_base(callsign: &str) -> String {
    let upper = callsign.to_uppercase();
    let cut = upper
        .char_indices()
        .find(|&(i, c)| c == '-' && !upper[i..].chars().any(is_js_line_terminator));
    let sliced = match cut {
        Some((i, _)) => &upper[..i],
        None => &upper[..],
    };
    js_trim(sliced).to_string()
}

fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// String.prototype.trim: Unicode White_Space, the line terminators, and the
/// BOM. Rust's own `trim` covers White_Space but not U+FEFF.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// Callsign -> PI. None for inputs the formula can't encode.
///
/// The widest value the formula can produce is W_BASE + MAX_SUFFIX = 39247, so
/// the result is a PI-shaped u16 and round-trips through `pi_to_callsign`.
pub fn callsign_to_pi(callsign_raw: &str) -> Option<u16> {
    if callsign_raw.is_empty() {
        return None;
    }
    // Normalise: uppercase, strip an -FM / -FM1 style suffix and any dashes.
    let cs = callsign_base(callsign_raw);

    if cs.chars().count() == 3 {
        // Three-letter: table only.
        return THREE_LETTER_PI
            .iter()
            .find(|(_, c)| *c == cs)
            .map(|(p, _)| *p);
    }
    if !is_valid_callsign(&cs) {
        return None;
    }
    let b = cs.as_bytes();
    let base = if b[0] == b'W' { W_BASE } else { K_BASE };
    let v1 = (b[1] - b'A') as u16;
    let v2 = (b[2] - b'A') as u16;
    let v3 = (b[3] - b'A') as u16;
    Some(base + v1 * 676 + v2 * 26 + v3)
}

/// PI (decimal) -> callsign HINT. Always inspect `.confident` before showing the
/// result as an identity.
///
/// The parameter is the 16 bits of block A, which is the only thing that ever
/// reaches this. The TypeScript signature is `number` and opens with a
/// `Number.isFinite` / `Math.floor` guard against fractional and out-of-range
/// input; a `u16` makes those states unrepresentable instead, so the guard here
/// is only the zero case.
pub fn pi_to_callsign(pi: u16) -> PiDecode {
    if pi == 0 {
        return PiDecode::none("invalid/zero PI");
    }
    let p = pi;

    // Three-letter table takes precedence (fixed assignments).
    if let Some((_, cs)) = THREE_LETTER_PI.iter().find(|(k, _)| *k == p) {
        return PiDecode {
            callsign: Some((*cs).to_string()),
            method: PiMethod::ThreeLetter,
            confident: true,
            note: None,
        };
    }

    // Encoder defaults / reserved values that are never real US callsign PIs.
    if p == 0xffff {
        return PiDecode::none("default/unset PI (0xFFFF)");
    }
    if (A_BLOCK_LO..=A_BLOCK_HI).contains(&p) {
        return PiDecode::none("A-block remapped PI (not inverted)");
    }

    let (letter, rem) = if p >= W_BASE {
        ('W', p - W_BASE)
    } else if p >= K_BASE {
        ('K', p - K_BASE)
    } else {
        return PiDecode::none("below K block (not a US 4-letter PI)");
    };

    if rem > MAX_SUFFIX {
        return PiDecode::none("suffix out of range (likely translator/foreign)");
    }

    let v1 = (rem / 676) as u8;
    let v2 = ((rem % 676) / 26) as u8;
    let v3 = (rem % 26) as u8;
    let callsign = format!(
        "{}{}{}{}",
        letter,
        (b'A' + v1) as char,
        (b'A' + v2) as char,
        (b'A' + v3) as char
    );
    PiDecode {
        callsign: Some(callsign),
        method: PiMethod::Formula,
        confident: true,
        note: None,
    }
}

/// The PI bits that survive a wrong top nibble.
///
/// Some encoders get the top nibble wrong and the remaining twelve right — the
/// signature of an encoder running in European RDS mode, where that nibble is a
/// country code rather than part of the callsign arithmetic. Observed on this
/// unit 2026-08-03, on two stations at once: WIBA-FM 101.5 sends 0x19E2 (the
/// arithmetic gives 0x69E2 -> "KDTI") and WZEE 104.1 sends 0x1718 (0x9718 ->
/// "KCRW"). Both decodes name real, distant stations, so nothing about the value
/// looks wrong — only the dial disagrees.
pub const PI_LOW_MASK: u16 = 0x0fff;

/// Which of `rows` could have sent `pi` if the top nibble is untrustworthy.
///
/// Pass only stations already known to be on the tuned frequency: the pair
/// (frequency, low 12 bits) is very nearly a key. Measured over the whole
/// bundled FCC table — 10,646 full-power stations — 10,487 distinct pairs, of
/// which 130 have two holders and none has three. A single hit is strong
/// evidence; two mean give up, which is what the caller does.
///
/// Returns uppercase callsign bases, deduplicated, in first-seen order (the
/// TypeScript returns `[...new Set(...)]`, which is insertion-ordered).
pub fn pi_low_bits_candidates<'a, I>(pi: u16, rows: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    if pi == 0 {
        return Vec::new();
    }
    let want = pi & PI_LOW_MASK;
    let mut hits: Vec<String> = Vec::new();
    for base in rows {
        if let Some(p) = callsign_to_pi(base) {
            if p & PI_LOW_MASK == want {
                let key = callsign_base(base);
                if !hits.contains(&key) {
                    hits.push(key);
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_formula_runs_both_ways() {
        // WIBA-FM's own arithmetic value, and back again.
        let pi = callsign_to_pi("WIBA").unwrap();
        assert_eq!(pi_to_callsign(pi).callsign.as_deref(), Some("WIBA"));
    }

    #[test]
    fn a_k_call_and_a_w_call_land_in_their_blocks() {
        assert_eq!(callsign_to_pi("KAAA"), Some(K_BASE));
        assert_eq!(callsign_to_pi("WAAA"), Some(W_BASE));
    }

    #[test]
    fn an_fm_suffix_is_stripped_before_the_arithmetic() {
        assert_eq!(callsign_to_pi("WOLX-FM"), callsign_to_pi("WOLX"));
        assert_eq!(callsign_base("wolx-fm"), "WOLX");
    }

    #[test]
    fn a_hyphen_before_a_newline_does_not_truncate() {
        // JavaScript's `-.*$` cannot cross a line terminator, so the string is
        // returned whole. Reproduced deliberately; see callsign_base.
        assert_eq!(callsign_base("WOLX-FM\nX"), "WOLX-FM\nX");
    }

    #[test]
    fn the_unset_pi_is_refused() {
        let d = pi_to_callsign(0xffff);
        assert!(d.callsign.is_none());
        assert_eq!(d.note.as_deref(), Some("default/unset PI (0xFFFF)"));
    }

    #[test]
    fn the_a_block_is_detected_and_not_inverted() {
        let d = pi_to_callsign(0xa123);
        assert!(d.callsign.is_none());
        assert_eq!(
            d.note.as_deref(),
            Some("A-block remapped PI (not inverted)")
        );
    }

    #[test]
    fn below_the_k_block_is_not_a_us_callsign() {
        assert!(pi_to_callsign(0x0fff).callsign.is_none());
        assert!(pi_to_callsign(0).callsign.is_none());
    }

    #[test]
    fn three_letter_callsigns_decode_as_unknown_while_the_table_is_empty() {
        // Guards the intentional emptiness: a populated table would change this,
        // and that change should be deliberate.
        assert!(THREE_LETTER_PI.is_empty());
        assert_eq!(callsign_to_pi("WGN"), None);
    }

    #[test]
    fn the_two_measured_encoder_faults_are_recoverable_from_the_low_bits() {
        // WIBA-FM 101.5 transmitted 0x19E2; the arithmetic value is 0x69E2.
        let rows = ["WIBA", "WZEE", "WERN"];
        assert_eq!(pi_low_bits_candidates(0x19e2, rows), vec!["WIBA"]);
        // WZEE 104.1 transmitted 0x1718; the arithmetic value is 0x9718.
        assert_eq!(pi_low_bits_candidates(0x1718, rows), vec!["WZEE"]);
    }

    #[test]
    fn the_low_bits_search_dedupes_and_refuses_a_dead_pi() {
        let rows = ["WIBA", "WIBA-FM"];
        assert_eq!(pi_low_bits_candidates(0x19e2, rows).len(), 1);
        assert!(pi_low_bits_candidates(0, rows).is_empty());
    }
}
