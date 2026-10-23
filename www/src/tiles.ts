// Stadia Maps raster basemaps. Browser requests are authorized by domain
// (`*.hccs.dev`, `*.hudcostreets.org`; localhost needs nothing), so no API key.
export const TILE_DARK = 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png'
export const TILE_LIGHT = 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'
export const TILE_MAX_ZOOM = 20

export const TILES_ATTR_HTML =
  '© <a href="https://stadiamaps.com/" target="_blank" rel="noopener">Stadia Maps</a> · '
  + '© <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · '
  + '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
