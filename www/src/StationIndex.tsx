import { type CSSProperties, useMemo } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ActionConfig, useActions } from "use-kbd"
import { STATION_ABBREVS, STATION_COLORS, STATION_INFO, type StationInfo } from "./stations"

function Group({ label, stations, current }: { label: string, stations: StationInfo[], current?: string }) {
  return (
    <div className="station-index-group">
      <span className="station-index-label">{label}:</span>
      {stations.map(i => i.station === current
        ? <span key={i.slug} className="station-index-item current" style={{ '--c': STATION_COLORS[i.station] } as CSSProperties}>{i.title}</span>
        : <Link key={i.slug} className="station-index-item" to={`/station/${i.slug}`} style={{ '--c': STATION_COLORS[i.station] } as CSSProperties}>{i.title}</Link>
      )}
    </div>
  )
}

/** Links to all 13 per-station pages, grouped NY / NJ. `current` renders as
 *  plain (non-link) text. */
export function StationIndex({ current, title = "Station pages" }: { current?: string, title?: string }) {
  const ny = STATION_INFO.filter(i => i.state === "NY")
  const nj = STATION_INFO.filter(i => i.state === "NJ")
  return (
    <nav className="station-index" aria-label="Station pages">
      {title && <div className="station-index-title">{title}</div>}
      <Group label="NY" stations={ny} current={current} />
      <Group label="NJ" stations={nj} current={current} />
    </nav>
  )
}

/** Omnibar actions ("Grove Street station page", …) for jumping to any
 *  station page. Hidden from the shortcuts modal (no default bindings). */
export function StationNavActions() {
  const navigate = useNavigate()
  const actions = useMemo(() => Object.fromEntries(STATION_INFO.map(i => [
    `station-page:${i.slug}`,
    {
      label: `${i.title} station page`,
      group: 'Station pages',
      keywords: [i.station, STATION_ABBREVS[i.station], i.area, 'station'],
      handler: () => navigate(`/station/${i.slug}`),
      hideFromModal: true,
    } satisfies ActionConfig,
  ])), [navigate])
  useActions(actions)
  return null
}
