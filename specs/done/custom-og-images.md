# Custom `og:image` + `og:title` + `og:description` per page

## Goal

Every route on the site produces a high-quality OG preview when shared — not a generic screenshot of the homepage. Per-page, not per-site.

## Status

Phases 1, 2, 4 done; phase 3 (per-station) has its metadata + HTML plumbing in place, using the homepage image until per-station images exist (see "Remaining" below).

## Mechanism (as built)

Crawlers (Slack, X, iMessage, Facebook, …) don't run JS, so each route's tags must be in the HTML served for that route. Chose **build-time static per-route HTML** (Option A + pre-rendered head tags); no worker / edge function.

- **`www/src/route-meta.ts`**: single table (`ROUTE_METAS`) of `{ path, title, description, ogTitle, ogImage }`; `og:url` is derived (`ORIGIN + path`). Pure data (no React / DOM), so both the app and `vite.config.ts` import it. `routeMeta(pathname)` looks up an entry (trailing slash ignored), falling back to `HOME`.
- **`www/vite-route-meta.ts`** (`routeMetaPlugin`, replaces the old post-build `scripts/prerender-routes.mjs`):
  - build: `index.html` gets `HOME`'s tags; `generateBundle` emits one `dist/<route>.html` copy per other entry (e.g. `bt.html`, `station/grove-street.html`) with `<title>`, `description`, `og:{title,description,image,url}` rewritten (HTML-escaped). A missing tag in `index.html` throws, failing the build.
  - dev: `transformIndexHtml` rewrites the same tags per request URL, so `curl localhost:8858/bt` matches prod.
- **`www/src/useRouteMeta.ts`**: keeps `document.title` + the same meta tags in sync on client-side navigation (mounted in `main.tsx` inside `BrowserRouter`).

### Why `<route>.html`, not `<route>/index.html`

Verified with `wrangler pages dev` (and prod, for the old layout):

| layout | `/bt` | `/bt/` | `/bt.html` |
|---|---|---|---|
| `bt/index.html` (old) | 308 → `/bt/` | 200 | — |
| `bt.html` (new) | **200** | 308 → `/bt` | 308 → `/bt` |

With `bt.html`, the canonical, trailing-slash-free URL (matching `og:url` and the React route) serves directly; query strings survive the 308. `vite preview` resolves `/bt` → `bt.html` the same way, so CI's e2e run (against `pnpm preview`) exercises the built files.

`www.yml`'s `cp dist/index.html dist/404.html` is unchanged: with a top-level `404.html`, CFP returns it (status 404) for paths with no file, e.g. `/banner`, which keep the homepage's tags. `/airports` previously got that 404-status fallback; it now has its own `airports.html` (200).

## Routes

| route | `og:title` | `og:image` |
|---|---|---|
| `/` | PATH Ridership Data | `og.png` (plotly, `path-data months` DVX stage, 1200×630) |
| `/bt` | PANYNJ Bridge & Tunnel Traffic | `og-bt.png` (`scripts/capture-og.ts`, 1200×630) |
| `/map` | PATH Ridership – Hourly Pie-Map | `og-map.jpg` (`scripts/capture-og.ts`, 1200×630) |
| `/airports` | PANYNJ Airport Traffic | `og.png` (fallback) |
| `/station/<slug>` ×13 | `<Station> PATH Station Ridership` | `og.png` (fallback) |
| anything else (`/banner`, …) | homepage's | `og.png` |

`<title>`s are `<page title> – Hudson County Complete Streets`; descriptions are human-written for top-level routes and templated (`stationMeta()`) for stations. Twitter/X reads `og:*` (plus the existing `twitter:card=summary_large_image`), so no separate `twitter:*` tags.

## Phases

### Phase 1: homepage — done

`og.png` is already 1200×630 (`fix-og-image-dimensions.md`'s resize task is done; its GitHub-settings tasks are not) and regenerated with the data by the `path-data months` stage.

### Phase 2: `/bt` — done

- Per-route HTML via `routeMetaPlugin` (above).
- Re-captured `og-bt.png` (data through Jul 2026; was Feb 2026). In `?clean` mode the B&T subtitle (`.bt-subtitle`)'s negative top margin poked it above the viewport once the `h1` was hidden, clipping its text atop the image; clean mode now zeroes that margin.
- Not yet verified in a real Slack unfurl (needs a deploy); the served tags are verified by `e2e/route-meta.spec.ts`.

### Phase 3: per-station — plumbing done, images remaining

- Done: `stationSlug()` (lowercase-kebab of `STATIONS` names: `grove-street`, `wtc`, `33rd-street`, …) and `stationMeta()` generate a `ROUTE_METAS` entry per station, so `dist/station/<slug>.html` is emitted with station-specific title/description/`og:url`, and `useRouteMeta` sets them client-side.
- Remaining:
  - If `per-station-pages.md` defines its own slug function, make `route-meta.ts` import it (or vice versa) so there's one definition; the e2e test pins today's slugs.
  - The station page shouldn't also set `document.title` itself (`useRouteMeta` owns it); tweak `stationMeta()`'s copy to match the page once its contents settle.
  - Per-station images: add the station route to `scripts/capture-og.ts` (13 × `og-station-<slug>.png`, or a single DVX stage), then point `stationMeta().ogImage` at them and add them to `strip-dvc-artifacts.mjs`'s `KEEP`.

### Phase 4: social copy — done

See the Routes table / `ROUTE_METAS`.

## Tests

- `www/src/route-meta.test.ts` (vitest): `applyRouteMeta` output (exact string), missing-tag error, lookup / fallback, route list, station slugs.
- `www/e2e/route-meta.spec.ts` (Playwright): fetches each route's served HTML, parses its `<title>` + `<meta>`s, asserts exact equality (literal values for `/`, `/bt`, `/station/grove-street`; table-driven for the rest); OG images served; client-side navigation updates title + meta. `PW_PORT` overrides the Playwright port (default 8858).

## Non-goals

- Twitter Cards beyond what `og:*` already covers
- Animated / video OG previews
- Dynamic (worker-generated) OG images; revisit if parametric routes outgrow static generation
