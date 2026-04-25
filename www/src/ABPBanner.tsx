import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useActions } from "use-kbd"
import { useDark } from "./plot-utils"

const SUBTITLE_FILL = "#22783A"

export type BannerMode = "paths" | "text"

function InlineSVG({ src, className }: { src: string, className?: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    fetch(src).then(r => r.text()).then(setSvg)
  }, [src])
  if (!svg) return null
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />
}

function BannerContent({ mode }: { mode: BannerMode }) {
  const textMode = mode === "text"
  const dark = useDark()
  const svgSrc = dark
    ? (textMode ? "/abp-banner-dark-deco.svg" : "/abp-banner-dark.svg")
    : (textMode ? "/abp-banner-deco.svg" : "/abp-banner.svg")
  const headingFill = dark ? "white" : "#100F0D"

  return (
    <div className="abp-banner-wrap">
      <InlineSVG src={svgSrc} className="abp-banner-inline" />
      {textMode && (
        <div className="abp-banner-text">
          <span className="abp-banner-heading" style={{ color: headingFill }}>A Better PATH</span>
          <span className="abp-banner-subtitle" style={{ color: SUBTITLE_FILL }}>A <strong>Hudson County Complete Streets</strong> Campaign</span>
        </div>
      )}
    </div>
  )
}

export default function ABPBanner() {
  const [searchParams] = useSearchParams()
  const paramMode = searchParams.get('banner') as BannerMode | null
  const [toggleMode, setToggleMode] = useState<BannerMode>("text")
  const mode = paramMode ?? toggleMode

  useActions({
    'toggle-banner-text': {
      label: 'Toggle banner text/paths',
      defaultBindings: ['b'],
      handler: () => setToggleMode(prev => prev === "paths" ? "text" : "paths"),
    },
  })

  return (
    <div className="abp-header">
      <BannerContent mode={mode} />
    </div>
  )
}

/** Standalone banner comparison page with side-by-side and toggle */
export function BannerPage() {
  const dark = useDark()
  const bg = dark ? '#1a1a2e' : '#fff'
  const [mode, setMode] = useState<BannerMode>("paths")

  useActions({
    'toggle-banner-text-page': {
      label: 'Toggle banner text/paths',
      defaultBindings: ['b'],
      handler: () => setMode(prev => prev === "paths" ? "text" : "paths"),
    },
  })

  return (
    <div style={{ padding: '1rem', background: bg, minHeight: '100vh' }}>
      <div style={{ textAlign: 'center', fontFamily: 'system-ui', marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem' }}>Banner comparison</h2>
        <p style={{ color: '#888', margin: 0 }}>
          Press <kbd style={{ padding: '0.1em 0.4em', border: '1px solid #ccc', borderRadius: 3, background: '#f5f5f5' }}>b</kbd> to
          toggle · currently showing: <strong>{mode}</strong>
        </p>
      </div>

      {/* Toggle view */}
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem', fontFamily: 'system-ui', color: '#888' }}>
          toggle view ({mode})
        </div>
        <BannerContent mode={mode} />
      </div>

      {/* Side-by-side */}
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center', flex: '1 1 300px', maxWidth: 500 }}>
          <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem', fontFamily: 'system-ui', color: '#888' }}>
            paths (original SVG)
          </div>
          <BannerContent mode="paths" />
        </div>
        <div style={{ textAlign: 'center', flex: '1 1 300px', maxWidth: 500 }}>
          <div style={{ fontSize: '0.8rem', marginBottom: '0.5rem', fontFamily: 'system-ui', color: '#888' }}>
            text (Montserrat overlay)
          </div>
          <BannerContent mode="text" />
        </div>
      </div>
    </div>
  )
}
