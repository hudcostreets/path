import { describe, expect, it } from 'vitest'
import { applyRouteMeta, routeHtmlPath } from '../vite-route-meta'
import { HOME, ROUTE_METAS, routeMeta, stationSlug } from './route-meta'
import { STATIONS } from './stations'

const FIXTURE = `<head>
    <title>X</title>
    <meta name="description" content="X" />
    <meta property="og:title" content="X" />
    <meta property="og:description" content="X" />
    <meta property="og:image" content="X" />
    <meta property="og:url" content="X" />
    <meta property="og:type" content="website" />
</head>`

describe('applyRouteMeta()', () => {
  it('rewrites every route-dependent tag, HTML-escaping values', () => {
    expect(applyRouteMeta(FIXTURE, routeMeta('/bt'))).toBe(`<head>
    <title>PANYNJ Bridge &amp; Tunnel Traffic – Hudson County Complete Streets</title>
    <meta name="description" content="Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present." />
    <meta property="og:title" content="PANYNJ Bridge &amp; Tunnel Traffic" />
    <meta property="og:description" content="Interactive visualizations of monthly vehicle counts at the six PANYNJ bridges and tunnels (GWB, Lincoln, Holland, Bayonne, Goethals, Outerbridge), 2011–present." />
    <meta property="og:image" content="https://pa.hccs.dev/og-bt.png" />
    <meta property="og:url" content="https://pa.hccs.dev/bt" />
    <meta property="og:type" content="website" />
</head>`)
  })

  it('throws when a required tag is missing', () => {
    const stripped = FIXTURE.replace(/\n *<meta property="og:url"[^>]*>/, '')
    expect(() => applyRouteMeta(stripped, HOME)).toThrow('route-meta: pattern /<meta property="og:url" content="[^"]*"/ not found in index.html')
  })
})

describe('routeMeta()', () => {
  it('matches with or without a trailing slash', () => {
    expect(routeMeta('/bt/')).toBe(routeMeta('/bt'))
    expect(routeMeta('/bt').path).toBe('/bt')
  })
  it('falls back to HOME for unknown routes', () => {
    expect(routeMeta('/')).toBe(HOME)
    expect(routeMeta('/banner')).toBe(HOME)
    expect(routeMeta('/nope/x')).toBe(HOME)
  })
})

describe('ROUTE_METAS', () => {
  it('has one entry per top-level route and station page', () => {
    expect(ROUTE_METAS.map(m => m.path)).toEqual([
      '/',
      '/bt',
      '/map',
      '/airports',
      ...STATIONS.map(s => `/station/${stationSlug(s)}`),
    ])
  })
  it('non-home routes are emitted as `<route>.html`', () => {
    expect(ROUTE_METAS.filter(m => m !== HOME).map(routeHtmlPath)).toEqual([
      'bt.html',
      'map.html',
      'airports.html',
      ...STATIONS.map(s => `station/${stationSlug(s)}.html`),
    ])
  })
  it('station slugs are lowercase-kebab', () => {
    expect(STATIONS.map(stationSlug)).toEqual([
      'christopher-street',
      '9th-street',
      '14th-street',
      '23rd-street',
      '33rd-street',
      'wtc',
      'newark',
      'harrison',
      'journal-square',
      'grove-street',
      'exchange-place',
      'newport',
      'hoboken',
    ])
  })
})
