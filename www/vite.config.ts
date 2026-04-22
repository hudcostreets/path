import mdx from '@mdx-js/rollup'
import react from '@vitejs/plugin-react'
import { createRequire } from 'module'
import { pdsPlugin } from 'pnpm-dep-source/vite'
import { defineConfig } from 'vite'
import dvc from 'vite-plugin-dvc'

const require = createRequire(import.meta.url)
const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

// Resolve plotly.js/basic to its actual file path so Vite can prebundle it
// (symlinked workspace packages aren't followed by Vite's optimizer)
const plotlyBasicPath = require.resolve('plotly.js/basic')

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    port: 8858,
    host: true,
    allowedHosts,
  },
  plugins: [
    react(),
    mdx({
      providerImportSource: "@mdx-js/react",
    }),
    dvc({ root: 'public' }),
    pdsPlugin(),
  ],
  resolve: {
    alias: {
      'plotly.js/basic': plotlyBasicPath,
    },
  },
  build: {
    commonjsOptions: {
      include: [/plotly\.js/, /node_modules/],
    },
    rollupOptions: {
      external: ['plotly.js-dist-min'],
    },
  },
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  }
})
