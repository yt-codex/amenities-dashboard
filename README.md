# Singapore Amenities Explorer

Singapore Amenities Explorer is a static Leaflet dashboard hosted on GitHub Pages.
All data generation now runs directly in GitHub Actions and writes versioned JSON files into this repository.

## Architecture

- Frontend: `web/` (static app)
- Generated data: `web/data/`
- ETL pipeline: `scripts/pipeline.mjs`
- Scheduled automation: `.github/workflows/data-refresh.yml`

The app no longer depends on Google Apps Script or Google Drive.

## Frontend Data Source

`web/app.js` loads static files from `web/data/` using `CONFIG.DATA_BASE_PATH` in `web/config.js`.

## Run Locally

1. Install dependencies:
   - `npm install`
2. (Optional) refresh data:
   - `npm run data:all`
3. Serve static files:
   - `python -m http.server 8000`
4. Open:
   - `http://localhost:8000/web/`

## Data Pipeline Commands

- `npm run data:all`
- `npm run data:denoms`
- `npm run data:amenities`

Extra flags:

- `node scripts/pipeline.mjs all --force-denoms --force-amenities`
- `node scripts/pipeline.mjs denoms --year 2025`
- `node scripts/pipeline.mjs amenities --snapshot 2026Q1 --force-amenities`

## GitHub Actions Setup

Workflow file:

- `.github/workflows/data-refresh.yml`

Schedule:

- Runs monthly on day 1 (UTC), with month guards in the script:
  - denoms: Jan/Jul
  - amenities: Jan/Apr/Jul/Oct

Required repository secrets for amenities geocoding:

- `ONEMAP_EMAIL`
- `ONEMAP_PASSWORD`

Optional repository secrets:

- `ONEMAP_TOKEN`
- `ONEMAP_TOKEN_EXP_MS`

## Why root URL now works

Root `index.html` redirects to `./web/`, so this opens the dashboard directly:

- `https://yt-codex.github.io/amenities-dashboard/`

## Notes

- Generated files are committed back into the repo by the workflow.
- Geocode cache is stored in `scripts/cache/onemap_geocode_cache.json`.
- Boundary GeoJSON files are under `web/assets/`.
