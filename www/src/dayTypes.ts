/** Shared day-type model + URL param (used by RidesPlot, EntriesVsExitsBars).
 *  3-value picker (weekday / weekend / holiday). EntriesVsExitsBars expands
 *  "weekend" to ["saturday", "sunday"] internally when aggregating its data. */
import { Param } from "use-prms"

export const DAY_TYPES = ["weekday", "weekend", "holiday"] as const
export type DayType = typeof DAY_TYPES[number]

// Use `Record<string, string>` (not `Record<DayType, string>`) so callers can
// index with arbitrary strings (e.g. user input, trace names) without TS noise.
export const DAY_TYPE_LABELS: Record<string, string> = {
  weekday: "Weekday",
  weekend: "Weekend",
  holiday: "Holiday",
}

export const DAY_TYPE_COLORS: Record<string, string> = {
  weekday: "#ef4444",
  weekend: "#3b82f6",
  holiday: "#10b981",
}

export const DAY_TYPE_FROM_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(DAY_TYPE_LABELS).map(([k, v]) => [v, k])
)

const DAY_TYPE_CODES: Record<DayType, string> = {
  weekday: "w",
  weekend: "e",
  holiday: "h",
}

const CODE_TO_DAY_TYPE: Record<string, DayType> = Object.fromEntries(
  Object.entries(DAY_TYPE_CODES).map(([k, v]) => [v, k as DayType])
)

const DEFAULT: DayType[] = ["weekday", "weekend"]

export const dayTypesParam: Param<string[]> = {
  encode(types: string[]): string | undefined {
    if (types.length === DEFAULT.length && DEFAULT.every(d => types.includes(d))) return undefined
    if (types.length === 0) return ''
    return types.map(t => DAY_TYPE_CODES[t as DayType]).join('')
  },
  decode(encoded: string | undefined): string[] {
    if (encoded === undefined) return [...DEFAULT]
    if (encoded === '') return []
    return encoded.split('').map(c => CODE_TO_DAY_TYPE[c]).filter(Boolean)
  },
}
