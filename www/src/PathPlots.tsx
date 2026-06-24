import { lazy, Suspense, useCallback, useRef, useState } from "react"
import { useUrlState } from "use-prms"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import type { Metric } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"
import HourlyPlot from "./HourlyPlot"
import EntriesVsExitsBars from "./EntriesVsExitsBars"
import { stationsParam } from "./stations"
import { dayTypesParam } from "./dayTypes"

type DateRange = { from: string, to: string }

// Lazy: leaflet + tile basemap only loads when user scrolls to the map.
const StationsMap = lazy(() => import("./StationsMap"))

/** Page-level state for cross-plot filters. Single source of truth:
 *   - `activeStations` (?s=): which stations are "in focus" — empty/full set
 *     means "all stations" and renders the unfiltered view; non-empty subset
 *     narrows every plot to those stations. Legend clicks set it to
 *     [clickedStation] (toggle back to default on second click).
 *   - `activeDayTypes` (?d=): the same idea for day types.
 *  Both flow down to every plot as controlled props. No local debounced
 *  copies, no separate "soloStation" / "selectedStations" / etc. */
export default function PathPlots() {
  const [activeStations, setActiveStations] = useUrlState<string[]>("s", stationsParam)
  const [activeDayTypes, setActiveDayTypes] = useUrlState<string[]>("d", dayTypesParam)
  const [plot1ActiveStation, setPlot1ActiveStation] = useState<string | null>(null)
  const [plot3ActiveStation, setPlot3ActiveStation] = useState<string | null>(null)
  const [activeYear, setActiveYear] = useState<string | null>(null)
  // Date range owned by plot4 (StationsMap). Plot3 (HourlyPlot) follows it
  // for cross-plot brushing.
  const [mapDateRange, setMapDateRange] = useState<DateRange | undefined>()
  // Plot2 metric: follows plot1 for avg/total, stays put when plot1 switches to pct2019
  const [plot2Metric, setPlot2Metric] = useState<"avg" | "total">("avg")
  const plot2MetricRef = useRef<"avg" | "total">("avg")
  const onMetricChange = useCallback((metric: Metric) => {
    if (metric === "avg" || metric === "total") {
      plot2MetricRef.current = metric
      setPlot2Metric(metric)
    }
  }, [])
  // MonthlyPlots narrows to hovered station (from either RidesPlot or
  // HourlyPlot) if any, otherwise follows the page-level activeStations filter.
  const plot2Stations = plot3ActiveStation
    ? [plot3ActiveStation]
    : plot1ActiveStation
    ? [plot1ActiveStation]
    : activeStations
  return <>
    <RidesPlot
      activeStations={activeStations}
      onActiveStationsChange={setActiveStations}
      activeDayTypes={activeDayTypes}
      onActiveDayTypesChange={setActiveDayTypes}
      onMetricChange={onMetricChange}
      activeYear={activeYear}
      onActiveStationChange={setPlot1ActiveStation}
      externalActiveStation={plot3ActiveStation}
    />
    <MonthlyPlots
      stations={plot2Stations}
      dayTypes={activeDayTypes}
      metric={plot2Metric}
      subtitle={stationSubtitle(plot2Stations)}
      onActiveYearChange={setActiveYear}
    />
    <HourlyPlot
      activeStations={activeStations}
      onActiveStationsChange={setActiveStations}
      activeDayTypes={activeDayTypes}
      onActiveDayTypesChange={setActiveDayTypes}
      onActiveStationChange={setPlot3ActiveStation}
      externalActiveStation={plot1ActiveStation}
      dateRange={mapDateRange}
    />
    <Suspense fallback={<div className="loading" style={{ height: 250 }}>Loading map…</div>}>
      <StationsMap embedded onDateRangeChange={setMapDateRange} />
    </Suspense>
    <EntriesVsExitsBars activeStations={activeStations} />
  </>
}
