#!/usr/bin/env node
// Record a 24-hour pie-map cycle deterministically: step the StationsMap
// through each integer hour via the `?record` window hook, screenshot at
// each settled state, then stitch frames into a GIF (+ MP4) with ffmpeg.
//
// Live playback recording (via scrns animate) was unreliable: headless
// chromium frequently captured the page mid-load with empty pies, and the
// internal play tick didn't always advance in step with the screenshot
// loop. Driving the hour ourselves avoids both classes of bug.
import { mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { chromium } from '@playwright/test'

// CLI flags:
//   --per-hour, -p N    Frames per integer hour (default 2). Higher = smoother.
//   --loop-seconds, -l S Target GIF playback seconds (default 6). FPS = frames/S.
//   --workers, -w N     Parallel render workers (default 1). Each worker owns
//                       its own playwright page in the same browser, picking
//                       frames by index mod N. Page-load (~10s, dominated by
//                       parquet fetch + parse) is paid once per worker, so
//                       parallelism only pays off at high frame counts; below
//                       ~100 frames sequential is faster.
//   --suffix, -s STR    Output filename suffix (default `-<N>fph`).
//   --desc, -d [STR]    Burn a title overlay onto the recording (in-page,
//                       not via ffmpeg). Bare flag uses the page defaults;
//                       `--desc "Title"` overrides title; `--desc "T|Sub"`
//                       overrides both. Pass `--desc ''` to disable.
//   --range, -r RANGE   Date range to average over. `YYYY` = full year;
//                       `YYYY-MM` = single month; `YYYY-MM,YYYY-MM` =
//                       inclusive range. Default: page default (full data).
// HOST/PORT/OUT_DIR remain env-only.
function parseArgs(argv) {
  // `desc` sentinel: undefined = not passed, null = bare flag (use page
  // defaults), string = explicit value (empty string disables overlay).
  const args = { perHour: 2, loopSeconds: 6, workers: 1, suffix: null, desc: undefined, range: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = argv[i + 1]
    if (a === '--per-hour' || a === '-p') { args.perHour = Number(next); i++ }
    else if (a === '--loop-seconds' || a === '-l') { args.loopSeconds = Number(next); i++ }
    else if (a === '--workers' || a === '-w') { args.workers = Number(next); i++ }
    else if (a === '--suffix' || a === '-s') { args.suffix = next; i++ }
    else if (a === '--range' || a === '-r') { args.range = next; i++ }
    else if (a === '--desc' || a === '-d') {
      // Treat a following value as the desc unless it looks like another flag.
      if (next !== undefined && !next.startsWith('-')) { args.desc = next; i++ }
      else args.desc = null
    }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: record-map.mjs [--per-hour N] [--loop-seconds S] [--workers N] [--suffix STR] [--desc [TEXT]] [--range RANGE]')
      process.exit(0)
    }
    else throw new Error(`unknown arg: ${a}`)
  }
  return args
}
const { perHour, loopSeconds, workers, suffix: userSuffix, desc, range } = parseArgs(process.argv.slice(2))
// Normalize range spec → [fromYm, toYm]. Accept `2025`, `2025-03`, `2025-01,2025-12`.
function parseRange(spec) {
  if (!spec) return null
  if (spec.includes(',')) {
    const [from, to] = spec.split(',')
    return [from.trim(), to.trim()]
  }
  if (/^\d{4}$/.test(spec)) return [`${spec}-01`, `${spec}-12`]
  return [spec, spec]
}
const rangePair = parseRange(range)
const HOST = process.env.HOST ?? 'localhost'
const PORT = process.env.PORT ?? '8859'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/scrns-out'
const FRAMES_DIR = join(OUT_DIR, 'frames')
const VIEWPORT = { width: 1200, height: 700 }
const TILE_SETTLE_MS = 1500
// `perHour` frames per integer hour. Examples: 1 = 24 frames at hour ticks
// (no interpolation visible); 2 = half-hour; 3 = every 20min; 4 = every
// 15min. FPS scales so each full revolution lasts `loopSeconds`.
const HOUR_STEP = 1 / perHour
const FRAME_COUNT = Math.round(24 * perHour)
const FPS = Math.max(2, Math.round(FRAME_COUNT / loopSeconds))
const SUFFIX = userSuffix ?? `-${perHour}fph`
// We snap visuals instantly (animMs=0) and rely on the rAF settle below
// rather than waiting for a CSS tween — each frame is a discrete state, no
// reason to pay tween wall-clock per step.
const RECORD_ANIM_MS = 0
const STEP_SETTLE_MS = 30  // ~one rAF + safety

await rm(FRAMES_DIR, { recursive: true, force: true })
await mkdir(FRAMES_DIR, { recursive: true })

const browser = await chromium.launch()
// `desc === undefined` → no `?desc` at all. `null` → bare flag (page defaults).
// Anything else → URL-encoded explicit value (including `''` to disable).
const descSuffix = desc === undefined ? ''
  : desc === null ? '&desc'
  : `&desc=${encodeURIComponent(desc)}`
const url = `http://${HOST}:${PORT}/map?clean&record${descSuffix}`

async function setupPage() {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForSelector('.station-pie', { timeout: 20_000 })
  await page.waitForFunction('window.__pathMap?.setHour', null, { timeout: 5_000 })
  await page.waitForTimeout(TILE_SETTLE_MS)
  await page.evaluate(ms => window.__pathMap.setAnimMs(ms), RECORD_ANIM_MS)
  if (rangePair) {
    await page.evaluate(([f, t]) => window.__pathMap.setRange(f, t), rangePair)
    // Re-pies after range change; let recompute settle.
    await page.waitForTimeout(120)
  }
  return page
}

console.log(`Recording ${FRAME_COUNT} frames @ ${HOUR_STEP.toFixed(4)}h steps → ${FPS}fps`
  + ` · ${workers} worker${workers === 1 ? '' : 's'}`)
const t0 = performance.now()
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  const page = await setupPage()
  // Worker `w` owns frames { w, w+workers, w+2*workers, … }. Striping (rather
  // than contiguous slicing) keeps each worker's hour sequence spread across
  // the cycle, so any per-hour rendering cost averages out instead of piling
  // onto one worker.
  for (let i = w; i < FRAME_COUNT; i += workers) {
    const h = i * HOUR_STEP
    await page.evaluate(hr => window.__pathMap.setHour(hr), h)
    await page.waitForTimeout(STEP_SETTLE_MS)
    const out = join(FRAMES_DIR, `frame-${String(i).padStart(3, '0')}.png`)
    await page.screenshot({ path: out, fullPage: false })
  }
  await page.context().close()
}))
const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
console.log(`Captured ${FRAME_COUNT} frames in ${elapsed}s`)
await browser.close()

const gifPath = join(OUT_DIR, `pie-map-24h${SUFFIX}.gif`)
const mp4Path = join(OUT_DIR, `pie-map-24h${SUFFIX}.mp4`)
const palette = join(OUT_DIR, `palette${SUFFIX}.png`)
console.log('Encoding GIF…')
execFileSync('ffmpeg', [
  '-y',
  '-framerate', String(FPS),
  '-i', join(FRAMES_DIR, 'frame-%03d.png'),
  '-vf', 'palettegen=stats_mode=full',
  palette,
], { stdio: 'inherit' })
execFileSync('ffmpeg', [
  '-y',
  '-framerate', String(FPS),
  '-i', join(FRAMES_DIR, 'frame-%03d.png'),
  '-i', palette,
  '-lavfi', `fps=${FPS},paletteuse=dither=bayer:bayer_scale=5`,
  '-loop', '0',
  gifPath,
], { stdio: 'inherit' })
console.log(`Wrote ${gifPath}`)

console.log('Encoding MP4…')
execFileSync('ffmpeg', [
  '-y',
  '-framerate', String(FPS),
  '-i', join(FRAMES_DIR, 'frame-%03d.png'),
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  // Loop count via stream copy isn't a thing in MP4; use -stream_loop for input.
  // Instead, just emit a single pass; players auto-loop based on container/player.
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  mp4Path,
], { stdio: 'inherit' })
console.log(`Wrote ${mp4Path}`)
