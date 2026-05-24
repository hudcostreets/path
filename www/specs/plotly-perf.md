# Plotly.js performance improvements

The plotly.js fork has new performance features. Here's what to do:

## 1. Add `deferAutoMargin: true` to plot config

In pltly's `PlotlyProvider` or wherever `Plotly.newPlot`/`Plotly.react` is called, add `deferAutoMargin: true` to the config object. This defers margin calculation (legend/title/axis label measurement) to a `requestAnimationFrame` after the initial render, getting traces on screen 15-29% faster.

The layout may shift by a frame as margins adjust — acceptable tradeoff for faster first paint.

## 2. Pass explicit `width`/`height` in layout

If the container size is known (e.g. from a `useLayoutEffect` measurement), pass it in the layout to skip the synchronous `getComputedStyle()` reflow:

```tsx
Plotly.react(el, data, { ...layout, width: containerWidth, height: containerHeight }, config)
```

## 3. Can't use lite bundle (needs annotations)

This project uses `layout.annotations` for endpoint labels on rides plots. The lite bundle (`plotly.js/lite`) strips the annotations component, so it can't be used here.

## 4. `deferAutoMargin` is the main win

Since both projects need the annotations component (and thus the basic/minimal bundle), the lite bundle isn't applicable. The main benefit is:
- **`deferAutoMargin: true`**: 15-29% faster time to first paint
- **Explicit dimensions**: skip `getComputedStyle()` reflow
- **Lazy selections**: less init overhead (automatic, no code change needed)

## What you get without any changes

Just by updating the plotly.js fork (via `pds gh plotly` or `pds l plotly`), you get:
- Lazy-loaded selections module (less init overhead)
- `performance.measure()` instrumentation visible in DevTools
- The `legendsymbol.path` attribute for custom legend icons
- Flush legend toggle rects (no hover gaps)

## Where to apply `deferAutoMargin`

The config change should ideally go in **pltly** (the React wrapper), not in each consumer app. That way all apps benefit. The pltly `PlotlyProvider` or `usePlot` hook is where `Plotly.react()` is called — add `deferAutoMargin: true` to the config there, possibly as an opt-in prop.
