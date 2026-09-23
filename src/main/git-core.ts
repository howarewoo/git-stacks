import { execFile as execFileCallback } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ChangedFile, GitOperation, Stash } from '../shared/types'

export const execFile = promisify(execFileCallback)
export const MAX_BUFFER = 32 * 1024 * 1024
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
): Promise<string> {
  try {
    const result = await execFile(command, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GH_PROMPT_DISABLED: '1',
        GCM_INTERACTIVE: 'Never',
        ...env,
      },
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

export async function runGit(
  repoPath: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return execute('git', args, repoPath, env)
}

export async function tryGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(repoPath, args)
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

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
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

export async function getRefs(repoPath: string): Promise<RefRecord[]> {
  const output = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)%00',
    'refs/heads',
    'refs/remotes',
  ])
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

export function parseStatus(output: string): ChangedFile[] {
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

export async function getStatus(repoPath: string): Promise<ChangedFile[]> {
  const output = await runGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parseStatus(output)
}

export async function getStashes(repoPath: string): Promise<Stash[]> {
  const output = await runGit(repoPath, ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00'])
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

export async function getOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const value = stripTrailingNewline(await runGit(repoPath, ['remote', 'get-url', 'origin']))
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
      host = parsed.hostname
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

export async function getConfigValue(repoPath: string, key: string): Promise<string | null> {
  try {
    const value = stripTrailingNewline(await runGit(repoPath, ['config', '--get', key]))
    return value || null
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

export async function getBranchParent(repoPath: string, branch: string): Promise<string | null> {
  return getConfigValue(repoPath, `branch.${branch}.parent`)
}

export async function getDefaultBranch(
  repoPath: string,
  refs: RefRecord[],
  currentBranch: string | null,
): Promise<string> {
  const remoteHead = refs.find(
    (ref) =>
      ref.refname.startsWith('refs/remotes/origin/') &&
      ref.symref.startsWith('refs/remotes/origin/'),
  )
  if (remoteHead?.symref) {
    return remoteHead.symref.slice('refs/remotes/origin/'.length)
  }
  const configured = await getConfigValue(repoPath, 'init.defaultBranch')
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

export async function gitPathExists(repoPath: string, name: string): Promise<boolean> {
  const output = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-path', name]))
  const candidate = path.isAbsolute(output) ? output : path.resolve(repoPath, output)
  try {
    await fs.stat(candidate)
    return true
  } catch {
    return false
  }
}

export async function getOperationState(repoPath: string): Promise<OperationState> {
  const names = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'sequencer',
    'BISECT_LOG',
  ]
  const existing = await Promise.all(names.map((name) => gitPathExists(repoPath, name)))
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
  const lines = output.split(/\r?\n/u)
  let worktreePath: string | null = null
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      worktreePath = line.slice('worktree '.length)
      continue
    }
    if (!line.startsWith('branch refs/heads/')) {
      continue
    }
    const checkedOutBranch = line.slice('branch refs/heads/'.length)
    if (checkedOutBranch !== branch || !worktreePath) {
      continue
    }
    let canonicalWorktree: string
    try {
      canonicalWorktree = await fs.realpath(worktreePath)
    } catch {
      canonicalWorktree = path.resolve(worktreePath)
    }
    if (canonicalWorktree !== repoPath) {
      throw new Error(`Branch "${branch}" is checked out in another worktree: ${canonicalWorktree}`)
    }
  }
}

export async function branchUpstream(repoPath: string, branch: string): Promise<string | null> {
  try {
    const value = stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]),
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
