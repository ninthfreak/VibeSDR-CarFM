//! Station identity and ranking for CarFM.
//!
//! The second piece of the portable core, after `carfm-rds`. It holds what the
//! app knows about *which station this is* and *what else is out there*: the
//! RBDS PI arithmetic, the geo maths behind "stations near me", the ranking that
//! turns a box of rows into a list, and the identification rules that decide
//! whether a decoded PI may rename the station on screen.
//!
//! Ported from src/services/{stationGeo,piCallsign,stationTypes}.ts and the pure
//! halves of stationDb.nearbyStations and stationFinder.identifyByPi. Those stay
//! the reference implementation until the TypeScript retires; the differential
//! harness (`npm run test:stations-diff`) diffs the two over the real bundled FCC
//! table and must stay green.
//!
//! Like `carfm-rds`, this crate does NO I/O. The database is reached through the
//! `StationSource` trait and the nearby ranking takes rows already in memory, so
//! the SQL — and the decision of what to prefilter — stays platform glue above.
//!
//! One thing worth knowing before trusting `class_bonus`: every one of the
//! 20,733 rows in the bundled table has a NULL `station_class`, so on real data
//! the bonus is always zero. It is ported because the column is in the schema and
//! a future DB build may populate it, not because it currently does anything.

pub mod geo;
pub mod identify;
pub mod nearby;
pub mod pi;
pub mod types;

pub use geo::{bounding_box, class_bonus, haversine_km, receivability_score, BBox};
pub use identify::{best_station, identify_by_pi, StationSource, FREQ_EPS};
pub use nearby::rank_nearby;
pub use pi::{
    callsign_base, callsign_to_pi, pi_low_bits_candidates, pi_to_callsign, PiDecode, PiMethod,
    PI_LOW_MASK, THREE_LETTER_PI,
};
pub use types::{NearbyStation, StationIdentity, StationRow};
