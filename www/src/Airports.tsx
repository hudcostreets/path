import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useMemo } from "react"
import { Data, Layout } from "plotly.js"
import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { codeParam, codesParam, useUrlState } from "use-prms"
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { compressors } from "./parquet-compressors"
import { Plot } from "./plot-utils"

const AIRPORTS = ['EWR', 'JFK', 'LGA', 'SWF'] as const
type Airport = typeof AIRPORTS[number]

// --- Ground Transport (PBI dashboard scrape) ---

const GROUND_CATEGORIES = [
  'Coach Bus Pax',
  'For-Hire Vehicles',
  'Taxi Dispatched',
  'Parked Cars',
  'Paid-Hwrd Beach',
  'Paid-Jamaica',
  'Paid-EWR',
  'Unpaid-On Airport',
] as const
type GroundCategory = typeof GROUND_CATEGORIES[number]

const GROUND_COLORS: Record<GroundCategory, string> = {
  'Coach Bus Pax':     '#636efa',
  'For-Hire Vehicles': '#EF553B',
  'Taxi Dispatched':   '#00cc96',
  'Parked Cars':       '#ab63fa',
  'Paid-Hwrd Beach':   '#FFA15A',
  'Paid-Jamaica':      '#19d3f3',
  'Paid-EWR':          '#FF6692',
  'Unpaid-On Airport': '#B6E880',
}

type GroundRow = { airport: Airport, year: number, month: number, category: GroundCategory, value: number }

// --- Flights / Passengers (PANYNJ bulk CSV) ---

const MARKETS = ['Domestic', 'International'] as const
type Market = typeof MARKETS[number]

const DIRECTIONS = ['Inbound', 'Outbound'] as const
type Direction = typeof DIRECTIONS[number]

// Ordered smallest → largest by total volume so stacks look right visually.
const REGIONS = [
  '~ SHUTTLE (PRE 2012)',
  'MEXICO',
  'PUERTO RICO + U.S. TERRITORIES',
  'TRANSPACIFIC',
  'CANADA',
  'CENTRAL AND SOUTH AMERICA',
  'CARIBBEAN + BERMUDA',
  'TRANSATLANTIC',
  'DOMESTIC',
  '~ INTERNATIONAL (2000 & 2001)',
] as const
type Region = typeof REGIONS[number]

const AIRPORT_COLORS: Record<Airport, string> = {
  EWR: '#636efa',
  JFK: '#EF553B',
  LGA: '#00cc96',
  SWF: '#ab63fa',
}

const MARKET_COLORS: Record<Market, string> = {
  Domestic:      '#636efa',
  International: '#EF553B',
}

const DIRECTION_COLORS: Record<Direction, string> = {
  Inbound:  '#636efa',
  Outbound: '#EF553B',
}

// Plotly's default qualitative palette, mapped to regions in the order above.
const REGION_COLORS: Record<Region, string> = {
  '~ SHUTTLE (PRE 2012)':           '#a5a5a5',
  'MEXICO':                         '#FECB52',
  'PUERTO RICO + U.S. TERRITORIES': '#FF97FF',
  'TRANSPACIFIC':                   '#B6E880',
  'CANADA':                         '#FF6692',
  'CENTRAL AND SOUTH AMERICA':      '#19d3f3',
  'CARIBBEAN + BERMUDA':            '#FFA15A',
  'TRANSATLANTIC':                  '#ab63fa',
  'DOMESTIC':                       '#636efa',
  '~ INTERNATIONAL (2000 & 2001)':  '#EF553B',
}

type FlightRow = {
  ym: number,
  airport: Airport,
  direction: Direction,
  market: Market,
  region: Region,
  pax_rev: number,
  pax_nonrev: number,
  flights: number,
}

const MODES = ['ground', 'passengers', 'flights'] as const
type Mode = typeof MODES[number]

const STACK_BYS = ['market', 'airport', 'region', 'direction'] as const
type StackBy = typeof STACK_BYS[number]

// --- URL state ---

const airportsParam = codesParam<Airport>([...AIRPORTS], { EWR: 'e', JFK: 'j', LGA: 'l', SWF: 's' })
const modeParam    = codeParam<Mode>('passengers', { ground: 'g', passengers: 'p', flights: 'f' })
const stackByParam = codeParam<StackBy>('market', { market: 'm', airport: 'a', region: 'r', direction: 'd' })

// --- Data hooks ---

function dvcUrl(name: string): string {
  const resolved = dvcResolve(name)
  return resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved
}

function useGroundData() {
  const url = dvcUrl('atd-ground.pqt')
  return useQuery({
    queryKey: ['atd-ground', url],
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url })
      const raw: Record<string, unknown>[] = []
      await parquetRead({ file, rowFormat: 'object', compressors, onComplete: data => raw.push(...data) })
      return raw
        .filter(r => r['timeframe'] === 'Monthly')
        .map(r => ({
          airport: r['airport'] as Airport,
          year: Number(r['year']),
          month: Number(r['month']),
          category: r['category'] as GroundCategory,
          value: Number(r['value']),
        } as GroundRow))
        .filter(r => AIRPORTS.includes(r.airport) && GROUND_CATEGORIES.includes(r.category))
    },
  })
}

function useFlightData() {
  const url = dvcUrl('atd-flights.pqt')
  return useQuery({
    queryKey: ['atd-flights', url],
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url })
      const raw: Record<string, unknown>[] = []
      await parquetRead({ file, rowFormat: 'object', compressors, onComplete: data => raw.push(...data) })
      return raw.map(r => ({
        ym: Number(r['ym']),
        airport: r['airport'] as Airport,
        direction: r['direction'] as Direction,
        market: r['market'] as Market,
        region: r['region'] as Region,
        pax_rev: Number(r['pax_rev']),
        pax_nonrev: Number(r['pax_nonrev']),
        flights: Number(r['flights']),
      } as FlightRow))
    },
  })
}

// --- Trace builders ---

function ymLabel(msFromEpoch: number): string {
  const d = new Date(msFromEpoch)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function buildGroundTraces(rows: GroundRow[], airport: Airport, windowYears = 5): Data[] {
  const filtered = rows.filter(r => r.airport === airport)
  if (!filtered.length) return []
  const maxYear = Math.max(...filtered.map(r => r.year))
  const minYear = Math.max(2011, maxYear - (windowYears - 1))
  const inWindow = filtered.filter(r => r.year >= minYear && r.year <= maxYear)
  const byCat = new Map<GroundCategory, { x: string[], y: number[] }>()
  for (const r of inWindow) {
    if (!byCat.has(r.category)) byCat.set(r.category, { x: [], y: [] })
    const e = byCat.get(r.category)!
    e.x.push(`${r.year}-${String(r.month).padStart(2, '0')}`)
    e.y.push(r.value)
  }
  const sortEntries = (e: { x: string[], y: number[] }) => {
    const zipped = e.x.map((x, i) => ({ x, y: e.y[i] }))
    zipped.sort((a, b) => a.x.localeCompare(b.x))
    return { x: zipped.map(z => z.x), y: zipped.map(z => z.y) }
  }
  return GROUND_CATEGORIES
    .filter(c => byCat.has(c))
    .map(cat => {
      const { x, y } = sortEntries(byCat.get(cat)!)
      return {
        type: 'bar' as const,
        name: cat,
        x, y,
        marker: { color: GROUND_COLORS[cat] },
        hovertemplate: '%{x}<br>%{fullData.name}: %{y:,}<extra></extra>',
      } as Data
    })
}

type FlightMetric = 'pax_rev' | 'flights'

function buildFlightTraces(
  rows: FlightRow[],
  airports: Airport[],
  stackBy: StackBy,
  metric: FlightMetric,
  windowYears = 5,
): Data[] {
  const airportSet = new Set(airports)
  const filtered = rows.filter(r => airportSet.has(r.airport))
  if (!filtered.length) return []

  // key = (ym, groupKey) → summed value.
  const keyOf = (r: FlightRow): string =>
    stackBy === 'market'    ? r.market
    : stackBy === 'airport' ? r.airport
    : stackBy === 'region'  ? r.region
    : r.direction

  const bucket = new Map<string, Map<string, number>>()
  for (const r of filtered) {
    const ym = ymLabel(r.ym)
    if (!bucket.has(ym)) bucket.set(ym, new Map())
    const inner = bucket.get(ym)!
    const k = keyOf(r)
    inner.set(k, (inner.get(k) ?? 0) + r[metric])
  }

  const xs = [...bucket.keys()].sort()
  const maxYm = xs[xs.length - 1]
  const minYear = Math.max(2000, Number(maxYm.slice(0, 4)) - (windowYears - 1))
  const inWindow = xs.filter(x => Number(x.slice(0, 4)) >= minYear)

  // Determine group order (stacking order) + colors per stack-by.
  const order: string[] =
    stackBy === 'market'    ? [...MARKETS]
    : stackBy === 'airport' ? [...AIRPORTS].filter(a => airportSet.has(a))
    : stackBy === 'region'  ? [...REGIONS]
    : [...DIRECTIONS]

  const colorOf: Record<string, string> =
    stackBy === 'market'    ? MARKET_COLORS
    : stackBy === 'airport' ? AIRPORT_COLORS
    : stackBy === 'region'  ? REGION_COLORS
    : DIRECTION_COLORS

  return order
    .filter(k => inWindow.some(x => (bucket.get(x)?.get(k) ?? 0) > 0))
    .map(k => ({
      type: 'bar' as const,
      name: k,
      x: inWindow,
      y: inWindow.map(x => bucket.get(x)?.get(k) ?? 0),
      marker: { color: colorOf[k] },
      hovertemplate: '%{x}<br>%{fullData.name}: %{y:,}<extra></extra>',
    } as Data))
}

// --- Component ---

const MODE_LABELS: Record<Mode, string> = {
  ground: 'Ground',
  passengers: 'Passengers',
  flights: 'Flights',
}

const STACKBY_LABELS: Record<StackBy, string> = {
  market: 'Market',
  airport: 'Airport',
  region: 'Region',
  direction: 'Direction',
}

export default function Airports() {
  const [airports, setAirports] = useUrlState<Airport[]>('a', airportsParam)
  const [mode,     setMode]     = useUrlState<Mode>('m', modeParam)
  const [stackBy,  setStackBy]  = useUrlState<StackBy>('s', stackByParam)

  const groundQ = useGroundData()
  const flightQ = useFlightData()

  // Ground mode: single-airport view (data doesn't roll up naturally across
  // airports). Fall back to first selected airport, or EWR.
  const groundAirport: Airport = airports[0] ?? 'EWR'

  const traces = useMemo<Data[]>(() => {
    if (mode === 'ground') {
      return buildGroundTraces(groundQ.data ?? [], groundAirport)
    }
    const metric: FlightMetric = mode === 'passengers' ? 'pax_rev' : 'flights'
    return buildFlightTraces(flightQ.data ?? [], airports, stackBy, metric)
  }, [mode, groundAirport, airports, stackBy, groundQ.data, flightQ.data])

  const isLoading = mode === 'ground' ? groundQ.isLoading : flightQ.isLoading

  const yAxisTitle =
    mode === 'ground'     ? 'Passengers / vehicles / cars'
    : mode === 'passengers' ? 'Revenue passengers'
    : 'Flights'

  const layout: Partial<Layout> = useMemo(() => ({
    barmode: 'stack',
    xaxis: { title: { text: 'Month' } },
    yaxis: { title: { text: yAxisTitle }, tickformat: '.2s' },
  }), [yAxisTitle])

  const subtitle = mode === 'ground'
    ? 'Monthly totals per category (Ground Transport + AirTrain)'
    : `Monthly ${mode === 'passengers' ? 'revenue passengers' : 'flights'}` +
      ` for ${airports.length === AIRPORTS.length ? 'all airports' : airports.join(' + ')}` +
      `, stacked by ${STACKBY_LABELS[stackBy].toLowerCase()} (inbound + outbound summed)`

  const title = mode === 'ground'
    ? `${groundAirport} — ${MODE_LABELS[mode]}`
    : `${airports.length === AIRPORTS.length ? 'All airports' : airports.join(' + ')} — ${MODE_LABELS[mode]}`

  return (
    <div style={{ padding: '1em', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ margin: '0.2em 0' }}>Airport Traffic (ATD)</h1>
      <p style={{ margin: '0.2em 0 1em', color: '#888' }}>
        From{' '}
        <a href="https://www.panynj.gov/airports/en/statistics-general-info.html"
           target="_blank" rel="noopener">PANYNJ ATD</a>.
        {' '}Ground: For-Hire Vehicles data available from Jan 2023.
      </p>
      <div style={{ display: 'flex', gap: '1em', alignItems: 'center', marginBottom: '1em', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: '0.4em', alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: '0.9em' }}>Mode</span>
          <ToggleButtonGroup exclusive value={mode} onChange={(_, v) => v && setMode(v)} size="small">
            {MODES.map(m => <ToggleButton key={m} value={m}>{MODE_LABELS[m]}</ToggleButton>)}
          </ToggleButtonGroup>
        </span>
        <span style={{ display: 'flex', gap: '0.4em', alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: '0.9em' }}>
            {mode === 'ground' ? 'Airport' : 'Airports'}
          </span>
          {mode === 'ground'
            ? <ToggleButtonGroup exclusive value={groundAirport} onChange={(_, v) => v && setAirports([v])} size="small">
                {AIRPORTS.map(a => <ToggleButton key={a} value={a}>{a}</ToggleButton>)}
              </ToggleButtonGroup>
            : <ToggleButtonGroup value={airports} onChange={(_, v) => v.length && setAirports(v)} size="small">
                {AIRPORTS.map(a => <ToggleButton key={a} value={a}>{a}</ToggleButton>)}
              </ToggleButtonGroup>}
        </span>
        {mode !== 'ground' && (
          <span style={{ display: 'flex', gap: '0.4em', alignItems: 'center' }}>
            <span style={{ color: '#888', fontSize: '0.9em' }}>Stack by</span>
            <ToggleButtonGroup exclusive value={stackBy} onChange={(_, v) => v && setStackBy(v)} size="small">
              {STACK_BYS.map(s => <ToggleButton key={s} value={s}>{STACKBY_LABELS[s]}</ToggleButton>)}
            </ToggleButtonGroup>
          </span>
        )}
      </div>
      {isLoading
        ? <div className="loading">Loading…</div>
        : <Plot id="atd" title={title} subtitle={subtitle} data={traces} layout={layout} />}
      <p style={{ marginTop: '1em' }}>
        <a href="/">← PATH ridership</a>
      </p>
    </div>
  )
}
