import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * Standalone build of the development/test fixture gallery. It is deliberately separate from
 * `electron.vite.config.ts` so specimens and fixture code never reach the packaged renderer:
 *
 *   dev:   npx vite --config tests/renderer/vite.config.ts --port 5199 --strictPort
 *   build: npx vite build --config tests/renderer/vite.config.ts   (out/renderer-fixtures)
 *
 * `base: './'` and the absolute outDir keep the built gallery loadable over `file://`, which is
 * what the packaged Electron smoke script uses.
 */
export default defineConfig({
  root: resolve('tests/renderer/gallery'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  server: { fs: { allow: [resolve('.')] } },
  build: {
    outDir: resolve('out/renderer-fixtures'),
    emptyOutDir: true,
  },
})
