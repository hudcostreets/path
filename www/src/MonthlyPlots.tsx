import { ToggleButton, ToggleButtonGroup } from "@mui/material"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Data, Layout, Legend } from "plotly.js"
import Plotly from "plotly.js-dist-min"
import { Plot as PltlyPlot, useLegendHover } from "pltly/react"
import { INFERNO, getColorAt } from "pltly"
import { useUrlState, codeParam } from "use-prms"
import { H2, Loading } from "./plot-utils"
import { resolve as dvcResolve } from 'virtual:dvc-data'

type PlotSpec = { data: Data[], layout: Partial<Layout> }
type DayType = "weekday" | "weekend"

const dayTypeParam = codeParam<DayType>("weekday", { weekday: "w", weekend: "e" })
const height = 450

function recolorTraces(data: Data[]): Data[] {
  const years = data.map(d => parseInt(d.name ?? '0')).filter(y => y > 0)
  if (years.length === 0) return data
  const minYear = Math.min(...years)
  const maxYear = Math.max(...years)
  const range = maxYear - minYear || 1
  return data.map(d => {
    const year = parseInt(d.name ?? '0')
    if (!year) return d
    const t = (year - minYear) / range
    const color = getColorAt(INFERNO, t)
    return { ...d, marker: { ...(d as any).marker, color } }
  })
}

function highlightTraces(data: Data[], activeTrace: string | null): Data[] {
  if (!activeTrace) return data
  return data.map(trace => {
    const isActive = trace.name === activeTrace
    if (isActive) {
      const yRaw = (trace as any).y
      const y: number[] = Array.isArray(yRaw) ? yRaw : yRaw?._inputArray ? Array.from(yRaw._inputArray) : Object.values(yRaw).filter((v): v is number => typeof v === 'number')
      return {
        ...trace,
        width: 0.25,
        zorder: 100,
        text: y.map(v => v > 0 ? `<b>${Math.round(v / 1000)}k</b>` : ''),
        textposition: 'outside',
        textfont: { color: '#e4e4e4', size: 11 },
        textangle: 0,
        constraintext: 'none',
        cliponaxis: false,
      } as Data
    }
    return { ...trace, opacity: 0.3, zorder: 1 } as Data
  })
}

export default function MonthlyPlots() {
  const [weekday, setWeekday] = useState<PlotSpec | null>(null)
  const [weekend, setWeekend] = useState<PlotSpec | null>(null)
  const [dayType, setDayType] = useUrlState<DayType>("d", dayTypeParam)

  useEffect(() => {
    fetch(dvcResolve('avg_weekday_month_grouped.json')).then(r => r.json()).then(setWeekday)
    fetch(dvcResolve('avg_weekend_month_grouped.json')).then(r => r.json()).then(setWeekend)
  }, [])

  const spec = dayType === "weekday" ? weekday : weekend
  const traceNames = useMemo(
    () => spec?.data.map(d => d.name).filter((n): n is string => !!n) ?? [],
    [spec],
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const { hoverTrace, handlers: legendHandlers } = useLegendHover(containerRef, traceNames)
  const attachLegend = useCallback(() => legendHandlers.onUpdate(), [legendHandlers])
  const coloredData = useMemo(() => spec ? recolorTraces(spec.data) : null, [spec])
  const styledData = useMemo(
    () => coloredData ? highlightTraces(coloredData, hoverTrace) : null,
    [coloredData, hoverTrace],
  )

  const narrow = typeof window !== 'undefined' && window.innerWidth < 600
  const margin = { l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }
  const legendBase: Partial<Legend> = narrow
    ? { orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top" }
    : {}

  if (!spec || !styledData) {
    return <div className="plot-container">
      <H2 id="monthly">Average rides, by month</H2>
      <Loading />
    </div>
  }

  return (
    <div className="plot-container">
      <H2 id="monthly">{`Average ${dayType} rides, by month`}</H2>
      <div ref={containerRef}>
      <PltlyPlot
        plotly={Plotly}
        data={styledData}
        disableLegendHover
        disableSoloTrace
        onAfterPlot={attachLegend}
        style={{ width: '100%', height: `${height}px` }}
        layout={{
          autosize: true,
          margin,
          hovermode: "x",
          barmode: "group",
          xaxis: {
            ...spec.layout.xaxis,
            fixedrange: true,
          },
          yaxis: {
            fixedrange: true,
          },
          legend: { ...spec.layout.legend, ...legendBase, title: undefined, entrywidth: 60 } as Partial<Legend>,
        }}
      />
      </div>
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
