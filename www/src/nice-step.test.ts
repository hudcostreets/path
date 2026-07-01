import { describe, it, expect } from 'vitest'
import { niceStep } from './nice-step'

describe('niceStep', () => {
  // Mantissa ladder: <1.5 → 1, <3.5 → 2, <7.5 → 5, else 10. Boundary inputs
  // (0.15, 0.35, …) can land either side due to `0.15/0.1 = 1.4999…` etc.,
  // so fixtures stay away from decimal-tenths boundaries and instead pick
  // inputs whose exact FP representation is unambiguous.
  const cases: [number, number][] = [
    // sub-unity
    [0.11, 0.1],   // mantissa 1.1  → 1  → 0.1
    [0.2, 0.2],    // mantissa 2    → 2  → 0.2
    [0.4, 0.5],    // mantissa 4    → 5  → 0.5
    [0.8, 1],      // mantissa 8    → 10 → 1.0
    // single-digit
    [1.0, 1],
    [1.5, 2],      // mantissa == boundary; falls to `<3.5` branch → 2
    [2.1, 2],
    [3.5, 5],      // exact FP; `3.5 < 3.5` is false → `<7.5` → 5
    [4, 5],
    [7.5, 10],     // exact FP; `<7.5` is false → 10
    [8, 10],
    // teens — mantissa in [1, 10), so multiplied by 10^1 = 10
    [15, 20],      // mantissa 1.5 → 2 → 20
    [16, 20],
    [34, 20],      // mantissa 3.4 → 2 → 20
    [40, 50],      // mantissa 4   → 5 → 50
    [85, 100],     // mantissa 8.5 → 10 → 100
    [999, 1000],   // mantissa 9.99 → 10 → 1000
    // millions (EvE bars' actual regime — 10-year totals ~100M)
    [4_500_000, 5_000_000],
    [16_000_000, 20_000_000],
    [85_000_000, 100_000_000],
  ]

  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      // Loose tolerance shakes off `0.4 → 0.5000000000000001` FP noise while
      // still catching mantissa-mis-selection (which returns a value with a
      // different leading digit or order of magnitude).
      expect(niceStep(input)).toBeCloseTo(expected, 8)
    })
  }
})
