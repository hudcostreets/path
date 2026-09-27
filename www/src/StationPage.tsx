import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { Data, Layout } from "plotly.js"
import { type CSSProperties, useEffect, useMemo } from "react"
import { Link, Navigate, useLocation, useParams } from "react-router-dom"
import { codeParam, useUrlState } from "use-prms"
import { DAY_TYPES, DAY_TYPE_COLORS, DAY_TYPE_LABELS, dayTypesParam } from "./dayTypes"
import HourlyPlot from "./HourlyPlot"
import MonthlyPlots from "./MonthlyPlots"
import { Plot, url as allPqtUrl } from "./plot-utils"
import {
  DEFAULT_EXCLUSIONS,
  buildByDayType,
  computeBaselines,
  sumAcrossDayTypes,
  useRidesData,
  type ProcessedData,
  type StationBaseline,
  type TimeRange,
} from "./RidesPlot"
import { StationDropdown } from "./StationDropdown"
import { StationIndex } from "./StationIndex"
import {
  STATIONS,
  STATION_CODES,
  STATION_COLORS,
  resolveSlug,
  stationInfo,
  stationLines,
  stationPath,
  type StationInfo,
} from "./stations"
import { InfoTip } from "./Tooltip"
import "./StationPage.scss"

const { round } = Math

type RidesMetric = "avg" | "total"
const metricParam = codeParam<RidesMetric>("avg", { avg: "a", total: "t" })
const timeRangeParam = codeParam<TimeRange>("all", { all: "a", recent: "p" })

/** Same baseline as the homepage's default "Recovery" view: 2017–19 avg,
 *  minus known-anomalous station-months (Christopher St weekend closures). */
const BASELINE_YEARS = 3
const BASELINE_LABEL = "2017–19"

const NUM_STATIONS = STATIONS.length

/** 7,123,456 → "7.1M"; 21,345 → "21.3k"; 812 → "812". */
function fmtShort(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return String(round(n))
}

function fmtMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/** `/station/:slug` route: canonical slug → page; alias (e.g. `jsq`,
 *  `world-trade-center`, mixed case) → redirect; unknown → not-found + index. */
export default function StationPage() {
  const { slug = '' } = useParams()
  const { search } = useLocation()
  const { info, redirect } = resolveSlug(slug)
  if (redirect) return <Navigate to={`/station/${redirect}${search}`} replace />
  if (!info) return <StationNotFound slug={slug} />
  return <StationView key={info.station} info={info} />
}

function StationNotFound({ slug }: { slug: string }) {
  useEffect(() => {
    const prev = document.title
    document.title = `Unknown station – PATH Ridership`
    return () => { document.title = prev }
  }, [])
  return (
    <div className="station-page">
      <Breadcrumb />
      <h1>Unknown station</h1>
      <p><code>{slug}</code> isn't a PATH station. Pick one:</p>
      <StationIndex title="" />
    </div>
  )
}

function Breadcrumb({ title }: { title?: string }) {
  return (
    <nav className="station-breadcrumb" aria-label="Breadcrumb">
      <Link to="/">PATH ridership</Link>
      {' / '}
      <Link to="/station">Stations</Link>
      {title && <>{' / '}<span>{title}</span></>}
    </nav>
  )
}

/** `/station` (no slug): the station index on its own. */
export function StationsIndexPage() {
  useEffect(() => {
    const prev = document.title
    document.title = `PATH stations – PATH Ridership`
    return () => { document.title = prev }
  }, [])
  return (
    <div className="station-page">
      <Breadcrumb />
      <h1>PATH stations</h1>
      <p>Per-station ridership history, recovery vs. {BASELINE_LABEL}, rank among the {NUM_STATIONS} stations, and hourly profiles.</p>
      <StationIndex title="" />
    </div>
  )
}

type Summary = {
  lastMonth: Date
  /** Trailing-12-month total rides (all day types). */
  total12: number
  /** Trailing-12-month mean of avg weekday rides/day. */
  avgWeekday12: number
  /** Trailing-12-month total as a fraction of the same months' baseline. */
  pctBaseline: number
  /** 1-based rank among all stations by trailing-12-month total. */
  rank: number
  /** Fraction of the system-wide trailing-12-month total. */
  share: number
}

const ALL_DAY_TYPES = [...DAY_TYPES] as string[]

function summarize(processed: ProcessedData, baselines: Map<string, StationBaseline>, station: string): Summary | null {
  const sd = processed.stations.get(station)
  const bl = baselines.get(station)
  if (!sd || !bl) return null
  const n = sd.months.length
  const idxs = Array.from({ length: 12 }, (_, i) => n - 12 + i).filter(i => i >= 0)
  const total12Of = (s: string) => {
    const d = processed.stations.get(s)
    if (!d) return 0
    let sum = 0
    for (const i of idxs) sum += sumAcrossDayTypes(d, "total", ALL_DAY_TYPES, i)
    return sum
  }
  const totals = new Map((STATIONS as readonly string[]).map(s => [s, total12Of(s)]))
  const total12 = totals.get(station)!
  let base = 0
  for (const i of idxs) {
    const mo = sd.months[i].getMonth()
    base += bl.total_weekday[mo] + bl.total_weekend[mo] + bl.total_holiday[mo]
  }
  const systemTotal = [...totals.values()].reduce((a, b) => a + b, 0)
  return {
    lastMonth: sd.months[n - 1],
    total12,
    avgWeekday12: idxs.reduce((a, i) => a + sd.avg_weekday[i], 0) / idxs.length,
    pctBaseline: base > 0 ? total12 / base : NaN,
    rank: 1 + [...totals.values()].filter(v => v > total12).length,
    share: systemTotal > 0 ? total12 / systemTotal : NaN,
  }
}

/** Monthly rank (1 = busiest) of `station` among all stations, by total rides
 *  summed over `dayTypes`. */
function buildRank(processed: ProcessedData, station: string, dayTypes: string[]): { data: Data[], layout: Partial<Layout> } | null {
  const sd = processed.stations.get(station)
  if (!sd) return null
  const others = (STATIONS as readonly string[]).map(s => processed.stations.get(s)).filter(d => d !== undefined)
  const ranks: number[] = []
  const rides: number[] = []
  for (let i = 0; i < sd.months.length; i++) {
    const v = sumAcrossDayTypes(sd, "total", dayTypes, i)
    let rank = 1
    for (const o of others) {
      if (o !== sd && sumAcrossDayTypes(o, "total", dayTypes, i) > v) rank++
    }
    ranks.push(rank)
    rides.push(v)
  }
  return {
    data: [{
      name: "Rank",
      x: sd.months,
      y: ranks,
      customdata: rides,
      type: "scatter",
      mode: "lines",
      line: { color: STATION_COLORS[station], width: 2, shape: "hv" },
      hovertemplate: `#%{y} of ${NUM_STATIONS} (%{customdata:,.0f} rides)<extra></extra>`,
      showlegend: false,
    } as Data],
    layout: {
      xaxis: { dtick: window.innerWidth < 600 ? "M24" : "M12", tickformat: "'%y", hoverformat: "%b '%y", tickangle: -45 },
      yaxis: {
        range: [NUM_STATIONS + 0.5, 0.5],
        tickvals: Array.from({ length: NUM_STATIONS }, (_, i) => i + 1),
        ticktext: Array.from({ length: NUM_STATIONS }, (_, i) => `#${i + 1}`),
      },
    },
  }
}

function downloadCsv(processed: ProcessedData, info: StationInfo) {
  const sd = processed.stations.get(info.station)
  if (!sd) return
  const cols = ["avg_weekday", "avg_weekend", "avg_holiday", "total_weekday", "total_weekend", "total_holiday"] as const
  const lines = [
    ["month", ...cols].join(","),
    ...sd.months.map((m, i) => [
      `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`,
      ...cols.map(c => round(sd[c][i])),
    ].join(",")),
  ]
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" })
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = `path-${info.slug}-monthly.csv`
  a.click()
  URL.revokeObjectURL(href)
}

function StatCard({ label, value, tip }: { label: string, value: string, tip?: string }) {
  return (
    <div className="station-stat">
      <div className="station-stat-value">{value}</div>
      <div className="station-stat-label">{label}{tip && <> <InfoTip>{tip}</InfoTip></>}</div>
    </div>
  )
}

function StationView({ info }: { info: StationInfo }) {
  const { station, title } = info
  const [dayTypes, setDayTypes] = useUrlState<string[]>("d", dayTypesParam)
  const [metric, setMetric] = useUrlState<RidesMetric>("m", metricParam)
  const [timeRange, setTimeRange] = useUrlState<TimeRange>("t", timeRangeParam)
  const { data: processed, isError, error } = useRidesData()

  useEffect(() => {
    const prev = document.title
    document.title = `${title} – PATH Ridership – Hudson County Complete Streets`
    return () => { document.title = prev }
  }, [title])

  const baselines = useMemo(
    () => processed ? computeBaselines(processed.stations, BASELINE_YEARS, DEFAULT_EXCLUSIONS) : null,
    [processed],
  )
  const summary = useMemo(
    () => processed && baselines ? summarize(processed, baselines, station) : null,
    [processed, baselines, station],
  )
  const stations = useMemo(() => [station], [station])
  const recovery = useMemo(
    () => processed && baselines && dayTypes.length
      ? buildByDayType(processed, baselines, "pct2019", dayTypes, stations, "recent", null)
      : null,
    [processed, baselines, dayTypes, stations],
  )
  const rides = useMemo(() => {
    if (!processed || !baselines || !dayTypes.length) return null
    const { data, layout } = buildByDayType(processed, baselines, metric, dayTypes, stations, timeRange, null)
    return {
      data,
      layout: {
        ...layout,
        // SI ticks ("5k", not "5000") fit the narrow-viewport margin.
        yaxis: { ...layout.yaxis, tickformat: "~s" },
        // Avg lines end in labeled endpoint annotations at the right edge;
        // keep the legend out of their way.
        ...(metric === "avg" ? { legend: { ...layout.legend, x: 0.01, xanchor: "left" as const } } : {}),
      },
    }
  }, [processed, baselines, dayTypes, stations, metric, timeRange])
  const rank = useMemo(
    () => processed && dayTypes.length ? buildRank(processed, station, dayTypes) : null,
    [processed, station, dayTypes],
  )

  const lines = stationLines(station)
  const dayTypeText = dayTypes.length === DAY_TYPES.length
    ? "all days"
    : dayTypes.map(dt => DAY_TYPE_LABELS[dt] ?? dt).join(" + ")
  const noop = useMemo(() => () => {}, [])

  return (
    <div className="station-page">
      <Breadcrumb title={title} />
      <header className="station-header" style={{ '--c': STATION_COLORS[station] } as CSSProperties}>
        <h1>{title}</h1>
        <div className="station-area">{info.area}</div>
        <ul className="station-lines">
          {lines.map(({ line, prev, next }) => (
            <li key={line.label}>
              <span className="line-chip" style={{ '--line': line.color } as CSSProperties}>{line.label}</span>
              <span className="line-neighbors">
                {prev ? <Link to={stationPath(prev)!}>← {stationInfo(prev)!.title}</Link> : <span className="terminal">terminal</span>}
                <span className="sep">·</span>
                {next ? <Link to={stationPath(next)!}>{stationInfo(next)!.title} →</Link> : <span className="terminal">terminal</span>}
              </span>
            </li>
          ))}
        </ul>
      </header>
      {isError ? <div className="error">Error: {error?.toString()}</div> : null}
      <div className="station-stats">
        {summary
          ? <>
            <StatCard label={`rides, 12 mo. to ${fmtMonth(summary.lastMonth)}`} value={fmtShort(summary.total12)} />
            <StatCard label="avg weekday rides / day" value={fmtShort(summary.avgWeekday12)} tip="Mean of the last 12 months' average weekday ridership." />
            <StatCard label={`of ${BASELINE_LABEL} levels`} value={`${round(summary.pctBaseline * 100)}%`} tip={`Last 12 months' total rides vs. the same calendar months' ${BASELINE_LABEL} average (all day types).`} />
            <StatCard label={`busiest of ${NUM_STATIONS} (${round(summary.share * 100)}% of rides)`} value={`#${summary.rank}`} tip="Rank and share of system-wide rides, last 12 months." />
          </>
          : <div className="loading station-stats-loading">Loading...</div>}
      </div>
      <div className="plot-toggles station-controls">
        <StationDropdown
          stations={[...DAY_TYPES] as string[]}
          colors={DAY_TYPE_COLORS}
          selected={dayTypes}
          onChange={setDayTypes}
          label="Day Types"
          nameMap={DAY_TYPE_LABELS}
        />
        <span className="station-controls-note">applies to all plots below</span>
      </div>

      <div className="plot-container">
        <Plot
          id="recovery"
          extraMarginLeft={10}
          title={`Ridership vs. ${BASELINE_LABEL}`}
          subtitle={`Avg daily rides vs. the same calendar month's ${BASELINE_LABEL} average, by day type`}
          {...(recovery ?? {})}
        />
      </div>

      <div className="plot-container">
        <Plot
          key={`rides-${metric}`}
          id="rides"
          title={metric === "avg" ? "Avg rides per day" : "Monthly rides"}
          subtitle={metric === "avg" ? "By day type" : `By day type, with 12-month rolling average (${dayTypeText})`}
          {...(rides ?? {})}
        />
        <div className="plot-toggles" data-pltly-keep-pin>
          <ToggleButtonGroup value={metric} exclusive size="small" onChange={(_, v) => { if (v) setMetric(v) }}>
            <ToggleButton value="avg">Avg/Day</ToggleButton>
            <ToggleButton value="total">Total</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup value={timeRange} exclusive size="small" onChange={(_, v) => { if (v) setTimeRange(v) }}>
            <ToggleButton value="all">All Time</ToggleButton>
            <ToggleButton value="recent">2020–Present</ToggleButton>
          </ToggleButtonGroup>
        </div>
      </div>

      <div className="plot-container">
        <Plot
          id="rank"
          title={`Rank among ${NUM_STATIONS} stations`}
          subtitle={`By monthly rides (${dayTypeText}); #1 = busiest`}
          {...(rank ?? {})}
        />
      </div>

      <MonthlyPlots
        stations={stations}
        dayTypes={dayTypes}
        metric={metric}
        subtitle=""
      />

      <HourlyPlot
        station={station}
        activeStations={stations}
        onActiveStationsChange={noop}
        activeDayTypes={dayTypes}
        onActiveDayTypesChange={setDayTypes}
      />

      <section className="station-data">
        <h2 id="data">Data</h2>
        <p>
          <button type="button" disabled={!processed} onClick={() => processed && downloadCsv(processed, info)}>
            Download {title} monthly CSV
          </button>
          {' '}(avg + total rides per weekday / weekend / holiday, {processed ? `${fmtMonth(processed.aggregate.months[0])}–${fmtMonth(processed.aggregate.months[processed.aggregate.months.length - 1])}` : '…'}).
          {' '}All stations: <a href={allPqtUrl}><code>all.pqt</code></a> (Parquet), from <a href="https://www.panynj.gov/path/en/about/stats.html" target="_blank" rel="noopener">PANYNJ monthly reports</a>.
        </p>
      </section>

      <StationIndex current={station} title="Other stations" />
      <p className="station-back">
        <Link to="/">← All stations</Link>
        <span className="sep">·</span>
        <Link to={`/?s=${STATION_CODES[station]}`}>{title} on the all-stations plots</Link>
      </p>
    </div>
  )
}
