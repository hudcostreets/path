import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useEffect, useState } from "react"
import { Data, Layout, LayoutAxis, Legend } from "plotly.js"
import { Plot } from "./LinePlots"
import { resolve as dvcResolve } from 'virtual:dvc-data'

type PlotSpec = { data: Data[], layout: Partial<Layout> }

const allTimeRange = ['2011-12-17', '2025-12-17']
const recentRange = ['2019-12-17', '2025-12-17']

export default function StationPlots() {
  const [weekdays, setWeekdays] = useState<PlotSpec | null>(null)
  const [weekends, setWeekends] = useState<PlotSpec | null>(null)
  const [dayType, setDayType] = useState<"weekday" | "weekend">("weekday")
  const [timeRange, setTimeRange] = useState<"all" | "recent">("all")

  useEffect(() => {
    fetch(dvcResolve('weekdays.json')).then(r => r.json()).then(setWeekdays)
    fetch(dvcResolve('weekends.json')).then(r => r.json()).then(setWeekends)
  }, [])

  const spec = dayType === "weekday" ? weekdays : weekends
  if (!spec) {
    return <div className="plot-container">
      <Plot id="station" title="Average PATH ridership by station" />
    </div>
  }

  const isRecent = timeRange === "recent"
  const xaxis: Partial<LayoutAxis> = {
    range: isRecent ? recentRange : allTimeRange,
    dtick: isRecent ? "M3" : "M12",
    tickformat: isRecent ? "%b '%y" : "'%y",
    hoverformat: "%b '%y",
    tickangle: -45,
    fixedrange: true,
  }

  return (
    <div className="plot-container">
      <Plot
        id="station"
        title={`Average ${dayType} PATH ridership by station`}
        data={spec.data}
        layout={{
          barmode: "relative",
          hovermode: "x",
          xaxis,
          yaxis: {
            fixedrange: true,
            hoverformat: ",.0f",
          },
          legend: { ...spec.layout.legend, title: undefined, entrywidth: 100 } as Partial<Legend>,
        }}
      />
      <div className="plot-toggles">
        <ToggleButtonGroup
          value={dayType}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setDayType(v) }}
        >
          <ToggleButton value="weekday">Weekday</ToggleButton>
          <ToggleButton value="weekend">Weekend</ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup
          value={timeRange}
          exclusive
          size="small"
          onChange={(_, v) => { if (v) setTimeRange(v) }}
        >
          <ToggleButton value="all">All Time</ToggleButton>
          <ToggleButton value="recent">2020–Present</ToggleButton>
        </ToggleButtonGroup>
      </div>
    </div>
  )
}
