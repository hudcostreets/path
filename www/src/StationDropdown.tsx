import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { displayName as stationDisplayName, type StationGroup } from "./stations"
import { Tooltip } from "./Tooltip"

/** "Grove Street page →" link, shown next to a pinned station's filter badge. */
export function StationPageLink({ to, station }: { to: string, station: string }) {
  return (
    <Link className="station-page-link" to={to} data-pltly-keep-pin>
      <span className="station-page-link-name">{stationDisplayName(station)} </span>page →
    </Link>
  )
}

function GroupCheckbox({
  group,
  selected,
  onChange,
}: {
  group: StationGroup
  selected: string[]
  onChange: (stations: string[]) => void
}) {
  const count = group.stations.filter(s => selected.includes(s)).length
  const all = count === group.stations.length
  const some = count > 0 && !all
  const checkboxRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = some
  }, [some])

  const toggle = () => {
    if (all) {
      onChange(selected.filter(s => !group.stations.includes(s)))
    } else {
      onChange([...new Set([...selected, ...group.stations])])
    }
  }

  const solo = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onChange([...group.stations])
  }

  return (
    <div className={`dropdown-row${all ? ' group-active' : ''}`} style={all ? { borderLeftColor: group.color } as React.CSSProperties : undefined}>
      <label>
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={all}
          onChange={toggle}
        />
        <span className="color-swatch solo-target" style={{ backgroundColor: group.color }} onClick={solo} />
        {group.label}
      </label>
      <span className="solo-link" onClick={solo}>only</span>
    </div>
  )
}

function StationRow({
  station,
  color,
  checked,
  onToggle,
  onSolo,
  href,
}: {
  station: string
  color: string
  checked: boolean
  onToggle: () => void
  onSolo: () => void
  /** Per-station page; renders a "↗" link at the end of the row. */
  href?: string
}) {
  const solo = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onSolo()
  }
  return (
    <div className="dropdown-row">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
        />
        <span className="color-swatch solo-target" style={{ backgroundColor: color }} onClick={solo} />
        {station}
      </label>
      <span className="solo-link" onClick={solo}>only</span>
      {href && (
        <Tooltip content={`${station} station page`} placement="right">
          <Link className="station-row-link" to={href} aria-label={`${station} station page`}>↗</Link>
        </Tooltip>
      )}
    </div>
  )
}

export function StationDropdown({
  stations,
  colors,
  selected,
  onChange,
  disabled,
  lineGroups,
  regionGroups,
  label = "Stations",
  lineGroupsLabel = "Lines",
  regionGroupsLabel = "Regions",
  nameMap,
  stationHref,
}: {
  stations: string[]
  colors: Record<string, string>
  selected: string[]
  onChange: (stations: string[]) => void
  disabled?: boolean
  lineGroups?: StationGroup[]
  regionGroups?: StationGroup[]
  label?: string
  lineGroupsLabel?: string
  regionGroupsLabel?: string
  nameMap?: Record<string, string>
  /** Map a station to its per-station page path (adds a link per row). */
  stationHref?: (station: string) => string | undefined
}) {
  const displayName = (s: string) => nameMap?.[s] ?? s
  const [isOpen, setIsOpen] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)

  const allSelected = selected.length === stations.length
  const noneSelected = selected.length === 0
  const summaryText = allSelected
    ? `All ${label}`
    : noneSelected
      ? `No ${label}`
      : selected.length === 1
        ? displayName(selected[0])
        : `${selected.length} ${label}`

  const toggleAll = () => {
    onChange(allSelected ? [] : [...stations])
  }

  const toggleStation = (station: string) => {
    if (selected.includes(station)) {
      onChange(selected.filter(s => s !== station))
    } else {
      onChange([...selected, station])
    }
  }

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        detailsRef.current.open = false
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [isOpen])

  return (
    <details
      ref={detailsRef}
      className={`station-dropdown${disabled ? ' disabled' : ''}`}
      open={isOpen && !disabled}
      onToggle={(e) => {
        if (disabled) {
          e.preventDefault()
          ;(e.target as HTMLDetailsElement).open = false
          return
        }
        setIsOpen((e.target as HTMLDetailsElement).open)
      }}
    >
      <summary>{summaryText}</summary>
      <div className="station-list">
        <label className="select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
          />
          {allSelected ? "Deselect All" : "Select All"}
        </label>
        {lineGroups && lineGroups.length > 0 && (
          <div className="group-section">
            <div className="group-heading">{lineGroupsLabel}</div>
            {lineGroups.map(g => (
              <GroupCheckbox key={g.label} group={g} selected={selected} onChange={onChange} />
            ))}
          </div>
        )}
        {regionGroups && regionGroups.length > 0 && (
          <div className="group-section">
            <div className="group-heading">{regionGroupsLabel}</div>
            {regionGroups.map(g => (
              <GroupCheckbox key={g.label} group={g} selected={selected} onChange={onChange} />
            ))}
          </div>
        )}
        <div className="group-section">
          <div className="group-heading">{label}</div>
          {stations.filter(s => {
            // Hide items already shown as single-item lineGroups
            if (!lineGroups) return true
            return !lineGroups.some(g => g.stations.length === 1 && g.stations[0] === s)
          }).map(station => (
            <StationRow
              key={station}
              station={displayName(station)}
              color={colors[station]}
              checked={selected.includes(station)}
              onToggle={() => toggleStation(station)}
              onSolo={() => onChange([station])}
              href={stationHref?.(station)}
            />
          ))}
        </div>
      </div>
    </details>
  )
}
