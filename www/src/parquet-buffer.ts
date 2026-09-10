import type { AsyncBuffer } from 'hyparquet'

// hyparquet's `asyncBufferFromUrl` first issues a HEAD to learn the byte length,
// then ranged GETs. R2 returns 503 for the browser's concurrent HEAD probes at
// page load (S3 returned 200), so hyparquet falls back to a ranged GET and the
// HEADs show up as failed requests. Our parquets are all small (≤~450KB), so we
// skip the HEAD entirely: fetch the whole file in one GET and hand hyparquet an
// in-memory AsyncBuffer. No HEAD, one round-trip (faster than HEAD + range here).
export async function bufferFromUrl(url: string): Promise<AsyncBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`)
  const buf = await res.arrayBuffer()
  return { byteLength: buf.byteLength, slice: (start, end) => buf.slice(start, end) }
}
