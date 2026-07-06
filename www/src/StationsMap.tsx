import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useQuery } from '@tanstack/react-query'
import { asyncBufferFromUrl, parquetRead } from 'hyparquet'
import { compressors } from './parquet-compressors'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Param, codeParam, useUrlState } from 'use-prms'
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { STATION_COORDS } from './stations-geo'
import { PIE_MAP_GIF_URL, PIE_MAP_MP4_URL } from './static-urls'
import { YmInput } from './YmInput'

const resolved = dvcResolve('hourly.pqt')
const hourlyUrl = resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved

type StationRow = {
  station: string
  ym: string
  hour: number
  entries: number
  exits: number
}
type RangeAvg = {
  station: string
  // Linearly interpolated between bracketing integer hours — drives pie size,
  // wedge angles, and bar heights so visuals stay smooth at sub-hour steps.
  entries: number
  exits: number
  // Snapped to the floor integer hour — drives text labels (pie numbers,
  // popup body, hour label) so the *numbers* the user reads only change on
  // hour ticks, matching the live animation semantics.
  bucketEntries: number
  bucketExits: number
}
type Shape = 'pie' | 'bars'
const shapeParam = codeParam<Shape>('pie', { pie: 'p', bars: 'b' })
const ALL_HOURS = -1
const hourParam: Param<number> = {
  encode(h) { return h === ALL_HOURS ? undefined : String(h) },
  // Accept `8` / `8.5` (decimal hours) or `8:30` (HH:MM). Range is [0, 24);
  // fractional values are valid (sub-hour scrubbing + recorder steps).
  decode(s) {
    if (s === undefined) return ALL_HOURS
    const colon = s.indexOf(':')
    const n = colon >= 0
      ? Number(s.slice(0, colon)) + Number(s.slice(colon + 1)) / 60
      : Number(s)
    return Number.isFinite(n) && n >= 0 && n < 24 ? n : ALL_HOURS
  },
}

const ENTRY_COLOR = '#22c55e'
const EXIT_COLOR = '#f97316'
const MAX_RADIUS = 80

// Geographic elide: NJ outer (Newark, Harrison) sit ~10km west of the Jersey
// City / NYC core, with no PATH stations between. Rendering both at one
// shared zoom either crams the core cluster (current state) or shrinks the NJ
// outer to invisible. Splitting into two side-by-side L.map panes with a
// `//` divider lets each cluster fitBounds on its own subset, with a thin
// visual break to signal the compressed distance.
const NJ_OUTER_STATIONS = new Set(['Newark', 'Harrison'])
const isCore = (station: string) => !NJ_OUTER_STATIONS.has(station)
// Each marker gets a fixed-size icon container; radius/shape variation lives
// inside via SVG + CSS scale, so Leaflet doesn't have to re-create markers
// every hour change (which would defeat any CSS transition).
const ICON_BOX = (MAX_RADIUS + 2) * 2

const HOUR_LABELS = [
  '12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
  '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p',
]

/** "9-10am", "11am-12pm", "12-1pm", "11pm-12am". For fractional inputs
 *  (sub-hour recorder steps) we floor — the label tracks the integer
 *  hour bucket, not the clock hand's exact position. */
function formatHourRange(h: number): string {
  const lo = Math.floor(h) % 24
  const hi = (lo + 1) % 24
  const fmt = (x: number) => x === 0 || x === 12 ? '12' : String(x % 12)
  const ap = (x: number) => x < 12 ? 'am' : 'pm'
  return ap(lo) === ap(hi) ? `${fmt(lo)}-${fmt(hi)}${ap(lo)}` : `${fmt(lo)}${ap(lo)}-${fmt(hi)}${ap(hi)}`
}

/** Compact integer formatter for in-marker labels: 0-999 raw, 1k-9.9k one
 *  decimal, 10k+ rounded. */
function formatCompactNum(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  return Math.round(n / 1000) + 'k'
}

export default function StationsMap({
  embedded = false,
  activeStations,
  dateRange,
  onDateRangeChange,
  onDataDefault,
}: {
  embedded?: boolean
  /** Page-level station filter (canonical names like "Christopher Street").
   *  When a strict subset, non-active markers fade + drop below active ones in
   *  z-order so the focused stations pop. */
  activeStations?: string[]
  /** Shared `(fromYm, toYm)` from parent (URL-backed). `null` = no user
   *  override, fall back to data-derived defaults via `onDataDefault`. */
  dateRange?: [string, string] | null
  /** Picker writes back to parent's URL state. */
  onDateRangeChange?: (r: [string, string] | null) => void
  /** Called once per session with the data-derived default range; parent
   *  ignores all but the first caller so plots don't fight over defaults. */
  onDataDefault?: (r: [string, string]) => void
} = {}) {
  // Active set in this file's name convention ("Christopher St.") — null means
  // "no filter, all stations full brightness".
  const activeSet = useMemo<Set<string> | null>(() => {
    if (!activeStations) return null
    // Canonical "Christopher Street" → "Christopher St." for matching.
    const mapped = activeStations.map(s => s === "Christopher Street" ? "Christopher St." : s)
    // Treat empty or full-set as "no filter".
    if (mapped.length === 0) return null
    if (mapped.length >= Object.keys(STATION_COORDS).length) return null
    return new Set(mapped)
  }, [activeStations])
  // Two L.map instances side by side (NJ outer + core cluster) with a `//`
  // divider in between. Each pane fits its own subset's bounds. All markers
  // share `markersRef` keyed by station name; the data update effect mutates
  // marker DOM uniformly regardless of which pane each marker lives on.
  const njContainerRef = useRef<HTMLDivElement>(null)
  const coreContainerRef = useRef<HTMLDivElement>(null)
  const njMapRef = useRef<L.Map | null>(null)
  const coreMapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())

  const { data: rows } = useQuery({
    queryKey: ['stations-hourly-rows', hourlyUrl],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async (): Promise<StationRow[]> => {
      const file = await asyncBufferFromUrl({ url: hourlyUrl })
      const raw: Record<string, unknown>[] = []
      await parquetRead({
        file,
        columns: ['Station', 'Year', 'Month', 'Hour',
                  'Avg Weekday Entry', 'Avg Saturday Entry', 'Avg Sunday Entry',
                  'Avg Weekday Exit', 'Avg Saturday Exit', 'Avg Sunday Exit'],
        rowFormat: 'object',
        compressors,
        onComplete: data => raw.push(...data),
      })
      const num = (v: unknown) => Number(v) || 0
      return raw.map(r => ({
        station: r['Station'] as string,
        ym: `${num(r['Year'])}-${String(num(r['Month'])).padStart(2, '0')}`,
        hour: num(r['Hour']),
        entries: (5 * num(r['Avg Weekday Entry'])
          + num(r['Avg Saturday Entry'])
          + num(r['Avg Sunday Entry'])) / 7,
        exits: (5 * num(r['Avg Weekday Exit'])
          + num(r['Avg Saturday Exit'])
          + num(r['Avg Sunday Exit'])) / 7,
      }))
    },
  })

  const allYms = useMemo(() => {
    if (!rows) return []
    return Array.from(new Set(rows.map(r => r.ym))).sort()
  }, [rows])

  // Date range comes from the parent (URL-backed shared state). Picker
  // changes go up via `onDateRangeChange`; on first data load we report
  // our bounds to `onDataDefault` (parent dedups so the first caller wins).
  const [fromYm, toYm] = dateRange ?? ['', '']
  const setFromYm = (v: string) => onDateRangeChange?.([v, toYm])
  const setToYm = (v: string) => onDateRangeChange?.([fromYm, v])
  // `mh` URL param holds the paused hour for shareable URLs. While the clock
  // is animating we drive `liveHour` internally (no URL writes) so the param
  // doesn't churn on every tick; pausing commits `liveHour` to the URL, and
  // resuming play clears it. If a fresh load has `?mh=`, we start paused on
  // that hour.
  const [urlHour, setUrlHour] = useUrlState<number>('mh', hourParam)
  const [liveHour, setLiveHour] = useState<number>(urlHour)
  const hour = liveHour
  const setHour = setLiveHour
  const [hoveredHour, setHoveredHour] = useState<number | null>(null)
  const effectiveHour = hoveredHour ?? hour
  const [shape, setShape] = useUrlState<Shape>('ms', shapeParam)
  // 300ms gives a nice "daily heartbeat" cadence when playing through 24 hours.
  const [animMs, setAnimMs] = useState<number>(300)
  const [playing, setPlaying] = useState<boolean>(urlHour === ALL_HOURS)
  // Mirror external URL edits → liveHour while paused. (Ignored during play
  // so animation isn't disrupted by our own `setUrlHour(ALL_HOURS)` clear.)
  useEffect(() => {
    if (!playing) setLiveHour(urlHour)
  }, [urlHour, playing])
  // Play/pause transitions: clear `mh` on play, commit `liveHour` on pause.
  useEffect(() => {
    if (playing) setUrlHour(ALL_HOURS)
    else setUrlHour(liveHour)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])
  // Spacebar toggles play/pause when the map is on screen. Gated on
  // viewport visibility so it doesn't break page-scroll on the rest of
  // the page (the homepage has multiple plots above this one).
  const [mapVisible, setMapVisible] = useState(false)
  useEffect(() => {
    const el = coreContainerRef.current ?? njContainerRef.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => setMapVisible(entry.isIntersecting), { threshold: 0.3 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  useEffect(() => {
    if (!mapVisible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as Element | null
      if (t?.matches?.('input, textarea, select, [contenteditable="true"]')) return
      e.preventDefault()
      setPlaying(p => !p)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mapVisible])
  const hourRef = useRef(hour)
  hourRef.current = hour
  // While playing, advance the hour every animMs (clamped) so the wedges/bars
  // tween straight into the next state. Wraps 11p → 12a; entering play from
  // "All hours" jumps to 12a so the first frame has a real hour.
  //
  // Background-tab handling: browsers throttle setInterval to ~1Hz on hidden
  // tabs, and may fire several deferred callbacks in rapid succession when
  // the tab regains focus (visible "catch-up spin"). Skip the tick when
  // `document.hidden` and resume cleanly via the `visibilitychange` event,
  // so there's no replay of background time.
  useEffect(() => {
    if (!playing) return
    if (hourRef.current === ALL_HOURS) setHour(0)
    const period = Math.max(animMs, 120)
    let id: number | undefined
    const start = () => {
      if (id !== undefined) return
      id = window.setInterval(() => {
        if (document.hidden) return
        const cur = hourRef.current
        setHour(cur === ALL_HOURS ? 0 : (cur + 1) % 24)
      }, period)
    }
    const stop = () => {
      if (id !== undefined) { clearInterval(id); id = undefined }
    }
    const onVis = () => { if (document.hidden) stop(); else start() }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [playing, animMs, setHour])

  useEffect(() => {
    if (allYms.length) onDataDefault?.([allYms[0], allYms[allYms.length - 1]])
  }, [allYms, onDataDefault])

  // Record-mode hook: external scripts (scripts/record-map.mjs) drive the
  // hour deterministically rather than recording live playback.
  const recordMode = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('record')
  // `?desc[=...]` adds a title overlay on the map for shareable
  // captures. Bare `?desc` uses the defaults below; `?desc=My+title`
  // overrides the title; `?desc=Title|Subtitle` overrides both lines.
  const descParam = typeof window === 'undefined' ? null
    : new URLSearchParams(window.location.search).get('desc')
  const showDesc = descParam !== null
  const [descTitle, descSubtitle]: [string, React.ReactNode] = (() => {
    // Compact range label: "Jan 2025 – Dec 2025"; or "Mar 2025" for single month.
    const rangeLabel = (() => {
      if (!fromYm || !toYm) return ''
      const fmt = (ym: string) => {
        const [y, m] = ym.split('-')
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]
        return `${month} ${y}`
      }
      return fromYm === toYm ? fmt(fromYm) : `${fmt(fromYm)} – ${fmt(toYm)}`
    })()
    const defaultTitle = 'PATH faregate ridership, by hour'
    // Colored word tokens (`green`/`orange`) so the legend palette is
    // self-documenting in the recorded GIF — the words match the wedge colors.
    const defaultSubtitle: React.ReactNode = (
      <>
        <span style={{ color: ENTRY_COLOR }}>green</span>
        {' = entries · '}
        <span style={{ color: EXIT_COLOR }}>orange</span>
        {' = exits'}
        {rangeLabel && ` · ${rangeLabel} avg`}
      </>
    )
    if (!descParam) return [defaultTitle, defaultSubtitle]
    const [t, s] = descParam.split('|')
    return [t || defaultTitle, s ?? defaultSubtitle]
  })()
  useEffect(() => {
    if (!recordMode) return
    ;(window as { __pathMap?: unknown }).__pathMap = {
      setHour: (h: number) => { setPlaying(false); setHour(h) },
      setAnimMs: (ms: number) => setAnimMs(ms),
      setShape: (s: Shape) => setShape(s),
      setRange: (from: string, to: string) => { setFromYm(from); setToYm(to) },
    }
  }, [recordMode, setHour, setShape])

  // Per-(station, hour) entries/exits averaged across months in the date
  // range. Computed once and reused for both `rangeAvg` and `maxTotal` so
  // pie sizes stay absolute across hour scrubbing.
  const perStationHour = useMemo(() => {
    const result = new Map<string, Map<number, { e: number, x: number }>>()
    if (!rows) return result
    // Standalone `/map` renders `<StationsMap />` with no `dateRange` prop, so
    // `fromYm`/`toYm` stay empty. In that uncontrolled case use all rows so
    // pies render out of the box; explicit ranges still filter as usual.
    const inRange = (fromYm && toYm)
      ? rows.filter(r => r.ym >= fromYm && r.ym <= toYm)
      : rows
    // Bucket by (station, hour, ym) summing rows, then average across yms.
    const accum = new Map<string, Map<number, Map<string, { e: number, x: number }>>>()
    for (const r of inRange) {
      let byHr = accum.get(r.station)
      if (!byHr) { byHr = new Map(); accum.set(r.station, byHr) }
      let byYm = byHr.get(r.hour)
      if (!byYm) { byYm = new Map(); byHr.set(r.hour, byYm) }
      const cur = byYm.get(r.ym) ?? { e: 0, x: 0 }
      cur.e += r.entries; cur.x += r.exits
      byYm.set(r.ym, cur)
    }
    for (const [station, byHr] of accum) {
      const stn = new Map<number, { e: number, x: number }>()
      for (const [hour, byYm] of byHr) {
        const vals = Array.from(byYm.values())
        const n = Math.max(1, vals.length)
        stn.set(hour, {
          e: vals.reduce((s, v) => s + v.e, 0) / n,
          x: vals.reduce((s, v) => s + v.x, 0) / n,
        })
      }
      result.set(station, stn)
    }
    return result
  }, [rows, fromYm, toYm])

  const rangeAvg = useMemo<RangeAvg[]>(() => {
    return Array.from(perStationHour.entries()).map(([station, byHr]) => {
      if (effectiveHour === ALL_HOURS) {
        let e = 0, x = 0
        for (const v of byHr.values()) { e += v.e; x += v.x }
        return { station, entries: e, exits: x, bucketEntries: e, bucketExits: x }
      }
      // Visuals (size/wedge angles) interpolate between the bracketing integer
      // hours so sub-hour recorder steps tween smoothly. The `bucket*` fields
      // snap to the floor hour and drive text labels (pie numbers + popup) so
      // numeric readouts only change on hour ticks. For integer `effectiveHour`
      // both pairs collapse to the same value (t=0).
      const lo = Math.floor(effectiveHour) % 24
      const hi = (lo + 1) % 24
      const t = effectiveHour - Math.floor(effectiveHour)
      const v0 = byHr.get(lo) ?? { e: 0, x: 0 }
      const v1 = byHr.get(hi) ?? { e: 0, x: 0 }
      return {
        station,
        entries: v0.e * (1 - t) + v1.e * t,
        exits: v0.x * (1 - t) + v1.x * t,
        bucketEntries: v0.e,
        bucketExits: v0.x,
      }
    })
  }, [perStationHour, effectiveHour])

  // Absolute pie scale: in hour-scrubbing mode, peg `maxTotal` to the largest
  // (station, hour) pair across ALL hours in the date range — so a station's
  // pie size stays consistent as the user scrubs through hours (smaller pies
  // at off-peak vs larger at rush, instead of every hour's max filling
  // MAX_RADIUS). In All-hours mode, use the all-day sum max.
  const maxTotal = useMemo(() => {
    let hourlyMax = 1, dailyMax = 1
    for (const byHr of perStationHour.values()) {
      let stnDaily = 0
      for (const v of byHr.values()) {
        const h = v.e + v.x
        if (h > hourlyMax) hourlyMax = h
        stnDaily += h
      }
      if (stnDaily > dailyMax) dailyMax = stnDaily
    }
    return effectiveHour === ALL_HOURS ? dailyMax : hourlyMax
  }, [perStationHour, effectiveHour])

  // System-wide totals across the visible station filter at the current hour
  // (or across all hours in the "All" state). Uses the bucket (integer-hour
  // floor) values so the readout snaps on hour ticks — matches on-pie labels
  // rather than drifting with sub-hour interpolation.
  const systemTotals = useMemo(() => {
    let e = 0, x = 0
    for (const r of rangeAvg) {
      if (activeSet !== null && !activeSet.has(r.station)) continue
      e += r.bucketEntries
      x += r.bucketExits
    }
    return { entries: e, exits: x }
  }, [rangeAvg, activeSet])

  // Container for the clock control rendered into the map's top-right corner
  // via React portal. Set once Leaflet's L.control creates its DOM.
  const [clockHost, setClockHost] = useState<HTMLDivElement | null>(null)

  // Init both panes' maps + markers ONCE. Marker DOM stays put across hour
  // changes; the data update effect mutates inner SVG / transforms uniformly
  // regardless of which pane the marker belongs to.
  useEffect(() => {
    if (!njContainerRef.current || !coreContainerRef.current) return
    if (njMapRef.current || coreMapRef.current) return

    const baseMapOpts = {
      zoomSnap: 0.5 as number,
      zoomControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    }
    const tileOpts = { attribution: '', subdomains: 'abcd', maxZoom: 19 }
    const tileUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'

    const njMap = L.map(njContainerRef.current, { ...baseMapOpts, center: [40.736, -74.16], zoom: 14 })
    L.tileLayer(tileUrl, tileOpts).addTo(njMap)
    njMap.attributionControl.remove()
    njMapRef.current = njMap

    const coreMap = L.map(coreContainerRef.current, { ...baseMapOpts, center: [40.73, -74.02], zoom: 13 })
    L.tileLayer(tileUrl, tileOpts).addTo(coreMap)
    coreMap.attributionControl.remove()
    coreMapRef.current = coreMap

    // Attribution on the right (core) pane's lower-left.
    const InfoControl = L.Control.extend({
      onAdd() {
        const c = L.DomUtil.create('div', 'leaflet-control map-attr-info')
        c.innerHTML = '<span class="info-icon" aria-label="Map attribution">ⓘ</span>'
          + '<span class="info-text">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a></span>'
        L.DomEvent.disableClickPropagation(c)
        return c
      },
    })
    new InfoControl({ position: 'bottomleft' }).addTo(coreMap)

    // Clock control on the LEFT (NJ) pane — the NJ outer cluster only has
    // 2 stations, leaving plenty of empty pane area for the dial. Frees up
    // top-left of the core pane for tighter station fit.
    const ClockControl = L.Control.extend({
      onAdd() {
        const c = L.DomUtil.create('div', 'leaflet-control map-clock-control')
        L.DomEvent.disableClickPropagation(c)
        L.DomEvent.disableScrollPropagation(c)
        setClockHost(c)
        return c
      },
    })
    new ClockControl({ position: 'topleft' }).addTo(njMap)

    // Per-pane bounds (using just that pane's stations).
    const njBounds = L.latLngBounds(
      Object.entries(STATION_COORDS)
        .filter(([s]) => NJ_OUTER_STATIONS.has(s))
        .map(([_, [lng, lat]]) => [lat, lng] as [number, number]),
    )
    const coreBounds = L.latLngBounds(
      Object.entries(STATION_COORDS)
        .filter(([s]) => isCore(s))
        .map(([_, [lng, lat]]) => [lat, lng] as [number, number]),
    )

    /** Highest snap-aligned zoom at which `bounds` fits inside the available
     *  rectangle (pane size minus paddings). */
    const computeZoom = (
      map: L.Map,
      bounds: L.LatLngBounds,
      pad: { left: number, top: number, right: number, bottom: number },
    ): number => {
      const size = map.getSize()
      const availW = size.x - pad.left - pad.right
      const availH = size.y - pad.top - pad.bottom
      if (availW <= 0 || availH <= 0) return map.getZoom()
      const snap = (map.options.zoomSnap as number) || 1
      let zoom = map.getMaxZoom() ?? 19
      const sw = bounds.getSouthWest(), ne = bounds.getNorthEast()
      while (zoom > 0) {
        const swPx = map.project(sw, zoom)
        const nePx = map.project(ne, zoom)
        if (Math.abs(nePx.x - swPx.x) <= availW && Math.abs(nePx.y - swPx.y) <= availH) break
        zoom -= snap
      }
      return zoom
    }
    /** Center `map` on `bounds` at a given `zoom`, so the bbox center lands
     *  in the middle of the available rectangle (after applying paddings). */
    const placePaneAtZoom = (
      map: L.Map,
      bounds: L.LatLngBounds,
      zoom: number,
      pad: { left: number, top: number, right: number, bottom: number },
    ) => {
      const size = map.getSize()
      const availW = size.x - pad.left - pad.right
      const availH = size.y - pad.top - pad.bottom
      const centerPx = map.project(bounds.getCenter(), zoom)
      const target = L.point(pad.left + availW / 2, pad.top + availH / 2)
      const shift = L.point(size.x / 2, size.y / 2).subtract(target)
      map.setView(map.unproject(centerPx.add(shift), zoom), zoom, { animate: false })
    }
    // Base paddings — clock floats top-left of NJ (reserved via `top`).
    // Inside-edge pads are computed dynamically below to achieve a
    // 3-equal-pad layout (left-outer == middle == right-outer).
    const njPadBase = { top: 130, bottom: 60 }
    const corePadBase = { top: 30, bottom: 60 }
    const MIN_PAD = 30  // breathing room at the closest edge

    const fitAll = () => {
      // First pass: compute shared zoom from a generous-pad estimate so the
      // zoom isn't biased by whatever pane widths the DOM currently has.
      const njPadInit = { ...njPadBase, left: MIN_PAD, right: MIN_PAD }
      const corePadInit = { ...corePadBase, left: MIN_PAD, right: MIN_PAD }
      const zoom = Math.min(
        computeZoom(njMap, njBounds, njPadInit),
        computeZoom(coreMap, coreBounds, corePadInit),
      )

      // Compute bbox pixel widths at this zoom.
      const bboxPxWidth = (b: L.LatLngBounds) =>
        Math.abs(coreMap.project(b.getNorthEast(), zoom).x - coreMap.project(b.getSouthWest(), zoom).x)
      const njBboxPx = bboxPxWidth(njBounds)
      const coreBboxPx = bboxPxWidth(coreBounds)

      // Responsive 3-equal-pad: container = 3X + njBbox + coreBbox.
      // Middle pad X includes the 28px divider; each middle-half = (X-28)/2.
      const container = njContainerRef.current!.parentElement!.getBoundingClientRect().width
      const X = (container - njBboxPx - coreBboxPx) / 3
      const DIVIDER = 28

      if (X >= 2 * MIN_PAD + DIVIDER) {
        // Wide enough for 3-equal-pad. Compute target pane widths.
        const middleHalf = (X - DIVIDER) / 2
        const njPaneWidth = X + njBboxPx + middleHalf
        // Set NJ pane width via inline style; Core flex-fills the rest.
        njContainerRef.current!.style.flexBasis = `${njPaneWidth}px`
        coreContainerRef.current!.style.flexBasis = `${container - njPaneWidth - DIVIDER}px`
        njMap.invalidateSize()
        coreMap.invalidateSize()
        // Shift bbox within each pane via asymmetric left/right pad so the
        // bbox center lands at the target position derived from X.
        // pad.left − pad.right = 2*desired_center_in_pane − pane_width
        // NJ desired_center = X + njBboxPx/2  →  diff = 0.5X + 14
        // Core desired_center = (X-28)/2 + coreBboxPx/2  →  diff = -(0.5X + 14)
        const shift = 0.5 * X + 14
        placePaneAtZoom(njMap, njBounds, zoom, { ...njPadBase, left: MIN_PAD + shift, right: MIN_PAD })
        placePaneAtZoom(coreMap, coreBounds, zoom, { ...corePadBase, left: MIN_PAD, right: MIN_PAD + shift })
      } else {
        // Narrow viewport: fall back to baseline 27/73 split with simple pads.
        placePaneAtZoom(njMap, njBounds, zoom, { ...njPadBase, left: MIN_PAD, right: MIN_PAD })
        placePaneAtZoom(coreMap, coreBounds, zoom, { ...corePadBase, left: MIN_PAD, right: MIN_PAD })
      }
    }
    fitAll()

    // Re-fit when either pane resizes.
    const ro = new ResizeObserver(() => {
      njMap.invalidateSize()
      coreMap.invalidateSize()
      fitAll()
    })
    ro.observe(njContainerRef.current!)
    ro.observe(coreContainerRef.current!)

    // Add markers to the appropriate pane based on station partitioning.
    // Per-slice/bar value labels live OUTSIDE `.station-glyph` so they don't
    // scale with the glyph; the data-update effect positions them via
    // `--lx`/`--ly` CSS variables based on the current scaled wedge/bar
    // geometry.
    for (const [station, [lng, lat]] of Object.entries(STATION_COORDS)) {
      const icon = L.divIcon({
        html: `<div class="station-glyph" style="width:${ICON_BOX}px;height:${ICON_BOX}px"></div>`
          + `<span class="value-label value-label-entry"></span>`
          + `<span class="value-label value-label-exit"></span>`
          + `<span class="station-name">${station}</span>`,
        className: 'station-pie',
        iconSize: [ICON_BOX, ICON_BOX],
        iconAnchor: [ICON_BOX / 2, ICON_BOX / 2],
      })
      const targetMap = NJ_OUTER_STATIONS.has(station) ? njMap : coreMap
      const marker = L.marker([lat, lng], { icon }).addTo(targetMap)
      markersRef.current.set(station, marker)
    }
    return () => {
      ro.disconnect()
      njMap.remove()
      coreMap.remove()
      njMapRef.current = null
      coreMapRef.current = null
      markersRef.current.clear()
    }
  }, [])

  // Update markers on aggregate / shape / animation changes. The DOM for each
  // shape is built once (via `setupShape`) and then only style props mutate so
  // CSS transitions tween wedge angles, bar heights, and outer scale.
  useEffect(() => {
    if (!rangeAvg.length) return
    const byStation = new Map(rangeAvg.map(r => [r.station, r]))
    for (const [station, marker] of markersRef.current) {
      const t = byStation.get(station)
      const markerEl = marker.getElement()
      const el = markerEl?.querySelector<HTMLElement>('.station-glyph')
      if (!el || !markerEl) continue
      // Page-level station filter: fade non-active markers and drop them
      // below active ones in z-order.
      const isFaded = activeSet !== null && !activeSet.has(station)
      markerEl.style.opacity = isFaded ? '0.28' : '1'
      marker.setZIndexOffset(isFaded ? -500 : 500)
      // Set `--anim-ms` on the marker root so both `.station-glyph` (transform,
      // bar heights, etc.) and `.station-name` (top position) inherit it.
      // Use `linear` easing during play so consecutive hour steps blend into
      // continuous motion (matches the clock arrow); `ease` otherwise feels
      // nicer for one-off scrubs.
      markerEl.style.setProperty('--anim-ms', `${animMs}ms`)
      markerEl.style.setProperty('--anim-easing', playing ? 'linear' : 'ease')
      setupShape(el, shape)
      if (!t) {
        el.style.transform = 'scale(0)'
        continue
      }
      const total = t.entries + t.exits
      const frac = total / maxTotal
      const scale = Math.max(0.05, Math.sqrt(Math.max(0, frac)))
      el.style.transform = `scale(${scale})`
      if (shape === 'pie') applyPieData(el, t.entries, t.exits, animMs, playing)
      else applyBarsData(el, t.entries, t.exits)
      // Position the station-name label just below the visible glyph extent.
      const exitFrac = total > 0 ? t.exits / total : 0
      const bottomExtent = (shape === 'pie' ? MAX_RADIUS : exitFrac * MAX_RADIUS) * scale
      markerEl.style.setProperty('--marker-extent', `${bottomExtent}px`)
      // Per-slice/bar value labels: snap to the new hour's geometry (no
      // transition) while the wedge angles / bar heights still tween.
      const labelE = markerEl.querySelector<HTMLElement>('.value-label-entry')
      const labelX = markerEl.querySelector<HTMLElement>('.value-label-exit')
      if (labelE && labelX) {
        // Text content tracks the integer-hour bucket so on-pie numbers don't
        // wobble across sub-hour recorder steps. Position (`--lx`/`--ly`)
        // below follows the interpolated wedge angles so labels stay aligned
        // with the tweening fill — content snaps, anchor slides.
        labelE.textContent = formatCompactNum(t.bucketEntries)
        labelX.textContent = formatCompactNum(t.bucketExits)
        if (shape === 'pie') {
          const entryFrac = total > 0 ? t.entries / total : 0.5
          const angE = -Math.PI / 2 + entryFrac * Math.PI
          const angX = Math.PI / 2 + entryFrac * Math.PI
          const r = MAX_RADIUS * 0.62 * scale
          labelE.style.setProperty('--lx', `${r * Math.cos(angE)}px`)
          labelE.style.setProperty('--ly', `${r * Math.sin(angE)}px`)
          labelX.style.setProperty('--lx', `${r * Math.cos(angX)}px`)
          labelX.style.setProperty('--ly', `${r * Math.sin(angX)}px`)
        } else {
          // Bars: entry above center, exit below center; labels just past each
          // bar's outer edge so they don't overlap the bar fill.
          const entryFrac = total > 0 ? t.entries / total : 0
          labelE.style.setProperty('--lx', '0px')
          labelE.style.setProperty('--ly', `${-(entryFrac * MAX_RADIUS * scale + 9)}px`)
          labelX.style.setProperty('--lx', '0px')
          labelX.style.setProperty('--ly', `${exitFrac * MAX_RADIUS * scale + 9}px`)
        }
      }
      const popupHourLabel = effectiveHour === ALL_HOURS ? 'All hours' : formatHourRange(effectiveHour)
      marker.bindPopup(
        `<strong>${station}</strong>`
        + `<br/><span style="opacity:0.7">${popupHourLabel}</span>`
        + `<br/>Avg entries: ${Math.round(t.bucketEntries).toLocaleString()}`
        + `<br/>Avg exits: ${Math.round(t.bucketExits).toLocaleString()}`
      )
    }
  }, [rangeAvg, maxTotal, shape, animMs, playing, activeSet, effectiveHour])


  const hourLabel = effectiveHour === ALL_HOURS ? 'All hours' : formatHourRange(effectiveHour)

  const outerStyle: React.CSSProperties = embedded
    ? { width: '100%', display: 'flex', flexDirection: 'column', margin: '1em 0' }
    : { display: 'flex', flexDirection: 'column', height: '100vh' }
  const mapRowStyle: React.CSSProperties = embedded
    ? { height: 460, minHeight: 280, resize: 'vertical', overflow: 'hidden', display: 'flex', alignItems: 'stretch' }
    : { flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }
  const paneStyle: React.CSSProperties = { height: '100%' }

  return (
    <div style={outerStyle}>
      {!embedded && (
        <div style={{ padding: '0.75rem 1rem 0.4rem' }}>
          <h1 style={{ margin: 0, fontSize: '1.25rem' }}>PATH stations — avg daily entries & exits</h1>
        </div>
      )}
      <div style={{ ...mapRowStyle, position: 'relative' }}>
        <div ref={njContainerRef} className="map-pane-nj" style={{ ...paneStyle, flex: '0 0 27%' }} />
        <div className="map-elide-divider" aria-hidden style={{ ...paneStyle, flex: '0 0 28px' }} />
        <div ref={coreContainerRef} className="map-pane-core" style={{ ...paneStyle, flex: '1 1 auto' }} />
        {showDesc && (
          // pointer-events: none so the overlay never blocks map interaction.
          // z-index above Leaflet's default panes (~400) but below the clock
          // control (which uses Leaflet's own control z-index ~800).
          <div style={{
            position: 'absolute', top: 10, left: 0, right: 0,
            textAlign: 'center', pointerEvents: 'none', zIndex: 500,
            color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.85)',
          }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 600, lineHeight: 1.15 }}>{descTitle}</div>
            {descSubtitle && (
              <div style={{ fontSize: '0.95rem', opacity: 0.92, marginTop: 4 }}>{descSubtitle}</div>
            )}
          </div>
        )}
      </div>
      {clockHost && createPortal(
        <div className={`map-clock-panel${recordMode ? ' map-clock-panel--record' : ''}`}>
          {!recordMode && (
            <button type="button"
              className="map-clock-play"
              onClick={() => setPlaying(p => !p)}
              title={playing ? 'Pause hour cycle' : 'Cycle through hours'}>
              {playing ? '⏸' : '▶'}
            </button>
          )}
          <div className="map-clock-row">
            <HourClock
              hour={hour}
              onChange={h => { setHour(h); setPlaying(false) }}
              onHoverChange={setHoveredHour}
              // Record mode bypasses the 120ms floor so each `setHour` is
              // captured at its settled state — otherwise the recorder
              // screenshots the arrow mid-tween (non-monotonic frames).
              animMs={recordMode ? 0 : Math.max(animMs, 120)}
              playing={playing}
            />
          </div>
          <div className="map-clock-big-label">{hourLabel}</div>
          {(systemTotals.entries > 0 || systemTotals.exits > 0) && (
            <div className="map-clock-totals">
              <span style={{ color: ENTRY_COLOR }}>{formatCompactNum(systemTotals.entries)}</span>
              <span className="map-clock-totals-sep">·</span>
              <span style={{ color: EXIT_COLOR }}>{formatCompactNum(systemTotals.exits)}</span>
            </div>
          )}
        </div>,
        clockHost,
      )}
      {!recordMode && <div style={{
        padding: '0.4rem 0',
        fontSize: '0.85rem',
        color: '#888',
        display: 'flex',
        gap: '1.2em',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <span><span style={{ color: ENTRY_COLOR }}>green</span>/<span style={{ color: EXIT_COLOR }}>orange</span> = entries/exits</span>
        {/* When embedded on the homepage, `EntriesVsExitsBars` renders its
            own YM picker on the shared `?ym=` URL state — skip ours to avoid
            two identical pickers stacked on top of each other. */}
        {!embedded && fromYm && toYm && (
          <span>
            <YmInput value={fromYm} onChange={setFromYm} allYms={allYms} />
            {' – '}
            <YmInput value={toYm} onChange={setToYm} allYms={allYms} />
          </span>
        )}
        <span>
          Shape:{' '}
          <select value={shape} onChange={e => setShape(e.target.value as Shape)} style={selectStyle}>
            <option value="pie">Pie</option>
            <option value="bars">Bars</option>
          </select>
        </span>
        <span>
          Anim: <strong style={{ minWidth: '3em', display: 'inline-block' }}>{animMs}ms</strong>{' '}
          <input type="range" min={0} max={1500} step={50} value={animMs}
            onChange={e => setAnimMs(parseInt(e.target.value))}
            style={{ verticalAlign: 'middle', width: '10em' }} />
        </span>
        <span>
          24h loop:{' '}
          <a href={PIE_MAP_GIF_URL} target="_blank" rel="noopener">.gif</a>
          {' · '}
          <a href={PIE_MAP_MP4_URL} target="_blank" rel="noopener">.mp4</a>
        </span>
        {!embedded && <a href="/">← PATH ridership</a>}
      </div>}
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  background: '#222',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '0.15em 0.4em',
  fontSize: '0.85rem',
}

// 24-hour clock-face control. 12a at top, going clockwise. Click or drag the
// rim to pin an hour; hovering the rim brushes the parent (preview-only,
// reverts on mouseout); click the center to switch to "All hours".
function HourClock({ hour, onChange, onHoverChange, animMs = 400, playing = false, size = 88 }: {
  hour: number
  onChange: (h: number) => void
  onHoverChange?: (h: number | null) => void
  /** Transition duration for the hand rotation, ms. Use the same value as
   *  the play cycle period so consecutive ticks blend into smooth rotation. */
  animMs?: number
  /** When true, hand rotation prefers clockwise direction even when the
   *  shortest path would wrap backward (e.g. 11p → 12a). */
  playing?: boolean
  size?: number
}) {
  const cx = size / 2, cy = size / 2
  const rOuter = size / 2 - 1
  const rTickOut = rOuter - 2
  const rTickIn = rTickOut - 5
  const rLabel = rTickIn - 7
  const rHand = rTickIn - 2
  // Smaller center → wider drag annulus (~28px wide) for easier circular drag.
  const rCenter = size * 0.18
  const svgRef = useRef<SVGSVGElement>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const isAll = hour === ALL_HOURS
  const displayHour = hovered ?? hour
  const isHover = hovered !== null
  // Keep parent's hover state in sync.
  useEffect(() => { onHoverChange?.(hovered) }, [hovered, onHoverChange])
  // Clear hover when the SVG unmounts so parent doesn't get stuck previewing.
  useEffect(() => () => onHoverChange?.(null), [onHoverChange])

  const pointerToHour = (clientX: number, clientY: number): number | null => {
    const rect = svgRef.current!.getBoundingClientRect()
    const x = clientX - rect.left - cx
    const y = clientY - rect.top - cy
    const dist = Math.hypot(x, y)
    if (dist < rCenter) return null
    let a = Math.atan2(y, x) + Math.PI / 2
    if (a < 0) a += 2 * Math.PI
    return Math.round(a / (2 * Math.PI / 24)) % 24
  }
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-clock-center]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const h = pointerToHour(e.clientX, e.clientY)
    if (h !== null) { onChange(h); setHovered(null) }
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const h = pointerToHour(e.clientX, e.clientY)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      // Active drag → commit each hour as we go.
      if (h !== null) onChange(h)
    } else {
      // Plain hover → preview only.
      setHovered(h)
    }
  }
  const onPointerLeave = () => setHovered(null)

  const hourAngle = (h: number) => h / 24 * 2 * Math.PI - Math.PI / 2
  const handVisible = displayHour !== ALL_HOURS

  // Cumulative degrees rotation. We track the absolute rotation across hour
  // changes so CSS `transition: transform` tweens between steps. When playing,
  // always advance forward (clockwise) so a 11p → 12a wrap rotates +15°
  // instead of taking the shortest path backward (-345°).
  const cumulativeAngleRef = useRef(0)
  // Sentinel value (-2) so the first render with a real hour takes the
  // "snap to absolute angle" branch even when displayHour is 0 (which would
  // collide with ALL_HOURS = -1).
  const prevDisplayHourRef = useRef<number>(-2)
  if (displayHour !== ALL_HOURS) {
    const prev = prevDisplayHourRef.current
    const targetMod = (displayHour / 24) * 360
    if (prev === -2 || prev === ALL_HOURS) {
      cumulativeAngleRef.current = targetMod
    } else if (prev !== displayHour) {
      const prevMod = ((cumulativeAngleRef.current % 360) + 360) % 360
      let diff = ((targetMod - prevMod) % 360 + 360) % 360  // forward-only [0, 360)
      if (!playing && diff > 180) diff -= 360                // shortest path when scrubbing
      cumulativeAngleRef.current += diff
    }
  }
  prevDisplayHourRef.current = displayHour
  const handAngleDeg = cumulativeAngleRef.current
  const ticks = []
  for (let h = 0; h < 24; h++) {
    const a = hourAngle(h)
    const major = h % 6 === 0
    const r1 = major ? rTickIn - 2 : rTickIn + 1
    const isSel = h === displayHour
    ticks.push(
      <line key={h}
        x1={cx + r1 * Math.cos(a)} y1={cy + r1 * Math.sin(a)}
        x2={cx + rTickOut * Math.cos(a)} y2={cy + rTickOut * Math.sin(a)}
        stroke={isSel ? '#fff' : (major ? '#aaa' : '#666')}
        strokeWidth={major ? 1.4 : 1}
        strokeLinecap="round"
      />
    )
  }
  const labelPositions: { h: number, label: string, dx: number, dy: number, baseline: string }[] = [
    { h: 0,  label: '12a', dx: 0,             dy: -rLabel + 4,  baseline: 'hanging' },
    { h: 6,  label: '6a',  dx: rLabel - 4,    dy: 0,            baseline: 'central' },
    { h: 12, label: '12p', dx: 0,             dy: rLabel - 4,   baseline: 'auto' },
    { h: 18, label: '6p',  dx: -(rLabel - 4), dy: 0,            baseline: 'central' },
  ]

  return (
    <svg ref={svgRef} width={size} height={size}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      style={{
        touchAction: 'none',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        outline: 'none',
        flexShrink: 0,
      }}
      role="slider"
      aria-label="Hour of day"
      aria-valuemin={-1}
      aria-valuemax={23}
      aria-valuenow={hour}
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') { onChange(hour <= 0 ? 23 : hour - 1); e.preventDefault() }
        else if (e.key === 'ArrowRight') { onChange(hour === ALL_HOURS ? 0 : (hour + 1) % 24); e.preventDefault() }
        else if (e.key === 'Escape') onChange(ALL_HOURS)
      }}
    >
      <circle cx={cx} cy={cy} r={rOuter} fill="rgba(255,255,255,0.04)" stroke="#444" />
      {ticks}
      {labelPositions.map(l => (
        <text key={l.label} x={cx + l.dx} y={cy + l.dy}
          textAnchor="middle" dominantBaseline={l.baseline}
          fill="#888" fontSize="9" pointerEvents="none">
          {l.label}
        </text>
      ))}
      {handVisible && (
        <g
          style={{
            transform: `rotate(${handAngleDeg}deg)`,
            transformOrigin: `${cx}px ${cy}px`,
            // Snappy on hover (preview should track the cursor), smooth on
            // play (consecutive ticks blend into continuous rotation).
            transition: isHover ? 'transform 100ms ease-out' : `transform ${animMs}ms linear`,
          }}
          pointerEvents="none"
        >
          {/* Drawn pointing UP at 12 o'clock; the parent <g> rotates it. */}
          <line x1={cx} y1={cy} x2={cx} y2={cy - rHand}
            stroke={isHover ? 'rgba(255,255,255,0.55)' : '#fff'}
            strokeWidth={1.5} strokeLinecap="round" />
          <circle cx={cx} cy={cy - rHand} r={3.5}
            fill={isHover ? 'rgba(255,255,255,0.55)' : '#fff'} />
        </g>
      )}
      <g data-clock-center
        style={{ cursor: 'pointer' }}
        onClick={() => onChange(isAll ? 0 : ALL_HOURS)}
      >
        <circle cx={cx} cy={cy} r={rCenter}
          fill={isAll ? '#3a3a5a' : '#222'}
          stroke={isAll ? '#9a9af0' : '#555'}
        />
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
          fill={isAll ? '#fff' : '#bbb'} fontSize="10" fontWeight={isAll ? 600 : 400}
          pointerEvents="none">
          All
        </text>
      </g>
    </svg>
  )
}

// Pie / bar dimensions used at render time; outer CSS `transform: scale(...)`
// shrinks each glyph to its station's relative volume.
const PIE_DIAM = MAX_RADIUS * 2
const BAR_W = MAX_RADIUS * 2
const BAR_H = MAX_RADIUS * 2

// Per-element animation state. Pie wedge angles are interpolated by JS rAF
// because CSS-transitioned @property values don't progress reliably inside
// Leaflet's transformed marker pane (animation registers but stays at t=0).
type GlyphState = { entryFrac: number, animId: number }
const glyphState = new WeakMap<HTMLElement, GlyphState>()

/** Idempotent per-shape DOM setup. Runs once per shape change; data updates
 *  then mutate inline styles / SVG paths only, so transitions can tween. */
function setupShape(el: HTMLElement, shape: Shape) {
  if (el.dataset.shape === shape) return
  el.dataset.shape = shape
  el.style.background = ''
  el.style.borderRadius = ''
  el.style.boxShadow = ''
  if (shape === 'pie') {
    el.style.width = `${PIE_DIAM}px`
    el.style.height = `${PIE_DIAM}px`
    el.innerHTML = `<svg viewBox="-${MAX_RADIUS} -${MAX_RADIUS} ${PIE_DIAM} ${PIE_DIAM}" width="${PIE_DIAM}" height="${PIE_DIAM}" style="display:block">
      <path class="pie-entry" fill="${ENTRY_COLOR}" opacity="0.9"></path>
      <path class="pie-exit" fill="${EXIT_COLOR}" opacity="0.9"></path>
      <circle r="${MAX_RADIUS}" fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="1"/>
    </svg>`
  } else {
    el.style.width = `${BAR_W}px`
    el.style.height = `${BAR_H}px`
    el.innerHTML = `
      <div class="bars-row">
        <div class="bar bar-entry"></div>
        <div class="bar bar-exit"></div>
      </div>
    `
  }
}

function pieWedge(a0: number, a1: number): string {
  const x0 = MAX_RADIUS * Math.cos(a0), y0 = MAX_RADIUS * Math.sin(a0)
  const x1 = MAX_RADIUS * Math.cos(a1), y1 = MAX_RADIUS * Math.sin(a1)
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M 0 0 L ${x0} ${y0} A ${MAX_RADIUS} ${MAX_RADIUS} 0 ${large} 1 ${x1} ${y1} Z`
}

function drawPie(el: HTMLElement, frac: number) {
  const start = -Math.PI / 2
  const mid = start + frac * 2 * Math.PI
  const end = start + 2 * Math.PI
  const e = el.querySelector<SVGPathElement>('.pie-entry')
  const x = el.querySelector<SVGPathElement>('.pie-exit')
  if (e) e.setAttribute('d', frac > 0.001 ? pieWedge(start, mid) : '')
  if (x) x.setAttribute('d', frac < 0.999 ? pieWedge(mid, end) : '')
}

const easeInOutQuad = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2

function applyPieData(el: HTMLElement, entries: number, exits: number, animMs: number, linear: boolean) {
  const total = entries + exits
  const target = total > 0 ? entries / total : 0.5
  const state = glyphState.get(el) ?? { entryFrac: target, animId: 0 }
  cancelAnimationFrame(state.animId)
  if (animMs <= 0 || Math.abs(state.entryFrac - target) < 0.0005) {
    state.entryFrac = target
    drawPie(el, target)
    glyphState.set(el, state)
    return
  }
  const startFrac = state.entryFrac
  const t0 = performance.now()
  const ease = linear ? (t: number) => t : easeInOutQuad
  const tick = (now: number) => {
    const t = Math.min(1, (now - t0) / animMs)
    const cur = startFrac + (target - startFrac) * ease(t)
    state.entryFrac = cur
    drawPie(el, cur)
    if (t < 1) state.animId = requestAnimationFrame(tick)
  }
  state.animId = requestAnimationFrame(tick)
  glyphState.set(el, state)
}

function applyBarsData(el: HTMLElement, entries: number, exits: number) {
  const total = entries + exits
  // Each bar uses its share of `total` × half the glyph height. Green grows
  // upward from the center baseline; orange grows downward. At a 100% split
  // the dominant bar reaches MAX_RADIUS (= half the glyph), matching the
  // pie's outer radius.
  const eFrac = total > 0 ? entries / total : 0
  const xFrac = total > 0 ? exits / total : 0
  const eEl = el.querySelector<HTMLElement>('.bar-entry')
  const xEl = el.querySelector<HTMLElement>('.bar-exit')
  if (eEl) eEl.style.height = `${eFrac * 50}%`
  if (xEl) xEl.style.height = `${xFrac * 50}%`
}
