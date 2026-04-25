import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ActualTheme = 'light' | 'dark'

interface ThemeContextType {
  theme: Theme
  actualTheme: ActualTheme
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
}

const STORAGE_KEY = 'path-theme'
const DEFAULT: Theme = 'dark'

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const readStored = (): Theme => {
  if (typeof window === 'undefined') return DEFAULT
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT
}

const readSystem = (): ActualTheme =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light'

/** Apply theme to documentElement: `data-theme` for SCSS gating, `color-scheme`
 *  for browser canvas/form/scrollbar colors. Exposed for early synchronous use
 *  in main.tsx so first paint matches the persisted/default theme. */
export function applyTheme(actual: ActualTheme): void {
  const root = document.documentElement
  root.setAttribute('data-theme', actual)
  root.style.colorScheme = actual
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored)
  const [systemTheme, setSystemTheme] = useState<ActualTheme>(readSystem)
  const actualTheme: ActualTheme = theme === 'system' ? systemTheme : theme

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Cross-tab sync via storage events.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) setThemeState(e.newValue as Theme)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme)
    applyTheme(actualTheme)
  }, [theme, actualTheme])

  const setTheme = (t: Theme) => setThemeState(t)
  const cycleTheme = () => setThemeState(prev =>
    prev === 'dark' ? 'light' : prev === 'light' ? 'system' : 'dark',
  )

  return (
    <ThemeContext.Provider value={{ theme, actualTheme, setTheme, cycleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

/** Reactive boolean — components re-render on theme change. */
export function useDark(): boolean {
  return useTheme().actualTheme === 'dark'
}

/** Non-reactive read for module-scope helpers (no React subscription).
 *  Reads `data-theme` directly, so callers see the current value at call time
 *  but do NOT auto-re-render on changes. Pair with `useDark()` if reactivity
 *  matters at the call site. */
export function isDark(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}
