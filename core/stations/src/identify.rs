//! Identifying the live station from its RDS PI.
//!
//! Ported from stationFinder.identifyByPi. The row lookups it needs are I/O, so
//! they arrive through `StationSource` rather than being done here — that keeps
//! the crate's no-I/O rule while preserving the TypeScript's laziness: the
//! on-dial query only runs when a frequency clash actually needs salvaging.
//!
//! The side effect the TypeScript fires at the end (`noteEncountered`, which
//! queues a logo fetch) is NOT here. It is not identification, it is enrichment,
//! and it belongs to the caller.

use crate::pi::{callsign_base, pi_low_bits_candidates, pi_to_callsign};
use crate::types::{StationIdentity, StationRow};

/// The row lookups identification needs. Implemented above this crate, against
/// whatever holds the bundled FCC table.
pub trait StationSource {
    /// Every row sharing a callsign base.
    fn for_callsign_base(&self, base: &str) -> Vec<StationRow>;
    /// Every FULL-POWER station on one dial frequency, nationwide.
    ///
    /// Translators and LPFM are excluded on purpose: the RBDS callsign formula
    /// does not apply to them (NRSC-G300), so their derived PI is noise, and the
    /// only caller matches on derived PI.
    fn at_frequency(&self, mhz: f64) -> Vec<StationRow>;
}

/// Dial-vs-DB tolerance. The FM raster is 0.2 MHz in North America, so half a
/// 0.1 MHz step is loose enough for rounding and far tighter than any channel.
pub const FREQ_EPS: f64 = 0.05;

/// Prefer full-power, then LPFM, then a translator. Stable, so among equals the
/// input order decides — matching the TypeScript's `[...rows].sort(...)[0]`.
pub fn best_station(rows: &[StationRow]) -> Option<StationRow> {
    let rank = |s: &str| match s {
        "FM" => 0,
        "FL" => 1,
        "FX" => 2,
        _ => 9,
    };
    let mut sorted: Vec<&StationRow> = rows.iter().collect();
    sorted.sort_by_key(|r| rank(&r.service));
    sorted.first().map(|r| (*r).clone())
}

/// Look for the station the dial says we are on, when the PI says otherwise.
///
/// Only reached after a PI decoded cleanly to a callsign the DB places on a
/// DIFFERENT frequency — the state that says the top nibble is wrong rather than
/// the whole code. Refuses on 0 or 2+ candidates; see `pi_low_bits_candidates`
/// for why a single hit is trustworthy.
fn salvage_by_low_bits(pi: u16, freq_mhz: f64, src: &dyn StationSource) -> Option<StationRow> {
    let on_dial = src.at_frequency(freq_mhz);
    let bases = pi_low_bits_candidates(pi, on_dial.iter().map(|r| r.callsign_base.as_str()));
    if bases.len() != 1 {
        return None;
    }
    let matching: Vec<StationRow> = on_dial
        .into_iter()
        .filter(|r| r.callsign_base == bases[0])
        .collect();
    best_station(&matching)
}

/// `/\b([KW][A-Z]{3})\b/` over the uppercased PS text — the first callsign-shaped
/// token standing alone. Reproduced by hand rather than pulled in as a regex
/// dependency; the crate has none and this is the only pattern it needs.
fn callsign_in_ps(ps_upper: &str) -> Option<String> {
    let b = ps_upper.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for i in 0..b.len() {
        if i + 4 > b.len() {
            break;
        }
        if b[i] != b'K' && b[i] != b'W' {
            continue;
        }
        if !b[i + 1..i + 4].iter().all(|c| c.is_ascii_uppercase()) {
            continue;
        }
        // \b on both sides: a word char must not sit immediately outside.
        if i > 0 && is_word(b[i - 1]) {
            continue;
        }
        if i + 4 < b.len() && is_word(b[i + 4]) {
            continue;
        }
        return Some(ps_upper[i..i + 4].to_string());
    }
    None
}

/// Format a frequency the way JavaScript's template literal does, so the note
/// strings the two implementations produce compare equal.
fn fmt_mhz(v: f64) -> String {
    format!("{v}")
}

/// Identify the live station from its RDS PI.
///
/// Pass the tuned frequency whenever it is known — it is what stops a
/// mis-encoded PI from renaming the station.
pub fn identify_by_pi(
    pi: u16,
    ps_text: Option<&str>,
    freq_mhz: Option<f64>,
    src: &dyn StationSource,
) -> StationIdentity {
    let dec = pi_to_callsign(pi);
    let Some(decoded) = dec.callsign else {
        return StationIdentity {
            pi,
            callsign: None,
            confident: false,
            station: None,
            note: dec.note,
        };
    };

    let mut callsign = decoded;
    let mut base = callsign_base(&callsign);
    let rows = src.for_callsign_base(&base);
    let Some(mut station) = best_station(&rows) else {
        // NO DB ROW MEANS NO STATION. The formula turns any 16 bits in the K/W
        // range into four plausible letters, so "it decoded" is not evidence that
        // anything is out there. On 2026-08-04 a corrupt block A on WERN read
        // 0xA6FF as 0x57FF, which the formula renders as WBGX — a callsign absent
        // from the entire FCC table. The old code marked it not-confident and
        // returned it anyway, and the hero dropped WERN's logo to show it.
        return StationIdentity {
            pi,
            callsign: None,
            confident: false,
            station: None,
            note: Some("no DB match for computed callsign".to_string()),
        };
    };

    let mut confident = dec.confident && station.service == "FM";
    let mut note = dec.note;
    if station.service != "FM" {
        note = Some(format!(
            "matched a {} (formula unreliable for translators)",
            station.service
        ));
    }

    // ── THE DIAL OUTRANKS THE PI ────────────────────────────────────────────
    // A PI that decodes to a real station on a different frequency is not this
    // station, however clean the decode looks. Without this check WIBA-FM 101.5
    // renamed itself "KDTI · Rochester Hills" every time PI consensus landed, and
    // queued that station's logo — the decode was correct, the transmitted code
    // was not.
    //
    // This is deliberately the one identity path that survives a head unit with
    // no GPS fix, which is exactly when nothing else can contradict a bad PI.
    if let Some(f) = freq_mhz {
        if f > 0.0 && (station.frequency_mhz - f).abs() > FREQ_EPS {
            let clash = format!(
                "{} is {} MHz, dial is {}",
                callsign,
                fmt_mhz(station.frequency_mhz),
                fmt_mhz(f)
            );
            let Some(salvaged) = salvage_by_low_bits(pi, f, src) else {
                return StationIdentity {
                    pi,
                    callsign: None,
                    confident: false,
                    station: None,
                    note: Some(format!("{clash} — PI rejected")),
                };
            };
            // The BASE, not the row's `callsign`: the formula path returns a bare
            // four-letter form ('WOLX' for a row reading 'WOLX-FM'), and the hero
            // renders whatever this is verbatim, so the two paths must agree on
            // the shape.
            note = Some(format!(
                "{clash}; low 12 bits match {} on the dial",
                salvaged.callsign
            ));
            callsign = salvaged.callsign_base.clone();
            base = salvaged.callsign_base.clone();
            confident = salvaged.service == "FM";
            station = salvaged;
        }
    }

    if let Some(ps) = ps_text {
        if !ps.is_empty() {
            if let Some(other) = callsign_in_ps(&ps.to_uppercase()) {
                if other != base {
                    confident = false;
                    note = Some(format!("PS text names {other}, not {callsign}"));
                }
            }
        }
    }

    StationIdentity {
        pi,
        callsign: Some(callsign),
        confident,
        station: Some(station),
        note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Vec<StationRow>);

    impl StationSource for Fixed {
        fn for_callsign_base(&self, base: &str) -> Vec<StationRow> {
            self.0
                .iter()
                .filter(|r| r.callsign_base == base)
                .cloned()
                .collect()
        }
        fn at_frequency(&self, mhz: f64) -> Vec<StationRow> {
            self.0
                .iter()
                .filter(|r| r.service == "FM" && (r.frequency_mhz - mhz).abs() < 0.05)
                .cloned()
                .collect()
        }
    }

    fn row(callsign: &str, base: &str, mhz: f64, service: &str) -> StationRow {
        StationRow {
            callsign: callsign.to_string(),
            callsign_base: base.to_string(),
            frequency_mhz: mhz,
            service: service.to_string(),
            station_class: None,
            erp_kw: Some(10.0),
            lat: 43.0,
            lon: -89.4,
            city: Some("MADISON".to_string()),
            state: Some("WI".to_string()),
            facility_id: 1,
        }
    }

    fn db() -> Fixed {
        Fixed(vec![
            row("WIBA-FM", "WIBA", 101.5, "FM"),
            row("WZEE", "WZEE", 104.1, "FM"),
            row("WERN", "WERN", 88.7, "FM"),
            row("WOLX-FM", "WOLX", 94.9, "FM"),
        ])
    }

    #[test]
    fn a_clean_pi_on_the_right_dial_identifies_confidently() {
        let pi = crate::pi::callsign_to_pi("WERN").unwrap();
        let id = identify_by_pi(pi, None, Some(88.7), &db());
        assert_eq!(id.callsign.as_deref(), Some("WERN"));
        assert!(id.confident);
        assert_eq!(id.station.unwrap().callsign, "WERN");
    }

    #[test]
    fn a_callsign_absent_from_the_table_is_refused_outright() {
        // The 2026-08-04 case: corrupt block A on WERN read 0xA6FF as 0x57FF,
        // which the formula renders as WBGX — absent from the whole FCC table.
        let id = identify_by_pi(0x57ff, None, Some(88.7), &db());
        assert_eq!(id.callsign, None);
        assert_eq!(id.station, None);
        assert!(!id.confident);
        assert_eq!(
            id.note.as_deref(),
            Some("no DB match for computed callsign")
        );
    }

    #[test]
    fn the_dial_outranks_a_pi_that_names_a_station_elsewhere() {
        // WOLX is real and on 94.9; claim it while the dial says 88.7. Nothing on
        // 88.7 matches the low bits, so the PI is rejected rather than believed.
        let pi = crate::pi::callsign_to_pi("WOLX").unwrap();
        let id = identify_by_pi(pi, None, Some(88.7), &db());
        assert_eq!(id.callsign, None);
        assert!(id.note.unwrap().ends_with("PI rejected"));
    }

    #[test]
    fn the_low_bits_salvage_recovers_the_measured_wiba_fault() {
        // WIBA-FM 101.5 transmits 0x19E2; the arithmetic reads that as KDTI,
        // which is not in this table, so the no-DB-row guard fires first — the
        // salvage is reached only when the decode DOES name a real station.
        // Add KDTI on its real dial (90.3) to reproduce the live case.
        let mut rows = db().0;
        rows.push(row("KDTI", "KDTI", 90.3, "FM"));
        let id = identify_by_pi(0x19e2, None, Some(101.5), &Fixed(rows));
        assert_eq!(id.callsign.as_deref(), Some("WIBA"));
        assert!(id.confident);
        assert!(id
            .note
            .unwrap()
            .contains("low 12 bits match WIBA-FM on the dial"));
    }

    #[test]
    fn ps_text_naming_another_station_drops_confidence() {
        let pi = crate::pi::callsign_to_pi("WERN").unwrap();
        let id = identify_by_pi(pi, Some("WIBA news"), Some(88.7), &db());
        assert!(!id.confident);
        assert_eq!(id.note.as_deref(), Some("PS text names WIBA, not WERN"));
        // The station still stands — only the confidence drops.
        assert_eq!(id.callsign.as_deref(), Some("WERN"));
    }

    #[test]
    fn ps_text_naming_the_same_station_is_not_a_contradiction() {
        let pi = crate::pi::callsign_to_pi("WERN").unwrap();
        let id = identify_by_pi(pi, Some("WERN 88.7"), Some(88.7), &db());
        assert!(id.confident);
    }

    #[test]
    fn a_callsign_shaped_run_inside_a_word_is_not_a_callsign() {
        // \b on both sides: "WORKS" must not read as "WORK".
        assert_eq!(callsign_in_ps("THE WORKS"), None);
        assert_eq!(callsign_in_ps("KIND OF"), Some("KIND".to_string()));
    }

    #[test]
    fn full_power_wins_over_a_translator_on_the_same_base() {
        let rows = vec![
            row("WXXX-FX", "WXXX", 95.1, "FX"),
            row("WXXX", "WXXX", 95.1, "FM"),
        ];
        assert_eq!(best_station(&rows).unwrap().service, "FM");
    }

    #[test]
    fn no_frequency_means_no_dial_check() {
        // A head unit with no frequency to offer still gets an identity.
        let pi = crate::pi::callsign_to_pi("WOLX").unwrap();
        let id = identify_by_pi(pi, None, None, &db());
        assert_eq!(id.callsign.as_deref(), Some("WOLX"));
        assert!(id.confident);
    }
}
