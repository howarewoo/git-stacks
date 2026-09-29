import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { MAX_COMMAND_BYTES, MAX_STATUS_BYTES } from '../shared/performance'
import type { ChangedFile, GitOperation, Stash } from '../shared/types'
import { gitCommandEnvironment, resolveGitRuntime } from './git-runtime'

export const execFile = promisify(execFileCallback)
export const MAX_BUFFER = MAX_COMMAND_BYTES
export const MAX_BRANCH_LENGTH = 1024
export const MAX_PATH_LENGTH = 32 * 1024
export const MAX_MESSAGE_LENGTH = 256 * 1024

export interface CommandError extends Error {
  code?: string | number
  stdout?: string
  stderr?: string
}

export interface RefRecord {
  refname: string
  objectName: string
  upstream: string
  track: string
  subject: string
  updatedAt: string
  symref: string
}

export interface OperationState {
  rebase: boolean
  busy: boolean
  operation: GitOperation | null
}

export interface ParsedRemote {
  /**
   * The host that owns the remote, including an explicit port. A GitHub
   * Enterprise Server host is commonly served from one, and dropping it would
   * point every request for this repository at the default port of a host that
   * does not answer there. An SSH remote's port is part of its host name and is
   * likewise kept.
   */
  host: string
  owner: string
  name: string
  fullName: string
}

export function commandDetail(error: unknown): string {
  const commandError = error as CommandError
  const stderr = typeof commandError.stderr === 'string' ? commandError.stderr.trim() : ''
  const message = error instanceof Error ? error.message.trim() : String(error)
  return stderr || message
}

export function commandCode(error: unknown): string | number | undefined {
  const value = (error as CommandError | undefined)?.code
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

export function isExitCode(error: unknown, code: number): boolean {
  return commandCode(error) === code
}

export function stripTrailingNewline(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)+$/, '')
}

export async function execute(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  if (signal) {
    const result = await executeCapped(command, args, cwd, { env, maxBytes: MAX_BUFFER, signal })
    if (result.truncated) throw new Error(`${command} output exceeds the 32 MiB command limit.`)
    return result.text
  }
  try {
    const result = await execFile(command, args, {
      cwd,
      env: commandEnvironment(env),
      timeout: command === 'gh' ? 20_000 : 120_000,
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    })
    return typeof result.stdout === 'string' ? result.stdout : String(result.stdout)
  } catch (error) {
    const commandError = error as CommandError
    if (typeof commandError.stderr !== 'string') {
      commandError.stderr = ''
    }
    throw commandError
  }
}

/** A read the caller abandoned; never a repository or command failure. */
export class CommandCancelled extends Error {
  readonly cancelled = true

  constructor() {
    super('The request was cancelled.')
    this.name = 'CommandCancelled'
  }
}

export function isCancelled(error: unknown): boolean {
  if (error instanceof CommandCancelled) return true
  if (error && typeof error === 'object') {
    if ('name' in error && error.name === 'AbortError') return true
    if ('kind' in error && error.kind === 'cancelled') return true
  }
  return false
}

export interface CappedOptions {
  env?: NodeJS.ProcessEnv
  /** Stop retaining output past this many bytes and end the process. */
  maxBytes: number
  /** Cut the retained output at the last whole occurrence of this separator. */
  boundary?: string
  signal?: AbortSignal
  /** Overrides the per-command deadline; a clone needs longer than a status read. */
  timeoutMs?: number
}

export interface CappedResult {
  text: string
  truncated: boolean
}

/**
 * Runs a read-only command and retains at most `maxBytes` of stdout. Nothing
 * larger than the cap is ever accumulated, so a 100k-file status or a 5k-file
 * diff costs bounded memory instead of a full-repository buffer plus a copy.
 */
export async function executeCapped(
  command: string,
  args: string[],
  cwd: string,
  options: CappedOptions,
): Promise<CappedResult> {
  return new Promise<CappedResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CommandCancelled())
      return
    }
    const child = spawn(command, args, {
      cwd,
      env: commandEnvironment(options.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const decoder = new StringDecoder('utf8')
    const parts: string[] = []
    const stderr: string[] = []
    let retained = 0
    let truncated = false
    let settled = false
    let stopped: 'abort' | 'timeout' | 'limit' | null = null
    let escalation: NodeJS.Timeout | undefined

    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      options.signal?.removeEventListener('abort', onAbort)
      finish()
    }
    const stop = (reason: 'abort' | 'timeout' | 'limit') => {
      if (stopped) return
      stopped = reason
      child.kill('SIGTERM')
      // The serial read queue must not advance until the child has exited.
      escalation = setTimeout(() => child.kill('SIGKILL'), 1000)
      escalation.unref()
    }
    const onAbort = () => {
      if (stopped) stopped = 'abort'
      else stop('abort')
    }
    const timer = setTimeout(
      () => stop('timeout'),
      options.timeoutMs ?? (command === 'gh' ? 20_000 : 120_000),
    )
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    child.stdout.on('data', (chunk: Buffer) => {
      const room = options.maxBytes - retained
      if (room > 0) {
        const take = Math.min(room, chunk.length)
        retained += take
        parts.push(decoder.write(chunk.subarray(0, take)))
        if (take < chunk.length) truncated = true
      } else {
        truncated = true
      }
      if (truncated) stop('limit')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64) stderr.push(chunk.toString('utf8'))
    })
    child.on('error', (error) => settle(() => reject(error)))
    child.on('close', (code) => {
      if (stopped === 'abort') {
        settle(() => reject(new CommandCancelled()))
        return
      }
      if (stopped === 'timeout') {
        settle(() =>
          reject(
            Object.assign(new Error(`${command} timed out`), {
              code: 'ETIMEDOUT',
              stderr: stderr.join(''),
            }),
          ),
        )
        return
      }
      const tail = decoder.end()
      if (tail) parts.push(tail)
      let text = parts.join('')
      if (truncated) {
        if (options.boundary) {
          const cut = text.lastIndexOf(options.boundary)
          if (cut >= 0) text = text.slice(0, cut + options.boundary.length)
        } else if (text.endsWith('\uFFFD')) {
          // A byte cap can land inside a multi-byte character; drop the lone
          // replacement character rather than rendering a corrupt final glyph.
          text = text.slice(0, -1)
        }
      } else if (code !== 0) {
        settle(() =>
          reject(
            Object.assign(new Error(`${command} failed with exit code ${code}`), {
              code,
              stderr: stderr.join(''),
            }),
          ),
        )
        return
      }
      settle(() => resolve({ text, truncated }))
    })
  })
}

/**
 * Runs at most `limit` workers at a time. Per-branch Git work is bounded by
 * this rather than by the branch count, so a repository with thousands of
 * refs no longer forks thousands of processes at once.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  let failed = false
  let failure: unknown
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      try {
        await worker(items[cursor++])
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  })
  await Promise.all(runners)
  if (failed) throw failure
}

// Prompt suppression is the only general environment Git Stacks adds. Managed Git also
// receives its own relocated helper paths; user SSH, LFS, hooks and signing pass through.
export function commandEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GCM_INTERACTIVE: 'Never',
    ...env,
  }
}
export async function runGit(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const runtime = await resolveGitRuntime()
  return execute(
    runtime.executable,
    args,
    repoPath,
    gitCommandEnvironment(runtime, commandEnvironment(env)),
    signal,
  )
}

/**
 * Runs a command with text on stdin. `execFile` cannot write stdin, and a patch
 * must reach Git as a stream so a path with spaces or a NUL never has to be
 * spelled on the command line.
 */
export async function executeWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const child = spawn(command, args, {
    cwd,
    env: commandEnvironment(env),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const finish = (error: CommandError | null) => {
    clearTimeout(timer)
    if (error) {
      error.stdout = stdout
      error.stderr = stderr
      reject(error)
    } else {
      resolve(stdout)
    }
  }
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    const error: CommandError = new Error(`${command} timed out`)
    error.code = 'ETIMEDOUT'
    finish(error)
  }, 120_000)
  timer.unref?.()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > MAX_BUFFER) child.kill('SIGKILL')
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.on('error', (cause) => {
    const error: CommandError = new Error(String(cause))
    error.code = (cause as NodeJS.ErrnoException).code
    finish(error)
  })
  child.on('close', (code) => {
    if (code === 0) {
      finish(null)
      return
    }
    const error: CommandError = new Error(`${command} exited with code ${code ?? 'unknown'}`)
    error.code = code ?? 1
    finish(error)
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(input)
  return promise
}

export async function runGitWithInput(
  repoPath: string,
  args: string[],
  input: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const runtime = await resolveGitRuntime()
  return executeWithInput(
    runtime.executable,
    args,
    repoPath,
    input,
    gitCommandEnvironment(runtime, commandEnvironment(env)),
  )
}

export async function tryGit(
  repoPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(repoPath, args, undefined, signal)
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export function requireString(
  value: unknown,
  label: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be a non-empty string without NUL bytes`)
  }
  return value
}

export function requireRefInput(value: unknown, label: string): string {
  const ref = requireString(value, label, MAX_BRANCH_LENGTH)
  if (ref.startsWith('-') || ref.includes('@{') || /[\u0000-\u001f\u007f]/u.test(ref)) {
    throw new Error(`${label} is not a safe Git ref`)
  }
  return ref
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function getCurrentBranch(
  repoPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, signal),
    )
    return value || null
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export function parseRefRecords(output: string): RefRecord[] {
  const values = output.split('\0')
  const records: RefRecord[] = []
  for (let index = 0; index + 6 < values.length; index += 7) {
    const fields = values.slice(index, index + 7)
    const refname = fields[0].replace(/^[\r\n]+/u, '')
    const [, objectName, upstream, track, subject, updatedAt, symref] = fields
    if (!refname) {
      continue
    }
    records.push({ refname, objectName, upstream, track, subject, updatedAt, symref })
  }
  return records
}

export async function getRefs(repoPath: string, signal?: AbortSignal): Promise<RefRecord[]> {
  const output = await runGit(
    repoPath,
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)%00',
      'refs/heads',
      'refs/remotes',
    ],
    undefined,
    signal,
  )
  return parseRefRecords(output)
}

export function parseTrack(value: string): { ahead: number; behind: number } {
  const track = value.replace(/^\[/u, '').replace(/\]$/u, '')
  const aheadMatch = /(?:^|,\s*)ahead\s+(\d+)/u.exec(track)
  const behindMatch = /(?:^|,\s*)behind\s+(\d+)/u.exec(track)
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  }
}

export function isConflicted(indexStatus: string, worktreeStatus: string): boolean {
  return (
    indexStatus === 'U' ||
    worktreeStatus === 'U' ||
    ['AA', 'DD', 'AU', 'UA', 'DU', 'UD', 'UU'].includes(`${indexStatus}${worktreeStatus}`)
  )
}

export function parseStatus(output: string, truncated = false): ChangedFile[] {
  if (!output) {
    return []
  }
  const tokens = output.split('\0')
  const files: ChangedFile[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      continue
    }
    if (token.length < 3) {
      throw new Error('Git returned malformed porcelain status output')
    }
    const indexStatus = token[0]
    const worktreeStatus = token[1]
    const filePath = token.slice(3)
    if (!filePath) {
      throw new Error('Git returned a status entry without a path')
    }
    const renamed =
      indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    let originalPath: string | undefined
    if (renamed) {
      originalPath = tokens[index + 1]
      index += 1
      if (!originalPath) {
        // `-z` renames have two NUL-terminated paths. The byte cap can end
        // after the new path, before the old one has arrived.
        if (truncated && index === tokens.length - 1) break
        throw new Error('Git returned a rename status without its original path')
      }
    }
    files.push({
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
      index: indexStatus,
      worktree: worktreeStatus,
      conflicted: isConflicted(indexStatus, worktreeStatus),
    })
  }
  return files
}

export async function getStatus(repoPath: string, signal?: AbortSignal): Promise<ChangedFile[]> {
  const output = await runGit(
    repoPath,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      GIT_OPTIONAL_LOCKS: '0',
    },
    signal,
  )
  return parseStatus(output)
}

/**
 * The capped counterpart of `runGit`. Bounded reads resolve the same managed
 * runtime and relocated helper environment, so a large repository never forks
 * the system Git directly and a bundled build still reports its own version.
 */
export async function runGitCapped(
  repoPath: string,
  args: string[],
  options: CappedOptions,
): Promise<CappedResult> {
  const runtime = await resolveGitRuntime()
  return executeCapped(runtime.executable, args, repoPath, {
    ...options,
    env: gitCommandEnvironment(runtime, commandEnvironment(options.env)),
  })
}

/**
 * The capped counterpart of `tryGit`. A read that legitimately fails — an
 * unborn HEAD, an empty repository — answers `null` rather than rejecting, so
 * a caller can ask one whole-repository question without forking per path.
 */
export async function tryGitCapped(
  repoPath: string,
  args: string[],
  options: CappedOptions,
): Promise<CappedResult | null> {
  try {
    return await runGitCapped(repoPath, args, options)
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

/**
 * The working-tree listing used by snapshots. A repository with 100k changed
 * files is cut on a whole-record boundary at `MAX_STATUS_BYTES` and reports
 * `truncated` so the renderer states the limit instead of silently dropping
 * files. Actions that must see every path keep using `getStatus`.
 */
export async function listStatus(
  repoPath: string,
  signal?: AbortSignal,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const { text, truncated } = await runGitCapped(
    repoPath,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { maxBytes: MAX_STATUS_BYTES, boundary: '\0', signal },
  )
  return { files: parseStatus(text, truncated), truncated }
}

export async function getStashes(repoPath: string, signal?: AbortSignal): Promise<Stash[]> {
  const output = await runGit(
    repoPath,
    ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00'],
    undefined,
    signal,
  )
  const values = output.split('\0')
  const stashes: Stash[] = []
  for (let index = 0; index + 2 < values.length; index += 3) {
    const ref = stripTrailingNewline(values[index])
    const oid = stripTrailingNewline(values[index + 1])
    const message = stripTrailingNewline(values[index + 2])
    if (ref && oid) {
      stashes.push({ ref, oid, message })
    }
  }
  return stashes
}

export async function getOriginUrl(repoPath: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(repoPath, ['remote', 'get-url', 'origin'], undefined, signal),
    )
    return value || null
  } catch (error) {
    if (isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export async function getRemotePushUrl(repoPath: string, remote: string): Promise<string> {
  const output = await runGit(repoPath, ['remote', 'get-url', '--push', '--all', remote])
  const urls = output
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
  if (urls.length !== 1) {
    throw new Error(
      urls.length === 0
        ? `Remote "${remote}" has no push URL`
        : `Remote "${remote}" has multiple push URLs; configure exactly one`,
    )
  }
  return urls[0]
}

export async function getRemotes(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ['remote'])
  return output
    .split(/\r?\n/u)
    .map((remote) => remote.trim())
    .filter(Boolean)
}

export function parseRemote(urlValue: string | null): ParsedRemote | null {
  if (!urlValue) {
    return null
  }
  let value = urlValue.trim()
  let host = ''
  let remotePath = ''
  try {
    if (/^[^/@\s]+@[^:/\s]+:.+$/u.test(value)) {
      const separator = value.indexOf(':')
      host = value.slice(value.indexOf('@') + 1, separator)
      remotePath = value.slice(separator + 1)
    } else {
      const parsed = new URL(value)
      // `host` keeps an explicit port: it is the same host the user configured.
      host = parsed.host
      remotePath = parsed.pathname
    }
  } catch {
    return null
  }
  remotePath = remotePath.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  const segments = remotePath.split('/').filter(Boolean)
  if (segments.length < 2 || !host) {
    return null
  }
  const owner = segments[segments.length - 2]
  const name = segments[segments.length - 1]
  return { host: host.toLowerCase(), owner, name, fullName: `${owner}/${name}` }
}

export async function getConfigValue(
  repoPath: string,
  key: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(repoPath, ['config', '--get', key], undefined, signal),
    )
    return value || null
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export interface BranchConfig {
  parent: string | null
  parentTip: string | null
}

export function parseBranchConfig(output: string): Map<string, BranchConfig> {
  const configs = new Map<string, BranchConfig>()
  for (const token of output.split('\0')) {
    const match = /^branch\.(.+)\.(parent|parenttip)\n([\s\S]*)$/iu.exec(token)
    if (!match) continue
    const [, name, field, value] = match
    const entry = configs.get(name) ?? { parent: null, parentTip: null }
    if (field.toLowerCase() === 'parent') entry.parent = value || null
    else entry.parentTip = value || null
    configs.set(name, entry)
  }
  return configs
}

/**
 * One read for every branch's recorded parent and parent tip. The previous
 * per-branch `git config --get` cost two child processes per branch, which is
 * what made a repository with thousands of refs unusable.
 */
export async function getBranchConfigs(
  repoPath: string,
  signal?: AbortSignal,
): Promise<Map<string, BranchConfig>> {
  const output = await tryGit(
    repoPath,
    [
      'config',
      '--null',
      '--get-regexp',
      // Git reports config keys lower-cased, so the match must be lower-case too.
      '^branch\\..*\\.(parent|parenttip)$',
    ],
    signal,
  )
  return parseBranchConfig(output ?? '')
}

/** Commits named in one `log --no-walk` batch; a wider argument list only grows the command line. */
const DIRECT_PARENT_BATCH = 200

/**
 * The direct parents of many commits in batched reads. `log --no-walk` answers
 * each listed commit without walking its history, so a snapshot learns a whole
 * repository's tip topology in a handful of processes instead of one per tip.
 * A commit Git cannot resolve is simply absent from the result, so callers
 * that read a missing entry as "no evidence here" keep their own fallback.
 */
export async function readDirectParents(
  repoPath: string,
  oids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const parents = new Map<string, string[]>()
  for (let start = 0; start < oids.length; start += DIRECT_PARENT_BATCH) {
    const output = await tryGit(
      repoPath,
      [
        'log',
        '--no-walk=unsorted',
        '--format=%H:%P',
        ...oids.slice(start, start + DIRECT_PARENT_BATCH),
      ],
      signal,
    )
    for (const line of (output ?? '').split('\n')) {
      const separator = line.indexOf(':')
      if (separator < 0) continue
      parents.set(
        line.slice(0, separator),
        line
          .slice(separator + 1)
          .trim()
          .split(' ')
          .filter(Boolean),
      )
    }
  }
  return parents
}

export async function getBranchParent(repoPath: string, branch: string): Promise<string | null> {
  return getConfigValue(repoPath, `branch.${branch}.parent`)
}

export async function getDefaultBranch(
  repoPath: string,
  refs: RefRecord[],
  currentBranch: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const remoteHead = refs.find(
    (ref) =>
      ref.refname.startsWith('refs/remotes/origin/') &&
      ref.symref.startsWith('refs/remotes/origin/'),
  )
  if (remoteHead?.symref) {
    return remoteHead.symref.slice('refs/remotes/origin/'.length)
  }
  const configured = await getConfigValue(repoPath, 'init.defaultBranch', signal)
  if (configured) {
    return configured
  }
  const localNames = refs
    .filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
    .map((ref) => ref.refname.slice('refs/heads/'.length))
  if (localNames.includes('main')) {
    return 'main'
  }
  if (localNames.includes('master')) {
    return 'master'
  }
  if (currentBranch) {
    return currentBranch
  }
  return localNames[0] ?? 'main'
}

export async function gitPathExists(
  repoPath: string,
  name: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const output = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-path', name], undefined, signal),
  )
  const candidate = path.isAbsolute(output) ? output : path.resolve(repoPath, output)
  try {
    await fs.stat(candidate)
    if (signal?.aborted) throw new CommandCancelled()
    return true
  } catch (error) {
    if (isCancelled(error) || signal?.aborted) throw new CommandCancelled()
    return false
  }
}

export async function getOperationState(
  repoPath: string,
  signal?: AbortSignal,
): Promise<OperationState> {
  const names = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'sequencer',
    'BISECT_LOG',
  ]
  const reads = names.map((name) => gitPathExists(repoPath, name, signal))
  let existing: boolean[]
  try {
    existing = await Promise.all(reads)
  } catch (error) {
    await Promise.allSettled(reads)
    throw error
  }
  const rebase = existing[0] || existing[1]
  const operation = rebase
    ? 'rebase'
    : existing[2]
      ? 'merge'
      : existing[3]
        ? 'cherryPick'
        : existing[4]
          ? 'revert'
          : existing.some(Boolean)
            ? 'other'
            : null
  return { rebase, busy: existing.some(Boolean), operation }
}

export function statusPathCandidates(
  files: ChangedFile[],
  requested: string[],
  action: 'stage' | 'unstage',
): string[] {
  const byPath = new Map<string, ChangedFile>()
  for (const file of files) {
    byPath.set(file.path, file)
    if (file.originalPath) byPath.set(file.originalPath, file)
  }
  const paths = new Set<string>()
  for (const filePath of requested) {
    const file = byPath.get(filePath)
    if (!file) throw new Error(`Path is not currently changed: ${filePath}`)
    paths.add(file.path)
    if (action === 'unstage' && file.originalPath) paths.add(file.originalPath)
  }
  return [...paths]
}

export async function ensureNoBusyOperation(repoPath: string, operation: string): Promise<void> {
  const state = await getOperationState(repoPath)
  if (state.busy) {
    throw new Error(
      `Cannot ${operation} while another Git operation is in progress; finish or abort it first`,
    )
  }
}

export async function ensureClean(repoPath: string, operation: string): Promise<void> {
  const files = await getStatus(repoPath)
  if (files.length > 0) {
    throw new Error(`Cannot ${operation} with uncommitted changes; commit or stash them first`)
  }
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['show-ref', '--verify', '--quiet', ref])
    return true
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 128)) {
      return false
    }
    throw error
  }
}

export async function validateBranchName(repoPath: string, branch: string): Promise<void> {
  requireRefInput(branch, 'branch')
  try {
    await runGit(repoPath, ['check-ref-format', '--branch', branch])
  } catch (error) {
    throw new Error(`Invalid branch name "${branch}": ${commandDetail(error)}`)
  }
}

export async function ensureNotCheckedOutElsewhere(
  repoPath: string,
  branch: string,
): Promise<void> {
  const output = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  const worktrees: { path: string; branch: string | null }[] = []
  let currentWorktree: { path: string; branch: string | null } | null = null
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('worktree ')) {
      currentWorktree = { path: line.slice('worktree '.length), branch: null }
      worktrees.push(currentWorktree)
    } else if (currentWorktree && line.startsWith('branch refs/heads/')) {
      currentWorktree.branch = line.slice('branch refs/heads/'.length)
    }
  }

  let canonicalRepo: string
  try {
    canonicalRepo = await fs.realpath(repoPath)
  } catch {
    canonicalRepo = path.resolve(repoPath)
  }
  for (const worktree of worktrees) {
    let canonicalWorktree: string
    try {
      canonicalWorktree = await fs.realpath(worktree.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (worktree.branch === branch) {
          throw new Error(
            `Branch "${branch}" is checked out in another worktree: ${path.resolve(worktree.path)}`,
          )
        }
        continue
      }
      canonicalWorktree = path.resolve(worktree.path)
    }
    if (canonicalWorktree === canonicalRepo) continue
    if (worktree.branch === branch) {
      throw new Error(`Branch "${branch}" is checked out in another worktree: ${canonicalWorktree}`)
    }

    const exists = await fs
      .stat(worktree.path)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      })
    if (!exists) continue
    const gitDir = stripTrailingNewline(
      await runGit(worktree.path, ['rev-parse', '--absolute-git-dir']),
    )
    for (const backend of ['rebase-merge', 'rebase-apply']) {
      let headName: string
      try {
        headName = stripTrailingNewline(
          await fs.readFile(path.join(gitDir, backend, 'head-name'), 'utf8'),
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (headName === `refs/heads/${branch}`) {
        throw new Error(
          `Branch "${branch}" is checked out in another worktree: ${canonicalWorktree}`,
        )
      }
    }
  }
}

export async function branchUpstream(
  repoPath: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(
        repoPath,
        ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`],
        undefined,
        signal,
      ),
    )
    return value.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, './') || null
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export async function resolveParentRef(repoPath: string, parent: string): Promise<string> {
  await validateBranchName(repoPath, parent)
  if (await refExists(repoPath, `refs/heads/${parent}`)) {
    return `refs/heads/${parent}`
  }
  if (await refExists(repoPath, `refs/remotes/${parent}`)) {
    if (parent.endsWith('/HEAD')) {
      throw new Error('Cannot use a remote symbolic HEAD as a rebase parent')
    }
    return `refs/remotes/${parent}`
  }
  if (await refExists(repoPath, `refs/remotes/origin/${parent}`)) {
    return `refs/remotes/origin/${parent}`
  }
  throw new Error(`Parent branch "${parent}" does not exist locally or on a fetched remote`)
}
