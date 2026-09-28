// electron-builder calls this after copying resources but before signing the app seal.
// Sign nested Mach-O payloads first, then record their final bytes in the sealed manifest.
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} = require('node:fs')
const { join } = require('node:path')
const { signAsync } = require('@electron/osx-sign')

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

function signBinaries(root, identity, keychain) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) signBinaries(path, identity, keychain)
    else if (entry.isFile()) {
      const descriptor = openSync(path, 'r')
      const header = Buffer.alloc(4)
      try {
        readSync(descriptor, header, 0, 4, 0)
      } finally {
        closeSync(descriptor)
      }
      if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf'].includes(header.toString('hex')))
        continue
      const args = ['--force', '--options', 'runtime', '--timestamp', '--sign', identity]
      if (keychain) args.push('--keychain', keychain)
      execFileSync('/usr/bin/codesign', [...args, path], { stdio: 'inherit' })
    }
  }
}

module.exports = async (options) => {
  if (!options.identity)
    throw new Error('A Developer ID signing identity is required to ship bundled Git')
  const gitRoot = join(options.app, 'Contents', 'Resources', 'git')
  const platform = `darwin-${process.arch}`
  const manifestPath = join(gitRoot, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.platforms?.[platform])
    throw new Error(`Missing managed Git manifest entry for ${platform}`)
  signBinaries(join(gitRoot, platform), options.identity, options.keychain)
  manifest.platforms[platform].sha256 = digest(join(gitRoot, platform, 'bin', 'git'))
  manifest.platforms[platform].files = inventory(join(gitRoot, platform))
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await signAsync(options)
}
