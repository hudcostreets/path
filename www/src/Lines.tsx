import ReactJsonView from '@microlink/react-json-view'
import { Arr } from "@rdub/base/arr"
import { round } from "@rdub/base/math"
import Db from "@rdub/duckdb/client/db"
import { useQuery } from "@tanstack/react-query"
import { Int32 } from 'apache-arrow'
import { Annotations } from "plotly.js"
import * as Plotly from "plotly.js"
import { useMemo } from "react"
import Plot from 'react-plotly.js'

export type Row = {
  month: Int32
  avg_weekday: Int32
  avg_weekend: Int32
}
export type Pcts = { week: number, wknd: number }

const height = 450
export const gridcolor = "#ddd"
export const hovertemplate = "%{y:,.0f}"
export const hovertemplatePct = "%{y:.1%}"
const margin = {
  l: 40, r: 0,
  t: 0, b: 40,
}
const config: Partial<Plotly.Config> = {
  autosizable: true,
  responsive: true,
  displayModeBar: false
}

export const url = 'https://hudcostreets.s3.amazonaws.com/path/all.pqt'
// const [ collapseLevel, setCollapseLevel] = useLocalStorageState<number | null>(CollapseLevelKey, { defaultValue: 2 })

export function ann({ x, ax, ...a }: Partial<Omit<Annotations, 'x' | 'ax'> & { x: number | Date, ax: number | Date }>): Partial<Annotations> {
  if (x instanceof Date) x = x.getTime()
  if (ax instanceof Date) ax = ax.getTime()
  return {
    axref: "x",
    arrowcolor: "#2a3f5f",
    arrowhead: 0,
    arrowwidth: 1,
    ...a,
    x, ax,
  }
}

export default function LinePlots() {
  // const url = "/all.pqt"
  const db = useMemo(() => new Db(), [])
  const { data: table, isError, error, isLoading } = useQuery({
    queryKey: ['lines', url],
    queryFn: async () => {
      const conn = await (await db.db).connect()
      const query = `
          SELECT 
              month,
              cast(sum("avg weekday") as int32) as avg_weekday,
              cast(sum("avg weekend") as int32) as avg_weekend
          FROM parquet_scan('${url}')
          group by month
          order by month
      `
      const table = await conn.query<Row>(query)
      const offset = new Date().getTimezoneOffset() * 60000
      const month: Date[] = Arr(table.getChild("month")!.toArray()).map(m => new Date(m + offset))
      // console.log("result:", table, table.getChild("month"))
      // console.log("months:", month)//month?.map(m => new Date(m)))
      const avg_weekday = Arr(table.getChild("avg_weekday")!.toArray())
      const avg_weekend = Arr(table.getChild("avg_weekend")!.toArray())
      conn.close()
      const idxs2019: number[] = (
        month
          .map((m, idx) => [ m, idx ] as [ Date, number ])
          .filter(([m]) => m.getFullYear() === 2019)
          .map(([, idx]) => idx)
      )
      const pcts2019: Pcts[] = month.map((m, idx) => {
        const mo = m.getMonth()
        const week = avg_weekday[idx] / avg_weekday[idxs2019[mo]]
        const wknd = avg_weekend[idx] / avg_weekend[idxs2019[mo]]
        return { week, wknd }
      })
      if (month && avg_weekday && avg_weekend) {
        return { month, avg_weekday, avg_weekend, pcts2019, idxs2019 }
      } else {
        return null
      }
    }
  })
  if (isLoading) return <div>Loading...</div>
  if (isError) return <div>Error: {error?.toString()}</div>
  if (!table) return <div>No data</div>
  const { month, avg_weekday, avg_weekend, pcts2019, idxs2019 } = table
  const idx2020 = idxs2019[11] + 1
  const monthsFrom2020 = month.slice(idx2020)
  const pcts2019From2020 = pcts2019.slice(idx2020)
  const lastPcts = pcts2019From2020[pcts2019From2020.length - 1]
  const n = month.length
  let lastMoStr = month[n - 1].toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit'
  })
  lastMoStr = `${lastMoStr.substring(0, lastMoStr.length - 2)}'${lastMoStr.substring(lastMoStr.length - 2)}`
  // console.log("data:", data)
  return (
    <div className={"plot-container"}>
      <h2>Avg rides per day</h2>
      <Plot
        className={'plot'}
        data={[
          {
            name: "Avg Weekday",
            x: month, y: avg_weekday,
            marker: { color: 'red' },
            hovertemplate,
          },
          {
            name: "Avg Weekend",
            x: month, y: avg_weekend,
            marker: { color: 'blue' },
            hovertemplate,
          },
        ]}
        layout={{
          height,
          xaxis: {
            dtick: "M12",
            gridcolor,
          },
          yaxis: {
            fixedrange: true,
            gridcolor,
          },
          legend: {
            yanchor: "top",
            y: 0.99,
            xanchor: "right",
            x: 0.99,
          },
          margin,
          hovermode: "x",
          annotations: [
            ann({
              ax: month[n - 10],
              text: `${lastMoStr}: ${avg_weekday[n - 1].toLocaleString()}`,
              x: month[n - 1],
              y: avg_weekday[n - 1],
            }),
            ann({
              ax: month[n - 10],
              text: `${lastMoStr}: ${avg_weekend[n - 1].toLocaleString()}`,
              x: month[n - 1],
              y: avg_weekend[n - 1],
            }),
          ]
        }}
        config={config}
      />
      <h2>Avg rides per day (vs. 2019)</h2>
      <Plot
        className={'plot'}
        data={[
          {
            name: "Avg Weekday (% of 2019)",
            x: monthsFrom2020, y: pcts2019From2020.map(p => p.week),
            marker: { color: 'red' },
            hovertemplate: hovertemplatePct,
          },
          {
            name: "Avg Weekend (% of 2019)",
            x: monthsFrom2020, y: pcts2019From2020.map(p => p.wknd),
            marker: { color: 'blue' },
            hovertemplate: hovertemplatePct,
          },
        ]}
        layout={{
          height,
          xaxis: {
            dtick: "M3",
            tickformat: "%b '%y",
            tickangle: 45,
            range: [null, month[n - 1]/* + 1000*60*60*24*10*/],
            gridcolor,
          },
          yaxis: {
            dtick: 0.1,
            tickformat: ',.0%',
            fixedrange: true,
            gridcolor,
          },
          legend: {
            yanchor: "bottom",
            y: 0.03,
            xanchor: "right",
            x: 0.99,
          },
          margin,
          hovermode: "x",
          annotations: [
            ann({
              ax: month[n - 3],
              text: `${lastMoStr}: ${round(lastPcts.week * 1000) / 10}%`,
              x: month[n - 1],
              y: lastPcts.week,
            }),
            ann({
              ax: month[n - 3],
              text: `${lastMoStr}: ${round(lastPcts.wknd * 1000) / 10}%`,
              x: month[n - 1],
              y: lastPcts.wknd,
            }),
          ]
        }}
        config={config}
      />
      <hr/>
      <div>
        <details>
          <summary>Data</summary>
          <ReactJsonView
            src={table}
            // collapsed={collapseLevel ?? false}
            displayDataTypes={false}
            displayArrayKey={true}
            name={false}
            displayObjectSize
            enableClipboard
            quotesOnKeys={false}
          />
        </details>
      </div>
      {/*<pre>{JSON.stringify(table, null, 2)}</pre>*/}
    </div>
  )
}
