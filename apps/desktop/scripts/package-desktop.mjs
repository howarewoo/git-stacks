#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run packaging through pnpm.')
execFileSync(pnpm, ['exec', 'electron-builder', '--publish', 'never', ...process.argv.slice(2)], {
  stdio: 'inherit',
})
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('./verify-packaged-git-runtime.mjs', import.meta.url))],
  { stdio: 'inherit' },
)
