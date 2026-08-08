//! Ranking for "stations near me".
//!
//! The seam with the database is deliberate and matches stationDb.nearbyStations:
//! SQL does an indexed prefilter on the bounding box, then everything that
//! decides what the user sees — the true-distance trim, the receivability score,
//! the ordering and the cap — happens here, on rows already in memory. That is
//! what keeps this crate free of I/O while still owning the behaviour.

use crate::geo::{haversine_km, receivability_score};
use crate::types::{NearbyStation, StationRow};

/// Rank rows already prefiltered to the bounding box.
///
/// `rows` is expected in the order SQLite returned them; the sort below is
/// stable in both languages, so equal scores keep that order and the two
/// implementations agree row for row.
pub fn rank_nearby(
    lat: f64,
    lon: f64,
    radius_km: f64,
    limit: usize,
    rows: &[StationRow],
) -> Vec<NearbyStation> {
    let mut out: Vec<NearbyStation> = Vec::new();
    for r in rows {
        let distance_km = haversine_km(lat, lon, r.lat, r.lon);
        // The box is a superset of the circle — trim the corners.
        if distance_km > radius_km {
            continue;
        }
        let score = receivability_score(r.erp_kw, r.station_class.as_deref(), distance_km);
        out.push(NearbyStation {
            row: r.clone(),
            distance_km,
            score,
        });
    }
    // Descending by score. `sort_by` is stable, as is JavaScript's Array#sort
    // (required since ES2019), so ties resolve identically.
    //
    // A NaN SCORE RANKS LAST, EXPLICITLY, and the TypeScript does the same.
    // `receivability_score` propagates NaN on purpose (it reproduces
    // `Math.max`'s NaN handling), and the trim above deliberately keeps a
    // NaN-distance row, because `NaN > r` is false in both languages — so NaN
    // genuinely reaches this sort. The obvious comparator,
    // `partial_cmp(..).unwrap_or(Equal)`, mirrors JavaScript's rule that a NaN
    // comparison coerces to 0, but that is NOT a total order: with NaN, 1, 2 it
    // claims NaN == 1 and NaN == 2 while 1 < 2. Rust's sort detects the
    // violation and PANICS — in release as well as debug, since the check lives
    // in `core` — so the faithful-looking comparator aborts the process where
    // JavaScript merely returns a badly ordered list. Mapping NaN to
    // NEG_INFINITY first gives a real total order, sinks the unrankable rows,
    // and leaves them tied so the stable sort keeps their input order.
    let key = |s: f64| if s.is_nan() { f64::NEG_INFINITY } else { s };
    out.sort_by(|a, b| key(b.score).total_cmp(&key(a.score)));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(base: &str, lat: f64, lon: f64, erp: Option<f64>, class: Option<&str>) -> StationRow {
        StationRow {
            callsign: base.to_string(),
            callsign_base: base.to_string(),
            frequency_mhz: 101.5,
            service: "FM".to_string(),
            station_class: class.map(str::to_string),
            erp_kw: erp,
            lat,
            lon,
            city: None,
            state: None,
            facility_id: 0,
        }
    }

    #[test]
    fn a_row_outside_the_radius_is_trimmed() {
        // Both sit inside a 100 km BOX around Madison; only one is in the circle.
        let rows = vec![
            row("WNEA", 43.0731, -89.4012, Some(10.0), None),
            row("WFAR", 43.9, -90.6, Some(10.0), None), // ~120 km, box corner
        ];
        let out = rank_nearby(43.0731, -89.4012, 100.0, 50, &rows);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].row.callsign_base, "WNEA");
    }

    #[test]
    fn ranking_is_by_receivability_not_distance() {
        // The ordering the score exists to produce.
        let rows = vec![
            row("WTNY", 43.10, -89.40, Some(0.25), None), // close, tiny
            row("WBIG", 43.80, -89.40, Some(100.0), Some("C")), // far, big
        ];
        let out = rank_nearby(43.0731, -89.4012, 200.0, 50, &rows);
        assert_eq!(out[0].row.callsign_base, "WBIG");
        assert!(out[0].distance_km > out[1].distance_km);
    }

    #[test]
    fn the_limit_caps_the_list_after_ranking_not_before() {
        let rows = vec![
            row("WTNY", 43.08, -89.40, Some(0.25), None),
            row("WBIG", 43.20, -89.40, Some(100.0), Some("C")),
        ];
        let out = rank_nearby(43.0731, -89.4012, 200.0, 1, &rows);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].row.callsign_base, "WBIG");
    }

    #[test]
    fn an_empty_input_is_an_empty_list() {
        assert!(rank_nearby(43.0, -89.0, 100.0, 10, &[]).is_empty());
    }

    /// REGRESSION — a NaN score used to abort the process.
    ///
    /// `partial_cmp(..).unwrap_or(Equal)` looks like JavaScript's NaN rule but is
    /// not a total order, and Rust's sort panics on one. It does not trip on
    /// tidy input, so this fixture interleaves NaN irregularly across enough
    /// rows to reach the detecting code path; with the old comparator it panics
    /// with "user-provided comparison function does not correctly implement a
    /// total order", in release as well as debug.
    #[test]
    fn a_nan_score_sinks_instead_of_aborting() {
        // erp NaN on an irregular subset; the rest get distinct real scores.
        let nan_at = [1usize, 2, 5, 8, 13, 21, 34, 55, 60, 61, 62, 70, 71, 90];
        let rows: Vec<StationRow> = (0..100)
            .map(|i| {
                let erp = if nan_at.contains(&i) {
                    Some(f64::NAN)
                } else {
                    Some(1.0 + (i * 37 % 97) as f64)
                };
                row(
                    "WNAN",
                    43.0 + (i % 11) as f64 * 0.01,
                    -89.4 - (i % 7) as f64 * 0.01,
                    erp,
                    None,
                )
            })
            .collect();

        let out = rank_nearby(43.0731, -89.4012, 500.0, 1000, &rows);
        assert_eq!(out.len(), 100, "every row is inside the radius");

        // Real scores first, descending; the unrankable rows are all at the end.
        let first_nan = out.iter().position(|s| s.score.is_nan());
        assert_eq!(first_nan, Some(86), "14 NaN rows sink to the tail");
        assert!(out[..86].windows(2).all(|w| w[0].score >= w[1].score));
        assert!(out[86..].iter().all(|s| s.score.is_nan()));
    }
}
