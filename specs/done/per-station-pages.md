# Per-station detail pages

**Status: done** (phases 1–4, except per-route OG meta / images, which belong to `custom-og-images.md`). See [Outcome](#outcome) at the bottom for what shipped and the decisions on the open questions.

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

## Outcome

### Routes
- `/station/<slug>` → `StationPage.tsx` (lazy-loaded). Slugs are `slugify(canonical name)`: `christopher-street`, `9th-street`, `14th-street`, `23rd-street`, `33rd-street`, `wtc`, `newark`, `harrison`, `journal-square`, `grove-street`, `exchange-place`, `newport`, `hoboken`.
- Aliases redirect (`<Navigate replace>`, query string preserved) to the canonical slug: PATH abbreviations (`jsq`, `hob`, `npt`, `exp`, `gro`, `nwk`, `har`, `chr`, `9th`, …), `world-trade-center`, and any mixed-case spelling (`/station/JSQ`).
- Unknown slug → "Unknown station" page listing all 13 (no toast/redirect: keeps the bad URL visible and is one click from the right page).
- `/station` → index page of all stations.
- `<title>`/`og:*` per station (and for `/station`) come from `route-meta.ts` (`custom-og-images.md`): prerendered as `dist/station/<slug>.html` at build time, and kept in sync client-side by `useRouteMeta`, which builds on `STATION_INFO`. `StationPage` doesn't set `document.title` itself.

### Single source of truth for OG / prerender work
`www/src/stations.ts` exports `STATION_INFO: { station, slug, title, area, state }[]`, `SLUG_ALIASES`, `resolveSlug`, `stationPath`, `LINE_ROUTES`, `stationLines`. It has no runtime imports (only `import type`), so Node ≥23 build scripts can `import { STATION_INFO } from '../src/stations.ts'` directly (verified with Node 26) — e.g. `scripts/prerender-routes.mjs` can emit `dist/station/<slug>/index.html` for all 13.

It also now owns the constants previously duplicated in `RidesPlot.tsx` (`STATION_COLORS`, `STATION_ABBREVS`, `STATION_CODES`, NY/NJ + line groups, `LINE_GROUPS`, `REGION_GROUPS`, `StationGroup`, `stationsParam`, `displayName`).

### Page contents
1. Breadcrumb (PATH ridership / Stations / name), H1, area blurb, one row per line serving the station: color-coded line chip + "← prev · next →" links along that line (or "terminal").
2. Stat cards (trailing 12 months, all day types): total rides, avg weekday rides/day, % of 2017–19 levels (same calendar months), rank among 13 + share of system rides.
3. Day-type picker (`?d=`, same param/semantics as the homepage) applying to all plots.
4. **Ridership vs. 2017–19** — `buildByDayType(…, "pct2019", …, [station])` from `RidesPlot.tsx` (baseline fixed at 2017–19 with the default Christopher St exclusions).
5. **Avg rides per day / Monthly rides** — `buildByDayType` avg/total (`?m=a|t`), All Time / 2020–Present (`?t=`), stacked bars + 12-mo rolling avg in total mode.
6. **Rank among 13 stations** — monthly rank by total rides over the selected day types (step line, #1 at top).
7. **Avg daily rides by month** — `MonthlyPlots` reused as-is with `stations=[station]`.
8. **Avg hourly entries** — `HourlyPlot` with a new `station` prop (single-station mode): no station picker / BY STATION view / solo-highlight toggle, `hg` defaults to BY DAY TYPE, date range defaults to the last 12 months of `hourly.pqt`.
9. **Data** — client-side CSV download of the station's monthly series (`path-<slug>-monthly.csv`), link to `all.pqt`.
10. Station index ("Other stations") + links back to the homepage (plain, and pinned to this station via `?s=<code>`).

Refactors to enable reuse: `RidesPlot.tsx` exports `useRidesData` (shared react-query key, so homepage → station navigation doesn't refetch), `buildByDayType`, `computeBaselines`, `sumAcrossDayTypes`, `DEFAULT_EXCLUSIONS` and types. `Plot` gained `extraMarginLeft`; `HourlyPlot` y-ticks use `~s` (4.5k) so they fit the narrow left margin.

### Navigation / discoverability
- Homepage legend clicks keep their pin semantics (pin → page-wide filter); instead, when a single station is pinned (`?s=<code>`), RidesPlot's subtitle shows a "<Station> page →" link (just "page →" on narrow screens, next to the station badge). Only on pin, not hover, so the link doesn't vanish as the cursor moves to it.
- Station dropdowns (RidesPlot + HourlyPlot) show a ↗ link per station row (`stationHref` prop on `StationDropdown`), with a floating-ui tooltip.
- `StationIndex` strip on the homepage (above "Also see Bridge & Tunnel"), on each station page, the `/station` page, and the unknown-slug page.
- Omnibar actions "<Station> station page" (keywords: name, abbreviation, area), hidden from the shortcuts modal.
- 404 page links to `/station`.

### Decisions on open questions
1. **Neighborhood / line metadata**: hand-curated in `stations.ts` (`AREAS`, `TITLES`) plus a new ordered `LINE_ROUTES` (weekday stop sequences). `LINE_GROUPS` (homepage filter presets) was left unchanged; note its `JSQ_33` membership includes Exchange Place and Hoboken, which aren't weekday JSQ–33 stops (Hoboken is only on the nights/weekends "via HOB" variant; Exchange Place isn't on JSQ–33 at all) — worth a look separately.
2. **Controls on station page**: day-type picker (global), avg/total + time-range toggles on the rides plot, entry/exit + by day type / by direction on hourly. No station picker, no baseline-years / exclusions controls (fixed 2017–19 default).
3. **SEO / SSG**: SPA route is sufficient (Cloudflare Pages serves `index.html` for unknown paths; verified via `vite preview`). Per-route static HTML with meta tags should come from extending `prerender-routes.mjs` using `STATION_INFO` (OG spec's scope).
4. **Data strategy**: option A (reuse `all.pqt` + `hourly.pqt`, filter client-side); no new pipeline stages.

### Tests
`www/e2e/station-page.spec.ts`: header/line neighbors/plots/rank bounds, client-side neighbor navigation, alias redirects, unknown slug, homepage index hrefs, pinned-station link → station page. `playwright.config.ts` now honors `PW_PORT` (default 8858) so worktrees can run e2e against their own dev server. The pre-existing `performance.spec.ts` "PATH page transfer size" budget failure (≈9.6 MB vs 5 MB on the dev server) reproduces on main and is unrelated.
