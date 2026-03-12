# Bridge & Tunnel ridership data pipeline

## Goal

Set up a data pipeline for PANYNJ Bridge & Tunnel traffic reports, similar to the existing PATH ridership pipeline.

## Data source

PANYNJ publishes bridge and tunnel traffic data at:
https://www.panynj.gov/bridges-tunnels/en/traffic---volume-information---background.html

Reports cover the six PANYNJ crossings:
- George Washington Bridge
- Lincoln Tunnel
- Holland Tunnel
- Goethals Bridge
- Bayonne Bridge
- Outerbridge Crossing

## Questions to investigate

1. **Report format**: Are they PDFs like PATH data? Excel? HTML tables? What years are available?
2. **Report cadence**: Monthly? Annual? How soon after the period ends?
3. **Data granularity**: Daily? Monthly? By direction? By vehicle class?
4. **URL pattern**: Predictable like PATH (`/YYYY-...-Report.pdf`), or requires scraping?
5. **Scope**: Should this live in the same repo (`hudcostreets/path`) or a separate one? The repo name "path" is specific, but the infrastructure (DVX, GHA, site) could be shared.

## Rough plan

1. **Investigate**: Download sample reports, understand format and URL patterns
2. **Parse**: Write extraction code (tabula-py for PDFs, openpyxl for Excel, etc.)
3. **Pipeline**: DVX-tracked artifacts, `dvx import-url -G` for source files
4. **Visualize**: New plot components on the same site, or a separate page/tab
5. **Automate**: Add to GHA daily check alongside PATH data

## Relationship to PATH pipeline

Shared infrastructure:
- Same DVX remote (S3 bucket)
- Same GHA workflow patterns
- Same `vite-plugin-dvc` for web data
- Same Plotly / `pltly` charting

Could be:
- **Same repo, new namespace**: `data/bt/` for bridge-tunnel data, new notebooks, new CLI commands (`path-data bt-refresh`, etc.)
- **Separate repo**: Cleaner separation, but duplicates infrastructure setup

Leaning toward same repo with a broader scope (rename to "panynj-data" or keep as-is with a B&T section on the site).
