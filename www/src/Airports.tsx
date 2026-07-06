import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useMemo } from "react"
import { Data, Layout } from "plotly.js"
import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { codeParam, useUrlState } from "use-prms"
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

// The bulk CSV pre-aggregates to (ym, airport, direction, market, region). For
// the v1 airport view we sum across direction — inbound + outbound = total
// throughput, which is what PANYNJ reports as "activity".
const MARKETS = ['Domestic', 'International'] as const
type Market = typeof MARKETS[number]

const MARKET_COLORS: Record<Market, string> = {
  'Domestic':      '#636efa',
  'International': '#EF553B',
}

type FlightRow = { ym: number, airport: Airport, market: Market, pax_rev: number, pax_nonrev: number, flights: number }

const MODES = ['ground', 'passengers', 'flights'] as const
type Mode = typeof MODES[number]

// --- URL state + data hooks ---

const airportParam = codeParam<Airport>('EWR', { EWR: 'e', JFK: 'j', LGA: 'l', SWF: 's' })
const modeParam    = codeParam<Mode>('ground', { ground: 'g', passengers: 'p', flights: 'f' })

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
        market: r['market'] as Market,
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

function buildFlightTraces(
  rows: FlightRow[], airport: Airport, metric: 'pax' | 'flights', windowYears = 5,
): Data[] {
  const filtered = rows.filter(r => r.airport === airport)
  if (!filtered.length) return []
  // Sum inbound + outbound (both directions are in the parquet). Aggregate to
  // (ym, market).
  const bucket = new Map<string, Map<Market, number>>()
  for (const r of filtered) {
    const label = ymLabel(r.ym)
    if (!bucket.has(label)) bucket.set(label, new Map())
    const m = bucket.get(label)!
    const value = metric === 'pax' ? r.pax_rev : r.flights
    m.set(r.market, (m.get(r.market) ?? 0) + value)
  }
  const labels = [...bucket.keys()].sort()
  const maxYm = labels[labels.length - 1]
  const maxYear = Number(maxYm.slice(0, 4))
  const minYear = Math.max(2000, maxYear - (windowYears - 1))
  const inWindow = labels.filter(l => Number(l.slice(0, 4)) >= minYear)
  return MARKETS.map(mk => ({
    type: 'bar' as const,
    name: mk,
    x: inWindow,
    y: inWindow.map(l => bucket.get(l)?.get(mk) ?? 0),
    marker: { color: MARKET_COLORS[mk] },
    hovertemplate: '%{x}<br>%{fullData.name}: %{y:,}<extra></extra>',
  } as Data))
}

// --- Component ---

const MODE_LABELS: Record<Mode, string> = {
  ground: 'Ground',
  passengers: 'Passengers',
  flights: 'Flights',
}

export default function Airports() {
  const [airport, setAirport] = useUrlState<Airport>('a', airportParam)
  const [mode,    setMode]    = useUrlState<Mode>('m', modeParam)

  const groundQ = useGroundData()
  const flightQ = useFlightData()

  const traces = useMemo<Data[]>(() => {
    if (mode === 'ground')     return buildGroundTraces(groundQ.data ?? [], airport)
    if (mode === 'passengers') return buildFlightTraces(flightQ.data ?? [], airport, 'pax')
    if (mode === 'flights')    return buildFlightTraces(flightQ.data ?? [], airport, 'flights')
    return []
  }, [mode, airport, groundQ.data, flightQ.data])

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

  const subtitle =
    mode === 'ground'     ? 'Monthly totals per category (Ground Transport + AirTrain)'
    : mode === 'passengers' ? 'Monthly revenue passengers, Domestic + International (inbound + outbound)'
    : 'Monthly flight ops, Domestic + International (inbound + outbound)'

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
        <ToggleButtonGroup exclusive value={airport} onChange={(_, v) => v && setAirport(v)} size="small">
          {AIRPORTS.map(a => <ToggleButton key={a} value={a}>{a}</ToggleButton>)}
        </ToggleButtonGroup>
        <ToggleButtonGroup exclusive value={mode} onChange={(_, v) => v && setMode(v)} size="small">
          {MODES.map(m => <ToggleButton key={m} value={m}>{MODE_LABELS[m]}</ToggleButton>)}
        </ToggleButtonGroup>
      </div>
      {isLoading
        ? <div className="loading">Loading…</div>
        : <Plot
            id="atd"
            title={`${airport} — ${MODE_LABELS[mode]}`}
            subtitle={subtitle}
            data={traces}
            layout={layout}
          />}
      <p style={{ marginTop: '1em' }}>
        <a href="/">← PATH ridership</a>
      </p>
    </div>
  )
}
