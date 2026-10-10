import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * Standalone Vite configuration for the Git Stacks design system catalog.
 * Produces static assets in dist/ with a configurable base suitable for subpath hosting.
 *
 *   dev:     pnpm --filter design dev     (--port 5299)
 *   build:   pnpm --filter design build   (outDir: dist)
 *   preview: pnpm --filter design preview (--port 5299)
 */
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5299,
    strictPort: true,
  },
  preview: {
    port: 5299,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
