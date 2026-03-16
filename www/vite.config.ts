import mdx from '@mdx-js/rollup'
import react from '@vitejs/plugin-react'
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
  ],
  resolve: {
    alias: {
      'plotly.js-dist-min': 'plotly.js/dist/plotly.min.js',
    },
  },
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  }
})
