/** Round a positive magnitude `m` up to a "nice" round tick step in {1,2,5}
 *  × 10^k. Used to pick y-axis tick spacing that adapts across orders of
 *  magnitude (single-month totals ~5M, 10-year totals ~100M).
 *
 *  Kept in its own leaf module (no `plot-utils`/`pltly` imports) so unit
 *  tests can import it without spinning up the plotly toolchain. */
export function niceStep(m: number): number {
  const exp = Math.floor(Math.log10(m))
  const mantissa = m / 10 ** exp
  const niceMantissa = mantissa < 1.5 ? 1 : mantissa < 3.5 ? 2 : mantissa < 7.5 ? 5 : 10
  return niceMantissa * 10 ** exp
}
