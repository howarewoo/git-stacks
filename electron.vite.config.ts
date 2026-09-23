import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {},
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: {
    build: { minify: true },
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
  },
})
