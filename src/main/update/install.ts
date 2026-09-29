import { execFile as execFileCallback, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { StagedUpdate } from './artifact'

const execFile = promisify(execFileCallback)

/** Prefixes this app alone creates, so a cleanup can never touch anything else. */
const STAGING_PREFIX = '.git-stacks-updating-'
const BACKUP_PREFIX = '.git-stacks-replaced-'

/** The marker a cut-over leaves behind when the old bundle was still in use. */
const REAP_MARKER = 'replaced-bundle.json'

/**
 * The installer formats this build knows how to apply, by platform.
 *
 * Linux is absent on purpose: it ships as a single AppImage the person runs
 * from wherever they put it, with no installed copy to replace and no signature
 * to check before running one, so it is never replaced from inside itself.
 */
const INSTALLABLE_PLATFORMS: Record<string, 'dmg' | 'nsis'> = {
  darwin: 'dmg',
  win32: 'nsis',
}

export function installSupportFor(platform: string): 'dmg' | 'nsis' | null {
  return INSTALLABLE_PLATFORMS[platform] ?? null
}

/** What an install attempt concluded, and why it stopped when it stopped. */
export interface InstallOutcome {
  installed: boolean
  reason: string
}

/**
 * Where this build lives, resolved to the thing that is actually replaced.
 *
 * On macOS what runs is `<App>.app/Contents/MacOS/<name>`, so replacing the
 * executable path would destroy the app; the bundle is the unit, and it is
 * found by walking back over the real path of the running executable to the
 * `.app` that contains it. On Windows the executable is the unit. Nothing here
 * follows a link to some other place on the machine.
 */
export interface InstallTarget {
  /** The bundle root on macOS, the executable on Windows. */
  identityPath: string
  /** The directory the bundle or executable is replaced in. */
  parent: string
}

export async function resolveInstallTarget(
  platform: string,
  appPath: string,
): Promise<{ ok: true; target: InstallTarget } | { ok: false; reason: string }> {
  if (platform === 'win32') {
    return { ok: true, target: { identityPath: appPath, parent: dirname(appPath) } }
  }
  if (platform !== 'darwin') {
    return { ok: false, reason: 'This platform has no in-app installer.' }
  }
  const resolved = await realpath(appPath).catch(() => null)
  if (!resolved) return { ok: false, reason: 'This app’s own location could not be read.' }
  const segments = resolved.split('/')
  // .../<Name>.app/Contents/MacOS/<executable> — the bundle is two segments up.
  const executableIndex = segments.lastIndexOf('MacOS')
  if (executableIndex < 2 || segments[executableIndex - 1] !== 'Contents') {
    return { ok: false, reason: 'This app is not running from a macOS application bundle.' }
  }
  const root = segments.slice(0, executableIndex - 1).join('/')
  if (!root.endsWith('.app')) {
    return { ok: false, reason: 'This app is not running from a macOS application bundle.' }
  }
  // The executable must be the one inside that bundle, not a link out of it.
  const inside = resolved.startsWith(`${root}/Contents/MacOS/`)
  if (!inside) {
    return { ok: false, reason: 'This app is not running from the bundle it was launched in.' }
  }
  const isDirectory = await stat(root)
    .then((entry) => entry.isDirectory())
    .catch(() => false)
  if (!isDirectory) {
    return { ok: false, reason: 'The macOS application bundle could not be read.' }
  }
  return { ok: true, target: { identityPath: root, parent: dirname(root) } }
}

/** The signing identity of the app that is running right now. */
export async function currentSigningIdentity(
  platform: string,
  identityPath: string,
): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const { stderr } = await execFile('codesign', ['-dv', '--verbose=4', identityPath], {
        maxBuffer: 1 << 20,
      })
      return /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
    }
    if (platform === 'win32') {
      const { stdout } = await execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-AuthenticodeSignature -LiteralPath '${identityPath.replace(/'/gu, "''")}').SignerCertificate.Subject`,
        ],
        { maxBuffer: 1 << 20 },
      )
      return stdout.trim() || null
    }
  } catch {
    // An identity this build cannot read is an identity it cannot compare, and
    // an unverifiable installer is not installed.
    return null
  }
  return null
}

/** What the new build has to be, taken from the running app and the manifest. */
interface Expectations {
  team: string
  bundleIdentifier: string
  version: string
  arch: string
}

async function plistValue(bundle: string, key: string): Promise<string | null> {
  const { stdout } = await execFile(
    'plutil',
    ['-extract', key, 'raw', join(bundle, 'Contents', 'Info.plist')],
    { maxBuffer: 1 << 20 },
  )
  return stdout.trim() || null
}

/**
 * Proves one application bundle is the release the manifest named and the app
 * that is running is entitled to replace.
 *
 * The bundle inside the image is checked, not the image: a disk image can be
 * signed and still contain a different application. The signature must verify
 * strictly, the team must be the team that signed this app, and the bundle
 * identifier, version, and architecture must be the ones this build asked for.
 */
/**
 * Every name one architecture is called in, on the two sides of this check.
 * Node and the signed manifest say `x64`; `lipo` reports the Mach-O name,
 * `x86_64`. A universal binary reports both slices, and either one satisfies
 * an Intel or Apple Silicon machine.
 */
export function machArchitectures(name: string): string[] {
  if (name === 'x64') return ['x64', 'x86_64']
  if (name === 'x86_64') return ['x64', 'x86_64']
  if (name === 'arm64') return ['arm64', 'aarch64']
  if (name === 'aarch64') return ['arm64', 'aarch64']
  return [name]
}

/**
 * Proves the disk image itself is the one this release signed, before it is
 * mounted. The application inside is checked separately and cannot stand in for
 * the image: an image can be unsigned, or signed by another team, and still
 * contain a correctly signed application.
 */
async function verifyDiskImage(image: string, expectedTeam: string): Promise<void> {
  await execFile('codesign', ['--verify', '--strict', '--verbose=2', image], { maxBuffer: 1 << 20 })
  const { stderr } = await execFile('codesign', ['-dv', '--verbose=4', image], {
    maxBuffer: 1 << 20,
  })
  const team = /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
  if (team !== expectedTeam) {
    throw new Error(
      'The downloaded disk image is signed by a different team than this app, so it was not opened.',
    )
  }
  // The image is assessed as a disk image, which is what macOS will act on when
  // it is opened; the application inside is assessed again once it is mounted.
  await execFile(
    'spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', image],
    {
      maxBuffer: 1 << 20,
    },
  )
}

async function verifyAppBundle(bundle: string, expected: Expectations): Promise<void> {
  await execFile('codesign', ['--verify', '--strict', '--verbose=2', bundle], {
    maxBuffer: 1 << 20,
  })
  const { stderr } = await execFile('codesign', ['-dv', '--verbose=4', bundle], {
    maxBuffer: 1 << 20,
  })
  const team = /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
  if (team !== expected.team) {
    throw new Error('The downloaded app is signed by a different team than this app.')
  }
  const bundleIdentifier = await plistValue(bundle, 'CFBundleIdentifier')
  if (bundleIdentifier !== expected.bundleIdentifier) {
    throw new Error(
      `The downloaded app is ${bundleIdentifier ?? 'unidentified'}, not ${expected.bundleIdentifier}.`,
    )
  }
  const version = await plistValue(bundle, 'CFBundleShortVersionString')
  if (version !== expected.version) {
    throw new Error(
      `The downloaded app is version ${version ?? 'unknown'}, not the signed ${expected.version}.`,
    )
  }
  const executable = await plistValue(bundle, 'CFBundleExecutable')
  if (!executable) throw new Error('The downloaded app names no executable.')
  const { stdout: archs } = await execFile(
    'lipo',
    ['-archs', join(bundle, 'Contents', 'MacOS', executable)],
    { maxBuffer: 1 << 20 },
  )
  const built = new Set(archs.split(/\s+/u).filter(Boolean).flatMap(machArchitectures))
  if (!built.has(expected.arch)) {
    throw new Error(
      `The downloaded app has no ${expected.arch} build, which is the one this computer needs. It has ${[...built].join(', ') || 'none'}.`,
    )
  }
  await execFile('spctl', ['--assess', '--type', 'execute', '-v', bundle], { maxBuffer: 1 << 20 })
}

async function verifyNsisIdentity(staged: StagedUpdate, expectedSubject: string): Promise<void> {
  const { stdout } = await execFile(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$signature = Get-AuthenticodeSignature -LiteralPath '${staged.path.replace(/'/gu, "''")}';` +
        `$signature.Status; $signature.SignerCertificate.Subject`,
    ],
    { maxBuffer: 1 << 20 },
  )
  const [status, subject] = stdout.trim().split(/\r?\n/u)
  if (status !== 'Valid') {
    throw new Error(`The downloaded installer is not validly signed (${status || 'unknown'}).`)
  }
  if (subject.trim() !== expectedSubject) {
    throw new Error('The downloaded installer is signed by a different publisher than this app.')
  }
}

export interface IdentityCheck {
  trusted: boolean
  reason: string
}

export interface InstallOptions {
  platform: string
  /** The app bundle or executable this build is running from. */
  appPath: string
  /** The version the signed manifest offered, checked on macOS. */
  version?: string
  /** The architecture the signed manifest offered, checked on macOS. */
  arch?: string
  /** Where a leftover from a previous cut-over is recorded. */
  userDataPath?: string
  /** Called once the platform installer has taken the update. */
  relaunch: () => void
  /** Called when this app must close for the platform installer to finish. */
  quit?: () => void
  onProgress?: (message: string) => void
}

/**
 * Applies a verified update and restarts into it.
 *
 * The new build is written beside the running one, proved there, and only then
 * swapped in; if the swap cannot complete, the app that was already installed
 * is put back. Nothing here reads or writes a user repository: the only paths
 * touched are the app bundle, a temporary mount point, and this app's own data
 * directory.
 */
export async function installStagedUpdate(
  staged: StagedUpdate,
  options: InstallOptions,
): Promise<InstallOutcome> {
  const kind = installSupportFor(options.platform)
  if (!kind) {
    return { installed: false, reason: 'This platform has no in-app installer.' }
  }
  const target = await resolveInstallTarget(options.platform, options.appPath)
  if (!target.ok) return { installed: false, reason: target.reason }
  const identity = await currentSigningIdentity(options.platform, target.target.identityPath)
  if (!identity) {
    return {
      installed: false,
      reason: 'This app is not signed, so a downloaded update cannot be trusted to replace it.',
    }
  }
  try {
    if (kind === 'dmg') {
      return await installDmg(staged, { ...options, target: target.target, team: identity })
    }
    await verifyNsisIdentity(staged, identity)
    return await installNsis(staged, options)
  } catch (error) {
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

interface DmgOptions extends InstallOptions {
  target: InstallTarget
  team: string
}

async function installDmg(staged: StagedUpdate, options: DmgOptions): Promise<InstallOutcome> {
  const { target, team } = options
  const mountPoint = await mkdtemp(join(tmpdir(), 'git-stacks-update-'))
  const transaction = randomBytes(6).toString('hex')
  const prepared = join(target.parent, `${STAGING_PREFIX}${transaction}.app`)
  const backup = join(target.parent, `${BACKUP_PREFIX}${transaction}.app`)
  let mounted = false
  try {
    options.onProgress?.('Checking the disk image against this release')
    await verifyDiskImage(staged.path, team)
    options.onProgress?.('Opening the downloaded disk image')
    await execFile(
      'hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, staged.path],
      { maxBuffer: 1 << 20 },
    )
    mounted = true
    const entries = await readdir(mountPoint, { withFileTypes: true })
    const bundles = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    if (bundles.length !== 1) {
      return {
        installed: false,
        reason: 'The downloaded disk image did not contain exactly one application.',
      }
    }
    const contained = join(mountPoint, bundles[0]?.name ?? '')
    const bundleIdentifier = await plistValue(target.identityPath, 'CFBundleIdentifier')
    if (!options.version || !options.arch || !bundleIdentifier) {
      return {
        installed: false,
        reason: 'The signed release named no version or architecture to install.',
      }
    }
    const expected: Expectations = {
      team,
      bundleIdentifier,
      version: options.version,
      arch: options.arch,
    }
    options.onProgress?.('Checking the new version’s signature')
    await verifyAppBundle(contained, expected)

    // The new build is written beside the running one and proved again there,
    // so the cut-over itself moves something already known good into place.
    options.onProgress?.('Installing the new version')
    await rm(prepared, { recursive: true, force: true })
    await execFile('ditto', [contained, prepared], { maxBuffer: 1 << 20 })
    await verifyAppBundle(prepared, expected)

    const currentBundle = basename(target.identityPath)
    const livePath = join(target.parent, currentBundle)
    if (livePath !== target.identityPath) {
      return { installed: false, reason: 'The installed app could not be located for replacement.' }
    }
    await rm(backup, { recursive: true, force: true })
    await rename(livePath, backup)
    try {
      await rename(prepared, livePath)
    } catch (error) {
      // The old app goes back exactly where it was, so a failed update leaves a
      // working app rather than a half-replaced directory.
      await rename(backup, livePath).catch(() => undefined)
      throw error
    }
    const removed = await rm(backup, { recursive: true, force: true }).then(
      () => true,
      () => false,
    )
    if (!removed && options.userDataPath) {
      await mkdir(options.userDataPath, { recursive: true })
      await writeFile(
        join(options.userDataPath, REAP_MARKER),
        `${JSON.stringify({ path: backup }, null, 2)}\n`,
        { mode: 0o600 },
      ).catch(() => undefined)
    }
    options.onProgress?.('Restarting into the new version')
    options.relaunch()
    return { installed: true, reason: 'The update was installed and the app is restarting.' }
  } finally {
    if (mounted) {
      await execFile('hdiutil', ['detach', mountPoint], { maxBuffer: 1 << 20 }).catch(
        () => undefined,
      )
    }
    await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Starts the Windows installer, and only reports an install once the installer
 * is actually running.
 *
 * A launch failure is not delivered by the call that starts it: Node reports it
 * on the child, after this function would already have returned. So the launch
 * is awaited, and this app is closed only once the installer owns the update. A
 * signature-verified file that the operating system refuses to run — an
 * application-control policy, an antivirus that removed it, a file that was
 * taken away in between — leaves this app running and reports the refusal,
 * rather than closing with no installer to finish the work.
 */
async function installNsis(staged: StagedUpdate, options: InstallOptions): Promise<InstallOutcome> {
  options.onProgress?.('Starting the installer and closing this app')
  const child = spawn(staged.path, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  const started = await new Promise<{ ok: true } | { ok: false; reason: string }>(
    (resolveLaunch) => {
      const settle = (outcome: { ok: true } | { ok: false; reason: string }) =>
        resolveLaunch(outcome)
      child.once('spawn', () => settle({ ok: true }))
      child.once('error', (error) =>
        settle({
          ok: false,
          reason: `The installer could not be started, so the update did not happen: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      )
    },
  )
  if (!started.ok) return { installed: false, reason: started.reason }
  // The installer replaces files this app is running from, so it cannot finish
  // while this process holds them open. It is detached, this app then closes,
  // and the installer completes on its own.
  child.unref()
  options.quit?.()
  return {
    installed: true,
    reason: 'The installer is running. This app closes and the update finishes on its own.',
  }
}

/**
 * Removes a bundle a previous cut-over could not delete, because the app was
 * still running from it. Only a path this app recorded, under the same parent
 * as the running bundle and carrying this app's own prefix, is ever removed.
 */
export async function reapReplacedBundle(
  target: InstallTarget,
  userDataPath: string,
): Promise<void> {
  const marker = join(userDataPath, REAP_MARKER)
  let recorded: unknown
  try {
    recorded = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    return
  }
  if (typeof recorded !== 'object' || recorded === null || !('path' in recorded)) return
  const value: unknown = recorded.path
  if (typeof value !== 'string' || value.length === 0) return
  const path = value
  if (dirname(path) !== target.parent || !basename(path).startsWith(BACKUP_PREFIX)) return
  if (existsSync(path)) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(marker, { force: true }).catch(() => undefined)
}
