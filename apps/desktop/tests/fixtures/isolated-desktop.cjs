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

const { EventEmitter } = require('node:events')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} = require('node:fs')
const {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require('node:path')
const { promisify } = require('node:util')
const { fileURLToPath, pathToFileURL } = require('node:url')

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
 * A shell command line names the CLI somewhere inside a string this boundary
 * cannot resolve the way the OS would, so `gh` is never run through one. The
 * path separator counts as a name boundary so an absolute `/usr/local/bin/gh`
 * is recognised, and so is a `gh` behind any other quoting or redirection.
 */
function shellNames(command) {
  return /(?:^|[\s"'`;|&()<>\\/])gh(?:\.exe)?(?:$|[\s"'`;|&()<>\\/])/iu.test(command)
}

/**
 * Confines the provider CLI to the executable a run owns.
 *
 * A packaged launch inherits no shell PATH and the production bootstrap adds the
 * machine's own installation directories back, so a run that only points PATH at
 * its own directory still resolves the developer's real CLI. That CLI would read
 * a real account for the version probe, the auth status or a token read, and the
 * "the CLI is missing" step would prove nothing.
 *
 * This is the child's own process boundary, installed before the production main
 * is imported and re-synced into the built-in ESM exports so a named import
 * already handed out cannot bypass it. Ownership is declared, not inferred: the
 * directory a controlled run writes its CLI into is admitted explicitly, and only
 * the one file the request would actually start is judged against those roots —
 * resolved through the child's own PATH and working directory, so several roots
 * coexist and a CLI installed deep under one of them is still this run's own.
 * Everything else — another directory's `gh`, the other spelling of the name, a
 * symlink that leaves the owned directory, a name that is not an executable file,
 * a shell command line, a shell-enabled argv API — is answered exactly as an
 * absent CLI would be, with ENOENT, and is recorded for the run to assert on. No
 * second file is ever tried in place of a refused one. Real Git binaries are
 * untouched: they are isolated by their own configuration, not by this.
 *
 * Enabled by GIT_STACKS_OWNED_GH_DIR; without it nothing is fenced, because a
 * fixture that silently redirected a developer's CLI outside a controlled run
 * would be a worse failure than one that ran it.
 */

/**
 * The directories this run owns, and the only place a CLI may be installed.
 *
 * Admission is explicit and by directory: a controlled run registers the
 * directory it writes its own CLI into, and anything under that directory is
 * this run's own. Nothing else is admitted — not the system temporary
 * directory, not a home directory, and not a directory some other tool made —
 * so a refusal is a refusal rather than a coincidence of where a file landed.
 */
const ownedDirectories = new Set()

/**
 * Admits one directory as this run's own, and returns its canonical path.
 *
 * Canonicalised once, here: a temporary directory is a link on macOS and a
 * fixture that registered the other spelling would have its own executable
 * refused. A fixture whose CLI lives in a `bin` directory beneath a root it
 * made registers that `bin` directory itself; the boundary admits any depth
 * beneath a registered root, so a deeper path needs no second call.
 *
 * A directory that is not there is refused rather than remembered: a
 * registration that named nothing would admit a path nothing can be reached
 * through, which reads as an owned CLI that does not exist.
 */
function admitOwnedProviderCliRoot(directory) {
  if (typeof directory !== 'string' || directory === '') {
    throw new Error('An owned CLI root must be named by a path.')
  }
  const canonical = realpathSync(directory)
  ownedDirectories.add(canonical)
  return canonical
}

function installOwnedProviderCliBoundary(fixtureRoot) {
  const ownedDir = process.env.GIT_STACKS_OWNED_GH_DIR
  if (!ownedDir) return
  const childProcess = require('node:child_process')
  const moduleBuiltin = require('node:module')
  const log = join(fixtureRoot, 'unowned-gh-launches.log')

  // The directory named in the environment is this run's own, admitted the same
  // way any other is: canonicalised once, because a temporary directory is a
  // link on macOS and a run that registered the other spelling would have its
  // own executable refused.
  admitOwnedProviderCliRoot(ownedDir)

  const providerCliNames = ['gh', 'gh.exe']
  const isProviderCli = (file) =>
    typeof file === 'string' && providerCliNames.includes(basename(file))
  const usesShell = (options) =>
    options !== null &&
    typeof options === 'object' &&
    (options.shell === true || (typeof options.shell === 'string' && options.shell.length > 0))
  /**
   * The canonical file this boundary is willing to start, or null when the
   * candidate is not one of this run's own.
   *
   * The candidate is judged where it would actually run, and it is that one file
   * that decides: a regular, executable file that is still itself rather than a
   * link, whose realpath is inside one of the admitted roots. A run may own
   * several roots at once — a fixture that installs its own CLI per test owns a
   * directory of its own each time — so every candidate is judged against all of
   * them and never compared with another root's file: two controlled CLIs
   * coexist, and a CLI installed deep under an owned root is this run's own at
   * whatever depth it sits. Nothing outside the admitted roots is ever answered
   * for, which is what keeps a developer's own CLI out of reach.
   */
  const ownedExecutable = (candidate) => {
    let stats
    try {
      // The name itself, without following links: a `gh` that is a link is
      // something a person pointed there, not this run's install.
      stats = lstatSync(candidate)
    } catch {
      return null
    }
    if (!stats.isFile()) return null
    if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) return null
    let canonical
    try {
      // Compared by what the file actually is: a temporary directory is a link
      // on macOS, and the OS would run the file behind it.
      canonical = realpathSync(candidate)
    } catch {
      return null
    }
    for (const root of ownedDirectories) {
      const inside = relative(root, canonical)
      if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        continue
      }
      return canonical
    }
    return null
  }
  // What was asked for, and whether this run's own executable was installed at
  // the time: an attempt made while it was installed would have been answered by
  // this boundary rather than by the machine's CLI.
  const record = (file) => {
    const installed = providerCliNames.some((name) =>
      [...ownedDirectories].some((root) => ownedExecutable(join(root, name)) !== null),
    )
    appendFileSync(log, `${installed ? 'owned-present' : 'absent'} ${file}\n`)
  }
  const absent = (file) => {
    const error = new Error(`spawn ${file} ENOENT`)
    error.code = 'ENOENT'
    error.errno = -2
    error.syscall = `spawn ${file}`
    error.path = file
    return error
  }
  // The PATH that matters is the one this child will actually be given: a call
  // that passes its own environment is asking about that environment, not about
  // this process's. The working directory matters for the same reason — a
  // relative PATH entry or a relative path is resolved against the child's.
  //
  // An environment with no PATH in it is not an empty PATH. The child is started
  // with the platform's own default search in the first case and with its own
  // working directory in the second, so reading one as the other would have this
  // fence judge a file the operating system would never have looked for, and
  // refuse one it would. PATH is a case-insensitive name on Windows and an exact
  // one everywhere else, which is how the child reads it too.
  const defaultExecPath = () =>
    process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/bin:/bin'
  const childPath = (options) => {
    const env = options !== null && typeof options === 'object' ? options.env : undefined
    if (env === null || typeof env !== 'object') return process.env.PATH ?? ''
    const names = Object.keys(env)
    const key =
      process.platform === 'win32'
        ? names.find((name) => name.toLowerCase() === 'path')
        : names.find((name) => name === 'PATH')
    if (key === undefined) return defaultExecPath()
    const value = env[key]
    return typeof value === 'string' ? value : defaultExecPath()
  }
  const childCwd = (options) => {
    const cwd = options !== null && typeof options === 'object' ? options.cwd : undefined
    if (typeof cwd === 'string') return cwd === '' ? process.cwd() : cwd
    // A file URL is a working directory the child accepts, and resolving it to
    // this process's own directory instead would judge the wrong tree.
    if (cwd instanceof URL) return fileURLToPath(cwd)
    return process.cwd()
  }
  /**
   * What the operating system would start for a bare name: the first executable
   * file of exactly that name on the child's own PATH, resolved against the
   * child's working directory. The OS skips a directory, a file without the
   * executable bit, and an entry it cannot use, so this skips them too — and it
   * keeps an empty PATH entry, which means the child's own working directory
   * rather than nothing at all. The file is returned as it was spelled, so what
   * is judged is what would be started.
   */
  const selectedCandidate = (name, options) => {
    const base = childCwd(options)
    for (const directory of childPath(options).split(delimiter)) {
      const path = resolve(base, directory, name)
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) continue
        return path
      } catch {
        continue
      }
    }
    return null
  }
  /**
   * The file to start, or null when this boundary refuses the request. A
   * permitted provider CLI is started by the absolute path this boundary has
   * already validated as this run's own, so the file that starts is the file
   * that was checked.
   */
  const executableFor = (file, options) => {
    if (typeof file !== 'string') return file
    if (usesShell(options)) {
      // A shell resolves the command line itself, which this boundary cannot do
      // the way the OS would, so a provider CLI named in one is refused outright
      // rather than guessed at.
      return isProviderCli(file) || shellNames(file) ? null : file
    }
    // An argv API is given an executable, not a command line, so anything with
    // whitespace in it is either a shell form or a name nothing can be.
    if (/\s/u.test(file)) return shellNames(file) ? null : file
    if (!isProviderCli(file)) return file
    // The one file this request would start, and the only one that can answer
    // it: the named path resolved against the child's own working directory, or
    // the bare name resolved the way the OS resolves it on the child's PATH.
    const candidate =
      file.includes('/') || file.includes('\\')
        ? resolve(childCwd(options), file)
        : selectedCandidate(basename(file), options)
    if (candidate === null) return null
    return ownedExecutable(candidate)
  }
  const argvOptions = (rest) =>
    rest.find(
      (argument) => argument !== null && typeof argument === 'object' && !Array.isArray(argument),
    ) ?? null
  const guardArgvAsync = (original) => {
    const guarded = function guardedChild(file, ...rest) {
      const executable = executableFor(file, argvOptions(rest))
      if (executable !== null) return original.call(this, executable, ...rest)
      record(String(file))
      const error = absent(String(file))
      const callback = rest.find((argument) => typeof argument === 'function')
      if (callback) {
        // Node reports an executable that never started with the error alone:
        // there is no output to hand back, and reporting empty output would
        // have a parser read an empty answer as a real one.
        process.nextTick(() => callback(error))
        const child = new EventEmitter()
        child.pid = undefined
        child.killed = false
        child.stdout = null
        child.stderr = null
        return child
      }
      // A child the caller asked for as a process: reported the same way an
      // absent executable is, and it never started.
      const child = new EventEmitter()
      child.pid = undefined
      child.killed = false
      child.stdout = null
      child.stderr = null
      process.nextTick(() => child.emit('error', error))
      return child
    }
    return guarded
  }
  const guardSync = (original) =>
    function guardedSync(file, ...rest) {
      const executable = executableFor(file, argvOptions(rest))
      if (executable !== null) return original.call(this, executable, ...rest)
      record(String(file))
      throw absent(String(file))
    }

  // The shell forms are refused before they resolve anything, so their
  // promisified contract is the same refusal either way.
  const guardShellAsync = (original) => {
    const guarded = function guardedShell(command, ...rest) {
      if (typeof command === 'string' && shellNames(command)) {
        record(command)
        const error = absent(String(command).split(/\s+/u)[0] ?? 'gh')
        const callback = rest.find((argument) => typeof argument === 'function')
        if (callback) {
          process.nextTick(() => callback(error))
          return new EventEmitter()
        }
        return Promise.reject(error)
      }
      return original.call(this, command, ...rest)
    }
    return Object.assign(guarded, {
      [promisify.custom]: (command, ...rest) =>
        new Promise((resolve, reject) => {
          guarded(command, ...rest, (error, stdout, stderr) => {
            if (error) {
              attachOutput(error, stdout, stderr)
              reject(error)
            } else resolve({ stdout, stderr })
          })
        }),
    })
  }
  const guardShellSync = (original) =>
    function guardedShellSync(command, ...rest) {
      if (typeof command === 'string' && shellNames(command)) {
        record(command)
        throw absent(String(command).split(/\s+/u)[0] ?? 'gh')
      }
      return original.call(this, command, ...rest)
    }

  const argvAsync = ['spawn', 'execFile']
  for (const name of argvAsync) {
    childProcess[name] = guardArgvAsync(childProcess[name])
  }
  childProcess.execFile = withPromisifiedExecFileShape(childProcess.execFile)
  childProcess.exec = guardShellAsync(childProcess.exec)
  for (const name of ['spawnSync', 'execFileSync']) {
    childProcess[name] = guardSync(childProcess[name])
  }
  childProcess.execSync = guardShellSync(childProcess.execSync)
  childProcess.fork = guardArgvAsync(childProcess.fork)

  // A module that already holds a named import of one of these still sees the
  // guarded function after this: the built-in ESM exports are re-synced from the
  // patched CommonJS object, which is the only way to reach bindings that were
  // handed out before the boundary was installed.
  if (typeof moduleBuiltin.syncBuiltinESMExports === 'function') {
    moduleBuiltin.syncBuiltinESMExports()
  }
}

/**
 * The output a refused or failed child produced, on the error itself.
 *
 * Node's promisified `execFile` does this, and the auth-status parser depends on
 * it: `gh auth status` exits nonzero while still writing the JSON this build
 * reads, so an error without that output reports an unavailable CLI where the
 * real answer is an account. Only what the callback actually delivered is
 * attached — an executable that never started printed nothing, and saying so
 * would be a different answer.
 */
function attachOutput(error, stdout, stderr) {
  if (typeof stdout === 'string') error.stdout = stdout
  if (typeof stderr === 'string') error.stderr = stderr
}

/**
 * Restores what callers of a promisified `execFile` actually receive.
 *
 * Production code promisifies `execFile` and then does two things with the
 * result: it destructures `{ stdout, stderr }`, and for a request that carries a
 * body it writes that body to `child.child.stdin` on the child Node attaches to
 * the returned promise. Both are Node's own contract, so the wrapper reproduces
 * both: the resolved value is the output object, the rejected error carries the
 * output, and the promise carries the child that was started.
 *
 * The wrapper is bound to the guarded function itself, so the boundary is still
 * what decides whether a child starts, and every argument — argv, options and
 * callback alike — is forwarded as it was given, so the child environment and
 * working directory the boundary judges are the caller's own. The original
 * function's custom promisifier is never copied: that one calls the original.
 */
function withPromisifiedExecFileShape(guarded) {
  const custom = (file, ...rest) => {
    let child
    const promise = new Promise((resolve, reject) => {
      child = guarded(file, ...rest, (error, stdout, stderr) => {
        if (error) {
          attachOutput(error, stdout, stderr)
          reject(error)
        } else resolve({ stdout, stderr })
      })
    })
    promise.child = child
    return promise
  }
  return Object.assign(guarded, { [promisify.custom]: custom })
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

  // Installed before the production main is imported: the boundary has to be in
  // place before any of its modules can hold a reference to a spawn function.
  installOwnedProviderCliBoundary(options.fixtureRoot)

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
    admitOwnedProviderCliRoot,
    installOwnedProviderCliBoundary,
    KEY_FILE,
    createIsolatedSafeStorage,
    createFixtureKey,
    installIsolatedSafeStorage,
    readFixtureKey,
  }
}
