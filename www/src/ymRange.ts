import type { Param } from 'use-prms'

export type YmRange = [string, string]

const RE = /^\d{2}-\d{2}$/

/** Drop the `20` prefix for URL compactness: `2017-01` <-> `17-01`. */
const short = (ym: string) => ym.slice(2)
const long = (s: string) => `20${s}`

/** URL state for the shared `(fromYm, toYm)` date range. Encoded as
 *  `?ym=YY-MM,YY-MM` (e.g. `?ym=17-01,26-02`); absent means "no user
 *  override" and consumers fall back to data-derived defaults. */
export const ymRangeParam: Param<YmRange | null> = {
  encode(r): string | undefined {
    if (!r) return undefined
    return `${short(r[0])},${short(r[1])}`
  },
  decode(s): YmRange | null {
    if (!s) return null
    const [from, to] = s.split(',')
    if (!RE.test(from) || !RE.test(to)) return null
    return [long(from), long(to)]
  },
}
