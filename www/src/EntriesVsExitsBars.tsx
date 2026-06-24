import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Data, Layout } from "plotly.js"
import { useUrlState } from "use-prms"
import { resolve as dvcResolve } from "virtual:dvc-data"

import { Plot, isDark } from "./plot-utils"
import { YmInput } from "./YmInput"
import { DAY_TYPES, DAY_TYPE_LABELS, dayTypesParam, type DayType } from "./dayTypes"

// EvE's data has 4 raw day-types (the picker only exposes 3 — weekend = sat+sun).
type RawDayType = 'weekday' | 'saturday' | 'sunday' | 'holiday'

type StationMonthRow = {
  name: string
  by_day_type: Record<RawDayType, { avg_entries: number, avg_exits: number }>
}

type MonthEntry = {
  days: Record<RawDayType, number>
  stations: StationMonthRow[]
}

type Payload = {
  all_yms: string[]
  months: Record<string, MonthEntry>
}

// Map a picker day-type to the underlying raw types it covers.
const PICKER_TO_RAW: Record<DayType, RawDayType[]> = {
  weekday: ['weekday'],
  weekend: ['saturday', 'sunday'],
  holiday: ['holiday'],
}

const ENTRY_GREEN = '#2e7d32'
const EXIT_ORANGE = '#ef6c00'
const RATIO_YELLOW = '#fbc02d'

const fmt = (n: number) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return `${n}`
}
const fmtInt = (n: number) => n.toLocaleString()

const chipBase: React.CSSProperties = {
  padding: '0.2em 0.6em',
  border: '1px solid #444',
  borderRadius: 999,
  fontSize: '0.85rem',
  cursor: 'pointer',
  userSelect: 'none',
  background: '#222',
  color: '#ccc',
  fontFamily: 'inherit',
}
const chipActive: React.CSSProperties = {
  ...chipBase,
  background: '#3a3a5a',
  color: '#e4e4e4',
  borderColor: '#666',
}

/** Mirror bars + gap line, with date-range + day-type filters and
 *  live system-wide totals. */
export default function EntriesVsExitsBars({ activeStations = [] }: {
  /** Page-level station filter. Empty/full set → all stations; non-empty
   *  subset → filter to those (single = pin). */
  activeStations?: string[]
} = {}) {
  // Translate canonical names ("Christopher Street") to our short form.
  const toShort = (s: string) => s === "Christopher Street" ? "Christopher St." : s
  // When the page-level filter is a strict subset, narrow EvE to those stations.
  const STATION_COUNT = 13  // total PATH stations
  const filterStations = activeStations.length > 0 && activeStations.length < STATION_COUNT
    ? activeStations.map(toShort)
    : null  // null = no filter, render all
  const { data } = useQuery<Payload>({
    queryKey: ['entries-vs-exits'],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => (await fetch(dvcResolve('entries_vs_exits.json'))).json(),
  })

  const allYms = data?.all_yms ?? []
  const [fromYm, setFromYm] = useState('')
  const [toYm, setToYm] = useState('')
  // Shared URL state with RidesPlot (param "d") — 3-value picker.
  const [activeDayTypes, setActiveDayTypes] = useUrlState<string[]>("d", dayTypesParam)

  // Initialize range to full span when data lands.
  useEffect(() => {
    if (allYms.length && !fromYm) setFromYm(allYms[0])
    if (allYms.length && !toYm) setToYm(allYms[allYms.length - 1])
  }, [allYms, fromYm, toYm])

  const agg = useMemo(() => {
    if (!data || !fromYm || !toYm) return null
    // Expand picker day-types to underlying raw day-types.
    const rawTypes: RawDayType[] = (activeDayTypes as DayType[]).flatMap(t => PICKER_TO_RAW[t] ?? [])
    const totalsByStation = new Map<string, { entries: number, exits: number }>()
    const totalDays: Record<RawDayType, number> = { weekday: 0, saturday: 0, sunday: 0, holiday: 0 }
    const selectedYms = data.all_yms.filter(ym => ym >= fromYm && ym <= toYm)
    for (const ym of selectedYms) {
      const m = data.months[ym]
      for (const dt of rawTypes) totalDays[dt] += m.days[dt]
      for (const s of m.stations) {
        const cur = totalsByStation.get(s.name) ?? { entries: 0, exits: 0 }
        for (const dt of rawTypes) {
          cur.entries += s.by_day_type[dt].avg_entries * m.days[dt]
          cur.exits += s.by_day_type[dt].avg_exits * m.days[dt]
        }
        totalsByStation.set(s.name, cur)
      }
    }
    const allStations = Array.from(totalsByStation.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => (b.entries + b.exits) - (a.entries + a.exits))
    // When the page-level filter is a strict subset, narrow EvE to those stations.
    const stations = filterStations
      ? allStations.filter(s => filterStations.includes(s.name))
      : allStations
    const sysEntries = stations.reduce((s, r) => s + r.entries, 0)
    const sysExits = stations.reduce((s, r) => s + r.exits, 0)
    return { stations, sysEntries, sysExits, totalDays, selectedYms }
  }, [data, fromYm, toYm, activeDayTypes, filterStations])

  const plot = useMemo(() => {
    if (!agg) return null
    const { stations } = agg
    const names = stations.map(s => s.name)
    const entries = stations.map(s => s.entries)
    const exits = stations.map(s => s.exits)
    // Negate so the line goes BELOW the x-axis when exits dominate (matches
    // the orange exit bars below 0). Positive = entries dominant (matches
    // the green entry bars above 0).
    const ratios = stations.map(s => s.entries > 0 ? 1 - s.exits / s.entries : 0)
    const pctLabels = ratios.map(r => `${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%`)

    const entriesTrace: Data = {
      type: 'bar',
      name: 'Entries',
      x: names,
      y: entries,
      marker: { color: ENTRY_GREEN },
      hovertemplate: '<b>%{x}</b><br>Entries: %{y:,}<extra></extra>',
    }

    const exitsTrace: Data = {
      type: 'bar',
      name: 'Exits',
      x: names,
      y: exits.map(e => -e),
      marker: { color: EXIT_ORANGE },
      customdata: exits,
      hovertemplate: '<b>%{x}</b><br>Exits: %{customdata:,}<extra></extra>',
    }

    const ratioTrace: Data = {
      type: 'scatter',
      name: '1 − exits/entries',
      x: names,
      y: ratios,
      yaxis: 'y2',
      mode: 'lines+markers+text' as any,
      line: { color: RATIO_YELLOW, width: 2 },
      marker: { color: RATIO_YELLOW, size: 8, line: { color: '#000', width: 1 } },
      text: pctLabels,
      textposition: 'top center',
      textfont: { color: RATIO_YELLOW, size: 11 },
      hovertemplate: '<b>%{x}</b><br>Exits/entries − 1: %{y:+.1%}<extra></extra>',
    }

    const maxAbs = Math.max(...entries, ...exits, 1) * 1.1
    // Symmetric y-axis tick set for "magnitude" reading on both sides.
    const tickStep = maxAbs > 5_000_000 ? 2_000_000 : maxAbs > 2_000_000 ? 1_000_000 : 500_000
    const tickvals: number[] = []
    for (let v = -Math.floor(maxAbs / tickStep) * tickStep; v <= maxAbs; v += tickStep) tickvals.push(v)
    const ticktext = tickvals.map(v => fmt(Math.abs(v)))

    const layout: Partial<Layout> = {
      barmode: 'overlay',
      xaxis: { title: { text: '' }, tickangle: -30 },
      yaxis: {
        title: { text: 'Riders (entries ↑ / exits ↓)' },
        range: [-maxAbs, maxAbs],
        tickvals,
        ticktext,
        zeroline: true,
        zerolinewidth: 1,
        zerolinecolor: isDark() ? '#888' : '#444',
      },
      yaxis2: {
        title: { text: '1 − exits/entries', font: { color: RATIO_YELLOW } },
        tickformat: '+.0%',
        tickfont: { color: RATIO_YELLOW },
        overlaying: 'y',
        side: 'right',
        range: [-0.6, 0.6],
        zeroline: false,
        showgrid: false,
      },
      legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.18, yanchor: 'top' },
      hovermode: 'x unified',
      margin: { l: 90, r: 90, t: 30, b: 100 },
    }
    return { data: [entriesTrace, exitsTrace, ratioTrace], layout }
  }, [agg])

  const sysSubtitle = useMemo(() => {
    if (!agg) return ' '
    const { sysEntries, sysExits, totalDays, selectedYms } = agg
    // Same convention as the y2 line: positive = entries dominate, negative
    // = exits dominate (matches the +/- sign of the bars above/below 0).
    const ratio = sysEntries > 0 ? 1 - sysExits / sysEntries : 0
    const totalDaysN = (Object.values(totalDays) as number[]).reduce((a, b) => a + b, 0)
    const SHORT: Record<RawDayType, string> = { weekday: 'wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'hol' }
    const dayBreakdown = (Object.entries(totalDays) as [RawDayType, number][])
      .filter(([, n]) => n > 0)
      .map(([dt, n]) => `${n} ${SHORT[dt]}`)
      .join(' + ')
    const range = selectedYms.length === 1 ? selectedYms[0] : `${selectedYms[0]} – ${selectedYms[selectedYms.length - 1]}`
    return (
      <span>
        <strong>{range}</strong> · {totalDaysN} days ({dayBreakdown}) · system:{' '}
        <strong>{fmtInt(sysEntries)}</strong> entries ·{' '}
        <strong>{fmtInt(sysExits)}</strong> exits · gap{' '}
        <strong style={{ color: RATIO_YELLOW }}>{`${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`}</strong>
      </span>
    )
  }, [agg])

  const toggleDayType = (dt: DayType) => {
    const has = activeDayTypes.includes(dt)
    const next = has ? activeDayTypes.filter(x => x !== dt) : [...activeDayTypes, dt]
    if (next.length === 0) return  // don't allow empty selection — would zero the plot
    setActiveDayTypes(next)
  }

  const controls = (
    <div style={{ display: 'flex', gap: '1em', alignItems: 'center', flexWrap: 'wrap', margin: '0.5em 0 0.8em' }}>
      {allYms.length > 0 && (
        <span>
          <YmInput value={fromYm} onChange={setFromYm} allYms={allYms} />
          {' – '}
          <YmInput value={toYm} onChange={setToYm} allYms={allYms} />
        </span>
      )}
      <span style={{ display: 'flex', gap: '0.4em' }} className="eve-day-chips">
        {DAY_TYPES.map(dt => {
          const active = activeDayTypes.includes(dt)
          return (
            <button
              key={dt}
              type="button"
              aria-pressed={active}
              style={active ? chipActive : chipBase}
              onClick={() => toggleDayType(dt as DayType)}
              title={`${active ? 'Hide' : 'Show'} ${DAY_TYPE_LABELS[dt as DayType]}s`}
            >
              {DAY_TYPE_LABELS[dt as DayType]}
            </button>
          )
        })}
      </span>
    </div>
  )

  return (
    <div className="plot-container">
      {controls}
      <Plot
        id="entries-vs-exits-bars"
        title="Faregate entries vs exits, by station"
        subtitle={sysSubtitle}
        data={plot?.data}
        layout={plot?.layout}
      />
    </div>
  )
}
