# Bridge & Tunnel traffic data pipeline

## Goal

Extend the existing PATH ridership site with PANYNJ Bridge & Tunnel traffic data: download PDFs, parse to parquet, visualize on the same site.

## Data source

PANYNJ publishes annual B&T traffic PDFs at a predictable URL:
```
https://www.panynj.gov/content/dam/bridges-tunnels/pdfs/traffic-e-zpass-usage-{YEAR}.pdf
```

Years available: **2011–2025** (2008–2010 return 404).

### Report format

Each year's PDF is a single-page landscape table (generated from Excel via "Acrobat PDFMaker for Excel") titled "YYYY Monthly Traffic and Percent of E-ZPass Usage". Contains:

- **7 crossings**: All Crossings (aggregate), George Washington Bridge, Lincoln Tunnel, Holland Tunnel, Goethals Bridge, Outerbridge Crossing, Bayonne Bridge
- **4 vehicle types per crossing**: Automobiles, Buses, Trucks, Total Vehicles
- **E-ZPass usage %** per crossing (absent in current/partial year)
- **Months**: Jan–Dec columns + Annual/Year-to-Date total
- **Direction**: Eastbound only (tolled direction)

The 2025 PDF is partial (current year), with a footnote: "Traffic volumes are preliminary and subject to change."

### Format changes by year

- 2011–2017: "Annual" column header
- 2018+: "Year-to-Date" column header
- Current year: fewer month columns, no E-ZPass row

## Current state

### Existing work in this repo

- **`parse-traffic.ipynb`**: Parses 2011–2022 from merged PDF using `tabula-py` with a Tabula template (`templates/traffic-e-zpass-usage.tabula-template.json`). Extracts monthly counts by crossing/vehicle type, verifies aggregation sums, outputs `data/traffic.pqt` and `data/ezpass.pqt`.
- **`data/traffic-e-zpass-usage-{2011..2022}.pdf`**: Per-year PDFs (locally downloaded)
- **`data/traffic-e-zpass-usage.pdf`**: Merged PDF (all years, used by the notebook)
- **`data/traffic.pqt`**: 2,538 rows — columns: `Year`, `Crossing`, `Type`, `Month`, `Count`
- **`data/ezpass.pqt`**: 1,071 rows — columns: `Year`, `Crossing`, `Month`, `E-Z Pass Percent`

### What's missing

- **2023–2025 PDFs** not yet downloaded
- Notebook hardcodes `cur_year = 2022`, `last_month = 9`
- No DVX tracking (PDFs are git-tracked without URL provenance)
- No web visualization
- No GHA automation
- Template extraction rects are per-page (one per year) — fragile for new years

## Plan

### Phase 1: Update data (2023–2025)

1. Download missing PDFs:
   ```bash
   for y in 2023 2024 2025; do
     dvx import-url -G \
       "https://www.panynj.gov/content/dam/bridges-tunnels/pdfs/traffic-e-zpass-usage-${y}.pdf" \
       -o "data/traffic-e-zpass-usage-${y}.pdf"
   done
   ```
2. Add DVX provenance to existing 2011–2022 PDFs (same `dvx import-url -G` pattern)
3. Merge all years into updated `data/traffic-e-zpass-usage.pdf` (or switch to per-file parsing)

### Phase 2: Modernize parsing

The current notebook uses `tabula-py` with a per-page template. Options:

**Option A: Keep tabula, extend template** — Add extraction rects for pages 13–15 (2023–2025). Quick but fragile.

**Option B: Switch to per-file parsing** — Parse each year's single-page PDF independently instead of a merged PDF. More robust for yearly updates, no template drift. Each year is one table on one page.

**Option C: Use a different extractor** — `pdfplumber` or `camelot` may handle these tables more reliably without manual templates.

Leaning toward **Option B** — per-file parsing with `tabula-py` or `pdfplumber`, extracting the single table from each year's PDF. Update the notebook or convert to a DVX-tracked script.

### Phase 3: DVX pipeline

Mirror the PATH pipeline structure:

```
data/traffic-e-zpass-usage-YYYY.pdf     # DVX import-url -G (git-tracked w/ URL provenance)
data/traffic-e-zpass-usage-YYYY.pdf.dvc # DVX sidecar (URL, ETag, Last-Modified)
data/bt/traffic.pqt                     # Combined parsed data (DVX-tracked)
data/bt/ezpass.pqt                      # Combined E-ZPass percentages (DVX-tracked)
```

DVX `.dvc` files track the computation:
```yaml
deps:
  - path: data/traffic-e-zpass-usage-2025.pdf
outs:
  - path: data/bt/traffic.pqt
  - path: data/bt/ezpass.pqt
cmd: python parse_bt.py
```

### Phase 4: Visualization

New plot component(s) on the existing site. Potential views:

1. **Monthly traffic by crossing** — stacked bar chart (like PATH station bars), with crossing selector
2. **Monthly traffic by vehicle type** — stacked bars colored by auto/bus/truck
3. **vs. 2019** — percentage recovery lines (like PATH's vs-2019 view)
4. **E-ZPass adoption** — line chart of E-ZPass % over time by crossing

Controls:
- Crossing selector (multi-select dropdown, like station dropdown)
- Vehicle type filter
- Time range (all / 2020–present)

Data loading: DuckDB WASM query against `data/bt/traffic.pqt` (same pattern as PATH).

### Phase 5: GHA automation

Add to existing workflow:
- Check for new/updated B&T PDFs (`dvx update`)
- Re-parse if changed (`dvx run`)
- Deploy updated site

## Open questions

1. **Repo scope**: Keep everything in `hudcostreets/path`? The site URL and repo name are PATH-specific. Could add a `/bt` route or tab, or rename the repo.
2. **Navigation**: How to structure the site with both PATH and B&T data? Tabs? Separate pages? Single scrolling page with sections?
3. **E-ZPass data**: Worth visualizing? It's an interesting supplementary metric (>90% adoption at most crossings now).
4. **Historical data**: 2008–2010 PDFs don't exist at the expected URL. Are they available elsewhere, or is 2011 the floor?
