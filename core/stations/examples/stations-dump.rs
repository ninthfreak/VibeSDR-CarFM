//! Differential harness, Rust side. Reads the corpus file named on the command
//! line and prints one line per scenario. Paired with tools/tests/stationDump.mjs,
//! which prints the same shape from the TypeScript — if you change what one
//! prints, change the other.

use carfm_stations::identify::StationSource;
use carfm_stations::{
    bounding_box, callsign_base, callsign_to_pi, haversine_km, identify_by_pi, pi_to_callsign,
    rank_nearby, receivability_score, StationRow, FREQ_EPS,
};

/// `JSON.stringify` for a string or null, matching what the TypeScript prints.
fn jstr(s: Option<&str>) -> String {
    let Some(s) = s else {
        return "null".to_string();
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // JSON.stringify escapes the other C0 controls as \u00xx and leaves
            // everything above 0x1F alone, non-ASCII included.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `String(v)` for a float. Rust prints negative zero as "-0"; JavaScript prints
/// "0". Nothing else in the printed range diverges — the values are distances,
/// scores, frequencies and lat/lon bounds, all well inside the window where both
/// languages emit the shortest round-tripping decimal.
fn jnum(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    format!("{v}")
}

struct Table(Vec<StationRow>);

impl StationSource for Table {
    fn for_callsign_base(&self, base: &str) -> Vec<StationRow> {
        if base.is_empty() {
            return Vec::new();
        }
        let k = base.to_uppercase();
        self.0
            .iter()
            .filter(|r| r.callsign_base == k)
            .cloned()
            .collect()
    }
    fn at_frequency(&self, mhz: f64) -> Vec<StationRow> {
        if !mhz.is_finite() || mhz <= 0.0 {
            return Vec::new();
        }
        self.0
            .iter()
            .filter(|r| r.service == "FM" && (r.frequency_mhz - mhz).abs() < FREQ_EPS)
            .cloned()
            .collect()
    }
}

fn un(s: &str) -> Option<&str> {
    if s == "\\N" {
        None
    } else {
        Some(s)
    }
}
fn unum(s: &str) -> Option<f64> {
    un(s).map(|v| v.parse().expect("number"))
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <corpus>");
    let text = std::fs::read_to_string(&path).expect("read corpus");
    let mut lines = text.split('\n');

    let head = lines.next().expect("empty corpus");
    assert!(
        head.starts_with("#ROWS"),
        "corpus does not start with #ROWS"
    );
    let row_count: usize = head
        .split('\t')
        .nth(1)
        .expect("#ROWS count")
        .parse()
        .expect("count");

    let mut rows = Vec::with_capacity(row_count);
    for _ in 0..row_count {
        let c: Vec<&str> = lines.next().expect("row").split('\t').collect();
        rows.push(StationRow {
            callsign: c[0].to_string(),
            callsign_base: c[1].to_string(),
            frequency_mhz: c[2].parse().expect("freq"),
            service: c[3].to_string(),
            station_class: un(c[4]).map(str::to_string),
            erp_kw: unum(c[5]),
            lat: c[6].parse().expect("lat"),
            lon: c[7].parse().expect("lon"),
            city: un(c[8]).map(str::to_string),
            state: un(c[9]).map(str::to_string),
            facility_id: c[10].parse().expect("facility_id"),
        });
    }
    assert_eq!(lines.next(), Some("#SCENARIOS"), "expected #SCENARIOS");

    let table = Table(rows);
    let mut out = String::new();

    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (cmd, rest) = match line.find(' ') {
            Some(i) => (&line[..i], &line[i + 1..]),
            None => (line, ""),
        };
        let a: Vec<&str> = rest.split(' ').collect();

        match cmd {
            "pi" => {
                let pi: u16 = a[0].parse().expect("pi");
                let d = pi_to_callsign(pi);
                out.push_str(&format!(
                    "pi {} call={} method={} conf={} note={}\n",
                    a[0],
                    jstr(d.callsign.as_deref()),
                    d.method.as_str(),
                    d.confident,
                    jstr(d.note.as_deref())
                ));
            }
            "tocall" => {
                let v = callsign_to_pi(rest)
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "null".into());
                out.push_str(&format!("tocall {} -> {}\n", jstr(Some(rest)), v));
            }
            "base" => {
                out.push_str(&format!(
                    "base {} -> {}\n",
                    jstr(Some(rest)),
                    jstr(Some(&callsign_base(rest)))
                ));
            }
            "geo" => {
                let d = haversine_km(
                    a[0].parse().unwrap(),
                    a[1].parse().unwrap(),
                    a[2].parse().unwrap(),
                    a[3].parse().unwrap(),
                );
                out.push_str(&format!("geo {rest} -> {}\n", jnum(d)));
            }
            "bbox" => {
                let b = bounding_box(
                    a[0].parse().unwrap(),
                    a[1].parse().unwrap(),
                    a[2].parse().unwrap(),
                );
                out.push_str(&format!(
                    "bbox {rest} -> {} {} {} {}\n",
                    jnum(b.min_lat),
                    jnum(b.max_lat),
                    jnum(b.min_lon),
                    jnum(b.max_lon)
                ));
            }
            "score" => {
                let s = receivability_score(unum(a[0]), un(a[1]), a[2].parse().unwrap());
                out.push_str(&format!("score {rest} -> {}\n", jnum(s)));
            }
            "nearby" => {
                let (lat, lon): (f64, f64) = (a[0].parse().unwrap(), a[1].parse().unwrap());
                let radius: f64 = a[2].parse().unwrap();
                let limit: usize = a[3].parse().unwrap();
                let b = bounding_box(lat, lon, radius);
                // The bounding box is the SQL prefilter; applying it here keeps
                // the harness honest about what rank_nearby receives in the app.
                let in_box: Vec<StationRow> = table
                    .0
                    .iter()
                    .filter(|r| {
                        r.lat >= b.min_lat
                            && r.lat <= b.max_lat
                            && r.lon >= b.min_lon
                            && r.lon <= b.max_lon
                    })
                    .cloned()
                    .collect();
                let ranked = rank_nearby(lat, lon, radius, limit, &in_box);
                out.push_str(&format!("nearby {rest} -> {}\n", ranked.len()));
                for s in &ranked {
                    out.push_str(&format!(
                        "  {} {} {} {} f={} d={} s={}\n",
                        s.row.callsign,
                        s.row.callsign_base,
                        jnum(s.row.frequency_mhz),
                        s.row.service,
                        s.row.facility_id,
                        jnum(s.distance_km),
                        jnum(s.score)
                    ));
                }
            }
            "identify" => {
                let pi: u16 = a[0].parse().expect("pi");
                let freq = unum(a[1]);
                let ps_joined = a[2..].join(" ");
                let ps = un(&ps_joined).map(str::to_string);
                let id = identify_by_pi(pi, ps.as_deref(), freq, &table);
                let st = id.station.as_ref().map(|s| {
                    format!(
                        "{}|{}|{}|{}",
                        s.callsign,
                        jnum(s.frequency_mhz),
                        s.service,
                        s.facility_id
                    )
                });
                out.push_str(&format!(
                    "identify {rest} -> call={} conf={} st={} note={}\n",
                    jstr(id.callsign.as_deref()),
                    id.confident,
                    jstr(st.as_deref()),
                    jstr(id.note.as_deref())
                ));
            }
            other => panic!("unknown scenario \"{other}\""),
        }
    }
    print!("{out}");
}
