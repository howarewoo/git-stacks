/**
 * Isolated desktop fixture.
 *
 * A portable, test-only external Electron launcher. It runs as the main
 * process entry instead of the production main file, installs a synthetic
 * credential-sealing backend, proves that the installation cannot be
 * bypassed, and only then loads the real production main/preload/UI.
 *
 * What it guarantees for the launched app, without touching production source:
 *   - every safeStorage entry point the compiled product uses is replaced by
 *     a local authenticated-encryption implementation, and no original native
 *     method is ever invoked;
 *   - the sealing key is a caller-owned synthetic file that persists across
 *     launches against the same fixture root, so sealed credentials survive a
 *     restart and fail to open under any other key;
 *   - Chromium itself is kept off the real OS key store via --use-mock-keychain
 *     and --password-store=basic;
 *   - if any of that cannot be proven, the fixture refuses to load the
 *     production main module (fail closed).
 *
 * Usage (as the Electron main entry):
 *   electron tests/fixtures/isolated-desktop.cjs --fixture-root <dir> --main <entry> [-- <app args>]
 *
 * As a plain Node module it only exports the building blocks for the
 * isolation regression test; it never touches Electron or the network.
 *
 * Signal: a launch is under the fixture when this file is the main entry.
 * The fixture writes <fixture-root>/fixture.json describing the synthetic
 * store and creates <fixture-root>/synthetic-key.bin (0600) on first use.
 * Neither the key nor any sealed plaintext is ever printed.
 */

const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const FORMAT_MAGIC = Buffer.from('ISDF1')
const NONCE_BYTES = 12
const KEY_FILE = 'synthetic-key.bin'
const MARKER_FILE = 'fixture.json'

const USED_ENTRY_POINTS = [
  'isEncryptionAvailable',
  'getSelectedStorageBackend',
  'encryptString',
  'decryptString',
]

function readFixtureKey(keyFile) {
  if (!existsSync(keyFile)) return null
  const key = readFileSync(keyFile)
  if (key.length !== 32) {
    throw new Error(`The fixture key at ${keyFile} is not 32 bytes; refusing to guess.`)
  }
  return key
}

function createFixtureKey(keyFile, fixtureRoot) {
  mkdirSync(fixtureRoot, { recursive: true })
  const existing = readFixtureKey(keyFile)
  if (existing) return existing
  const key = randomBytes(32)
  writeFileSync(keyFile, key, { mode: 0o600 })
  try {
    chmodSync(keyFile, 0o600)
  } catch {
    // Best-effort tightening; the mode at creation already restricts access.
  }
  return key
}

/**
 * The synthetic safeStorage: AES-256-GCM over a fixture-owned key. `native`
 * is injected (in production it is the real Electron safeStorage, in the
 * regression it is a stand-in whose every method rejects); the synthetic
 * implementation never calls it.
 */
function createIsolatedSafeStorage({ keyFile, fixtureRoot = undefined, native }) {
  if (!native || typeof native !== 'object') {
    throw new Error('The isolated fixture requires the native safeStorage object to guard against.')
  }
  // getSelectedStorageBackend only exists on Linux; the product reads it
  // solely behind its platform !== 'linux' branch, so require it only there.
  for (const name of USED_ENTRY_POINTS) {
    if (name === 'getSelectedStorageBackend' && process.platform !== 'linux') continue
    if (typeof native[name] !== 'function') {
      throw new Error(`The native safeStorage is missing ${name}; refusing to install the fixture.`)
    }
  }
  const root =
    fixtureRoot ?? (keyFile.endsWith(KEY_FILE) ? keyFile.slice(0, -KEY_FILE.length - 1) : undefined)
  if (!root) throw new Error('The fixture root is required.')
  const key = createFixtureKey(keyFile, root)
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'isolated-fixture',
    encryptString: (plain) => {
      if (typeof plain !== 'string') throw new TypeError('encryptString expects a string')
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([FORMAT_MAGIC, nonce, cipher.getAuthTag(), ciphertext])
    },
    decryptString: (sealed) => {
      if (!Buffer.isBuffer(sealed)) sealed = Buffer.from(sealed)
      if (
        sealed.length < FORMAT_MAGIC.length + NONCE_BYTES + 16 ||
        !sealed.subarray(0, FORMAT_MAGIC.length).equals(FORMAT_MAGIC)
      ) {
        throw new Error('The sealed value is not an isolated-fixture ciphertext.')
      }
      const nonce = sealed.subarray(FORMAT_MAGIC.length, FORMAT_MAGIC.length + NONCE_BYTES)
      const tag = sealed.subarray(
        FORMAT_MAGIC.length + NONCE_BYTES,
        FORMAT_MAGIC.length + NONCE_BYTES + 16,
      )
      const ciphertext = sealed.subarray(FORMAT_MAGIC.length + NONCE_BYTES + 16)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    },
  }
}

/**
 * Replace every used safeStorage entry point on the shared native object.
 * Electron's non-configurable export getter and already-held aliases keep
 * returning that object. Refuse installation if its methods cannot be guarded;
 * no original method is ever invoked.
 */
function installIsolatedSafeStorage({ electron, keyFile, fixtureRoot, logger }) {
  if (!electron || typeof electron !== 'object') throw new Error('The Electron module is required.')
  const native = electron.safeStorage
  if (!native || typeof native !== 'object') {
    throw new Error('The Electron module exposes no safeStorage; refusing to continue unguarded.')
  }
  const synthetic = createIsolatedSafeStorage({ keyFile, fixtureRoot, native })
  const originals = new Set()
  for (const name of USED_ENTRY_POINTS) {
    originals.add(native[name])
    try {
      Object.defineProperty(native, name, {
        value: synthetic[name],
        writable: true,
        configurable: true,
      })
    } catch {
      throw new Error(
        `The fixture could not replace native safeStorage.${name} in place; refusing to continue.`,
      )
    }
  }
  // Prove the guard purely by identity; call nothing that could reach the
  // original implementations.
  for (const name of USED_ENTRY_POINTS) {
    if (native[name] !== synthetic[name] || electron.safeStorage[name] !== synthetic[name]) {
      throw new Error(
        `The fixture could not replace native safeStorage.${name}; refusing to continue.`,
      )
    }
  }
  for (const original of originals) {
    if (typeof original !== 'function') continue
    for (const name of USED_ENTRY_POINTS) {
      if (native[name] === original || electron.safeStorage[name] === original) {
        throw new Error('An original safeStorage method is still reachable; refusing to continue.')
      }
    }
  }
  if (logger) logger(`isolated-desktop: synthetic credential sealing installed (${keyFile})`)
  return synthetic
}

function parseCli(argv) {
  const options = { appArgs: [] }
  const rest = [...argv]
  const dashDash = rest.indexOf('--')
  const head = dashDash === -1 ? rest : rest.slice(0, dashDash)
  const tail = dashDash === -1 ? [] : rest.slice(dashDash + 1)
  const interleaved = []
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '--fixture-root') options.fixtureRoot = head[++i]
    else if (head[i] === '--main') options.main = head[++i]
    else interleaved.push(head[i])
  }
  options.appArgs = [...interleaved, ...tail]
  if (!options.fixtureRoot) throw new Error('Missing required --fixture-root <dir>.')
  if (!options.main) throw new Error('Missing required --main <entry>.')
  options.fixtureRoot = resolve(options.fixtureRoot)
  options.main = resolve(options.main)
  return options
}

async function runFixtureMain(argv) {
  const options = parseCli(argv)
  mkdirSync(options.fixtureRoot, { recursive: true })
  if (!existsSync(options.main))
    throw new Error(`The production main entry does not exist: ${options.main}`)

  const Module = require('node:module')
  const originalLoad = Module._load
  let firstLoad = true
  let installed = null
  Module._load = function (request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments)
    if (request === 'electron') {
      if (firstLoad) {
        // Patch in place on the very first evaluation so any import —
        // require or ESM named import — sees the synthetic backend.
        installed = installIsolatedSafeStorage({
          electron: loaded,
          keyFile: join(options.fixtureRoot, KEY_FILE),
          fixtureRoot: options.fixtureRoot,
          logger: (line) => process.stdout.write(`${line}\n`),
        })
        firstLoad = false
      } else {
        const stillInstalled =
          installed &&
          loaded.safeStorage &&
          loaded.safeStorage.encryptString === installed.encryptString &&
          loaded.safeStorage.decryptString === installed.decryptString &&
          loaded.safeStorage.isEncryptionAvailable === installed.isEncryptionAvailable &&
          loaded.safeStorage.getSelectedStorageBackend === installed.getSelectedStorageBackend
        if (!stillInstalled) {
          throw new Error('The isolated fixture was displaced; refusing to continue.')
        }
      }
    }
    return loaded
  }

  const electron = require('electron')
  if (firstLoad || !installed) {
    throw new Error(
      'The isolated fixture failed to install before Electron loaded; refusing to continue.',
    )
  }
  electron.app.commandLine.appendSwitch('use-mock-keychain')
  electron.app.commandLine.appendSwitch('password-store', 'basic')
  const keychainMocked = electron.app.commandLine.hasSwitch('use-mock-keychain')
  const basicPasswordStore = electron.app.commandLine.getSwitchValue('password-store') === 'basic'
  if (!keychainMocked || !basicPasswordStore) {
    throw new Error(
      'The isolated fixture could not force the mock Chromium key store; refusing to continue.',
    )
  }
  const installedInPlace =
    electron.safeStorage.encryptString === installed.encryptString &&
    electron.safeStorage.decryptString === installed.decryptString &&
    electron.safeStorage.isEncryptionAvailable === installed.isEncryptionAvailable &&
    electron.safeStorage.getSelectedStorageBackend === installed.getSelectedStorageBackend
  if (!installedInPlace) {
    throw new Error(
      'The isolated fixture could not prove the synthetic credential store; refusing to continue.',
    )
  }

  writeFileSync(
    join(options.fixtureRoot, MARKER_FILE),
    JSON.stringify(
      { helper: 'isolated-desktop.cjs', version: 1, store: 'aes-256-gcm', keyFile: KEY_FILE },
      null,
      2,
    ),
  )

  process.argv = [process.argv[0], options.main, ...options.appArgs]
  await import(pathToFileURL(options.main).href)
}

if (process.versions.electron && process.argv[1] && resolve(process.argv[1]) === __filename) {
  runFixtureMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`isolated-desktop: ${error.message}\n`)
    process.exit(1)
  })
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KEY_FILE,
    MARKER_FILE,
    createIsolatedSafeStorage,
    createFixtureKey,
    installIsolatedSafeStorage,
    parseCli,
    readFixtureKey,
  }
}
