// Minimal compressors object for hyparquet: only ZSTD (used by `hourly.pqt`
// and `entries_vs_exits.pqt`) + SNAPPY (native default in some parquet
// writers). Avoids pulling `hyparquet-compressors`' full bundle
// (brotli/gzip/lz4/wasm-snappy), which added ~130KB to the main JS chunk.
//
// If a future dataset needs brotli/gzip/lz4, swap this for
// `import { compressors } from 'hyparquet-compressors'`.
import { decompress as decompressZstd } from 'fzstd'
import type { Compressors } from 'hyparquet'

export const compressors: Compressors = {
  ZSTD: (input) => decompressZstd(input),
}
