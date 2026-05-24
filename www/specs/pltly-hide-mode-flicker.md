# `pltly` `soloMode: 'hide'` legend-hover y-axis flicker

## Symptom

In `BridgeTunnel`'s `TrafficPlot` (SOLO mode → pltly `soloMode: 'hide'`),
hovering between LIs produces a brief visible flicker. The new LI's bars
render first at the *previous* y-range (e.g. ~12M for the stacked-all view),
then a second paint re-scales the y-axis to fit the newly-visible data
(~1.7M for Lincoln-only) and the bars snap to their correct size.

## Root cause (in pltly, not `path`)

In `pltly/src/react/Plot.tsx`, `applyFadeSolo` hide-mode branch (current
dist `Plot.js:259-285`):

```js
if (mode === 'hide') {
    const groups = new Map();
    // ...build groups: [true: [activeIdx], 'legendonly': [non-active idxs]]
    for (const [value, idxs] of groups) {
        P.restyle(plotDiv, { visible: value }, idxs);   // (1)
    }
    P.relayout(plotDiv, { 'yaxis.autorange': true });   // (2)
}
```

Each `Plotly.restyle` and the subsequent `Plotly.relayout` are separate
mutations. Verified live with `performance.now()` instrumentation: the
operations are issued with ~30-50ms of synchronous Plotly work between
them. Plotly paints after the restyle settles, *then* repaints after the
relayout's autorange recomputes the range.

The flicker is amplified by `path`'s explicit `yaxis.range` /
`autorange: false` for the all-traces case (`BridgeTunnel.tsx`
`stackMax * 1.05`). After (1) the project's pinned range (~12M) is still
in effect → the single visible trace's bars look squished. Then (2) flips
`autorange: true` → Plotly re-fits → bars snap to ~1.7M scale. Two paints,
visibly different.

## Verified fix (one `Plotly.update` call)

Collapse the per-group restyle + separate relayout into one mutation:

```js
const visArray = new Array(plotDiv.data.length).fill(true);
for (const [value, idxs] of groups) {
    for (const i of idxs) visArray[i] = value;
}
P.update(plotDiv, { visible: visArray }, { 'yaxis.autorange': true });
```

`Plotly.update` issues restyle + relayout in one operation → single paint
at end of tick. CIC-verified: bars render at the correct y-range
immediately. (The comment in the existing code, "array-form restyles
don't repaint bar-trace SVGs", appears not to apply when the call is
`Plotly.update` rather than `Plotly.restyle` — the layout change forces
a proper re-render. Worth re-verifying across more chart types.)

## Secondary issue (separate)

`applyFadeSolo` fires **twice** per hover, not once. Stack-trace
instrumentation:

- Call 1: `commitHookEffectListMount` → the `useEffect` on `activeTrace`
  change (`Plot.js:386-388`).
- Call 2: ~110ms later, via `linkedTraces` effect's `P.update`
  afterplot reapply (`Plot.js:463`, inside the
  `onUpdate`/`afterplot` flow at `Plot.js:651`).

Both calls produce the same final visual (active = `'GWB'` both times),
so this doesn't *cause* the y-range flicker — but it's wasted work. The
afterplot reapply is correct after a `Plotly.react` data swap (which
resets `visible` flags) but unnecessary after a restyle/relayout that
applyFadeSolo itself just issued. A "skip if state matches last applied"
guard would address it.

## Where this should land

- **Primary flicker fix** → `pltly`, `src/react/Plot.tsx`, `applyFadeSolo`
  hide-mode branch. One-line conceptual change (`restyle` × N + `relayout`
  → `update` × 1).
- **Secondary double-apply guard** → also `pltly`, same file.
- **Nothing in `path`** — the project doesn't (and shouldn't) need to know
  about pltly's batching strategy. The pinned `yaxis.range` /
  `autorange: false` in `BridgeTunnel.tsx` is a defensible project choice
  (keep the y-axis stable for the all-traces case); it just exposed the
  pltly issue when combined with hover-driven `soloMode: 'hide'`.

## Resolution

Fixed upstream in `pltly` `4d286ec` (dist SHA `e7b1bca`, picked up here
in `a27fe6a`). The investigation walked through three iterations:

1. Combine the per-group `restyle`s + separate `relayout` into one
   `Plotly.update` (pltly `2afb320`). Single Plotly call per
   `applyFadeSolo`, but `applyFadeSolo` itself still fired twice per
   hover via the `linkedTraces` afterplot reapply.
2. Skip `applyFadeSolo` when `plotDiv.data[i].visible` already matches
   (pltly `6036a24`). e2e test asserts "exactly one apply per hover."
3. **The actual fix** (pltly `4d286ec`): React-driven dispatch.
   `linkedData` depends on `activeTrace`; visibility baked into
   `plotData` for `soloMode: 'hide'`; `yaxis.autorange: true` folded
   into `mergedLayout` when soloed; the main `Plotly.react` effect is
   the single dispatcher; `applyFadeSolo`'s hide-branch + separate
   `linkedTraces` `useEffect` removed. One paint per gesture.

Full architecture writeup, invariant + e2e test, and migration notes:
<https://gitlab.com/runsascoded/js/pltly/-/blob/main/specs/react-driven-architecture.md>.

The earlier per-call fixes (`2afb320`, `6036a24`) are still in pltly's
history but the code paths they touched are no-ops after `4d286ec`.

## Suggested follow-ups (not done)

- **`soloMode: 'fade'` still uses the restyle path** — folding its
  `activeStyle`/`inactiveStyle` overrides into `plotData` is the
  natural extension. `path` uses `'hide'` so this is fine.
- **Benchmark `Plotly.react`-driven vs restyle-driven hover latency**
  for synthetic plots with large N (traces/points). The architecture
  works fine for `path`'s ~180 bars × 6 traces but a defensible number
  would back the choice for bigger plots.
