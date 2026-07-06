#!/usr/bin/env node
// Post-build: strip DVX-tracked files from `dist/` that we don't need
// origin-served. In prod, `vite-plugin-dvc` rewrites `dvcResolve()` calls to
// S3 URLs — so the raw `.pqt` / `.json` blobs Vite auto-copies from `public/`
// into `dist/` are dead weight. Also strip every `.dvc` sidecar copied along.
//
// Keep-list: files that must be served from `path.hudcostreets.org` directly.
//   - `og.png`, `og-bt.png`, `og-map.jpg`: social-media OG fetchers hit the
//     canonical URL, not S3.
// The pie-map .gif/.mp4 used to be here too, but they now live at stable
// `s3://hudcostreets/path/pie-map-24h.{gif,mp4}` URLs (published by the
// `path-data publish-static` DVX side-effect stage), so they no longer need
// to ship in the deploy artifact.
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const DIST = join(ROOT, 'dist')
const PUBLIC = join(ROOT, 'public')

const KEEP = new Set([
  'og.png',
  'og-bt.png',
  'og-map.jpg',
])

async function main() {
  const publicEntries = await readdir(PUBLIC)
  const dvcTracked = publicEntries
    .filter(n => n.endsWith('.dvc'))
    .map(n => n.replace(/\.dvc$/, ''))

  const toDelete = []
  for (const name of dvcTracked) {
    if (!KEEP.has(name)) toDelete.push(name)
    toDelete.push(`${name}.dvc`)  // always strip sidecars from dist
  }

  let bytes = 0, count = 0
  for (const name of toDelete) {
    const path = join(DIST, name)
    try {
      const s = await stat(path)
      await unlink(path)
      bytes += s.size
      count++
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  console.log(`strip-dvc-artifacts: removed ${count} files (${(bytes / 1024).toFixed(1)} KB)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
