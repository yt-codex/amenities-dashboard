# SG Amenities Dashboard (Milestone 0)

This project builds a shareable static web dashboard (hosted on GitHub Pages) that maps Singapore planning areas and shades them by amenity supply.
Data processing will run in Google Apps Script and publish compact JSON artifacts for the frontend.
A quarterly Apps Script trigger (time-based) will refresh snapshots; GitHub Actions scheduling is explicitly out of scope.
The dashboard data model uses planning-area level aggregates rather than raw OSM tag blobs to keep payloads compact.
The panel output will be `snapshot_quarter, planning_area, category, count`.
Resident denominators are versioned as `denom_vintage_date, planning_area, age_group, residents` and mapped to snapshots.
Frontend metrics will support absolute counts and per-1,000 resident rates.
The denominator toggle must support age groups: ALL, 0–6, 13–18, and 65+.
Amenity categories are fixed to exactly six: GP clinics, Dental, Childcare/preschool, Secondary schools, Supermarkets, Eldercare facilities.
Malls, MRT stations, and primary schools are explicitly excluded from scope.
Milestones are implemented incrementally with tests/checkpoints before moving forward.

## Architecture (planned)

```text
[Overpass API + boundary/denominator sources]
                |
                v
      [Google Apps Script ETL]
                |
     (quarterly time trigger)
                |
                v
   [Compact JSON snapshot artifacts]
                |
                v
 [GitHub Pages static frontend (/web)]
                |
                v
 [Map + category/metric/denominator/snapshot controls]
```

## Constraints

- No GitHub Actions scheduler; only Google Apps Script time-based triggers for refresh.
- Keep data compact: planning-area aggregates + compact denominator tables only.
- Support exactly 6 amenity categories (GP clinics, Dental, Childcare/preschool, Secondary schools, Supermarkets, Eldercare facilities).
- Dashboard metric toggle must include absolute counts and per-1,000 residents.
- Denominator toggle must include age groups: ALL, 0–6, 13–18, 65+.

## Milestones (0–8)

- **Milestone 0:** Repo skeleton and architecture docs only (no ingestion or app logic).
- **Milestone 1:** Define schemas/contracts for panel output, denominator vintages, and snapshot metadata.
- **Milestone 2:** Build a tiny static frontend shell with fixed controls and mock data wiring.
- **Milestone 3:** Add planning-area geometry loading and choropleth rendering with placeholder values.
- **Milestone 4:** Implement Apps Script scaffolding for ETL pipeline stages and config management.
- **Milestone 5:** Implement denominator ingestion/version mapping (SingStat primary, Census fallback).
- **Milestone 6:** Implement OSM category queries/aggregation to planning-area counts (compact outputs only).
- **Milestone 7:** Wire published snapshots to frontend selectors and compute robust per-1,000 rates.
- **Milestone 8:** Add quarterly trigger automation, validation checks, and deployment/readiness docs.
