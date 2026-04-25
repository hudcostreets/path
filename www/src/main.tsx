import { MDXProvider } from "@mdx-js/react"
import { createTheme, ThemeProvider as MuiThemeProvider } from "@mui/material"
import A from "@rdub/base/a"
import { Theme } from "@rdub/icons/Tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HotkeysProvider, Omnibar, SequenceModal, SpeedDial, type SpeedDialAction } from "use-kbd"
import { PlotlyProvider } from "pltly/react"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import "use-kbd/styles.css"
import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.scss'
import './plot.scss'
import Body from './Body.mdx'
import { HccsIcon, GhIcon, ThemeCycleIcon } from './speed-dial-icons'
import { applyTheme, ThemeProvider, useTheme } from './ThemeContext'

const BridgeTunnel = lazy(() => import('./BridgeTunnel'))
const BannerPage = lazy(() => import('./ABPBanner').then(m => ({ default: m.BannerPage })))
const StationsMap = lazy(() => import('./StationsMap'))

const components = {
  a: A,
}

const queryClient = new QueryClient()

const theme = createTheme(Theme)

const staticSpeedDialActions: SpeedDialAction[] = [
  {
    key: 'hccs',
    label: 'Hudson County Complete Streets',
    icon: <HccsIcon />,
    href: 'https://hudcostreets.org/panynj',
  },
  {
    key: 'github',
    label: 'GitHub',
    icon: <GhIcon />,
    href: 'https://github.com/hudcostreets/path',
  },
]

if (new URLSearchParams(window.location.search).has('clean')) {
  document.documentElement.classList.add('clean')
}

// Synchronously apply persisted/default theme before React's first paint so
// the page doesn't flash the wrong theme. ThemeProvider re-applies on mount.
{
  const stored = (localStorage.getItem('path-theme') ?? 'dark') as 'light' | 'dark' | 'system'
  const actual: 'light' | 'dark' = stored === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : stored
  applyTheme(actual)
}

/** Wraps the SpeedDial with a theme-cycler action that pulls live state from
 *  ThemeContext so the icon reflects the current theme. */
function AppSpeedDial() {
  const { theme, cycleTheme } = useTheme()
  const themeAction: SpeedDialAction = {
    key: 'theme',
    label: `Theme: ${theme[0].toUpperCase()}${theme.slice(1)} (click to cycle)`,
    icon: <ThemeCycleIcon theme={theme} />,
    onClick: cycleTheme,
  }
  return <SpeedDial actions={[themeAction, ...staticSpeedDialActions]} chevronMode="badge" />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <MuiThemeProvider theme={theme}>
        <QueryClientProvider client={queryClient}>
          <PlotlyProvider loader={() => import('plotly.js/basic').then(m => (m as any).default ?? m)}>
            <HotkeysProvider>
              <BrowserRouter>
                <Routes>
                  <Route path="/banner" element={
                    <Suspense fallback={null}>
                      <BannerPage />
                    </Suspense>
                  } />
                  <Route path="/bt" element={
                    <Suspense fallback={<div className="loading" style={{ height: 450 }}>Loading...</div>}>
                      <BridgeTunnel />
                    </Suspense>
                  } />
                  <Route path="/map" element={
                    <Suspense fallback={<div className="loading" style={{ height: 450 }}>Loading...</div>}>
                      <StationsMap />
                    </Suspense>
                  } />
                  <Route path="*" element={
                    <MDXProvider components={components}>
                      <Body />
                    </MDXProvider>
                  } />
                </Routes>
              </BrowserRouter>
              <Omnibar />
              <SequenceModal />
              <AppSpeedDial />
            </HotkeysProvider>
          </PlotlyProvider>
        </QueryClientProvider>
      </MuiThemeProvider>
    </ThemeProvider>
  </StrictMode>,
)
