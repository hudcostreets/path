# Per-station detail pages

## Goal

Each of the 13 PATH stations gets its own page at `/station/<slug>` with a focused view of that station's ridership history, and the homepage surfaces links into these pages from the main plots (e.g., legend click / station selector → navigate).

## Why

The homepage optimizes for comparison across stations and across time. It answers questions like "which stations recovered fastest?" and "how do weekday vs. weekend patterns differ?" A per-station page can answer narrower, station-specific questions that clutter the all-stations view:

- How did **this** station's ridership compare to its own pre-COVID baseline over time?
- What's the hour-of-day profile for **this** station (once hourly data is parsed — see `hourly-data-pipeline.md`)?
- Are there known anomalies / closures (e.g., Christopher St weekend closures) and what's the cleaned series look like?
- Context: neighborhood, connecting lines, approximate ridership rank.

## Route design

- URL: `/station/:slug` — slug is lowercase-kebab (e.g., `/station/grove-street`, `/station/wtc`, `/station/33rd-street`)
- Slug derives from the canonical station name; reversible mapping lives alongside `STATIONS` in `RidesPlot.tsx` (or a new `stations.ts`)
- Unknown slug → redirect to homepage with a toast (or 404 page with station list)
- Each page sets custom `og:image`, `og:title`, `og:description` per station (see separate `custom-og-images.md` spec)

## Page contents (MVP)

1. **Header**: station name, neighborhood, connecting PATH lines (color-coded)
2. **Recovery-vs-2019 plot**: single-station view of the pct2019 metric over time
3. **Monthly totals plot**: this station's weekday + weekend traces, rolling average
4. **Rank over time**: where does this station rank among the 13 by monthly ridership?
5. **(Once hourly lands)**: time-of-day curve for weekdays / weekends
6. **Data table / download**: scoped parquet or CSV slice for power users

## Data strategy

Two options:

**A. Reuse `all.pqt`, filter client-side** (simpler, larger initial payload)
- Homepage already loads `all.pqt` via hyparquet; per-station page reuses it
- No new pipeline stages
- Cost: per-station page waits on the same ~1MB+ parquet

**B. Per-station parquet slices** (more work, faster per-station loads)
- Add a DVX stage that emits `www/public/station/<slug>.pqt` (or `.json`) per station
- Faster cold load per-page, but 13 new tracked artifacts

I'd lean **A** until we see the all.pqt load is a noticeable problem on the station page, then consider B.

## Navigation / discoverability

- Homepage: clicking a station name in the legend (or a "View [station]" button in the station dropdown) navigates to `/station/<slug>`
- Per-station page: breadcrumb / link back to "All stations" (homepage)
- Cross-links between adjacent stations along the same line? Nice-to-have

## Open questions

1. Neighborhood / line metadata — where does this live? Hand-curated JSON, or derived from `LINE_GROUPS` / `NY_STATIONS`/`NJ_STATIONS` that already exist?
2. How much of the homepage control UI to expose on the station page? (Probably less — baseline years, day-type filter, recovery vs. absolute. Skip station picker since you're already on a station page.)
3. SEO: is it worth pre-rendering (SSG) these 13 pages, or is SPA-route sufficient?

## Phases

### Phase 1: Skeleton route + single-station plot (the minimum viable page)

- Add `/station/:slug` route in `main.tsx`
- `StationPage.tsx` component, renders name + single `RidesPlot`-style plot filtered to one station
- Legend-click from homepage navigates to station page

### Phase 2: Multiple plots + metadata

- Recovery, totals, rank plots
- Neighborhood / line metadata chip
- Custom `og:image` per station (stubbed; actual generation in separate spec)

### Phase 3: Hourly (depends on `hourly-data-pipeline.md`)

- Once hourly parquets land, add time-of-day plot per station

### Phase 4: Polish

- Cross-links between line neighbors
- Download / data access (ties into the broader "raw data surfacing" thread)

## Non-goals

- Station-level forecasting
- Per-station Slack alerts
- Historical station renamings (Pavonia/Newport etc.) — treat current names as canonical

## Dependencies

- `custom-og-images.md` (separate spec) — per-station OG images
- `hourly-data-pipeline.md` (separate spec) — blocks phase 3
- No blocking changes to `RidesPlot.tsx` expected; may factor out a smaller `SingleStationPlot` from it
