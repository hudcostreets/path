import { lazy, Suspense, useCallback, useRef, useState } from "react"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import type { Metric } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"
import HourlyPlot from "./HourlyPlot"

type DateRange = { from: string, to: string }

// Lazy: leaflet + tile basemap only loads when user scrolls to the map.
const StationsMap = lazy(() => import("./StationsMap"))

export default function PathPlots() {
  const [plot1Stations, setPlot1Stations] = useState<string[]>([])
  const [plot1ActiveStation, setPlot1ActiveStation] = useState<string | null>(null)
  const [plot3ActiveStation, setPlot3ActiveStation] = useState<string | null>(null)
  const [effectiveDayTypes, setEffectiveDayTypes] = useState<string[]>(["weekday", "weekend"])
  const [activeYear, setActiveYear] = useState<string | null>(null)
  // Bidirectional pin: either plot's legend-click writes `soloStation`; both
  // plots read it via pltly's controlled `soloTrace` and render it as pinned.
  const [soloStation, setSoloStation] = useState<string | null>(null)
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
  // Plot3 can also brush plot2 on hover: when it has an active (non-pinned)
  // station, prefer that over plot1's reported stations. Plot3 itself gets
  // plot1's brush (not its own, to avoid narrowing data to one station that
  // pltly's soloMode already visually isolates).
  const plot2Stations = plot3ActiveStation ? [plot3ActiveStation] : plot1Stations
  return <>
    <RidesPlot
      onEffectiveStationsChange={setPlot1Stations}
      onEffectiveDayTypesChange={setEffectiveDayTypes}
      onMetricChange={onMetricChange}
      activeYear={activeYear}
      soloStation={soloStation}
      onSoloStationChange={setSoloStation}
      onActiveStationChange={setPlot1ActiveStation}
      externalActiveStation={plot3ActiveStation}
    />
    <MonthlyPlots
      stations={plot2Stations}
      dayTypes={effectiveDayTypes}
      metric={plot2Metric}
      subtitle={stationSubtitle(plot2Stations)}
      onActiveYearChange={setActiveYear}
    />
    <HourlyPlot
      onActiveStationChange={setPlot3ActiveStation}
      soloStation={soloStation}
      onSoloStationChange={setSoloStation}
      externalActiveStation={plot1ActiveStation}
      dateRange={mapDateRange}
    />
    <Suspense fallback={<div className="loading" style={{ height: 250 }}>Loading map…</div>}>
      <StationsMap embedded onDateRangeChange={setMapDateRange} />
    </Suspense>
  </>
}
