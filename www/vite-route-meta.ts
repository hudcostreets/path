import { HOME, ogUrl, ROUTE_METAS, routeMeta, type RouteMeta } from './src/route-meta'
import type { Plugin, Rollup } from 'vite'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Replace the route-dependent head tags in `html` with `meta`'s values.
 *  Throws if any tag is missing from `index.html`, so a template edit can't
 *  silently ship pages without them. */
export function applyRouteMeta(html: string, meta: RouteMeta): string {
  const title = escapeAttr(meta.title)
  const description = escapeAttr(meta.description)
  const subs: [RegExp, string][] = [
    [/<title>[^<]*<\/title>/, `<title>${title}</title>`],
    [/<meta name="description" content="[^"]*"/, `<meta name="description" content="${description}"`],
    [/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${escapeAttr(meta.ogTitle)}"`],
    [/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${description}"`],
    [/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${escapeAttr(meta.ogImage)}"`],
    [/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${escapeAttr(ogUrl(meta))}"`],
  ]
  let out = html
  for (const [re, replacement] of subs) {
    if (!re.test(out)) throw new Error(`route-meta: pattern ${re} not found in index.html`)
    out = out.replace(re, replacement)
  }
  return out
}

/** `/bt` → `bt.html`, `/station/wtc` → `station/wtc.html`. Cloudflare Pages
 *  (and `vite preview`) serve `/bt` from `bt.html` directly, whereas
 *  `bt/index.html` would 308 `/bt` → `/bt/`. */
export function routeHtmlPath(meta: RouteMeta): string {
  return `${meta.path.replace(/^\//, '')}.html`
}

/** Bake per-route `<title>` / description / `og:*` into the served HTML:
 *  - dev: rewrites `index.html` per request URL,
 *  - build: `index.html` gets `HOME`'s tags, plus one `<route>.html` copy per
 *    other `ROUTE_METAS` entry. */
export function routeMetaPlugin(): Plugin {
  return {
    name: 'route-meta',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      const pathname = ctx.server && ctx.originalUrl
        ? new URL(ctx.originalUrl, 'http://localhost').pathname
        : '/'
      return applyRouteMeta(html, routeMeta(pathname))
    },
    generateBundle(_, bundle) {
      const index = bundle['index.html'] as Rollup.OutputAsset | undefined
      if (!index) throw new Error('route-meta: no index.html in bundle')
      const html = index.source.toString()
      for (const meta of ROUTE_METAS) {
        if (meta === HOME) continue
        this.emitFile({
          type: 'asset',
          fileName: routeHtmlPath(meta),
          source: applyRouteMeta(html, meta),
        })
      }
    },
  }
}
