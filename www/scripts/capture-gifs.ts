#!/usr/bin/env -S npx tsx
/**
 * Capture GIF frames by hovering each legend item in sequence.
 * Uses Playwright directly for reliable mouse interactions.
 *
 * Usage: npx tsx scripts/capture-gifs.ts [--port 8858] [--out tmp/gif-frames]
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') ?? '8858')
const OUT = resolve(process.argv.find((_, i, a) => a[i - 1] === '--out') ?? 'public')
const WIDTH = 1200
const HEIGHT = 1200
const FPS = 2
const BEAT_FRAMES = 3  // extra frames for first/last
const BASE = `http://localhost:${PORT}`

mkdirSync(OUT, { recursive: true })

async function captureStationGif() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: 'dark',
  })
  await page.goto(`${BASE}/?g=s&l=h&clean`)
  await page.waitForSelector('.legend .traces .legendtext', { timeout: 20_000 })
  await page.waitForTimeout(2000) // let plotly fully render

  // Get plot1's legend item positions (first .plot-container only)
  const items = await page.$$eval('.plot-container:first-child .legend .traces', (traces, stationCount) =>
    traces.slice(0, stationCount).map(t => {
      const text = t.querySelector('.legendtext')?.textContent?.trim() ?? ''
      const rect = t.getBoundingClientRect()
      return { name: text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }),
    13, // number of stations
  )
  console.log(`Found ${items.length} legend items: ${items.map(i => i.name).join(', ')}`)

  const frames: string[] = []

  // Opening frame: all traces visible (1 frame, serves as intro)
  const allFrame = join(OUT, 'station-all.png')
  await page.screenshot({ path: allFrame })
  frames.push(allFrame)

  // Hover each station in order (1 frame each, uniform timing)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    console.log(`  Hovering: ${item.name}`)
    await page.mouse.move(item.x, item.y)
    await page.waitForTimeout(300)

    const framePath = join(OUT, `station-${String(i).padStart(2, '0')}-${item.name.replace(/\s+/g, '-')}.png`)
    await page.screenshot({ path: framePath })
    frames.push(framePath)
  }

  // Closing: hover out, all traces (longer pause before loop)
  await page.mouse.move(10, 10)
  await page.waitForTimeout(300)
  const finalFrame = join(OUT, 'station-final.png')
  await page.screenshot({ path: finalFrame })
  for (let i = 0; i < BEAT_FRAMES; i++) frames.push(finalFrame)

  await browser.close()

  // Assemble GIF with ffmpeg
  const concatFile = join(OUT, 'station-frames.txt')
  writeFileSync(concatFile, frames.map(f => `file '${f}'`).join('\n'))
  const gifPath = join(OUT, 'stations.gif')
  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-r', String(FPS), '-i', concatFile,
    '-vf', 'scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
    gifPath,
  ])
  console.log(`\nSaved: ${gifPath} (${frames.length} frames)`)
}

async function captureOgImage() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    colorScheme: 'dark',
  })
  await page.goto(`${BASE}/?g=s&l=h&clean`)
  await page.waitForSelector('.legend .traces .legendtext', { timeout: 20_000 })
  await page.waitForTimeout(2000)
  const ogPath = join(OUT, 'og.png')
  await page.screenshot({ path: ogPath })
  console.log(`Saved: ${ogPath}`)
  await browser.close()
}

async function main() {
  await Promise.all([
    captureStationGif(),
    captureOgImage(),
  ])
}

main().catch(e => { console.error(e); process.exit(1) })
