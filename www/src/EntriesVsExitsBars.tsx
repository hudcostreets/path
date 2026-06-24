import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { Data, Layout } from "plotly.js"

import { Plot, isDark } from "./plot-utils"
import { YmInput } from "./YmInput"

const DAY_TYPES = ['weekday', 'saturday', 'sunday', 'holiday'] as const
type DayType = typeof DAY_TYPES[number]

const DAY_TYPE_LABELS: Record<DayType, string> = {
  weekday: 'Weekday',
  saturday: 'Saturday',
  sunday: 'Sunday',
  holiday: 'Holiday',
}

type StationMonthRow = {
  name: string
  by_day_type: Record<DayType, { avg_entries: number, avg_exits: number }>
}

type MonthEntry = {
  days: Record<DayType, number>
  stations: StationMonthRow[]
}

type Payload = {
  all_yms: string[]
  months: Record<string, MonthEntry>
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
  display: 'inline-block',
  padding: '0.2em 0.6em',
  border: '1px solid #444',
  borderRadius: 999,
  fontSize: '0.85rem',
  cursor: 'pointer',
  userSelect: 'none',
  background: '#222',
  color: '#ccc',
}
const chipActive: React.CSSProperties = {
  ...chipBase,
  background: '#3a3a5a',
  color: '#e4e4e4',
  borderColor: '#666',
}

/** Mirror bars + gap line, with date-range + day-type filters and
 *  live system-wide totals. */
export default function EntriesVsExitsBars() {
  const { data } = useQuery<Payload>({
    queryKey: ['entries-vs-exits'],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => (await fetch('/entries_vs_exits.json')).json(),
  })

  const allYms = data?.all_yms ?? []
  const [fromYm, setFromYm] = useState('')
  const [toYm, setToYm] = useState('')
  const [activeDayTypes, setActiveDayTypes] = useState<DayType[]>([...DAY_TYPES])

  // Initialize range to full span when data lands.
  useEffect(() => {
    if (allYms.length && !fromYm) setFromYm(allYms[0])
    if (allYms.length && !toYm) setToYm(allYms[allYms.length - 1])
  }, [allYms, fromYm, toYm])

  const agg = useMemo(() => {
    if (!data || !fromYm || !toYm) return null
    // Sum entries/exits across selected months + selected day-types.
    const totalsByStation = new Map<string, { entries: number, exits: number }>()
    const totalDays: Record<DayType, number> = { weekday: 0, saturday: 0, sunday: 0, holiday: 0 }
    const selectedYms = data.all_yms.filter(ym => ym >= fromYm && ym <= toYm)
    for (const ym of selectedYms) {
      const m = data.months[ym]
      for (const dt of activeDayTypes) totalDays[dt] += m.days[dt]
      for (const s of m.stations) {
        const cur = totalsByStation.get(s.name) ?? { entries: 0, exits: 0 }
        for (const dt of activeDayTypes) {
          cur.entries += s.by_day_type[dt].avg_entries * m.days[dt]
          cur.exits += s.by_day_type[dt].avg_exits * m.days[dt]
        }
        totalsByStation.set(s.name, cur)
      }
    }
    const stations = Array.from(totalsByStation.entries())
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => (b.entries + b.exits) - (a.entries + a.exits))
    const sysEntries = stations.reduce((s, r) => s + r.entries, 0)
    const sysExits = stations.reduce((s, r) => s + r.exits, 0)
    return { stations, sysEntries, sysExits, totalDays, selectedYms }
  }, [data, fromYm, toYm, activeDayTypes])

  const plot = useMemo(() => {
    if (!agg) return null
    const { stations } = agg
    const names = stations.map(s => s.name)
    const entries = stations.map(s => s.entries)
    const exits = stations.map(s => s.exits)
    const ratios = stations.map(s => s.entries > 0 ? s.exits / s.entries - 1 : 0)
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
      name: 'Exits / entries − 1',
      x: names,
      y: ratios,
      yaxis: 'y2',
      mode: 'lines+markers+text',
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
        title: { text: 'Exits / entries − 1', font: { color: RATIO_YELLOW } },
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
    const ratio = sysEntries > 0 ? sysExits / sysEntries - 1 : 0
    const totalDaysN = (Object.values(totalDays) as number[]).reduce((a, b) => a + b, 0)
    const SHORT: Record<DayType, string> = { weekday: 'wkdy', saturday: 'Sat', sunday: 'Sun', holiday: 'hol' }
    const dayBreakdown = (Object.entries(totalDays) as [DayType, number][])
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
    setActiveDayTypes(prev => {
      const has = prev.includes(dt)
      const next = has ? prev.filter(x => x !== dt) : [...prev, dt]
      // Don't allow empty selection — would zero the plot.
      return next.length === 0 ? prev : next
    })
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
      <span style={{ display: 'flex', gap: '0.4em' }}>
        {DAY_TYPES.map(dt => (
          <span
            key={dt}
            style={activeDayTypes.includes(dt) ? chipActive : chipBase}
            onClick={() => toggleDayType(dt)}
            title={`${activeDayTypes.includes(dt) ? 'Hide' : 'Show'} ${DAY_TYPE_LABELS[dt]}s`}
          >
            {DAY_TYPE_LABELS[dt]}
          </span>
        ))}
      </span>
    </div>
  )

  return (
    <>
      {controls}
      <Plot
        id="entries-vs-exits-bars"
        title="Faregate entries vs exits, by station"
        subtitle={sysSubtitle}
        data={plot?.data}
        layout={plot?.layout}
      />
    </>
  )
}
