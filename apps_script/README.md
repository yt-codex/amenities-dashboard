# Apps Script - Denominators and Amenity Snapshots

This folder contains Google Apps Script code that:
- builds denominator JSON artifacts (PA + SZ by age group),
- builds quarterly amenity snapshot JSON artifacts (PA + SZ), and
- serves both through a web app endpoint.

## Files

- `Code.gs`: ETL, checks, Drive writes, and web routes (`doGet`, `doPost`).

## Configuration

Edit `apps_script/Code.gs` and set the `CONFIG` values:

- `OUTPUT_FOLDER_ID`: Drive folder that stores generated JSON files.
- `RESIDENT_SOURCE.csvFileId`: resident CSV file ID (`PA,SZ,Age,Sex,Pop,Time`).
- `SUBZONE_GEOJSON_URL`: public URL to deployed subzone GeoJSON.
- `OVERPASS_ENDPOINT`: Overpass API endpoint.
- `QUARTERLY_CHECK_MONTHS`: quarter start months (`[1,4,7,10]` by default).
- `ADMIN_TRIGGER_TOKEN_PROPERTY`: script property name used by admin POST routes (`ADMIN_TRIGGER_TOKEN` by default).

## Denominator Build

Run in Apps Script editor:

- `buildDenomsAllYears()`

Outputs to Drive:

- `denoms_sz_{YEAR}.json`
- `denoms_pa_{YEAR}.json`
- `denoms_index.json`

## Amenity Snapshot Build

Amenity categories:

- `gp_clinics`
- `dental`
- `childcare_preschool`
- `primary_schools`
- `secondary_schools`
- `supermarkets`
- `eldercare`

For each quarter `YYYYQn`, outputs:

- `amenities_sz_YYYYQn.json`
- `amenities_pa_YYYYQn.json`
- `amenities_debug_YYYYQn.json`
- `amenities_index.json`

Run helpers:

- `ensureQuarterlyAmenityTrigger_()` to install monthly trigger (day 1, 6am).
- `scheduledAmenityCheck()` monthly handler (builds only in quarter months, and only if snapshot is missing).
- `runAmenityNow()` force-check current quarter now.
- `rebuildAmenitySnapshot("YYYYQn")` rebuild a specific quarter.
- `runAmenityTests("YYYYQn")` test helper.

## Web Endpoints

GET routes:

- `?path=denoms/index`
- `?path=denoms&geo=sz&year=2025`
- `?path=denoms&geo=pa&year=2025`
- `?path=amenities/index`
- `?path=amenities&geo=sz&snapshot=YYYYQn`
- `?path=amenities&geo=pa&snapshot=YYYYQn`

POST admin routes (token required):

- `path=admin/amenities/quarterly-refresh`
- `path=admin/amenities/run-now`

POST params:

- `token`: must match script property `ADMIN_TRIGGER_TOKEN`.
- `force` (optional, `true|false`): bypass quarter-month guard for quarterly-refresh route.

## GitHub Actions Quarterly Trigger

1. In Apps Script project settings, add script property:
   - key: `ADMIN_TRIGGER_TOKEN`
   - value: long random secret
2. In GitHub repository secrets, add:
   - `APPS_SCRIPT_URL` (web app `/exec` URL)
   - `APPS_SCRIPT_ADMIN_TOKEN` (same token value)
3. Commit includes workflow: `.github/workflows/quarterly-amenity-refresh.yml`
   - scheduled on Jan/Apr/Jul/Oct (UTC)
   - also supports manual run via `workflow_dispatch`

## Notes

Apps Script `ContentService` cannot set HTTP status codes directly for `TextOutput`.
Responses include a JSON `status` field (for example `200`, `400`, `404`, `500`).
