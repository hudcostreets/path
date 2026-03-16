# Replace duckdb-wasm with hyparquet

## Context

The site loads ~141KB of parquet data (`all.pqt` 102KB, `bt-traffic.pqt` 35KB, `bt-ezpass.pqt` 4KB) through duckdb-wasm, which adds:
- **5.5MB JS bundle** (1.7MB gzipped) — mostly duckdb-wasm
- **~4MB WASM binary** loaded at runtime
- **~2s startup delay** for WASM instantiation before any query runs

The SQL queries are trivial — essentially `SELECT * FROM parquet ORDER BY month` with no joins, aggregations, or filters. A lightweight parquet reader is sufficient.

## Requirements

### 1. Replace duckdb-wasm with hyparquet

[hyparquet](https://github.com/hyparam/hyparquet) is ~15KB and reads parquet files directly into JS arrays.

**Files to change:**
- `src/RidesPlot.tsx` — replace `useDb()` + DuckDB query with hyparquet `parquetRead`
- `src/BridgeTunnel.tsx` — same for BT data
- `src/MonthlyPlots.tsx` — same (shares the PATH data query)
- `package.json` — remove `@rdub/duckdb-wasm`, `@duckdb/duckdb-wasm`; add `hyparquet`

**Current pattern (duckdb-wasm):**
```ts
const dbConn = useDb()
const { data } = useQuery({
  queryFn: async () => {
    const { conn } = dbConn
    const result = await conn.query(`SELECT ... FROM parquet_scan('${url}')`)
    // manually extract columns from Arrow table
  }
})
```

**New pattern (hyparquet):**
```ts
const { data } = useQuery({
  queryFn: async () => {
    const response = await fetch(url)
    const buffer = await response.arrayBuffer()
    const { rows, columns } = await parquetRead({ file: buffer })
    // rows is already a JS array
  }
})
```

### 2. Consider pre-converting to JSON

At 102KB parquet → ~200KB JSON (~50KB gzipped), the data could be:
- Pre-converted at build time to JSON
- Inlined in the bundle or fetched as a static file
- No parquet library needed at all

This would be the simplest option but loses parquet's columnar compression advantage. For 141KB total data, the difference is negligible.

**Decision**: Use hyparquet first (keeps parquet format, minimal code change). JSON conversion can be a follow-up if hyparquet adds unnecessary complexity.

### 3. Data loading hook

Create a simple `useParquetData(url)` hook that:
- Fetches the parquet file
- Parses with hyparquet
- Returns typed rows
- Caches via react-query

This replaces the `useDb()` + manual column extraction pattern.

## Implementation Notes

### Column mapping
The current code manually extracts Arrow columns by name:
```ts
const monthCol = Arr(table.getChild("month")!.toArray())
const stationCol = Arr(table.getChild("station")!.toArray())
```

hyparquet returns rows as objects with column names as keys, so this simplifies to:
```ts
const rows = await parquetRead({ file: buffer })
// rows[0] = { month: "2012-01", station: "WTC", avg_weekday: 1234, ... }
```

### NaN coercion
Current code does `(value as number) || 0` for holiday columns. This should be preserved in the new loading code.

### DVC resolution
The `vite-plugin-dvc` `dvcResolve()` call stays the same — it just returns a URL. The change is only in how we fetch and parse that URL.

### Removing duckdb-wasm
- Remove `@rdub/duckdb-wasm` and `@duckdb/duckdb-wasm` from dependencies
- Remove `useDb()` calls and the `<DuckDBProvider>` if present
- Remove `vite.config.ts` workarounds for duckdb (`process.env` polyfill, `esbuild.logOverride`)
- The `apache-arrow` dependency can also be removed

## Acceptance Criteria

1. No duckdb-wasm in the bundle
2. Bundle size < 1.5MB (gzipped), down from ~1.7MB
3. All data loads correctly (PATH + BT pages)
4. Page load time (time to first plot render) < 2s on fast connection
5. All 18 e2e tests pass
6. No `process.env` polyfill needed in vite config
