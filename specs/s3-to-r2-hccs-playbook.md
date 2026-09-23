# Playbook: migrate an HCCS project's public data S3 → R2 (HCCS Cloudflare account)

Reusable recipe derived from the **`path`** migration (2026-09-10, commits
`4928858` + `adc022f` on `hudcostreets/path@main`). Each sibling project
(`hbt`, `ctbk`, `crashes`) has a thin delta spec (`specs/s3-to-r2-hccs.md`) that
references this file; read both.

**Goal:** move a project's public data (DVX cache + any vanity blobs) from S3 to
an R2 bucket in the **HCCS Cloudflare account** (`2363642879f18d37d52dca114059937e`),
served publicly over a custom domain, with prod kept working throughout.

## Prereqs / shared facts

- HCCS R2 creds live in `path/.envrc` (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
  / `R2_ENDPOINT` = `https://2363…937e.r2.cloudflarestorage.com`). Mint a
  **bucket-scoped** R2 API token per project (Object R/W) for that project's CI.
- CF DNS for `hccs.dev` is managed by token `CF_HCCS_DEV_DNS_EDIT_TOKEN`
  (Zone:Read + DNS:Edit). `hccs.dev` and `ctbk.dev` are already CF zones.
- aws profile `cf` = the **RAC `0dcad`** R2 account (`ryan@runsascoded.com`, NOT HCCS; the actual OA account is `43a6f2…`, profile `cfo`) — don't confuse them.
- R2 is S3-compatible: `aws --endpoint-url $R2_ENDPOINT s3 …`, and DVX/DVC honor
  `endpointurl` in `.dvc/config` (dvc_s3 ≥ 3.66).

## Steps

1. **Create the R2 bucket** in the HCCS account (dashboard, or `aws --endpoint-url
   $R2_ENDPOINT s3 mb s3://<bucket>` with an account-level token). Name it to match
   the project's existing bucket (`hbt`, `ctbk`, `nj-crashes`).

2. **Move the data.** Data can't sync directly across two S3 endpoints, so mirror
   through local: `aws s3 sync s3://<src> tmp/mirror/` (source creds) then
   `aws --endpoint-url $R2_ENDPOINT s3 sync tmp/mirror/ s3://<bucket>/` (R2 creds).
   Verify byte parity (`s3 ls --recursive` key+size diff, both sides).

3. **Public access + CORS.**
   - Custom domain: **attach `<host>` to the bucket** (R2 → bucket → Custom Domains).
     Requires `<host>`'s zone on CF. If the zone isn't on CF yet, do the *domain
     move* (below) first. (r2.dev managed URL is an interim option but 503s the
     browser's HEAD probes and is rate-limited — avoid for prod.)
   - CORS: set `AllowedOrigins:["*"]`, `AllowedMethods:["GET","HEAD"]`,
     `AllowedHeaders:["Range","Authorization"]`, expose
     `Accept-Ranges,Content-Range,Content-Length,Content-Encoding,ETag`. Via the
     R2 dashboard CORS editor (Object-scoped token can't `put-bucket-cors`) or the
     S3 API with an admin token.

4. **Repoint the DVX remote** (`.dvc/config`): set the remote `url` to
   `s3://<bucket>/…` and add `endpointurl = $R2_ENDPOINT`. Point `core.remote` at
   it. **CI creds:** wherever the project's CI reads S3 creds (GH secrets, Worker
   vars), swap to the R2 token. Prove a cold `dvx pull` works from R2 (fresh cache)
   and a direct `aws s3 cp` GET of a cache blob with the CI token.

5. **Repoint FE blob reads** to `https://<host>`. If the project uses
   `vite-plugin-dvc` (path does), set `baseUrl`; otherwise find the base-URL
   constant the data loader builds object URLs from. Rebuild and grep the bundle
   for the new host + **zero** stale S3/old-host refs.

6. **HEAD-503 fix (hyparquet projects only).** R2 returns **503** to the browser's
   concurrent HEAD probes at page load (S3 returned 200); charts still render via a
   ranged-GET fallback, but it's a regression. Fix depends on file size:
   - **Small parquets (≲ a few MB):** skip the HEAD — fetch the whole file in one
     GET and hand hyparquet an in-memory `AsyncBuffer` (`bufferFromUrl` in
     `path/www/src/parquet-buffer.ts`). One round-trip, no HEAD.
   - **Large parquets (crashes: ~280MB):** do **not** full-download — keep ranged
     reads but pass a known `byteLength` to skip only the HEAD.
   - `asyncBufferFromStore` (ctbk/crashes) — the store impl decides whether it
     HEADs; verify in the browser network panel before/after.

7. **Domain move (only if `<host>`'s zone isn't on CF yet).** Add the root domain
   as a CF zone (dashboard rejects subdomains). CF's quick-scan **misses custom
   subdomains** — reconcile the full record set via the API against the registrar's
   list (see `path/tmp/cf_dns.py`), set all GH-Pages/external records **DNS-only**.
   Switch nameservers at the registrar (Squarespace: DNS → Domain Nameservers →
   Use custom → the zone's `*.ns.cloudflare.com`). Wait for zone `active`, then
   attach the R2 custom domain.

8. **Cutover (atomic) + verify.** Keep prod on S3 until ready: if you flip CI creds
   to R2 early, either keep the S3-config committed + S3 creds (prod stays on S3) or
   pause the data cron — a config/creds mismatch fails the job. Then, close together:
   re-sync S3→R2 (catch drift), flip CI creds → R2, commit + deploy (config R2 +
   creds R2), watch CI green, **CIC prod** (network panel: blobs load from `<host>`,
   GET 200, no 503). Leave the S3 bucket intact a few green days, then retire.

## Gotchas (all bit the path migration)

- Put the bucket in the **HCCS** account, not RAC `0dcad` — the demo account is a
  different account; a bucket there needs a cross-account cred and orphans the work.
- CF "Connect a domain" **rejects subdomains** ("provide the root domain") — that's
  the silent hang; add the root zone.
- Restore/keep S3 creds while prod is still on S3, or the daily cron fails on a
  config↔creds mismatch (the `AWS_*` GH secrets are shared by pull and push).

## disk-tree interplay

`ctbk` and `nj-crashes` are also **disk-tree demo buckets** — copies live in the
`0dcad` account that `r2.rbw.sh` scans. Once the *source* moves to HCCS R2, the demo
should scan the HCCS buckets (cross-account → one read-only HCCS R2 token in its
rescan runner) instead of maintaining `0dcad` copies. Coordinate with the disk-tree
session (`specs/public-diff-demo.md` there, Phase 4).
