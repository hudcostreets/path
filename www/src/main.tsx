import { MDXProvider } from "@mdx-js/react"
import A from "@rdub/base/a"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.scss'
import './plot.scss'
import Body from './Body.mdx'
import { createTheme, ThemeProvider } from "@mui/material";
import { Theme } from "@rdub/icons/Tooltip";

const components = {
  a: A,
}

const queryClient = new QueryClient()

const theme = createTheme(Theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={queryClient}>
        <MDXProvider components={components}>
          <Body />
        </MDXProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
