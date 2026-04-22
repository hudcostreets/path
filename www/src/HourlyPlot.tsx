import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { useCallback, useMemo, useState } from "react"
import { Data, Legend } from "plotly.js"
import { resolve as dvcResolve } from 'virtual:dvc-data'
import { codeParam, useUrlState } from "use-prms"
import { Plot, hovertemplate } from "./plot-utils"
import { StationDropdown } from "./StationDropdown"
import type { StationGroup } from "./RidesPlot"

const height = 450

const resolved = dvcResolve('hourly.pqt')
const hourlyUrl = resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved

const STATIONS = [
  "Christopher St.", "9th Street", "14th Street", "23rd Street", "33rd Street",
  "WTC", "Newark", "Harrison", "Journal Square", "Grove Street",
  "Exchange Place", "Newport", "Hoboken",
] as const

const STATION_COLORS: Record<string, string> = {
  "Christopher St.": "#636efa",
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

const NY_STATIONS = ["Christopher St.", "9th Street", "14th Street", "23rd Street", "33rd Street", "WTC"] as const
const NJ_STATIONS = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken"] as const

const NWK_WTC = ["Newark", "Harrison", "Journal Square", "Grove Street", "Exchange Place", "WTC"] as const
const JSQ_33 = ["Journal Square", "Grove Street", "Exchange Place", "Newport", "Hoboken", "Christopher St.", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_33 = ["Hoboken", "Christopher St.", "9th Street", "14th Street", "23rd Street", "33rd Street"] as const
const HOB_WTC = ["Hoboken", "Newport", "Exchange Place", "WTC"] as const

const LINE_GROUPS: StationGroup[] = [
  { label: "NWK\u2013WTC", color: "#D93A30", stations: NWK_WTC },
  { label: "JSQ\u201333", color: "#F0A81C", stations: JSQ_33 },
  { label: "HOB\u201333", color: "#0082C6", stations: HOB_33 },
  { label: "HOB\u2013WTC", color: "#00A84F", stations: HOB_WTC },
]

const REGION_GROUPS: StationGroup[] = [
  { label: "New York", color: "#aaa", stations: NY_STATIONS },
  { label: "New Jersey", color: "#aaa", stations: NJ_STATIONS },
]

type DayType = "weekday" | "saturday" | "sunday" | "holiday"
type GroupBy = "station" | "daytype"
type Direction = "entry" | "exit"
type LegendMode = "solo" | "highlight"

const DAY_TYPES: DayType[] = ["weekday", "saturday", "sunday", "holiday"]

const groupByParam = codeParam<GroupBy>("station", { station: "s", daytype: "d" })
const directionParam = codeParam<Direction>("entry", { entry: "n", exit: "x" })
const legendModeParam = codeParam<LegendMode>("solo", { solo: "s", highlight: "h" })

const DAY_TYPE_LABELS: Record<string, string> = {
  weekday: "Weekday", saturday: "Saturday", sunday: "Sunday", holiday: "Holiday",
  weekend: "Weekend",
}

const DAY_TYPE_COLORS: Record<string, string> = {
  weekday: "#ef4444",
  saturday: "#3b82f6",
  sunday: "#8b5cf6",
  holiday: "#10b981",
  weekend: "#3b82f6",
}


const HOUR_LABELS = [
  "12a", "1a", "2a", "3a", "4a", "5a", "6a", "7a", "8a", "9a", "10a", "11a",
  "12p", "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p", "10p", "11p",
]

type HourlyRow = {
  year: number
  month: number
  station: string
  hour: number
  avg_weekday_entry: number
  avg_saturday_entry: number
  avg_sunday_entry: number
  avg_weekday_exit: number
  avg_saturday_exit: number
  avg_sunday_exit: number
  avg_holiday_entries: number
  avg_holiday_exits: number
}

function colKey(dayType: DayType, direction: Direction): keyof HourlyRow {
  if (dayType === "holiday") {
    return direction === "entry" ? "avg_holiday_entries" : "avg_holiday_exits"
  }
  return `avg_${dayType}_${direction}` as keyof HourlyRow
}

export default function HourlyPlot({ stations: externalStations, onActiveStationChange, soloStation, onSoloStationChange }: {
  stations?: string[]
  onActiveStationChange?: (station: string | null) => void
  /** Controlled solo/pin (full station name). Pair with `onSoloStationChange`
   *  to share pin state across plots. */
  soloStation?: string | null
  onSoloStationChange?: (station: string | null) => void
}) {
  const [groupBy, setGroupBy] = useUrlState<GroupBy>("hg", groupByParam)
  const [direction, setDirection] = useUrlState<Direction>("hd", directionParam)
  const [legendMode, setLegendMode] = useUrlState<LegendMode>("hl", legendModeParam)
  const [selectedStations, setSelectedStations] = useState<string[]>([...STATIONS])
  const [selectedDayTypes, setSelectedDayTypes] = useState<DayType[]>([...DAY_TYPES])

  const activeStations = useMemo(() => {
    if (externalStations && externalStations.length > 0) {
      return externalStations
        .map(s => s === "Christopher Street" ? "Christopher St." : s)
        .filter(s => (STATIONS as readonly string[]).includes(s))
    }
    return selectedStations
  }, [externalStations, selectedStations])

  const { data: allRows } = useQuery({
    queryKey: ['hourly-by-station', hourlyUrl],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url: hourlyUrl })
      const raw: Record<string, unknown>[] = []
      await parquetRead({
        file,
        rowFormat: 'object',
        onComplete: data => raw.push(...data),
      })
      const num = (v: unknown) => Number(v) || 0
      return raw.map(r => ({
        year: num(r['Year']),
        month: num(r['Month']),
        station: r['Station'] as string,
        hour: num(r['Hour']),
        avg_weekday_entry: num(r['Avg Weekday Entry']),
        avg_saturday_entry: num(r['Avg Saturday Entry']),
        avg_sunday_entry: num(r['Avg Sunday Entry']),
        avg_weekday_exit: num(r['Avg Weekday Exit']),
        avg_saturday_exit: num(r['Avg Saturday Exit']),
        avg_sunday_exit: num(r['Avg Sunday Exit']),
        avg_holiday_entries: num(r['Avg Holiday Entries']),
        avg_holiday_exits: num(r['Avg Holiday Exits']),
      }))
    },
  })

  const plotData = useMemo(() => {
    if (!allRows) return null
    const filtered = allRows.filter(r => activeStations.includes(r.station))
    const hours = Array.from({ length: 24 }, (_, i) => i)

    if (groupBy === "station") {
      // One trace per station, sum across selected day types
      const stationHourSums = new Map<string, { sum: number, count: number }>()
      for (const r of filtered) {
        for (const dt of selectedDayTypes) {
          const key = `${r.station}-${r.hour}`
          const prev = stationHourSums.get(key) ?? { sum: 0, count: 0 }
          prev.sum += r[colKey(dt, direction)] as number
          prev.count += 1
          stationHourSums.set(key, prev)
        }
      }
      return [...STATIONS]
        .filter(s => activeStations.includes(s))
        .map(station => {
          const y = hours.map(h => {
            const entry = stationHourSums.get(`${station}-${h}`)
            return entry ? Math.round(entry.sum / entry.count) : 0
          })
          return {
            name: station,
            type: "bar",
            x: hours,
            y,
            marker: { color: STATION_COLORS[station] },
            hovertemplate,
          } as Data
        })
    } else {
      // One trace per day type, merging sat+sun into "Weekend" when both selected
      const hasSat = selectedDayTypes.includes("saturday")
      const hasSun = selectedDayTypes.includes("sunday")
      const mergeWeekend = hasSat && hasSun

      type TraceSpec = { label: string, cols: DayType[], color: string }
      const specs: TraceSpec[] = []
      for (const dt of selectedDayTypes) {
        if (mergeWeekend && dt === "sunday") continue
        if (mergeWeekend && dt === "saturday") {
          specs.push({ label: "Weekend", cols: ["saturday", "sunday"], color: DAY_TYPE_COLORS.weekend })
        } else {
          specs.push({ label: DAY_TYPE_LABELS[dt], cols: [dt], color: DAY_TYPE_COLORS[dt] })
        }
      }

      return specs.map(({ label, cols, color }) => {
        const hourSums = new Map<number, { sum: number, count: number }>()
        for (const r of filtered) {
          for (const col of cols) {
            const prev = hourSums.get(r.hour) ?? { sum: 0, count: 0 }
            prev.sum += r[colKey(col, direction)] as number
            prev.count += 1
            hourSums.set(r.hour, prev)
          }
        }
        const y = hours.map(h => {
          const entry = hourSums.get(h)
          return entry ? Math.round(entry.sum / entry.count) : 0
        })
        return {
          name: label,
          type: "bar",
          x: hours,
          y,
          marker: { color },
          hovertemplate,
        } as Data
      })
    }
  }, [allRows, activeStations, selectedDayTypes, groupBy, direction])

  const dirLabel = direction === "entry" ? "entries" : "exits"
  const groupLabel = groupBy === "station" ? "by station" : "by day type"
  const titleText = `Avg hourly ${dirLabel} ${groupLabel}`

  // Track active (hover OR pin) trace for the subtitle badge.
  const [activeTraceName, setActiveTraceName] = useState<string | null>(null)

  const handleActiveTrace = useCallback((name: string | null) => {
    setActiveTraceName(name)
    if (!onActiveStationChange) return
    if (!name || groupBy !== "station") {
      onActiveStationChange(null)
      return
    }
    // Map legend name ("Christopher St." abbreviation) back to canonical station.
    onActiveStationChange(name === "Christopher St." ? "Christopher Street" : name)
  }, [onActiveStationChange, groupBy])

  // Build subtitle with filter badges (station active, day types) + static text.
  const subtitle: React.ReactNode = useMemo(() => {
    const badges: React.ReactNode[] = []
    if (activeTraceName && groupBy === "station") {
      badges.push(
        <span key="station" className="filter-badge">
          {activeTraceName}
          <span className="clear-filter" onClick={() => onSoloStationChange?.(null)}>&times;</span>
        </span>
      )
    }
    if (selectedDayTypes.length < DAY_TYPES.length) {
      const hasSat = selectedDayTypes.includes("saturday")
      const hasSun = selectedDayTypes.includes("sunday")
      const parts: string[] = []
      if (hasSat && hasSun) {
        if (selectedDayTypes.includes("weekday")) parts.push("Weekday")
        parts.push("Weekend")
        if (selectedDayTypes.includes("holiday")) parts.push("Holiday")
      } else {
        for (const dt of selectedDayTypes) parts.push(DAY_TYPE_LABELS[dt])
      }
      badges.push(
        <span key="daytypes" className="filter-badge">
          {parts.join(", ")}
          <span className="clear-filter" onClick={() => setSelectedDayTypes([...DAY_TYPES])}>&times;</span>
        </span>
      )
    }
    const staticText = "all months averaged (2017–present)"
    if (badges.length === 0) return staticText
    return <>{badges} · {staticText}</>
  }, [activeTraceName, groupBy, selectedDayTypes, onSoloStationChange])

  // Controlled solo: map full station name <-> trace name (with period abbreviation).
  const soloTraceName = useMemo(() => {
    if (soloStation === undefined) return undefined
    if (!soloStation || groupBy !== "station") return null
    const mapped = soloStation === "Christopher Street" ? "Christopher St." : soloStation
    return (STATIONS as readonly string[]).includes(mapped) ? mapped : null
  }, [soloStation, groupBy])

  const handleSoloTraceChange = useCallback((name: string | null) => {
    if (!onSoloStationChange) return
    if (!name) { onSoloStationChange(null); return }
    if (groupBy !== "station") return
    onSoloStationChange(name === "Christopher St." ? "Christopher Street" : name)
  }, [onSoloStationChange, groupBy])

  const layout = useMemo(() => ({
    barmode: "stack" as const,
    xaxis: {
      tickmode: "array" as const,
      tickvals: hours24,
      ticktext: HOUR_LABELS,
    },
    legend: { traceorder: "reversed" } as Partial<Legend>,
  }), [])

  return (
    <div className="plot-container">
      <Plot
        id="hourly"
        title={titleText}
        subtitle={subtitle}
        data={plotData ?? undefined}
        soloMode={legendMode === "solo" ? "hide" : "fade"}
        fadeOpacity={0.15}
        onActiveTraceChange={handleActiveTrace}
        soloTrace={soloTraceName}
        onSoloTraceChange={handleSoloTraceChange}
        layout={layout}
      />
      <div className="plot-toggles">
        <ToggleButtonGroup size="small" exclusive value={direction} onChange={(_, v) => v && setDirection(v)}>
          <ToggleButton value="entry">Entry</ToggleButton>
          <ToggleButton value="exit">Exit</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={groupBy} onChange={(_, v) => v && setGroupBy(v)}>
          <ToggleButton value="station">By Station</ToggleButton>
          <ToggleButton value="daytype">By Day Type</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={legendMode} onChange={(_, v) => v && setLegendMode(v)}>
          <ToggleButton value="solo">Solo</ToggleButton>
          <ToggleButton value="highlight">Highlight</ToggleButton>
        </ToggleButtonGroup>
        <StationDropdown
          stations={[...STATIONS]}
          colors={STATION_COLORS}
          selected={selectedStations}
          onChange={setSelectedStations}
          lineGroups={LINE_GROUPS}
          regionGroups={REGION_GROUPS}
        />
        <StationDropdown
          label="Sat / Sun"
          stations={[...DAY_TYPES]}
          colors={DAY_TYPE_COLORS}
          selected={selectedDayTypes}
          lineGroups={[
            { label: "Weekday", color: DAY_TYPE_COLORS.weekday, stations: ["weekday"] },
            { label: "Weekend", color: DAY_TYPE_COLORS.weekend, stations: ["saturday", "sunday"] },
            { label: "Holiday", color: DAY_TYPE_COLORS.holiday, stations: ["holiday"] },
          ]}
          lineGroupsLabel="Day Types"
          nameMap={DAY_TYPE_LABELS}
          onChange={v => setSelectedDayTypes(v as DayType[])}
        />
      </div>
    </div>
  )
}

const hours24 = Array.from({ length: 24 }, (_, i) => i)
