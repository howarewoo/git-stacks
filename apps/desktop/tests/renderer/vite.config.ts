import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** This file's own directory, so the config does not depend on the shell's cwd. */
const testsDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(testsDir, '../..')

/**
 * Standalone build of the development/test fixture gallery. It is deliberately separate from
 * `electron.vite.config.ts` so specimens and fixture code never reach the packaged renderer:
 *
 *   dev:   pnpm exec vite --config tests/renderer/vite.config.ts --port 5199 --strictPort
 *         (override the port with GALLERY_PORT so parallel worktrees stay separate)
 *   build: pnpm exec vite build --config tests/renderer/vite.config.ts   (out/renderer-fixtures)
 *
 * `base: './'` and the absolute outDir keep the built gallery loadable over `file://`, which is
 * what the packaged Electron smoke script uses.
 */
export default defineConfig({
  root: resolve(testsDir, 'gallery'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(repoRoot, 'src/renderer/src') } },
  server: { fs: { allow: [repoRoot, resolve(repoRoot, '../..')] } },
  build: {
    outDir: resolve(repoRoot, 'out/renderer-fixtures'),
    emptyOutDir: true,
  },
})
