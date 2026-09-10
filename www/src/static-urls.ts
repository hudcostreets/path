// Stable public URLs for select static assets (as opposed to DVX-tracked
// files, whose URLs are md5-cache paths that rotate on every regeneration).
// Mirrored into place by `path-data publish-static` — a side-effect DVX
// stage (`www/public/publish-static.dvc`) that re-runs whenever the
// underlying blob's md5 changes. Served from R2 (bucket `path`) via the
// path.hccs.dev custom domain.
const R2_STATIC_BASE = 'https://path.hccs.dev'

export const PIE_MAP_GIF_URL = `${R2_STATIC_BASE}/pie-map-24h.gif`
export const PIE_MAP_MP4_URL = `${R2_STATIC_BASE}/pie-map-24h.mp4`
