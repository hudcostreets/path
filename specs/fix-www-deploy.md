# Fix `www.yml` deploy pipeline (broken since 2026-03-16)

## Symptom

`Deploy www` (`.github/workflows/www.yml`) has not had a successful run since `b994bb2 DVC-track BT parquet files` on 2026-03-16. First failure surfaced in run `24310647208` on 2026-04-12 — 13 Playwright tests failed, site never re-deployed.

## Timeline of the silence

Between 2026-03-16 and 2026-04-12, several commits touched `www/**` and should have triggered `www.yml` per its `paths` filter:

- `80b4773 Use plotly-basic bundle via PlotlyProvider, drop static plotly imports`
- `cf27856 Replace duckdb-wasm with hyparquet; add performance budgets`
- `33775c3 Tighten performance budgets after plotly-basic migration`
- `e7874f1 Migrate to idiomatic pltly APIs; fix @mdx-js/react CJS build error`
- `79e923c Add 2026 data; auto-create pipeline stubs for new years`

`gh run list --workflow=www.yml --limit 100` shows no runs for any of these. The workflow file itself wasn't disabled. Push events clearly fired (ref is `main`, paths should match). **Needs investigation** — possible causes:

1. Branch protection / required-status-checks settings changed such that workflow is skipped when other workflows are queued
2. Repo-level actions concurrency limits
3. GitHub Actions API / UI inconsistency (runs exist but are filtered from list)
4. The commits were somehow force-pushed or squash-rebased in a way that dropped the triggering events

## Concrete failures in run 24310647208

### Failure class 1: CSS bundle over 40KB budget

- `www/e2e/budgets.json` sets `css_bundle_kb: 40`
- Actual `www/dist/assets/` has two CSS files:
  - `index-*.css` — app styles — 33.45 KB
  - `index-basic-*.css` — plotly.js/basic CSS — 65.48 KB
  - **Total: 98.93 KB**
- Budget was set at `cf27856` (Mar 16, pre-plotly-basic) and never adjusted when `80b4773` introduced the 65KB plotly CSS chunk
- The test (`www/e2e/performance.spec.ts:28–40`) sums *all* `.css` files in `dist/assets/`, so it's measuring app + plotly together

**Fix options:**

- **A**: Raise `css_bundle_kb` to ~105 (covers current total + headroom). Honest but loses the "app-only" signal.
- **B**: Modify the test to exclude plotly's CSS (filter out `index-basic-*.css`). Keeps a meaningful app-CSS budget.
- **C**: Split the budget into `app_css_kb` (e.g., 40) and `plotly_css_kb` (e.g., 70). Most nuanced, requires schema changes.

Recommend **B** — the app-CSS budget is what we care about for catching our own bloat; plotly CSS is exogenous.

### Failure class 2: Plot never renders (timeouts)

12 tests all wait for `.plot-container .js-plotly-plot .legend .traces` and time out at 20 s. Likely root cause: `www/public/*.dvc` files reference S3 MD5-addressed blobs, but `www.yml` has **no `dvx pull` step**. When the built SPA tries to fetch data, URLs 404, plots never populate, selector never appears.

**Fix:** add `dvx pull` before `pnpm run build`. Requires AWS creds in the workflow (already set in `update-path-data.yml` — mirror to `www.yml`).

### Possibly also: Node 20 deprecation warnings

`actions/checkout@v4` and `actions/setup-python@v5` pinned to Node 20 — warning only, not a failure, but we should bump to `@v6` (already available) before Sep 16 2026.

## Proposed fix (single PR)

1. Add AWS creds + `dvx pull` to `www.yml`
2. Adjust CSS budget test to filter out `plotly`-owned CSS (Option B)
3. (Optional) bump `actions/*@v4/v5` → `@v6`
4. Re-enable `dvx pull data/all.pqt` or equivalent — need to confirm which `www/public/*.dvc` paths the SPA actually fetches at runtime

After these changes, push a small `www/` change (e.g., a no-op comment) to verify the full green deploy path before trusting subsequent runs.

## Non-goals

- Fixing the "workflow didn't fire for a month" root cause (separate GitHub-settings investigation)
- Migrating deploy from GH Pages to Cloudflare Pages (noted in `port-pipelines-to-dvx.md`)

## Dependencies

- `specs/port-pipelines-to-dvx.md` — long-term, this whole deploy would become a DVX stage (`www/deploy.dvc`) following the `crashes/daily.yml` pattern
- `specs/custom-og-images.md` — per-route OG needs working build first
