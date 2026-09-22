import { execFile as execFileCallback } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type {
  ActionResult,
  Branch,
  ChangedFile,
  GitAction,
  PullRequest,
  RepositorySnapshot,
} from '../shared/types'

const execFile = promisify(execFileCallback)
const MAX_BUFFER = 32 * 1024 * 1024
const MAX_BRANCH_LENGTH = 1024
const MAX_PATH_LENGTH = 32 * 1024
const MAX_MESSAGE_LENGTH = 256 * 1024

interface CommandError extends Error {
  code?: string | number
  stdout?: string
  stderr?: string
}

interface RefRecord {
  refname: string
  objectName: string
  upstream: string
  track: string
  subject: string
  updatedAt: string
  symref: string
}

interface OperationState {
  rebase: boolean
  busy: boolean
}

interface GitHubResult {
  pullRequests: PullRequest[]
  available: boolean
  message: string
  sameRepository: (value: unknown) => boolean
}

interface ParsedRemote {
  host: string
  owner: string
  name: string
  fullName: string
}

function commandDetail(error: unknown): string {
  const commandError = error as CommandError
  const stderr = typeof commandError.stderr === 'string' ? commandError.stderr.trim() : ''
  const message = error instanceof Error ? error.message.trim() : String(error)
  return stderr || message
}

function commandCode(error: unknown): string | number | undefined {
  const value = (error as CommandError | undefined)?.code
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function isExitCode(error: unknown, code: number): boolean {
  return commandCode(error) === code
}

function stripTrailingNewline(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)+$/, '')
}

async function execute(
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

async function runGit(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return execute('git', args, repoPath, env)
}

async function tryGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(repoPath, args)
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 2) || isExitCode(error, 128)) {
      return null
    }
    throw error
  }
}

function requireString(value: unknown, label: string, maxLength = MAX_MESSAGE_LENGTH): string {
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

function requireRefInput(value: unknown, label: string): string {
  const ref = requireString(value, label, MAX_BRANCH_LENGTH)
  if (ref.startsWith('-') || ref.includes('@{') || /[\u0000-\u001f\u007f]/u.test(ref)) {
    throw new Error(`${label} is not a safe Git ref`)
  }
  return ref
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateAction(value: unknown): GitAction {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Invalid Git action payload')
  }

  switch (value.type) {
    case 'switch':
      return { type: 'switch', ref: requireRefInput(value.ref, 'branch ref') }
    case 'createBranch':
      return {
        type: 'createBranch',
        name: requireRefInput(value.name, 'branch name'),
        parent: requireRefInput(value.parent, 'parent branch'),
      }
    case 'stage':
    case 'unstage': {
      if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 1000) {
        throw new Error(`${value.type} requires one or more paths`)
      }
      const paths = value.paths.map((entry, index) => {
        const filePath = requireString(entry, `paths[${index}]`, MAX_PATH_LENGTH)
        if (
          filePath.startsWith('/') ||
          filePath.split('/').some((part) => part === '..' || part === '.')
        ) {
          throw new Error(`paths[${index}] is not a safe repository-relative path`)
        }
        return filePath
      })
      if (new Set(paths).size !== paths.length) {
        throw new Error('paths must not contain duplicates')
      }
      return { type: value.type, paths }
    }
    case 'commit':
      return { type: 'commit', message: requireString(value.message, 'commit message') }
    case 'fetch':
    case 'pull':
    case 'push':
    case 'stash':
    case 'rebaseContinue':
    case 'rebaseAbort':
      return { type: value.type }
    case 'stashPop':
      return { type: 'stashPop', ref: requireString(value.ref, 'stash ref', 256) }
    case 'rebase':
      return { type: 'rebase', parent: requireRefInput(value.parent, 'parent branch') }
    case 'createPr':
      if (typeof value.draft !== 'boolean') {
        throw new Error('draft must be a boolean')
      }
      return {
        type: 'createPr',
        title: requireString(value.title, 'pull request title'),
        body:
          typeof value.body === 'string'
            ? value.body
            : (() => {
                throw new Error('pull request body must be a string')
              })(),
        base: requireRefInput(value.base, 'pull request base'),
        draft: value.draft,
      }
    default:
      throw new Error(`Unsupported Git action: ${value.type}`)
  }
}

export async function resolveRepository(inputPath: string): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.includes('\0')) {
    throw new Error('Repository path must be a non-empty path')
  }

  let candidate: string
  try {
    candidate = await fs.realpath(inputPath)
  } catch {
    throw new Error(`Repository path does not exist: ${inputPath}`)
  }

  let isBare: string
  try {
    isBare = stripTrailingNewline(
      await runGit(candidate, ['rev-parse', '--is-bare-repository']),
    ).trim()
  } catch (error) {
    throw new Error(`Not a Git repository: ${commandDetail(error)}`)
  }
  if (isBare === 'true') {
    throw new Error('Bare Git repositories are not supported; choose a working tree')
  }

  let topLevel: string
  try {
    topLevel = stripTrailingNewline(await runGit(candidate, ['rev-parse', '--show-toplevel']))
  } catch (error) {
    throw new Error(`Not a Git repository: ${commandDetail(error)}`)
  }
  if (!topLevel) {
    throw new Error('Not a Git repository: Git returned no working tree root')
  }

  try {
    return await fs.realpath(topLevel)
  } catch {
    throw new Error(`Git working tree root does not exist: ${topLevel}`)
  }
}

async function getCurrentBranch(repoPath: string): Promise<string | null> {
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

function parseRefRecords(output: string): RefRecord[] {
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

async function getRefs(repoPath: string): Promise<RefRecord[]> {
  const output = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)%00',
    'refs/heads',
    'refs/remotes',
  ])
  return parseRefRecords(output)
}

function parseTrack(value: string): { ahead: number; behind: number } {
  const track = value.replace(/^\[/u, '').replace(/\]$/u, '')
  const aheadMatch = /(?:^|,\s*)ahead\s+(\d+)/u.exec(track)
  const behindMatch = /(?:^|,\s*)behind\s+(\d+)/u.exec(track)
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  }
}

function isConflicted(indexStatus: string, worktreeStatus: string): boolean {
  return (
    indexStatus === 'U' ||
    worktreeStatus === 'U' ||
    ['AA', 'DD', 'AU', 'UA', 'DU', 'UD', 'UU'].includes(`${indexStatus}${worktreeStatus}`)
  )
}

function parseStatus(output: string): ChangedFile[] {
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

async function getStatus(repoPath: string): Promise<ChangedFile[]> {
  const output = await runGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  return parseStatus(output)
}

async function getStashes(repoPath: string): Promise<{ ref: string; message: string }[]> {
  const output = await runGit(repoPath, ['stash', 'list', '--format=%gd%x00%gs%x00'])
  const values = output.split('\0')
  const stashes: { ref: string; message: string }[] = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    const ref = values[index]
    const message = values[index + 1]
    if (ref) {
      stashes.push({ ref, message })
    }
  }
  return stashes
}

async function getOriginUrl(repoPath: string): Promise<string | null> {
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

async function getRemotes(repoPath: string): Promise<string[]> {
  const output = await runGit(repoPath, ['remote'])
  return output
    .split(/\r?\n/u)
    .map((remote) => remote.trim())
    .filter(Boolean)
}

function parseRemote(urlValue: string | null): ParsedRemote | null {
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

function pullRequestChecks(value: unknown): PullRequest['checks'] {
  if (!Array.isArray(value) || value.length === 0) {
    return 'none'
  }
  let pending = false
  let failing = false
  for (const entry of value) {
    if (!isRecord(entry)) {
      pending = true
      continue
    }
    const raw = entry.conclusion ?? entry.state ?? entry.status
    const state = typeof raw === 'string' ? raw.toUpperCase() : ''
    if (
      !state ||
      ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(state)
    ) {
      pending = true
    } else if (
      [
        'FAILURE',
        'ERROR',
        'CANCELLED',
        'TIMED_OUT',
        'ACTION_REQUIRED',
        'STARTUP_FAILURE',
        'STALE',
      ].includes(state)
    ) {
      failing = true
    }
  }
  if (failing) {
    return 'failing'
  }
  if (pending) {
    return 'pending'
  }
  return 'passing'
}

function pullRequestHeadRepository(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (!isRecord(value)) {
    return null
  }
  const nameWithOwner = value.nameWithOwner
  if (typeof nameWithOwner === 'string') {
    return nameWithOwner
  }
  const name = value.name
  const owner = value.owner
  if (typeof name === 'string' && isRecord(owner) && typeof owner.login === 'string') {
    return `${owner.login}/${name}`
  }
  return null
}

function parsePullRequests(output: string): {
  pullRequests: PullRequest[]
  headRepositories: (string | null)[]
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error('GitHub CLI returned invalid pull request JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub CLI returned an unexpected pull request response')
  }
  const pullRequests: PullRequest[] = []
  const headRepositories: (string | null)[] = []
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue
    }
    const number = item.number
    const title = item.title
    const url = item.url
    const head = item.headRefName
    const base = item.baseRefName
    if (
      typeof number !== 'number' ||
      typeof title !== 'string' ||
      typeof url !== 'string' ||
      typeof head !== 'string' ||
      typeof base !== 'string'
    ) {
      continue
    }
    const rawState = typeof item.state === 'string' ? item.state.toUpperCase() : 'OPEN'
    const state: PullRequest['state'] =
      rawState === 'MERGED' || rawState === 'CLOSED' ? rawState : 'OPEN'
    pullRequests.push({
      number,
      title,
      url,
      head,
      base,
      state,
      draft: item.isDraft === true,
      checks: pullRequestChecks(item.statusCheckRollup),
    })
    headRepositories.push(pullRequestHeadRepository(item.headRepository))
  }
  return { pullRequests, headRepositories }
}

function githubErrorMessage(error: unknown): string {
  const detail = commandDetail(error)
  if (commandCode(error) === 'ENOENT') {
    return 'GitHub metadata unavailable: the gh CLI is not installed'
  }
  if (/auth|login|token|credential/iu.test(detail)) {
    return `GitHub metadata unavailable: authentication is required (${detail})`
  }
  if (/network|connect|timeout|resolve|fetch|socket|dns|api\.github/iu.test(detail)) {
    return `GitHub metadata unavailable: network request failed (${detail})`
  }
  return `GitHub metadata unavailable: ${detail}`
}

async function getGitHubData(repoPath: string, originUrl: string | null): Promise<GitHubResult> {
  const remote = parseRemote(originUrl)
  const unavailable = (message: string): GitHubResult => ({
    pullRequests: [],
    available: false,
    message,
    sameRepository: () => false,
  })
  if (!originUrl) {
    return unavailable('GitHub metadata unavailable: no origin remote is configured')
  }
  if (!remote || remote.host !== 'github.com') {
    return unavailable(
      'PR integration requires a github.com origin remote. Local Git actions remain available.',
    )
  }

  try {
    const query = `query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 100, after: $endCursor, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number title url headRefName baseRefName isDraft state
            headRepository { nameWithOwner }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`
    const output = await execute(
      'gh',
      [
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '--paginate',
        '--slurp',
        '-f',
        `owner=${remote.owner}`,
        '-f',
        `name=${remote.name}`,
        '-f',
        `query=${query}`,
      ],
      repoPath,
    )
    const pages: unknown = JSON.parse(output)
    if (!Array.isArray(pages)) throw new Error('Unexpected GitHub pagination response')
    const items: Record<string, unknown>[] = []
    for (const page of pages) {
      const nodes = page?.data?.repository?.pullRequests?.nodes
      if (!Array.isArray(nodes) || page.errors?.length)
        throw new Error('GitHub could not load pull requests')
      for (const item of nodes) {
        if (!isRecord(item)) continue
        const commits =
          isRecord(item.commits) && Array.isArray(item.commits.nodes) ? item.commits.nodes : []
        items.push({
          ...item,
          statusCheckRollup: commits.flatMap((node) =>
            node?.commit?.statusCheckRollup ? [node.commit.statusCheckRollup] : [],
          ),
        })
      }
    }
    const parsed = parsePullRequests(JSON.stringify(items))
    const originFullName = remote?.fullName.toLowerCase() ?? null
    const normalizedHeads = parsed.headRepositories.map((value) => value?.toLowerCase() ?? null)
    const sameRepository = (value: unknown): boolean => {
      if (!originFullName || typeof value !== 'number') {
        return false
      }
      return normalizedHeads[value]?.toLowerCase() === originFullName
    }
    return {
      pullRequests: parsed.pullRequests,
      available: true,
      message:
        parsed.pullRequests.length === 0
          ? 'GitHub metadata available; no open pull requests'
          : `GitHub metadata available; ${parsed.pullRequests.length} open pull request${parsed.pullRequests.length === 1 ? '' : 's'}`,
      sameRepository,
    }
  } catch (error) {
    return unavailable(githubErrorMessage(error))
  }
}

async function getConfigValue(repoPath: string, key: string): Promise<string | null> {
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

async function getBranchParent(repoPath: string, branch: string): Promise<string | null> {
  return getConfigValue(repoPath, `branch.${branch}.parent`)
}

async function getDefaultBranch(
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

async function gitPathExists(repoPath: string, name: string): Promise<boolean> {
  const output = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-path', name]))
  const candidate = path.isAbsolute(output) ? output : path.resolve(repoPath, output)
  try {
    await fs.stat(candidate)
    return true
  } catch {
    return false
  }
}

async function getOperationState(repoPath: string): Promise<OperationState> {
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
  return { rebase, busy: existing.some(Boolean) }
}

function statusPathCandidates(
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

async function ensureNoBusyOperation(repoPath: string, operation: string): Promise<void> {
  const state = await getOperationState(repoPath)
  if (state.busy) {
    throw new Error(
      `Cannot ${operation} while another Git operation is in progress; finish or abort it first`,
    )
  }
}

async function ensureClean(repoPath: string, operation: string): Promise<void> {
  const files = await getStatus(repoPath)
  if (files.length > 0) {
    throw new Error(`Cannot ${operation} with uncommitted changes; commit or stash them first`)
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
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

async function validateBranchName(repoPath: string, branch: string): Promise<void> {
  requireRefInput(branch, 'branch')
  try {
    await runGit(repoPath, ['check-ref-format', '--branch', branch])
  } catch (error) {
    throw new Error(`Invalid branch name "${branch}": ${commandDetail(error)}`)
  }
}

async function ensureNotCheckedOutElsewhere(repoPath: string, branch: string): Promise<void> {
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

async function branchUpstream(repoPath: string, branch: string): Promise<string | null> {
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

async function runStage(
  repoPath: string,
  action: 'stage' | 'unstage',
  requestedPaths: string[],
): Promise<ActionResult> {
  const files = await getStatus(repoPath)
  const paths = statusPathCandidates(files, requestedPaths, action)
  if (paths.length === 0) {
    throw new Error('No changed paths were selected')
  }
  if (action === 'stage') {
    await runGit(repoPath, ['--literal-pathspecs', 'add', '--', ...paths])
    return { message: `Staged ${paths.length} path${paths.length === 1 ? '' : 's'}` }
  }
  if (await tryGit(repoPath, ['rev-parse', '--verify', 'HEAD'])) {
    await runGit(repoPath, ['--literal-pathspecs', 'restore', '--staged', '--', ...paths])
  } else {
    await runGit(repoPath, ['--literal-pathspecs', 'rm', '--cached', '--force', '--', ...paths])
  }
  return { message: `Unstaged ${paths.length} path${paths.length === 1 ? '' : 's'}` }
}

async function runCommit(repoPath: string, message: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'commit')
  const files = await getStatus(repoPath)
  if (!files.some((file) => file.index !== ' ' && file.index !== '?')) {
    throw new Error('Nothing is staged to commit')
  }
  await runGit(repoPath, ['commit', '--message', message])
  return { message: 'Committed staged changes' }
}

async function runFetch(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'fetch')
  const remotes = await getRemotes(repoPath)
  if (remotes.length === 0) {
    throw new Error('Cannot fetch: repository has no configured remotes')
  }
  await runGit(repoPath, ['fetch', '--all', '--prune'])
  return { message: 'Fetched all remotes' }
}

async function runPull(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'pull')
  await ensureClean(repoPath, 'pull')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) {
    throw new Error('Cannot pull while HEAD is detached')
  }
  const upstream = await branchUpstream(repoPath, currentBranch)
  if (!upstream) {
    throw new Error(`Branch "${currentBranch}" has no upstream; configure one before pulling`)
  }
  await runGit(repoPath, ['pull', '--ff-only'])
  return { message: `Pulled ${upstream} with fast-forward-only protection` }
}

async function runPush(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'push')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) {
    throw new Error('Cannot push while HEAD is detached')
  }
  const remotes = await getRemotes(repoPath)
  if (remotes.length === 0) {
    throw new Error('Cannot push: repository has no configured remotes')
  }
  const upstream = await branchUpstream(repoPath, currentBranch)
  if (upstream) {
    const remote = await getConfigValue(repoPath, `branch.${currentBranch}.remote`)
    const destination = await getConfigValue(repoPath, `branch.${currentBranch}.merge`)
    if (!remote || !remotes.includes(remote) || !destination?.startsWith('refs/heads/')) {
      throw new Error('Push requires a remote branch upstream, not another local branch.')
    }
    await runGit(repoPath, [
      '-c',
      'push.followTags=false',
      'push',
      '--no-force',
      '--no-mirror',
      '--',
      remote,
      `refs/heads/${currentBranch}:${destination}`,
    ])
    return { message: `Pushed ${currentBranch} to ${upstream}` }
  }
  if (!remotes.includes('origin')) {
    throw new Error(
      `Branch "${currentBranch}" has no upstream and this repository has no origin remote`,
    )
  }
  await runGit(repoPath, [
    '-c',
    'push.followTags=false',
    'push',
    '--no-force',
    '--no-mirror',
    '--set-upstream',
    '--',
    'origin',
    `refs/heads/${currentBranch}:refs/heads/${currentBranch}`,
  ])
  return { message: `Pushed ${currentBranch} and set origin/${currentBranch} as its upstream` }
}

async function runStash(repoPath: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'stash')
  const files = await getStatus(repoPath)
  if (files.length === 0) {
    throw new Error('Nothing to stash')
  }
  await runGit(repoPath, ['stash', 'push', '--include-untracked'])
  return { message: 'Stashed changes, including untracked files' }
}

async function runStashPop(repoPath: string, ref: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'pop a stash')
  if (!/^stash@\{\d+\}$/u.test(ref)) {
    throw new Error('Invalid stash reference')
  }
  const stashes = await getStashes(repoPath)
  if (!stashes.some((stash) => stash.ref === ref)) {
    throw new Error(`Stash ${ref} does not exist`)
  }
  await runGit(repoPath, ['stash', 'pop', '--index', ref])
  return { message: `Applied ${ref}` }
}

async function runSwitch(repoPath: string, ref: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'switch branches')
  await ensureClean(repoPath, 'switch branches')
  if (
    (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) ||
    !(await refExists(repoPath, ref))
  ) {
    throw new Error('Select an existing local or remote branch reference.')
  }
  if (ref.startsWith('refs/heads/')) {
    const name = ref.slice('refs/heads/'.length)
    await validateBranchName(repoPath, name)
    await ensureNotCheckedOutElsewhere(repoPath, name)
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--',
      name,
    ])
    return { message: `Switched to ${name}` }
  }
  const remotes = (await getRemotes(repoPath)).sort((a, b) => b.length - a.length)
  const remote = remotes.find((name) => ref.startsWith(`refs/remotes/${name}/`))
  if (!remote) throw new Error('The selected branch has no configured remote.')
  const localName = ref.slice(`refs/remotes/${remote}/`.length)
  if (localName === 'HEAD') throw new Error('Select a branch instead of the remote symbolic HEAD.')
  await validateBranchName(repoPath, localName)
  await ensureNotCheckedOutElsewhere(repoPath, localName)
  if (await refExists(repoPath, `refs/heads/${localName}`)) {
    const upstream = await branchUpstream(repoPath, localName)
    if (upstream !== `${remote}/${localName}`) {
      throw new Error(
        `Local branch "${localName}" already exists but does not track this remote branch. Select the local branch explicitly.`,
      )
    }
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--',
      localName,
    ])
  } else {
    await runGit(repoPath, [
      'switch',
      '--no-overwrite-ignore',
      '--no-recurse-submodules',
      '--track',
      ref,
    ])
  }
  return { message: `Switched to ${localName} tracking ${remote}/${localName}` }
}

async function runCreateBranch(
  repoPath: string,
  name: string,
  parent: string,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'create a branch')
  await ensureClean(repoPath, 'create a branch')
  await validateBranchName(repoPath, name)
  await validateBranchName(repoPath, parent)
  if (await refExists(repoPath, `refs/heads/${name}`)) {
    throw new Error(`Local branch "${name}" already exists`)
  }
  if (!(await refExists(repoPath, `refs/heads/${parent}`))) {
    throw new Error(`Parent branch "${parent}" does not exist locally`)
  }
  await ensureNotCheckedOutElsewhere(repoPath, name)
  await runGit(repoPath, [
    'switch',
    '--no-overwrite-ignore',
    '--no-recurse-submodules',
    '--create',
    name,
    `refs/heads/${parent}`,
  ])
  try {
    await runGit(repoPath, ['config', '--local', `branch.${name}.parent`, parent])
  } catch (error) {
    throw new Error(
      `Created branch "${name}", but could not persist its parent configuration: ${commandDetail(error)}`,
    )
  }
  return { message: `Created and switched to ${name} from ${parent}` }
}

async function resolveParentRef(repoPath: string, parent: string): Promise<string> {
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

async function runRebase(repoPath: string, parent: string): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'start a rebase')
  await ensureClean(repoPath, 'start a rebase')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) {
    throw new Error('Cannot rebase while HEAD is detached')
  }
  const parentRef = await resolveParentRef(repoPath, parent)
  if (parentRef === currentBranch || parentRef === `refs/heads/${currentBranch}`) {
    throw new Error('Cannot rebase a branch onto itself')
  }
  await ensureNotCheckedOutElsewhere(repoPath, currentBranch)
  await runGit(repoPath, ['-c', 'rebase.updateRefs=false', 'rebase', parentRef])
  return { message: `Rebased ${currentBranch} onto ${parent}` }
}

async function runRebaseContinue(repoPath: string): Promise<ActionResult> {
  const state = await getOperationState(repoPath)
  if (!state.rebase) {
    throw new Error('No rebase is in progress')
  }
  await runGit(repoPath, ['rebase', '--continue'], {
    ...process.env,
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
  })
  return { message: 'Continued the rebase' }
}

async function runRebaseAbort(repoPath: string): Promise<ActionResult> {
  const state = await getOperationState(repoPath)
  if (!state.rebase) {
    throw new Error('No rebase is in progress')
  }
  await runGit(repoPath, ['rebase', '--abort'])
  return { message: 'Aborted the rebase' }
}

async function baseForGh(
  repoPath: string,
  requestedBase: string,
  resolvedBase: string,
): Promise<string> {
  if (await refExists(repoPath, `refs/heads/${requestedBase}`)) {
    return requestedBase
  }
  const remotes = await getRemotes(repoPath)
  const remote = remotes.find((name) => resolvedBase.startsWith(`refs/remotes/${name}/`))
  if (!remote) throw new Error('The PR base does not resolve to a branch.')
  return resolvedBase.slice(`refs/remotes/${remote}/`.length)
}

async function runCreatePr(
  repoPath: string,
  title: string,
  body: string,
  base: string,
  draft: boolean,
): Promise<ActionResult> {
  await ensureNoBusyOperation(repoPath, 'create a pull request')
  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) {
    throw new Error('Cannot create a pull request while HEAD is detached')
  }
  const upstream = await branchUpstream(repoPath, currentBranch)
  if (!upstream || upstream.startsWith('./') || upstream === '.') {
    throw new Error(
      `Branch "${currentBranch}" must be pushed to a remote before creating a pull request`,
    )
  }
  const separator = upstream.indexOf('/')
  if (separator <= 0 || separator === upstream.length - 1) {
    throw new Error(
      `Branch "${currentBranch}" has an invalid upstream; push it to a remote before creating a pull request`,
    )
  }
  const remote = upstream.slice(0, separator)
  const remoteBranch = upstream.slice(separator + 1)
  try {
    const remoteHead = await runGit(repoPath, [
      'ls-remote',
      '--heads',
      remote,
      `refs/heads/${remoteBranch}`,
    ])
    if (!remoteHead.trim()) {
      throw new Error('remote branch was not found')
    }
  } catch (error) {
    throw new Error(
      `Cannot create a pull request until ${upstream} is pushed: ${commandDetail(error)}`,
    )
  }
  const checkedBase = await resolveParentRef(repoPath, base)
  const ghBase = await baseForGh(repoPath, base, checkedBase)
  const origin = parseRemote(await getOriginUrl(repoPath))
  const headRemote = parseRemote(await runGit(repoPath, ['remote', 'get-url', remote]))
  if (!origin || origin.host !== 'github.com' || !headRemote || headRemote.host !== 'github.com') {
    throw new Error('PR creation requires github.com origin and upstream remotes.')
  }
  if (ghBase === remoteBranch && origin.fullName === headRemote.fullName) {
    throw new Error('The pull request base must differ from its head branch.')
  }
  const head =
    origin.fullName.toLowerCase() === headRemote.fullName.toLowerCase()
      ? remoteBranch
      : `${headRemote.owner}:${remoteBranch}`
  const args = [
    'pr',
    'create',
    '--repo',
    `github.com/${origin.fullName}`,
    '--title',
    title,
    '--body',
    body,
    '--base',
    ghBase,
    '--head',
    head,
  ]
  if (draft) {
    args.push('--draft')
  }
  let output: string
  try {
    output = await execute('gh', args, repoPath)
  } catch (error) {
    throw new Error(`Could not create pull request: ${commandDetail(error)}`)
  }
  const url = /(https?:\/\/[^\s]+)/u.exec(output)?.[1]
  return {
    message: `Created pull request from ${currentBranch} to ${ghBase}`,
    ...(url ? { url } : {}),
  }
}

function branchFromRef(ref: RefRecord, currentBranch: string | null, remote: boolean): Branch {
  const prefix = remote ? 'refs/remotes/' : 'refs/heads/'
  const name = ref.refname.slice(prefix.length)
  const track = parseTrack(ref.track)
  return {
    ref: ref.refname,
    name,
    current: !remote && name === currentBranch,
    remote,
    upstream: ref.upstream.replace(/^refs\/(?:remotes|heads)\//u, '') || null,
    upstreamRef: ref.upstream || null,
    ahead: track.ahead,
    behind: track.behind,
    subject: ref.subject,
    updatedAt: ref.updatedAt,
    parent: null,
    pr: null,
  }
}

export async function getSnapshot(repoPath: string): Promise<RepositorySnapshot> {
  const root = await resolveRepository(repoPath)
  const [refs, currentBranch, files, stashes, originUrl, operationState] = await Promise.all([
    getRefs(root),
    getCurrentBranch(root),
    getStatus(root),
    getStashes(root),
    getOriginUrl(root),
    getOperationState(root),
  ])

  const localRefs = refs.filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
  const remoteRefs = refs.filter((ref) => ref.refname.startsWith('refs/remotes/') && !ref.symref)
  const branches: Branch[] = [
    ...localRefs.map((ref) => branchFromRef(ref, currentBranch, false)),
    ...remoteRefs.map((ref) => branchFromRef(ref, currentBranch, true)),
  ]
  if (
    currentBranch &&
    !branches.some((branch) => !branch.remote && branch.name === currentBranch)
  ) {
    const upstream = await branchUpstream(root, currentBranch)
    branches.unshift({
      ref: `refs/heads/${currentBranch}`,
      name: currentBranch,
      current: true,
      remote: false,
      upstream,
      upstreamRef: null,
      ahead: 0,
      behind: 0,
      subject: '',
      updatedAt: '',
      parent: null,
      pr: null,
    })
  }

  const github = await getGitHubData(root, originUrl)
  const parentConfigs = await Promise.all(
    branches
      .filter((branch) => !branch.remote)
      .map(async (branch) => ({
        name: branch.name,
        parent: await getBranchParent(root, branch.name),
      })),
  )
  const configParents = new Map(parentConfigs.map((entry) => [entry.name, entry.parent]))
  const localPullRequests = new Map<string, PullRequest>()
  github.pullRequests.forEach((pullRequest, index) => {
    if (github.sameRepository(index) && !localPullRequests.has(pullRequest.head)) {
      localPullRequests.set(pullRequest.head, pullRequest)
    }
  })
  for (const branch of branches) {
    if (branch.remote) {
      continue
    }
    const pullRequest = localPullRequests.get(branch.name) ?? null
    branch.pr = pullRequest
    branch.parent = pullRequest?.base ?? configParents.get(branch.name) ?? null
  }

  const defaultBranch = await getDefaultBranch(root, refs, currentBranch)
  return {
    path: root,
    name: path.basename(root) || root,
    currentBranch,
    defaultBranch,
    remoteUrl: originUrl,
    branches,
    pullRequests: github.pullRequests,
    files,
    stashes,
    rebaseInProgress: operationState.rebase,
    github: { available: github.available, message: github.message },
  }
}

export async function runAction(repoPath: string, value: GitAction): Promise<ActionResult> {
  const root = await resolveRepository(repoPath)
  const action = validateAction(value)
  switch (action.type) {
    case 'stage':
    case 'unstage':
      return runStage(root, action.type, action.paths)
    case 'commit':
      return runCommit(root, action.message)
    case 'fetch':
      return runFetch(root)
    case 'pull':
      return runPull(root)
    case 'push':
      return runPush(root)
    case 'stash':
      return runStash(root)
    case 'stashPop':
      return runStashPop(root, action.ref)
    case 'switch':
      return runSwitch(root, action.ref)
    case 'createBranch':
      return runCreateBranch(root, action.name, action.parent)
    case 'rebase':
      return runRebase(root, action.parent)
    case 'rebaseContinue':
      return runRebaseContinue(root)
    case 'rebaseAbort':
      return runRebaseAbort(root)
    case 'createPr':
      return runCreatePr(root, action.title, action.body, action.base, action.draft)
  }
}
