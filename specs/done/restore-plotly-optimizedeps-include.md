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

## Outcome (2026-09-27)

1. Done: `optimizeDeps.include: ['plotly.js/basic']` re-added to `www/vite.config.ts` (between `resolve` and `build`, as before).
2. **Not yet possible**: the pds fix (`eb44ac2`, `d881da4`, …) exists only on local `~/c/js/pds` `main` (6 commits ahead of `r/main`). The latest npm/dist release is `0.5.1` (2026-09-11), which predates it, and the global `pds` is `0.5.1`. Until a release that includes the fix is installed globally, don't run `pds l`/`pds g` here (or re-check `vite.config.ts` afterward).
3. Done: after `rm -rf node_modules/.vite` and a cold `pnpm dev`, `node_modules/.vite/deps/plotly__js_basic.js` was pre-bundled at startup. Loading `/` and scrolling through the plots logged no "new dependencies optimized … reloading", either in the server log or in the browser console.
