# Restore `optimizeDeps.include: ['plotly.js/basic']` in `www/vite.config.ts`

Source: pds session, 2026-09-27.

## What happened

`www/vite.config.ts` had (commit `80b4773`):

```ts
optimizeDeps: {
  include: ['plotly.js/basic'],
},
```

so Vite pre-bundles (CJS→ESM) the dynamically-imported `plotly.js/basic` entry (`src/main.tsx`: `import('plotly.js/basic')`). A `pds` bug deleted the whole `optimizeDeps` block during a `pds l plotly.js` → `pds g plotly.js` round-trip (removing the last `exclude` entry wiped sibling keys too). The site works without it, but the dev server's first dynamic Plotly import is slower (discovered + optimized lazily, which can also trigger a full page reload mid-session).

pds is fixed (it now edits only `exclude`, preserving `include` and other keys, and restores the file byte-for-byte), so re-adding is durable.

## Ask

1. Re-add to `www/vite.config.ts`:
   ```ts
   optimizeDeps: {
     include: ['plotly.js/basic'],
   },
   ```
2. Upgrade to `pnpm-dep-source` ≥ the release containing the fix before the next `pds l`/`pds g` of a dep in this project.
3. Sanity-check: cold-start the dev server (`rm -rf node_modules/.vite`), open a page that loads Plotly, and confirm no "new dependencies optimized: plotly.js/basic … reloading" message.
