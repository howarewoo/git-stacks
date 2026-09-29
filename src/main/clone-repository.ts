import { randomUUID } from 'node:crypto'
import { lstat, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  CommandCancelled,
  commandCode,
  commandDetail,
  executeCapped,
  isCancelled,
  stripTrailingNewline,
  tryGit,
  type CappedResult,
} from './git-core'
import {
  gitCommandEnvironment,
  resolveGitRuntime,
  withGitRuntime,
  type GitRuntimeRecord,
} from './git-runtime'
import type { GitEnvironmentStatus, OnboardingFailureReason } from '../shared/types'
import { assertDirectoryName, assertFullName } from './github-repositories'

/** Cloning a real repository takes longer than any read the app performs. */
const CLONE_TIMEOUT_MS = 30 * 60_000
/** Configuration reads and the empty-repository probe answer or fail immediately. */
const READ_TIMEOUT_MS = 20_000
const READ_BYTES = 8 * 1024
/** `ssh -V` prints one line; a handful of bytes is all the version needs. */
const SSH_TIMEOUT_MS = 5_000
const SSH_VERSION = /OpenSSH[_ ]([A-Za-z0-9._-]+)/u
/** The hidden folder a clone is built in before it is renamed into place. */
const STAGING_PREFIX = '.git-stacks-clone-'

/** A refusal with a name the renderer can explain, instead of Git's raw stderr. */
export class CloneError extends Error {
  readonly reason: OnboardingFailureReason

  constructor(reason: OnboardingFailureReason, message: string) {
    super(message)
    this.name = 'CloneError'
    this.reason = reason
  }
}

/**
 * Git reports a refusal in prose on stderr. Mapping the messages a clone
 * actually produces onto named outcomes keeps single sign-on denial, a missing
 * key, an unknown repository, and a plain network fault distinguishable instead
 * of scraping output for success.
 */
const FAILURES: readonly (readonly [RegExp, OnboardingFailureReason, string])[] = [
  [
    /Permission denied \(publickey\)|Host key verification failed|Too many authentication failures|Could not resolve hostname|Connection refused/iu,
    'ssh',
    'Git could not use your SSH key for this repository.',
  ],
  [
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password|returned error: (401|403)/iu,
    'authentication',
    'Git could not authenticate. Set up Git credentials for HTTPS, or choose SSH and add a key to GitHub.',
  ],
  [
    /SSL certificate problem|unable to access|Connection reset|remote end hung up|Failed to connect|Operation timed out|couldn't connect to server|Network is unreachable/iu,
    'network',
    'Git could not reach the remote.',
  ],
  // Git reports a refused key and a hidden repository with the same sentence, so
  // the SSH case above is matched first and this names only what is left.
  [
    /Repository not found|could not read from remote repository|does not appear to be a git repository|remote: not found|(?:^|\n)fatal: repository .* does not exist/iu,
    'not-found',
    'GitHub does not have that repository, or this credential cannot see it.',
  ],
]

/** Names the refusal a clone produced, or reports the detail it could not name. */
export function classifyCloneFailure(detail: string): CloneError {
  for (const [pattern, reason, message] of FAILURES) {
    if (pattern.test(detail)) return new CloneError(reason, message)
  }
  return new CloneError('failed', detail || 'The clone failed.')
}

export interface CloneOptions {
  /** `https://github.com/owner/name.git` or `git@github.com:owner/name.git`. */
  url: string
  fullName: string
  parentDirectory: string
  directoryName: string
  shallow: boolean
  signal?: AbortSignal
}

export interface CloneOutcome {
  path: string
  /** GitHub had no commits; the working tree is an empty repository. */
  empty: boolean
}

function commandOptions(runtime: GitRuntimeRecord, signal?: AbortSignal) {
  return {
    maxBytes: READ_BYTES,
    timeoutMs: READ_TIMEOUT_MS,
    env: gitCommandEnvironment(runtime),
    ...(signal ? { signal } : {}),
  }
}

/** Whether a path is present at all: a missing path and an unreadable one both mean no. */
async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Removes the staging folder this one clone created, and nothing else. The
 * random identifier minted for that clone is in the name, so a path that does
 * not carry it was never ours to delete.
 */
async function discardStaging(staging: string, token: string): Promise<void> {
  if (!staging.includes(`${STAGING_PREFIX}${token}`)) return
  await rm(staging, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * One repository, cloned by ordinary Git into a folder this application owns
 * until the last step.
 *
 * The clone is built in a hidden staging folder beside the destination and is
 * renamed into place only after Git finished, so the destination either does not
 * exist yet or is a complete repository. A cancelled or failed clone removes
 * its own staging folder and nothing else, so no half-repository is ever left
 * for the app to register.
 */
export async function cloneRepository(options: CloneOptions): Promise<CloneOutcome> {
  assertFullName(options.fullName)
  const directoryName = assertDirectoryName(options.directoryName)
  if (!isAbsolute(options.parentDirectory) || !options.parentDirectory.trim()) {
    throw new CloneError('invalid-destination', 'Choose an existing folder to clone into.')
  }
  const parent = options.parentDirectory
  if (!(await present(parent))) {
    throw new CloneError('invalid-destination', 'That folder does not exist.')
  }
  const destination = join(parent, directoryName)
  if (await present(destination)) {
    throw new CloneError(
      'destination-exists',
      `${directoryName} already exists in that folder. Choose another name, or open the existing folder.`,
    )
  }

  const token = randomUUID()
  const staging = join(parent, `${STAGING_PREFIX}${token}`)
  const runtime = await resolveGitRuntime()
  try {
    await withGitRuntime(runtime, () =>
      executeCapped(
        runtime.executable,
        ['clone', ...(options.shallow ? ['--depth', '1'] : []), '--', options.url, staging],
        parent,
        {
          maxBytes: READ_BYTES,
          timeoutMs: CLONE_TIMEOUT_MS,
          env: gitCommandEnvironment(runtime),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      ),
    )
  } catch (error) {
    await discardStaging(staging, token)
    if (isCancelled(error) || options.signal?.aborted) throw new CommandCancelled()
    throw classifyCloneFailure(commandDetail(error))
  }

  try {
    await rename(staging, destination)
  } catch (error) {
    // The destination is someone else's data: it is reported, never replaced.
    await discardStaging(staging, token)
    throw new CloneError(
      'destination-exists',
      `The clone finished but ${directoryName} could not be moved into place: ${commandDetail(error)}`,
    )
  }

  // Git reports its working tree root on stdout with a trailing newline, which
  // must not become part of the path the rest of the app opens.
  const reported = await tryGit(destination, ['rev-parse', '--show-toplevel'], options.signal)
  const path = reported ? stripTrailingNewline(reported).trim() || destination : destination
  const head = await tryGit(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return { path, empty: head === null }
}

/**
 * Reads one Git configuration value outside any repository, so neither a
 * repository's own configuration nor a global one is written. An unset key is
 * exit status 1, not a failure.
 */
function configValue(runtime: GitRuntimeRecord, key: string, all = false): Promise<string[]> {
  return withGitRuntime(runtime, async () => {
    let output: CappedResult
    try {
      output = await executeCapped(
        runtime.executable,
        ['config', all ? '--get-all' : '--get', key],
        homedir(),
        commandOptions(runtime),
      )
    } catch (error) {
      if (commandCode(error) === 1) return []
      throw error
    }
    return stripTrailingNewline(output.text)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)
  })
}

/** Whether an SSH client Git can drive answers, and which version says so. */
async function probeSsh(): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await executeCapped('ssh', ['-V'], homedir(), {
      maxBytes: READ_BYTES,
      timeoutMs: SSH_TIMEOUT_MS,
    })
    const match = SSH_VERSION.exec(stripTrailingNewline(result.text))
    return { available: true, version: match ? match[1] : 'detected' }
  } catch {
    return { available: false, version: null }
  }
}

/**
 * What this machine can already do with Git. Every value here is read, never
 * written: Git Stacks invents no commit identity, installs no credential helper,
 * and configures no SSH key.
 */
export async function readGitEnvironment(signal?: AbortSignal): Promise<GitEnvironmentStatus> {
  if (signal?.aborted) throw new CommandCancelled()
  const runtime = await resolveGitRuntime()
  const [name, email, defaultBranch, helpers, ssh] = await Promise.all([
    configValue(runtime, 'user.name'),
    configValue(runtime, 'user.email'),
    configValue(runtime, 'init.defaultBranch'),
    configValue(runtime, 'credential.helper', true),
    probeSsh(),
  ])
  return {
    identity: { name: name[0] ?? null, email: email[0] ?? null },
    defaultBranch: defaultBranch[0] ?? null,
    httpsCredentials: { configured: helpers.length > 0, helper: helpers[0] ?? null },
    ssh,
  }
}
