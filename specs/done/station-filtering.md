# Station filtering and interactive controls

## Goal

Let users filter plots by station and explore data more interactively. Currently all data is shown at once; users can only toggle weekday/weekend and time range.

## Current state

- **LinePlots**: System-wide aggregates only (sum of all stations). Queries `all.pqt` via DuckDB.
- **StationPlots**: Per-station traces in a stacked bar chart. All stations always visible. Legend shows station names but clicking toggles visibility via default Plotly behavior.
- **MonthlyPlots**: Per-year traces grouped by month. All years always visible.
- Controls are per-component (toggle buttons embedded in each plot section).

## Questions to resolve

### Page-level vs. per-plot controls?

Currently each plot has its own toggle buttons. Station filtering could be:

**Option A: Per-plot** — Each plot gets its own station filter dropdown/chips. Simple, independent, but potentially confusing if filters diverge between plots.

**Option B: Page-level** — A shared control bar at the top (or sticky) that filters all plots simultaneously. More cohesive UX, but couples the components. Weekday/weekend toggle could also move here.

**Option C: Hybrid** — Page-level station filter (since it's a cross-cutting concern), but per-plot controls for things specific to that view (time range, grouping).

### What does station filtering mean for each plot?

- **LinePlots**: Would need per-station time series. `all.pqt` may not have station-level data — check if the source parquets do. If so, query DuckDB with a WHERE clause.
- **StationPlots**: Already per-station. Filtering = showing/hiding traces (already possible via legend, but a proper control would be better).
- **MonthlyPlots**: Currently aggregated across stations per year. Station filtering would require different source data.

### Data availability

Check what columns exist in `all.pqt` and the yearly parquets (`data/YYYY.pqt`). If station-level data is only in yearly parquets, we'd need either:
- A combined station-level parquet (new pipeline output)
- Or load multiple yearly parquets in DuckDB

## Plan (sketch)

### 1. Station selector component

A multi-select control (chips, dropdown, or checkbox list) showing all PATH stations:
- WTC, Exchange Place, Grove Street, Journal Square, Christopher Street, 9th Street, 14th Street, 23rd Street, 33rd Street, Hoboken, Harrison, Newark

Default: all selected. Clicking a station toggles it. "All" / "None" shortcuts.

### 2. Wire into StationPlots first

Easiest starting point — data is already per-station. Filter traces by selected stations.

### 3. Extend to LinePlots

If station-level time series data is available, add filtered DuckDB queries. Otherwise, this plot stays system-wide with a note.

### 4. Time range controls (future)

A date range slider or picker that constrains all plots. Lower priority — the existing "all time" vs "2020+" toggle covers the main use case.

## Files to modify

| File | Change |
|------|--------|
| `www/src/StationPlots.tsx` | Accept station filter prop, filter traces |
| `www/src/LinePlots.tsx` | Possibly add station-level queries |
| `www/src/Body.mdx` or new layout | Shared station filter state |
| New: `www/src/StationFilter.tsx` | Multi-select station control |
| Pipeline: `path_data/cli/combine.py` | Possibly output station-level combined parquet |
