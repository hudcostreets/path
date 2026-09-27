# PATH ridership stats

Cleaned + plotted [PANYNJ][PA data] PATH faregate + hourly ridership.

**Live site:** [pa.hccs.dev](https://pa.hccs.dev/)

![PATH faregate entries (green) and exits (orange) per station, animated through 24 hours, 2025 avg](https://data.pa.hccs.dev/pie-map-24h.gif)

## Data

- [`data/all.pqt`] — per (month, station): total + avg-per-day for weekday / weekend / holiday
- [`data/all.xlsx`] — Excel copy of the above
- [Google Sheet]
- `data/YYYY-hourly.pqt` — per (station, hour, month), avg per weekday / Sat / Sun / holiday
- `www/public/entries_vs_exits.pqt` — per (ym, station), avg entries + exits per day-type
- `www/public/hourly.pqt` — the browser-served hourly parquet (zstd, int32-downcast)

Larger artifacts (parquets, PDFs, the pie-map GIF/MP4) are DVX-tracked (`.dvc` pointers in git, blobs on R2); `dvx pull` fetches the current versions.

## Pipeline

The daily [`daily.yml`][daily-workflow] cron (10:00 UTC):

1. `path-data refresh` — download the latest [PANYNJ ridership PDFs][PA data] (commits any that changed)
2. `dvx run --commit --push each` — re-parse changed years and rebuild derived artifacts (`path-data monthly -y YYYY`, `path-data parse-hourly -y YYYY`, `path-data combine`, `path-data combine-hourly`, `path-data entries-vs-exits`, B&T), committing and pushing each stage as it completes
3. `www/deploy.dvc` → `path-data deploy` — rebuild and deploy the site, iff a `www/public` artifact changed
4. `www/announce.dvc` → `path-data announce` — post "new data" to Slack, only after a successful deploy
5. `path-data daily-report` — "no new data" Slack thread reply, or a failure alert

Local dev:

```bash
git clone https://github.com/hudcostreets/path
cd path
pip install -e .
path-data --help
```

Web frontend lives at [`www/`](www/) — Vite + React + Plotly + Leaflet, deployed to Cloudflare Pages ([pa.hccs.dev]) via [`.github/workflows/www.yml`][www-workflow] (`path-data deploy`) on any push touching `www/**`.

## Bridge & Tunnel

Same repo also serves [/bt](https://pa.hccs.dev/bt) — PANYNJ B&T traffic (Lincoln + Holland tunnels, GWB, Bayonne + Goethals + Outerbridge). Merge per-year `traffic-e-zpass-usage-*.pdf` into one PDF for parsing:

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
[daily-workflow]: .github/workflows/daily.yml
[pa.hccs.dev]: https://pa.hccs.dev
[www-workflow]: .github/workflows/www.yml
