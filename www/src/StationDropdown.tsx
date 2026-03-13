import { useEffect, useRef, useState } from "react"
import type { StationGroup } from "./RidesPlot"

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
      // Remove this group's stations
      onChange(selected.filter(s => !group.stations.includes(s)))
    } else {
      // Add all of this group's stations (dedup via Set)
      onChange([...new Set([...selected, ...group.stations])])
    }
  }

  return (
    <label>
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={all}
        onChange={toggle}
      />
      <span className="color-swatch" style={{ backgroundColor: group.color }} />
      {group.label}
    </label>
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
}: {
  stations: string[]
  colors: Record<string, string>
  selected: string[]
  onChange: (stations: string[]) => void
  disabled?: boolean
  lineGroups?: StationGroup[]
  regionGroups?: StationGroup[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)

  const allSelected = selected.length === stations.length
  const noneSelected = selected.length === 0
  const summaryText = allSelected
    ? "All Stations"
    : noneSelected
      ? "No Stations"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} Stations`

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
            <div className="group-heading">Lines</div>
            {lineGroups.map(g => (
              <GroupCheckbox key={g.label} group={g} selected={selected} onChange={onChange} />
            ))}
          </div>
        )}
        {regionGroups && regionGroups.length > 0 && (
          <div className="group-section">
            <div className="group-heading">Regions</div>
            {regionGroups.map(g => (
              <GroupCheckbox key={g.label} group={g} selected={selected} onChange={onChange} />
            ))}
          </div>
        )}
        <div className="group-section">
          <div className="group-heading">Stations</div>
          {stations.map(station => (
            <label key={station}>
              <input
                type="checkbox"
                checked={selected.includes(station)}
                onChange={() => toggleStation(station)}
              />
              <span className="color-swatch" style={{ backgroundColor: colors[station] }} />
              {station}
            </label>
          ))}
        </div>
      </div>
    </details>
  )
}
