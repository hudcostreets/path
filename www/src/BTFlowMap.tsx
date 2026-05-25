import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useUrlState } from 'use-prms'
import {
  ribbonArrow, offsetPath, pxToHalfDeg, pxToDeg, smoothPath,
  type LatLon,
} from 'geo-sankey'
import { useDark } from './plot-utils'
import { BT_CROSSING_PATHS, BT_BBOX, BT_CROSSING_LABELS } from './bt-crossings-geo'

type TrafficRow = { crossing: string, type: string, year: number, month: string, count: number }

// Stack order along the perpendicular axis (NJ→NY ribbons read top-to-bottom).
const VEHICLE_TYPES = ['Buses', 'Trucks', 'Automobiles'] as const

const VEHICLE_TYPE_COLORS: Record<string, string> = {
  Automobiles: '#636efa',
  Buses:       '#EF553B',
  Trucks:      '#00cc96',
}

// Max ribbon width (Autos at the busiest crossing) in pixels at the rendered
// zoom — before the user's `ws` multiplier. Sqrt scale keeps the smallest
// flows ≥1px even after scaling.
const BASE_MAX_RIBBON_PX = 56
// Vertical gap between vehicle-type ribbons within a crossing.
const STACK_GAP_PX = 1.5

const TILE_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

const ATTR = ''  // Rendered once in JSX below; suppress Leaflet's built-in box.

const MAP_HEIGHT_KEY = 'bt-flow-map-height'
// Default to 80 vh capped so the BT map dominates the viewport on first load
// without scrolling the page off the title — user can drag to taste, and the
// height persists in sessionStorage.
function defaultMapHeight(): number {
  if (typeof window === 'undefined') return 720
  return Math.min(Math.round(window.innerHeight * 0.8), 1100)
}
const MIN_HEIGHT = 320
const MAX_HEIGHT = 1400

interface Props {
  rows: TrafficRow[]
}

interface FlowProps {
  crossing: string
  type: string
  count: number
  color: string
}

interface LatestVolumeData {
  latest: { year: number, month: string } | null
  volumes: Map<string, number>
  maxVol: number
}

// Shared data extraction: latest (year, month), per-(crossing, type) volume,
// and the global max for ribbon-width scaling.
function useLatestVolumes(rows: TrafficRow[]): LatestVolumeData {
  return useMemo(() => {
    if (!rows.length) return { latest: null, volumes: new Map(), maxVol: 0 }
    const r = rows[rows.length - 1]
    const latest = { year: r.year, month: r.month }
    const volumes = new Map<string, number>()
    for (const row of rows) {
      if (row.year !== latest.year || row.month !== latest.month) continue
      const key = `${row.crossing}|${row.type}`
      volumes.set(key, (volumes.get(key) ?? 0) + row.count)
    }
    let maxVol = 0
    for (const v of volumes.values()) if (v > maxVol) maxVol = v
    return { latest, volumes, maxVol }
  }, [rows])
}

function monthYearLabel(latest: { year: number, month: string } | null): string {
  return latest ? `${latest.month} '${String(latest.year).slice(-2)}` : '—'
}

interface BuildOpts {
  maxRibbonPx: number
  bodyLen: number
}

/** Stretch a NJ→NY path back from its destination (NY end held fixed) so the
 *  visible ribbon is `scale×` as long. Multi-waypoint paths keep their shape
 *  — every NJ-side waypoint moves proportionally further from the NY end. */
function scalePath(path: LatLon[], scale: number): LatLon[] {
  if (scale === 1 || path.length < 2) return path
  const [endLat, endLon] = path[path.length - 1]
  return path.map(([lat, lon], i) =>
    i === path.length - 1
      ? [lat, lon] as LatLon
      : [endLat + (lat - endLat) * scale, endLon + (lon - endLon) * scale] as LatLon
  )
}

/** Build ribbon GeoJSON features for a subset of crossings at the given zoom. */
function buildRibbonFeatures(
  crossings: string[],
  paths: Record<string, LatLon[]>,
  volumes: Map<string, number>,
  maxVol: number,
  zoom: number,
  refLat: number,
  { maxRibbonPx, bodyLen }: BuildOpts,
): GeoJSON.Feature<GeoJSON.Polygon, FlowProps>[] {
  if (maxVol === 0) return []
  // sqrt scale compresses the GWB-autos-vs-Bayonne-buses dynamic range
  // (~5 orders of magnitude) into something legible.
  const widthOf = (vol: number) =>
    vol > 0 ? Math.max(1, Math.sqrt(vol / maxVol) * maxRibbonPx) : 0

  const features: GeoJSON.Feature<GeoJSON.Polygon, FlowProps>[] = []
  for (const crossing of crossings) {
    const baseRaw = paths[crossing]
    if (!baseRaw) continue
    // Catmull-Rom spline through the 3 user-defined waypoints, then resample
    // densely so `ribbonArrow` produces a smooth curve (instead of the harsh
    // mid-path elbow of a 3-point polyline). Edit-mode handles remain at the
    // original waypoints — they're the spline knots, so the curve passes
    // through each handle exactly.
    const basePath = smoothPath(scalePath(baseRaw, bodyLen), 12).path
    const widths = VEHICLE_TYPES.map(t => widthOf(volumes.get(`${crossing}|${t}`) ?? 0))
    // Stack offsets perpendicular to the flow.
    const totalW = widths.reduce((a, b) => a + b, 0)
      + STACK_GAP_PX * Math.max(0, widths.filter(w => w > 0).length - 1)
    let acc = -totalW / 2
    const centerOffsets: number[] = []
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] === 0) { centerOffsets.push(0); continue }
      acc += widths[i] / 2
      centerOffsets.push(acc)
      acc += widths[i] / 2 + STACK_GAP_PX
    }

    for (let i = 0; i < VEHICLE_TYPES.length; i++) {
      const type = VEHICLE_TYPES[i]
      const count = volumes.get(`${crossing}|${type}`) ?? 0
      if (count <= 0) continue
      const width = widths[i]
      const offsetPx = centerOffsets[i]
      const offsetUnits = offsetPx === 0 ? 0 : pxToDeg(offsetPx, zoom, 1, refLat) / 0.0004
      const path: LatLon[] = offsetPath(basePath, offsetUnits)
      const hw = pxToHalfDeg(width, zoom, 1, refLat)
      const ring = ribbonArrow(path, hw, refLat, { widthPx: width })
      if (!ring.length) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring as [number, number][]] },
        properties: { crossing, type, count, color: VEHICLE_TYPE_COLORS[type] },
      })
    }
  }
  return features
}

function ribbonGeoJSONLayer(
  features: GeoJSON.Feature<GeoJSON.Polygon, FlowProps>[],
): L.GeoJSON {
  const fc: GeoJSON.FeatureCollection<GeoJSON.Polygon, FlowProps> = {
    type: 'FeatureCollection',
    features,
  }
  return L.geoJSON(fc, {
    style: (f) => ({
      fillColor: (f!.properties as FlowProps).color,
      fillOpacity: 0.85,
      color: (f!.properties as FlowProps).color,
      weight: 0,
    }),
    onEachFeature: (f, layer) => {
      const p = f.properties as FlowProps
      layer.bindTooltip(
        `<strong>${p.crossing}</strong><br>${p.type}: ${p.count.toLocaleString()}`,
        { sticky: true, direction: 'top' },
      )
    },
  })
}

/** Build a layer group of crossing-name labels at each path's NJ end. The
 *  divIcon is anchored to the right edge so the text renders to the WEST of
 *  the NJ approach — out of the ribbon for all six crossings. Labels move
 *  with `bodyLen` so they stay glued to the visible ribbon start. */
function crossingLabelsLayer(
  crossings: string[],
  paths: Record<string, LatLon[]>,
  bodyLen: number,
): L.LayerGroup {
  const group = L.layerGroup()
  for (const crossing of crossings) {
    const baseRaw = paths[crossing]
    if (!baseRaw) continue
    const scaled = scalePath(baseRaw, bodyLen)
    const [lat, lon] = scaled[0]
    const text = BT_CROSSING_LABELS[crossing] ?? crossing
    const icon = L.divIcon({
      className: 'bt-crossing-label',
      html: `<span>${text}</span>`,
      iconSize: undefined as unknown as L.PointExpression,
      iconAnchor: [0, 0],
    })
    L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(group)
  }
  return group
}

interface ControlsProps {
  widthScale: number
  setWidthScale: (v: number) => void
  bodyLen: number
  setBodyLen: (v: number) => void
  edit: boolean
  setEdit: (v: boolean) => void
  onExport: () => void
  onReset: () => void
}

function MapControls(p: ControlsProps) {
  return (
    <div className="bt-flow-controls">
      <label title="Multiplier on ribbon widths.">
        <span>Width</span>
        <input
          type="range" min={0.2} max={WIDTH_SCALE_MAX} step={0.1}
          value={p.widthScale}
          onChange={e => p.setWidthScale(parseFloat(e.target.value))}
        />
        <span className="bt-flow-controls-value">{p.widthScale.toFixed(1)}×</span>
      </label>
      <label title="Stretches the ribbon body backwards from the NY-side destination; NY-end held fixed.">
        <span>Length</span>
        <input
          type="range" min={0.5} max={BODY_LEN_MAX} step={0.1}
          value={p.bodyLen}
          onChange={e => p.setBodyLen(parseFloat(e.target.value))}
          disabled={p.edit}
        />
        <span className="bt-flow-controls-value">{p.bodyLen.toFixed(1)}×</span>
      </label>
      <label title="Edit mode: drag the per-waypoint handles to reposition each crossing's path. The Length slider is locked while editing — dragend inverse-scales drops back to 1× coords so the JSON export round-trips cleanly.">
        <input
          type="checkbox"
          checked={p.edit}
          onChange={e => p.setEdit(e.target.checked)}
        />
        <span>Edit paths</span>
      </label>
      {p.edit && (
        <>
          <button type="button" className="bt-flow-controls-btn" onClick={p.onExport}>
            Export JSON
          </button>
          <button type="button" className="bt-flow-controls-btn" onClick={p.onReset}>
            Reset
          </button>
        </>
      )}
    </div>
  )
}

// =============================================================================
// Default export: single tall map covering the full BT bbox.
// =============================================================================

const DEFAULT_WIDTH_SCALE = 2
const DEFAULT_BODY_LEN = 4
const WIDTH_SCALE_MAX = 4
const BODY_LEN_MAX = 10
const widthScaleParam = {
  encode: (v: number) => v === DEFAULT_WIDTH_SCALE ? undefined : v.toFixed(1),
  decode: (s: string | undefined) => s !== undefined ? parseFloat(s) : DEFAULT_WIDTH_SCALE,
}
const bodyLenParam = {
  encode: (v: number) => v === DEFAULT_BODY_LEN ? undefined : v.toFixed(1),
  decode: (s: string | undefined) => s !== undefined ? parseFloat(s) : DEFAULT_BODY_LEN,
}
const editParam = {
  encode: (v: boolean) => v ? '1' : undefined,
  decode: (s: string | undefined) => s === '1',
}

// `llz=<lat><lon><zoom>` with sign-separator encoding (matches the
// convention in sibling crash-map / household-vehicles apps). Lon's leading
// `-` (or `+` if positive) and zoom's leading `+` are the delimiters, so
// e.g. `40.7345-74.0843+10.50` parses cleanly with the regex below.
type LLZ = { lat: number, lon: number, zoom: number }
// Chosen at the typical desktop viewport so all 6 crossings fit comfortably
// at an INTEGER zoom level (no fractional-zoom tile gridline artifacts on
// CARTO dark tiles). Update if a better view-of-record gets chosen.
const DEFAULT_LLZ: LLZ = { lat: 40.7171, lon: -74.1570, zoom: 11 }
const llzParam = {
  encode: (v: LLZ | null) => {
    if (!v) return undefined
    const lonSign = v.lon < 0 ? '' : '+'
    return `${v.lat.toFixed(4)}${lonSign}${v.lon.toFixed(4)}+${v.zoom.toFixed(2)}`
  },
  decode: (s: string | undefined): LLZ | null => {
    if (!s) return null
    const parts = s.match(/[+-]?\d+(?:\.\d+)?/g)
    if (!parts || parts.length < 3) return null
    const lat = parseFloat(parts[0])
    const lon = parseFloat(parts[1])
    const zoom = parseFloat(parts[2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(zoom)) return null
    return { lat, lon, zoom }
  },
}

const PATHS_EDIT_KEY = 'bt-flow-paths-edit'

/** Format edited paths as a JSON-ish snippet ready to paste into
 *  `bt-crossings-geo.ts` over the existing `BT_CROSSING_PATHS` body. */
function formatPathsForExport(paths: Record<string, LatLon[]>): string {
  const lines: string[] = []
  for (const [crossing, path] of Object.entries(paths)) {
    lines.push(`  '${crossing}': [`)
    for (const [lat, lon] of path) {
      lines.push(`    [${lat.toFixed(4)}, ${lon.toFixed(4)}],`)
    }
    lines.push(`  ],`)
  }
  return `{\n${lines.join('\n')}\n}`
}

/** Draggable handle layer for edit mode. Each waypoint of each crossing gets
 *  a marker placed at its scaled (visible) position so handles overlay the
 *  rendered ribbon; on drag we inverse-scale back to the underlying coord
 *  before updating state, so the JSON export round-trips cleanly regardless
 *  of the current `bodyLen`. The 3 sub-ribbons per crossing share one path,
 *  so dragging any waypoint rotates the whole group.
 *
 *  Dragging the NY-end (last) handle preserves the other waypoints' VISIBLE
 *  positions by compensating their stored coords for the moved end —
 *  otherwise scalePath would re-stretch them from the new end at `bodyLen`
 *  and they'd jump by (1 - bodyLen)× the end's delta (e.g. at bodyLen=4,
 *  a 1° end drag would jump the other handles 3° the *opposite* way). */
function buildEditHandles(
  paths: Record<string, LatLon[]>,
  bodyLen: number,
  onPathChange: (crossing: string, path: LatLon[]) => void,
): L.LayerGroup {
  const group = L.layerGroup()
  const palette: Record<string, string> = {
    'George Washington Bridge': '#636efa',
    'Lincoln Tunnel': '#EF553B',
    'Holland Tunnel': '#00cc96',
    'Bayonne Bridge': '#19d3f3',
    'Goethals Bridge': '#ab63fa',
    'Outerbridge Crossing': '#FFA15A',
  }
  for (const [crossing, path] of Object.entries(paths)) {
    const color = palette[crossing] ?? '#ffeb3b'
    const scaled = scalePath(path, bodyLen)
    const endIdx = path.length - 1
    path.forEach((_, idx) => {
      const [vlat, vlon] = scaled[idx]
      const icon = L.divIcon({
        className: 'bt-edit-handle',
        html: `<div style="--c:${color}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      })
      const m = L.marker([vlat, vlon], { icon, draggable: true, autoPan: true })
      m.bindTooltip(`${crossing} · pt ${idx}`, { direction: 'top' })
      // Commit only on `dragend` — committing mid-drag would re-run the
      // effect that built this marker and tear its DOM down under Leaflet's
      // drag handler. Handles still move smoothly during the drag because
      // Leaflet updates the icon position directly; ribbons snap on release.
      m.on('dragend', () => {
        const ll = m.getLatLng()
        const [endLat, endLon] = path[endIdx]
        if (idx === endIdx) {
          // END drag: move the end + translate other points' STORED coords
          // so their visible positions stay put under scalePath. Derivation:
          //   visible_i = endOld + (stored_i - endOld) * k         (current)
          //   visible_i = endNew + (stored_i_new - endNew) * k     (want)
          // → stored_i_new = stored_i + (endNew - endOld) * (1 - 1/k)
          const dLat = ll.lat - endLat
          const dLon = ll.lng - endLon
          const factor = bodyLen === 0 ? 0 : 1 - 1 / bodyLen
          const next: LatLon[] = path.map((p, i) =>
            i === endIdx
              ? [ll.lat, ll.lng]
              : [p[0] + dLat * factor, p[1] + dLon * factor] as LatLon
          )
          onPathChange(crossing, next)
        } else {
          // Non-end drag: inverse-scale the single dragged point.
          const stored: LatLon = bodyLen === 0
            ? [ll.lat, ll.lng]
            : [endLat + (ll.lat - endLat) / bodyLen, endLon + (ll.lng - endLon) / bodyLen]
          const next: LatLon[] = path.map((p, i) => (i === idx ? stored : p))
          onPathChange(crossing, next)
        }
      })
      group.addLayer(m)
    })
  }
  return group
}

export default function BTFlowMap({ rows }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.TileLayer | null>(null)
  const layerRef = useRef<L.GeoJSON | null>(null)
  const labelsRef = useRef<L.LayerGroup | null>(null)
  const handlesRef = useRef<L.LayerGroup | null>(null)
  const dark = useDark()

  const [widthScale, setWidthScale] = useUrlState<number>('ws', widthScaleParam)
  const [bodyLen, setBodyLen] = useUrlState<number>('blen', bodyLenParam)
  const [edit, setEdit] = useUrlState<boolean>('edit', editParam)
  const [llz, setLlz] = useUrlState<LLZ | null>('llz', llzParam)
  // Keep the latest setter in a ref so the init-once map effect doesn't need
  // to re-run when use-prms hands back a new setter identity.
  const setLlzRef = useRef(setLlz)
  setLlzRef.current = setLlz
  // Snapshot the URL-loaded llz for the init effect (so it's not re-read on
  // subsequent renders, which would fight user pan/zoom).
  const initialLlzRef = useRef(llz)
  const [height, setHeight] = useState<number>(() => {
    if (typeof sessionStorage === 'undefined') return defaultMapHeight()
    const stored = sessionStorage.getItem(MAP_HEIGHT_KEY)
    const n = stored ? parseInt(stored, 10) : NaN
    return Number.isFinite(n) ? n : defaultMapHeight()
  })
  // Live edits to the path waypoints. Persisted in sessionStorage so edits
  // survive reloads within the same tab — clear by hitting "Reset" or by
  // committing the JSON back into `bt-crossings-geo.ts`.
  const [paths, setPaths] = useState<Record<string, LatLon[]>>(() => {
    if (typeof sessionStorage !== 'undefined') {
      const stored = sessionStorage.getItem(PATHS_EDIT_KEY)
      if (stored) {
        try { return JSON.parse(stored) } catch { /* fall through */ }
      }
    }
    return structuredClone(BT_CROSSING_PATHS)
  })

  const { latest, volumes, maxVol } = useLatestVolumes(rows)
  const monthLabel = monthYearLabel(latest)
  const refLat = (BT_BBOX.minLat + BT_BBOX.maxLat) / 2
  const crossings = useMemo(() => Object.keys(paths), [paths])
  const buildOpts: BuildOpts = useMemo(
    () => ({ maxRibbonPx: BASE_MAX_RIBBON_PX * widthScale, bodyLen }),
    [widthScale, bodyLen],
  )

  // Stash path edits into SS so a reload doesn't lose them.
  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return
    const same = JSON.stringify(paths) === JSON.stringify(BT_CROSSING_PATHS)
    if (same) sessionStorage.removeItem(PATHS_EDIT_KEY)
    else sessionStorage.setItem(PATHS_EDIT_KEY, JSON.stringify(paths))
  }, [paths])

  const updatePath = (crossing: string, path: LatLon[]) => {
    setPaths(prev => ({ ...prev, [crossing]: path }))
  }
  const resetPaths = () => setPaths(structuredClone(BT_CROSSING_PATHS))
  const exportPaths = async () => {
    const text = formatPathsForExport(paths)
    try {
      await navigator.clipboard.writeText(text)
      // eslint-disable-next-line no-alert
      alert('Path JSON copied to clipboard.')
    } catch {
      // eslint-disable-next-line no-alert
      prompt('Copy this JSON into bt-crossings-geo.ts:', text)
    }
  }

  // Init map once. Pan/zoom enabled (drag + wheel + zoom buttons). If the
  // URL had an `llz=` value, restore that view; otherwise use `DEFAULT_LLZ`
  // (an integer-zoom view chosen to fit all crossings without tile gridline
  // artifacts). Subsequent container resizes call `invalidateSize` so user
  // pan/zoom isn't clobbered. Every user pan/zoom syncs the new view back
  // to `llz=` so the URL is shareable + can drive new defaults.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, {
      zoomSnap: 0.25,
      zoomControl: true,
      attributionControl: false,
      scrollWheelZoom: true,
    })
    const initial = initialLlzRef.current ?? DEFAULT_LLZ
    map.setView([initial.lat, initial.lon], initial.zoom)
    mapRef.current = map
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(containerRef.current)
    // Sync every moveend back to the URL. Skip the very first moveend (from
    // the init setView/fitBounds above) so an auto-fit on a clean URL
    // doesn't immediately bake the auto-chosen zoom into the URL.
    let skipFirst = true
    const onMoveEnd = () => {
      if (skipFirst) { skipFirst = false; return }
      const c = map.getCenter()
      setLlzRef.current({ lat: c.lat, lon: c.lng, zoom: map.getZoom() })
    }
    map.on('moveend', onMoveEnd)
    return () => {
      ro.disconnect()
      map.off('moveend', onMoveEnd)
      if (labelsRef.current) { labelsRef.current.remove(); labelsRef.current = null }
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Crossing-name labels: re-render when paths or bodyLen change so they
  // track the visible NJ end of each ribbon.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (labelsRef.current) labelsRef.current.remove()
    labelsRef.current = crossingLabelsLayer(crossings, paths, bodyLen).addTo(map)
  }, [crossings, paths, bodyLen])

  // Edit-mode draggable handles; placed at the scaled (visible) positions so
  // they overlay the rendered ribbons.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (handlesRef.current) { handlesRef.current.remove(); handlesRef.current = null }
    if (edit) handlesRef.current = buildEditHandles(paths, bodyLen, updatePath).addTo(map)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit, paths, bodyLen])

  // Tile layer follows theme.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (tileRef.current) tileRef.current.remove()
    tileRef.current = L.tileLayer(dark ? TILE_DARK : TILE_LIGHT, {
      attribution: ATTR,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)
  }, [dark])

  // Draw ribbons whenever volumes, zoom, paths, or control values change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !latest) return
    const redraw = () => {
      if (layerRef.current) layerRef.current.remove()
      const features = buildRibbonFeatures(crossings, paths, volumes, maxVol, map.getZoom(), refLat, buildOpts)
      layerRef.current = ribbonGeoJSONLayer(features).addTo(map)
    }
    redraw()
    map.on('zoomend', redraw)
    return () => { map.off('zoomend', redraw); if (layerRef.current) layerRef.current.remove() }
  }, [crossings, paths, volumes, maxVol, latest, refLat, buildOpts])

  return (
    <div className="bt-flow-map">
      <h2 className="bt-flow-map-title">
        Monthly traffic by crossing — {monthLabel}
        <span className="bt-flow-map-dir"> · eastbound (NY-bound) only</span>
      </h2>
      <MapControls
        widthScale={widthScale}
        setWidthScale={setWidthScale}
        bodyLen={bodyLen}
        setBodyLen={setBodyLen}
        edit={edit}
        setEdit={setEdit}
        onExport={exportPaths}
        onReset={resetPaths}
      />
      <div
        ref={containerRef}
        className="bt-flow-single"
        style={{ height }}
        onMouseUp={e => {
          // CSS `resize: vertical` produces the drag-handle; snapshot the new
          // height into state + sessionStorage so it survives re-renders.
          const h = (e.currentTarget as HTMLDivElement).offsetHeight
          if (h !== height) {
            setHeight(h)
            sessionStorage.setItem(MAP_HEIGHT_KEY, String(h))
          }
        }}
      />
      <p className="bt-flow-map-attr">
        Maps: <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> ·
        Tiles © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> ·
        Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors
      </p>
    </div>
  )
}

// =============================================================================
// Alternate layout: 2×2 grid of per-cluster panes. Useful for emphasizing
// individual crossings; opt in by importing this named export instead of the
// default. Each pane fits a fixed lat/lon viewport, and all panes share a
// single Leaflet zoom so ribbon widths remain physically comparable.
// =============================================================================

const PANE_GROUPS: {
  name: string
  crossings: string[]
  viewport: { lat: [number, number], lon: [number, number] }
}[] = [
  {
    name: 'GWB',
    crossings: ['George Washington Bridge'],
    viewport: { lat: [40.831, 40.872], lon: [-73.999, -73.921] },
  },
  {
    name: 'Hudson',
    crossings: ['Lincoln Tunnel', 'Holland Tunnel'],
    viewport: { lat: [40.708, 40.782], lon: [-74.058, -73.978] },
  },
  {
    name: 'KVK',
    crossings: ['Bayonne Bridge', 'Goethals Bridge'],
    viewport: { lat: [40.612, 40.668], lon: [-74.222, -74.108] },
  },
  {
    name: 'Outerbridge',
    crossings: ['Outerbridge Crossing'],
    viewport: { lat: [40.498, 40.548], lon: [-74.282, -74.215] },
  },
]

export function BTFlowMapPanes({ rows }: Props) {
  const dark = useDark()
  const { latest, volumes, maxVol } = useLatestVolumes(rows)
  const monthLabel = monthYearLabel(latest)

  // Each pane reports its highest-fitting zoom; we take the MIN so they all
  // render at the same physical scale.
  const paneZoomsRef = useRef<(number | null)[]>(PANE_GROUPS.map(() => null))
  const [sharedZoom, setSharedZoom] = useState<number | null>(null)
  const handlePaneIdealZoom = (idx: number, z: number) => {
    paneZoomsRef.current[idx] = z
    const all = paneZoomsRef.current
    if (all.every(v => v !== null)) {
      const min = Math.min(...(all as number[]))
      setSharedZoom(prev => (prev === null || Math.abs(prev - min) > 0.001 ? min : prev))
    }
  }

  return (
    <div className="bt-flow-map">
      <h2 className="bt-flow-map-title">
        Monthly traffic by crossing — {monthLabel}
      </h2>
      <div className="bt-flow-map-row">
        {PANE_GROUPS.map((g, i) => (
          <BTFlowPane
            key={g.name}
            crossings={g.crossings}
            viewport={g.viewport}
            volumes={volumes}
            maxVol={maxVol}
            dark={dark}
            sharedZoom={sharedZoom}
            onIdealZoom={z => handlePaneIdealZoom(i, z)}
          />
        ))}
      </div>
      <p className="bt-flow-map-attr">
        Maps: <a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a> ·
        Tiles © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a> ·
        Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors
      </p>
    </div>
  )
}

interface PaneProps {
  crossings: string[]
  viewport: { lat: [number, number], lon: [number, number] }
  volumes: Map<string, number>
  maxVol: number
  dark: boolean
  sharedZoom: number | null
  onIdealZoom: (z: number) => void
}

function BTFlowPane({ crossings, viewport, volumes, maxVol, dark, sharedZoom, onIdealZoom }: PaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const tileRef = useRef<L.TileLayer | null>(null)
  const layerRef = useRef<L.GeoJSON | null>(null)
  const labelsRef = useRef<L.LayerGroup | null>(null)

  const bbox = useMemo(
    () => L.latLngBounds([viewport.lat[0], viewport.lon[0]], [viewport.lat[1], viewport.lon[1]]),
    [viewport],
  )
  const center: L.LatLngTuple = [
    (viewport.lat[0] + viewport.lat[1]) / 2,
    (viewport.lon[0] + viewport.lon[1]) / 2,
  ]
  const refLat = (viewport.lat[0] + viewport.lat[1]) / 2
  const paneBuildOpts: BuildOpts = useMemo(
    () => ({ maxRibbonPx: BASE_MAX_RIBBON_PX, bodyLen: 1 }),
    [],
  )

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, {
      zoomSnap: 0.25,
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      dragging: false,
      keyboard: false,
      touchZoom: false,
    })
    map.setView(center, 12)
    mapRef.current = map
    labelsRef.current = crossingLabelsLayer(crossings, BT_CROSSING_PATHS, 1).addTo(map)
    const reportZoom = () => {
      map.invalidateSize()
      onIdealZoom(map.getBoundsZoom(bbox, true))
    }
    const ro = new ResizeObserver(reportZoom)
    ro.observe(containerRef.current)
    reportZoom()
    return () => {
      ro.disconnect()
      if (labelsRef.current) { labelsRef.current.remove(); labelsRef.current = null }
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || sharedZoom === null) return
    map.setView(center, sharedZoom, { animate: false })
  }, [sharedZoom, center])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (tileRef.current) tileRef.current.remove()
    tileRef.current = L.tileLayer(dark ? TILE_DARK : TILE_LIGHT, {
      attribution: ATTR,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map)
  }, [dark])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const redraw = () => {
      if (layerRef.current) layerRef.current.remove()
      const features = buildRibbonFeatures(crossings, BT_CROSSING_PATHS, volumes, maxVol, map.getZoom(), refLat, paneBuildOpts)
      layerRef.current = ribbonGeoJSONLayer(features).addTo(map)
    }
    redraw()
    map.on('zoomend', redraw)
    return () => { map.off('zoomend', redraw); if (layerRef.current) layerRef.current.remove() }
  }, [crossings, volumes, maxVol, refLat, sharedZoom, paneBuildOpts])

  return <div ref={containerRef} className="bt-flow-pane" />
}
