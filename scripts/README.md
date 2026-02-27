# Data Pipeline

`scripts/pipeline.mjs` replaces the legacy Apps Script backend.

It generates static JSON files into `web/data/`:

- denominators (`denoms_*`)
- amenities snapshots (`amenities_*`)
- optional raw SingStat CSV archives (`web/data/raw/`)

## Commands

- `node scripts/pipeline.mjs all`
- `node scripts/pipeline.mjs denoms`
- `node scripts/pipeline.mjs amenities`

Optional flags:

- `--force-denoms`
- `--force-amenities`
- `--year YYYY`
- `--snapshot YYYYQn`

## Environment Variables

Required for school geocoding:

- `ONEMAP_EMAIL`
- `ONEMAP_PASSWORD`

Optional:

- `ONEMAP_TOKEN`
- `ONEMAP_TOKEN_EXP_MS`

Geocode cache is persisted at:

- `scripts/cache/onemap_geocode_cache.json`
