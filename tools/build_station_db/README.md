# build_station_db — FCC LMS → `assets/db/stations.sqlite`

Build-time ETL for the offline "stations near me" database (addendum §3). This is
a **human-run build step**, not on-device code. It downloads the FCC LMS public
files, flattens the FM facilities into one denormalized row each, and emits the
SQLite that ships in the APK.

> The FCC explicitly warns the LMS structure **is not simple** and that staff
> can't help with the tables. Budget real time for the join. This README is where
> we record what we found so the next refresh isn't a re-discovery.

## Run

The script is self-contained — you can run it from anywhere (copy it out of the
repo if you like). Outputs default to `stations.sqlite` **in the current
directory**; pass `--out` to place it elsewhere.

```bash
python3 build_station_db.py fetch      # download + unzip LMS files -> ./lms_files
python3 build_station_db.py inspect    # print each .dat's columns + a sample row
```

The FCC download sits behind an Akamai WAF that returns **HTTP 403** to scripted
clients. `fetch` already sends browser-like headers, but if it still refuses,
download the zip once in a browser and hand it to the same command:

```bash
# browser -> https://enterpriseefiling.fcc.gov/dataentry/public/tv/lms_db_download/lms_public_database.zip
python3 build_station_db.py fetch --zip lms_public_database.zip   # offline unzip
```

Everything after `fetch` (`inspect`, `build`) is offline.

```bash
python3 build_station_db.py build      # emit ./stations.sqlite
python3 build_station_db.py self-test  # prove the pipeline with synthetic data
python3 build_station_db.py sample     # emit a small SYNTHETIC db for emulator/UI dev

# to drop it straight where the app bundles it, run from that folder or use --out:
python3 build_station_db.py build --out ../../assets/db/stations.sqlite
```

The app loads the bundled DB from `assets/db/stations.sqlite`, so copy the built
file there (the build prints this reminder).

`sample` writes ~12 obviously-fake stations (callsigns `KAMP`, `KBMP`, …, city
"Sample City", snapshot `SAMPLE`) around a center (`--lat/--lon`, default San
Francisco), **each with a synthetic solid-colour PNG logo**, so you can build the
"Nearby" UI and exercise the query/ranking/logos in the emulator **before**
wrangling the real LMS download. Replace it with a real `build` (and bump
`DB_ASSET_VERSION`) before shipping.

Then **bump `DB_ASSET_VERSION` in `src/services/stationDb.ts`** so installed apps
re-copy the new DB, and rebuild the app.

Only `python3` (stdlib) is required — no pip installs.

## Data source

- **FCC LMS Public Database Files** — authoritative, US, public domain, updated
  each business day. Frequency, callsign, service, class, ERP, TX lat/long.
- **Do NOT use CDBS** — frozen since 2023-10-01. Lots of stale tooling still
  points at it.
- Format/genre and logos are NOT in the FCC data — those come at runtime from
  Radio-Browser (`src/services/radioBrowser.ts`), never bundled.

If the download URL 404s, get the current one from the LMS Public Database page:
<https://enterpriseefiling.fcc.gov/dataentry/public/tv/lmsDatabase.html>

## The join (VERIFIED against the 2026-07-16 LMS files)

Identity + frequency come straight from `facility.dat`. Engineering and location
live in `app_*` tables keyed by **opaque record ids, not `facility_id`** — a
5-hop chain, wired in `build()` with the column names in the CONFIG block:

```
facility ──license_filing_id──▶ application_facility (afac_facility_id,
                                   afac_application_id, afac_license_filing_id)
         ──afac_application_id──▶ app_location (aloc_aapp_application_id)
                                   → DMS coords + aloc_loc_record_id
         ──aloc_loc_record_id───▶ app_antenna (aant_aloc_loc_record_id,
                                   aant_antenna_record_id)
         ──aant_antenna_record_id▶ app_antenna_frequency → ERP
```

| Output column   | LMS file                    | LMS column                          | Verified |
|-----------------|-----------------------------|-------------------------------------|----------|
| `facility_id`   | `facility.dat`              | `facility_id`                       | ✅ 2026-07-16 |
| `callsign`      | `facility.dat`              | `callsign`                          | ✅ |
| `service`       | `facility.dat`              | `service_code` (FM/FX/FL)           | ✅ |
| `city`/`state`  | `facility.dat`              | `community_served_city`/`_state`    | ✅ |
| `frequency_mhz` | `facility.dat`              | `frequency` (fallback: `channel`)   | ✅ |
| `erp_kw`        | `app_antenna_frequency.dat` | `aafq_horiz_erp_kw` → `aafq_power_erp_kw` → `aafq_max_erp_kw` | ✅ |
| `station_class` | —                           | **not present** — `aafq_class_station_code` is blank in all 339k rows; emitted as NULL | ✅ (absent) |
| `lat`/`lon`     | `app_location.dat`          | `aloc_lat_deg/mm/ss/dir` + `aloc_long_*` (DMS, NAD83; ignore `_nad27`) | ✅ |

Findings from the real data (2026-07-16 snapshot):
- **Status filter matters:** of 55,651 active FM-service facilities only
  **21,484** are on-air licensed (`LICEN` + `LICRP` renewal-pending — KUSC is
  LICRP). The rest are voided/cancelled/pending and are dropped (`not_licensed`).
  `LICSL` (licensed-but-**silent**) is deliberately excluded — not receivable.
- **Current license:** a facility has up to ~30 applications; only those whose
  `afac_license_filing_id` equals `facility.license_filing_id` are used.
- **Multiple transmitter sites** per license (main + auxiliaries): the
  highest-ERP location wins (the licensed main site).
- **application.dat is not needed** (1.25M rows, largest table) —
  `facility.license_filing_id` already selects the current license.
- **Streaming required:** tables are read via `open_dat` one row at a time
  (~10-30 s, ~150 MB). Materialising them as dicts needs >4 GB — don't.
- Build report: 20,733 rows kept; skipped = non_fm 125,045 / not_licensed
  34,167 / no_location 750 / bad_freq 1. Row math reconciles exactly.

## Output

`stations.sqlite` — table `stations` (schema in the addendum §4), a `meta` table
(`lms_snapshot_date`, `schema_version`, `row_count`, `built_at`), and two logo
tables (schema_version 2):

- `logos(callsign_base, img BLOB, mime, genre, homepage, source, fetched_at)` —
  logos live in the **same** DB, as blobs. `build` leaves it empty (the app fills
  it at runtime); `sample` populates it with synthetic PNGs. `img IS NULL` records
  a known miss so the app doesn't retry forever.
- `logo_wanted(callsign_base, marked_at)` — the deferred-download queue: stations
  seen offline get marked, then swept when data returns.

Expect ~20–22k station rows, single-digit MB *without* logos; bundling logos adds
roughly the sizes noted in the addendum discussion. The build warns if it
produces far fewer FM rows than expected (usually a broken join).

## Station Explorer (sibling toy)

`station_explorer.py` in this folder is a tiny stdlib **Tkinter** GUI to browse a
`stations.sqlite` with the *same* logic as the app (bounding box → haversine →
receivability score, plus RDS PI ⇄ callsign decode, self-checked against
`stationGeo.ts` / `piCallsign.ts`). Handy for sanity-checking a build without an
emulator.

```bash
# GUI needs Tk: `sudo apt install python3-tk` (Debian/Mint/Ubuntu)
python3 station_explorer.py --db stations.sqlite
# headless, no Tk:
python3 station_explorer.py --cli --db stations.sqlite --lat 37.77 --lon -122.42
python3 station_explorer.py --db stations.sqlite --pi 0x54C4     # decode a PI
```

With no `--db`, it looks for `stations.sqlite` in the current directory, then
next to the script itself, then the repo's `assets/db/stations.sqlite` — first
one found wins. So `build`/`sample` then `station_explorer.py` in the same folder
just works, and running it from inside the repo finds the bundled DB.

## Logo search simulation

`logo_search.py` is a single-file Tkinter GUI that simulates **exactly what the
app will auto-search** for a station logo, over real stations — no typing. Press
Run and it iterates a built-in set of real US FM stations (or a real
`stations.sqlite` you load) and, for each, derives the query the way the app does
and shows the resulting images so you can judge whether they're usable:

Each source gets the query it actually wants:
- **Wikidata** — exact call sign (P2317 → P154 logo).
- **Commons** — `"<callsign> logo"` (file search matches file names, not prose).
- **Wikipedia** — article search `"<callsign> radio station"` → the page's lead
  image (usually the logo; far broader US coverage than Commons files).
- **Web** — descriptive `"<callsign> <city> radio logo"` handed to DuckDuckGo.

Automatic open sources are inherently thin for radio logos (mostly notable/public
stations), so expect modest hit rates — the whole-web share-back path is the real
workhorse. The query formulas live in `commons_url` / `wikipedia_url` / `ddg_url`.

```bash
python3 logo_search.py        # pip install pillow for thumbnails
```

Run on a normal connection (Wikimedia blocks locked-down proxies); needs Tk
(`sudo apt install python3-tk`). If the results look wrong, that's the signal to
change the query formula (one place: `keyword_query()`), which the app will then
match.

## Three-letter callsign table (separate task)

`src/services/piCallsign.ts` needs the NRSC-4-B Annex D three-letter → PI table
(e.g. KOB, WHO, WGN). It's intentionally empty there. Populate `THREE_LETTER_PI`
from Annex D during a DB refresh; it's a small, static list.
