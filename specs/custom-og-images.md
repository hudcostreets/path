# Custom `og:image` + `og:title` + `og:description` per page

## Goal

Every route on the site produces a high-quality OG preview when shared — not a generic screenshot of the homepage. Per-page, not per-site.

## Routes needing custom OG

Current / near-future:
- **`/`** (homepage) — already has an OG image, possibly stale (`specs/fix-og-image-dimensions.md` is an open related spec)
- **`/bt`** (bridge & tunnel) — currently inherits generic OG
- **`/banner`** (banner preview) — probably doesn't need custom OG (internal preview page)
- **`/station/:slug`** (planned — see `per-station-pages.md`) — 13 pages, each needs its own

## Strategy options

### Option A: static pre-generated OG images (DVX-tracked)

- Generate each OG image via Playwright (screenshot a `?clean=1` version of the page)
- Output to `www/public/og/<route>.png`
- DVX stage deps on the plot data + layout → regenerates when underlying data changes
- React helmet / `<Head>` sets correct `<meta>` per route

Pros: fast serve, cacheable, no runtime cost, uses existing `scrns` tooling
Cons: 13+ images to keep fresh; DVX stages multiply

### Option B: dynamic OG via Cloudflare Worker / edge function

- One small worker reads route + query params, generates image on-the-fly
- Cached at the edge

Pros: one code path, handles arbitrary station slugs
Cons: runtime complexity, infra dependency

### Option C: hybrid

- Static for top-level routes (`/`, `/bt`)
- Dynamic for parametric routes (`/station/:slug`) via either a small SSG step at build time or a worker

**Recommended: A for MVP**, migrate to C if we add enough parametric routes to justify it.

## Meta-tag plumbing

React SPA needs route-aware meta tags. Options:
- `react-helmet-async` or `@vueuse/head`-style lib — writes `<meta>` on nav, but scrapers often don't execute JS
- **Build-time pre-rendering** — `vite-plugin-ssg` / `vite-plugin-prerender` / a custom build step that emits per-route HTML with correct `<meta>` baked in. GitHub Pages serves these directly so scrapers see them without JS.

Without pre-rendering, `<meta og:*>` injected after hydration is hit-or-miss across scrapers (Slack fetches, Twitter does too, Facebook sometimes doesn't, …).

**Probably need build-time pre-rendering** for this to work reliably. `/bt` and `/station/:slug` need their own pre-rendered `index.html`s with the right meta tags.

## Phases

### Phase 1: homepage — get it right

- Confirm `specs/fix-og-image-dimensions.md` (already drafted) is resolved
- Commit baseline `og/home.png` and correct `<meta>` in the homepage HTML

### Phase 2: `/bt`

- Generate `og/bt.png` (Playwright screenshot of `/bt?clean=1`)
- Add a build-time step that emits `www/dist/bt/index.html` (or `/bt.html`) with `<meta>` referencing `og/bt.png`
- Verify in Slack preview

### Phase 3: per-station (depends on `per-station-pages.md`)

- Phase 3a: OG template — generate `og/station/<slug>.png` programmatically from the station's data (plot screenshot + label)
- Phase 3b: per-station HTML with `<meta>` baked in

### Phase 4: social copy

- Per-route `<title>`, `<meta name="description">`, `<meta og:title>`, `<meta og:description>` all distinct and human-written for top-level routes; templated for station pages

## Dependencies

- `scrns` is already in the repo for screenshot automation — reuse it
- `fix-og-image-dimensions.md` — resolve first
- `per-station-pages.md` — blocks Phase 3

## Non-goals

- Twitter Cards beyond what `og:*` already covers
- Animated / video OG previews
