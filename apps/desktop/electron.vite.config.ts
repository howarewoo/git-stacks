import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ['@git-stacks/shared', '@git-stacks/ui'],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ['@git-stacks/shared', '@git-stacks/ui'],
      },
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    build: { minify: true },
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
