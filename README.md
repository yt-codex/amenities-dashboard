# Singapore Amenities Explorer

Singapore Amenities Explorer is a static web mapping application that lets users compare amenities coverage across Singapore planning areas and subzones.
The frontend is designed for GitHub Pages hosting, while Google Apps Script serves JSON data endpoints for amenity counts and denominator baselines.

## What the app does

- Renders Singapore boundaries (planning area or subzone) on an interactive Leaflet map.
- Lets users switch amenity categories, snapshot vintages, and metrics (`COUNT` or `PER_1000`).
- Supports age-group-aware denominator calculations for normalized rates.
- Shows contextual status information, legend bins, and join-health diagnostics to make data quality visible.
- Includes category definition tooltips so users can quickly understand what each amenity bucket contains.

## Data sources and responsibility notice

This dashboard compiles data from publicly available sources and APIs.
While care is taken in assembling and presenting the information, the author does not guarantee and is not liable for the accuracy, completeness, or integrity of the underlying data.

## Project structure

```text
apps_script/   Google Apps Script project for endpoint generation/serving
web/           Static frontend (Leaflet map UI + controls)
```

## Configure the app

Edit `web/config.js` and set your deployed Apps Script web app URL:

```js
export const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/.../exec",
};
```

The frontend calls this base URL with query parameters to retrieve index and data payloads.

## Run locally

Serve the repository through a local HTTP server (do not open `web/index.html` with `file://`):

```bash
python3 -m http.server 8000
```

Then open:

- `http://localhost:8000/web/`

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. In **Settings → Pages**, select your deployment branch/folder.
3. Ensure the `web/` directory is included in the published path.
4. Open `https://<org-or-user>.github.io/<repo>/web/`.

## Notes

- Boundary files are located in `web/assets/`.
- Keep GeoJSON files simplified for smooth rendering on static hosting.
- If the Apps Script endpoint is missing or invalid, the UI will show a configuration warning and block data fetches.
