//! Geo + receivability maths for "stations near me".
//!
//! Ported from src/services/stationGeo.ts, which is already pure and is the
//! reference implementation the differential harness diffs against. The DB layer
//! uses `bounding_box` as a cheap indexed prefilter, `haversine_km` for true
//! distance, then `receivability_score` to rank by "can I actually hear it"
//! rather than by raw distance.

const EARTH_R_KM: f64 = 6371.0088;
const KM_PER_DEG_LAT: f64 = 111.32;
const D2R: f64 = std::f64::consts::PI / 180.0;

/// Great-circle distance in km.
pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * D2R;
    let d_lon = (lon2 - lon1) * D2R;
    let a = (d_lat / 2.0).sin().powi(2)
        + (lat1 * D2R).cos() * (lat2 * D2R).cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_R_KM * a.sqrt().min(1.0).asin()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

/// Lat/lon box enclosing a radius (km) around a point — for the SQL prefilter on
/// the indexed columns. A box is a superset of the circle; haversine then trims
/// the corners.
pub fn bounding_box(lat: f64, lon: f64, radius_km: f64) -> BBox {
    let d_lat = radius_km / KM_PER_DEG_LAT;
    // Guard the cosine near the poles (irrelevant for the US, but keep it safe).
    let cos = (lat * D2R).cos().max(0.01);
    let d_lon = radius_km / (KM_PER_DEG_LAT * cos);
    BBox {
        min_lat: lat - d_lat,
        max_lat: lat + d_lat,
        min_lon: lon - d_lon,
        max_lon: lon + d_lon,
    }
}

/// Small additive bonus by FM station class (higher class -> more reach).
pub fn class_bonus(station_class: Option<&str>) -> f64 {
    match station_class.unwrap_or("").to_uppercase().as_str() {
        "C" | "C0" => 6.0,
        "C1" => 4.5,
        "C2" | "B" => 3.0,
        "C3" | "B1" => 1.5,
        "A" => 0.0,
        // LPFM / translators / unknown carry no bonus (ERP already low).
        _ => 0.0,
    }
}

/// Relative "likely receivability" — HIGHER is better. Not a field prediction: a
/// free-space proxy in dB, 10*log10(ERP) - 20*log10(distance), plus the class
/// bonus. That ordering makes a 100 kW class C at 60 mi beat a 250 W translator
/// at 15 mi.
///
/// It is deliberately NOT a signal-level predictor. Measured against 232 settled
/// samples it explained 85% of the variance BETWEEN stations and essentially
/// none WITHIN one, which is why the estimated-signal meter that used it was
/// removed. Ranking a list is what it is good at.
pub fn receivability_score(erp_kw: Option<f64>, station_class: Option<&str>, distance_km: f64) -> f64 {
    // Floor; assume tiny if unknown.
    let erp = erp_kw.unwrap_or(0.05).max(0.0001);
    // Avoid log(0) right on top of a transmitter.
    let dist = distance_km.max(1.0);
    10.0 * erp.log10() - 20.0 * dist.log10() + class_bonus(station_class)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() < eps
    }

    #[test]
    fn distance_to_self_is_zero() {
        assert_eq!(haversine_km(43.07, -89.4, 43.07, -89.4), 0.0);
    }

    #[test]
    fn a_known_leg_matches_the_great_circle() {
        // Madison WI -> Chicago IL, ~197 km.
        let d = haversine_km(43.0731, -89.4012, 41.8781, -87.6298);
        assert!(close(d, 197.0, 2.0), "got {d}");
    }

    #[test]
    fn the_box_encloses_the_circle() {
        let b = bounding_box(43.0731, -89.4012, 100.0);
        // A due-north point at the radius must sit inside the box.
        assert!(b.max_lat > 43.0731 + 100.0 / 111.33);
        assert!(b.min_lon < -89.4012);
    }

    #[test]
    fn the_cosine_guard_holds_at_the_pole() {
        // Without the 0.01 floor this divides by ~0 and the box spans the globe.
        let b = bounding_box(90.0, 0.0, 100.0);
        assert!(b.max_lon.is_finite() && b.max_lon < 100.0);
    }

    #[test]
    fn class_bonus_is_case_insensitive_and_defaults_to_zero() {
        assert_eq!(class_bonus(Some("c1")), 4.5);
        assert_eq!(class_bonus(Some("C1")), 4.5);
        assert_eq!(class_bonus(None), 0.0);
        assert_eq!(class_bonus(Some("LP")), 0.0);
    }

    #[test]
    fn a_big_distant_station_outranks_a_tiny_near_one() {
        // The ordering the score exists to produce: 100 kW class C at 96 km beats
        // a 250 W translator at 24 km.
        let big = receivability_score(Some(100.0), Some("C"), 96.0);
        let small = receivability_score(Some(0.25), None, 24.0);
        assert!(big > small, "big {big} small {small}");
    }

    #[test]
    fn distance_is_floored_at_one_km() {
        // Right on top of the transmitter must not blow up to infinity.
        let on_top = receivability_score(Some(10.0), None, 0.0);
        assert!(on_top.is_finite());
        assert_eq!(on_top, receivability_score(Some(10.0), None, 1.0));
    }
}
