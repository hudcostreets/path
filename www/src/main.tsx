import { MDXProvider } from "@mdx-js/react"
import { createTheme, ThemeProvider } from "@mui/material"
import A from "@rdub/base/a"
import { Theme } from "@rdub/icons/Tooltip"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HotkeysProvider, Omnibar, SequenceModal, SpeedDial, type SpeedDialAction } from "use-kbd"
import "use-kbd/styles.css"
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.scss'
import './plot.scss'
import Body from './Body.mdx'
import { HccsIcon, GhIcon } from './speed-dial-icons'

const components = {
  a: A,
}

const queryClient = new QueryClient()

const theme = createTheme(Theme)

const speedDialActions: SpeedDialAction[] = [
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <HotkeysProvider>
          <MDXProvider components={components}>
            <Body />
          </MDXProvider>
          <Omnibar />
          <SequenceModal />
          <SpeedDial actions={speedDialActions} chevronMode="badge" />
        </HotkeysProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
