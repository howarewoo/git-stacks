// Extra-resource EXEs are signed while electron-builder copies them. Refresh only
// their digests after that copy, before the unpacked app becomes an installer.
const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, readlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { version: appVersion } = require('../package.json')
const { Arch } = require('builder-util')

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function inventory(root, prefix = '') {
  const files = {}
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(root, entry.name)
    if (entry.isDirectory()) Object.assign(files, inventory(path, name))
    else if (entry.isSymbolicLink()) files[name] = `link:${readlinkSync(path)}`
    else if (entry.isFile()) files[name] = digest(path)
    else throw new Error(`Unexpected Git runtime entry: ${name}`)
  }
  return files
}

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
