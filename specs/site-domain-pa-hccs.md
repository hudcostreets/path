# Move prod site domain → `pa.hccs.dev` (+ free `path.hccs.dev` for a redirect, move data to `data.pa.hccs.dev`)

Follow-on to the S3→R2→HCCS data migration (`4928858` + `adc022f`, playbook `specs/s3-to-r2-hccs-playbook.md`). That moved the *data* to R2 on `path.hccs.dev`. This moves the *site*.

## Goal / target end state

- **Canonical site:** `pa.hccs.dev` (GH Pages). "pa" = Port Authority — the umbrella for both PATH ridership and B&T (Bridge & Tunnel) data this project hosts, so a better name than `path`.
- **Data blobs:** `data.pa.hccs.dev` (R2 custom domain on bucket `path`), freeing `path.hccs.dev`.
- **`path.hccs.dev`:** no longer serves R2; **301 → `pa.hccs.dev`** (alias for the project).
- **`path.hudcostreets.org`** (current prod): **301 → `pa.hccs.dev`**.

## Current state (verified 2026-09-22)

- Site: `path.hudcostreets.org`, GH Pages, repo `hudcostreets/path`, `gh-pages` branch `CNAME` = `path.hudcostreets.org` (HTTP 200). Deploy: `.github/workflows/www.yml` → `JamesIves/github-pages-deploy-action@v4` (wipes `gh-pages` each run).
- `path.hccs.dev` → R2 custom domain on bucket `path` (CF-proxied). Root `/` 404s (no index object — normal R2 behavior); real blobs serve, e.g. `path.hccs.dev/.dvc/cache/files/md5/ca/181795721daf78beb622eb9dd5befe` (hourly.pqt) = **200**.
- `pa.hccs.dev` → CNAME to `hudcostreets.github.io` (DNS-only) from the zone move; **not yet claimed** by any repo (bare `https://pa.hccs.dev/` = TLS error / no cert). Free to take.
- `hccs.dev` zone is on **Cloudflare** (HCCS account `2363642879f18d37d52dca114059937e`); DNS via token `CF_HCCS_DEV_DNS_EDIT_TOKEN` (Zone:Read + DNS:Edit).
- `hudcostreets.org` zone is on **Google Cloud DNS** (`ns-cloud-*.googledomains.com`), NOT Cloudflare — its redirect happens at that registrar, not via a CF rule.
- FE data-base is set in two files: `www/vite.config.ts` (`dvc({ ..., baseUrl: 'https://path.hccs.dev/.dvc/cache' })`) and `www/src/static-urls.ts` (`R2_STATIC_BASE = 'https://path.hccs.dev'`, used by the pie-map GIF/MP4 URLs).

## Token-scope caveat

`CF_HCCS_DEV_DNS_EDIT_TOKEN` is Zone:Read + DNS:Edit only. It **cannot** attach/detach an R2 custom domain (needs R2 admin) nor create a **Redirect Rule** (needs Ruleset edit). Those steps are **CF dashboard (Chrome, HCCSx / ryanw@hudcostreets.org)** unless the token is scope-bumped. Plain DNS records (the redirect placeholder) the token can do.

## Ordering — add-new-before-remove-old (no prod downtime)

Prod (`path.hudcostreets.org`) reads blobs from `path.hccs.dev`, so don't detach that until the FE is repointed and deployed.

### Phase 1 — new data host (both live)
1. **CF/R2 dashboard:** attach `data.pa.hccs.dev` to bucket `path` (auto-creates the CNAME, provisions cert). Re-apply the bucket CORS policy (`AllowedOrigins:["*"]`, `GET,HEAD`, `Range`; expose `Accept-Ranges,Content-Range,Content-Length,Content-Encoding,ETag`) — it's bucket-scoped so it carries over, but verify.
2. Verify `data.pa.hccs.dev/.dvc/cache/files/md5/ca/181795721daf78beb622eb9dd5befe` = 200 + CORS headers (range 206).

### Phase 2 — repoint FE + site domain, deploy
3. `www/vite.config.ts`: `baseUrl` → `https://data.pa.hccs.dev/.dvc/cache`.
4. `www/src/static-urls.ts`: `R2_STATIC_BASE` → `https://data.pa.hccs.dev`.
5. Add **`www/public/CNAME`** = `pa.hccs.dev` (rides every build; the deploy action wipes `gh-pages` otherwise). This flips the GH Pages custom domain path.hudcostreets.org → pa.hccs.dev on next deploy (GH allows only one).
6. Update user-visible refs: README "Live site" link, any `path.hudcostreets.org` in FE, `og:image` / meta absolute URLs → `https://pa.hccs.dev`.
7. Commit + push → CI deploys. Confirm `pa.hccs.dev` DNS-only (grey) in CF. Wait for GH Let's Encrypt cert, then **enable "Enforce HTTPS"** (repo Settings → Pages — Chrome/you).
8. **CIC** `https://pa.hccs.dev`: charts render, network panel shows blobs from `data.pa.hccs.dev` (GET 200, no 503), zero stale `path.hccs.dev`. Grep the built bundle for `path.hccs.dev` → none.

### Phase 3 — free & redirect `path.hccs.dev`
9. **CF/R2 dashboard:** detach `path.hccs.dev` from bucket `path`.
10. **CF dashboard:** create a proxied placeholder DNS for `path` (CF redirect-only pattern: `AAAA path 100::`, proxied) + a **Redirect Rule** (Dynamic Redirect): `http.host eq "path.hccs.dev"` → `concat("https://pa.hccs.dev", http.request.uri.path)`, 301, preserve query string. Verify `path.hccs.dev/anything` 301s to `pa.hccs.dev/anything`.

### Phase 4 — redirect the old prod domain
11. **Google/Squarespace registrar** (owner of `hudcostreets.org`): add domain forwarding `path.hudcostreets.org` → `https://pa.hccs.dev` (301, path/query preserved if supported). Once GH Pages custom domain flipped to pa.hccs.dev (step 5), path.hudcostreets.org would 404 at GH otherwise. — Chrome/you.

## Verification checklist

- `https://pa.hccs.dev` → site 200, HTTPS enforced, charts render from `data.pa.hccs.dev`.
- `https://data.pa.hccs.dev/.dvc/cache/files/md5/ca/181795721daf78beb622eb9dd5befe` → 200, `access-control-allow-origin: *`, range → 206.
- `https://path.hccs.dev/` and a sub-path → 301 to `pa.hccs.dev`.
- `https://path.hudcostreets.org/` → 301 to `pa.hccs.dev`.
- CI green; built bundle has zero `path.hccs.dev` / `path.hudcostreets.org` refs.

## Rollback

Data on bucket `path` is untouched (only the custom-domain hostname changes). To roll back: re-attach `path.hccs.dev` to the bucket, revert the two FE constants + `www/public/CNAME`, redeploy. R2 objects never move.

## Handoff summary (what needs Chrome / non-code)

- **CF dashboard (HCCSx):** attach `data.pa.hccs.dev`; later detach `path.hccs.dev` + add its Redirect Rule + placeholder DNS.
- **GH repo Settings → Pages:** enable Enforce HTTPS after cert.
- **Google/Squarespace registrar:** forward `path.hudcostreets.org` → `pa.hccs.dev`.
- Everything else (FE constants, `CNAME`, README/meta) is code in this repo.
