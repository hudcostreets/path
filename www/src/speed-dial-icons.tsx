// SpeedDial icons (small, ~1em). HCCS is brand-color (rendered as <img> so
// its native green isn't tinted by SpeedDial's `currentColor: --kbd-text`);
// the rest are monochrome SVGs that inherit currentColor.

export function HccsIcon() {
  // Cropped from `abp-partnership.svg` (viewBox tightened around the HCCS
  // green-circle badge + `overflow:hidden` on the source SVG to drop the
  // adjacent vertical divider). `<img>` keeps the brand green.
  //
  // 1.45em compensates for the fact that the badge doesn't fill its 145×145
  // viewBox edge-to-edge (the perimeter text adds margin inside the disk's
  // bounding box). Without it, the visible green disk reads as ~70% of the
  // GH octocat's apparent radius in adjacent SpeedDial buttons.
  return <img src="/hccs.svg" alt="" style={{ width: '1.45em', height: '1.45em', verticalAlign: 'middle' }} />
}

/** Theme-cycler icon: sun (light), moon (dark), or A (system/auto). */
export function ThemeCycleIcon({ theme }: { theme: 'light' | 'dark' | 'system' }) {
  const style = { width: '1em', height: '1em' } as const
  if (theme === 'light') {
    // Sun
    return (
      <svg viewBox="0 0 24 24" style={style} fill="currentColor">
        <circle cx="12" cy="12" r="4" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="2" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="22" />
          <line x1="2" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="22" y2="12" />
          <line x1="4.93" y1="4.93" x2="7.05" y2="7.05" />
          <line x1="16.95" y1="16.95" x2="19.07" y2="19.07" />
          <line x1="4.93" y1="19.07" x2="7.05" y2="16.95" />
          <line x1="16.95" y1="7.05" x2="19.07" y2="4.93" />
        </g>
      </svg>
    )
  }
  if (theme === 'dark') {
    // Crescent moon
    return (
      <svg viewBox="0 0 24 24" style={style} fill="currentColor">
        <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
      </svg>
    )
  }
  // System: half-sun / half-moon (auto)
  return (
    <svg viewBox="0 0 24 24" style={style} fill="currentColor">
      <path d="M12 3a9 9 0 0 0 0 18 9 9 0 0 0 0-18zm0 2v14a7 7 0 0 1 0-14z" />
    </svg>
  )
}

export function GhIcon() {
  return (
    <svg viewBox="0 0 16 16" style={{ width: '1em', height: '1em' }} fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
