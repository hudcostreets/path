import { useEffect } from "react"

/**
 * Scroll restoration for SPAs with async-loaded content (plots, data tables).
 *
 * - On mount: if URL has a hash, repeatedly scroll the target into view
 *   until the user scrolls or 5s elapse (handles plots loading below the
 *   target that don't affect its position, and content above the target
 *   that would push it down).
 * - On user scroll (debounced): update the URL hash to the nearest `h2[id]`
 *   above the viewport top, using `replaceState` (doesn't pollute history).
 *   This way, any refresh lands at the user's current section without
 *   needing to save pixel offsets to sessionStorage.
 *
 * Ported from ../crashes/www/src/lib/useScrollAnchor.ts. Use once at app root.
 */
export function useScrollAnchor() {
  useEffect(() => {
    if (!('scrollRestoration' in history)) return
    history.scrollRestoration = 'manual'

    const hash = window.location.hash?.slice(1)
    let userScrolled = false

    if (hash) {
      const start = Date.now()
      const maxMs = 5000

      const onUserInput = () => { userScrolled = true }
      window.addEventListener('wheel', onUserInput, { passive: true, once: true })
      window.addEventListener('touchstart', onUserInput, { passive: true, once: true })
      window.addEventListener('keydown', onUserInput, { once: true })

      let revealed = false
      const reveal = () => {
        if (revealed) return
        revealed = true
        document.documentElement.style.visibility = ''
      }
      const rescroll = () => {
        if (userScrolled || Date.now() - start > maxMs) return
        const el = document.getElementById(hash)
        if (el) {
          el.scrollIntoView({ block: 'start' })
          reveal()
        }
      }
      rescroll()

      const observer = new MutationObserver(rescroll)
      observer.observe(document.body, { childList: true, subtree: true })
      window.setTimeout(() => { observer.disconnect(); reveal() }, maxMs)
    }

    // Debounced scroll → update URL hash to nearest section header above the
    // upper third of the viewport (2-screen look-ahead so the hash advances
    // as a header enters view, not only when it crosses the very top).
    //
    // Track `h2` AND `h3` in DOM order so scrolling from an h2 section into
    // a nested h3 sub-section (e.g. EvE H2 `#eve` → EvE bars H3 `#eve-bars`) flips
    // the hash to the h3 rather than sticking on the h2 above it.
    //
    // Each candidate has either a plain `id="…"` or the `@rdub/base` Heading
    // shape (`<hN><span id="…" style="position:absolute;top:-4em"/>…`), which
    // puts the id on an offset sentinel span so `#id` scrolls above the
    // visual heading. `id` comes from the child span in that case.
    let timer: number | undefined
    const updateHash = () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('h2, h3'))
      const headers = nodes
        .map(h => ({ h, id: h.id || h.querySelector<HTMLElement>('[id]')?.id }))
        .filter((x): x is { h: HTMLElement, id: string } => Boolean(x.id))
      if (headers.length === 0) return
      const threshold = window.innerHeight / 3
      let current: string | null = null
      for (const { h, id } of headers) {
        if (h.getBoundingClientRect().top <= threshold) current = id
        else break
      }
      const newHash = current ? `#${current}` : ''
      if (newHash !== window.location.hash) {
        history.replaceState(null, '', newHash || window.location.pathname + window.location.search)
      }
    }
    const onScroll = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(updateHash, 150)
    }
    window.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.clearTimeout(timer)
    }
  }, [])
}
