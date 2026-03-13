import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import ReactJsonView from '@microlink/react-json-view'
import { Arr } from "@rdub/base/arr"
import { round } from "@rdub/base/math"
import { useDb } from "@rdub/duckdb-wasm/duckdb"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import { Float64, Utf8 } from 'apache-arrow'
import { Data, Layout, Legend } from "plotly.js"
import { useActions } from "use-kbd"
import { useUrlState, codeParam, codesParam } from "use-prms"
import { Plot, ann, hovertemplate, hovertemplatePct, url } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"

type Row = {
  month: Utf8
  station: Utf8
  avg_weekday: Float64
  avg_weekend: Float64
}

const STATIONS = [
  "Christopher Street",
  "9th Street",
  "14th Street",
  "23rd Street",
  "33rd Street",
  "WTC",
  "Newark",
  "Harrison",
  "Journal Square",
  "Grove Street",
  "Exchange Place",
  "Newport",
  "Hoboken",
] as const

const STATION_COLORS: Record<string, string> = {
  "Christopher Street": "#636efa",
  "9th Street": "#EF553B",
  "14th Street": "#00cc96",
  "23rd Street": "#ab63fa",
  "33rd Street": "#FFA15A",
  "WTC": "#19d3f3",
  "Newark": "#FF6692",
  "Harrison": "#B6E880",
  "Journal Square": "#FF97FF",
  "Grove Street": "#FECB52",
  "Exchange Place": "#636efa",
  "Newport": "#EF553B",
  "Hoboken": "#00cc96",
}

// Station groups by state
const NY_STATIONS = ["Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street", "WTC"] as const
const NJ_STATIONS = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken"] as const

// Station groups by line
const NWK_WTC = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "WTC"] as const
const JSQ_33 = ["Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_33 = ["Hoboken", "Christopher Street", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_WTC = ["Hoboken", "Newport", "Exchange Place", "WTC"] as const

type DayType = "weekday" | "weekend"
type Mode = "rides" | "vs2019"
type TimeRange = "all" | "recent"

const modeParam = codeParam<Mode>("rides", { rides: "r", vs2019: "v" })
const dayTypeParam = codeParam<DayType>("weekday", { weekday: "w", weekend: "e" })
const timeRangeParam = codeParam<TimeRange>("all", { all: "a", recent: "p" })
const stationsParam = codesParam<string>(
  [...STATIONS],
  {
    "Christopher Street": "c",
    "9th Street": "9",
    "14th Street": "1",
    "23rd Street": "2",
    "33rd Street": "3",
    "WTC": "w",
    "Newark": "n",
    "Harrison": "h",
    "Journal Square": "j",
    "Grove Street": "g",
    "Exchange Place": "x",
    "Newport": "p",
    "Hoboken": "o",
  },
)

type StationData = {
  months: Date[]
  weekday: number[]
  weekend: number[]
}

type ProcessedData = {
  stations: Map<string, StationData>
  aggregate: StationData
  pcts2019: { week: number, wknd: number }[]
  idxs2019: number[]
  monthsFrom2020: Date[]
  pcts2019From2020: { week: number, wknd: number }[]
}

function processData(rows: { month: string, station: string, avg_weekday: number, avg_weekend: number }[]): ProcessedData {
  const stationMap = new Map<string, { months: string[], weekday: number[], weekend: number[] }>()
  for (const row of rows) {
    let entry = stationMap.get(row.station)
    if (!entry) {
      entry = { months: [], weekday: [], weekend: [] }
      stationMap.set(row.station, entry)
    }
    entry.months.push(row.month)
    entry.weekday.push(row.avg_weekday)
    entry.weekend.push(row.avg_weekend)
  }

  // Build aggregate by summing across stations per month
  const monthOrder: string[] = []
  const aggWeekday: number[] = []
  const aggWeekend: number[] = []
  const monthSums = new Map<string, { weekday: number, weekend: number }>()
  for (const row of rows) {
    let sums = monthSums.get(row.month)
    if (!sums) {
      sums = { weekday: 0, weekend: 0 }
      monthSums.set(row.month, sums)
      monthOrder.push(row.month)
    }
    sums.weekday += row.avg_weekday
    sums.weekend += row.avg_weekend
  }
  for (const m of monthOrder) {
    const sums = monthSums.get(m)!
    aggWeekday.push(sums.weekday)
    aggWeekend.push(sums.weekend)
  }

  const parseMonth = (m: string): Date => {
    const [yr, mo] = /^(\d{4})-(\d{2})$/.exec(m)!.slice(1, 3).map(i => parseInt(i))
    return new Date(yr, mo - 1, 1)
  }

  const months = monthOrder.map(parseMonth)
  const stations = new Map<string, StationData>()
  for (const [name, data] of stationMap) {
    stations.set(name, {
      months: data.months.map(parseMonth),
      weekday: data.weekday,
      weekend: data.weekend,
    })
  }

  // Compute vs-2019 percentages
  const idxs2019 = months
    .map((m, idx) => [m, idx] as [Date, number])
    .filter(([m]) => m.getFullYear() === 2019)
    .map(([, idx]) => idx)

  const pcts2019 = months.map((m, idx) => {
    const mo = m.getMonth()
    const week = aggWeekday[idx] / aggWeekday[idxs2019[mo]]
    const wknd = aggWeekend[idx] / aggWeekend[idxs2019[mo]]
    return { week, wknd }
  })

  const idx2020 = idxs2019[11] + 1
  const monthsFrom2020 = months.slice(idx2020)
  const pcts2019From2020 = pcts2019.slice(idx2020)

  return {
    stations,
    aggregate: { months, weekday: aggWeekday, weekend: aggWeekend },
    pcts2019,
    idxs2019,
    monthsFrom2020,
    pcts2019From2020,
  }
}

export default function RidesPlot() {
  const [mode, setMode] = useUrlState<Mode>("m", modeParam)
  const [dayType, setDayType] = useUrlState<DayType>("d", dayTypeParam)
  const [timeRange, setTimeRange] = useUrlState<TimeRange>("t", timeRangeParam)
  const [selectedStations, setSelectedStations] = useUrlState<string[]>("s", stationsParam)
  const dbConn = useDb()

  const selectGroup = useCallback((group: readonly string[]) => {
    setSelectedStations([...group])
    setMode("rides")
  }, [setSelectedStations, setMode])

  useActions({
    'stations:all': {
      label: 'All stations',
      group: 'Stations',
      defaultBindings: ['s a'],
      handler: () => setSelectedStations([...STATIONS]),
    },
    'stations:none': {
      label: 'No stations (aggregate)',
      group: 'Stations',
      defaultBindings: ['s 0'],
      handler: () => setSelectedStations([]),
    },
    'stations:ny': {
      label: 'New York stations',
      group: 'Stations',
      keywords: ['manhattan'],
      defaultBindings: ['s y'],
      handler: () => selectGroup(NY_STATIONS),
    },
    'stations:nj': {
      label: 'New Jersey stations',
      group: 'Stations',
      keywords: ['jersey city', 'hoboken', 'newark'],
      defaultBindings: ['s j'],
      handler: () => selectGroup(NJ_STATIONS),
    },
    'stations:nwk-wtc': {
      label: 'NWK–WTC line',
      group: 'Stations',
      keywords: ['newark', 'world trade center'],
      defaultBindings: ['s n'],
      handler: () => selectGroup(NWK_WTC),
    },
    'stations:jsq-33': {
      label: 'JSQ–33 line',
      group: 'Stations',
      keywords: ['journal square', '33rd'],
      defaultBindings: ['s q'],
      handler: () => selectGroup(JSQ_33),
    },
    'stations:hob-33': {
      label: 'HOB–33 line',
      group: 'Stations',
      keywords: ['hoboken', '33rd'],
      defaultBindings: ['s h'],
      handler: () => selectGroup(HOB_33),
    },
    'stations:hob-wtc': {
      label: 'HOB–WTC line',
      group: 'Stations',
      keywords: ['hoboken', 'world trade center'],
      defaultBindings: ['s w'],
      handler: () => selectGroup(HOB_WTC),
    },
    'mode:weekday': {
      label: 'Weekday',
      group: 'Controls',
      defaultBindings: ['d w'],
      handler: () => setDayType("weekday"),
    },
    'mode:weekend': {
      label: 'Weekend',
      group: 'Controls',
      defaultBindings: ['d e'],
      handler: () => setDayType("weekend"),
    },
    'mode:rides': {
      label: 'Rides mode',
      group: 'Controls',
      defaultBindings: ['m r'],
      handler: () => setMode("rides"),
    },
    'mode:vs2019': {
      label: 'vs. 2019 mode',
      group: 'Controls',
      defaultBindings: ['m v'],
      handler: () => setMode("vs2019"),
    },
    'time:all': {
      label: 'All time',
      group: 'Controls',
      defaultBindings: ['t a'],
      handler: () => setTimeRange("all"),
    },
    'time:recent': {
      label: '2020–Present',
      group: 'Controls',
      defaultBindings: ['t r'],
      handler: () => setTimeRange("recent"),
    },
  })

  const { data: processed, isError, error } = useQuery({
    queryKey: ['rides', url, dbConn === null],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => {
      if (!dbConn) return null
      const { conn } = dbConn
      const query = `
        SELECT station, month, "avg weekday" as avg_weekday, "avg weekend" as avg_weekend
        FROM parquet_scan('${url}')
        ORDER BY month, station
      `
      const table = await conn.query<Row>(query)
      const n = table.numRows
      const monthCol: string[] = Arr(table.getChild("month")!.toArray()) as any
      const stationCol: string[] = Arr(table.getChild("station")!.toArray()) as any
      const weekdayCol = Arr(table.getChild("avg_weekday")!.toArray())
      const weekendCol = Arr(table.getChild("avg_weekend")!.toArray())
      const rows: { month: string, station: string, avg_weekday: number, avg_weekend: number }[] = []
      for (let i = 0; i < n; i++) {
        rows.push({
          month: monthCol[i],
          station: stationCol[i],
          avg_weekday: weekdayCol[i],
          avg_weekend: weekendCol[i],
        })
      }
      conn.close()
      return processData(rows)
    },
  })

  const showStationBars = mode === "rides" && selectedStations.length > 0
  const isVs2019 = mode === "vs2019"

  const plotProps = useMemo(() => {
    if (!processed) return {}
    const { aggregate, stations, pcts2019From2020, monthsFrom2020 } = processed
    const { months, weekday: aggWeekday, weekend: aggWeekend } = aggregate
    const n = months.length

    if (isVs2019) {
      // vs. 2019 percentage lines
      const lastPcts = pcts2019From2020[pcts2019From2020.length - 1]
      let lastMoStr = months[n - 1].toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      lastMoStr = `${lastMoStr.substring(0, lastMoStr.length - 2)}'${lastMoStr.substring(lastMoStr.length - 2)}`
      const axo = 5, ayo = .15
      return {
        data: [
          {
            name: "Avg Weekday (% of 2019)",
            x: monthsFrom2020,
            y: pcts2019From2020.map(p => p.week),
            line: { color: '#ef4444' },
            hovertemplate: hovertemplatePct,
          },
          {
            name: "Avg Weekend (% of 2019)",
            x: monthsFrom2020,
            y: pcts2019From2020.map(p => p.wknd),
            line: { color: '#3b82f6' },
            hovertemplate: hovertemplatePct,
          },
        ] as Data[],
        layout: {
          xaxis: {
            dtick: window.innerWidth < 600 ? "M6" : "M3",
            tickformat: "%b '%y",
            tickangle: -45,
            range: [monthsFrom2020[0], monthsFrom2020[monthsFrom2020.length - 1]],
          },
          yaxis: {
            dtick: 0.1,
            tickformat: ',.0%',
          },
          legend: {
            yanchor: "bottom" as const, y: 0.03,
            xanchor: "right" as const, x: 0.99,
          },
          annotations: [
            ann({
              ax: months[n - axo], ay: lastPcts.week - ayo,
              yanchor: "top",
              text: `${lastMoStr}<br>${round(lastPcts.week * 1000) / 10}%`,
              x: months[n - 1],
              y: lastPcts.week,
            }),
            ann({
              ax: months[n - axo], ay: lastPcts.wknd + ayo / 2,
              yanchor: "bottom",
              text: `${lastMoStr}<br>${round(lastPcts.wknd * 1000) / 10}%`,
              x: months[n - 1],
              y: lastPcts.wknd,
            }),
          ],
          shapes: [{
            type: 'line' as const,
            xref: 'paper' as const,
            x0: 0, y0: 1, x1: 1, y1: 1,
            line: { color: '#777', width: 1 },
          }],
        } as Partial<Layout>,
      }
    }

    if (showStationBars) {
      // Stacked bar chart by station
      const isRecent = timeRange === "recent"
      const col = dayType === "weekday" ? "weekday" : "weekend"
      const data: Data[] = selectedStations.map(station => {
        const sd = stations.get(station)
        if (!sd) return null
        return {
          name: station,
          type: "bar",
          x: sd.months,
          y: sd[col],
          marker: { color: STATION_COLORS[station] },
          hovertemplate,
        } as Data
      }).filter((d): d is Data => d !== null)
      const allTimeRange = ['2011-12-17', '2025-12-17']
      const recentRange = ['2019-12-17', '2025-12-17']
      return {
        data,
        layout: {
          barmode: "relative",
          xaxis: {
            range: isRecent ? recentRange : allTimeRange,
            dtick: isRecent ? "M3" : "M12",
            tickformat: isRecent ? "%b '%y" : "'%y",
            hoverformat: "%b '%y",
            tickangle: -45,
          },
          yaxis: {
            hoverformat: ",.0f",
          },
          legend: { entrywidth: 100 } as Partial<Legend>,
        } as Partial<Layout>,
      }
    }

    // Aggregate lines (no stations selected)
    let lastMoStr = months[n - 1].toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    lastMoStr = `${lastMoStr.substring(0, lastMoStr.length - 2)}'${lastMoStr.substring(lastMoStr.length - 2)}`
    const isRecent = timeRange === "recent"
    let axo = 13, ayo = 50_000
    return {
      data: [
        {
          name: "Avg Weekday",
          x: months, y: aggWeekday,
          line: { color: '#ef4444' },
          hovertemplate,
        },
        {
          name: "Avg Weekend",
          x: months, y: aggWeekend,
          line: { color: '#3b82f6' },
          hovertemplate,
        },
      ] as Data[],
      layout: {
        xaxis: {
          dtick: isRecent ? "M3" : "M12",
          tickformat: isRecent ? "%b '%y" : "'%y",
          hoverformat: "%b '%y",
          tickangle: -45,
          ...(isRecent ? { range: ['2019-12-17', '2025-12-17'] } : {}),
        },
        legend: {
          yanchor: "top" as const, y: 0.99,
          xanchor: "right" as const, x: 0.99,
        },
        annotations: [
          ann({
            ax: months[n - axo], ay: aggWeekday[n - 1] + ayo / 2,
            yanchor: "bottom",
            text: `${lastMoStr}<br>${round(aggWeekday[n - 1]).toLocaleString()}`,
            x: months[n - 1],
            y: aggWeekday[n - 1],
          }),
          ann({
            ax: months[n - axo], ay: aggWeekend[n - 1] - ayo,
            yanchor: "top",
            text: `${lastMoStr}<br>${round(aggWeekend[n - 1]).toLocaleString()}`,
            x: months[n - 1],
            y: aggWeekend[n - 1],
          }),
        ],
      } as Partial<Layout>,
    }
  }, [processed, mode, dayType, timeRange, selectedStations, showStationBars, isVs2019])

  const title = isVs2019
    ? "Avg PATH rides per day (vs. 2019)"
    : showStationBars
      ? `Average ${dayType} PATH ridership by station`
      : "Avg PATH rides per day"

  return (
    <div className="plot-container">
      {isError ? <div className="error">Error: {error?.toString()}</div> : null}
      <Plot
        id="rides"
        title={title}
        soloMode={showStationBars ? "hide" : undefined}
        {...plotProps}
      />
      <div className="plot-toggles">
        {!isVs2019 && (
          <ToggleButtonGroup
            value={dayType}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setDayType(v) }}
          >
            <ToggleButton value="weekday">Weekday</ToggleButton>
            <ToggleButton value="weekend">Weekend</ToggleButton>
          </ToggleButtonGroup>
        )}
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setMode(v) }}
        >
          <ToggleButton value="rides">Rides</ToggleButton>
          <ToggleButton value="vs2019">vs. 2019</ToggleButton>
        </ToggleButtonGroup>
        {!isVs2019 && (
          <ToggleButtonGroup
            value={timeRange}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setTimeRange(v) }}
          >
            <ToggleButton value="all">All Time</ToggleButton>
            <ToggleButton value="recent">2020–Present</ToggleButton>
          </ToggleButtonGroup>
        )}
        <StationDropdown
          stations={[...STATIONS]}
          colors={STATION_COLORS}
          selected={selectedStations}
          onChange={setSelectedStations}
          disabled={isVs2019}
        />
      </div>
      {isVs2019 && <p>Weekend ridership has surpassed pre-COVID levels, though service remains degraded.</p>}
      <hr/>
      <div>
        {processed ?
          <details>
            <summary>Plot data</summary>
            <ReactJsonView
              src={processed}
              displayDataTypes={false}
              displayArrayKey={true}
              name={false}
              displayObjectSize
              enableClipboard
              quotesOnKeys={false}
            />
          </details>
          : null
        }
      </div>
    </div>
  )
}
