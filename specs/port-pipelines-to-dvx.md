# Port all pipelines in the repo to DVX

## Goal

Replace the ad-hoc mix of GHA-orchestrated steps, Python CLI wrappers, and DVX partial coverage with a unified DVX-orchestrated pipeline — every computation (including side-effect-only stages like "push to Slack" or "deploy to GH Pages") is a `.dvc` file, runnable via `dvx run --commit --push each <target>.dvc`.

## Inspiration

`~/c/hccs/crashes/.github/workflows/daily.yml` (committed, working) does exactly this: its workflow is just a sequence of `dvx run --commit --push each <stage>.dvc` invocations. Side-effect-only stages (`slack_post.dvc`, `deploy.dvc`) are DVX stages that only re-run when upstream deps change.

## Current state (path repo)

- Monthly/hourly PDFs: ✅ DVX-tracked via `dvx import-url -G`
- Yearly parquets + `all.pqt` + `all.xlsx` + chart JSONs: ✅ DVX-tracked
- `www/public/*.dvc`: ✅ DVX-tracked
- GHA workflow: **currently orchestrates** via `path-data gha-update` (the observability wrapper); pipeline steps themselves are `dvx run data/*.dvc www/public/*.dvc`
- Side-effect stages (Slack, deploy) are **not** DVX stages — they live in YAML + Python

## Proposal: adopt the crashes pattern

### Phase 1: side-effect stages as DVX targets

Move the following from YAML/Python into `.dvc` files:

- **`data/slack-daily.dvc`** — side-effect stage, deps = `data/all.pqt` (or similar top-of-funnel artifact); cmd = `path-data slack "..."`. Re-runs only when new data lands.
- **`www/deploy.dvc`** — side-effect stage, deps = `www/public/*.dvc` artifacts; cmd = `pnpm run build && <deploy>`. Replaces the push-triggered `www.yml` deploy.

### Phase 2: external HTTPS snapshots as DVX imports

Any upstream data fetches currently living in Python should become `dvx import-url` calls. In this repo, `refresh.py` already does this internally — confirm all external fetches go through DVX, not bare `requests`.

### Phase 3: simplify the workflow YAML

End state, mirroring `crashes/daily.yml`:

```yaml
- name: Refresh PDFs
  run: dvx run --commit --push each data/*-PATH-*.pdf.dvc
- name: Run pipeline
  run: dvx run --commit --push each data/*.pqt.dvc data/all.pqt.dvc data/all.xlsx.dvc
- name: Regenerate chart JSONs
  run: dvx run --commit --push each www/public/*.dvc
- name: Slack notify
  run: dvx run --commit --push each data/slack-daily.dvc
- name: Deploy
  run: dvx run --commit --push each www/deploy.dvc
```

Each stage auto-commits + pushes on change, so "daily no-op" is a sequence of no-op `dvx run` calls + a single Slack stage that still fires (or is itself a no-op + falls back to the `if: failure()` branch for errors).

### Phase 4: daily Slack on no-change days

The crashes pattern doesn't natively post on no-change days. Options:
1. Keep `path-data gha-update` as the **outer** wrapper that posts the "no change" Slack msg if the DVX pipeline is a full no-op
2. Add a `slack-always-daily.dvc` with a date-based dep (e.g., a small `.date` file touched daily) so it always re-runs — but that's a hack

Probably stick with #1: DVX for content-driven stages, `gha-update` wrapper for the always-fires observability post.

## Dependencies

- DVX itself (use local install or GH pin — mentioned in user guidance)
- Study `crashes/` slack_post.dvc and deploy.dvc as reference implementations

## Non-goals

- Re-architecting the notebooks themselves (they already run cleanly via `juq papermill run`)
- Porting the `www.yml` deploy workflow before the DVX `deploy.dvc` stage is proven locally

## Open questions

1. Does `dvx` now support an empty-deps / always-run mode for side-effect stages that should fire daily regardless of content? (Relevant for daily Slack on no-change days.)
2. Cloudflare Pages deploy vs. GH Pages — do we migrate like crashes did, or keep GH Pages?
