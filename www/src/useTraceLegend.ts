import { useCallback, useMemo, useRef } from "react"
import { useLegendHover } from "pltly/react"
import type { LegendClickEvent } from "pltly/react"

/**
 * Shared hook for stacked bar legend interaction.
 *
 * - Legend click → update URL-persisted selection (solo/restore)
 * - Legend hover → transient highlight (visual only, not URL-persisted)
 * - All legend items always visible; non-selected faded via DOM fixup
 * - In "solo" mode, non-selected traces use `visible: 'legendonly'`
 *   (hidden from plot but LI stays); in "highlight" mode, `opacity: 0.4`
 *
 * Used by both PATH (stations) and BT (crossings/vehicle types).
 */
export function useTraceLegend(
  allItems: readonly string[],
  selectedItems: string[],
  setSelectedItems: (items: string[]) => void,
  nameMap?: Record<string, string>,
  /** Items to restore when un-soloing via LI click (defaults to allItems). */
  restoreItems?: readonly string[],
) {
  const traceName = useCallback(
    (item: string) => nameMap?.[item] ?? item,
    [nameMap],
  )
  const reverseMap = useMemo(() => {
    if (!nameMap) return null
    return Object.fromEntries(Object.entries(nameMap).map(([k, v]) => [v, k]))
  }, [nameMap])
  const itemForTrace = useCallback(
    (name: string): string | undefined =>
      reverseMap ? reverseMap[name] : (allItems.includes(name) ? name : undefined),
    [reverseMap, allItems],
  )

  const traceNames = useMemo(
    () => allItems.map(item => traceName(item)),
    [allItems, traceName],
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const { hoverTrace, handlers: legendHandlers } = useLegendHover(containerRef, traceNames)

  const isAllSelected = selectedItems.length === 0 || selectedItems.length >= allItems.length

  const onLegendClick = useCallback((event: LegendClickEvent) => {
    const name = event.data[event.curveNumber]?.name
    if (!name || !traceNames.includes(name)) return false
    const item = itemForTrace(name)
    if (!item) return false
    if (selectedItems.length === 1 && selectedItems[0] === item) {
      setSelectedItems([...(restoreItems ?? allItems)])
    } else {
      setSelectedItems([item])
    }
    return false
  }, [allItems, selectedItems, setSelectedItems, itemForTrace, traceNames])

  const onLegendDoubleClick = useCallback(() => {
    setSelectedItems([...(restoreItems ?? allItems)])
    return false
  }, [allItems, restoreItems, setSelectedItems])

  const hoveredItem = hoverTrace ? itemForTrace(hoverTrace) ?? null : null
  const singleSelected = !isAllSelected && selectedItems.length === 1 ? selectedItems[0] : null
  const activeItem: string | null = hoveredItem ?? singleSelected

  const effectiveItems: string[] = useMemo(
    () => hoveredItem ? [hoveredItem] : (isAllSelected ? [...allItems] : selectedItems),
    [hoveredItem, isAllSelected, allItems, selectedItems],
  )

  const selectedSet = useMemo(
    () => new Set(isAllSelected ? allItems : selectedItems),
    [isAllSelected, allItems, selectedItems],
  )

  const isFaded = useCallback((traceName: string): boolean => {
    const item = itemForTrace(traceName)
    if (!item) return false
    if (hoverTrace) return traceName !== hoverTrace
    if (isAllSelected) return false
    return !selectedSet.has(item)
  }, [hoverTrace, isAllSelected, selectedSet, itemForTrace])

  /** Reattach legend hover handlers + apply faded opacity to legend items.
   *  Call from `onAfterPlot`. */
  const attachLegend = useCallback(() => {
    legendHandlers.onUpdate()
    const container = containerRef.current
    if (!container) return
    const legendTraces = container.querySelectorAll('.legend .traces')
    legendTraces.forEach(traceEl => {
      const textEl = traceEl.querySelector('.legendtext')
      if (!textEl) return
      const name = textEl.textContent?.trim() ?? ''
      if (!traceNames.includes(name)) return
      const faded = isFaded(name)
      ;(traceEl as SVGElement).style.opacity = faded ? '0.4' : '1'
    })
  }, [legendHandlers, containerRef, traceNames, isFaded])

  return {
    containerRef,
    traceNames,
    hoverTrace,
    hoveredItem,
    activeItem,
    effectiveItems,
    isAllSelected,
    isFaded,
    onLegendClick: onLegendClick as (event: unknown) => boolean,
    onLegendDoubleClick: onLegendDoubleClick as () => boolean,
    attachLegend,
  }
}
