import { describe, it, expect } from 'vitest'
import { rewrite, ROUTES, ORIGIN } from './prerender-routes.mjs'

// The real dist/index.html this rewrites — kept in-sync with ../index.html
// via the build. Using a fixture with the same meta patterns exercises
// rewrite()'s regex-substitution list without needing a real build.
const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>PATH Ridership Data – Hudson County Complete Streets</title>
    <meta name="description" content="Interactive visualizations of PATH train ridership data, parsed from monthly reports published by the Port Authority of NY & NJ." />
    <meta property="og:title" content="PATH Ridership Data" />
    <meta property="og:description" content="Interactive visualizations of PATH train ridership data, parsed from monthly reports published by the Port Authority of NY & NJ." />
    <meta property="og:image" content="https://path.hudcostreets.org/og.png" />
    <meta property="og:url" content="https://path.hudcostreets.org/" />
    <meta property="og:type" content="website" />
  </head>
  <body></body>
</html>`

describe('rewrite()', () => {
  for (const route of ROUTES) {
    describe(`route ${route.path}`, () => {
      const out = rewrite(FIXTURE, route)
      const url = ORIGIN + route.path

      it('sets <title> to route.title', () => {
        expect(out).toContain(`<title>${route.title}</title>`)
      })
      it('sets meta description to route.description', () => {
        expect(out).toContain(`<meta name="description" content="${route.description}"`)
      })
      it('sets og:title to route.ogTitle', () => {
        expect(out).toContain(`<meta property="og:title" content="${route.ogTitle}"`)
      })
      it('sets og:description to route.description', () => {
        expect(out).toContain(`<meta property="og:description" content="${route.description}"`)
      })
      it('sets og:image to route.ogImage', () => {
        expect(out).toContain(`<meta property="og:image" content="${route.ogImage}"`)
      })
      it('sets og:url to ORIGIN+route.path', () => {
        expect(out).toContain(`<meta property="og:url" content="${url}"`)
      })
      it('does not leak the original homepage <title>', () => {
        expect(out).not.toContain('<title>PATH Ridership Data – Hudson County Complete Streets</title>')
      })
    })
  }

  it('throws when a required meta pattern is missing', () => {
    const stripped = FIXTURE.replace(/<meta property="og:url"[^>]*>/, '')
    expect(() => rewrite(stripped, ROUTES[0])).toThrow(/og:url/)
  })
})
