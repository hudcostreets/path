import { useCallback, useRef, useState } from "react"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import type { Metric } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"

export default function PathPlots() {
  const [effectiveStations, setEffectiveStations] = useState<string[]>([])
  const [effectiveDayTypes, setEffectiveDayTypes] = useState<string[]>(["weekday", "weekend"])
  const [activeYear, setActiveYear] = useState<string | null>(null)
  // Plot2 metric: follows plot1 for avg/total, stays put when plot1 switches to pct2019
  const [plot2Metric, setPlot2Metric] = useState<"avg" | "total">("avg")
  const plot2MetricRef = useRef<"avg" | "total">("avg")
  const onMetricChange = useCallback((metric: Metric) => {
    if (metric === "avg" || metric === "total") {
      plot2MetricRef.current = metric
      setPlot2Metric(metric)
    }
  }, [])
  return <>
    <RidesPlot
      onEffectiveStationsChange={setEffectiveStations}
      onEffectiveDayTypesChange={setEffectiveDayTypes}
      onMetricChange={onMetricChange}
      activeYear={activeYear}
    />
    <MonthlyPlots
      stations={effectiveStations}
      dayTypes={effectiveDayTypes}
      metric={plot2Metric}
      subtitle={stationSubtitle(effectiveStations)}
      onActiveYearChange={setActiveYear}
    />
  </>
}
