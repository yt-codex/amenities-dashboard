# SG Amenities Dashboard (Milestone 2)

This project builds a shareable static web dashboard (hosted on GitHub Pages) that maps Singapore planning areas and subzones.
Data processing runs in Google Apps Script and publishes JSON endpoints consumed by the frontend.
A quarterly Apps Script trigger (time-based) will refresh snapshots; GitHub Actions scheduling is explicitly out of scope.

## Architecture (current)

```text
[Google Apps Script JSON endpoints] ---> [GitHub Pages static frontend (/web)] ---> [Leaflet map + debug panels]
```

## Milestone 2 scope delivered

- Leaflet map scaffold with geography toggle (Planning Area vs Subzone).
- Local GeoJSON loading from `/web/assets/planning_area.geojson` and `/web/assets/subzone.geojson`.
- Hover tooltip name display and click-to-inspect raw feature properties.
- Denominator debug panel with:
  - index fetch (`route=index`)
  - sample fetch (`route=denoms&geo=<pa|sz>&year=<vintage>`)
  - basic request/error status rendering
  - in-memory index caching to avoid repeated requests

No choropleth shading, amenities extraction, quarterly snapshots, or denominator mapping is included in this milestone.

## Milestone 2 Runbook

### 1) Configure Apps Script endpoint

Edit `web/config.js` and set:

```js
export const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/.../exec",
};
```

`app.js` builds API URLs from this base and calls:

- `?route=index`
- `?route=denoms&geo=pa|sz&year=<vintage>`

If `APPS_SCRIPT_URL` is missing/invalid, the UI shows a visible warning and blocks denominator fetch actions.

### 2) Run locally (important)

Do **not** open `web/index.html` via `file://` because browser fetches for local GeoJSON can fail due to CORS/security rules.

From repo root:

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/web/`

### 3) Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, choose source branch (for example `main`) and folder (`/root` if serving repo root).
3. Ensure `/web` files are committed.
4. Visit `https://<org-or-user>.github.io/<repo>/web/`.

### 4) Checkpoints A–C

#### Checkpoint A — geometry + layer controls

- Open `/web/`.
- Confirm map tiles load.
- Switch geography selector between **Planning Area** and **Subzone**.
- Confirm polygons swap.
- Hover polygon and verify tooltip shows name.
  - Planning area tooltip uses `PLN_AREA_N` (fallback candidates are implemented in code).
  - Subzone tooltip uses `SUBZONE_N` (fallback candidates are implemented in code).
- Click polygon and verify side panel shows raw feature JSON.

#### Checkpoint B — denominator index

- Click **Load Denominator Index**.
- Confirm output shows:
  - `vintages`
  - `age_groups`
  - `geos`
  - `updated_at`
- Confirm `denom_year` dropdown is populated from `vintages`.

#### Checkpoint C — denominator sample

- Choose `denom_geo` (`pa` or `sz`) and `denom_year`.
- Click **Fetch Denominator Sample**.
- Confirm output shows:
  - `rows_count`
  - `first_5_rows`

## Notes on boundary files

The files in `web/assets` are placeholders for Milestone 2 wiring validation.
Replace with simplified authoritative GeoJSON exports from:

- Planning Area Boundary (No Sea) — URA Master Plan 2019 via data.gov.sg
- Subzone Boundary — SVY21 via data.gov.sg

Keep files simplified to preserve frontend performance on GitHub Pages.
