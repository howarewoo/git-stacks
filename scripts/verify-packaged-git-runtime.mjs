#!/usr/bin/env node
// Verify the runtime after electron-builder has copied and signed the actual app.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const release = join(root, 'release')
const targets = []
for (const directory of readdirSync(release, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const path = join(release, directory.name)
  if (process.platform === 'darwin') {
    for (const app of readdirSync(path, { withFileTypes: true })) {
      if (app.isDirectory() && app.name.endsWith('.app')) {
        targets.push(join(path, app.name, 'Contents', 'Resources'))
      }
    }
  } else if (directory.name.endsWith('-unpacked')) {
    targets.push(join(path, 'resources'))
  }
}
if (!targets.length) throw new Error(`No unpacked ${process.platform} desktop app in ${release}`)
for (const resources of targets) {
  if (!existsSync(join(resources, 'git', 'runtime-manifest.json'))) {
    throw new Error(`Packaged desktop app is missing its Git runtime: ${resources}`)
  }
  execFileSync(process.execPath, [join(root, 'scripts', 'verify-git-runtime.mjs'), resources], {
    stdio: 'inherit',
  })
}
console.log(`Verified Git inside ${targets.length} packaged desktop app(s)`)
