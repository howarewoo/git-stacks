// One inventory of a provisioned Git runtime, shared by every build step that
// has to agree about it: the provisioner records it, the two packaging hooks
// refresh it once signing has changed the bytes, and the two verifiers refuse a
// payload that no longer matches what was recorded.
//
// CommonJS because electron-builder loads `afterPack` and `mac.sign` through
// `require`, and because an ESM import of this file works the same way from the
// `.mjs` entry scripts.
const { createHash } = require('node:crypto')
const { readdirSync, readFileSync, readlinkSync } = require('node:fs')
const { join } = require('node:path')

/** The digest every recorded file is compared by. */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Every file under `root`, keyed by its `/`-separated path relative to `root`.
 *
 * A symbolic link is recorded as the target it points at rather than as the
 * bytes behind it, because a link is what the payload carries. Anything that is
 * neither a directory, a link, nor a file is thrown rather than skipped: an
 * entry nobody can describe is a payload nobody can prove.
 */
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

module.exports = { digest, inventory }
