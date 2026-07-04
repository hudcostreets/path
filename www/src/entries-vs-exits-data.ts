import { useQuery } from "@tanstack/react-query"
import { asyncBufferFromUrl, parquetRead } from "hyparquet"
import { resolve as dvcResolve } from "virtual:dvc-data"
import { compressors } from "./parquet-compressors"

// Shared shape of the `entries_vs_exits.pqt` payload. Fetched once per session
// via `useEntriesVsExits()`; both `EntriesVsExitsBars` and `HourlyPlot` read
// from it (day counts + per-station monthly averages).

export type RawDayType = 'weekday' | 'saturday' | 'sunday' | 'holiday'

export type StationMonthRow = {
  name: string
  by_day_type: Record<RawDayType, { avg_entries: number, avg_exits: number }>
}

export type MonthEntry = {
  days: Record<RawDayType, number>
  stations: StationMonthRow[]
}

export type EvePayload = {
  all_yms: string[]
  months: Record<string, MonthEntry>
}

/** Fetch `entries_vs_exits.pqt`, rebuild the nested `Payload` shape once, and
 *  share it across all consumers via react-query's `['entries-vs-exits']` key. */
export function useEntriesVsExits() {
  return useQuery<EvePayload>({
    queryKey: ['entries-vs-exits'],
    refetchOnWindowFocus: false,
    refetchInterval: false,
    queryFn: async () => {
      const file = await asyncBufferFromUrl({ url: dvcResolve('entries_vs_exits.pqt') })
      const raw: Record<string, unknown>[] = []
      await parquetRead({ file, rowFormat: 'object', compressors, onComplete: rows => raw.push(...rows) })
      const months: Record<string, MonthEntry> = {}
      const ymSet = new Set<string>()
      for (const r of raw) {
        const ym = r['ym'] as string
        const name = r['station'] as string
        ymSet.add(ym)
        let m = months[ym]
        if (!m) {
          m = {
            days: {
              weekday: Number(r['weekday_days']),
              saturday: Number(r['saturday_days']),
              sunday: Number(r['sunday_days']),
              holiday: Number(r['holiday_days']),
            },
            stations: [],
          }
          months[ym] = m
        }
        m.stations.push({
          name,
          by_day_type: {
            weekday: { avg_entries: Number(r['weekday_entries']), avg_exits: Number(r['weekday_exits']) },
            saturday: { avg_entries: Number(r['saturday_entries']), avg_exits: Number(r['saturday_exits']) },
            sunday: { avg_entries: Number(r['sunday_entries']), avg_exits: Number(r['sunday_exits']) },
            holiday: { avg_entries: Number(r['holiday_entries']), avg_exits: Number(r['holiday_exits']) },
          },
        })
      }
      return { all_yms: Array.from(ymSet).sort(), months }
    },
  })
}

/** Sum day counts (weekday / sat / sun / holiday) across `[fromYm, toYm]`
 *  inclusive. Returns zeroes if the payload isn't loaded yet. */
export function dayCountsInRange(
  payload: EvePayload | undefined,
  fromYm: string,
  toYm: string,
): Record<RawDayType, number> {
  const totals: Record<RawDayType, number> = { weekday: 0, saturday: 0, sunday: 0, holiday: 0 }
  if (!payload || !fromYm || !toYm) return totals
  for (const ym of payload.all_yms) {
    if (ym < fromYm || ym > toYm) continue
    const d = payload.months[ym]?.days
    if (!d) continue
    totals.weekday += d.weekday
    totals.saturday += d.saturday
    totals.sunday += d.sunday
    totals.holiday += d.holiday
  }
  return totals
}
