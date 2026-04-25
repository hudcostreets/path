import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useQuery } from '@tanstack/react-query'
import { asyncBufferFromUrl, parquetRead } from 'hyparquet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Param, codeParam, useUrlState } from 'use-prms'
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { STATION_COORDS } from './stations-geo'

const resolved = dvcResolve('hourly.pqt')
const hourlyUrl = resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved

type StationRow = {
  station: string
  ym: string
  hour: number
  entries: number
  exits: number
}
type RangeAvg = { station: string, entries: number, exits: number }
type Shape = 'pie' | 'bars'
const shapeParam = codeParam<Shape>('pie', { pie: 'p', bars: 'b' })
const ALL_HOURS = -1
const hourParam: Param<number> = {
  encode(h) { return h === ALL_HOURS ? undefined : String(h) },
  decode(s) {
    if (s === undefined) return ALL_HOURS
    const n = parseInt(s)
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : ALL_HOURS
  },
}

const ENTRY_COLOR = '#22c55e'
const EXIT_COLOR = '#f97316'
const MAX_RADIUS = 56

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

export default function StationsMap({ embedded = false, onDateRangeChange }: {
  embedded?: boolean
  /** Fires whenever the date range changes (after auto-init or user edit).
   *  Lets the parent share the range with sibling plots (plot3 brushing). */
  onDateRangeChange?: (range: { from: string, to: string }) => void
} = {}) {
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

  const [fromYm, setFromYm] = useState<string>('')
  const [toYm, setToYm] = useState<string>('')
  const [hour, setHour] = useUrlState<number>('mh', hourParam)
  const [hoveredHour, setHoveredHour] = useState<number | null>(null)
  const effectiveHour = hoveredHour ?? hour
  const [shape, setShape] = useUrlState<Shape>('ms', shapeParam)
  const [animMs, setAnimMs] = useState<number>(400)
  const [playing, setPlaying] = useState(true)
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
  useEffect(() => {
    if (!playing) return
    if (hourRef.current === ALL_HOURS) {
      setHour(0)
      return
    }
    const period = Math.max(animMs, 120)
    const id = setInterval(() => {
      const cur = hourRef.current
      setHour(cur === ALL_HOURS ? 0 : (cur + 1) % 24)
    }, period)
    return () => clearInterval(id)
  }, [playing, animMs, setHour])

  useEffect(() => {
    if (allYms.length && !fromYm) setFromYm(allYms[0])
    if (allYms.length && !toYm) setToYm(allYms[allYms.length - 1])
  }, [allYms, fromYm, toYm])

  // Notify parent on every (validated) range change so sibling plots can brush.
  useEffect(() => {
    if (fromYm && toYm) onDateRangeChange?.({ from: fromYm, to: toYm })
  }, [fromYm, toYm, onDateRangeChange])

  const rangeAvg = useMemo<RangeAvg[]>(() => {
    if (!rows || !fromYm || !toYm) return []
    const inRange = rows.filter(r => r.ym >= fromYm && r.ym <= toYm)
    const perYm = new Map<string, Map<string, { e: number, x: number }>>()
    for (const r of inRange) {
      if (effectiveHour !== ALL_HOURS && r.hour !== effectiveHour) continue
      const s = perYm.get(r.station) ?? new Map()
      const cur = s.get(r.ym) ?? { e: 0, x: 0 }
      cur.e += r.entries; cur.x += r.exits
      s.set(r.ym, cur); perYm.set(r.station, s)
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
    return Array.from(perYm.entries()).map(([station, m]) => ({
      station,
      entries: mean(Array.from(m.values()).map(v => v.e)),
      exits: mean(Array.from(m.values()).map(v => v.x)),
    }))
  }, [rows, fromYm, toYm, effectiveHour])

  // Per-view max: the biggest station in the current (date-range, hour) slice
  // fills MAX_RADIUS. Off-peak hours would otherwise render as tiny dots if we
  // pegged the scale to the daily-sum max.
  const maxTotal = useMemo(() => {
    let max = 1
    for (const r of rangeAvg) max = Math.max(max, r.entries + r.exits)
    return max
  }, [rangeAvg])

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
    // NJ pane: clock occupies top-left ~140×130; tight margins otherwise.
    const njPad = { left: 140, top: 30, right: 30, bottom: 60 }
    // Core pane: no clock — pad just for marker extents.
    const corePad = { left: 30, top: 30, right: 60, bottom: 60 }
    const fitAll = () => {
      // Both panes share a zoom level: pick the smaller-fitting zoom across
      // panes so neither clips. In practice that's the core pane (its bbox
      // is ~10× wider than NJ's). Result: stations on both sides render at
      // the same physical scale.
      const zNj = computeZoom(njMap, njBounds, njPad)
      const zCore = computeZoom(coreMap, coreBounds, corePad)
      const zoom = Math.min(zNj, zCore)
      placePaneAtZoom(njMap, njBounds, zoom, njPad)
      placePaneAtZoom(coreMap, coreBounds, zoom, corePad)
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
    for (const [station, [lng, lat]] of Object.entries(STATION_COORDS)) {
      const icon = L.divIcon({
        html: `<div class="station-glyph" style="width:${ICON_BOX}px;height:${ICON_BOX}px"></div>`
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
      marker.bindPopup(
        `<strong>${station}</strong><br/>Avg entries: ${Math.round(t.entries).toLocaleString()}<br/>Avg exits: ${Math.round(t.exits).toLocaleString()}`
      )
    }
  }, [rangeAvg, maxTotal, shape, animMs, playing])


  const hourLabel = effectiveHour === ALL_HOURS ? 'All hours' : HOUR_LABELS[effectiveHour]

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
      <div style={mapRowStyle}>
        <div ref={njContainerRef} className="map-pane-nj" style={{ ...paneStyle, flex: '0 0 27%' }} />
        <div className="map-elide-divider" aria-hidden style={{ ...paneStyle, flex: '0 0 28px' }} />
        <div ref={coreContainerRef} className="map-pane-core" style={{ ...paneStyle, flex: '1 1 auto' }} />
      </div>
      {clockHost && createPortal(
        <div className="map-clock-panel">
          <div className="map-clock-label">
            <span className="map-clock-hint">Hour</span>
            <strong>{hourLabel}</strong>
          </div>
          <div className="map-clock-row">
            <HourClock
              hour={hour}
              onChange={h => { setHour(h); setPlaying(false) }}
              onHoverChange={setHoveredHour}
              animMs={Math.max(animMs, 120)}
              playing={playing}
            />
            <button type="button"
              onClick={() => setPlaying(p => !p)}
              title={playing ? 'Pause hour cycle' : 'Cycle through hours'}
              style={playButtonStyle}>
              {playing ? '⏸' : '▶'}
            </button>
          </div>
        </div>,
        clockHost,
      )}
      <div style={{
        padding: '0.4rem 0',
        fontSize: '0.85rem',
        color: '#888',
        display: 'flex',
        gap: '1.2em',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}>
        <span><span style={{ color: ENTRY_COLOR }}>green</span>/<span style={{ color: EXIT_COLOR }}>orange</span> = entries/exits · area ∝ volume</span>
        {fromYm && toYm && (
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
        {!embedded && <a href="/">← PATH ridership</a>}
      </div>
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

// Parse "YY-?MM" / "YYYY-?MM" → "YYYY-MM". Accepts "26-2", "2602", "2026-02".
// Returns null when no available month matches.
function parseYmInput(s: string, allYms: string[]): string | null {
  const t = s.trim()
  if (!t) return null
  const m4 = t.match(/^(\d{4})-?(\d{1,2})$/)
  const m2 = t.match(/^(\d{2})-?(\d{1,2})$/)
  let yyyy: number, mm: number
  if (m4) { yyyy = parseInt(m4[1]); mm = parseInt(m4[2]) }
  else if (m2) { yyyy = 2000 + parseInt(m2[1]); mm = parseInt(m2[2]) }
  else return null
  if (mm < 1 || mm > 12) return null
  const ym = `${yyyy}-${String(mm).padStart(2, '0')}`
  return allYms.includes(ym) ? ym : null
}
const ymToInput = (ym: string) => ym ? `${ym.slice(2, 4)}-${ym.slice(5, 7)}` : ''

function YmInput({ value, onChange, allYms }: {
  value: string
  onChange: (v: string) => void
  allYms: string[]
}) {
  const [text, setText] = useState(ymToInput(value))
  // Resync when external value changes (URL nav, reset).
  useEffect(() => { setText(ymToInput(value)) }, [value])
  // Read raw text from the DOM at commit time — stale-closure-safe — and
  // either accept (notify parent + canonicalize) or revert to last valid.
  const commit = (raw: string) => {
    const parsed = parseYmInput(raw, allYms)
    if (parsed) {
      onChange(parsed)
      setText(ymToInput(parsed))
    } else {
      setText(ymToInput(value))
    }
  }
  return (
    <input
      type="text"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={e => commit(e.currentTarget.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.currentTarget.blur() }
        else if (e.key === 'Escape') { setText(ymToInput(value)); e.currentTarget.blur() }
      }}
      placeholder="YY-MM"
      style={{
        ...selectStyle,
        width: '4.5em',
        textAlign: 'center',
        fontFamily: 'ui-monospace, monospace',
      }}
    />
  )
}

const playButtonStyle: React.CSSProperties = {
  background: '#222',
  color: '#ddd',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '0 0.4em',
  fontSize: '0.85rem',
  cursor: 'pointer',
  lineHeight: 1.4,
  minWidth: '1.8em',
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
            transition: `transform ${animMs}ms linear`,
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
