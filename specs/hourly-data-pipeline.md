# Hourly PATH ridership data — parse, pipeline, plot

## Goal

Extract everything available from PANYNJ's "PATH Ridership Report (By Hour)" PDFs (2017–present), land it in the DVX-tracked pipeline, and surface 1–2 new plots on the homepage that give readers a time-of-day view complementing the existing by-month plots.

## Current state

- Hourly PDFs are **DVX-tracked** (via `dvx import-url -G`): `data/YYYY-PATH-Hourly-Ridership-Report.pdf` for 2017+
- `refresh` already handles the hourly PDFs the same way as monthlies (both fetched, both year-transition aware)
- Some hourly parsing exists in `hourly.ipynb` / `data/YYYY-hourly*.pqt` — **audit needed** to confirm what fields are currently extracted vs. what the PDF actually contains

## Open questions (resolve before implementing)

1. **What fields does the PDF expose?** The report title says "By Hour" — but does it decompose by:
   - Station × hour?
   - Station × hour × day-of-week?
   - Station × hour × direction (NB/SB/EB/WB)?
   - Station × hour × month?
   - Entries vs. exits?
   A manual read of one page would settle this in ~5 minutes.

2. **What does the existing `hourly*.pqt` capture?** Check:
   - `data/*-hourly*.pqt.dvc` to see what outs exist
   - `hourly.ipynb` (if it exists) or equivalent parser for what it's pulling
   - Any gaps vs. what's actually in the PDF

3. **What's the highest-value plot?** Options, roughly in order of likely value:
   - **Time-of-day curve** (ridership by hour, averaged across weekdays or split by weekday/weekend) — the "classic" commute peak visualization
   - **Heatmap** (station × hour, or day-of-week × hour) — dense but informative
   - **Peak-shift over time** (e.g., has the AM peak broadened post-COVID?) — narrative-rich, requires multi-year aggregation

## Proposed phases

### Phase 1: Audit existing parsing

- Read one hourly PDF page-by-page; enumerate every table/field present
- Diff against what `*-hourly*.pqt` currently stores
- Write a short "what we extract / what we ignore / what's structurally hard" note in this spec

### Phase 2: Extend the parser

- Add any missing fields to the `hourly.ipynb` notebook output
- Regenerate year parquets via `juq papermill run`
- Verify DVX deps update cleanly (one or more new columns → new MD5 → downstream stages re-run)

### Phase 3: Combine stage

- Add an `all-hourly.pqt` combine step (mirrors `all.pqt` for monthlies)
- Output JSON slices for the plot(s) to `www/public/`, DVX-tracked

### Phase 4: Plot(s)

- Implement 1–2 plots in `www/src/`, following `RidesPlot.tsx` conventions
  (URL-state via `use-prms`, metric/station/daytype filters where applicable,
  Plotly via pltly)
- Wire into `PathPlots.tsx` (or add a new section below)

## Non-goals

- Real-time hourly data (PANYNJ only publishes monthly aggregates)
- Directional decomposition if the PDF doesn't contain it
- Predictive / forecasting plots

## Dependencies / related

- Spec `specs/done/automate-pipeline.md` (fully landed; hourly PDFs are already imported)
- `path_data/cli/refresh.py` already covers hourly PDFs end-to-end
