#!/usr/bin/env node
// The desktop app never downloads Git. Build-time provisioning installs a pinned
// distribution and records every shipped file in the release manifest; this check
// rejects incomplete or modified payloads before packaging.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest, inventory } from './git-runtime-inventory.cjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeRoot = process.argv[2]
  ? join(resolve(process.argv[2]), 'git')
  : join(repositoryRoot, 'resources', 'git')
const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
const platform = `${process.platform}-${process.arch}`
const executableName = process.platform === 'win32' ? 'cmd/git.exe' : 'bin/git'

function fail(message) {
  console.error(`git-runtime: ${message}`)
  process.exit(1)
}

/** The inventory as this script reports it: a prefixed line, then the stop. */
function inventoryOrFail(root) {
  try {
    return inventory(root)
  } catch (error) {
    fail(error.message)
  }
}

if (!existsSync(manifestPath)) {
  fail(
    `no release manifest at ${manifestPath}. Run npm run provision:git-runtime before packaging.`,
  )
}

const { version: appVersion } = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.appVersion !== appVersion) {
  fail(
    `the runtime manifest records app version ${manifest.appVersion} but package.json is ${appVersion}. Regenerate the runtime for this release.`,
  )
}

const provisioned = readdirSync(runtimeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
for (const name of provisioned) {
  if (!manifest.platforms?.[name]) {
    fail(`${name} is provisioned but not recorded in the runtime manifest.`)
  }
}
for (const [name, entry] of Object.entries(manifest.platforms ?? {})) {
  const executable = join(runtimeRoot, name, name.startsWith('win32-') ? 'cmd/git.exe' : 'bin/git')
  if (!existsSync(executable)) {
    fail(`the manifest records ${name} but ${executable} is missing.`)
  }
  const sha256 = digest(executable)
  if (sha256 !== entry.sha256) {
    fail(`${executable} does not match the digest recorded for ${name}.`)
  }
  if (!entry.source) {
    fail(`the manifest records no source for the ${name} Git runtime.`)
  }
  if (
    !entry.files ||
    JSON.stringify(inventoryOrFail(join(runtimeRoot, name))) !== JSON.stringify(entry.files)
  ) {
    fail(`${name} runtime files do not match the release inventory.`)
  }
}

const host = manifest.platforms?.[platform]
if (!host) {
  fail(
    `the runtime manifest records no Git runtime for ${platform}, so this build would refuse to start.`,
  )
}
const hostExecutable = join(runtimeRoot, platform, executableName)
const reported = execFileSync(hostExecutable, ['--version'], { encoding: 'utf8' }).trim()
const version = /(\d+\.\d+(?:\.\d+)?)/u.exec(reported)?.[1] ?? null
if (version !== host.gitVersion) {
  fail(`${hostExecutable} reports ${reported} but the manifest records ${host.gitVersion}.`)
}
if (process.platform === 'win32' || statSync(hostExecutable).mode & 0o111) {
  // POSIX executable bits are not represented by the content digest.
  console.log(
    `git-runtime: ${platform} Git ${version} (${host.source}) verified against the ${appVersion} release manifest.`,
  )
} else {
  fail(`${hostExecutable} is not executable.`)
}
