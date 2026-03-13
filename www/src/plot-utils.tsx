import { Headings } from "@rdub/base/heading"
import { Annotations, Data, Layout } from "plotly.js"
import Plotly from 'plotly.js-dist-min'
import { Plot as PltlyPlot } from 'pltly/react'
import { resolve as dvcResolve } from 'virtual:dvc-data'

const height = 450
const DefaultHeight = height
const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches

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

export function Plot(
  { id, title, soloMode, ...props }: {
    id: string
    title: string
    soloMode?: 'fade' | 'hide'
  } & ({
    data: Data[]
    layout: Partial<Layout>
  } | {})
) {
  const h2 = <H2 id={id}>{title}</H2>
  const narrow = window.innerWidth < 600
  const margin = { l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }
  if (!('data' in props)) {
    return <>
      {h2}
      <Loading/>
    </>
  }
  let { data, layout: { xaxis = {}, yaxis = {}, legend = {}, ...layout } } = props
  xaxis = { fixedrange: true, ...xaxis }
  yaxis = { fixedrange: true, ...yaxis }
  if (narrow) {
    legend = { ...legend, orientation: "h", x: 0.5, xanchor: "center", y: -0.08, yanchor: "top" }
  }
  return <>
    {h2}
    <PltlyPlot
      plotly={Plotly}
      data={data}
      soloMode={soloMode}
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
