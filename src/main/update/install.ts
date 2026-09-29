import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { StagedUpdate } from './artifact'

const execFile = promisify(execFileCallback)

/**
 * The installer formats this build knows how to apply, by platform.
 *
 * Linux has none: an AppImage is a single file a user runs from wherever they
 * put it, there is no installed copy to replace, and no signature to check
 * before running it. Linux is supported as a build and as a download, and
 * deliberately not as an in-place update — see the support matrix in README.md.
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

/** The signing identity of the app that is running right now. */
export async function currentSigningIdentity(
  platform: string,
  appPath: string,
): Promise<string | null> {
  try {
    if (platform === 'darwin') {
      const { stderr } = await execFile('codesign', ['-dv', '--verbose=4', appPath], {
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
          `(Get-AuthenticodeSignature -LiteralPath '${appPath.replace(/'/gu, "''")}').SignerCertificate.Subject`,
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

async function verifyDmgIdentity(staged: StagedUpdate, expectedTeam: string): Promise<void> {
  await execFile('codesign', ['--verify', '--strict', '--verbose=2', staged.path], {
    maxBuffer: 1 << 20,
  })
  const { stderr } = await execFile('codesign', ['-dv', '--verbose=4', staged.path], {
    maxBuffer: 1 << 20,
  })
  const team = /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
  if (team !== expectedTeam) {
    throw new Error('The downloaded build is signed by a different team than this app.')
  }
  await execFile(
    'spctl',
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', staged.path],
    { maxBuffer: 1 << 20 },
  )
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

/**
 * Proves a staged download carries the platform's own signature before anything
 * on this machine runs it. The comparison is against the identity of the app
 * that is already installed and trusted, not against a name configured
 * somewhere: an installer signed by anybody else is refused even when its
 * digest matches the manifest exactly.
 */
export async function verifyStagedIdentity(
  staged: StagedUpdate,
  options: { platform: string; appPath: string },
): Promise<IdentityCheck> {
  const kind = installSupportFor(options.platform)
  if (!kind) {
    return {
      trusted: false,
      reason: 'This platform has no in-app installer, so an update is downloaded for you to run.',
    }
  }
  const expected = await currentSigningIdentity(options.platform, options.appPath)
  if (!expected) {
    return {
      trusted: false,
      reason: 'This app is not signed, so a downloaded update cannot be trusted to replace it.',
    }
  }
  try {
    if (kind === 'dmg') await verifyDmgIdentity(staged, expected)
    else await verifyNsisIdentity(staged, expected)
    return { trusted: true, reason: 'The download carries this app’s own platform signature.' }
  } catch (error) {
    return { trusted: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export interface InstallOptions {
  platform: string
  /** The app bundle or executable this build is running from. */
  appPath: string
  /** Called once the platform installer has taken the update. */
  relaunch: () => void
  onProgress?: (message: string) => void
}

/**
 * Applies a verified update and restarts into it.
 *
 * The old copy is moved aside rather than overwritten in place, so a failure
 * part-way through leaves a working app to go back to. Nothing here reads or
 * writes a user repository: the only paths touched are the app bundle and a
 * temporary mount point.
 */
export async function installStagedUpdate(
  staged: StagedUpdate,
  options: InstallOptions,
): Promise<InstallOutcome> {
  const identity = await verifyStagedIdentity(staged, options)
  if (!identity.trusted) return { installed: false, reason: identity.reason }
  try {
    if (options.platform === 'darwin') return await installDmg(staged, options)
    if (options.platform === 'win32') return await installNsis(staged, options)
    return { installed: false, reason: 'This platform has no in-app installer.' }
  } catch (error) {
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

async function installDmg(staged: StagedUpdate, options: InstallOptions): Promise<InstallOutcome> {
  const mountPoint = await mkdtemp(join(tmpdir(), 'git-stacks-update-'))
  let mounted = false
  try {
    options.onProgress?.('Opening the downloaded disk image')
    await execFile(
      'hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, staged.path],
      { maxBuffer: 1 << 20 },
    )
    mounted = true
    const bundles = (await readdir(mountPoint, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => join(mountPoint, entry.name))
    if (bundles.length !== 1) {
      return {
        installed: false,
        reason: 'The downloaded disk image did not contain exactly one application.',
      }
    }
    options.onProgress?.('Installing the new version')
    const previous = `${options.appPath}.replaced`
    await rm(previous, { recursive: true, force: true })
    await rename(options.appPath, previous)
    try {
      await execFile('ditto', [bundles[0] as string, options.appPath], { maxBuffer: 1 << 20 })
    } catch (error) {
      await rename(previous, options.appPath)
      throw error
    }
    await rm(previous, { recursive: true, force: true })
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

async function installNsis(staged: StagedUpdate, options: InstallOptions): Promise<InstallOutcome> {
  options.onProgress?.('Running the installer')
  await execFile(staged.path, ['/S'], { maxBuffer: 1 << 20 })
  options.onProgress?.('Restarting into the new version')
  options.relaunch()
  return { installed: true, reason: 'The update was installed and the app is restarting.' }
}
