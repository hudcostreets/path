import { Headings } from "@rdub/base/heading"
import { useEffect, useMemo, useState } from "react"
import { Annotations, Data, Layout } from "plotly.js"

import { Plot as PltlyPlot, type PlotProps as PltlyPlotProps } from 'pltly/react'
import { resolve as dvcResolve } from 'virtual:dvc-data'

const height = 450
const DefaultHeight = height
export const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
export const clean = new URLSearchParams(window.location.search).has('clean')

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
    standoff: 6,
    ...a,
    x, ax,
  }
}

export const { H2 } = Headings({ className: "heading" })

/** Blend a hex color toward white (dark mode) or black (light mode) by `t` (0–1). */
export function blendAvgColor(hexColor: string, t = 0.5): string {
  const base = dark ? [255, 255, 255] : [0, 0, 0]
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  const mr = Math.round(r + (base[0] - r) * t)
  const mg = Math.round(g + (base[1] - g) * t)
  const mb = Math.round(b + (base[2] - b) * t)
  return `rgb(${mr},${mg},${mb})`
}

export function rollingAvg(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += values[j]
    return sum / window
  })
}

export function Loading({ height = DefaultHeight }: { height?: number }) {
  return <div className={"loading"} style={{ height }}>Loading...</div>
}

type PlotOwnProps = {
  id: string
  title: string
  subtitle?: React.ReactNode
}

/** Track `window.innerWidth < threshold` as reactive React state. Subscribes
 *  to `resize` so toggling mobile↔desktop in DevTools repaints without refresh. */
function useNarrow(threshold = 600): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < threshold)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < threshold)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [threshold])
  return narrow
}

export function Plot(
  { id, title, subtitle, ...props }: PlotOwnProps & Partial<Omit<PltlyPlotProps, 'style'>> & { layout?: Partial<Layout> }
) {
  const h2 = <H2 id={id}>{title}</H2>
  const sub = <div className="plot-subtitle" style={subtitle ? undefined : { visibility: 'hidden' }}>{subtitle || '\u00A0'}</div>
  const narrow = useNarrow()
  const margin = useMemo(() => ({ l: narrow ? 30 : 40, r: 0, t: 0, b: narrow ? 50 : 40 }), [narrow])
  const userLayout = (props as { layout?: Partial<Layout> }).layout
  // Memoize the computed layout so its identity depends only on `userLayout`.
  // Otherwise every re-render of this wrapper would create a new layout object,
  // causing pltly's Plot to fire a redundant Plotly.react on every hover.
  const mergedLayout = useMemo(() => {
    const { xaxis: xaxisIn, yaxis: yaxisIn, legend: legendIn, ...rest } = userLayout ?? {}
    return {
      autosize: true,
      margin,
      hovermode: "x unified" as const,
      hoverlabel: dark ? { bgcolor: "#2a2a3e", font: { color: "#e4e4e4" } } : undefined,
      xaxis: { fixedrange: true, ...xaxisIn },
      yaxis: { fixedrange: true, ...yaxisIn },
      legend: narrow
        ? { ...legendIn, orientation: "h" as const, x: 0.5, xanchor: "center" as const, y: -0.08, yanchor: "top" as const }
        : { ...legendIn },
      ...rest,
    }
  }, [narrow, userLayout, margin])
  if (!props.data) {
    return <>
      {h2}
      {sub}
      <Loading/>
    </>
  }
  const { data, layout: _layout, ...plotProps } = props as { data: Data[], layout?: Partial<Layout> } & Omit<PltlyPlotProps, 'style' | 'data' | 'layout'>
  return <>
    {h2}
    {sub}
    <PltlyPlot
      data={data}
      {...plotProps}
      style={{ width: '100%', height: `${height}px` }}
      layout={mergedLayout}
    />
  </>
}
