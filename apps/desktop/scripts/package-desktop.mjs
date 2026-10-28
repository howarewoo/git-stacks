#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Desktop packaging supports macOS arm64 and x64 only.')
}
const args = process.argv.slice(2)
if (args.some((arg) => /^(?:--?(?:win|windows|linux|ia32|armv7l)|-w|-l)(?:=|$)/u.test(arg))) {
  throw new Error('Desktop packaging supports macOS arm64 and x64 only.')
}
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run packaging through pnpm.')
execFileSync(pnpm, ['exec', 'electron-builder', '--mac', '--publish', 'never', ...args], {
  stdio: 'inherit',
})
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('./verify-packaged-git-runtime.mjs', import.meta.url))],
  { stdio: 'inherit' },
)
