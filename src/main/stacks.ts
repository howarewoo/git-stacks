import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileHandle } from 'node:fs/promises'
import type {
  ActionResult,
  Branch,
  PullRequest,
  RepositorySnapshot,
  StackAction,
  StackKind,
  StackPreview,
  StackProgress,
  StackStep,
} from '../shared/types'
import {
  CommandCancelled,
  MAX_MESSAGE_LENGTH,
  branchUpstream,
  commandCode,
  commandDetail,
  ensureClean,
  ensureNoBusyOperation,
  ensureNotCheckedOutElsewhere,
  getBranchParent,
  getConfigValue,
  getCurrentBranch,
  getDefaultBranch,
  getOperationState,
  getOriginUrl,
  getRefs,
  getRemotePushUrl,
  getStatus,
  isRecord,
  parseRemote,
  refExists,
  requireRefInput,
  requireString,
  resolveParentRef,
  runGit,
  stripTrailingNewline,
  tryGit,
  validateBranchName,
} from './git-core'
import { canonicalRemoteName, getGitHubData, getPullRequest, pullRequestRepository } from './github'
import { githubTransport } from './github-transport'
import type { GitHubResult } from './github'

const PLAN_TTL_MS = 5 * 60_000
const JOURNAL_VERSION = 1
const STACK_MARKER = '<!-- git-stacks:stack-links:v1 -->'

interface BranchRecord {
  name: string
  oid: string
  parent: string | null
  parentTip: string | null
  invalidParentTip: boolean
  parentSource: 'recorded' | 'pullRequest' | 'inferred' | null
  pr: PullRequest | null
  mergedHeadPr: string | null
  mergedHeadOid: string | null
  mergedCommitOid: string | null
}

interface PlanEntry {
  branch: string
  parent: string
  parentRef: string
  parentOid: string
  oldParent: string | null
  oldTip: string
  boundary: string
  oldParentTip: string | null
  parentTipSource: 'recorded' | 'merge-base' | 'parent-tip'
  needsRestack: boolean
  pr: PullRequest | null
  remoteOid: string | null
  upstream: string | null
  retargetedFrom: string | null
  note: string
}

interface StackPlan {
  token: string
  repoPath: string
  expiresAt: number
  kind: StackKind
  branch: string
  defaultBranch: string
  originUrl: string | null
  pushUrl: string | null
  originFullName: string | null
  originalBranch: string | null
  originalHead: string | null
  entries: PlanEntry[]
  capturedParents: Record<string, string | null>
  capturedParentTips: Record<string, string | null>
  capturedParentOids: Record<string, string | null>
  capturedTips: Record<string, string>
  capturedRemoteOids: Record<string, string | null>
  capturedPrs: Record<string, PullRequest | null>
  capturedMergedHeads: Record<
    string,
    { pr: string | null; oid: string | null; commit: string | null }
  >
  warnings: string[]
  blockers: string[]
  mergeMethods: ('merge' | 'squash' | 'rebase')[]
}

interface JournalEntry {
  branch: string
  oldTip: string
  newTip: string | null
  oldParent: string | null
  oldParentTip: string | null
  newParent: string
  newParentRef: string
  newParentOid: string
  newParentTip: string | null
  boundary: string
  backupRef: string
  headReflogCount: number | null
  status: 'pending' | 'rebasing' | 'metadata' | 'completed' | 'restored'
}

interface StackJournal {
  version: 1
  id: string
  repoPath: string
  originalBranch: string | null
  originalHead: string | null
  currentBranch: string | null
  entries: JournalEntry[]
  status: 'running' | 'conflict' | 'uncertain' | 'aborting'
  message: string
}

const plans = new Map<string, StackPlan>()

function stackActionError(message: string): never {
  throw new Error(message)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validateTitleMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) stackActionError('titles must be an object')
  const result: Record<string, string> = {}
  for (const [key, title] of Object.entries(value)) {
    requireRefInput(key, 'title branch')
    result[key] = requireString(title, `title for ${key}`)
  }
  return result
}

export function validateStackAction(value: unknown): StackAction {
  if (!isRecord(value) || typeof value.type !== 'string') {
    stackActionError('Invalid stack action')
  }
  switch (value.type) {
    case 'setParent':
      if (!hasOnlyKeys(value, ['type', 'branch', 'parent']))
        stackActionError('Invalid setParent action')
      return {
        type: 'setParent',
        branch: requireRefInput(value.branch, 'branch'),
        parent: requireRefInput(value.parent, 'parent'),
      }
    case 'executeStack':
      if (
        !hasOnlyKeys(value, ['type', 'token', 'allowForce', 'draft', 'titles', 'mergeMethod']) ||
        typeof value.allowForce !== 'boolean' ||
        typeof value.draft !== 'boolean'
      ) {
        stackActionError('Invalid executeStack action')
      }
      if (
        value.mergeMethod !== 'merge' &&
        value.mergeMethod !== 'squash' &&
        value.mergeMethod !== 'rebase'
      ) {
        stackActionError('Invalid merge method')
      }
      return {
        type: 'executeStack',
        token: requireString(value.token, 'stack preview token', 512),
        allowForce: value.allowForce,
        draft: value.draft,
        titles: validateTitleMap(value.titles),
        mergeMethod: value.mergeMethod,
      }
    case 'stackContinue':
    case 'stackAbort':
      if (!hasOnlyKeys(value, ['type'])) stackActionError(`Invalid ${value.type} action`)
      return { type: value.type }
    case 'updatePr':
      if (!hasOnlyKeys(value, ['type', 'number', 'title', 'body', 'draft'])) {
        stackActionError('Invalid updatePr action')
      }
      if (
        typeof value.number !== 'number' ||
        !Number.isInteger(value.number) ||
        value.number <= 0
      ) {
        stackActionError('Pull request number must be a positive integer')
      }
      if (typeof value.draft !== 'boolean') stackActionError('draft must be a boolean')
      if (
        typeof value.body !== 'string' ||
        value.body.length > MAX_MESSAGE_LENGTH ||
        value.body.includes('\0')
      ) {
        stackActionError('pull request body must be a string without NUL bytes')
      }
      return {
        type: 'updatePr',
        number: value.number,
        title: requireString(value.title, 'pull request title'),
        body: value.body,
        draft: value.draft,
      }
    case 'closePr':
    case 'reopenPr':
      if (!hasOnlyKeys(value, ['type', 'number'])) stackActionError(`Invalid ${value.type} action`)
      if (
        typeof value.number !== 'number' ||
        !Number.isInteger(value.number) ||
        value.number <= 0
      ) {
        stackActionError('Pull request number must be a positive integer')
      }
      return { type: value.type, number: value.number }
    default:
      stackActionError(`Unsupported stack action: ${String(value.type)}`)
  }
}

export function isStackAction(value: unknown): value is StackAction {
  try {
    validateStackAction(value)
    return true
  } catch {
    return false
  }
}

async function repositoryPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  const workTree = await tryGit(repoPath, ['rev-parse', '--show-toplevel'], signal)
  if (workTree) return path.resolve(stripTrailingNewline(workTree))
  // A bare repository has no worktree, so the journal lives in the Git directory.
  return path.resolve(
    stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--absolute-git-dir'], undefined, signal),
    ),
  )
}

async function gitDirectory(repoPath: string, signal?: AbortSignal): Promise<string> {
  const output = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-dir'], undefined, signal),
  )
  return path.resolve(repoPath, output)
}

async function journalPath(repoPath: string, signal?: AbortSignal): Promise<string> {
  return path.join(await gitDirectory(repoPath, signal), 'git-stacks-stack.json')
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
}

async function readJournal(repoPath: string, signal?: AbortSignal): Promise<StackJournal | null> {
  let value: string
  try {
    const target = await journalPath(repoPath, signal)
    if ((await fs.stat(target)).size > 8 * 1024 * 1024)
      throw new Error('Stack journal is too large')
    value = await fs.readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The Git Stacks operation journal is corrupt; refusing to rewrite branches')
  }
  const invalid = () =>
    new Error('The Git Stacks operation journal is invalid; refusing to rewrite branches')
  if (
    !isRecord(parsed) ||
    parsed.version !== JOURNAL_VERSION ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(parsed.id) ||
    parsed.repoPath !== repoPath ||
    !isOid(parsed.originalHead) ||
    (parsed.originalBranch !== null && typeof parsed.originalBranch !== 'string') ||
    (parsed.currentBranch !== null && typeof parsed.currentBranch !== 'string') ||
    typeof parsed.message !== 'string' ||
    !['running', 'conflict', 'uncertain', 'aborting'].includes(String(parsed.status)) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0 ||
    parsed.entries.length > 2048
  )
    throw invalid()
  const names = new Set<string>()
  const branches = new Set<string>()
  for (const entry of parsed.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.branch !== 'string' ||
      branches.has(entry.branch) ||
      typeof entry.newParent !== 'string' ||
      !isOid(entry.oldTip) ||
      !isOid(entry.boundary) ||
      !isOid(entry.newParentOid) ||
      (entry.newTip !== null && !isOid(entry.newTip)) ||
      (entry.newParentTip !== null && !isOid(entry.newParentTip)) ||
      (entry.oldParentTip !== null && !isOid(entry.oldParentTip)) ||
      (entry.oldParent !== null && typeof entry.oldParent !== 'string') ||
      !['pending', 'rebasing', 'metadata', 'completed', 'restored'].includes(
        String(entry.status),
      ) ||
      ![`refs/heads/${entry.newParent}`, `refs/remotes/origin/${entry.newParent}`].includes(
        String(entry.newParentRef),
      ) ||
      entry.backupRef !== backupRefFor(parsed.id, entry.branch) ||
      (entry.headReflogCount !== null &&
        entry.headReflogCount !== undefined &&
        (typeof entry.headReflogCount !== 'number' ||
          !Number.isSafeInteger(entry.headReflogCount) ||
          entry.headReflogCount < 0)) ||
      (['metadata', 'completed'].includes(String(entry.status)) &&
        (!isOid(entry.newTip) || !isOid(entry.newParentTip)))
    )
      throw invalid()
    entry.headReflogCount = typeof entry.headReflogCount === 'number' ? entry.headReflogCount : null
    branches.add(entry.branch)
    names.add(entry.branch)
    names.add(entry.newParent)
    if (entry.oldParent !== null) names.add(entry.oldParent)
  }
  if (parsed.originalBranch !== null) names.add(parsed.originalBranch)
  if (parsed.currentBranch !== null) names.add(parsed.currentBranch)
  for (const name of names) await validateBranchName(repoPath, name)
  return parsed as unknown as StackJournal
}

async function writeJournal(repoPath: string, journal: StackJournal): Promise<void> {
  const target = await journalPath(repoPath)
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
  await fs.writeFile(temporary, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, target)
}

async function removeJournal(repoPath: string): Promise<void> {
  try {
    await fs.unlink(await journalPath(repoPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function resolveCommit(
  repoPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const output = await tryGit(
    repoPath,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    signal,
  )
  return output ? stripTrailingNewline(output) : null
}

async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runGit(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant], undefined, signal)
    return true
  } catch (error) {
    if (commandCode(error) === 1) return false
    throw error
  }
}

async function commitCount(repoPath: string, boundary: string, tip: string): Promise<number> {
  const output = await runGit(repoPath, ['rev-list', '--count', `${boundary}..${tip}`, '--'])
  const count = Number(stripTrailingNewline(output))
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid commit count')
  return count
}
async function mergeCommitCount(repoPath: string, boundary: string, tip: string): Promise<number> {
  const output = await runGit(repoPath, [
    'rev-list',
    '--merges',
    '--count',
    `${boundary}..${tip}`,
    '--',
  ])
  const count = Number(stripTrailingNewline(output))
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid merge commit count')
  return count
}
async function commitParents(repoPath: string, oid: string): Promise<string[]> {
  const output = await runGit(repoPath, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    '--end-of-options',
    oid,
  ])
  const tokens = stripTrailingNewline(output).trim().split(/\s+/u)
  return tokens.slice(1).filter(Boolean)
}

interface MergedPrRecord {
  branch: string
  pr: number
  headOid: string
  mergeOid: string | null
  mergedAt: number
}

async function mergedPrJournalPath(repoPath: string): Promise<string> {
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  return path.resolve(repoPath, commonDir, 'git-stacks-merged-heads.json')
}

async function readMergedPrJournal(repoPath: string): Promise<Map<string, MergedPrRecord>> {
  const journalPath = await mergedPrJournalPath(repoPath)
  const map = new Map<string, MergedPrRecord>()
  try {
    const raw = await fs.readFile(journalPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (
          isRecord(value) &&
          typeof value.branch === 'string' &&
          typeof value.pr === 'number' &&
          typeof value.headOid === 'string'
        ) {
          map.set(key, {
            branch: value.branch,
            pr: value.pr,
            headOid: value.headOid,
            mergeOid: typeof value.mergeOid === 'string' ? value.mergeOid : null,
            mergedAt: typeof value.mergedAt === 'number' ? value.mergedAt : Date.now(),
          })
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Ignore unreadable or missing journal
    }
  }
  return map
}

async function writeMergedPrRecord(repoPath: string, record: MergedPrRecord): Promise<void> {
  const journalPath = await mergedPrJournalPath(repoPath)
  await fs.mkdir(path.dirname(journalPath), { recursive: true })
  const map = await readMergedPrJournal(repoPath)
  map.set(String(record.pr), record)
  map.set(record.branch, record)
  const obj: Record<string, MergedPrRecord> = {}
  for (const [k, v] of map.entries()) {
    obj[k] = v
  }
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(obj, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporaryPath, journalPath)
}

async function isProvenMergeHead(
  repoPath: string,
  prNumber: number,
  candidateHeadOid: string,
  mergeOid: string,
  journal: Map<string, MergedPrRecord>,
): Promise<boolean> {
  const journalRecord = journal.get(String(prNumber))
  if (journalRecord && journalRecord.pr === prNumber) {
    if (journalRecord.headOid !== candidateHeadOid) {
      return false
    }
    return !journalRecord.mergeOid || !mergeOid || journalRecord.mergeOid === mergeOid
  }
  if (mergeOid) {
    try {
      const parents = await commitParents(repoPath, mergeOid)
      if (parents.length >= 2) {
        const prParent = parents[1]
        if (candidateHeadOid === prParent) {
          return true
        }
      }
    } catch {
      // Ignore
    }
  }
  return false
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

function isPidRunning(pid: number): boolean {
  if (!isValidPid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function localFilesRefStoragePath(value: string): string {
  const uri = new URL(value)
  if (
    uri.protocol !== 'files:' ||
    uri.host ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    !uri.pathname.startsWith('/')
  ) {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  let decodedPath: string
  try {
    decodedPath = fileURLToPath(uri.href.replace(/^files:/u, 'file:'))
  } catch {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  if (decodedPath.includes('\0')) {
    throw new Error('The configured files ref-storage URI cannot be locked safely')
  }
  return decodedPath
}

function gitPathOnDisk(repoPath: string, value: string, refRoot: string | null): string {
  if (value.startsWith('files:')) return localFilesRefStoragePath(value)
  if (value.startsWith('file:')) return fileURLToPath(new URL(value))
  return path.resolve(refRoot ?? repoPath, value)
}

function isValidTransactionId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[0-9a-fA-F-]{8,64}$/.test(id) &&
    !id.includes('.') &&
    !id.includes('/') &&
    !id.includes('\\')
  )
}

function safeJournalPath(locksDir: string, transactionId: unknown): string | null {
  if (!isValidTransactionId(transactionId)) return null
  const normalizedLocksDir = path.resolve(locksDir)
  const resolved = path.resolve(normalizedLocksDir, `${transactionId}.json`)
  if (path.dirname(resolved) !== normalizedLocksDir) return null
  return resolved
}

async function sameExistingPath(left: string, right: string): Promise<boolean> {
  try {
    const [leftRealPath, rightRealPath] = await Promise.all([fs.realpath(left), fs.realpath(right)])
    return leftRealPath === rightRealPath
  } catch {
    return false
  }
}

async function isSafeBranchLockPath(
  repoPath: string,
  candidatePath: unknown,
  branch: unknown,
): Promise<boolean> {
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) return false
  if (!candidatePath.endsWith('.lock')) return false
  if (typeof branch !== 'string' || !branch.trim()) return false

  try {
    await runGit(repoPath, ['check-ref-format', '--branch', branch])
    const refPathValue = stripTrailingNewline(
      await runGit(repoPath, ['rev-parse', '--git-path', `refs/heads/${branch}`]),
    )
    if (!refPathValue) return false

    let refRoot: string | null = null
    const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
    if (refStorage && refStorage.toLowerCase() !== 'files') {
      try {
        refRoot = localFilesRefStoragePath(refStorage)
      } catch {
        return false
      }
    }
    const expectedLockPath = `${gitPathOnDisk(repoPath, refPathValue, refRoot)}.lock`
    return path.resolve(candidatePath) === path.resolve(expectedLockPath)
  } catch {
    return false
  }
}

type UnlinkIdentityResult = 'unlinked' | 'replaced' | 'failed'

async function unlinkIfSameIdentity(
  lockPath: string,
  expectedStat: { dev: number; ino: number },
): Promise<UnlinkIdentityResult> {
  let currentHandle: FileHandle | null = null
  try {
    try {
      currentHandle = await fs.open(lockPath, 'r')
      const [pathStat, openedStat] = await Promise.all([fs.lstat(lockPath), currentHandle.stat()])
      if (
        pathStat.dev !== expectedStat.dev ||
        pathStat.ino !== expectedStat.ino ||
        openedStat.dev !== expectedStat.dev ||
        openedStat.ino !== expectedStat.ino
      ) {
        return 'replaced'
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      return 'failed'
    }

    const claimPath = `${lockPath}.${randomUUID()}.stale-claim`
    try {
      await fs.rename(lockPath, claimPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      return 'failed'
    }

    try {
      const [claimStat, heldStat] = await Promise.all([fs.lstat(claimPath), currentHandle.stat()])
      if (
        claimStat.dev !== heldStat.dev ||
        claimStat.ino !== heldStat.ino ||
        heldStat.dev !== expectedStat.dev ||
        heldStat.ino !== expectedStat.ino
      ) {
        try {
          await fs.rename(claimPath, lockPath)
        } catch {
          // Preserve the claimed file if another process recreated the canonical path.
        }
        return 'replaced'
      }

      await fs.unlink(claimPath)
      return 'unlinked'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'unlinked'
      }
      try {
        await fs.rename(claimPath, lockPath)
      } catch {
        // Preserve the claimed file if it cannot be restored.
      }
      return 'failed'
    }
  } finally {
    await currentHandle?.close().catch(() => {})
  }
}

interface BranchLockInfo {
  pid: number
  branch: string
  lockPath: string
  createdAt: number
  transactionId: string
}

async function tryRecoverStaleBranchLock(
  repoPath: string,
  lockPath: string,
  branch: string,
): Promise<boolean> {
  let commonDir = ''
  try {
    commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  } catch {
    return false
  }
  const resolvedCommonDir = path.resolve(repoPath, commonDir)
  if (!(await isSafeBranchLockPath(repoPath, lockPath, branch))) {
    return false
  }

  const locksDir = path.resolve(resolvedCommonDir, 'git-stacks-branch-locks')
  let lockHandle: FileHandle | null = null
  let lockStat: { dev: number; ino: number } | null = null
  let content = ''
  try {
    lockHandle = await fs.open(lockPath, 'r')
    const stat = await lockHandle.stat()
    lockStat = { dev: stat.dev, ino: stat.ino }
    content = await lockHandle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  } finally {
    await lockHandle?.close().catch(() => {})
  }

  let parsed: Record<string, unknown> | null = null
  try {
    const rawParsed = JSON.parse(content)
    if (isRecord(rawParsed)) {
      parsed = rawParsed
    }
  } catch {
    parsed = null
  }
  if (
    parsed &&
    isValidPid(parsed.pid) &&
    isValidTransactionId(parsed.transactionId) &&
    parsed.branch === branch &&
    typeof parsed.lockPath === 'string' &&
    !isPidRunning(parsed.pid)
  ) {
    if (!(await sameExistingPath(parsed.lockPath, lockPath))) return false

    const journalPath = safeJournalPath(locksDir, parsed.transactionId)
    if (!journalPath) return false

    let journal: Record<string, unknown>
    try {
      const rawJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      if (!isRecord(rawJournal)) return false
      journal = rawJournal
    } catch {
      return false
    }
    if (
      journal.transactionId !== parsed.transactionId ||
      typeof journal.lockPath !== 'string' ||
      !(await sameExistingPath(journal.lockPath, lockPath)) ||
      journal.branch !== branch ||
      journal.pid !== parsed.pid ||
      !isValidPid(journal.pid) ||
      isPidRunning(journal.pid)
    ) {
      return false
    }

    const unlinkResult = await unlinkIfSameIdentity(lockPath, lockStat!)
    if (unlinkResult !== 'unlinked') {
      return false
    }
    await fs.unlink(journalPath).catch(() => {})
    return true
  }
  // A partial or malformed lock has no reliable transaction ownership. Keep it
  // for manual recovery instead of deleting a lock that may belong to a new
  // publisher which is still writing its metadata.
  return false
}

export async function recoverStaleBranchLocks(repoPath: string): Promise<void> {
  let commonDirRaw: string
  try {
    commonDirRaw = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  } catch {
    return
  }
  const commonDir = path.resolve(repoPath, commonDirRaw)
  const locksDir = path.resolve(commonDir, 'git-stacks-branch-locks')

  let entries: string[]
  try {
    entries = await fs.readdir(locksDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Ignore
    }
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const journalPath = path.join(locksDir, entry)
    try {
      const raw = await fs.readFile(journalPath, 'utf8')
      const journalJson = JSON.parse(raw)
      if (!isRecord(journalJson)) continue
      const pid = journalJson.pid
      if (!isValidPid(pid) || isPidRunning(pid)) {
        continue
      }

      if (!isValidTransactionId(journalJson.transactionId)) continue

      const safe = await isSafeBranchLockPath(repoPath, journalJson.lockPath, journalJson.branch)
      if (!safe) {
        // Keep rejected journals as evidence; their lock paths are not proven safe to touch.
        continue
      }

      const lockPath = journalJson.lockPath as string
      let lockHandle: FileHandle | null = null
      let lockStat: { dev: number; ino: number } | null = null
      let lockRaw: string | null = null
      try {
        lockHandle = await fs.open(lockPath, 'r')
        const stat = await lockHandle.stat()
        lockStat = { dev: stat.dev, ino: stat.ino }
        lockRaw = await lockHandle.readFile({ encoding: 'utf8' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Lock file does not exist, journal is stale
          await fs.unlink(journalPath).catch(() => {})
          continue
        }
        // Unreadable or permission error: keep journal evidence
        continue
      } finally {
        await lockHandle?.close().catch(() => {})
      }

      let lockParsed: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(lockRaw)
        if (isRecord(parsed)) {
          lockParsed = parsed
        }
      } catch {
        lockParsed = null
      }

      if (lockParsed) {
        const isSameDeadLock =
          isValidTransactionId(journalJson.transactionId) &&
          lockParsed.transactionId === journalJson.transactionId &&
          lockParsed.pid === journalJson.pid &&
          lockParsed.branch === journalJson.branch &&
          typeof lockParsed.lockPath === 'string' &&
          (await sameExistingPath(lockParsed.lockPath, lockPath))

        if (isSameDeadLock) {
          const result = await unlinkIfSameIdentity(lockPath, lockStat!)
          if (result === 'unlinked') {
            await fs.unlink(journalPath).catch(() => {})
          }
          // If 'failed', keep journal evidence
        } else if (
          isValidPid(lockParsed.pid) &&
          isPidRunning(lockParsed.pid) &&
          lockParsed.transactionId === journalJson.transactionId &&
          lockParsed.branch === journalJson.branch &&
          typeof lockParsed.lockPath === 'string' &&
          (await sameExistingPath(lockParsed.lockPath, lockPath))
        ) {
          // A live publisher owns the same transaction; remove only its stale journal.
          await fs.unlink(journalPath).catch(() => {})
        }
      }
    } catch {
      // Ignore unreadable entry
    }
  }
}

interface ParentTarget {
  ref: string
  oid: string
}

export async function parentTarget(
  repoPath: string,
  parent: string,
  defaultBranch: string,
  preferRemoteDefault: boolean,
  signal?: AbortSignal,
): Promise<ParentTarget | null> {
  if (parent === defaultBranch) {
    const localRef = `refs/heads/${defaultBranch}`
    const remoteRef = `refs/remotes/origin/${defaultBranch}`
    const localOid = await resolveCommit(repoPath, localRef, signal)
    const remoteOidValue = await resolveCommit(repoPath, remoteRef, signal)
    if (
      remoteOidValue &&
      (preferRemoteDefault ||
        !localOid ||
        (await isAncestor(repoPath, localOid, remoteOidValue, signal)))
    ) {
      return { ref: remoteRef, oid: remoteOidValue }
    }
    if (localOid) return { ref: localRef, oid: localOid }
    return null
  }
  const localRef = `refs/heads/${parent}`
  const localOid = await resolveCommit(repoPath, localRef, signal)
  if (localOid) return { ref: localRef, oid: localOid }
  const resolved = await resolveParentRef(repoPath, parent)
  const oid = await resolveCommit(repoPath, resolved, signal)
  return oid ? { ref: resolved, oid } : null
}

async function actualMergeBase(
  repoPath: string,
  left: string,
  right: string,
): Promise<string | null> {
  const output = await tryGit(repoPath, ['merge-base', left, right])
  return output ? stripTrailingNewline(output) : null
}

async function setConfig(repoPath: string, key: string, value: string): Promise<void> {
  await runGit(repoPath, ['config', '--local', key, value])
}

async function unsetConfig(repoPath: string, key: string): Promise<void> {
  try {
    await runGit(repoPath, ['config', '--local', '--unset', key])
  } catch (error) {
    if (commandCode(error) !== 5 && commandCode(error) !== 1) throw error
  }
}

async function localBranchNames(repoPath: string): Promise<string[]> {
  const refs = await getRefs(repoPath)
  return refs
    .filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
    .map((ref) => ref.refname.slice('refs/heads/'.length))
}

async function remoteOid(repoPath: string, remote: string, branch: string): Promise<string | null> {
  const output = await runGit(repoPath, ['ls-remote', '--heads', remote, `refs/heads/${branch}`])
  const first = output.trim().split(/\s+/u)[0]
  return /^[0-9a-f]{40,64}$/iu.test(first) ? first : null
}

function branchSnapshot(snapshot: RepositorySnapshot, name: string): Branch | null {
  return snapshot.branches.find((entry) => !entry.remote && entry.name === name) ?? null
}

function localPrForBranch(
  snapshot: RepositorySnapshot,
  name: string,
  originFullName: string | null,
): PullRequest | null {
  const candidate = branchSnapshot(snapshot, name)?.pr
  if (!candidate || candidate.head !== name) return null
  if (!originFullName || pullRequestRepository(candidate) !== originFullName) return null
  return candidate
}

async function branchRecords(
  repoPath: string,
  snapshot: RepositorySnapshot,
  defaultBranch: string,
  originFullName: string | null,
  canonicalPrs: Map<string, PullRequest>,
): Promise<Map<string, BranchRecord>> {
  const refs = await getRefs(repoPath)
  const local = refs.filter((ref) => ref.refname.startsWith('refs/heads/') && !ref.symref)
  const records = new Map<string, BranchRecord>()
  const mergedJournal = await readMergedPrJournal(repoPath)
  for (const ref of local) {
    const name = ref.refname.slice('refs/heads/'.length)
    const oid = ref.objectName
    const configuredParent = await getBranchParent(repoPath, name)
    const snapshotBranch = branchSnapshot(snapshot, name)
    const inferredParent = snapshotBranch?.parent ?? null
    const parent =
      configuredParent ?? (inferredParent && inferredParent !== name ? inferredParent : null)
    const configuredTip = await getConfigValue(repoPath, `branch.${name}.parentTip`)
    const configuredTipOid = configuredTip ? await resolveCommit(repoPath, configuredTip) : null
    const invalidParentTip = Boolean(
      configuredTip &&
      (!isOid(configuredTip) ||
        !configuredTipOid ||
        !(await isAncestor(repoPath, configuredTipOid, oid))),
    )
    const validTip = invalidParentTip ? null : configuredTip
    const source: BranchRecord['parentSource'] = configuredParent
      ? 'recorded'
      : snapshotBranch?.parentSource === 'recorded'
        ? 'inferred'
        : (snapshotBranch?.parentSource ?? null)
    const configuredMergedHeadPr = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedHeadPr`,
    )
    const configuredMergedHeadOid = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedHeadOid`,
    )
    const configuredMergedCommitOid = await getConfigValue(
      repoPath,
      `branch.${name}.gitStacksMergedCommitOid`,
    )
    const pr = canonicalPrs.get(name) ?? localPrForBranch(snapshot, name, originFullName)
    const journalEntry =
      mergedJournal.get(name) ?? (pr ? mergedJournal.get(String(pr.number)) : null)
    const mergedHeadPr = configuredMergedHeadPr ?? (journalEntry ? String(journalEntry.pr) : null)
    let mergedHeadOid = configuredMergedHeadOid ?? journalEntry?.headOid ?? null
    let mergedCommitOid =
      configuredMergedCommitOid ?? journalEntry?.mergeOid ?? pr?.mergeOid ?? null
    if (!mergedHeadOid && mergedCommitOid) {
      try {
        const parents = await commitParents(repoPath, mergedCommitOid)
        if (parents.length >= 2 && isOid(parents[1])) {
          mergedHeadOid = parents[1]
        }
      } catch {
        // Ignore
      }
    }
    records.set(name, {
      name,
      oid,
      parent: name === defaultBranch ? null : (parent ?? defaultBranch),
      parentTip: validTip,
      invalidParentTip,
      parentSource: source,
      pr,
      mergedHeadPr,
      mergedHeadOid,
      mergedCommitOid,
    })
  }
  return records
}

function mergedParent(
  records: Map<string, BranchRecord>,
  name: string,
  defaultBranch: string,
): boolean {
  const parent = records.get(name)
  return parent?.pr?.state === 'MERGED' && name !== defaultBranch
}

function effectiveParent(
  records: Map<string, BranchRecord>,
  name: string,
  defaultBranch: string,
  visiting = new Set<string>(),
): string | null {
  if (visiting.has(name)) return null
  visiting.add(name)
  const record = records.get(name)
  if (!record || !record.parent) return defaultBranch
  if (!mergedParent(records, record.parent, defaultBranch)) return record.parent
  return effectiveParent(records, record.parent, defaultBranch, visiting) ?? defaultBranch
}

function connectedBranchNames(
  records: Map<string, BranchRecord>,
  selected: string,
  defaultBranch: string,
): { names: string[]; blockers: string[] } {
  const blockers: string[] = []
  const names = new Set<string>()
  let current: string | null = selected
  const seen = new Set<string>()
  while (current && current !== defaultBranch) {
    if (seen.has(current)) {
      blockers.push(`Stack parent cycle detected at ${current}`)
      break
    }
    seen.add(current)
    const record = records.get(current)
    if (!record) {
      blockers.push(`Branch ${current} is not a local branch`)
      break
    }
    names.add(current)
    const parent = record.parent
    if (!parent) {
      blockers.push(`Branch ${current} has no parent`)
      break
    }
    if (parent !== defaultBranch && !records.has(parent)) {
      blockers.push(`Branch ${current} declares missing parent ${parent}`)
      break
    }
    current = parent
  }
  if (!records.has(selected)) blockers.push(`Branch ${selected} is not a local branch`)
  let changed = true
  while (changed) {
    changed = false
    for (const record of records.values()) {
      if (record.name === defaultBranch || names.has(record.name)) continue
      if (record.parent && names.has(record.parent)) {
        names.add(record.name)
        changed = true
      }
    }
  }
  return { names: [...names], blockers }
}

async function capturePlan(
  repoPath: string,
  snapshot: RepositorySnapshot,
  kind: StackKind,
  selectedBranch: string,
): Promise<{ plan: StackPlan; preview: StackPreview }> {
  const root = await repositoryPath(repoPath)
  const refs = await getRefs(root)
  const currentBranch = await getCurrentBranch(root)
  const currentHead = await resolveCommit(root, 'HEAD')
  const defaultBranch =
    snapshot.defaultBranch || (await getDefaultBranch(root, refs, currentBranch))
  const originUrl = await getOriginUrl(root)
  const originFullName = canonicalRemoteName(originUrl)
  const githubData = kind === 'restack' ? null : await getGitHubData(root, originUrl)
  const canonicalPrs = new Map<string, PullRequest>()
  if (githubData?.available) {
    for (const pr of githubData.pullRequests) {
      if (!canonicalPrs.has(pr.head)) {
        const canonical = await exactPrForBranch(pr.head, githubData)
        if (canonical) canonicalPrs.set(pr.head, canonical)
      }
    }
  }
  const records = await branchRecords(root, snapshot, defaultBranch, originFullName, canonicalPrs)
  const mergedJournal = await readMergedPrJournal(root)
  const connected = connectedBranchNames(records, selectedBranch, defaultBranch)
  const blockers = [...connected.blockers]
  let mergeMethods: ('merge' | 'squash' | 'rebase')[] = []
  let pushUrl: string | null = null
  if (kind === 'publish') {
    try {
      pushUrl = await getRemotePushUrl(root, 'origin')
      const pushRemote = parseRemote(pushUrl)
      if (!pushRemote || pushRemote.host !== 'github.com') {
        blockers.push('Publishing requires a github.com origin push URL')
      } else if (
        originFullName &&
        pushRemote.fullName.toLowerCase() !== originFullName.toLowerCase()
      ) {
        blockers.push('Origin fetch and push URLs target different GitHub repositories')
      }
    } catch (error) {
      blockers.push(`Could not read the origin push URL: ${commandDetail(error)}`)
    }
  }
  if (kind === 'merge' && originFullName) {
    const allowed = await repositoryMergeMethods(originFullName)
    if (!allowed) blockers.push('Repository merge-method policy is unavailable; merge is blocked')
    else mergeMethods = allowed
  }
  const warnings: string[] = []
  if (kind !== 'restack') {
    if (!githubData || !githubData.available)
      blockers.push(githubData?.message ?? 'GitHub metadata is unavailable')
    if (!originFullName) blockers.push('Publishing requires a github.com origin remote')
  }
  const operation = await getOperationState(root)
  if (operation.busy) blockers.push('A Git operation is already in progress')
  const files = await getStatus(root)
  if (files.length > 0) blockers.push('Commit or stash uncommitted changes before restacking')
  const selectedRecord = records.get(selectedBranch)
  if (!selectedRecord) blockers.push(`Branch ${selectedBranch} is not a local branch`)
  if (selectedBranch === defaultBranch)
    blockers.push('The default branch cannot be restacked or merged')

  const names = connected.names
  const parentMap: Record<string, string | null> = {}
  const parentTipMap: Record<string, string | null> = {}
  const parentOidMap: Record<string, string | null> = {}
  const tips: Record<string, string> = {}
  const remoteOids: Record<string, string | null> = {}
  const prs: Record<string, PullRequest | null> = {}
  const capturedMergedHeads: Record<
    string,
    { pr: string | null; oid: string | null; commit: string | null }
  > = {}
  for (const [name, record] of records) {
    capturedMergedHeads[name] = {
      pr: record.mergedHeadPr,
      oid: record.mergedHeadOid,
      commit: record.mergedCommitOid,
    }
  }
  const entries: PlanEntry[] = []
  const skippedMerged = new Set<string>()
  for (const name of names) {
    const record = records.get(name)
    if (!record) continue
    const declaredParent = record.parent
    const configuredParent = record.parentSource === 'recorded' ? declaredParent : null
    parentMap[name] = configuredParent
    parentTipMap[name] = record.parentTip
    tips[name] = record.oid
    if (record.invalidParentTip) {
      blockers.push(`Branch ${name} has an invalid recorded parent boundary`)
      continue
    }
    const upstream = await branchUpstream(root, name)
    remoteOids[name] = kind === 'publish' && pushUrl ? await remoteOid(root, pushUrl, name) : null
    if (record.pr?.state === 'MERGED') {
      skippedMerged.add(name)
      if (kind === 'merge' && name === selectedBranch) {
        blockers.push(`Branch ${name} already has a merged pull request`)
      }
      continue
    }
    const parent = effectiveParent(records, name, defaultBranch)
    if (!parent || parent === name) {
      blockers.push(`Branch ${name} has an invalid parent`)
      continue
    }
    const oldParent = declaredParent
    const oldConfiguredParent = configuredParent
    const oldParentRecord = oldParent ? records.get(oldParent) : null
    let boundary = record.parentTip
    let parentTipSource: PlanEntry['parentTipSource'] = 'parent-tip'
    if (!boundary) {
      const oldParentOid =
        oldParentRecord?.oid ??
        (oldParent === defaultBranch
          ? ((await resolveCommit(root, `refs/heads/${defaultBranch}`)) ??
            (await resolveCommit(root, `refs/remotes/origin/${defaultBranch}`)))
          : null)
      if (!oldParentOid) {
        blockers.push(`Cannot determine the original parent boundary for ${name}`)
        continue
      }
      boundary = await actualMergeBase(root, oldParentOid, record.oid)
      parentTipSource = 'merge-base'
      if (!boundary) {
        blockers.push(`No common ancestor exists for ${name} and ${oldParent ?? defaultBranch}`)
        continue
      }
    }
    const retargetedFrom = oldParent && oldParent !== parent ? oldParent : null
    const preferRemoteDefault =
      kind !== 'restack' || Boolean(retargetedFrom && parent === defaultBranch)
    const localDefaultOid =
      parent === defaultBranch ? await resolveCommit(root, `refs/heads/${defaultBranch}`) : null
    const remoteDefaultOid =
      parent === defaultBranch
        ? await resolveCommit(root, `refs/remotes/origin/${defaultBranch}`)
        : null
    if (
      localDefaultOid &&
      remoteDefaultOid &&
      localDefaultOid !== remoteDefaultOid &&
      !preferRemoteDefault &&
      !(await isAncestor(root, localDefaultOid, remoteDefaultOid)) &&
      !(await isAncestor(root, remoteDefaultOid, localDefaultOid))
    ) {
      blockers.push(
        `Default branch ${defaultBranch} has divergent local and origin tips; refresh or reconcile it before restacking ${name}`,
      )
      continue
    }
    const target = await parentTarget(root, parent, defaultBranch, preferRemoteDefault)
    if (!target) {
      blockers.push(`Parent ${parent} for ${name} does not resolve locally`)
      continue
    }
    parentOidMap[name] = target.oid
    const effectiveParentOid = target.oid
    if (retargetedFrom && oldParentRecord?.pr?.state === 'MERGED') {
      const mergedPr = oldParentRecord.pr
      const mergeOid = mergedPr.mergeOid
      if (
        !mergeOid ||
        !(await resolveCommit(root, mergeOid)) ||
        !(await isAncestor(root, mergeOid, effectiveParentOid))
      ) {
        blockers.push(
          `Merged parent ${retargetedFrom} has no validated merge commit reachable from ${parent}; fetch origin and inspect the rewritten base before retrying`,
        )
      }
      let recordedMergeHead =
        oldParentRecord.mergedHeadPr === String(mergedPr.number) &&
        oldParentRecord.mergedCommitOid === mergedPr.mergeOid &&
        oldParentRecord.mergedHeadOid &&
        isOid(oldParentRecord.mergedHeadOid)
          ? await resolveCommit(root, oldParentRecord.mergedHeadOid)
          : null
      if (!recordedMergeHead) {
        const journalRecord =
          mergedJournal.get(String(mergedPr.number)) ?? mergedJournal.get(retargetedFrom)
        if (
          journalRecord &&
          journalRecord.pr === mergedPr.number &&
          journalRecord.headOid &&
          isOid(journalRecord.headOid) &&
          (!journalRecord.mergeOid || journalRecord.mergeOid === mergedPr.mergeOid)
        ) {
          recordedMergeHead = await resolveCommit(root, journalRecord.headOid)
        }
      }
      if (!recordedMergeHead && mergedPr.mergeOid) {
        try {
          const parents = await commitParents(root, mergedPr.mergeOid)
          if (parents.length >= 2 && isOid(parents[1])) {
            recordedMergeHead = await resolveCommit(root, parents[1])
          }
        } catch {
          // Ignore
        }
      }
      const boundaryIncludedInParent = await isAncestor(root, boundary, effectiveParentOid)
      const unsafeBoundaryMessage = `Merged parent ${retargetedFrom} has no validated merge-time head for ${name} that can be used as a safe replay boundary; restacking is blocked to preserve commits`
      if (!recordedMergeHead) {
        blockers.push(unsafeBoundaryMessage)
      } else {
        const isChildTip = recordedMergeHead === record.oid
        const commitsToChild = await commitCount(root, recordedMergeHead, record.oid)
        const isProven =
          !isChildTip &&
          commitsToChild > 0 &&
          (await isProvenMergeHead(
            root,
            mergedPr.number,
            recordedMergeHead,
            mergeOid ?? '',
            mergedJournal,
          ))
        if (!isProven) {
          blockers.push(unsafeBoundaryMessage)
        } else if (await isAncestor(root, recordedMergeHead, record.oid)) {
          const mergeHeadIncludedInBoundary = await isAncestor(root, recordedMergeHead, boundary)
          if (!mergeHeadIncludedInBoundary || !boundaryIncludedInParent) {
            // Replay from the immutable head captured when the PR was merged.
            // The live source ref may have advanced since GitHub closed the PR.
            boundary = recordedMergeHead
          }
        } else if (!boundaryIncludedInParent) {
          blockers.push(unsafeBoundaryMessage)
        }
      }
    }
    const commits = await commitCount(root, boundary, record.oid)
    const mergeCount = await mergeCommitCount(root, boundary, record.oid)
    if (kind !== 'publish' && kind !== 'merge' && mergeCount > 0) {
      blockers.push(
        `Branch ${name} contains ${mergeCount} merge commit${mergeCount === 1 ? '' : 's'}; restack is blocked to preserve merge topology. Resolve it manually before retrying.`,
      )
    }
    const needsRestack =
      parent !== oldParent ||
      Boolean(record.parentTip && record.parentTip !== effectiveParentOid) ||
      !(await isAncestor(root, effectiveParentOid, record.oid))
    if (kind === 'publish' && needsRestack) {
      blockers.push(
        `Branch ${name} needs an explicit Restack before Publish; Publish never rewrites local refs`,
      )
    }
    if (
      kind === 'publish' &&
      parent === defaultBranch &&
      localDefaultOid &&
      remoteDefaultOid &&
      record.parentTip === localDefaultOid &&
      !(await isAncestor(root, localDefaultOid, remoteDefaultOid))
    ) {
      blockers.push(
        `Publish or reconcile ${defaultBranch} with origin/${defaultBranch} first; this stack contains unpublished default-branch commits`,
      )
    }
    if (retargetedFrom) {
      warnings.push(
        `Merged parent ${retargetedFrom} will be replaced by ${parent}; ${commits} child commits remain after the recorded boundary`,
      )
    }
    const noteParts = [
      kind === 'restack'
        ? `Rebase onto ${target.ref.replace(/^refs\/(?:heads|remotes)\//u, '')} @ ${target.oid.slice(0, 12)}`
        : kind === 'publish'
          ? `Push reviewed tip ${record.oid.slice(0, 12)}; PR base ${parent}`
          : `Merge only PR #${record.pr?.number ?? '?'} into ${parent}`,
    ]
    if (parentTipSource === 'merge-base') {
      noteParts.push(`using merge-base ${boundary.slice(0, 12)} (${commits} commits)`)
      warnings.push(
        `Branch ${name} has no recorded parent boundary. Review the merge-base and ${commits} preserved commits before restacking.`,
      )
    }
    entries.push({
      branch: name,
      parent,
      parentRef: target.ref,
      parentOid: target.oid,
      oldParent: oldConfiguredParent,
      oldTip: record.oid,
      boundary,
      oldParentTip: record.parentTip,
      parentTipSource,
      needsRestack,
      pr: record.pr,
      remoteOid: remoteOids[name],
      upstream,
      retargetedFrom,
      note: noteParts.join('; '),
    })
  }
  const depth = (name: string, seen = new Set<string>()): number => {
    if (seen.has(name)) return 0
    seen.add(name)
    const record = records.get(name)
    if (!record || !record.parent || record.parent === defaultBranch) return 0
    return 1 + depth(record.parent, seen)
  }
  entries.sort(
    (left, right) =>
      depth(left.branch) - depth(right.branch) || left.branch.localeCompare(right.branch),
  )
  if (kind === 'merge') {
    const mergeEntry = entries.find((entry) => entry.branch === selectedBranch)
    if (!mergeEntry) blockers.push(`No unmerged stack entry exists for ${selectedBranch}`)
    else {
      if (mergeEntry.parent !== defaultBranch)
        blockers.push('Only the bottom pull request based on the default branch may be merged')
      if (!mergeEntry.pr) blockers.push(`Branch ${selectedBranch} has no canonical pull request`)
      else {
        blockers.push(...mergeBlockers(mergeEntry.pr, defaultBranch, mergeEntry.oldTip))
      }
    }
  }
  if (kind === 'publish') {
    for (const entry of entries) {
      if (entry.upstream && entry.upstream !== `origin/${entry.branch}`) {
        blockers.push(
          `Branch ${entry.branch} has a non-origin or renamed upstream (${entry.upstream})`,
        )
      }
      if (entry.remoteOid && entry.remoteOid !== entry.oldTip) {
        warnings.push(
          `Publishing ${entry.branch} may require a force-with-lease from ${entry.remoteOid.slice(0, 12)}`,
        )
      }
    }
  }
  if (entries.length === 0 && kind !== 'merge') {
    blockers.push(
      'No unmerged branches remain in this stack; select a remaining branch to continue',
    )
  }
  const steps: StackStep[] = entries.map((entry) => ({
    branch: entry.branch,
    parent: entry.parent,
    oid: entry.oldTip,
    commits: 0,
    title: entry.pr?.title ?? entry.branch,
    pr: entry.pr,
    note: entry.note,
  }))
  for (const [index, entry] of entries.entries()) {
    steps[index] = {
      ...steps[index],
      commits: await commitCount(root, entry.boundary, entry.oldTip),
    }
  }
  if (skippedMerged.size > 0)
    warnings.push(
      `Merged stack branches are left untouched: ${[...skippedMerged].sort().join(', ')}`,
    )
  const token = randomUUID()
  const plan: StackPlan = {
    token,
    repoPath: root,
    expiresAt: Date.now() + PLAN_TTL_MS,
    kind,
    branch: selectedBranch,
    defaultBranch,
    originUrl,
    pushUrl,
    originFullName,
    originalBranch: currentBranch,
    originalHead: currentHead,
    entries,
    capturedParents: parentMap,
    capturedParentTips: parentTipMap,
    capturedParentOids: parentOidMap,
    capturedTips: tips,
    capturedRemoteOids: remoteOids,
    capturedMergedHeads,
    capturedPrs: prs,
    warnings,
    blockers,
    mergeMethods,
  }
  plans.set(token, plan)
  return {
    plan,
    preview: {
      token,
      kind,
      branch: selectedBranch,
      steps,
      warnings,
      blockers,
      mergeMethods: plan.mergeMethods,
    },
  }
}

function prunePlans(): void {
  const now = Date.now()
  for (const [token, plan] of plans) if (plan.expiresAt <= now) plans.delete(token)
}

export async function previewStack(
  repoPath: string,
  snapshot: RepositorySnapshot,
  kind: StackKind,
  branch: string,
): Promise<StackPreview> {
  if (kind !== 'restack' && kind !== 'publish' && kind !== 'merge')
    throw new Error('Invalid stack preview kind')
  requireRefInput(branch, 'branch')
  prunePlans()
  const result = await capturePlan(repoPath, snapshot, kind, branch)
  return result.preview
}

async function revalidatePlan(repoPath: string, plan: StackPlan): Promise<void> {
  const origin = await getOriginUrl(repoPath)
  if (origin !== plan.originUrl)
    throw new Error('Stack preview is stale: the origin remote changed')
  const currentBranch = await getCurrentBranch(repoPath)
  const currentHead = await resolveCommit(repoPath, 'HEAD')
  if (currentBranch !== plan.originalBranch || currentHead !== plan.originalHead) {
    throw new Error('Stack preview is stale: the original checkout or HEAD changed')
  }
  if (plan.pushUrl) {
    const pushUrl = await getRemotePushUrl(repoPath, 'origin')
    const pushRemote = parseRemote(pushUrl)
    const originRemote = parseRemote(origin)
    if (
      pushUrl !== plan.pushUrl ||
      !pushRemote ||
      !originRemote ||
      pushRemote.host !== 'github.com' ||
      pushRemote.fullName.toLowerCase() !== originRemote.fullName.toLowerCase()
    ) {
      throw new Error('Stack preview is stale: the origin push URL changed')
    }
  }
  for (const [branch, expectedTip] of Object.entries(plan.capturedTips)) {
    const currentTip = await resolveCommit(repoPath, `refs/heads/${branch}`)
    if (currentTip !== expectedTip)
      throw new Error(`Stack preview is stale: branch ${branch} changed`)
  }
  for (const [branch, expected] of Object.entries(plan.capturedMergedHeads)) {
    const [pr, oid, commit] = await Promise.all([
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedHeadPr`),
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedHeadOid`),
      getConfigValue(repoPath, `branch.${branch}.gitStacksMergedCommitOid`),
    ])
    if (pr !== expected.pr || oid !== expected.oid || commit !== expected.commit) {
      throw new Error(`Stack preview is stale: merged pull request boundary for ${branch} changed`)
    }
  }
  for (const entry of plan.entries) {
    const parent = await getBranchParent(repoPath, entry.branch)
    if ((plan.capturedParents[entry.branch] ?? null) !== parent) {
      throw new Error(`Stack preview is stale: parent metadata for ${entry.branch} changed`)
    }
    const parentTip = await getConfigValue(repoPath, `branch.${entry.branch}.parentTip`)
    if ((plan.capturedParentTips[entry.branch] ?? null) !== parentTip) {
      throw new Error(`Stack preview is stale: parent boundary for ${entry.branch} changed`)
    }
    const parentOid = plan.capturedParentOids[entry.branch]
    if (parentOid) {
      const currentParentOid = await resolveCommit(repoPath, entry.parentRef)
      if (currentParentOid !== parentOid) {
        throw new Error(`Stack preview is stale: parent ${entry.parent} changed`)
      }
    }
    if (plan.pushUrl) {
      const currentRemote = await remoteOid(repoPath, plan.pushUrl, entry.branch)
      if (currentRemote !== entry.remoteOid)
        throw new Error(`Stack preview is stale: remote ${entry.branch} changed`)
    }
    if ((await branchUpstream(repoPath, entry.branch)) !== entry.upstream) {
      throw new Error(`Stack preview is stale: upstream for ${entry.branch} changed`)
    }
  }
}

async function restoreCheckout(
  repoPath: string,
  branch: string | null,
  head: string | null,
): Promise<void> {
  if (branch) {
    const exists = await refExists(repoPath, `refs/heads/${branch}`)
    if (exists) {
      await runGit(repoPath, ['switch', '--', branch])
      return
    }
  }
  if (head) await runGit(repoPath, ['switch', '--detach', head])
}

async function backupEntries(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    const existing = await resolveCommit(repoPath, entry.backupRef)
    if (existing) {
      if (existing !== entry.oldTip)
        throw new Error(`Backup ref for ${entry.branch} does not match its recorded tip`)
      continue
    }
    await runGit(repoPath, ['update-ref', entry.backupRef, entry.oldTip, ''])
  }
}

async function deleteBackups(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (await resolveCommit(repoPath, entry.backupRef)) {
      await runGit(repoPath, ['update-ref', '-d', entry.backupRef, entry.oldTip])
    }
  }
}

async function updateParentMetadata(
  repoPath: string,
  branch: string,
  parent: string,
  parentTip: string,
): Promise<void> {
  await setConfig(repoPath, `branch.${branch}.parent`, parent)
  await setConfig(repoPath, `branch.${branch}.parentTip`, parentTip)
}

async function restoreParentMetadata(repoPath: string, entry: JournalEntry): Promise<void> {
  if (entry.oldParent) await setConfig(repoPath, `branch.${entry.branch}.parent`, entry.oldParent)
  else await unsetConfig(repoPath, `branch.${entry.branch}.parent`)
  if (entry.oldParentTip)
    await setConfig(repoPath, `branch.${entry.branch}.parentTip`, entry.oldParentTip)
  else await unsetConfig(repoPath, `branch.${entry.branch}.parentTip`)
}

function backupRefFor(id: string, branch: string): string {
  return `refs/git-stacks/backups/${id}/${Buffer.from(branch, 'utf8').toString('hex')}`
}

async function verifyEntryMetadata(
  repoPath: string,
  entry: JournalEntry,
  rollback = false,
): Promise<void> {
  const [parent, tip] = await Promise.all([
    getBranchParent(repoPath, entry.branch),
    getConfigValue(repoPath, `branch.${entry.branch}.parentTip`),
  ])
  const before = parent === entry.oldParent && tip === entry.oldParentTip
  const after =
    entry.newParentTip !== null && parent === entry.newParent && tip === entry.newParentTip
  const forwardPartial = parent === entry.newParent && tip === entry.oldParentTip
  const rollbackPartial = parent === entry.oldParent && tip === entry.newParentTip
  const valid =
    entry.status === 'completed'
      ? after || (rollback && (before || rollbackPartial))
      : entry.status === 'metadata'
        ? before || after || forwardPartial || (rollback && rollbackPartial)
        : before
  if (!valid) throw new Error(`Parent metadata for ${entry.branch} changed outside Git Stacks`)
}

async function verifyCompletedEntries(repoPath: string, journal: StackJournal): Promise<void> {
  for (const entry of journal.entries) {
    if (entry.status !== 'completed') continue
    if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.newTip) {
      throw new Error(`Completed branch ${entry.branch} changed outside Git Stacks`)
    }
    await verifyEntryMetadata(repoPath, entry)
  }
}

interface ActiveRebaseState {
  head: string
  original: string
  onto: string
}

async function activeRebaseState(repoPath: string): Promise<ActiveRebaseState | null> {
  const directory = await gitDirectory(repoPath)
  for (const backend of ['rebase-merge', 'rebase-apply']) {
    try {
      const [head, original, onto] = await Promise.all(
        ['head-name', 'orig-head', 'onto'].map((name) =>
          fs.readFile(path.join(directory, backend, name), 'utf8'),
        ),
      )
      return { head: head.trim(), original: original.trim(), onto: onto.trim() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return null
}

function expectedRebaseOnto(journal: StackJournal, entry: JournalEntry): string {
  const parent = journal.entries.find(
    (candidate) => candidate.branch === entry.newParent && candidate.status === 'completed',
  )
  return entry.newParentTip ?? parent?.newTip ?? entry.newParentOid
}

function replayReflogAction(journal: StackJournal, entry: JournalEntry): string {
  return `git-stacks-rebase:${journal.id}:${entry.boundary}:${expectedRebaseOnto(journal, entry)}`
}

async function requiredHeadReflogCount(repoPath: string): Promise<number> {
  const logAllRefUpdates = await tryGit(repoPath, [
    'config',
    '--bool',
    '--get',
    'core.logAllRefUpdates',
  ])
  if (stripTrailingNewline(logAllRefUpdates ?? '') === 'false') {
    throw new Error('Restack recovery requires HEAD reflog recording to remain enabled')
  }
  const output = await tryGit(repoPath, ['reflog', 'show', 'HEAD', '--format=%H'])
  const count = output?.split('\n').filter((line) => line.length > 0).length ?? 0
  if (count === 0) throw new Error('Restack recovery requires an available HEAD reflog baseline')
  return count
}

type ParsedReflogEntry = { oid: string; message: string }

function recoveryProofError(entry: JournalEntry): Error {
  return new Error(
    `Cannot prove the saved rebase for ${entry.branch} matches its recorded boundary and destination; refusing recovery`,
  )
}

async function recordedHeadReflogDelta(
  repoPath: string,
  entry: JournalEntry,
): Promise<ParsedReflogEntry[]> {
  if (entry.headReflogCount === null) throw recoveryProofError(entry)
  const headOutput = await tryGit(repoPath, ['reflog', 'show', 'HEAD', '--format=%H %gs'])
  if (headOutput === null) throw recoveryProofError(entry)
  const headLines = headOutput.split('\n').filter((line) => line.length > 0)
  const deltaLength = headLines.length - entry.headReflogCount
  if (deltaLength < 1) throw recoveryProofError(entry)
  const delta = headLines.slice(0, deltaLength).map(parseReflogEntry).reverse()
  if (delta.some((line) => line === null)) throw recoveryProofError(entry)
  return delta as ParsedReflogEntry[]
}

async function assertRecordedReplayStart(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<{ action: string; delta: ParsedReflogEntry[] }> {
  const action = replayReflogAction(journal, entry)
  const expectedOnto = expectedRebaseOnto(journal, entry)
  const delta = await recordedHeadReflogDelta(repoPath, entry)
  const start = delta[0]
  if (
    !start ||
    start.oid !== expectedOnto ||
    start.message !== `${action} (start): checkout ${expectedOnto}`
  )
    throw recoveryProofError(entry)
  return { action, delta }
}

function inactiveRebaseError(): Error {
  return new Error('The saved stack rebase is not active; inspect its backup refs before recovery')
}

async function assertActiveRebase(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<void> {
  const state = await activeRebaseState(repoPath)
  if (!state) throw inactiveRebaseError()
  const expectedOnto = expectedRebaseOnto(journal, entry)
  if (
    state.head !== `refs/heads/${entry.branch}` ||
    state.original !== entry.oldTip ||
    state.onto !== expectedOnto
  ) {
    throw new Error(
      'The active rebase does not match the saved stack operation; refusing to change it',
    )
  }
  const { action, delta } = await assertRecordedReplayStart(repoPath, journal, entry)
  assertActiveReplayHistory(entry, action, delta)
  entry.newParentTip = expectedOnto
}

function isRecordedReplayStep(action: string, message: string): boolean {
  return message.startsWith(`${action} (pick): `) || message.startsWith(`${action} (continue): `)
}

function assertActiveReplayHistory(
  entry: JournalEntry,
  action: string,
  delta: ParsedReflogEntry[],
): void {
  for (let index = 1; index < delta.length; index += 1) {
    const line = delta[index]
    if (!line || !isRecordedReplayStep(action, line.message)) throw recoveryProofError(entry)
  }
}

function parseReflogEntry(line: string): ParsedReflogEntry | null {
  const separator = line.indexOf(' ')
  if (separator <= 0) return null
  return { oid: line.slice(0, separator), message: line.slice(separator + 1) }
}

// Prove that the ref entries appended since the journaled launch form exactly
// one rebase of this journal's replay: a single start checked out at the
// recorded onto, followed only by that rebase's pick/continue steps and its
// finish back on this branch. Anything else (an external abort, a second
// rebase, a substituted boundary) cannot be adopted, so the backup ref stays.
async function assertRecordedReplay(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
  expectedOnto: string,
  tip: string,
): Promise<void> {
  const { action, delta } = await assertRecordedReplayStart(repoPath, journal, entry)
  if (delta.length < 2) throw recoveryProofError(entry)
  let finish: ParsedReflogEntry | null = null
  for (let index = 1; index < delta.length; index += 1) {
    const line = delta[index]
    if (!line) throw recoveryProofError(entry)
    if (line.message === `${action} (finish): returning to refs/heads/${entry.branch}`) {
      finish = line
      break
    }
    if (!isRecordedReplayStep(action, line.message)) throw recoveryProofError(entry)
  }
  if (!finish || finish.oid !== tip || expectedRebaseOnto(journal, entry) !== expectedOnto)
    throw recoveryProofError(entry)
}

async function reconcileCompletedRebase(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
  tip: string | null,
): Promise<void> {
  const operation = await getOperationState(repoPath)
  if (operation.busy) throw new Error('Another Git operation is still in progress')
  if (!tip || tip === entry.oldTip) throw inactiveRebaseError()
  const backup = await resolveCommit(repoPath, entry.backupRef)
  if (backup !== entry.oldTip)
    throw new Error(`Backup ref for ${entry.branch} does not match its recorded tip`)
  const expectedOnto = expectedRebaseOnto(journal, entry)
  const output = await tryGit(repoPath, [
    'reflog',
    'show',
    `refs/heads/${entry.branch}`,
    '--format=%H %gs',
    '--max-count=2',
  ])
  const lines = (output ?? '').split('\n').filter((line) => line.length > 0)
  const newest = parseReflogEntry(lines[0] ?? '')
  const previous = parseReflogEntry(lines[1] ?? '')
  const prefix = `${replayReflogAction(journal, entry)} (finish): refs/heads/${entry.branch} onto `

  const proven =
    newest !== null &&
    previous !== null &&
    newest.oid === tip &&
    previous.oid === entry.oldTip &&
    newest.message.startsWith(prefix) &&
    isOid(newest.message.slice(prefix.length)) &&
    newest.message.slice(prefix.length) === expectedOnto
  if (!proven)
    throw new Error(`Branch ${entry.branch} changed outside Git Stacks; refusing to adopt its tip`)
  await assertRecordedReplay(repoPath, journal, entry, expectedOnto, tip)
  entry.newParentTip = expectedOnto
  entry.newTip = tip
  entry.status = 'metadata'
  await writeJournal(repoPath, journal)
}

async function completeEntry(
  repoPath: string,
  journal: StackJournal,
  entry: JournalEntry,
): Promise<void> {
  if (entry.status === 'rebasing') {
    const [tip, branch] = await Promise.all([
      resolveCommit(repoPath, `refs/heads/${entry.branch}`),
      getCurrentBranch(repoPath),
    ])
    if (!tip || branch !== entry.branch)
      throw new Error(`Restack did not finish on attached branch ${entry.branch}`)
    entry.newTip = tip
    entry.status = 'metadata'
    await writeJournal(repoPath, journal)
  }
  if (entry.status !== 'metadata' || !entry.newTip || !entry.newParentTip)
    throw new Error('Incomplete stack completion checkpoint')
  if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.newTip) {
    throw new Error(`Branch ${entry.branch} changed before its metadata could be completed`)
  }
  await verifyEntryMetadata(repoPath, entry)
  await updateParentMetadata(repoPath, entry.branch, entry.newParent, entry.newParentTip)
  entry.status = 'completed'
  journal.status = 'running'
  journal.currentBranch = entry.branch
  journal.message = `Restacked ${entry.branch}`
  await writeJournal(repoPath, journal)
}

async function restackJournal(repoPath: string, journal: StackJournal): Promise<ActionResult> {
  if (journal.status === 'aborting')
    throw new Error('Stack rollback has started; use Abort to finish it')
  await ensureNoBusyOperation(repoPath, 'resume the stack')
  await ensureClean(repoPath, 'resume the stack')
  await verifyCompletedEntries(repoPath, journal)
  await backupEntries(repoPath, journal)
  await writeJournal(repoPath, journal)
  for (const entry of journal.entries) {
    if (entry.status === 'completed') continue
    if (entry.status === 'metadata') {
      await completeEntry(repoPath, journal, entry)
      continue
    }
    if (entry.status !== 'pending')
      throw new Error(`Inspect the interrupted ${entry.branch} step before continuing`)
    if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
      throw new Error(
        `Branch ${entry.branch} changed before its stack step; no replay was attempted`,
      )
    }
    await verifyEntryMetadata(repoPath, entry)
    await ensureNotCheckedOutElsewhere(repoPath, entry.branch)
    await ensureClean(repoPath, 'restack the next branch')
    const parent = journal.entries.find(
      (candidate) => candidate.branch === entry.newParent && candidate.status === 'completed',
    )
    const parentRef = parent ? `refs/heads/${entry.newParent}` : entry.newParentRef
    const parentOid = parent?.newTip ?? entry.newParentOid
    if ((await resolveCommit(repoPath, parentRef)) !== parentOid) {
      throw new Error(`Parent ${entry.newParent} changed after preview; no replay was attempted`)
    }
    if (!(await isAncestor(repoPath, entry.boundary, entry.oldTip))) {
      throw new Error(`The recorded rebase boundary for ${entry.branch} is no longer an ancestor`)
    }
    entry.newParentRef = parentRef
    entry.newParentTip = parentOid
    entry.status = 'rebasing'
    journal.currentBranch = entry.branch
    journal.status = 'running'
    journal.message = `Restacking ${entry.branch} onto ${entry.newParent}`
    try {
      await runGit(repoPath, ['switch', '--', entry.branch])
      if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
        throw new Error(`Branch ${entry.branch} changed after preview; no replay was attempted`)
      }
      entry.headReflogCount = await requiredHeadReflogCount(repoPath)
      await writeJournal(repoPath, journal)
      if ((await resolveCommit(repoPath, `refs/heads/${entry.branch}`)) !== entry.oldTip) {
        entry.status = 'pending'
        entry.headReflogCount = null
        throw new Error(`Branch ${entry.branch} changed after preview; no replay was attempted`)
      }
      await runGit(
        repoPath,
        [
          '-c',
          'rebase.updateRefs=false',
          '-c',
          'rebase.autoStash=false',
          'rebase',
          '--onto',
          parentOid,
          entry.boundary,
          entry.branch,
        ],
        {
          GIT_EDITOR: 'true',
          GIT_REFLOG_ACTION: replayReflogAction(journal, entry),
        },
      )
    } catch (error) {
      const operation = await getOperationState(repoPath)
      let restoreDetail = ''
      if (entry.headReflogCount === null) {
        entry.status = 'pending'
        if (!operation.rebase) {
          try {
            await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
            journal.currentBranch = journal.originalBranch
          } catch (restoreError) {
            restoreDetail = `; checkout restore failed: ${commandDetail(restoreError)}`
          }
        }
      }
      journal.status = operation.rebase ? 'conflict' : 'uncertain'
      journal.message = `${operation.rebase ? 'Restack paused' : 'Restack stopped'} on ${entry.branch}: ${commandDetail(error)}${restoreDetail}`
      await writeJournal(repoPath, journal)
      throw new Error(journal.message)
    }
    await completeEntry(repoPath, journal, entry)
  }
  await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
  await deleteBackups(repoPath, journal)
  await removeJournal(repoPath)
  return {
    message: `Restacked ${journal.entries.length} stack branch${journal.entries.length === 1 ? '' : 'es'}`,
  }
}

async function beginRestack(repoPath: string, plan: StackPlan): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  if (plan.entries.length === 0) {
    return { message: 'No remaining unmerged stack branches require restacking' }
  }
  await ensureNoBusyOperation(repoPath, 'restack the stack')
  await ensureClean(repoPath, 'restack the stack')
  await revalidatePlan(repoPath, plan)
  const id = randomUUID()
  const journal: StackJournal = {
    version: JOURNAL_VERSION,
    id,
    repoPath,
    originalBranch: plan.originalBranch,
    originalHead: plan.originalHead,
    currentBranch: plan.originalBranch,
    entries: plan.entries.map((entry) => ({
      branch: entry.branch,
      oldTip: entry.oldTip,
      newTip: null,
      oldParent: entry.oldParent,
      oldParentTip: entry.oldParentTip,
      newParent: entry.parent,
      newParentRef: entry.parentRef,
      newParentOid: entry.parentOid,
      newParentTip: null,
      boundary: entry.boundary,
      backupRef: backupRefFor(id, entry.branch),
      headReflogCount: null,
      status: 'pending',
    })),
    status: 'running',
    message: 'Preparing stack restack',
  }
  return restackJournal(repoPath, journal)
}

async function stackContinue(repoPath: string): Promise<ActionResult> {
  const journal = await readJournal(repoPath)
  if (!journal) throw new Error('No interrupted Git Stacks operation is available')
  if (journal.status === 'aborting')
    throw new Error('Stack rollback has started; use Abort to finish it')
  const active = journal.entries.find((entry) => entry.status === 'rebasing')
  if (!active) return restackJournal(repoPath, journal)
  await verifyCompletedEntries(repoPath, journal)
  await verifyEntryMetadata(repoPath, active)
  if (!(await activeRebaseState(repoPath))) {
    const tip = await resolveCommit(repoPath, `refs/heads/${active.branch}`)
    await reconcileCompletedRebase(repoPath, journal, active, tip)
    await completeEntry(repoPath, journal, active)
    return restackJournal(repoPath, journal)
  }
  await assertActiveRebase(repoPath, journal, active)
  if ((await resolveCommit(repoPath, `refs/heads/${active.branch}`)) !== active.oldTip) {
    throw new Error(
      `Branch ${active.branch} changed while the stack was paused; refusing to continue`,
    )
  }
  if ((await resolveCommit(repoPath, active.newParentRef)) !== active.newParentTip) {
    throw new Error(`Parent ${active.newParent} changed while the stack was paused`)
  }
  await requiredHeadReflogCount(repoPath)
  try {
    await runGit(
      repoPath,
      ['-c', 'rebase.updateRefs=false', '-c', 'rebase.autoStash=false', 'rebase', '--continue'],
      {
        GIT_EDITOR: 'true',
        GIT_REFLOG_ACTION: replayReflogAction(journal, active),
      },
    )
  } catch (error) {
    journal.status = (await getOperationState(repoPath)).rebase ? 'conflict' : 'uncertain'
    journal.message = `Restack remains paused on ${active.branch}: ${commandDetail(error)}`
    await writeJournal(repoPath, journal)
    throw new Error(journal.message)
  }
  await completeEntry(repoPath, journal, active)
  return restackJournal(repoPath, journal)
}

async function stackAbort(repoPath: string): Promise<ActionResult> {
  const journal = await readJournal(repoPath)
  if (!journal) throw new Error('No interrupted Git Stacks operation is available')
  const state = await getOperationState(repoPath)
  const active = journal.entries.find((entry) => entry.status === 'rebasing')
  if (state.rebase) {
    if (!active) throw new Error('An unrelated rebase is active; refusing to abort it')
    await assertActiveRebase(repoPath, journal, active)
  } else if (state.busy) {
    throw new Error('Another Git operation is still in progress')
  } else {
    await ensureClean(repoPath, 'abort the stack')
    if (active) {
      const tip = await resolveCommit(repoPath, `refs/heads/${active.branch}`)
      if (tip && tip !== active.oldTip) {
        await reconcileCompletedRebase(repoPath, journal, active, tip)
      }
    }
  }
  for (const entry of journal.entries) {
    const tip = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    if (tip !== entry.oldTip && (!entry.newTip || tip !== entry.newTip)) {
      throw new Error(`Refusing to restore ${entry.branch}: its tip changed outside Git Stacks`)
    }
    await verifyEntryMetadata(repoPath, entry, journal.status === 'aborting')
    await ensureNotCheckedOutElsewhere(repoPath, entry.branch)
  }
  journal.status = 'aborting'
  journal.message = 'Aborting stack restack and restoring saved branch tips'
  await writeJournal(repoPath, journal)
  if (state.rebase) await runGit(repoPath, ['rebase', '--abort'])
  await ensureClean(repoPath, 'restore saved stack branches')
  const currentBranch = await getCurrentBranch(repoPath)
  if (currentBranch && journal.entries.some((entry) => entry.branch === currentBranch)) {
    await runGit(repoPath, ['switch', '--detach', 'HEAD'])
  }
  for (const entry of [...journal.entries].reverse()) {
    if (entry.status === 'restored') continue
    const tip = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    if (tip !== entry.oldTip) {
      if (!entry.newTip || tip !== entry.newTip)
        throw new Error(`Branch ${entry.branch} changed during rollback`)
      await runGit(repoPath, [
        'update-ref',
        `refs/heads/${entry.branch}`,
        entry.oldTip,
        entry.newTip,
      ])
    }
    await verifyEntryMetadata(repoPath, entry, true)
    await restoreParentMetadata(repoPath, entry)
    entry.status = 'restored'
    await writeJournal(repoPath, journal)
  }
  await restoreCheckout(repoPath, journal.originalBranch, journal.originalHead)
  await deleteBackups(repoPath, journal)
  await removeJournal(repoPath)
  return { message: 'Aborted the stack restack and restored the original branch tips' }
}
async function currentOrigin(
  repoPath: string,
  includePushUrl = false,
): Promise<{ url: string; fullName: string; pushUrl: string | null }> {
  const url = await getOriginUrl(repoPath)
  const remote = parseRemote(url)
  if (!url || !remote || remote.host !== 'github.com')
    throw new Error('A github.com origin remote is required')
  let pushUrl: string | null = null
  if (includePushUrl) pushUrl = await getRemotePushUrl(repoPath, 'origin')
  return { url, fullName: remote.fullName, pushUrl }
}
async function repositoryMergeMethods(
  fullName: string,
): Promise<('merge' | 'squash' | 'rebase')[] | null> {
  try {
    const { data } = await githubTransport().rest<Record<string, unknown>>({
      path: `repos/${fullName}`,
    })
    if (!isRecord(data)) return null
    const methods: ('merge' | 'squash' | 'rebase')[] = []
    if (data.allow_merge_commit === true) methods.push('merge')
    if (data.allow_squash_merge === true) methods.push('squash')
    if (data.allow_rebase_merge === true) methods.push('rebase')
    return methods
  } catch {
    return null
  }
}

async function setPullRequestNumber(
  repoPath: string,
  branch: string,
  number: number,
): Promise<void> {
  await setConfig(repoPath, `branch.${branch}.gitStacksPr`, String(number))
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedHeadPr`)
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedHeadOid`)
  await unsetConfig(repoPath, `branch.${branch}.gitStacksMergedCommitOid`)
}

async function canonicalPullRequests(
  repoPath: string,
): Promise<{ data: GitHubResult; fullName: string }> {
  const origin = await currentOrigin(repoPath)
  const data = await getGitHubData(repoPath, origin.url)
  if (!data.available) throw new Error(data.message)
  return { data, fullName: origin.fullName }
}

function mergeBlockers(pr: PullRequest, base: string, head: string): string[] {
  const blockers: string[] = []
  if (pr.state !== 'OPEN') blockers.push(`Pull request #${pr.number} is not open`)
  if (pr.base !== base) blockers.push(`Pull request #${pr.number} is not based on ${base}`)
  if (!pr.headOid || pr.headOid !== head)
    blockers.push(`Pull request #${pr.number} head does not match the reviewed local tip`)
  if (pr.draft) blockers.push(`Pull request #${pr.number} is still a draft`)
  if (pr.checks === 'pending' || pr.checks === 'failing')
    blockers.push(`Pull request #${pr.number} checks are ${pr.checks}`)
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED') {
    blockers.push(`Pull request #${pr.number} still requires review approval`)
  }
  if (pr.mergeState?.toUpperCase() !== 'CLEAN')
    blockers.push(`Pull request #${pr.number} is not mergeable (${pr.mergeState || 'unknown'})`)
  return blockers
}

async function exactPrForBranch(branch: string, data: GitHubResult): Promise<PullRequest | null> {
  const matches = data.pullRequests.filter(
    (pr, index) => pr.head === branch && data.sameRepository(index),
  )
  const open = matches.filter((pr) => pr.state === 'OPEN')
  if (open.length > 1)
    throw new Error(`Multiple canonical pull requests target local branch ${branch}`)
  if (open.length === 1) return open[0]
  if (matches.length > 1)
    throw new Error(
      `Multiple historical pull requests target local branch ${branch}; select the recorded PR explicitly`,
    )
  return matches[0] ?? null
}

function matchesCapturedPullRequest(entry: PlanEntry, currentPr: PullRequest | null): boolean {
  if (!entry.pr) return currentPr === null
  if (!currentPr || currentPr.state !== 'OPEN') return false
  return (
    currentPr.number === entry.pr.number &&
    currentPr.head === entry.pr.head &&
    currentPr.headOid === entry.pr.headOid &&
    currentPr.base === entry.pr.base
  )
}

async function withLocalBranchRefLock<T>(
  repoPath: string,
  branch: string,
  action: () => Promise<T>,
): Promise<T> {
  const refStorage = await getConfigValue(repoPath, 'extensions.refstorage')
  let refRoot: string | null = null
  if (refStorage && refStorage.toLowerCase() !== 'files') {
    try {
      refRoot = localFilesRefStoragePath(refStorage)
    } catch {
      throw new Error(`Cannot safely publish ${branch} with ref storage ${refStorage}`)
    }
  }
  const refPathValue = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-path', `refs/heads/${branch}`]),
  )
  if (!refPathValue) throw new Error(`Cannot locate the local ref for ${branch}`)
  const lockPath = `${gitPathOnDisk(repoPath, refPathValue, refRoot)}.lock`
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  const locksDir = path.resolve(repoPath, commonDir, 'git-stacks-branch-locks')
  await fs.mkdir(locksDir, { recursive: true })

  const transactionId = randomUUID()
  const lockJournalPath = path.join(locksDir, `${transactionId}.json`)
  const lockInfo: BranchLockInfo = {
    pid: process.pid,
    branch,
    lockPath,
    createdAt: Date.now(),
    transactionId,
  }
  const tempJournal = `${lockJournalPath}.${randomUUID()}.tmp`
  const journalHandle = await fs.open(tempJournal, 'wx', 0o600)
  try {
    await journalHandle.writeFile(JSON.stringify(lockInfo), 'utf8')
    await journalHandle.sync()
  } finally {
    await journalHandle.close()
  }
  await fs.rename(tempJournal, lockJournalPath)

  let lock: FileHandle | null = null
  try {
    lock = await fs.open(lockPath, 'wx', 0o666)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const recovered = await tryRecoverStaleBranchLock(repoPath, lockPath, branch)
      if (recovered) {
        try {
          lock = await fs.open(lockPath, 'wx', 0o666)
        } catch (err) {
          await fs.unlink(lockJournalPath).catch(() => {})
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Cannot publish ${branch}: its local branch ref is being updated`)
          }
          throw err
        }
      } else {
        await fs.unlink(lockJournalPath).catch(() => {})
        throw new Error(`Cannot publish ${branch}: its local branch ref is being updated`)
      }
    } else {
      await fs.unlink(lockJournalPath).catch(() => {})
      throw error
    }
  }

  try {
    await lock!.writeFile(JSON.stringify(lockInfo), 'utf8')
    await lock!.sync()
    const lockIdentity = await lock!.stat()
    try {
      return await action()
    } finally {
      try {
        const current = await fs.lstat(lockPath)
        if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
          await fs.unlink(lockPath)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } finally {
    await fs.unlink(lockJournalPath).catch(() => {})
    await lock?.close().catch(() => {})
  }
}

async function pushBranch(
  repoPath: string,
  entry: PlanEntry,
  allowForce: boolean,
  pushUrl: string,
): Promise<string> {
  return withLocalBranchRefLock(repoPath, entry.branch, async () => {
    const upstream = await branchUpstream(repoPath, entry.branch)
    if (upstream && upstream !== `origin/${entry.branch}`) {
      throw new Error(`Branch ${entry.branch} has a non-origin or renamed upstream (${upstream})`)
    }
    const local = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    if (!local) throw new Error(`Branch ${entry.branch} no longer exists`)
    if (local !== entry.oldTip)
      throw new Error(`Stack preview is stale: local ${entry.branch} changed`)
    const remote = await remoteOid(repoPath, pushUrl, entry.branch)
    if (remote !== entry.remoteOid)
      throw new Error(`Stack preview is stale: remote ${entry.branch} changed`)
    if (remote === local) {
      await setConfig(repoPath, `branch.${entry.branch}.remote`, 'origin')
      await setConfig(repoPath, `branch.${entry.branch}.merge`, `refs/heads/${entry.branch}`)
      return local
    }
    const nonFastForward = remote !== null && !(await isAncestor(repoPath, remote, local))
    if (nonFastForward && !allowForce) {
      throw new Error(`Publishing ${entry.branch} requires explicit force-with-lease permission`)
    }
    if (nonFastForward) {
      if (!entry.remoteOid) throw new Error(`Remote ${entry.branch} changed; force lease refused`)
      await runGit(repoPath, [
        '-c',
        'push.followTags=false',
        'push',
        '--no-mirror',
        `--force-with-lease=refs/heads/${entry.branch}:${entry.remoteOid}`,
        'origin',
        `${entry.oldTip}:refs/heads/${entry.branch}`,
      ])
    } else {
      await runGit(repoPath, [
        '-c',
        'push.followTags=false',
        'push',
        '--no-force',
        '--no-mirror',
        'origin',
        `${entry.oldTip}:refs/heads/${entry.branch}`,
      ])
    }
    await setConfig(repoPath, `branch.${entry.branch}.remote`, 'origin')
    await setConfig(repoPath, `branch.${entry.branch}.merge`, `refs/heads/${entry.branch}`)
    return local
  })
}

async function createPullRequest(
  fullName: string,
  branch: string,
  base: string,
  title: string,
  draft: boolean,
): Promise<void> {
  try {
    await githubTransport().rest({
      method: 'POST',
      path: `repos/${fullName}/pulls`,
      body: {
        title,
        head: branch,
        base,
        body: `${title}\n\n${STACK_MARKER}\nGit Stacks branch: ${branch}\nBase: ${base}`,
        draft,
      },
    })
  } catch (error) {
    throw new Error(`Could not create pull request for ${branch}: ${commandDetail(error)}`)
  }
}

async function patchPullRequest(
  fullName: string,
  number: number,
  body: Record<string, unknown>,
): Promise<void> {
  await githubTransport().rest({
    method: 'PATCH',
    path: `repos/${fullName}/pulls/${number}`,
    body,
  })
}

async function changePullRequestDraft(
  fullName: string,
  number: number,
  draft: boolean,
): Promise<void> {
  const [owner, name] = fullName.split('/')
  const transport = githubTransport()
  const lookup = await transport.graphql<unknown>(
    'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }',
    { owner, name, number },
  )
  const repository = isRecord(lookup) ? lookup.repository : null
  const pullRequest = isRecord(repository) ? repository.pullRequest : null
  if (!isRecord(pullRequest) || typeof pullRequest.id !== 'string')
    throw new Error(`Could not identify pull request #${number} for readiness update`)
  const field = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'
  const result = await transport.graphql<unknown>(
    `mutation($pullRequestId: ID!) { ${field}(input: {pullRequestId: $pullRequestId}) { pullRequest { id isDraft } } }`,
    { pullRequestId: pullRequest.id },
  )
  const payload = isRecord(result) ? result[field] : null
  const updated = isRecord(payload) ? payload.pullRequest : null
  if (!isRecord(updated) || updated.id !== pullRequest.id || updated.isDraft !== draft)
    throw new Error(`Pull request #${number} did not change readiness`)
}

async function linkStackComments(
  fullName: string,
  pullRequests: Array<{ branch: string; pr: PullRequest }>,
): Promise<void> {
  const transport = githubTransport()
  const { data: viewer } = await transport.rest<Record<string, unknown>>({ path: 'user' })
  if (!isRecord(viewer) || typeof viewer.id !== 'number')
    throw new Error('Could not verify the authenticated GitHub comment author')
  const endMarker = '<!-- /git-stacks:stack-links:v1 -->'
  const links = pullRequests
    .map((entry) => `- ${entry.branch}: #${entry.pr.number} (${entry.pr.url})`)
    .join('\n')
  const managed = `${STACK_MARKER}\nStack navigation:\n${links}\n${endMarker}`
  const owned = (comment: unknown): comment is Record<string, unknown> =>
    isRecord(comment) &&
    isRecord(comment.user) &&
    comment.user.id === viewer.id &&
    typeof comment.id === 'number' &&
    typeof comment.body === 'string' &&
    comment.body.startsWith(`${STACK_MARKER}\n`)
  for (const entry of pullRequests) {
    const endpoint = `repos/${fullName}/issues/${entry.pr.number}/comments`
    const comments = await transport.paginate<unknown>({ path: endpoint })
    const candidates = comments.filter(owned)
    if (candidates.length > 1)
      throw new Error(
        `Multiple owned stack comments exist on PR #${entry.pr.number}; reconcile them on GitHub before publishing`,
      )
    let id: number
    let body = managed
    const existing = candidates[0]
    if (existing) {
      const { data } = await transport.rest<Record<string, unknown>>({
        path: `repos/${fullName}/issues/comments/${existing.id}`,
      })
      if (!owned(data)) throw new Error(`Stack comment ownership changed on PR #${entry.pr.number}`)
      const previous = data.body as string
      const end = previous.indexOf(endMarker)
      if (
        end < 0 ||
        previous.indexOf(STACK_MARKER, STACK_MARKER.length) >= 0 ||
        previous.indexOf(endMarker, end + endMarker.length) >= 0
      ) {
        throw new Error(
          `The owned stack comment on PR #${entry.pr.number} has ambiguous boundaries; preserve and reconcile it on GitHub`,
        )
      }
      id = data.id as number
      body += previous.slice(end + endMarker.length)
      if (body !== previous)
        await transport.rest({
          method: 'PATCH',
          path: `repos/${fullName}/issues/comments/${id}`,
          body: { body },
        })
    } else {
      const { data: created } = await transport.rest<Record<string, unknown>>({
        method: 'POST',
        path: endpoint,
        body: { body },
      })
      if (!owned(created))
        throw new Error(
          `Stack comment creation for PR #${entry.pr.number} is unconfirmed; inspect GitHub before retrying`,
        )
      id = created.id as number
    }
    const { data: readBack } = await transport.rest<Record<string, unknown>>({
      path: `repos/${fullName}/issues/comments/${id}`,
    })
    if (!owned(readBack) || readBack.body !== body)
      throw new Error(
        `Stack navigation for PR #${entry.pr.number} did not match its confirmed content`,
      )
  }
}

async function publishStack(
  repoPath: string,
  plan: StackPlan,
  action: Extract<StackAction, { type: 'executeStack' }>,
): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  const origin = await currentOrigin(repoPath, true)
  if (origin.url !== plan.originUrl || origin.pushUrl !== plan.pushUrl) {
    throw new Error('Stack preview is stale: origin fetch or push URL changed')
  }
  await ensureNoBusyOperation(repoPath, 'publish the stack')
  await ensureClean(repoPath, 'publish the stack')
  await revalidatePlan(repoPath, plan)
  if (!plan.pushUrl) throw new Error('A single github.com origin push URL is required')
  const pushUrl = plan.pushUrl
  for (const entry of plan.entries) {
    const local = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
    const remote = await remoteOid(repoPath, pushUrl, entry.branch)
    if (remote !== entry.remoteOid)
      throw new Error(`Stack preview is stale: remote ${entry.branch} changed`)
    const nonFastForward =
      remote !== null && local !== null && !(await isAncestor(repoPath, remote, local))
    if (nonFastForward && !action.allowForce) {
      throw new Error(`Publishing ${entry.branch} requires explicit force-with-lease permission`)
    }
  }
  const preflight = await canonicalPullRequests(repoPath)
  for (const entry of plan.entries) {
    const currentPr = await exactPrForBranch(entry.branch, preflight.data)
    if (!matchesCapturedPullRequest(entry, currentPr)) {
      throw new Error(`Stack preview is stale: pull request for ${entry.branch} changed`)
    }
  }
  const canonical = preflight
  const published: Array<{ branch: string; pr: PullRequest }> = []
  for (const entry of plan.entries) {
    const beforePush = await getGitHubData(repoPath, origin.url)
    if (!beforePush.available) throw new Error(beforePush.message)
    const beforePushPr = await exactPrForBranch(entry.branch, beforePush)
    if (!matchesCapturedPullRequest(entry, beforePushPr)) {
      throw new Error(
        `Pull request for ${entry.branch} changed during publication; inspect the published branches before retrying`,
      )
    }
    const currentOid = await pushBranch(repoPath, entry, action.allowForce, pushUrl)
    const currentData = await getGitHubData(repoPath, origin.url)
    if (!currentData.available) throw new Error(currentData.message)
    let pr = await exactPrForBranch(entry.branch, currentData)
    const base = entry.parent
    if (
      (entry.pr &&
        (!pr ||
          pr.number !== entry.pr.number ||
          pr.base !== entry.pr.base ||
          pr.state !== 'OPEN')) ||
      (!entry.pr && pr !== null)
    ) {
      throw new Error(
        `Pull request for ${entry.branch} changed during publication; inspect the published branches before retrying`,
      )
    }
    if (!pr) {
      await createPullRequest(
        canonical.fullName,
        entry.branch,
        base,
        action.titles[entry.branch] ?? entry.branch,
        action.draft,
      )
      const afterCreate = await getGitHubData(repoPath, origin.url)
      if (!afterCreate.available) throw new Error(afterCreate.message)
      pr = await exactPrForBranch(entry.branch, afterCreate)
      if (!pr)
        throw new Error(
          `Pull request creation for ${entry.branch} returned no canonical head; retry only after a fresh preview`,
        )
    } else if (pr.base !== base) {
      await patchPullRequest(canonical.fullName, pr.number, { base })
      const afterPatch = await getPullRequest(repoPath, pr.number)
      if (afterPatch.base !== base)
        throw new Error(`Pull request #${pr.number} did not accept base ${base}`)
      pr = afterPatch
    }
    await setPullRequestNumber(repoPath, entry.branch, pr.number)
    const readBack = await getPullRequest(repoPath, pr.number)
    if (
      readBack.state !== 'OPEN' ||
      readBack.base !== base ||
      pullRequestRepository(readBack) !== canonical.fullName.toLowerCase() ||
      readBack.head !== entry.branch ||
      readBack.headOid !== currentOid
    ) {
      throw new Error(
        `Pull request #${pr.number} no longer points at ${entry.branch}@${currentOid}`,
      )
    }
    published.push({ branch: entry.branch, pr: readBack })
  }
  await linkStackComments(canonical.fullName, published)
  return {
    message: `Published ${published.length} stack pull request${published.length === 1 ? '' : 's'}`,
  }
}

async function mergeStack(
  repoPath: string,
  plan: StackPlan,
  action: Extract<StackAction, { type: 'executeStack' }>,
): Promise<ActionResult> {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '))
  const origin = await currentOrigin(repoPath)
  if (
    origin.url !== plan.originUrl ||
    origin.fullName.toLowerCase() !== plan.originFullName?.toLowerCase()
  ) {
    throw new Error('Stack preview is stale: origin changed')
  }
  await ensureNoBusyOperation(repoPath, 'merge the pull request')
  await ensureClean(repoPath, 'merge the pull request')
  await revalidatePlan(repoPath, plan)
  if (!plan.originFullName) throw new Error('A github.com origin remote is required')
  const entry = plan.entries.find((candidate) => candidate.branch === plan.branch)
  if (!entry?.pr || !entry.pr.headOid)
    throw new Error('The selected bottom pull request is unavailable')
  const currentTip = await resolveCommit(repoPath, `refs/heads/${entry.branch}`)
  if (currentTip !== entry.oldTip || currentTip !== entry.pr.headOid)
    throw new Error('Stack preview is stale: pull request head changed')
  const currentPr = await getPullRequest(repoPath, entry.pr.number)
  if (
    currentPr.state !== 'OPEN' ||
    currentPr.head !== entry.branch ||
    currentPr.headOid !== entry.pr.headOid
  ) {
    throw new Error(`Pull request #${entry.pr.number} changed since preview`)
  }
  const currentData = await getGitHubData(repoPath, plan.originUrl)
  if (!currentData.available) throw new Error(currentData.message)
  const canonical = await exactPrForBranch(entry.branch, currentData)
  if (
    !canonical ||
    canonical.number !== entry.pr.number ||
    canonical.headOid !== entry.pr.headOid
  ) {
    throw new Error(`Pull request #${entry.pr.number} changed since preview`)
  }
  const blockers = mergeBlockers(currentPr, plan.defaultBranch, entry.oldTip)
  blockers.push(...mergeBlockers(canonical, plan.defaultBranch, entry.oldTip))
  if (blockers.length > 0) throw new Error([...new Set(blockers)].join('; '))
  const allowedMethods = await repositoryMergeMethods(plan.originFullName)
  if (
    !plan.mergeMethods.includes(action.mergeMethod) ||
    !allowedMethods ||
    !allowedMethods.includes(action.mergeMethod)
  ) {
    throw new Error(`Merge method ${action.mergeMethod} is not allowed by the repository`)
  }
  await setPullRequestNumber(repoPath, entry.branch, entry.pr.number)
  let mergeError: unknown
  try {
    await githubTransport().rest({
      method: 'PUT',
      path: `repos/${plan.originFullName}/pulls/${entry.pr.number}/merge`,
      body: { sha: entry.pr.headOid, merge_method: action.mergeMethod },
    })
  } catch (error) {
    mergeError = error
  }
  let readBack: PullRequest
  try {
    readBack = await getPullRequest(repoPath, entry.pr.number)
  } catch {
    throw new Error(
      `Could not confirm whether PR #${entry.pr.number} merged. Inspect GitHub before retrying; no merge was retried.`,
    )
  }
  if (readBack.state !== 'MERGED' || readBack.headOid !== entry.pr.headOid) {
    throw new Error(
      `GitHub did not confirm the reviewed head of PR #${entry.pr.number} as merged${mergeError ? `: ${commandDetail(mergeError)}` : ''}`,
    )
  }
  let mergeOid = readBack.mergeOid ?? null
  if (!mergeOid) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      try {
        const refreshed = await getPullRequest(repoPath, entry.pr.number)
        if (refreshed.mergeOid) {
          mergeOid = refreshed.mergeOid
          break
        }
      } catch {
        // Continue retry
      }
    }
  }
  let fetchMessage = ''
  try {
    if ((await getOriginUrl(repoPath)) !== plan.originUrl)
      throw new Error('Origin changed after the merge')
    await runGit(repoPath, [
      'fetch',
      'origin',
      `refs/heads/${plan.defaultBranch}:refs/remotes/origin/${plan.defaultBranch}`,
    ])
  } catch (error) {
    fetchMessage = ` The pull request merged, but refreshing origin/${plan.defaultBranch} failed: ${commandDetail(error)}`
  }
  if (!mergeOid) {
    try {
      const logOutput = await runGit(repoPath, [
        'log',
        '-n',
        '20',
        '--merges',
        '--format=%H %P',
        `refs/remotes/origin/${plan.defaultBranch}`,
      ])
      for (const line of logOutput.split('\n')) {
        const tokens = line.trim().split(/\s+/u)
        if (
          tokens.length >= 3 &&
          (tokens[2] === entry.pr.headOid ||
            (await isAncestor(repoPath, entry.pr.headOid, tokens[2])))
        ) {
          mergeOid = tokens[0]
          break
        }
      }
    } catch {
      // Best effort recovery
    }
  }
  await writeMergedPrRecord(repoPath, {
    branch: entry.branch,
    pr: entry.pr.number,
    headOid: entry.pr.headOid,
    mergeOid,
    mergedAt: Date.now(),
  })
  await setConfig(repoPath, `branch.${entry.branch}.gitStacksMergedHeadPr`, String(entry.pr.number))
  await setConfig(repoPath, `branch.${entry.branch}.gitStacksMergedHeadOid`, entry.pr.headOid)
  if (mergeOid) {
    await setConfig(repoPath, `branch.${entry.branch}.gitStacksMergedCommitOid`, mergeOid)
  }
  return { message: `Merged pull request #${entry.pr.number}.${fetchMessage}` }
}

async function updatePullRequest(
  repoPath: string,
  number: number,
  title: string,
  body: string,
  draft: boolean,
): Promise<ActionResult> {
  const origin = await currentOrigin(repoPath)
  const current = await getPullRequest(repoPath, number)
  if (current.state === 'MERGED') throw new Error(`Pull request #${number} is already merged`)
  await patchPullRequest(origin.fullName, number, { title, body })
  if (current.draft !== draft) await changePullRequestDraft(origin.fullName, number, draft)
  const readBack = await getPullRequest(repoPath, number)
  if (readBack.title !== title || readBack.body !== body || readBack.draft !== draft) {
    throw new Error(`Pull request #${number} did not match the requested update`)
  }
  return { message: `Updated pull request #${number}` }
}

async function changePullRequestState(
  repoPath: string,
  number: number,
  state: 'open' | 'closed',
): Promise<ActionResult> {
  const origin = await currentOrigin(repoPath)
  const current = await getPullRequest(repoPath, number)
  if (state === 'open' && current.state === 'MERGED')
    throw new Error(`Pull request #${number} cannot be reopened after merge`)
  await patchPullRequest(origin.fullName, number, { state })
  const readBack = await getPullRequest(repoPath, number)
  const expected = state === 'open' ? 'OPEN' : 'CLOSED'
  if (readBack.state !== expected)
    throw new Error(`Pull request #${number} did not become ${expected.toLowerCase()}`)
  return { message: `${state === 'open' ? 'Reopened' : 'Closed'} pull request #${number}` }
}

async function setParentAction(
  repoPath: string,
  branch: string,
  parent: string,
): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  await validateBranchName(root, branch)
  await validateBranchName(root, parent)
  await ensureNoBusyOperation(root, 'change a stack parent')
  const refs = await getRefs(root)
  const currentBranch = await getCurrentBranch(root)
  const defaultBranch = await getDefaultBranch(root, refs, currentBranch)
  if (branch === defaultBranch) throw new Error('The default branch cannot have a stack parent')
  const branchTip = await resolveCommit(root, `refs/heads/${branch}`)
  if (!branchTip) throw new Error(`Local branch ${branch} does not exist`)
  const parentRef = await resolveParentRef(root, parent)
  if (parent === branch || parentRef === `refs/heads/${branch}`)
    throw new Error('A branch cannot be its own parent')
  const originUrl = await getOriginUrl(root)
  const originFullName = canonicalRemoteName(originUrl)
  const baseByBranch = new Map<string, string>()
  if (originFullName) {
    const githubData = await getGitHubData(root, originUrl)
    if (githubData.available) {
      githubData.pullRequests.forEach((pr, index) => {
        if (githubData.sameRepository(index) && pr.base && !baseByBranch.has(pr.head)) {
          baseByBranch.set(pr.head, pr.base)
        }
      })
    }
  }
  const names = await localBranchNames(root)
  const parentMap = new Map<string, string>()
  for (const name of names) {
    const configured = await getBranchParent(root, name)
    if (configured) parentMap.set(name, configured)
    else if (name !== defaultBranch) parentMap.set(name, baseByBranch.get(name) ?? defaultBranch)
  }
  parentMap.set(branch, parent)
  let cursor: string | null = branch
  const seen = new Set<string>()
  while (cursor && cursor !== defaultBranch) {
    if (seen.has(cursor)) throw new Error('Changing this parent would create a stack cycle')
    seen.add(cursor)
    const next = parentMap.get(cursor)
    if (!next) throw new Error(`Parent metadata for ${cursor} is missing`)
    if (next !== defaultBranch && !names.includes(next))
      throw new Error(`Parent ${next} does not exist locally`)
    cursor = next
  }
  await ensureNotCheckedOutElsewhere(root, branch)
  const configuredParent = await getBranchParent(root, branch)
  const oldParent = configuredParent ?? baseByBranch.get(branch) ?? defaultBranch
  const configuredBoundary = await getConfigValue(root, `branch.${branch}.parentTip`)
  let boundary: string | null = null
  let source = 'existing parent boundary'
  if (configuredBoundary) {
    const configuredOid = await resolveCommit(root, configuredBoundary)
    if (!configuredOid || !(await isAncestor(root, configuredOid, branchTip))) {
      throw new Error(
        `Recorded parent boundary for ${branch} is invalid; refuse to infer a replacement`,
      )
    }
    boundary = configuredBoundary
  }
  if (!boundary) {
    const oldParentRef = await resolveParentRef(root, oldParent)
    const oldParentTip = await resolveCommit(root, oldParentRef)
    if (!oldParentTip) throw new Error(`Cannot resolve the old parent ${oldParent}`)
    boundary = await actualMergeBase(root, oldParentTip, branchTip)
    source = `merge-base with ${oldParent}`
    if (!boundary)
      throw new Error(`Cannot determine a safe rebase boundary from old parent ${oldParent}`)
  }
  const count = await commitCount(root, boundary, branchTip)
  await setConfig(root, `branch.${branch}.parent`, parent)
  await setConfig(root, `branch.${branch}.parentTip`, boundary)
  return { message: `Adopted ${branch} under ${parent}; preserved ${count} commits from ${source}` }
}

export async function getStackProgress(
  repoPath: string,
  signal?: AbortSignal,
): Promise<StackProgress | null> {
  const root = await repositoryPath(repoPath, signal)
  const journal = await readJournal(root, signal)
  if (signal?.aborted) throw new CommandCancelled()
  if (!journal) return null
  const completed = journal.entries
    .filter((entry) => entry.status === 'completed')
    .map((entry) => entry.branch)
  const remaining = journal.entries
    .filter((entry) => entry.status !== 'completed')
    .map((entry) => entry.branch)
  return {
    kind: 'restack',
    originalBranch: journal.originalBranch ?? '',
    currentBranch: journal.currentBranch,
    completed,
    remaining,
    message: journal.message,
  }
}

export async function runStackAction(
  repoPath: string,
  actionValue: StackAction,
): Promise<ActionResult> {
  const root = await repositoryPath(repoPath)
  const action = validateStackAction(actionValue)
  if (
    action.type !== 'stackContinue' &&
    action.type !== 'stackAbort' &&
    (await readJournal(root))
  ) {
    throw new Error('Finish or abort the current stack operation before starting another action')
  }
  switch (action.type) {
    case 'setParent':
      return setParentAction(root, action.branch, action.parent)
    case 'stackContinue':
      return stackContinue(root)
    case 'stackAbort':
      return stackAbort(root)
    case 'updatePr':
      return updatePullRequest(root, action.number, action.title, action.body, action.draft)
    case 'closePr':
      return changePullRequestState(root, action.number, 'closed')
    case 'reopenPr':
      return changePullRequestState(root, action.number, 'open')
    case 'executeStack': {
      prunePlans()
      const plan = plans.get(action.token)
      if (!plan || plan.expiresAt <= Date.now())
        throw new Error('Stack preview token is missing or expired; refresh the preview')
      if (plan.repoPath !== root) throw new Error('Stack preview belongs to a different repository')
      plans.delete(action.token)
      if (plan.kind === 'restack') return beginRestack(root, plan)
      if (plan.kind === 'publish') return publishStack(root, plan, action)
      return mergeStack(root, plan, action)
    }
  }
}
