// Extra-resource EXEs are signed while electron-builder copies them. Refresh only
// their digests after that copy, before the unpacked app becomes an installer.
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { version: appVersion } = require('../package.json')
const { Arch } = require('builder-util')
const { digest, inventory } = require('./git-runtime-inventory.cjs')

module.exports = async ({ appOutDir, arch, electronPlatformName }) => {
  if (electronPlatformName !== 'win32') return
  const platform = `win32-${Arch[arch]}`
  const gitRoot = join(appOutDir, 'resources', 'git')
  const manifestPath = join(gitRoot, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = manifest.platforms?.[platform]
  if (manifest.appVersion !== appVersion)
    throw new Error(`Git release manifest is not for app version ${appVersion}`)
  if (
    !entry?.files ||
    !entry.source ||
    !entry.gitVersion ||
    entry.sha256 !== entry.files['cmd/git.exe']
  )
    throw new Error(`Missing provisioned Git release inventory for ${platform}`)
  const actual = inventory(join(gitRoot, platform))
  const previous = entry.files
  const names = Object.keys(previous)
  if (
    names.length !== Object.keys(actual).length ||
    names.some(
      (name) => !(name in actual) || (!name.endsWith('.exe') && previous[name] !== actual[name]),
    )
  ) {
    throw new Error(`Unexpected Git runtime change while signing ${platform}`)
  }
  entry.sha256 = actual['cmd/git.exe']
  entry.files = actual
  if (!entry.sha256) throw new Error(`Missing signed Git executable for ${platform}`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
