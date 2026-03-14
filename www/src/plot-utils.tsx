import { Headings } from "@rdub/base/heading"
import { Annotations, Data, Layout } from "plotly.js"
import Plotly from 'plotly.js-dist-min'
import { Plot as PltlyPlot } from 'pltly/react'
import { resolve as dvcResolve } from 'virtual:dvc-data'

const height = 450
const DefaultHeight = height
export const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches

export const hovertemplate = "%{y:,.0f}"
export const hovertemplatePct = "%{y:.1%}"

const resolved = dvcResolve('all.pqt')
export const url = resolved.startsWith('/') ? `${window.location.origin}${resolved}` : resolved

export function ann({ x, ax, ...a }: Partial<Omit<Annotations, 'x' | 'ax'> & { x: number | Date, ax: number | Date }>): Partial<Annotations> {
  if (x instanceof Date) x = x.getTime()
  if (ax instanceof Date) ax = ax.getTime()
  return {
    axref: "x",
    ayref: "y",
    arrowcolor: "#888",
    arrowhead: 0,
    arrowwidth: 1,
    xanchor: "right",
    ...a,
    x, ax,
  }
}

export const { H2 } = Headings({ className: "heading" })

export function Loading({ height = DefaultHeight }: { height?: number }) {
  return <div className={"loading"} style={{ height }}>Loading...</div>
}

export type PlotExtraProps = {
  onLegendClick?: (data: unknown) => boolean
  onLegendDoubleClick?: () => boolean
  onAfterPlot?: () => void
  disableLegendHover?: boolean
  disableSoloTrace?: boolean
  traceNames?: string[]
}

export function Plot(
  { id, title, subtitle, soloMode, ...props }: {
    id: string
    title: string
    subtitle?: string
    soloMode?: 'fade' | 'hide'
  } & PlotExtraProps & ({
    data: Data[]
    layout: Partial<Layout>
  } | {})
) {
  const h2 = <H2 id={id}>{title}</H2>
  const sub = subtitle ? <div className="plot-subtitle">{subtitle}</div> : null
  const narrow = window.innerWidth < 600
  const margin = { l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }
  if (!('data' in props)) {
    return <>
      {h2}
      {sub}
      <Loading/>
    </>
  }
  const {
    data,
    layout: { xaxis: xaxisIn = {}, yaxis: yaxisIn = {}, legend: legendIn = {}, ...layout },
    onLegendClick, onLegendDoubleClick, onAfterPlot,
    disableLegendHover, disableSoloTrace, traceNames,
  } = props
  let xaxis = { fixedrange: true, ...xaxisIn }
  let yaxis = { fixedrange: true, ...yaxisIn }
  let legend = { ...legendIn }
  if (narrow) {
    legend = { ...legend, orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top" }
  }
  return <>
    {h2}
    {sub}
    <PltlyPlot
      plotly={Plotly}
      data={data}
      soloMode={soloMode}
      onLegendClick={onLegendClick}
      onLegendDoubleClick={onLegendDoubleClick}
      onAfterPlot={onAfterPlot}
      disableLegendHover={disableLegendHover}
      disableSoloTrace={disableSoloTrace}
      traceNames={traceNames}
      style={{ width: '100%', height: `${height}px` }}
      layout={{
        autosize: true,
        margin,
        hovermode: "x unified",
        hoverlabel: dark ? { bgcolor: "#2a2a3e", font: { color: "#e4e4e4" } } : undefined,
        xaxis, yaxis,
        legend,
        ...layout,
      }}
    />
  </>
}
