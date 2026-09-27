import { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { ogUrl, routeMeta } from "./route-meta"

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  document.head.querySelector(`meta[${attr}="${key}"]`)?.setAttribute('content', content)
}

/** Keep `document.title` + description / `og:*` tags in sync with the
 *  current route on client-side navigation (the served HTML already has the
 *  right tags for the initial route; see `route-meta.ts`). */
export function useRouteMeta() {
  const { pathname } = useLocation()
  useEffect(() => {
    const meta = routeMeta(pathname)
    document.title = meta.title
    setMeta('name', 'description', meta.description)
    setMeta('property', 'og:title', meta.ogTitle)
    setMeta('property', 'og:description', meta.description)
    setMeta('property', 'og:image', meta.ogImage)
    setMeta('property', 'og:url', ogUrl(meta))
  }, [pathname])
}
