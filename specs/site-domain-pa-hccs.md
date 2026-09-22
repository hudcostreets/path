# Move prod site → Cloudflare Pages (`pa.hccs.dev`); data → `data.pa.hccs.dev`

Follow-on to the S3→R2→HCCS data migration (`4928858` + `adc022f`, playbook `specs/s3-to-r2-hccs-playbook.md`). That moved the *data* to R2 on `path.hccs.dev`. This moves the *site* off GitHub Pages onto **Cloudflare Pages**, and gives the site + data cleaner names under the Port Authority umbrella (`pa` = PATH + B&T).

## Goal / target end state

- **Site:** Cloudflare Pages project **`pa`** (HCCS account `2363642879f18d37d52dca114059937e`), canonical custom domain **`pa.hccs.dev`**. Replaces GitHub Pages.
- **Data blobs:** `data.pa.hccs.dev` (R2 custom domain on bucket `path`), freeing `path.hccs.dev`.
- **Legacy `path.hccs.dev` + `path.hudcostreets.org`:** attached to the same CFP project (CFP serves many domains per project) and/or 301 → `pa.hccs.dev`.

## Why CFP, not GHP

GitHub Pages allows **one** custom domain per repo, so switching domains is atomic and breaks the old URL until a registrar redirect lands. Cloudflare Pages serves **multiple** custom domains per project (crashes serves both `crashes.hccs.dev` and `crashes.hudcostreets.org` from one project) with native redirects — no cutover gap — and keeps the site in the HCCS CF account beside the data and the sibling projects (crashes, ctbk).

## Current state (verified 2026-09-22)

- Site: `path.hudcostreets.org`, GH Pages, repo `hudcostreets/path`, deployed via `JamesIves/github-pages-deploy-action` in `.github/workflows/www.yml`. Stays live (untouched) throughout — CFP is stood up independently, so there is **no downtime**.
- `data.pa.hccs.dev` → R2 custom domain on bucket `path`, **Active**. Verified GET 200 (etag = md5), CORS `*` + expose-headers, Range → 206.
- `path.hccs.dev` → still R2 custom domain on bucket `path` (current prod reads blobs here). Root `/` 404s (no index object — normal). Free it only after nothing reads it.
- `pa.hccs.dev` → CNAME to `hudcostreets.github.io` (DNS-only) from the zone move; not yet claimed. Attaching it to the CFP project repoints this record to the project.
- `hccs.dev` zone on **Cloudflare** (HCCS); `hudcostreets.org` zone on **Google Cloud DNS** (`ns-cloud-*.googledomains.com`), not CF.
- FE data-base set in `www/vite.config.ts` (`dvc` `baseUrl`) + `www/src/static-urls.ts` (`R2_STATIC_BASE`); site canonical/og in `www/index.html` + `www/scripts/prerender-routes.mjs` (`ORIGIN`).

## Deploy idiom (mirrors crashes `www/deploy.sh`)

`npx wrangler pages deploy dist --project-name pa --branch main --commit-dirty=true`, with env `CLOUDFLARE_API_TOKEN=$CF_HCCS_INFRA_TOKEN` + `CLOUDFLARE_ACCOUNT_ID=2363642879f18d37d52dca114059937e`. In `www.yml` this replaces the GH-Pages action (build + e2e steps unchanged; `404.html` copy kept for SPA fallback).

**Token:** reuse `CF_HCCS_INFRA_TOKEN` — the HCCS Pages token crashes already uses (in `crashes/.envrc` + a GH secret on the crashes repo). Set it as a GH secret on `hudcostreets/path`; add to `path/.envrc` for local deploys.

## Phases (zero-downtime — GHP stays live until we repoint DNS)

### Phase 1 — data host [DONE]
`data.pa.hccs.dev` attached to bucket `path` (HCCS dash). FE repointed to it (commit). `path.hccs.dev` untouched.

### Phase 2 — stand up CFP `pa`
1. Create CFP project `pa` (HCCS account), production branch `main`.
2. First deploy of the built `dist/` (local `wrangler pages deploy`, or let CI do it once wired).
3. Attach `pa.hccs.dev` as a custom domain on the project (CFP repoints the `hccs.dev` CNAME + provisions cert). Verify `pa.hccs.dev` serves the SPA + reads blobs from `data.pa.hccs.dev` (network panel: GET 200, no 503).

### Phase 3 — CI → CFP
4. `www.yml`: swap GH-Pages action for the wrangler deploy step (done in repo). Remove `www/public/CNAME` (GHP-only).
5. Add `CF_HCCS_INFRA_TOKEN` GH secret to `hudcostreets/path`.
6. Push → CI builds + `wrangler pages deploy`. Watch green (`ghws`).

### Phase 4 — legacy domains + retire GHP
7. `path.hccs.dev`: detach from the R2 bucket (only after prod no longer reads it — i.e. once `path.hudcostreets.org` also serves the new build), then either attach to the CFP project or 301 → `pa.hccs.dev` (CF redirect rule; `hccs.dev` is on CF).
8. `path.hudcostreets.org`: repoint its Google-DNS CNAME `hudcostreets.github.io` → `pa.pages.dev` and attach to the CFP project (served, crashes-style), **or** 301 at the Google/Squarespace registrar. Either way it stays up.
9. Retire GHP: remove the repo's Pages custom domain; the stale `gh-pages` branch can be left or deleted.

## Token-scope note

`CF_HCCS_DEV_DNS_EDIT_TOKEN` (Zone:Read + DNS:Edit) can't create/deploy a Pages project — that needs `CF_HCCS_INFRA_TOKEN` (Pages:Edit). CFP custom-domain attach + the Phase-4 redirect rule are CF dashboard/API with that token, or the dashboard (HCCSx).

## Verification checklist

- `https://pa.hccs.dev` → CFP-served SPA, 200; charts render from `data.pa.hccs.dev` (GET 200, no 503); `/bt` + `/map` prerendered og tags = `pa.hccs.dev`.
- CI: `www.yml` deploys to CFP project `pa`, green.
- Built `dist/`: `data.pa.hccs.dev` (blobs) + `pa.hccs.dev` (og), zero `path.hccs.dev` / `path.hudcostreets.org`.
- Legacy `path.hccs.dev` / `path.hudcostreets.org` → served by CFP or 301 to `pa.hccs.dev`; neither 404s.

## Rollback

Site: GHP stays live until Phase 4, so rollback pre-cutover = revert `www.yml` + redeploy gh-pages. Data: bucket `path` objects never move; re-attach `path.hccs.dev` and revert the two FE constants to roll the data host back.
