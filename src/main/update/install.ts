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
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, win32 as winPath } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { StagedUpdate } from './artifact'

const execFile = promisify(execFileCallback)

/**
 * The platform tools this module runs, named by the absolute path the operating
 * system keeps them at.
 *
 * A tool name on its own is resolved through `PATH`, and on Windows through the
 * current directory as well — which is the repository the app was started in. A
 * `powershell.exe` sitting in that repository would be executed, and believed
 * about a signature, before anything had checked anything. Every tool here is
 * therefore the full path, and a tool that is not at its path is not run: the
 * call fails, and a verifier that cannot run refuses rather than guessing.
 *
 * These are all part of a stock macOS: `codesign`, `spctl`, `plutil`, `hdiutil`
 * and `ditto` are what the system itself uses to answer the same questions.
 * Nothing from a developer-tools package is used here, because an update has to
 * work on a machine that has never had Xcode installed on it.
 */
export const MACOS_TOOLS = {
  codesign: '/usr/bin/codesign',
  spctl: '/usr/sbin/spctl',
  plutil: '/usr/bin/plutil',
  hdiutil: '/usr/bin/hdiutil',
  ditto: '/usr/bin/ditto',
} as const

const WINDOWS_POWERSHELL = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * The absolute path of the Windows PowerShell this module runs, derived from the
 * system directory Windows itself reports.
 *
 * `SystemRoot` is the one environment value that can be trusted to name the
 * operating system, and it is required to be an absolute Windows path with no
 * way out of it: a relative value, a value with a `..` in it, or anything that
 * does not end in the interpreter's own directory is a refusal, not something to
 * repair. The result is used only if a file is actually there.
 */
export function windowsPowerShellPath(systemRoot: string | undefined): string {
  if (!systemRoot || !winPath.isAbsolute(systemRoot)) {
    throw new Error('Windows reported no system directory, so no signature can be read.')
  }
  // The check is on the value as reported, before it is normalised: a path that
  // steps out of the system directory is refused rather than resolved to
  // somewhere it should never have been allowed to reach.
  if (systemRoot.split(/[\\/]+/u).some((segment) => segment === '..')) {
    throw new Error('The Windows system directory is not a directory, so no signature can be read.')
  }
  const root = winPath.normalize(systemRoot)
  const executable = winPath.join(root, WINDOWS_POWERSHELL)
  if (!winPath.isAbsolute(executable) || !executable.endsWith(winPath.join(WINDOWS_POWERSHELL))) {
    throw new Error('The Windows PowerShell path is not a system path.')
  }
  return executable
}

/** Prefixes this app alone creates, so a cleanup can never touch anything else. */
const STAGING_PREFIX = '.git-stacks-updating-'
const BACKUP_PREFIX = '.git-stacks-replaced-'

/** The marker a cut-over leaves behind when the old bundle was still in use. */
const REAP_MARKER = 'replaced-bundle.json'

/**
 * Where a run's owner-private copy is kept, and what the directories this app
 * makes inside it are called. Both are named here so the run that creates the
 * directory and the cleanup that removes it agree on one answer, and a record
 * can be checked against them.
 */
export const HANDOFF_PARENT = 'handoff'
export const HANDOFF_PREFIX = 'run-'

/** The marker a run leaves when the installer it started outlives the call. */
const RETAINED_MARKER = 'retained-handoff.json'

/**
 * The two files that live inside a run's handoff directory, and that no other
 * process on this computer may write: the one this app leaves for the
 * installer to read, and the one the installer leaves when it is finished.
 *
 * Their names are part of the contract with the installer this repository
 * builds, in `build/installer.nsh`. Both are named here and there so a change
 * to one that is not made to the other reads as unfinished rather than as a
 * handoff nobody can ever complete.
 */
const HANDOFF_REQUEST = 'git-stacks-handoff.txt'
const HANDOFF_COMPLETE = 'git-stacks-install-complete.txt'

/**
 * Leaves the token the installer will echo back, and returns it.
 *
 * The token is written before the installer exists, into the directory this
 * attempt made, so that whichever instance of the installer does the work has
 * something to answer with. A value nobody can predict, in a directory only
 * this user's app can write, is what makes that answer worth reading: an echo
 * naming a different token belongs to a different attempt, and is not an
 * answer about this one.
 *
 * It is one ASCII line ending in CRLF, which is the line the installer reads a
 * token out of and the line it writes its answer back in — see
 * `build/installer.nsh`, which is the other half of this.
 */
export async function beginHandoff(directory: string): Promise<string> {
  const token = randomBytes(16).toString('hex')
  await writeFile(join(directory, HANDOFF_REQUEST), `token=${token}\r\n`, { mode: 0o600 })
  return token
}

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

/**
 * The platform installer that is still using the prepared executable after the
 * call that started it has returned.
 */
export interface RetainedInstall {
  /**
   * The token this run left beside the prepared copy for the installer to read
   * back. The installer echoes it when the work it was sent to do is finished,
 * with the process that finished it, and that echoed token is the only thing
 * this app treats as a completion.
   */
  token: string
}

/** What an install attempt concluded, and why it stopped when it stopped. */
export interface InstallOutcome {
  installed: boolean
  reason: string
  /**
   * Set only when the platform installer still holds — or may yet reopen — the
   * prepared executable after this call returned. The caller must not remove
   * that file while this is set; it is what the installer was given to run.
   */
  retains?: RetainedInstall
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
      const { stderr } = await execFile(
        MACOS_TOOLS.codesign,
        ['-dv', '--verbose=4', identityPath],
        {
          maxBuffer: 1 << 20,
        },
      )
      return /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
    }
    if (platform === 'win32') {
      const { stdout } = await execFile(
        windowsPowerShellPath(process.env.SystemRoot ?? process.env.WINDIR),
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
    MACOS_TOOLS.plutil,
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
 *
 * Node and the signed manifest say `x64`; a Mach-O header says `x86_64`, and a
 * universal binary reports both slices, and either one satisfies an Intel or
 * Apple Silicon machine.
 */
export function machArchitectures(name: string): string[] {
  if (name === 'x64') return ['x64', 'x86_64']
  if (name === 'x86_64') return ['x64', 'x86_64']
  if (name === 'arm64') return ['arm64', 'aarch64']
  if (name === 'aarch64') return ['arm64', 'aarch64']
  return [name]
}

/** The one name this app uses for an architecture, on either side of a check. */
export function canonicalArchitecture(name: string): string {
  return machArchitectures(name)[0] ?? name
}

const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const THIN_MAGIC = 0xfeedface
const THIN_MAGIC_64 = 0xfeedfacf
const CPU_ARCH_ABI64 = 0x01000000
const CPU_TYPE_X86 = 7
const CPU_TYPE_ARM = 12
/** The most a universal binary's slice table is ever allowed to claim. */
const FAT_TABLE_LIMIT = 4096
/** The most slices a table is allowed to describe before it stops being one. */
const FAT_SLICE_LIMIT = 64
/** The most a single slice's own header may be, to read the one field read. */
const SLICE_HEADER_LIMIT = 4096

/**
 * The architectures a Mach-O file carries, read out of its own headers.
 *
 * `lipo` is a developer tool, and asking a person to install one to be able to
 * update the app they already have is not a thing this app can do. The file says
 * the same thing and is in the file: a universal binary is a table of slices,
 * each with an offset, a size, and a header naming its own processor, and a
 * single-architecture binary is one such header at the start of the file.
 *
 * Three things this will not do, because each of them would let a file claim an
 * architecture it does not have:
 *
 * - **Read the whole file.** Only the bytes a header or a table actually says
 *   are read, each with an explicit length, from a file descriptor, and every
 *   read is bounded by what the file itself is large enough to contain. A
 *   200 MB executable is read as a few kilobytes.
 * - **Trust the table.** The table says which offsets to look at; the header at
 *   each of those offsets has to say the same processor. A table that points at
 *   something which is not a slice of that architecture is a file that is not
 *   what it claims, and it is refused rather than believed.
 * - **Believe a name for a 32-bit build.** The 64-bit flag is cleared to compare
 *   processor families, so a 32-bit x86 or ARM header would otherwise be read as
 *   its 64-bit sibling. A 32-bit slice is named for what it is and does not
 *   satisfy a 64-bit machine.
 *
 * An `arm64e` slice is an arm64 slice as far as running it goes, so it is
 * reported as one. A file that is not a Mach-O file, a truncated one, a table
 * pointing outside the file, and a slice whose header contradicts the table all
 * read as no architectures: a refusal, not a guess.
 */
export function readMachArchitectures(file: string): string[] {
  let handle: number | undefined
  try {
    handle = openSync(file, 'r')
    const size = fstatSync(handle).size
    const leading = readAt(handle, 0, Math.min(size, FAT_TABLE_LIMIT), size)
    if (leading.length < 8) return []
    for (const order of BYTE_ORDERS) {
      const magic = u32(leading, order, 0)
      if (magic === THIN_MAGIC || magic === THIN_MAGIC_64) {
        return readThin(handle, order, size)
      }
    }
    for (const order of BYTE_ORDERS) {
      const magic = u32(leading, order, 0)
      if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
        return readUniversal(handle, order, size)
      }
    }
    return []
  } catch {
    // A file that cannot be read is a file whose architectures are unknown, and
    // an update whose architecture is unknown is not installed.
    return []
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

const BYTE_ORDERS = ['LE', 'BE'] as const
type ByteOrder = (typeof BYTE_ORDERS)[number]

/** A four-byte field in the order its own header declares. */
function u32(buffer: Buffer, order: ByteOrder, at: number): number {
  return order === 'LE' ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at)
}

/** An eight-byte field in the order its own table declares. */
function u64(buffer: Buffer, order: ByteOrder, at: number): number {
  const value = order === 'LE' ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.NaN
  return Number(value)
}

/** Exactly `length` bytes at `at`, or nothing if the file is not that long. */
function readAt(handle: number, at: number, length: number, size: number): Buffer {
  if (at < 0 || length < 0 || at + length > size) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  const read = readSync(handle, buffer, 0, length, at)
  return read === length ? buffer : Buffer.alloc(0)
}

function readThin(handle: number, order: ByteOrder, size: number): string[] {
  const header = readAt(handle, 0, Math.min(size, 32), size)
  if (header.length < 8) return []
  const magic = u32(header, order, 0)
  // A 64-bit magic on a header that does not declare the 64-bit ABI is not a
  // 64-bit build, and a 32-bit one is not this machine's architecture.
  const sixtyFour = magic === THIN_MAGIC_64
  // The 64-bit ABI is a bit in the cpu type, not the whole of it: the check is
  // that bit, so a 32-bit header and a 64-bit one cannot be told apart by
  // clearing it.
  const cpuType = u32(header, order, 4)
  if ((cpuType & CPU_ARCH_ABI64) !== (sixtyFour ? CPU_ARCH_ABI64 : 0)) return []
  // Byte 4 is the CPU type and byte 8 is the CPU subtype, and they are not the
  // same field: an arm64 binary carries subtype 0 and an x86_64 one subtype 3,
  // so reading the subtype here would answer "no architecture" for both and
  // refuse a correctly signed update for the machine it was built for.
  const name = architectureName(cpuType, sixtyFour)
  return name ? [name] : []
}

function readUniversal(handle: number, order: ByteOrder, size: number): string[] {
  const table = readAt(handle, 0, Math.min(size, FAT_TABLE_LIMIT), size)
  if (table.length < 8) return []
  const sixtyFour = u32(table, order, 0) === FAT_MAGIC_64
  const entrySize = sixtyFour ? 32 : 20
  const count = u32(table, order, 4)
  // A table that claims more slices than a table can hold, or more than any
  // real file has, is refused before a single offset is followed.
  if (count === 0 || count > FAT_SLICE_LIMIT) return []
  if (8 + count * entrySize > table.length) return []
  const found = new Set<string>()
  for (let slice = 0; slice < count; slice += 1) {
    const at = 8 + slice * entrySize
    const claimed = u32(table, order, at)
    const claimedSixtyFour = (claimed & CPU_ARCH_ABI64) !== 0
    const offset = sixtyFour ? u64(table, order, at + 8) : u32(table, order, at + 8)
    const sliceSize = sixtyFour ? u64(table, order, at + 16) : u32(table, order, at + 12)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(sliceSize)) return []
    // The slice has to be inside the file and big enough to hold a header.
    if (offset < 8 || sliceSize < 32 || offset + sliceSize > size) return []
    const header = readAt(handle, offset, Math.min(sliceSize, SLICE_HEADER_LIMIT), size)
    if (header.length < 12) return []
    // The slice's own header decides, and it has to agree with the table: a
    // table entry pointing at something else is a file that is not what it says.
    let declared: { name: string | null; sixtyFour: boolean } | null = null
    for (const sliceOrder of BYTE_ORDERS) {
      const magic = u32(header, sliceOrder, 0)
      if (magic !== THIN_MAGIC && magic !== THIN_MAGIC_64) continue
      const sixtyFourMagic = magic === THIN_MAGIC_64
      const cpu = u32(header, sliceOrder, 4)
      if ((cpu & CPU_ARCH_ABI64) !== (sixtyFourMagic ? CPU_ARCH_ABI64 : 0)) continue
      declared = {
        name: architectureName(cpu, sixtyFourMagic),
        sixtyFour: sixtyFourMagic,
      }
      break
    }
    if (declared === null) return []
    if (declared.sixtyFour !== claimedSixtyFour) return []
    if (architectureName(claimed, claimedSixtyFour) !== declared.name) return []
    if (declared.name) found.add(declared.name)
  }
  return [...found].sort()
}

/** The name this app uses for a Mach-O cpu type, or null for another one. */
function architectureName(cpuType: number, sixtyFour: boolean): string | null {
  if (!sixtyFour) return null
  const base = cpuType & ~CPU_ARCH_ABI64
  if (base === CPU_TYPE_X86) return 'x64'
  if (base === CPU_TYPE_ARM) return 'arm64'
  return null
}

/**
 * Proves the disk image itself is the one this release signed, before it is
 * mounted. The application inside is checked separately and cannot stand in for
 * the image: an image can be unsigned, or signed by another team, and still
 * contain a correctly signed application.
 *
 * An unsigned image is refused here rather than opened and inspected later, so
 * the question "is this the release, from this project" is answered by the
 * platform's own signature check and not by anything this app decides
 * afterwards. The application inside then has to answer it again with more:
 * same bundle identifier, same version, a stapled ticket, and its own Gatekeeper
 * assessment.
 */
async function verifyDiskImage(image: string, expectedTeam: string): Promise<void> {
  await execFile(MACOS_TOOLS.codesign, ['--verify', '--strict', '--verbose=2', image], {
    maxBuffer: 1 << 20,
  })
  const { stderr } = await execFile(MACOS_TOOLS.codesign, ['-dv', '--verbose=4', image], {
    maxBuffer: 1 << 20,
  })
  const team = /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
  if (team !== expectedTeam) {
    throw new Error(
      'The downloaded disk image is signed by a different team than this app, so it was not opened.',
    )
  }
  // The image is assessed as a disk image, which is what macOS acts on when it
  // is opened. The application inside is assessed again once it is mounted, and
  // that assessment is what decides whether it may be run.
  await execFile(
    MACOS_TOOLS.spctl,
    ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', image],
    {
      maxBuffer: 1 << 20,
    },
  )
}

async function verifyAppBundle(bundle: string, expected: Expectations): Promise<void> {
  await execFile(MACOS_TOOLS.codesign, ['--verify', '--strict', '--verbose=2', bundle], {
    maxBuffer: 1 << 20,
  })
  const { stderr } = await execFile(MACOS_TOOLS.codesign, ['-dv', '--verbose=4', bundle], {
    maxBuffer: 1 << 20,
  })
  const team = /TeamIdentifier=([A-Z0-9]+)/u.exec(stderr)?.[1] ?? null
  if (team !== expected.team) {
    throw new Error('The downloaded app is signed by a different team than this app.')
  }
  // Gatekeeper is the operating system's own answer to "may this run", and it is
  // the answer a person gets when they open the new build, so it is asked here
  // rather than approximated. It reads the stapled ticket and the notarisation
  // record, which is why the release job also proves the ticket with
  // `xcrun stapler validate` where the developer tools exist: nothing in this
  // path requires Xcode, or `lipo`, or any other tool a person who only wants
  // the update will have.
  await execFile(MACOS_TOOLS.spctl, ['--assess', '--type', 'execute', '-v', bundle], {
    maxBuffer: 1 << 20,
  })
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
  const built = new Set(readMachArchitectures(join(bundle, 'Contents', 'MacOS', executable)))
  if (!built.has(canonicalArchitecture(expected.arch))) {
    throw new Error(
      `The downloaded app has no ${expected.arch} build, which is the one this computer needs. It has ${[...built].join(', ') || 'none'}.`,
    )
  }
}

async function verifyNsisIdentity(staged: StagedUpdate, expectedSubject: string): Promise<void> {
  const { stdout } = await execFile(
    windowsPowerShellPath(process.env.SystemRoot ?? process.env.WINDIR),
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
  /**
   * Called with the installer process that outlives this call, before this app
   * is asked to close. The caller owns the prepared copy and has to record that
   * it is still in use while this app is still running and able to record it.
   */
  onRetain?: (retained: RetainedInstall) => Promise<void> | void
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
      MACOS_TOOLS.hdiutil,
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
    await execFile(MACOS_TOOLS.ditto, [contained, prepared], { maxBuffer: 1 << 20 })
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
      await execFile(MACOS_TOOLS.hdiutil, ['detach', mountPoint], { maxBuffer: 1 << 20 }).catch(
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
 *
 * The installer is given a path, not a copy of itself in memory, and it is
 * still using that path after this function has returned. The outcome says so
 * rather than leaving the caller to assume the call was the whole of it.
 */
async function installNsis(staged: StagedUpdate, options: InstallOptions): Promise<InstallOutcome> {
  options.onProgress?.('Starting the installer and closing this app')
  // The token goes out before the installer exists, so that whichever instance
  // of it does the work has something to answer with when it finishes.
  const token = await beginHandoff(dirname(staged.path))
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
  // Being spawned is not the same as having read the file. A Windows installer
  // opens its own executable again after it starts, and elevation hands the
  // work to a second instance of it that begins after this process has gone,
  // so the prepared copy is still in use while this app is still running, and
  // removing it here is what left an update installing from a file that had
  // already been unlinked.
  //
  // No process this app knows of can say when that work is over — the one it
  // spawned is not the one that does it — so it is not asked. The token is
  // carried instead, and the installer writes it back with the process that
  // finished. This app removes the copy only after a later launch has read
  // that back and found that process gone; anything else leaves it in place.
  const retained: RetainedInstall = { token }
  await options.onRetain?.(retained)
  options.quit?.()
  return {
    installed: true,
    reason: 'The installer is running. This app closes and the update finishes on its own.',
    retains: retained,
  }
}

/**
 * Records a prepared copy that a platform installer was handed and has not
 * finished with, together with the token that installer has to echo back.
 *
 * The record is written by the run that created the directory and owns it,
 * while this app is still running: a run that hands a file to a detached
 * installer is about to be asked to close, and a record written after that may
 * never reach the disk. A record that cannot be written does not fail the
 * update — the copy is still kept, it is only left with no way to be ever
 * proven finished — so nothing here throws.
 */
export async function recordRetainedHandoff(
  userDataPath: string,
  directory: string,
  retained: RetainedInstall,
): Promise<void> {
  const body = `${JSON.stringify({ path: directory, token: retained.token }, null, 2)}\n`
  await writeFile(join(userDataPath, RETAINED_MARKER), body, { mode: 0o600 }).catch(() => undefined)
}

/**
 * Removes a prepared copy, once the installer that was using it has said it
 * finished and that installer has gone.
 *
 * The run that handed the copy over could not remove it: the installer was
 * spawned and this app was closed while the installer was still going to read
 * that file. And the run could not wait either, because no process it knows of
 * can answer that question. A Windows installer hands the work to a second
 * instance of itself when it elevates, and that instance starts after the one
 * that was spawned has exited and reads this same file — so the spawned process
 * is not the installer, and its exit says nothing about the file being free.
 *
 * So the answer is asked of the installer itself rather than guessed here. At
 * the end of the install it echoes the token this run left beside the copy,
 * with the process id of the instance that finished the work — the elevated
 * one when it elevated, the original one when it did not. Removal requires that
 * echo, with this run's own token in it, and requires the process it names to
 * be gone: signal 0 asks without touching it, and only "no such process" counts.
 *
 * Every other outcome leaves the copy exactly where it is. No echo at all, an
 * echo carrying another attempt's token, an echo that cannot be read, one that
 * names no process, a process still running, a refusal to signal it because it
 * runs as another user: all of these keep the copy, because a copy that is
 * kept is a file this app can clean up later and a copy that is removed early
 * is an update that installs from nothing.
 *
 * Nothing is removed unless the record names a directory this app made, inside
 * the handoff parent, carrying this app's own prefix — the same rule the
 * replaced-bundle marker follows — and the completion is read from inside that
 * directory, so nothing written anywhere else on this computer is ever read,
 * believed, or removed.
 */
export async function reapRetainedHandoff(userDataPath: string): Promise<void> {
  const marker = join(userDataPath, RETAINED_MARKER)
  let recorded: unknown
  try {
    recorded = JSON.parse(await readFile(marker, 'utf8'))
  } catch {
    return
  }
  if (typeof recorded !== 'object' || recorded === null || !('path' in recorded)) return
  const value: unknown = recorded.path
  const token: unknown = 'token' in recorded ? recorded.token : null
  if (typeof value !== 'string' || value.length === 0) return
  if (typeof token !== 'string' || token.length === 0) return
  if (dirname(value) !== join(userDataPath, HANDOFF_PARENT)) return
  if (!basename(value).startsWith(HANDOFF_PREFIX)) return
  const completion = await readFile(join(value, HANDOFF_COMPLETE), 'utf8').catch(() => null)
  // No answer at all: the installer never got that far, or it is an installer
  // built before this protocol existed. There is nothing to believe, so the
  // copy stays.
  if (completion === null) return
  // The answer is a line per field, each `name=value`, the shape the request is
  // written in. The value ends at the next space, so a file carrying both
  // fields on one line is read as what it is rather than as a token with a pid
  // glued to it.
  let echoed = ''
  let pid = Number.NaN
  for (const line of completion.split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const field = line.slice(separator + 1).trim().split(/\s+/u)[0] ?? ''
    if (key === 'token') echoed = field
    if (key === 'pid') pid = Number(field)
  }
  if (echoed !== token) return
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, 0)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
  }
  if (existsSync(value)) {
    await rm(value, { recursive: true, force: true }).catch(() => undefined)
  }
  await rm(marker, { force: true }).catch(() => undefined)
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
