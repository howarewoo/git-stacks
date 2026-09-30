#!/usr/bin/env node
// Verify the runtime after electron-builder has copied and signed the actual app:
// the Git runtime the app shells out to, and the clone promotion helper it
// renames with. Both are copied as plain files beside the app, so a build that
// left either one out is only visible here.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  const helper = join(
    resources,
    'promote',
    process.platform === 'win32' ? 'promote-repository.exe' : 'promote-repository',
  )
  if (!existsSync(helper) || !statSync(helper).size) {
    throw new Error(`Packaged desktop app is missing its clone promotion helper: ${helper}`)
  }
  if (process.platform !== 'win32' && !(statSync(helper).mode & 0o111)) {
    throw new Error(`Packaged clone promotion helper is not executable: ${helper}`)
  }
  // Run with no arguments, so the shipped binary has to start and answer with
  // the usage exit code. A helper built for another platform fails here.
  if (spawnSync(helper, [], { stdio: 'pipe' }).status !== 2) {
    throw new Error(`Packaged clone promotion helper did not answer as a helper: ${helper}`)
  }
}
console.log(
  `Verified the Git runtime and the clone promotion helper inside ${targets.length} packaged desktop app(s)`,
)
