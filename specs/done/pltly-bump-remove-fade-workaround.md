# Bump pltly + remove `MonthlyPlots` fade workaround

`hccs/crashes` debugged a Plotly bar-trace paint bug that affects pltly's
`applyFadeSolo` path: `Plotly.restyle({opacity: [v0, v1, …]}, [i0, i1, …])`
(multi-index multi-value form) updates `plotDiv.data[i].opacity` correctly
but does **not** repaint the SVG bars. The trace-level opacity on
`<g class="trace bars">` stays at 1, regardless of the new value.

The scalar form `Plotly.restyle({opacity: 0.3}, [i…])` paints correctly.

## The pltly fix

In `pltly/src/react/Plot.tsx`, `applyFadeSolo` now groups indices by
target value and issues one scalar `restyle` per (attr, value) group
instead of a single multi-value `update` call. Same result for non-bar
traces; correct paint for bar plots.

Once published, pltly handles hover/pin fade automatically — consumers
no longer need a workaround for bar plots.

**Remote ref to bump to:** the latest `r/dist` commit on
`gitlab.com/runsascoded/js/pltly` after the `Plot: split applyFadeSolo
restyle by value to fix bar-trace paint bug` source commit lands on
`r/main` and the dist build runs. Today (2026-04-24) the source commit
is local-only at `/Users/ryan/c/js/pltly`; check `r/dist` after push.

## What to change in this repo

1. **Bump `package.json` `pltly`** dep URL to the new dist tarball
   (replace the `9c64c11…` SHA in
   `https://gitlab.com/runsascoded/js/pltly/-/archive/<sha>/pltly-<sha>.tar.gz`).
   `pnpm install`.

2. **`src/MonthlyPlots.tsx`** — strip the manual fade in `highlightTraces`.

   - Remove the `opacity: 0.3` and `zorder: 1` entries from the
     non-active branch (pltly handles fade-via-opacity once
     `disableLegendHover` / `disableSoloTrace` are dropped).
   - Keep the active branch's `width: 0.25 / zorder: 100 / text /
     textposition / textfont / etc.` — those are visual lifts pltly
     doesn't touch.
   - Drop `disableLegendHover` and `disableSoloTrace` props from
     `<Plot>`.

   The `onActiveTraceChange={setActiveYear}` wiring stays — pltly fires
   it for both hover and pin, and the consumer still wants the active
   year for its own state (e.g. `onActiveYearChange` callback to the
   parent).

3. **Verify in browser:**
   - Hover a year in the legend → that year stays full opacity, every
     other trace fades to ~0.3, active gets the `<b>349k</b>` label.
   - Move cursor between LIs → fade follows cursor cleanly (no ghost
     trail; no flicker back to full opacity for non-active traces).
   - Click an LI to pin → fade persists after cursor leaves the legend.
   - Click again (or anywhere outside the legend) → unpin / fade clears.

## Why this matters

Once verified here, the pattern generalizes. Any pltly consumer with
bar plots can drop their fade workaround. `hccs/crashes`
`FatalitiesByMonthBarsPlot` is the same shape (commit `b7c56a27a5f`
applied the same workaround as a stopgap) and will get reverted to the
no-workaround form after this verification passes here.

## Non-goals

- Other pltly behaviors (hover dismiss, brush, axis fade) are
  unchanged. No props besides `disableLegendHover` / `disableSoloTrace`
  should need flipping.
- `highlightTraces` keeps its width/zorder/text customizations. We're
  only removing the `opacity: 0.3` / `zorder: 1` on the non-active
  branch, which pltly now handles via `Plotly.restyle`.
