import { useState } from "react"
import RidesPlot, { stationSubtitle } from "./RidesPlot"
import MonthlyPlots from "./MonthlyPlots"

export default function PathPlots() {
  const [effectiveStations, setEffectiveStations] = useState<string[]>([])
  return <>
    <RidesPlot onEffectiveStationsChange={setEffectiveStations} />
    <MonthlyPlots stations={effectiveStations} subtitle={stationSubtitle(effectiveStations)} />
  </>
}
