import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useEffect, useState } from "react"
import { Data, Layout, Legend } from "plotly.js"
import { Plot } from "./LinePlots"
import { resolve as dvcResolve } from 'virtual:dvc-data'

type PlotSpec = { data: Data[], layout: Partial<Layout> }

export default function MonthlyPlots() {
  const [weekday, setWeekday] = useState<PlotSpec | null>(null)
  const [weekend, setWeekend] = useState<PlotSpec | null>(null)
  const [dayType, setDayType] = useState<"weekday" | "weekend">("weekday")

  useEffect(() => {
    fetch(dvcResolve('avg_weekday_month_grouped.json')).then(r => r.json()).then(setWeekday)
    fetch(dvcResolve('avg_weekend_month_grouped.json')).then(r => r.json()).then(setWeekend)
  }, [])

  const spec = dayType === "weekday" ? weekday : weekend
  if (!spec) {
    return <div className="plot-container">
      <Plot id="monthly" title="Average rides, by month" />
    </div>
  }

  return (
    <div className="plot-container">
      <Plot
        id="monthly"
        title={`Average ${dayType} rides, by month`}
        soloMode="hide"
        data={spec.data}
        layout={{
          barmode: "group",
          xaxis: {
            ...spec.layout.xaxis,
            fixedrange: true,
          },
          yaxis: {
            fixedrange: true,
          },
          legend: { ...spec.layout.legend, title: undefined, entrywidth: 60 } as Partial<Legend>,
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
      </div>
    </div>
  )
}
