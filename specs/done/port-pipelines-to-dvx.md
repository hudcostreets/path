# Port all pipelines in the repo to DVX

## Goal

Replace the ad-hoc mix of GHA-orchestrated steps, Python CLI wrappers, and DVX partial coverage with a unified DVX-orchestrated pipeline — every computation (including side-effect-only stages like "post to Slack" or "deploy the site") is a `.dvc` file, runnable via `dvx run --commit --push each <target>.dvc`.

## Inspiration

`~/c/hccs/crashes/.github/workflows/daily.yml` does this: its workflow is a sequence of `dvx run --commit --push each <stage>.dvc` invocations. Side-effect-only stages (`njsp/data/slack_post.dvc`, `www/deploy.dvc`) are DVX stages that only re-run when upstream deps change. One deliberate difference here: crashes posts to Slack *before* deploying; this repo only announces new data *after* its deploy succeeds (see [a83f54b], which moved the "deployed" post into `www.yml` for that reason).

## Status

| Phase | Status |
|---|---|
| 0. DAG hygiene (prerequisite, found while porting) | ✅ done |
| 1. Side-effect stages (`www/deploy.dvc`, `www/announce.dvc`) | ✅ done |
| 2. External fetches via DVX | ✅ audited (daily pipeline: yes; ATD: manual, deferred) |
| 3a. DVX workflow (`daily.yml`) | ✅ done; proven by dispatch (dry run 36316450310, real run 36342352067) |
| 4. Daily Slack on no-change days | ✅ done (in `daily.yml`'s `daily-report` step) |
| 3b. Cutover: schedule `daily.yml`, retire `gha-update` + `www.yml`'s notify path | ✅ done (2026-09-27) |

## Phase 0: DAG hygiene ✅

`dvx run` orders stages and decides freshness purely from each `.dvc`'s declared deps, resolving keys relative to the `.dvc`'s dir (or the repo root, if `/`-prefixed). Many keys were written repo-root-relative without the `/`, so they resolved to nothing:

- `www/public/*.dvc` deps `data/20XX.pqt` → `www/public/data/20XX.pqt`: no ordering edge, so `path-data months` / `combine-hourly` ran in level 1, concurrently with (or before) the per-year parsers they read.
- "git dep missing" ⇒ permanently stale (re-ran on every `dvx run`): `data/bt/*.dvc` (`parse_bt.py`, B&T PDFs), `data/all.*.dvc` (`path_data/months.py`), legacy `monthly.ipynb` git_deps (2012–25), 2017–22 hourly (`path_data/parse_hourly.py`; PDF name mis-cased, only resolvable on case-insensitive FSs).
- `data/2023–26-hourly.pqt.dvc` had no `computation` (only their co-outputs did), and `www/public/bt-*.pqt` were written by an `&& cp` in the `data/bt` cmd: `dvx run` never re-recorded their md5s (only `gha-update`'s `dvx add -f` did). They're now proper stages.
- `ensure_year_pipeline` / `ensure_bt_year` (`path-data refresh`) write new-year deps in DVX's spelling.

A per-stage `--commit` pipeline can't work with always-stale stages (each would commit daily), so this was a hard prerequisite. `tests/test_dvc_deps.py` guards it: every declared dep resolves (case-sensitively), and every md5 dep has a producing stage.

This phase also changes the currently-scheduled `gha-update` flow: previously-always-stale stages are now skipped when fresh.

## Phase 1: side-effect stages ✅

- **`www/deploy.dvc`** → `path-data deploy`: `dvx pull` + `dvx push` the `www/public` artifacts (so every content-addressed URL the build embeds resolves before it goes live; `--push each` only *warns* on a failed cache push), `pnpm install`, `pnpm run build`, `404.html`, Playwright e2e (`-E` skips), `wrangler pages deploy` (token via `$CLOUDFLARE_API_TOKEN`). Deps: every `www/public` artifact (`tests/test_side_effect_stages.py` enforces the list stays complete), so any data update rebuilds. Site-code changes keep deploying via `www.yml` on push.
- **`www/announce.dvc`** → `path-data announce`: its only dep is a `git_dep` on `www/deploy.dvc`. DVX rewrites `deploy.dvc` only when `path-data deploy` exits 0; a failed deploy leaves it (and so `announce.dvc`) untouched, and the deploy is retried on the next run. When it runs, it compares the latest months in the deployed FE data (`www/public/all.pqt`, `www/public/bt-traffic.pqt`) to `www/announced.json`; if newer, it posts "New data: PATH through 2026-09 (was 2026-08) — published and deployed" and records them (only after the post succeeds, so a Slack error fails the stage → retried). Deriving months from the FE data (not PDF page counts, as `gha-update` does) means it can't claim data the site doesn't show (the 2026-06-17 incident).
- Both take `-n/--dry-run`; `announce -i` records the current months without posting.
- The committed `.dvc`s record the current state (deployed), and `announced.json` the current prod months (PATH 2026-08, B&T 2026-07).
- No explicit `side_effect: true`: the pinned `dvx` ([9f462bf19]) infers it from "no `outs`", and drops the key when rewriting.

`tests/test_dvx_side_effects.py` exercises these semantics against the pinned `dvx` in a scratch repo (failed deploy ⇒ no announcement; next run retries the deploy, then announces once).

## Phase 2: external fetches ✅ (audit)

- PATH monthly/hourly + B&T PDFs: `path-data refresh` → `dvx update` / `dvx import-url -G`. ✅ (They can't be `dvx run` targets — import `.dvc`s have no `computation` — so refresh stays a `path-data` step.)
- ATD (`path-data atd-{ground,flights}`): bare `requests` (a PowerBI query POST, and a CSV GET); run by hand, not by the daily job; `www/public/atd-*.pqt.dvc` have no `computation`. The POST can't be an `import-url`. **Deferred**: if they should refresh automatically, give them stages with a `fetch: {schedule: …}` (needs `croniter` for cron expressions; not installed) or leave manual.
- `path_data.utils.get_url_mtime` is unused.

## Phase 3a: DVX workflow ✅ (dispatch-only, untested in GHA)

`.github/workflows/daily.yml` (cron `0 10 * * *` since 3b, plus `workflow_dispatch`; `concurrency: path-data`). Steps:

1. `path-data refresh -cc` (commit + push new PDFs)
2. `dvx pull` (non-fatal; hydrates outputs so fresh stages are hash-verified, not recomputed)
3. `$DVX data/*.dvc data/bt/*.dvc www/public/*.dvc` — one invocation, so DVX orders `path-data months`' co-outputs across `data/` and `www/public/`
4. Playwright browsers
5. `$DVX www/deploy.dvc`
6. `$DVX www/announce.dvc`
7. `path-data daily-report` (`if: !cancelled()`; see Phase 4)

`$DVX` = `dvx run -v --commit --push each` (`-n` when the `dry_run` input is set, which is the default: refresh + plans, no commits / pushes / deploys / posts). Each completed stage is committed + pushed immediately, so a mid-pipeline failure keeps the finished stages and the next run resumes from the stale ones (e.g. a failed deploy is retried the next day, then announced).

Transition safety (until 3b): `gha-update` also wrote `www/announced.json` when it committed new data, so `daily.yml` couldn't re-announce an update the old flow announced.

## Phase 4: daily Slack on no-change days ✅

Spec option 1, moved into a final step: `path-data daily-report -s ${{ job.status }} -b <starting sha>`:

- success, and `www/announced.json` unchanged since the run started ⇒ reply to the "no new data" thread (the existing `_post_no_new_data`); also fails loudly if any commit is unpushed (`--push each` only warns when a `git push` fails, and an unpushed `announced.json` would re-announce).
- failure (any step) ⇒ ":rotating_light: PATH pipeline failed", with the failing stage's output (from the `✗ <target>` line in the tee'd `dvx` output → DVX's `tmp/dvx-run-<stem>.log`), or the notebook cell error, as a thread reply.

## Phase 3b: cutover ✅

Prove 3a first:

1. Dispatch `daily.yml` with `dry_run` (default). Expect: refresh finds nothing (or new PDFs, uncommitted), every data stage `skip (up-to-date)` after the pull (else a Phase-0 dep value is off, or the pull missed an output), deploy/announce skipped, report logs a would-be "no new data" reply.
2. Dispatch with `dry_run` unchecked on a no-new-data day: expect no commits, one "no new data" thread reply.
3. Then, in one commit:
   - `daily.yml`: add `schedule: - cron: '0 10 * * *'` (scheduled runs have empty `inputs`, i.e. a real run); drop the "dispatch-only" note.
   - Delete `update-path-data.yml`, the `gha-update` command, and its `announced.json` sync (keep the helpers `daily-report` uses; consider moving them to their own module).
   - `www.yml`: replace its build/e2e/wrangler steps with `path-data deploy` (one definition of "deploy"); drop the `notify`/`site_path`/`data_run_url` inputs, the "Announce new data in Slack" step, and `path-data deploy-notify`.

The first real new-data day after that exercises refresh → parse → per-stage commits/pushes → deploy → announce end to end.

Outcome (2026-09-27):

1. Dry run [36316450310]: all 75 data stages `skip (up-to-date)`; `www/deploy` "would run" only because `deploy.dvc` predated the merged re-capture of `og-bt.png` (fixed in `074d880`, which also bumps `announce.dvc`'s `git_dep` on it).
2. Real run [36342352067]: 75/75 stages skipped, deploy + announce up-to-date, no commits, one "no new data" reply (the day's thread shows "Polled 2x": the old cron's + this one's).
3. Cutover commit:
   - `daily.yml`: `schedule: - cron: '0 10 * * *'`.
   - Deleted `update-path-data.yml`, `gha-update`, `deploy-notify`, and helpers only they used; the rest of `path_data/cli/gha_update.py` (`daily-report`, `backfill-slack`, Slack/summary helpers) is now `path_data/cli/report.py`.
   - `www.yml`: toolchain setup + Playwright browsers + `path-data deploy` (for site-code pushes; data deploys are `www/deploy.dvc`). No inputs / Slack step.

Also observed: the old flow committed + redeployed daily even with no new data, because `refresh` bumps the PDFs' `fetched:` dates. `daily.yml` still commits those bumps (`refresh -cc`), but `www/deploy.dvc` doesn't depend on them, so no redeploy; and a `GITHUB_TOKEN` push doesn't trigger `www.yml`.

[36316450310]: https://github.com/hudcostreets/path/actions/runs/36316450310
[36342352067]: https://github.com/hudcostreets/path/actions/runs/36342352067

## Decisions (formerly open questions)

1. *Always-run mode for daily side effects?* DVX has one (`computation.fetch.schedule`: `daily`/`hourly`/`weekly`/cron/`manual`; the stage is stale when due), but interval schedules drift against a cron trigger (`daily` = "≥24h since `last_run`"), and cron expressions need `croniter`. Not needed: the no-change post is the workflow's final `daily-report` step instead.
2. *Cloudflare Pages vs. GH Pages?* Already on CF Pages (`pa.hccs.dev`), since [b54ff46]. `path-data deploy` targets it.
3. *Where does "announce" live?* `www/announce.dvc` (not the spec's `data/slack-daily.dvc`: it's about deploys, and `gha-update`'s `data/*.dvc` glob would have picked it up).
4. *Slack before or after deploy?* After (unlike crashes), enforced by the DAG (`git_dep` on `deploy.dvc`), not just step order.

## Follow-ups / caveats

- `--commit` makes one commit per executed stage (default message `Run <stem>`; `deploy`/`announce` write their own via `$DVX_COMMIT_MSG_FILE`). A new-data day will add ~10–20 small commits. Stage cmds could write better messages.
- The `dvx` pin ([9f462bf19]) is 30 commits behind `~/c/dvx`; newer versions preserve comments + `side_effect` on rewrite, bound/instrument cache pushes, and fix dep materialization. Bumping is separate from this port.
- `www/public/{og-bt.png,og-map.jpg,pie-map-24h.*,atd-*}` have no stages (manual); `deploy.dvc` still depends on them, so updating one by hand redeploys the next day.

[a83f54b]: https://github.com/hudcostreets/path/commit/a83f54b
[b54ff46]: https://github.com/hudcostreets/path/commit/b54ff46
[9f462bf19]: https://github.com/runsascoded/dvx/commit/9f462bf19
