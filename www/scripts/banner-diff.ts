#!/usr/bin/env npx tsx
/**
 * Screenshot both banner modes (paths vs text) and produce a perceptual diff.
 *
 * Usage: npx tsx scripts/banner-diff.ts [--width 600] [--port 8858]
 *
 * Outputs to tmp/banner/:
 *   paths.png   — original path-based SVG text
 *   text.png    — Montserrat text overlay
 *   diff.png    — perceptual diff (red = mismatch)
 *   sxs.png     — side-by-side: paths | text | diff
 *   report.txt  — mismatch pixel count and percentage
 */
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

const WIDTH = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--width') ?? '600')
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '8858')
const BASE = `http://localhost:${PORT}`
const OUT = join(import.meta.dirname, '..', 'tmp', 'banner')

mkdirSync(OUT, { recursive: true })

async function screenshotBanner(mode: 'paths' | 'text'): Promise<Buffer> {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 400 } })
  // Use the main page with ?banner param, not /banner (which has multiple wrappers)
  await page.goto(`${BASE}/?banner=${mode}`, { waitUntil: 'networkidle' })
  // Wait for fonts to load
  await page.waitForFunction(() => document.fonts.ready)
  await page.waitForTimeout(500)

  const banner = page.locator('.abp-banner-wrap').first()
  const buf = await banner.screenshot({ type: 'png' })
  await browser.close()
  return buf as Buffer
}

async function main() {
  console.log(`Capturing banners at width=${WIDTH} from ${BASE}...`)

  const [pathsBuf, textBuf] = await Promise.all([
    screenshotBanner('paths'),
    screenshotBanner('text'),
  ])

  writeFileSync(join(OUT, 'paths.png'), pathsBuf)
  writeFileSync(join(OUT, 'text.png'), textBuf)
  console.log(`  paths.png: ${pathsBuf.length} bytes`)
  console.log(`  text.png:  ${textBuf.length} bytes`)

  // Decode PNGs
  const pathsPng = PNG.sync.read(pathsBuf)
  const textPng = PNG.sync.read(textBuf)

  // Ensure same dimensions (pad smaller if needed)
  const w = Math.max(pathsPng.width, textPng.width)
  const h = Math.max(pathsPng.height, textPng.height)

  function padToSize(png: PNG, targetW: number, targetH: number): PNG {
    if (png.width === targetW && png.height === targetH) return png
    const out = new PNG({ width: targetW, height: targetH, fill: true })
    // Fill with white
    out.data.fill(255)
    PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0)
    return out
  }

  const pPadded = padToSize(pathsPng, w, h)
  const tPadded = padToSize(textPng, w, h)

  // Compute diff
  const diffPng = new PNG({ width: w, height: h })
  const mismatchCount = pixelmatch(pPadded.data, tPadded.data, diffPng.data, w, h, {
    threshold: 0.15,
    alpha: 0.3,
    diffColor: [255, 0, 0],
    diffColorAlt: [0, 0, 255],
  })

  const totalPixels = w * h
  const mismatchPct = (mismatchCount / totalPixels * 100).toFixed(2)

  writeFileSync(join(OUT, 'diff.png'), PNG.sync.write(diffPng))
  console.log(`  diff.png: ${mismatchCount} mismatched pixels (${mismatchPct}% of ${totalPixels})`)

  // Create side-by-side: paths | text | diff
  const gap = 4
  const sxsW = w * 3 + gap * 2
  const sxs = new PNG({ width: sxsW, height: h, fill: true })
  // Fill gaps with light gray
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < sxsW; x++) {
      const idx = (y * sxsW + x) * 4
      sxs.data[idx] = sxs.data[idx + 1] = sxs.data[idx + 2] = 200
      sxs.data[idx + 3] = 255
    }
  }
  PNG.bitblt(pPadded, sxs, 0, 0, w, h, 0, 0)
  PNG.bitblt(tPadded, sxs, 0, 0, w, h, w + gap, 0)
  PNG.bitblt(diffPng, sxs, 0, 0, w, h, w * 2 + gap * 2, 0)

  writeFileSync(join(OUT, 'sxs.png'), PNG.sync.write(sxs))
  console.log(`  sxs.png: ${sxsW}×${h} (paths | text | diff)`)

  // Report
  const report = [
    `Banner diff report`,
    `Width: ${WIDTH}px`,
    `Image size: ${w}×${h}`,
    `Mismatched pixels: ${mismatchCount} / ${totalPixels} (${mismatchPct}%)`,
  ].join('\n')
  writeFileSync(join(OUT, 'report.txt'), report + '\n')
  console.log(`\n${report}`)
}

main().catch(e => { console.error(e); process.exit(1) })
