# Fully automated PATH data pipeline via `dvx run`

## Goal

Make the entire data pipeline — from PDF download through chart generation — runnable as a single `dvx run`, with idempotency, dependency tracking, and automatic change detection.

## Current state

### Pipeline tiers (all DVX-tracked except Tier 1)

```
Tier 1: Source PDFs (git-tracked, 20 files)
  data/YYYY-PATH-Monthly-Ridership-Report.pdf
  data/YYYY-PATH-Hourly-Ridership-Report.pdf (2017+)
    ↓ [papermill monthly.ipynb -p year YYYY]
Tier 2: Yearly parquets (DVX-tracked, ~46 artifacts)
  data/YYYY.pqt, data/YYYY-day-types.pqt, data/YYYY-hourly*.pqt
    ↓ [papermill months.ipynb]
Tier 3: Combined data (DVX-tracked, 4 artifacts)
  data/all.pqt, data/all.xlsx, + chart JSONs
    ↓ [cp to www/public/]
Tier 4: Web outputs (DVX-tracked, 10 artifacts)
  www/public/all.pqt, www/public/*.json, www/dist/*
```

### What's outside DVX

- **PDF download** (`path-data refresh`): custom Python script, checks PANYNJ URLs, writes to git-tracked files
- **PDF → parquet dependency**: uses `git_deps` (git SHA of PDF), not DVX `deps`
- Refresh runs separately from `dvx run`, in GHA workflow or manually

### Problems with current approach

1. PDFs are git-tracked but have no DVX provenance (no URL, ETag, or `Last-Modified`)
2. `refresh` is outside the DVX DAG — can't `dvx run` end-to-end
3. Year transitions require manual intervention (new year = new PDF filename)
4. No record of when upstream published new data

## Proposed changes

### Phase 1: Convert PDFs to `dvx import-url --git`

DVX now supports `import-url` with `Last-Modified` tracking. The `--git` (`-G`) flag keeps the file git-tracked (good for small files like these ~400KB PDFs) while adding DVX URL provenance:

```bash
# For each year's monthly PDF:
dvx import-url -G \
  https://www.panynj.gov/content/dam/path/about/statistics/2025-PATH-Monthly-Ridership-Report.pdf \
  -o data/2025-PATH-Monthly-Ridership-Report.pdf

# Similarly for hourly PDFs (2017+)
```

This creates `.dvc` sidecar files with HTTP metadata, while the PDF stays git-tracked:

```yaml
deps:
- path: https://www.panynj.gov/.../2025-PATH-Monthly-Ridership-Report.pdf
  checksum: '"abc123"'    # ETag
  size: 651234
  mtime: '2026-02-11T14:56:29+00:00'  # Last-Modified
outs:
- md5: 9d4ba01e2651bc63...
  path: 2025-PATH-Monthly-Ridership-Report.pdf
  git: true   # committed to git, not .gitignored
```

Benefits of `-G`:
- PDFs remain in git (easy clone, no `dvx pull` needed for source data)
- `.dvc` sidecar tracks URL, ETag, `Last-Modified` (publication history)
- Proper DVX dep for `dvx run` DAG (replaces `git_deps` with `deps`)
- `dvx update` checks URL for changes, downloads + commits if changed

### Phase 2: Update downstream `.dvc` pipeline deps

Currently, yearly parquet `.dvc` files reference PDFs as `git_deps`:

```yaml
meta:
  computation:
    git_deps:
      data/2025-PATH-Monthly-Ridership-Report.pdf: 9d4ba01e2651bc63...
```

After conversion, DVX should detect these as regular `deps` (by MD5 of the PDF output):

```yaml
meta:
  computation:
    deps:
      data/2025-PATH-Monthly-Ridership-Report.pdf: <md5>
    git_deps:
      monthly.ipynb: <git-sha>
```

This may require re-running `dvx run` once to regenerate the `.dvc` metadata with the new dep type.

### Phase 3: End-to-end `dvx run`

With PDFs as DVX imports, the full pipeline becomes:

```bash
# Check for new/updated PDFs from PANYNJ
dvx update data/*.pdf

# Run the full pipeline (only stale stages execute)
dvx run

# Push new artifacts to S3
dvx push
```

`dvx run` handles the entire DAG:
1. Detects changed PDF content (ETag/MD5 changed after `dvx update`)
2. Re-runs `papermill monthly.ipynb` for affected years
3. Re-runs `papermill months.ipynb` (combine) if any yearly parquets changed
4. Copies updated outputs to `www/public/`

### Phase 4: Simplified GHA workflow

```yaml
name: Update PATH Ridership Data
on:
  schedule:
    - cron: '0 10 * * *'  # Daily
  workflow_dispatch:

jobs:
  update-data:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.13' }
      - run: pip install -e .

      - name: Check for new data
        run: dvx update data/*.pdf

      - name: Run pipeline
        run: dvx run

      - name: Push and deploy
        if: # any changes detected
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          dvx push
          git add -u
          git commit -m "Update PATH data"
          git push
```

### Phase 5: Handle year transitions

When a new year starts (e.g., 2026), the pipeline needs a new `import-url` entry. Options:

1. **Manual**: `dvx import-url <url> -o data/2026-PATH-Monthly-Ridership-Report.pdf` once the PDF exists
2. **Script**: `refresh` becomes a thin wrapper that checks if expected URLs exist, runs `dvx import-url` for new ones, and `dvx update` for existing ones
3. **Convention**: GHA workflow can speculatively try `dvx import-url` for the next year, catching 404s gracefully

Option 2 is probably best — keep `refresh` as a lightweight orchestrator:

```python
def refresh():
    """Check for new/updated PATH ridership PDFs."""
    last_ym = last_month()
    for year in {last_ym.y, (last_ym + 1).y}:
        for pdf_fn in [monthly_pdf, hourly_pdf]:
            name = basename(pdf_fn(year))
            dvc_path = f'data/{name}.dvc'
            url = f'{BASE_URL}/{name}'
            if exists(dvc_path):
                # Existing import — check for updates
                run('dvx', 'update', dvc_path)
            else:
                # New year — try to import (skip 404)
                try:
                    run('dvx', 'import-url', url, '-o', f'data/{name}')
                except:
                    pass  # PDF doesn't exist yet
```

## Migration checklist

- [x] `dvx import-url -G` all existing PDFs (20 files with live URLs)
- [x] Update `refresh` to use `dvx update` + `dvx import-url -G`
- [ ] Re-run `dvx run` to update `.dvc` metadata (git_deps → deps for PDFs)
- [ ] Update GHA workflow to use `dvx update && dvx run`
- [ ] Verify `dvx run --dry-run` shows correct DAG
- [ ] Test end-to-end: `path-data refresh && dvx run && dvx push`
- [ ] Delete `ci.yml` (disabled, superseded)

## Benefits

- **Single command**: `dvx update && dvx run` replaces `refresh + update + combine`
- **Idempotent**: re-running is always safe, only stale stages execute
- **Publication tracking**: `Last-Modified` in `.dvc` files gives a history of when PANYNJ published each update
- **Automatic year transitions**: `refresh` handles new years without manual intervention
