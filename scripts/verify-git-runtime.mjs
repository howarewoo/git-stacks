#!/usr/bin/env node
// Verifies the Git runtime that ships inside a release. Git Stacks never downloads a
// Git executable, so the release pipeline provisions resources/git/<platform>/bin/git
// plus resources/git/runtime-manifest.json, and this check refuses to package anything
// that does not match the recorded release digests.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeRoot = join(repositoryRoot, 'resources', 'git')
const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
const platform = `${process.platform}-${process.arch}`
const executableName = process.platform === 'win32' ? 'git.exe' : 'git'

function fail(message) {
  console.error(`git-runtime: ${message}`)
  process.exit(1)
}

if (!existsSync(manifestPath)) {
  fail(
    `no release manifest at ${manifestPath}. Provision resources/git/<platform>/bin/${executableName} and record its version, digest, and source before packaging.`,
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
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
for (const name of provisioned) {
  if (!manifest.platforms?.[name]) {
    fail(`${name} is provisioned but not recorded in the runtime manifest.`)
  }
}
for (const [name, entry] of Object.entries(manifest.platforms ?? {})) {
  const executable = join(runtimeRoot, name, 'bin', executableName)
  if (!existsSync(executable)) {
    fail(`the manifest records ${name} but ${executable} is missing.`)
  }
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex')
  if (sha256 !== entry.sha256) {
    fail(`${executable} does not match the digest recorded for ${name}.`)
  }
  if (!entry.source) {
    fail(`the manifest records no source for the ${name} Git runtime.`)
  }
}

const host = manifest.platforms?.[platform]
if (!host) {
  fail(
    `the runtime manifest records no Git runtime for ${platform}, so this build would refuse to start.`,
  )
}
const hostExecutable = join(runtimeRoot, platform, 'bin', executableName)
const reported = execFileSync(hostExecutable, ['--version'], { encoding: 'utf8' }).trim()
const version = /(\d+\.\d+(?:\.\d+)?)/u.exec(reported)?.[1] ?? null
if (version !== host.gitVersion) {
  fail(`${hostExecutable} reports ${reported} but the manifest records ${host.gitVersion}.`)
}
if (statSync(hostExecutable).mode & 0o111) {
  // The executable bit is the only mode the check cannot read from the digest.
  console.log(
    `git-runtime: ${platform} Git ${version} (${host.source}) verified against the ${appVersion} release manifest.`,
  )
} else {
  fail(`${hostExecutable} is not executable.`)
}
