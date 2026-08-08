//! Shared station types. Mirrors src/services/stationTypes.ts.

/// A row of the bundled, read-only FCC-derived station table.
#[derive(Debug, Clone, PartialEq)]
pub struct StationRow {
    pub callsign: String,
    /// 4-letter base, the PI join key.
    pub callsign_base: String,
    /// 88.1 .. 107.9
    pub frequency_mhz: f64,
    /// "FM" full-power / "FX" translator / "FL" LPFM.
    pub service: String,
    pub station_class: Option<String>,
    pub erp_kw: Option<f64>,
    pub lat: f64,
    pub lon: f64,
    pub city: Option<String>,
    pub state: Option<String>,
    pub facility_id: i64,
}

/// A ranked nearby station = row + distance and receivability score.
///
/// The TypeScript shape also carries `genre`, `logoUri` and `homepage`. Those
/// come from the logo store and the enrichment tables, which are I/O and live
/// above this crate; the ranking does not read them.
#[derive(Debug, Clone, PartialEq)]
pub struct NearbyStation {
    pub row: StationRow,
    pub distance_km: f64,
    /// Receivability rank, higher = more likely audible.
    pub score: f64,
}

/// Result of identifying a live station from its RDS PI.
#[derive(Debug, Clone, PartialEq)]
pub struct StationIdentity {
    pub pi: u16,
    /// PI-derived hint (may be wrong for translators).
    pub callsign: Option<String>,
    /// PI decode clean AND a DB match agrees.
    pub confident: bool,
    pub station: Option<StationRow>,
    pub note: Option<String>,
}
