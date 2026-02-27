# Singapore Amenities Explorer

Singapore Amenities Explorer is a static Leaflet dashboard for comparing amenity coverage across Singapore planning areas and subzones.

Frontend is hosted from this repo (GitHub Pages), while Google Apps Script serves JSON endpoints for:
- amenity snapshot counts, and
- resident denominator vintages.

## Project Structure

```text
.github/workflows/   GitHub Actions automation
apps_script/         Apps Script ETL + API routes
web/                 Static dashboard assets
index.html           Root redirect to /web/
```

## Configure Frontend

Set Apps Script URL in `web/config.js`:

```js
export const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/.../exec",
};
```

## Run Locally

Serve over HTTP (not `file://`):

```bash
python -m http.server 8000
```

Open:

- `http://localhost:8000/web/`

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In repository Settings -> Pages, publish from the repository root.
3. Visit:
   - `https://<org-or-user>.github.io/<repo>/`

Root now redirects to `./web/`, so the dashboard opens directly from the base Pages URL.

## Quarterly Amenity Refresh Automation

Workflow file:

- `.github/workflows/quarterly-amenity-refresh.yml`

It runs on Jan/Apr/Jul/Oct and can also be triggered manually.

Required repository secrets:

- `APPS_SCRIPT_URL`
- `APPS_SCRIPT_ADMIN_TOKEN`

Apps Script must also have script property:

- `ADMIN_TRIGGER_TOKEN` (same value as `APPS_SCRIPT_ADMIN_TOKEN`)

## Notes

- Boundary GeoJSON files are in `web/assets/`.
- If `APPS_SCRIPT_URL` is missing/invalid, frontend blocks map rendering and shows a config warning.
- This dashboard uses public datasets/APIs; data quality depends on upstream sources.
