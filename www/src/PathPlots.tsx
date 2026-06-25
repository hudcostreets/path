import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react"
import { useUrlState } from "use-prms"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import type { Metric } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"
import HourlyPlot from "./HourlyPlot"
import EntriesVsExitsBars from "./EntriesVsExitsBars"
import { H2 } from "./plot-utils"
import { stationsParam } from "./stations"
import { dayTypesParam } from "./dayTypes"
import { ymRangeParam, type YmRange } from "./ymRange"

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
  // Shared date range across pies + EvE bars + HourlyPlot:
  //  - `urlYmRange` (URL `?ym=YY-MM,YY-MM`) is the explicit user choice; null
  //    means "no override" so plots fall back to data-derived defaults.
  //  - `dataDefaultRange` is whichever plot loaded data first; both plots'
  //    `setDataDefault` callbacks only fire when this is still null.
  //  - `effectiveRange` is what plots actually consume: URL choice wins,
  //    else the shared default. Both keep pickers in sync.
  const [urlYmRange, setUrlYmRange] = useUrlState<YmRange | null>("ym", ymRangeParam)
  const [dataDefaultRange, setDataDefaultRange] = useState<YmRange | null>(null)
  const setDataDefault = useCallback((r: YmRange) => {
    setDataDefaultRange(prev => prev ?? r)
  }, [])
  const effectiveRange = urlYmRange ?? dataDefaultRange
  const mapDateRange = useMemo(
    () => effectiveRange ? { from: effectiveRange[0], to: effectiveRange[1] } : undefined,
    [effectiveRange],
  )
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
    {/* Shared section heading: covers both the pie-map (entries vs exits per
     *  station, animated by hour) and the bar chart (same data summed across
     *  the date-range, per station). One heading instead of two duplicates. */}
    <H2 id="entries-vs-exits">Faregate entries vs exits, by station</H2>
    <Suspense fallback={<div className="loading" style={{ height: 250 }}>Loading map…</div>}>
      <StationsMap
        embedded
        activeStations={activeStations}
        dateRange={effectiveRange}
        onDateRangeChange={setUrlYmRange}
        onDataDefault={setDataDefault}
      />
    </Suspense>
    <EntriesVsExitsBars
      activeStations={activeStations}
      dateRange={effectiveRange}
      onDateRangeChange={setUrlYmRange}
      onDataDefault={setDataDefault}
    />
  </>
}
