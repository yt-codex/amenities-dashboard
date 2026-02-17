# Apps Script — Milestones 1 & 3 (Denominators + Amenity Snapshots)

This folder contains Google Apps Script code to build resident denominator JSON artifacts at:
- **Subzone level** (`SZ × age_group`)
- **Planning-area level** (`PA × age_group`)

Output artifacts are versioned by year (`Time`) and written to a configured Google Drive folder.

## Files

- `Code.gs`: denominator ETL, validation checks, Drive writes, and web endpoint (`doGet`).

## Configure

Open `apps_script/Code.gs` and set:

- `CONFIG.OUTPUT_FOLDER_ID`: Drive folder ID that stores generated JSON.
- `CONFIG.RESIDENT_SOURCE.csvFileId`: Drive file ID of your resident CSV.

Current ingestion mode is intentionally simple and reliable for this milestone:
- **Drive CSV only** (`PA,SZ,Age,Sex,Pop,Time`).

## Expected CSV schema

Header columns (case-insensitive names expected):

- `PA`
- `SZ`
- `Age` (single-year age if numeric; non-numeric values like `90+` are treated as `SENIOR_65_PLUS` and included in `ALL`)
- `Sex`
- `Pop`
- `Time` (year)

Rows missing required values (`PA`, `SZ`, `Pop`, `Time`) are dropped and counted in logs.

## Age groups used (exact)

- `ALL`
- `CHILD_0_6`
- `CHILD_7_12`
- `TEEN_13_18`
- `YOUNG_ADULT_19_34`
- `ADULT_35_54`
- `YOUNG_SENIOR_55_64`
- `SENIOR_65_PLUS`

## Run the build

In Apps Script editor, run:

- `buildDenomsAllYears()`

This performs:
1. Load CSV rows from Drive
2. Parse + normalize rows
3. Aggregate PA/SZ denominators by year
4. Run milestone checks
5. Write output JSON files to Drive (idempotent overwrite by filename)
6. Log build summary

## Output files in Drive

For each available year:

- `denoms_sz_{YEAR}.json`
- `denoms_pa_{YEAR}.json`

And one index:

- `denoms_index.json`

## Test functions / milestone checks

### Main checks run during `buildDenomsAllYears()`

- Sanity total per year: PA-level `ALL` sum must be `> 3,000,000`
- Internal consistency by `(year, pa)`:
  - `ALL >= max(single band)`
  - `ALL >= sum(all 7 non-ALL bands)` (mismatches logged; expected only with non-numeric ages)
- No invalid outputs:
  - no blank PA/SZ
  - no negative residents
  - residents are integers
- Shape checks:
  - PA rows expected as `#PA × 8`
  - SZ rows expected as `#SZ × 8`
  - missing PA/SZ-age combinations logged explicitly
- Endpoint checks:
  - index returns vintages and exact age groups list
  - denominator endpoint returns data for a known year

### Optional standalone test

Run:

- `testDenomsOutputs()`

This validates that Drive artifacts are present and shaped correctly for a known year.

## Publish web app endpoint

1. In Apps Script, click **Deploy** → **New deployment**.
2. Type: **Web app**.
3. Execute as: your preferred service account/user.
4. Access: set as needed for your consumers.
5. Deploy and copy the web app URL.

## Endpoint routes (GET)

- `?path=denoms/index`
- `?path=denoms&geo=sz&year=2025`
- `?path=denoms&geo=pa&year=2025`

Examples:

- `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?path=denoms/index`
- `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?path=denoms&geo=sz&year=2025`
- `https://script.google.com/macros/s/DEPLOYMENT_ID/exec?path=denoms&geo=pa&year=2025`

## Notes on HTTP error status

Apps Script `ContentService` does not provide direct control of HTTP status code on `TextOutput`.
This implementation always returns JSON and includes `status` in the JSON payload, e.g.:

- `{ "status": 400, "error": "..." }`
- `{ "status": 404, "error": "..." }`
- `{ "status": 500, "error": "..." }`



---

## Milestone 3 — Automated amenity snapshots (Overpass → SZ/PA)

Milestone 3 adds an amenity pipeline in `Code.gs` to:
- pull amenity points from OpenStreetMap (Overpass),
- assign points to **subzones** via point-in-polygon,
- aggregate counts to **subzone** and **planning area**,
- store quarterly snapshot JSON files in Drive,
- expose JSON web endpoints for static-site consumption.

### Additional config placeholders (required)

In `CONFIG` in `Code.gs`, set:
- `CONFIG.SUBZONE_GEOJSON_URL` (public URL for deployed `subzone.geojson`)
- `CONFIG.PLANNING_AREA_GEOJSON_URL` (public URL for deployed `planning_area.geojson`, fallback only)
- `CONFIG.OVERPASS_ENDPOINT` (default provided)
- `CONFIG.QUARTERLY_CHECK_MONTHS` (default `[1,4,7,10]`)

Do not use private Drive links unless they are publicly fetchable by Apps Script.

### Amenity categories (exact)

- `gp_clinics`
- `dental`
- `childcare_preschool`
- `secondary_schools`
- `supermarkets`
- `eldercare`

### Snapshot outputs in Drive

For each quarter `YYYYQn`:
- `amenities_sz_YYYYQn.json`
- `amenities_pa_YYYYQn.json`
- `amenities_debug_YYYYQn.json` (small debug payload)

And index:
- `amenities_index.json`

### Endpoints (GET)

- `?path=amenities/index`
- `?path=amenities&geo=sz&snapshot=YYYYQn`
- `?path=amenities&geo=pa&snapshot=YYYYQn`

### Scheduling and manual runs

Run once to install monthly trigger (day 1, 6am):
- `ensureQuarterlyAmenityTrigger_()`

Monthly handler (guarded to quarter months):
- `scheduledAmenityCheck()`

Manual helpers:
- `runAmenityNow()`
- `rebuildAmenitySnapshot("YYYYQn")`

### Milestone test helper

Run:
- `runAmenityTests("YYYYQn")`

This checks:
1. Overpass returns arrays and logs counts by category.
2. Assignment coverage ratios (warn if `< 0.80`).
3. Supermarkets sanity bound (`<= 5000` points, hard-fail above).
4. Compact output keys for SZ payload rows.
5. Idempotency for index snapshot entries.

### Limitation note

`secondary_schools` relies on level tags (`school:level`, `isced:level`, or `grades`) and may undercount where OSM data is incomplete.
