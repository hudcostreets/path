import mdx from '@mdx-js/rollup'
import react from '@vitejs/plugin-react'
import { pdsPlugin } from 'pnpm-dep-source/vite'
import { defineConfig } from 'vite'
import dvc from 'vite-plugin-dvc'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

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
  build: {
    commonjsOptions: {
      include: [/plotly\.js/],
    },
    rollupOptions: {
      external: ['plotly.js-dist-min'],
    },
  },
  optimizeDeps: {
    include: ['plotly.js/basic'],
  },
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  },
})
