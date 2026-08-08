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
        out.push(NearbyStation { row: r.clone(), distance_km, score });
    }
    // Descending by score. `sort_by` is stable, as is JavaScript's Array#sort
    // (required since ES2019), so ties resolve identically.
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
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
            row("WTNY", 43.10, -89.40, Some(0.25), None),  // close, tiny
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
}
