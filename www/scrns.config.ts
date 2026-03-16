import type { Screens, ScreencastAction } from 'scrns'

const width = 1200
const height = 900
const selector = '.js-plotly-plot'
const loadTimeout = 20_000

const LI_SELECTOR = '.plot-container:first-child .legend .traces'

function stationGifActions(count: number): ScreencastAction[] {
  const actions: ScreencastAction[] = [
    { type: 'wait', duration: 1500 },
  ]
  for (let i = 0; i < count; i++) {
    actions.push({ type: 'hover', selector: LI_SELECTOR, index: i })
    const isEdge = i === 0 || i === count - 1
    actions.push({ type: 'wait', duration: isEdge ? 1200 : 600 })
  }
  // Hover away to reset
  actions.push({ type: 'hover', x: 10, y: 10 })
  actions.push({ type: 'wait', duration: 1500 })
  return actions
}

const screens: Screens = {
  // Static screenshots
  'homepage': {
    query: '?g=s&l=h',
    width,
    height,
    selector,
    loadTimeout,
  },
  'homepage-recovery': {
    query: '?g=s&l=h&m=p',
    width,
    height,
    selector,
    loadTimeout,
  },
  'bt': {
    path: '/bt',
    width,
    height,
    selector,
    loadTimeout,
  },
  // GIF: cycle through each station (clean mode, dark)
  'stations': {
    query: '?g=s&l=h&clean',
    width,
    height,
    selector,
    loadTimeout,
    actions: stationGifActions(13),
    fps: 2,
    gifQuality: 10,
    loop: true,
  },
}

export default screens
