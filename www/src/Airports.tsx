import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useMemo } from "react"
import { Data, Layout } from "plotly.js"
import { Plot as PltlyPlot } from "pltly/react"
import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { codeParam, useUrlState } from "use-prms"
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { compressors } from "./parquet-compressors"
import { isDark, useDark } from "./plot-utils"

const AIRPORTS = ['EWR', 'JFK', 'LGA', 'SWF'] as const
type Airport = typeof AIRPORTS[number]

// Stacking order: smallest → largest average, so the biggest sits on top of
// the stack (visually similar to `/bt`'s vehicle-type stacking).
const CATEGORIES = [
  'Coach Bus Pax',
  'For-Hire Vehicles',
  'Taxi Dispatched',
  'Parked Cars',
  'Paid-Hwrd Beach',
  'Paid-Jamaica',
  'Paid-EWR',
  'Unpaid-On Airport',
] as const
type Category = typeof CATEGORIES[number]

// Roughly matches Plotly's default qualitative palette so the chart looks at
// home next to the other pages.
const CATEGORY_COLORS: Record<Category, string> = {
  'Coach Bus Pax':     '#636efa',
  'For-Hire Vehicles': '#EF553B',
  'Taxi Dispatched':   '#00cc96',
  'Parked Cars':       '#ab63fa',
  'Paid-Hwrd Beach':   '#FFA15A',
  'Paid-Jamaica':      '#19d3f3',
  'Paid-EWR':          '#FF6692',
  'Unpaid-On Airport': '#B6E880',
}

type Row = { airport: Airport, year: number, month: number, category: Category, value: number }

function dataUrl(): string {
  const resolved = dvcResolve('atd-ground.pqt')
  return resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved
}

function useAtdData() {
  const url = dataUrl()
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
          category: r['category'] as Category,
          value: Number(r['value']),
        } as Row))
        .filter(r => AIRPORTS.includes(r.airport) && CATEGORIES.includes(r.category))
    },
  })
}

const airportParam = codeParam<Airport>('EWR', { EWR: 'e', JFK: 'j', LGA: 'l', SWF: 's' })

export default function Airports() {
  const dark = useDark()
  const [airport, setAirport] = useUrlState<Airport>('a', airportParam)
  const { data: rows = [], isLoading } = useAtdData()

  const filtered = useMemo(() => rows.filter(r => r.airport === airport), [rows, airport])

  const yearRange = useMemo(() => {
    if (!filtered.length) return null
    const maxYear = Math.max(...filtered.map(r => r.year))
    const minYear = Math.max(2011, maxYear - 4)  // last ~5 years by default
    return [minYear, maxYear] as const
  }, [filtered])

  const traces: Data[] = useMemo(() => {
    if (!yearRange) return []
    const [minY, maxY] = yearRange
    const windowRows = filtered.filter(r => r.year >= minY && r.year <= maxY)
    // Build one trace per category with per-month x/y series.
    const byCat = new Map<Category, { x: string[], y: number[] }>()
    for (const r of windowRows) {
      if (!byCat.has(r.category)) byCat.set(r.category, { x: [], y: [] })
      byCat.get(r.category)!.x.push(`${r.year}-${String(r.month).padStart(2, '0')}`)
      byCat.get(r.category)!.y.push(r.value)
    }
    // Sort each series by month for consistent bar order.
    const sortEntries = (e: { x: string[], y: number[] }) => {
      const zipped = e.x.map((x, i) => ({ x, y: e.y[i] }))
      zipped.sort((a, b) => a.x.localeCompare(b.x))
      return { x: zipped.map(z => z.x), y: zipped.map(z => z.y) }
    }
    return CATEGORIES
      .filter(c => byCat.has(c))
      .map(cat => {
        const { x, y } = sortEntries(byCat.get(cat)!)
        return {
          type: 'bar' as const,
          name: cat,
          x, y,
          marker: { color: CATEGORY_COLORS[cat] },
          hovertemplate: '%{x}<br>%{fullData.name}: %{y:,}<extra></extra>',
        } as Data
      })
  }, [filtered, yearRange])

  const layout: Partial<Layout> = useMemo(() => ({
    barmode: 'stack',
    title: {
      text: `${airport} — Airport Traffic Dashboard (Ground Transport + AirTrain)`,
      font: { color: isDark(dark) ? '#e4e4e4' : undefined },
    },
    xaxis: { title: { text: 'Month' } },
    yaxis: { title: { text: 'Passengers / vehicles / cars' }, tickformat: '.2s' },
    legend: { orientation: 'h', y: -0.15 },
    margin: { l: 60, r: 20, t: 60, b: 80 },
    hovermode: 'x unified',
  }), [airport, dark])

  return (
    <div style={{ padding: '1em', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ margin: '0.2em 0' }}>Airport Traffic (ATD) — Ground Transport</h1>
      <p style={{ margin: '0.2em 0 1em', color: '#888' }}>
        Monthly totals per category, from{' '}
        <a href="https://www.panynj.gov/airports/en/statistics-general-info.html"
           target="_blank" rel="noopener">PANYNJ ATD</a>.
        {' '}For-Hire Vehicles data available from Jan 2023.
      </p>
      <ToggleButtonGroup
        exclusive
        value={airport}
        onChange={(_, v) => v && setAirport(v)}
        size="small"
        sx={{ marginBottom: '1em' }}
      >
        {AIRPORTS.map(a => (
          <ToggleButton key={a} value={a}>{a}</ToggleButton>
        ))}
      </ToggleButtonGroup>
      {isLoading
        ? <div className="loading">Loading…</div>
        : <PltlyPlot data={traces} layout={layout} style={{ width: '100%', height: 500 }} />}
      <p style={{ marginTop: '1em' }}>
        <a href="/">← PATH ridership</a>
      </p>
    </div>
  )
}
