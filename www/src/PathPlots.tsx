import { useState } from "react"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"

export default function PathPlots() {
  const [effectiveStations, setEffectiveStations] = useState<string[]>([])
  const [activeYear, setActiveYear] = useState<string | null>(null)
  return <>
    <RidesPlot onEffectiveStationsChange={setEffectiveStations} activeYear={activeYear} />
    <MonthlyPlots
      stations={effectiveStations}
      subtitle={stationSubtitle(effectiveStations)}
      onActiveYearChange={setActiveYear}
    />
  </>
}
