import mdx from '@mdx-js/rollup'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
    })
  ],
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  }
})
