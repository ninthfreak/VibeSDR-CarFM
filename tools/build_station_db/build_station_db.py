#!/usr/bin/env python3
"""
Build-time ETL: FCC LMS public database files -> assets/db/stations.sqlite
(addendum §3). Run occasionally by a human; NEVER on-device.

    python3 build_station_db.py fetch                 # download + unzip LMS files
    python3 build_station_db.py inspect               # dump table/columns/samples
    python3 build_station_db.py build                 # emit stations.sqlite
    python3 build_station_db.py self-test             # prove the pipeline (synthetic)

The FCC warns the LMS structure is not simple and staff can't help with the
tables. So the facility -> engineering join below is ISOLATED and marked VERIFY:
use `inspect` against a real download to confirm the file/column names, fix the
CONFIG block, and record what you found in README.md so the next refresh isn't a
re-discovery.

Scale check: ~11k full-power FM + ~9k translators + ~2k LPFM ~= 20-22k small
rows -> single-digit MB SQLite. Do not turn this into a server.
"""
from __future__ import annotations

import argparse
import csv
import io
import math
import os
import sqlite3
import sys
import zipfile
from datetime import date, datetime
from urllib.request import urlopen, Request

# Outputs default to the CURRENT directory so this single-file script is safe to
# run from anywhere (e.g. a copy in Downloads). In-repo, run it from assets/db/
# or pass --out ../../assets/db/stations.sqlite to drop it where the app expects.
DEFAULT_LMS_DIR = "lms_files"
DEFAULT_OUT = "stations.sqlite"
# Where the app loads the bundled DB from — printed as a reminder after a build.
APP_DB_PATH = "assets/db/stations.sqlite"

# LMS public database files (zip of pipe-delimited tables), updated each business
# day. Confirm the current URL on the LMS Public Database page if this 404s:
#   https://enterpriseefiling.fcc.gov/dataentry/public/tv/lmsDatabase.html
LMS_ZIP_URL = "https://enterpriseefiling.fcc.gov/dataentry/public/tv/lms_db_download/lms_public_database.zip"

# FCC service codes we keep (addendum §3.3). AM/TV out of scope. These are the
# letter codes in facility.service_code (decoded via lkp_service_code.dat).
FM_SERVICES = {"FM", "FX", "FL"}   # full-power FM, FM translator, LPFM
# Keep only on-air licensed facilities. facility.dat also carries voided (FVOID),
# cancelled (LICAN/PRCAN), pending (CPAPP/CPOFF), and unknown records — ~34k of
# the 55k FM-service rows — which must NOT ship in a tuner's list.
#   LICEN = licensed; LICRP = licensed, renewal pending (still broadcasting, e.g.
#   KUSC). LICSL (licensed-but-silent) is intentionally EXCLUDED — a silent
#   station isn't receivable, which is the whole point of the "nearby" list.
LICENSED_STATUS = {"LICEN", "LICRP"}

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — the join, VERIFIED against the real LMS per-table files (see README).
# Identity + frequency come straight from facility.dat. Engineering (ERP/class)
# and the transmitter coordinate live in app_* tables reachable only through a
# 5-hop chain keyed by opaque record ids — NOT by facility_id:
#
#   facility ──license_filing_id──▶ application_facility (afac_facility_id,
#                                      afac_application_id, afac_license_filing_id)
#            ──afac_application_id──▶ app_location (aloc_aapp_application_id)
#                                      → coordinates + aloc_loc_record_id
#            ──aloc_loc_record_id───▶ app_antenna (aant_aloc_loc_record_id,
#                                      aant_antenna_record_id)
#            ──aant_antenna_record_id▶ app_antenna_frequency → ERP / class
#
# application.dat is deliberately NOT read: facility.license_filing_id already
# identifies the current license, and skipping that 1.25M-row table keeps the
# build to ~1 min / a few hundred MB. Coordinates are DMS (NAD83, un-suffixed).
# ─────────────────────────────────────────────────────────────────────────────
FACILITY_FILE = "facility.dat"
F = dict(id="facility_id", call="callsign", svc="service_code", status="facility_status",
         active="active_ind", freq="frequency", chan="channel",
         city="community_served_city", state="community_served_state", lfid="license_filing_id")

AF_FILE = "application_facility.dat"
AF = dict(app="afac_application_id", fac="afac_facility_id", lfid="afac_license_filing_id")

LOC_FILE = "app_location.dat"
LOC = dict(app="aloc_aapp_application_id", rec="aloc_loc_record_id",
           lat_deg="aloc_lat_deg", lat_min="aloc_lat_mm", lat_sec="aloc_lat_ss", lat_dir="aloc_lat_dir",
           lon_deg="aloc_long_deg", lon_min="aloc_long_mm", lon_sec="aloc_long_ss", lon_dir="aloc_long_dir")

ANT_FILE = "app_antenna.dat"
ANT = dict(rec="aant_antenna_record_id", loc="aant_aloc_loc_record_id")

FRQ_FILE = "app_antenna_frequency.dat"
FRQ = dict(ant="aafq_aant_antenna_record_id", cls="aafq_class_station_code",
           erp_h="aafq_horiz_erp_kw", erp_p="aafq_power_erp_kw", erp_m="aafq_max_erp_kw")

SCHEMA = """
CREATE TABLE stations (
  callsign      TEXT NOT NULL,
  callsign_base TEXT NOT NULL,
  frequency_mhz REAL NOT NULL,
  service       TEXT NOT NULL,
  station_class TEXT,
  erp_kw        REAL,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  city          TEXT,
  state         TEXT,
  facility_id   INTEGER,
  PRIMARY KEY (facility_id)
);
CREATE INDEX idx_callsign_base ON stations(callsign_base);
CREATE INDEX idx_lat ON stations(lat);
CREATE INDEX idx_lon ON stations(lon);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
-- Logos live in the SAME db, keyed by callsign_base. img NULL = a known miss
-- (station has no logo) so we don't retry forever. genre/homepage ride along.
CREATE TABLE logos (
  callsign_base TEXT PRIMARY KEY,
  img           BLOB,
  mime          TEXT,
  genre         TEXT,
  homepage      TEXT,
  source        TEXT,      -- 'radio-browser' | 'sample' | ...
  fetched_at    INTEGER
);
-- Deferred-download queue: stations seen (geo search / tuned) while offline get
-- marked here; a sweep downloads their logos once connectivity returns.
CREATE TABLE logo_wanted (
  callsign_base TEXT PRIMARY KEY,
  marked_at     INTEGER
);
"""

SCHEMA_VERSION = "2"   # bumped when logos/logo_wanted were added


def make_png(size: int, rgb: tuple[int, int, int]) -> bytes:
    """A minimal valid solid-colour RGB PNG (no PIL) for synthetic sample logos."""
    import struct
    import zlib

    def chunk(typ: bytes, data: bytes) -> bytes:
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit, colour type 2 (RGB)
    raw = (b"\x00" + bytes(rgb) * size) * size                # each row: filter byte 0 + pixels
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


# ── helpers ──────────────────────────────────────────────────────────────────
def open_dat(path: str):
    """Stream a pipe-delimited LMS .dat WITHOUT materialising it: return
    (column_index, row_generator) so the big tables (1.25M rows) flow through a
    single pass and non-matching rows are discarded immediately. Callers pull
    fields by position via the returned index — this is the low-memory path the
    join uses; load_dat stays for the human-facing inspect command."""
    f = open(path, "r", encoding="latin-1", newline="")
    rd = csv.reader(f, delimiter="|")
    idx = {h.strip().lower(): i for i, h in enumerate(next(rd))}

    def rows():
        try:
            yield from rd
        finally:
            f.close()
    return idx, rows()


def cell(row: list, idx: dict, name: str) -> str:
    """Positional, bounds-safe, stripped field access for open_dat rows."""
    i = idx.get(name)
    return row[i].strip() if (i is not None and i < len(row)) else ""


def load_dat(path: str) -> tuple[list[str], list[dict]]:
    """Load a pipe-delimited LMS .dat (assumes a header row — VERIFY)."""
    with open(path, "r", encoding="latin-1", newline="") as f:
        reader = csv.reader(f, delimiter="|")
        rows = list(reader)
    if not rows:
        return [], []
    header = [h.strip() for h in rows[0]]
    out = [dict(zip(header, [c.strip() for c in r])) for r in rows[1:] if len(r) >= 1]
    return header, out


def ensure_parent(path: str) -> None:
    """Make the parent dir if the path has one (a bare filename in cwd has none)."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)


def callsign_base(cs: str) -> str:
    return cs.upper().split("-")[0].strip()


def channel_to_mhz(ch: float) -> float:
    # FM channels 200..300 -> 87.9..107.9 MHz, 200 kHz spacing.
    return round(87.9 + (ch - 200) * 0.2, 1)


def dms_to_dec(deg, mn, sec, direction) -> float | None:
    try:
        v = abs(float(deg)) + float(mn) / 60 + float(sec) / 3600
    except (TypeError, ValueError):
        return None
    if str(direction).strip().upper() in ("S", "W"):
        v = -v
    return round(v, 6)


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_fetch(args):
    os.makedirs(args.lms_dir, exist_ok=True)
    print(f"Downloading {LMS_ZIP_URL}")
    req = Request(LMS_ZIP_URL, headers={"User-Agent": "VibeSDR-CarFM station DB build"})
    data = urlopen(req, timeout=300).read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(args.lms_dir)
    print(f"Extracted {len(os.listdir(args.lms_dir))} files to {args.lms_dir}")


def cmd_inspect(args):
    """Print each .dat's columns + a sample row — the tool for wiring the join."""
    files = sorted(f for f in os.listdir(args.lms_dir) if f.endswith(".dat"))
    if not files:
        sys.exit(f"No .dat files in {args.lms_dir} — run `fetch` first.")
    for fn in files:
        header, rows = load_dat(os.path.join(args.lms_dir, fn))
        print(f"\n=== {fn}  ({len(rows)} rows) ===")
        print("  columns:", ", ".join(header))
        if rows:
            sample = {k: v for k, v in list(rows[0].items())[:12]}
            print("  sample :", sample)


def build(lms_dir: str, out_path: str, snapshot: str) -> dict:
    p = lambda n: os.path.join(lms_dir, n)
    for n in (FACILITY_FILE, AF_FILE, LOC_FILE, ANT_FILE, FRQ_FILE):
        if not os.path.isfile(p(n)):
            sys.exit(f"missing {n} in {lms_dir}. `build` needs facility, "
                     "application_facility, app_location, app_antenna, and "
                     "app_antenna_frequency — run `fetch` for those tables.")

    skipped = {"non_fm": 0, "not_licensed": 0, "bad_freq": 0, "no_location": 0}

    # 1) facility.dat — keep licensed FM/FX/FL. Identity, frequency, city/state
    #    all come straight from here (the app_* tables carry no callsign/freq).
    fac, fac_lfid = {}, {}
    idx, rows = open_dat(p(FACILITY_FILE))
    for r in rows:
        if cell(r, idx, F["svc"]).upper() not in FM_SERVICES:
            skipped["non_fm"] += 1; continue
        if (cell(r, idx, F["status"]).upper() not in LICENSED_STATUS
                or cell(r, idx, F["active"]).upper() != "Y"):
            skipped["not_licensed"] += 1; continue
        freq = _num(cell(r, idx, F["freq"]))
        if freq is None:
            ch = _num(cell(r, idx, F["chan"]))
            freq = channel_to_mhz(ch) if ch is not None else None
        if freq is None or not (87.5 <= freq <= 108.1):
            skipped["bad_freq"] += 1; continue
        fid = cell(r, idx, F["id"])
        cs = cell(r, idx, F["call"]).upper()
        fac[fid] = (cs, round(freq, 1), cell(r, idx, F["svc"]).upper(),
                    cell(r, idx, F["city"]) or None, cell(r, idx, F["state"]) or None)
        fac_lfid[fid] = cell(r, idx, F["lfid"])

    # 2) application_facility.dat — map the CURRENT license's application_id(s)
    #    back to each facility (match facility.license_filing_id).
    app2fac = {}
    idx, rows = open_dat(p(AF_FILE))
    for r in rows:
        fid = cell(r, idx, AF["fac"])
        if fid in fac and cell(r, idx, AF["lfid"]) == fac_lfid.get(fid):
            app2fac[cell(r, idx, AF["app"])] = fid

    # 3) app_location.dat — valid transmitter coordinates (DMS, NAD83) per
    #    location record, tied back to the facility via its application_id.
    loc_ll, fac_locs = {}, {}
    idx, rows = open_dat(p(LOC_FILE))
    for r in rows:
        fid = app2fac.get(cell(r, idx, LOC["app"]))
        if fid is None:
            continue
        lat = dms_to_dec(cell(r, idx, LOC["lat_deg"]), cell(r, idx, LOC["lat_min"]),
                         cell(r, idx, LOC["lat_sec"]), cell(r, idx, LOC["lat_dir"]))
        lon = dms_to_dec(cell(r, idx, LOC["lon_deg"]), cell(r, idx, LOC["lon_min"]),
                         cell(r, idx, LOC["lon_sec"]), cell(r, idx, LOC["lon_dir"]))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        rec = cell(r, idx, LOC["rec"])
        loc_ll[rec] = (lat, lon)
        fac_locs.setdefault(fid, set()).add(rec)

    # 4) app_antenna.dat — antenna record -> its location record (ours only).
    ant_loc = {}
    idx, rows = open_dat(p(ANT_FILE))
    for r in rows:
        loc = cell(r, idx, ANT["loc"])
        if loc in loc_ll:
            ant_loc[cell(r, idx, ANT["rec"])] = loc

    # 5) app_antenna_frequency.dat — best ERP (+ class) per location record.
    loc_erp = {}
    idx, rows = open_dat(p(FRQ_FILE))
    for r in rows:
        loc = ant_loc.get(cell(r, idx, FRQ["ant"]))
        if loc is None:
            continue
        erp = (_num(cell(r, idx, FRQ["erp_h"])) or _num(cell(r, idx, FRQ["erp_p"]))
               or _num(cell(r, idx, FRQ["erp_m"])))
        cls = cell(r, idx, FRQ["cls"]) or None
        prev = loc_erp.get(loc)
        if prev is None or (erp or -1) > (prev[0] or -1):
            loc_erp[loc] = (erp, cls)

    # 6) One row per facility, choosing its highest-ERP transmitter location
    #    (the licensed main site; auxiliaries / STAs have lower ERP).
    stations = []
    for fid, (cs, freq, svc, city, state) in fac.items():
        locs = fac_locs.get(fid)
        if not locs:
            skipped["no_location"] += 1; continue
        best = None
        for rec in locs:
            erp, cls = loc_erp.get(rec, (None, None))
            lat, lon = loc_ll[rec]
            key = erp if erp is not None else -1.0
            if best is None or key > best[0]:
                best = (key, lat, lon, erp, cls)
        _, lat, lon, erp, cls = best
        stations.append((cs, callsign_base(cs), freq, svc, cls, erp,
                         lat, lon, city, state, int(fid)))

    if os.path.exists(out_path):
        os.remove(out_path)
    ensure_parent(out_path)
    db = sqlite3.connect(out_path)
    db.executescript(SCHEMA)
    db.executemany(
        "INSERT OR REPLACE INTO stations VALUES (?,?,?,?,?,?,?,?,?,?,?)", stations)
    db.executemany("INSERT INTO meta(key,value) VALUES (?,?)", [
        ("lms_snapshot_date", snapshot),
        ("schema_version", SCHEMA_VERSION),
        ("row_count", str(len(stations))),
        ("built_at", datetime.utcnow().isoformat(timespec="seconds") + "Z"),
    ])
    db.commit()
    integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
    by_service = dict(db.execute(
        "SELECT service, COUNT(*) FROM stations GROUP BY service").fetchall())
    db.close()
    return {"rows": len(stations), "skipped": skipped, "by_service": by_service,
            "integrity": integrity, "out": out_path,
            "size_mb": round(os.path.getsize(out_path) / 1e6, 2)}


def cmd_build(args):
    if not os.path.isdir(args.lms_dir):
        sys.exit(f"No LMS dir {args.lms_dir} — run `fetch` first.")
    snapshot = args.snapshot or date.today().isoformat()
    rep = build(args.lms_dir, args.out, snapshot)
    print(f"\nBuilt {rep['out']}  ({rep['size_mb']} MB, integrity={rep['integrity']})")
    print(f"  rows: {rep['rows']}  by service: {rep['by_service']}")
    print(f"  skipped: {rep['skipped']}")
    if rep["rows"] < 10000:
        print("  WARNING: far fewer FM rows than the ~20k expected — verify the "
              "join (run `inspect`).")
    print(f"\nNext: copy it to the app at {APP_DB_PATH} (or build with "
          f"--out ../../{APP_DB_PATH}), then bump DB_ASSET_VERSION in "
          f"src/services/stationDb.ts so the app re-copies the new DB.")


def cmd_sample(args):
    """Emit a small SYNTHETIC stations.sqlite for emulator/UI dev before the real
    LMS build. Clearly-fake callsigns + city, snapshot 'SAMPLE', a spread of
    ERP/class/service/distance so ranking and the list UI are exercisable."""
    lat0, lon0 = args.lat, args.lon
    # (bearing°, distance km, freq MHz, service, class, ERP kW)
    specs = [
        (0, 8, 88.5, "FM", "C", 100.0), (45, 15, 90.7, "FM", "C1", 50.0),
        (90, 25, 92.3, "FM", "B", 25.0), (135, 40, 94.1, "FM", "C", 100.0),
        (180, 60, 95.9, "FM", "C", 100.0), (225, 12, 97.3, "FL", None, 0.1),
        (270, 20, 98.7, "FX", None, 0.25), (315, 5, 100.1, "FM", "A", 6.0),
        (30, 70, 101.5, "FM", "C", 98.0), (200, 33, 103.3, "FM", "C2", 15.0),
        (110, 50, 104.9, "FX", None, 0.05), (300, 18, 106.7, "FM", "A", 3.5),
    ][: args.count]
    rows = []
    for i, (brg, dist, freq, svc, cls, erp) in enumerate(specs):
        b = math.radians(brg)
        dlat = (dist * math.cos(b)) / 111.32
        dlon = (dist * math.sin(b)) / (111.32 * max(0.01, math.cos(math.radians(lat0))))
        cs = f"K{chr(65 + (i % 26))}MP"  # KAMP, KBMP, ... — obviously sample data
        rows.append((cs, cs, freq, svc, cls, erp,
                     round(lat0 + dlat, 6), round(lon0 + dlon, 6),
                     "Sample City", "SA", 900000 + i))
    if os.path.exists(args.out):
        os.remove(args.out)
    ensure_parent(args.out)
    db = sqlite3.connect(args.out)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO stations VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    # Synthetic logos so the UI shows something offline. Distinct solid colours
    # per station (hash-derived) — obviously fake, but valid renderable PNGs.
    palette = [(0x3B, 0x9E, 0xFF), (0xFF, 0xB8, 0x33), (0x4C, 0xC9, 0x8A), (0xB0, 0x8C, 0xFF),
               (0xFF, 0x6F, 0x91), (0x59, 0xC3, 0xC3), (0xE8, 0xA8, 0x4B), (0x8A, 0x94, 0xA2)]
    genres = ["News/Talk", "Classic Rock", "Country", "Public Radio", "Top 40", "Jazz", None]
    logos = []
    for i, r in enumerate(rows):
        base = r[1]
        logos.append((base, make_png(96, palette[i % len(palette)]), "image/png",
                      genres[i % len(genres)], f"https://example.com/{base.lower()}",
                      "sample", 0))
    db.executemany("INSERT INTO logos(callsign_base,img,mime,genre,homepage,source,fetched_at) "
                   "VALUES (?,?,?,?,?,?,?)", logos)
    db.executemany("INSERT INTO meta(key,value) VALUES (?,?)", [
        ("lms_snapshot_date", "SAMPLE"), ("schema_version", SCHEMA_VERSION),
        ("row_count", str(len(rows))),
    ])
    db.commit()
    nlogo = db.execute("SELECT COUNT(*) FROM logos WHERE img IS NOT NULL").fetchone()[0]
    print(f"Wrote {len(rows)} SAMPLE stations ({nlogo} with logos) to {args.out} around "
          f"({lat0}, {lon0}). integrity={db.execute('PRAGMA integrity_check').fetchone()[0]}")
    db.close()
    print("This is synthetic dev data — run `build` for the real FCC DB, and bump "
          "DB_ASSET_VERSION in src/services/stationDb.ts.")


def cmd_self_test(args):
    """Prove the 5-hop join / filter / emit with synthetic staging files (no FCC).
    Mirrors the real LMS schema: facility -> application_facility -> app_location
    -> app_antenna -> app_antenna_frequency, incl. current-license selection, the
    licensed-only filter, and highest-ERP location choice."""
    import tempfile
    d = tempfile.mkdtemp()
    def w(name, header, rows):
        with open(os.path.join(d, name), "w", encoding="latin-1", newline="") as f:
            wr = csv.writer(f, delimiter="|")
            wr.writerow(header)
            wr.writerows(rows)
    # facility 1 KBBB (keep), 2 K250XY translator (keep), 3 WOLD AM (drop non_fm),
    # 4 KOLD voided (drop not_licensed), 5 KNOLO licensed but no location (drop).
    w(FACILITY_FILE, ["facility_id", "callsign", "service_code", "facility_status",
                      "active_ind", "frequency", "channel", "community_served_city",
                      "community_served_state", "license_filing_id"], [
        ["1", "KBBB-FM", "FM", "LICEN", "Y", "101.1", "266", "Reno", "NV", "LF1"],
        ["2", "K250XY", "FX", "LICEN", "Y", "95.7", "239", "Reno", "NV", "LF2"],
        ["3", "WOLD", "AM", "LICEN", "Y", "", "", "Dallas", "TX", "LF3"],
        ["4", "KOLD", "FM", "FVOID", "N", "88.5", "203", "Gone", "NV", "LF4"],
        ["5", "KNOLO", "FM", "LICEN", "Y", "90.1", "211", "Nowhere", "NV", "LF5"],
    ])
    # APPOLD ties fac1 to a NON-current filing (LFX) -> must be ignored.
    w(AF_FILE, ["afac_application_id", "afac_facility_id", "afac_license_filing_id"], [
        ["APP1", "1", "LF1"], ["APPOLD", "1", "LFX"],
        ["APP2", "2", "LF2"], ["APP5", "5", "LF5"],
    ])
    # KBBB has a main site (LOC1) + a lower-ERP aux (LOC1B); the main must win.
    # 39 31 46.6 N / 119 48 49.7 W ≈ 39.5296, -119.8138.
    w(LOC_FILE, ["aloc_aapp_application_id", "aloc_loc_record_id",
                 "aloc_lat_deg", "aloc_lat_mm", "aloc_lat_ss", "aloc_lat_dir",
                 "aloc_long_deg", "aloc_long_mm", "aloc_long_ss", "aloc_long_dir"], [
        ["APP1", "LOC1", "39", "31", "46.6", "N", "119", "48", "49.7", "W"],
        ["APP1", "LOC1B", "39", "00", "00", "N", "119", "00", "00", "W"],
        ["APPOLD", "LOCOLD", "10", "0", "0", "N", "10", "0", "0", "W"],
        ["APP2", "LOC2", "39", "30", "00", "N", "119", "48", "00", "W"],
        # APP5 (fac 5) intentionally has NO location row -> no_location skip.
    ])
    w(ANT_FILE, ["aant_antenna_record_id", "aant_aloc_loc_record_id"], [
        ["ANT1", "LOC1"], ["ANT1B", "LOC1B"], ["ANT2", "LOC2"], ["ANTOLD", "LOCOLD"],
    ])
    w(FRQ_FILE, ["aafq_aant_antenna_record_id", "aafq_class_station_code",
                 "aafq_horiz_erp_kw", "aafq_power_erp_kw", "aafq_max_erp_kw"], [
        ["ANT1", "C", "100", "100", ""],     # main
        ["ANT1B", "C", "5", "5", ""],        # aux, lower ERP
        ["ANT2", "", "0.25", "0.25", ""],
        ["ANTOLD", "B", "50", "50", ""],
    ])
    out = os.path.join(d, "out.sqlite")
    rep = build(d, out, "2099-01-01")
    ok = True
    def check(name, cond):
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + name)
        ok = ok and cond
    check("2 FM/FX rows kept", rep["rows"] == 2)
    check("AM dropped (non_fm)", rep["skipped"]["non_fm"] == 1)
    check("voided dropped (not_licensed)", rep["skipped"]["not_licensed"] == 1)
    check("no-location dropped", rep["skipped"]["no_location"] == 1)
    check("integrity ok", rep["integrity"] == "ok")
    con = sqlite3.connect(out)
    kbbb = con.execute("SELECT callsign, callsign_base, frequency_mhz, erp_kw, station_class, lat, lon "
                       "FROM stations WHERE facility_id=1").fetchone()
    check("KBBB identity/freq/class", kbbb[:3] == ("KBBB-FM", "KBBB", 101.1) and kbbb[4] == "C")
    check("KBBB picked MAIN site ERP (100, not 5)", kbbb[3] == 100.0)
    check("KBBB coords from DMS", abs(kbbb[5] - 39.5296) < 0.01 and abs(kbbb[6] - (-119.8138)) < 0.01)
    snap = con.execute("SELECT value FROM meta WHERE key='lms_snapshot_date'").fetchone()[0]
    check("meta snapshot set", snap == "2099-01-01")
    ver = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    check("schema_version == 2", ver == SCHEMA_VERSION)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check("logos + logo_wanted tables present", {"logos", "logo_wanted"} <= tables)
    png = make_png(8, (10, 20, 30))
    check("make_png emits a PNG signature", png[:8] == b"\x89PNG\r\n\x1a\n")
    con.close()
    print("\nSELF-TEST PASS" if ok else "\nSELF-TEST FAILURES")
    sys.exit(0 if ok else 1)


def main():
    p = argparse.ArgumentParser(description="Build stations.sqlite from FCC LMS files.")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("fetch", "inspect", "build", "self-test", "sample"):
        sp = sub.add_parser(name)
        sp.add_argument("--lms-dir", default=DEFAULT_LMS_DIR)
        sp.add_argument("--out", default=DEFAULT_OUT)
        sp.add_argument("--snapshot", help="LMS snapshot date YYYY-MM-DD (default: today)")
        if name == "sample":
            sp.add_argument("--lat", type=float, default=37.7749, help="center latitude (default: SF)")
            sp.add_argument("--lon", type=float, default=-122.4194, help="center longitude")
            sp.add_argument("--count", type=int, default=12, help="number of sample stations")
    args = p.parse_args()
    {"fetch": cmd_fetch, "inspect": cmd_inspect, "build": cmd_build,
     "self-test": cmd_self_test, "sample": cmd_sample}[args.cmd](args)


if __name__ == "__main__":
    main()
