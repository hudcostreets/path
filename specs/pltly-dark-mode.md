# Integrate `pltly` + dark mode support

## Goal

Replace raw `react-plotly.js` usage with [`pltly`] to get:
- Dark/light mode theming (auto-detects `prefers-color-scheme`)
- Hover-to-highlight legend traces
- Click-to-solo legend traces
- Mobile touch scroll (instead of Plotly hijacking scroll events)
- Responsive margins/fonts based on container width

## Current state

- Three plot components: `LinePlots`, `StationPlots`, `MonthlyPlots`
- All use `react-plotly.js` `<Plot>` directly
- Hardcoded light colors: grid `#ddd`, text `#213547`, bg `#ffffff`
- `displayModeBar: false`, `scrollZoom: false`, `dragmode: false`, `fixedrange: true`
- No dark mode support anywhere (CSS or plots)
- Mobile: no touch-specific handling

## Plan

### 1. Add `pltly` dependency

```bash
cd www && pnpm add pltly
```

(Use `pds` if developing locally in tandem.)

### 2. Replace `<Plot>` with `pltly`'s `<Plot>`

Each component switches from:
```tsx
import Plot from 'react-plotly.js'
```
to:
```tsx
import { Plot } from 'pltly'
```

`pltly`'s `<Plot>` wraps Plotly with theme-aware defaults, hover-legend behavior, and mobile touch handling.

### 3. Theme integration

`pltly` auto-detects dark/light via `prefers-color-scheme` or a `data-theme` attribute. It provides `DARK_THEME` and `LIGHT_THEME` presets that set:
- Plot background, paper background
- Grid colors, axis line colors
- Font colors
- Legend styling

Use `useTheme()` hook or pass theme config to `<Plot>`. Remove hardcoded color values from plot layouts.

### 4. CSS dark mode

Add CSS variables and `prefers-color-scheme` media queries in `index.scss`:
- Body/root background and text colors
- Link colors
- Toggle button styling (MUI theme override or CSS)
- ABP banner/footer: check contrast on dark backgrounds
- `.loading` and `.error` backgrounds

The existing `@media (prefers-color-scheme: light)` block already exists but doesn't do much. Expand it to a proper dark/light system.

### 5. Hover-legend + solo traces

`pltly` provides `useTraceHighlight` which combines:
- **Hover**: dims other traces, highlights hovered one
- **Click**: solos/unsolos a trace (toggles visibility)

This replaces Plotly's default legend click behavior (which is clunky on mobile). Apply to all three plot components.

### 6. Mobile improvements

`pltly/mobile` provides:
- `autoMobileLayout`: adapts margins, font sizes, tick counts for narrow screens
- Touch scroll pass-through (fixes Plotly hijacking touch events on mobile)
- `isTouchDevice()` detection

Replace the current manual `narrow` breakpoint logic in `LinePlots` with `pltly`'s `useBreakpoints` / `useContainerWidth`.

## Files to modify

| File | Change |
|------|--------|
| `www/package.json` | Add `pltly` |
| `www/src/LinePlots.tsx` | Use `pltly` `<Plot>`, remove hardcoded colors, use theme |
| `www/src/StationPlots.tsx` | Use `pltly` `<Plot>`, add hover-legend |
| `www/src/MonthlyPlots.tsx` | Use `pltly` `<Plot>`, add hover-legend |
| `www/src/index.scss` | Dark mode CSS variables + media queries |
| `www/src/main.tsx` | Possibly wrap with theme provider |

## Open questions

- ABP banner/partnership images: do we need dark-mode variants, or do they work on dark backgrounds as-is?
- Toggle buttons: MUI's `ToggleButtonGroup` needs theme-aware styling. Use MUI's `createTheme` with dark mode, or just CSS?
- The collapsible JSON data explorer in LinePlots uses `@microlink/react-json-view` — check if it supports dark theme

[`pltly`]: https://gitlab.com/runsascoded/js/pltly
