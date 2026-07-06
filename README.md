# PATH ridership stats

Cleaned + plotted [PANYNJ][PA data] PATH faregate + hourly ridership.

**Live site:** [path.hudcostreets.org](https://path.hudcostreets.org/)

![PATH faregate entries (green) and exits (orange) per station, animated through 24 hours, 2025 avg](https://hudcostreets.s3.amazonaws.com/path/pie-map-24h.gif)

## Data

- [`data/all.pqt`] — per (month, station): total + avg-per-day for weekday / weekend / holiday
- [`data/all.xlsx`] — Excel copy of the above
- [Google Sheet]
- `data/YYYY-hourly.pqt` — per (station, hour, month), avg per weekday / Sat / Sun / holiday
- `www/public/entries_vs_exits.pqt` — per (ym, station), avg entries + exits per day-type
- `www/public/hourly.pqt` — the browser-served hourly parquet (zstd, int32-downcast)

Larger artifacts (parquets, PDFs, the pie-map GIF/MP4) are DVX-tracked (`.dvc` pointers in git, blobs on S3); `dvx pull` fetches the current versions.

## Pipeline

The daily [`update-path-data.yml`][update-workflow] cron runs `path-data gha-update`:

1. `path-data refresh` — download the latest [PANYNJ ridership PDFs][PA data]
2. `dvx run` — re-parse any changed years and rebuild derived artifacts (`path-data monthly -y YYYY`, `path-data parse-hourly -y YYYY`, `path-data combine`, `path-data combine-hourly`, `path-data entries-vs-exits`)
3. `dvx add` + `dvx push` — snapshot new outputs to S3
4. `git commit` and, if `www/public/**/*.dvc` actually changed, `gh workflow run www.yml` to redeploy the site

Local dev:

```bash
git clone https://github.com/hudcostreets/path
cd path
pip install -e .
path-data --help
```

Web frontend lives at [`www/`](www/) — Vite + React + Plotly + Leaflet, deployed to GitHub Pages via [`.github/workflows/www.yml`][www-workflow]. Any push touching `www/**` (including new `.dvc` pointers to fresh data) redeploys automatically.

## Bridge & Tunnel

Same repo also serves [/bt](https://path.hudcostreets.org/bt) — PANYNJ B&T traffic (Lincoln + Holland tunnels, GWB, Bayonne + Goethals + Outerbridge). Merge per-year `traffic-e-zpass-usage-*.pdf` into one PDF for parsing:

```bash
gs -o merged.pdf \
   -sDEVICE=pdfwrite \
   -dPDFFitPage \
   -g12984x10033 \
   -dPDFSETTINGS=/prepress \
   traffic-e-zpass-usage-20*
```

(cf. [SO](https://stackoverflow.com/a/28455147/544236))


[`data/all.pqt`]: data/all.pqt
[`data/all.xlsx`]: data/all.xlsx
[PA data]: https://www.panynj.gov/path/en/about/stats.html
[Google Sheet]: https://docs.google.com/spreadsheets/d/1HMrVNcRzYryUtI5mnPc5K5hrt2UT1w78MwzexXinqys/edit
[update-workflow]: .github/workflows/update-path-data.yml
[www-workflow]: .github/workflows/www.yml
