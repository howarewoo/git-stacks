import { classifyRemoteMutation, unknownRemoteOutcome } from './remote-mutations'
import { getStackProgress, getSubmitStackProgress, validateStackAction } from './stacks'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { lstatSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import type { InspectionContext } from '@git-stacks/shared/inspection'
import type {
  OperationScope,
  OperationCapture,
  OperationRecord,
} from '@git-stacks/shared/operation-scope'
import { sameOperationScope } from '@git-stacks/shared/operation-scope'
import type { GitAction, ActionResult, MergeLayerResult } from '@git-stacks/shared/types'
import { discoverWorktrees, inspectWorktree } from './worktree-inventory'
import { runGit, tryGit, getOriginUrl, commandEnvironment, MAX_BUFFER } from './git-core'
import { gitCommandEnvironment, resolveGitRuntime } from './git-runtime'
import { readJournal, writeJournal, withJournalLock } from './review-journal'
import { isRecord } from '@git-stacks/shared/guards'
import type { MergeQueueObservation } from './merge-async'
import type { RepositoryInventory } from '@git-stacks/shared/worktree-inventory'
import type { RecentRepository } from '@git-stacks/shared/types'

/**
 * Explicit operation-target authority: an independently nominated path belongs
 * to a repository that is registered and current — the repository root itself
 * or a discovered worktree of it. It never has to be the repository the window
 * shows; anything else still needs the ambient authority.
 */
export function registeredOperationTargetId(
  root: string,
  repositories: readonly RepositoryInventory[],
  recents: readonly RecentRepository[],
): string | null {
  const repository = repositories.find(
    (repo) =>
      repo.registeredPaths.includes(root) || repo.worktrees.some((tree) => tree.path === root),
  )
  if (
    !repository ||
    !repository.registeredPaths.some((path) => recents.some((recent) => recent.path === path))
  )
    return null
  return repository.identity.id
}

const directoryStatOptions = { bigint: true } as const
function directoryIncarnation(value: BigIntStats): string {
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.ino === 0n ||
    value.birthtimeNs === 0n
  )
    throw new Error('Cannot establish the selected directory incarnation.')
  return `${value.dev}:${value.ino}:${value.birthtimeNs}`
}
async function incarnation(path: string): Promise<string> {
  return directoryIncarnation(await lstat(path, directoryStatOptions))
}

export async function validateCapturedDirectory(capture: OperationCapture): Promise<void> {
  const identities = await Promise.all([
    incarnation(capture.worktreePath),
    incarnation(capture.commonDirectory),
    incarnation(capture.gitDirectory),
  ])
  if (
    identities[0] !== capture.directoryIdentity ||
    identities[1] !== capture.commonIdentity ||
    identities[2] !== capture.gitDirectoryIdentity
  )
    throw new Error(
      'The original worktree, common repository or administrative directory was replaced.',
    )
}

function pointerDirectory(value: string, base: string, prefix: string): string {
  const end = value.endsWith('\r\n')
    ? value.length - 2
    : value.endsWith('\n')
      ? value.length - 1
      : value.length
  if (!value.startsWith(prefix) || end <= prefix.length)
    throw new Error('Original Git directory binding cannot be established.')
  return realpathSync(resolve(base, value.slice(prefix.length, end)))
}

function assertGitDirectoryBinding(capture: OperationCapture): void {
  const entry = join(capture.worktreePath, '.git')
  const entryStat = lstatSync(entry, directoryStatOptions)
  if (!entryStat.isDirectory() && !entryStat.isFile())
    throw new Error('Original Git directory binding cannot follow a replacement or symlink.')
  const admin = entryStat.isDirectory()
    ? realpathSync(entry)
    : pointerDirectory(readFileSync(entry, 'utf8'), capture.worktreePath, 'gitdir: ')
  let commonPointer: string | null = null
  try {
    commonPointer = readFileSync(join(admin, 'commondir'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const common = commonPointer === null ? admin : pointerDirectory(commonPointer, admin, '')
  if (
    admin !== realpathSync(capture.gitDirectory) ||
    common !== realpathSync(capture.commonDirectory)
  )
    throw new Error('The original worktree administrative/common binding was replaced.')
}

/** Preserve effective Git config across the last private-provider await. */
export function createOperationProviderValidator(
  root: string,
  validatePrivateProvider: (origin: string | null) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const runtime = await resolveGitRuntime()
    const args = ['config', '--null', '--show-origin', '--show-scope', '--list']
    const originalConfig = await runGit(root, args)
    const origin = await getOriginUrl(root)
    await validatePrivateProvider(origin)
    // Use Git itself, including includes, conditional/worktree config and URL
    // rewrites, rather than parsing only .git/config. No application await follows
    // this read before the factory's synchronous physical/binding fence.
    const currentConfig = execFileSync(runtime.executable, args, {
      cwd: root,
      env: gitCommandEnvironment(runtime, commandEnvironment()),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: MAX_BUFFER,
    })
    if (currentConfig !== originalConfig)
      throw new Error(
        'Effective Git origin/config changed during private provider validation; no further step is authorized.',
      )
  }
}

/** Combined production validator, after evolved target preflight at actual dispatch. */
export function createOperationEffectValidator(
  capture: OperationCapture,
  scope: OperationScope,
  validateProvider: () => Promise<void>,
): () => Promise<void> {
  let admitted = false
  return async () => {
    // Only the first effect compares the original HEAD/index/ref fingerprint.
    // Later owned steps retain their engine's evolved checkpoints.
    if (!admitted) await revalidateOperation(capture, scope)
    const fresh = await discoverWorktrees(capture.worktreePath)
    if (
      fresh.identity.id !== capture.repositoryId ||
      !fresh.worktrees.some(
        (tree) =>
          tree.id === capture.worktreeId && tree.path === capture.worktreePath && !tree.missing,
      )
    )
      throw new Error('The original execution worktree authority was retired.')
    // Actual origin/private credentials are read only after all ordinary
    // capture/discovery/target preflight awaits. Final Git binding and physical
    // checks are synchronous: no further application await can retire the
    // owner between provider validation and this dispatch boundary.
    await validateProvider()
    assertGitDirectoryBinding(capture)
    if (
      directoryIncarnation(lstatSync(capture.worktreePath, directoryStatOptions)) !==
        capture.directoryIdentity ||
      directoryIncarnation(lstatSync(capture.commonDirectory, directoryStatOptions)) !==
        capture.commonIdentity ||
      directoryIncarnation(lstatSync(capture.gitDirectory, directoryStatOptions)) !==
        capture.gitDirectoryIdentity
    )
      throw new Error(
        'The original worktree, common repository or administrative directory was replaced.',
      )
    admitted = true
  }
}

/** Inspection cannot mint mutation authority. Capture includes the entire local dependency/ref domain. */
export async function captureOperation(
  root: string,
  context: InspectionContext,
  scope: OperationScope,
): Promise<OperationCapture> {
  if (!context.worktreeId) throw new Error('Select an explicit existing execution worktree.')
  const repository = await discoverWorktrees(root)
  if (
    repository.identity.id !== context.repositoryId ||
    repository.discovery.state !== 'complete' ||
    repository.refsRead.state !== 'complete'
  )
    throw new Error('The complete common repository and ref scope could not be established.')
  const discovered = repository.worktrees.find((tree) => tree.id === context.worktreeId)
  if (!discovered || discovered.path !== root || discovered.missing || discovered.kind === 'bare')
    throw new Error('The selected worktree authority is unavailable.')
  if (context.refId && !repository.refs.some((ref) => ref.id === context.refId))
    throw new Error('The captured qualified target ref is unavailable.')
  const tree = await inspectWorktree(discovered)
  if (tree.read.state !== 'complete')
    throw new Error(tree.read.error ?? 'Worktree safety facts are incomplete.')
  const index = await readFile(join(tree.gitDirectory!, 'index')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0)
      throw error
    },
  )
  const pseudoRef =
    tree.operation === 'rebase'
      ? 'REBASE_HEAD'
      : tree.operation === 'cherryPick'
        ? 'CHERRY_PICK_HEAD'
        : tree.operation === 'revert'
          ? 'REVERT_HEAD'
          : null
  const operationCommitOid = pseudoRef
    ? ((await tryGit(root, ['rev-parse', '--verify', `${pseudoRef}^{commit}`]))?.trim() ?? null)
    : null
  const [
    status,
    config,
    diff,
    directoryIdentity,
    commonIdentity,
    adminIdentity,
    stack,
    publication,
  ] = await Promise.all([
    runGit(root, [
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]),
    runGit(root, ['config', '--local', '--null', '--list']),
    runGit(root, ['--no-optional-locks', 'diff', '--binary', '--no-ext-diff', '--no-textconv']),
    incarnation(root),
    incarnation(repository.identity.commonDirectory),
    incarnation(tree.gitDirectory!),
    getStackProgress(root),
    getSubmitStackProgress(root),
  ])
  const refs = repository.refs.map((ref) => ({ id: ref.id, ref: ref.name, oid: ref.oid }))
  const worktrees = await Promise.all(
    repository.worktrees.map(async (item) => ({
      id: item.id,
      path: item.path,
      refId: item.refId,
      headOid: item.headOid,
      missing: item.missing,
      locked: item.locked,
      directoryIdentity: item.missing ? null : await incarnation(item.path),
      adminIdentity: item.gitDirectory ? await incarnation(item.gitDirectory) : null,
    })),
  )
  const fingerprint = createHash('sha256')
    .update(index)
    .update(status)
    .update(config)
    .update(diff)
    .update(
      JSON.stringify({
        directoryIdentity,
        commonIdentity,
        adminIdentity,
        tree: {
          id: tree.id,
          path: tree.path,
          gitDirectory: tree.gitDirectory,
          head: tree.headOid,
          ref: tree.refId,
          locked: tree.locked,
          operation: tree.operation,
        },
        refs,
        worktrees,
        // Display text can change when the engine journals its next owned step.
        stack: stack ? { ...stack, message: undefined } : null,
        publication,
        operationCommitOid,
      }),
    )
    .digest('hex')
  return {
    token: randomUUID(),
    context: { ...context },
    scope,
    commonDirectory: repository.identity.commonDirectory,
    directoryIdentity,
    commonIdentity,
    gitDirectory: tree.gitDirectory!,
    gitDirectoryIdentity: adminIdentity,
    repositoryId: repository.identity.id,
    worktreePath: root,
    worktreeId: tree.id,
    headOid: tree.headOid,
    operationCommitOid,
    fingerprint,
    refs,
    capturedAt: new Date().toISOString(),
    coordination:
      'Coordinate external tools before executing. App locks serialize participating operations only; cleanliness and Git administrative locks do not prove external inactivity.',
  }
}

export async function revalidateOperation(
  capture: OperationCapture,
  scope: OperationScope,
): Promise<void> {
  const current = await captureOperation(capture.worktreePath, capture.context, scope)
  if (
    current.fingerprint !== capture.fingerprint ||
    current.scope.remoteUrl !== capture.scope.remoteUrl ||
    current.scope.authority !== capture.scope.authority
  )
    throw new Error(
      'Captured directory, HEAD, index, status, refs, dependency metadata, worktree ownership or provider authority changed. Review a new preview; nothing was executed.',
    )
}

/** A replaced common directory cannot inherit the lock file or its original approval. */
export async function withCapturedOperationLock<T>(
  capture: OperationCapture,
  run: () => Promise<T>,
): Promise<T> {
  if ((await incarnation(capture.commonDirectory)) !== capture.commonIdentity)
    throw new Error('The captured common repository directory was replaced; nothing was executed.')
  return withJournalLock(
    join(capture.commonDirectory, 'git-stacks-operation-authority'),
    async () => {
      if ((await incarnation(capture.commonDirectory)) !== capture.commonIdentity)
        throw new Error(
          'The captured common repository directory was replaced while acquiring authority.',
        )
      return run()
    },
  )
}

async function saveRecord(capture: OperationCapture, record: OperationRecord): Promise<void> {
  await writeJournal(
    join(capture.commonDirectory, 'git-stacks-operations', `${record.id}.json`),
    'records',
    [record],
  )
}
const operationRecord = new AsyncLocalStorage<{
  capture: OperationCapture
  record: OperationRecord
}>()

/** Persist partial effects before and after a non-atomic lifecycle step. */
export async function recordOperationResult(result: ActionResult): Promise<void> {
  const owner = operationRecord.getStore()
  if (!owner) return
  owner.record.result = structuredClone(result)
  owner.record.updatedAt = new Date().toISOString()
  await saveRecord(owner.capture, owner.record)
}

export async function recordOperationPreview(
  preview: NonNullable<OperationRecord['preview']>,
): Promise<void> {
  const owner = operationRecord.getStore()
  if (!owner) return
  owner.record.preview = structuredClone(preview)
  await saveRecord(owner.capture, owner.record)
}

/** Records an actual mutation boundary, not an inspection or a claim of provider exclusivity. */
export async function recordOperationRemoteDispatch(
  disposition: 'intent' | 'rejected',
): Promise<void> {
  const owner = operationRecord.getStore()
  if (!owner) return
  owner.record.remoteDispatch = disposition
  owner.record.updatedAt = new Date().toISOString()
  await saveRecord(owner.capture, owner.record)
}

/** Save the journal identity before effects; progress never reuses a path-only approval. */
export async function recordOperationRecovery(
  kind: 'stack' | 'publication',
  id: string,
): Promise<void> {
  const owner = operationRecord.getStore()
  if (!owner) return
  if (owner.record.recovery) {
    if (owner.record.recovery.kind !== kind || owner.record.recovery.id !== id)
      throw new Error('An operation cannot acquire a different recovery journal.')
    return
  }
  owner.record.recovery = { kind, id }
  await saveRecord(owner.capture, owner.record)
}

const activeRecords = new Set<string>()
export async function runRecordedOperation(
  capture: OperationCapture,
  action: GitAction,
  run: () => Promise<ActionResult>,
): Promise<ActionResult> {
  const record: OperationRecord = {
    id: randomUUID(),
    repositoryId: capture.repositoryId,
    context: capture.context,
    scope: capture.scope,
    capture: structuredClone(capture),
    worktreePath: capture.worktreePath,
    action: structuredClone(action),
    state: 'active',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: `Running ${action.type}`,
    result: null,
  }
  await saveRecord(capture, record)
  activeRecords.add(record.id)
  try {
    const result = await operationRecord.run({ capture, record }, run)
    record.result = result
    const stack = await getStackProgress(capture.worktreePath)
    record.state =
      record.recovery?.kind === 'stack' && stack?.operationId === record.recovery.id
        ? 'paused'
        : result.worktreeLifecycle?.targets.some((target) => target.state === 'unconfirmed')
          ? 'unconfirmed'
          : result.worktreeLifecycle?.targets.some((target) => target.state === 'failed')
            ? 'failed'
            : result.merge?.layers.some((layer) =>
                  ['pending', 'enqueued', 'unconfirmed'].includes(layer.status),
                )
              ? 'unconfirmed'
              : result.merge?.layers.some((layer) => layer.status === 'failed')
                ? 'failed'
                : 'completed'
    record.message = result.message
    return result
  } catch (error) {
    const progress = await getStackProgress(capture.worktreePath).catch(() => null)
    record.state =
      record.recovery?.kind === 'stack' && progress?.operationId === record.recovery.id
        ? 'paused'
        : record.remoteDispatch === 'intent' ||
            (classifyRemoteMutation(action) && unknownRemoteOutcome(error))
          ? 'unconfirmed'
          : 'failed'
    record.message = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    record.updatedAt = new Date().toISOString()
    try {
      await saveRecord(capture, record)
    } finally {
      activeRecords.delete(record.id)
    }
  }
}

/** Exclude only this request and independently validated terminal recovery projections. */
export async function unresolvedOperationRecords(root: string): Promise<OperationRecord[]> {
  const own = operationRecord.getStore()?.record.id
  return (await readOperationRecords(root)).filter(
    (record) =>
      record.id !== own &&
      ['active', 'paused', 'unconfirmed'].includes(record.state) &&
      (!record.resolution ||
        Boolean(record.stackProgress) ||
        Boolean(record.publication && record.publication.status !== 'completed')),
  )
}

/** Retain source-confirmed outcomes separately from the immutable approval and result. */
export async function confirmRecordedMerge(
  root: string,
  observation: MergeQueueObservation,
  layer: MergeLayerResult,
): Promise<void> {
  const request = observation.request
  if (!['merged', 'failed', 'not-merged'].includes(layer.status) || !request) return
  if (layer.status === 'not-merged' && observation.outcome !== 'enqueued') return
  const origin = await getOriginUrl(root)
  const repository = await discoverWorktrees(root)
  const commonIdentity = await incarnation(repository.identity.commonDirectory)
  for (const record of await readOperationRecords(root)) {
    if (
      activeRecords.has(record.id) ||
      record.scope.remoteUrl !== origin ||
      record.capture.commonIdentity !== commonIdentity ||
      !record.preview ||
      !('merge' in record.preview) ||
      !record.preview.merge?.layers.some(
        (entry) =>
          entry.pullRequest === observation.pullRequest &&
          entry.headOid === observation.headOid &&
          entry.base === observation.base,
      ) ||
      !record.result?.merge?.layers.some(
        (entry) =>
          entry.pullRequest === observation.pullRequest && entry.requestUuid === request.uuid,
      )
    )
      continue
    record.mergeConfirmations = {
      ...record.mergeConfirmations,
      [observation.pullRequest]: structuredClone(layer),
    }
    await saveRecord(record.capture, record)
  }
}
/** No replay, repair, journal retirement or account substitution on a status read. */
export async function readOperationRecords(root: string): Promise<OperationRecord[]> {
  const repository = await discoverWorktrees(root)
  const directory = join(repository.identity.commonDirectory, 'git-stacks-operations')
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const records: OperationRecord[] = []
  const commonIdentity = await incarnation(repository.identity.commonDirectory)
  const progressByOwner = new Map<
    string,
    Promise<{
      directoryIdentity: string
      gitDirectoryIdentity: string
      stack: OperationRecord['stackProgress']
      publication: OperationRecord['publication']
    } | null>
  >()
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue
    const [value] = await readJournal<OperationRecord>(
      join(directory, name),
      'records',
      (entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== 'string' ||
          typeof entry.repositoryId !== 'string' ||
          typeof entry.worktreePath !== 'string' ||
          !isRecord(entry.context) ||
          !isRecord(entry.scope) ||
          !isRecord(entry.capture) ||
          !isRecord(entry.action) ||
          typeof entry.startedAt !== 'string' ||
          typeof entry.message !== 'string' ||
          !['active', 'paused', 'failed', 'unconfirmed', 'completed'].includes(String(entry.state))
        )
          return null
        const capture = entry.capture
        if (
          [
            'token',
            'repositoryId',
            'worktreeId',
            'worktreePath',
            'directoryIdentity',
            'commonDirectory',
            'commonIdentity',
            'gitDirectory',
            'gitDirectoryIdentity',
            'fingerprint',
            'capturedAt',
          ].some((key) => typeof capture[key] !== 'string' || !capture[key]) ||
          capture.repositoryId !== entry.repositoryId ||
          capture.worktreePath !== entry.worktreePath ||
          capture.worktreeId !== entry.context.worktreeId ||
          !isRecord(capture.context) ||
          !isRecord(capture.scope) ||
          !Array.isArray(capture.refs)
        )
          return null
        return entry as unknown as OperationRecord
      },
      { strict: true },
    )
    if (!value) throw new Error('The operation journal has no readable original authority.')
    if (value.repositoryId !== repository.identity.id) continue
    if (value.mergeConfirmations && value.result?.merge) {
      const layers = value.result.merge.layers.map(
        (layer) => value.mergeConfirmations?.[layer.pullRequest] ?? layer,
      )
      if (layers.every((layer) => !['pending', 'enqueued', 'unconfirmed'].includes(layer.status))) {
        value.state = layers.some((layer) => layer.status === 'failed') ? 'failed' : 'completed'
      }
    }
    const owner = repository.worktrees.find(
      (tree) =>
        tree.id === value.context?.worktreeId && tree.path === value.worktreePath && !tree.missing,
    )
    value.stackProgress = null
    value.publication = null
    // Resolution is derived from later confirmed original-authority recovery,
    // never trusted from persisted display/status fields.
    delete value.resolution
    if (
      owner?.gitDirectory &&
      value.recovery &&
      value.capture.commonIdentity === commonIdentity &&
      value.capture.gitDirectory === owner.gitDirectory
    ) {
      let progress = progressByOwner.get(owner.id)
      if (!progress) {
        const gitDirectory = owner.gitDirectory
        progress = Promise.all([
          incarnation(owner.path),
          incarnation(gitDirectory),
          getStackProgress(owner.path),
          getSubmitStackProgress(owner.path),
        ])
          .then(([directoryIdentity, gitDirectoryIdentity, stack, publication]) => ({
            directoryIdentity,
            gitDirectoryIdentity,
            stack,
            publication,
          }))
          .catch(() => null)
        progressByOwner.set(owner.id, progress)
      }
      const observed = await progress
      if (
        observed &&
        observed.directoryIdentity === value.capture.directoryIdentity &&
        observed.gitDirectoryIdentity === value.capture.gitDirectoryIdentity
      ) {
        value.stackProgress =
          value.recovery.kind === 'stack' && observed.stack?.operationId === value.recovery.id
            ? observed.stack
            : null
        value.publication =
          value.recovery.kind === 'publication' &&
          observed.publication?.operationId === value.recovery.id
            ? observed.publication
            : null
      }
    }
    records.push(
      value.state === 'active' && !activeRecords.has(value.id)
        ? {
            ...value,
            state: 'unconfirmed',
            message: `${value.message}. The process ended before confirming the outcome; inspect actual effects and use explicit supported recovery, never replay automatically.`,
          }
        : value,
    )
  }
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const terminal = new Map<string, OperationRecord>()
  for (const record of records) {
    if (
      record.state !== 'completed' ||
      !record.recovery ||
      ![
        'stackContinue',
        'operationSkip',
        'stackAbort',
        'submitStackRetry',
        'submitStackDismiss',
      ].includes(record.action.type)
    )
      continue
    const key = `${record.recovery.kind}:${record.recovery.id}`
    if (!terminal.has(key)) terminal.set(key, record)
  }
  for (const record of records) {
    if (
      !record.recovery ||
      record.state === 'completed' ||
      record.stackProgress ||
      (record.publication && record.publication.status !== 'completed')
    )
      continue
    const resolved = terminal.get(`${record.recovery.kind}:${record.recovery.id}`)
    if (
      !resolved ||
      resolved.startedAt <= record.startedAt ||
      !sameOperationScope(resolved.scope, record.scope) ||
      resolved.capture.directoryIdentity !== record.capture.directoryIdentity ||
      resolved.capture.commonIdentity !== record.capture.commonIdentity ||
      resolved.capture.gitDirectoryIdentity !== record.capture.gitDirectoryIdentity
    )
      continue
    record.resolution =
      resolved.action.type === 'stackAbort'
        ? 'aborted'
        : resolved.action.type === 'submitStackDismiss'
          ? 'dismissed'
          : 'completed'
  }
  return records
}

/** Current facts may evolve through recovery, but original physical/provider authority cannot. */
export async function validateRecordedRecovery(
  capture: OperationCapture,
  action: GitAction,
): Promise<void> {
  const publicationAction =
    action.type === 'submitStackRetry' || action.type === 'submitStackDismiss'
  const stackAction = ['stackContinue', 'stackAbort', 'operationSkip'].includes(action.type)
  if (!publicationAction && !stackAction) return
  const stack = publicationAction ? null : await getStackProgress(capture.worktreePath)
  if (action.type === 'operationSkip' && !stack) return
  const publication = publicationAction ? await getSubmitStackProgress(capture.worktreePath) : null
  const kind = publicationAction ? 'publication' : 'stack'
  const id = publication?.operationId ?? stack?.operationId
  if (!id) throw new Error('No original recovery journal is available; nothing was executed.')
  const original = (await readOperationRecords(capture.worktreePath)).find(
    (record) =>
      record.recovery?.kind === kind &&
      record.recovery.id === id &&
      ['executeStack', 'executeSurgery', 'submitStack'].includes(record.action.type) &&
      record.repositoryId === capture.repositoryId &&
      record.capture.worktreeId === capture.worktreeId &&
      record.capture.directoryIdentity === capture.directoryIdentity &&
      record.capture.commonIdentity === capture.commonIdentity &&
      record.capture.gitDirectory === capture.gitDirectory &&
      record.capture.gitDirectoryIdentity === capture.gitDirectoryIdentity &&
      sameOperationScope(record.scope, capture.scope),
  )
  if (!original)
    throw new Error(
      'Original physical worktree or provider authority is unavailable. Recovery cannot borrow another path, account or journal.',
    )
  const consent = publication?.allowForce ?? stack?.allowForce
  if (
    consent !== null &&
    consent !== undefined &&
    (!('allowForce' in original.action) || original.action.allowForce !== consent)
  )
    throw new Error('The saved force consent differs from the immutable original approval.')
  if (publication) {
    const approved = validateStackAction(original.action)
    if (
      approved.type !== 'submitStack' ||
      !original.preview ||
      !('publish' in original.preview) ||
      !original.preview.publish
    )
      throw new Error('The original publication choices are unavailable.')
    const layers = original.preview.publish.layers.map((layer) => ({
      ...layer,
      ...approved.layers[layer.branch],
    }))
    if (
      publication.layers.length !== layers.length ||
      publication.layers.some((layer, index) => {
        const expected = layers[index]
        return (
          !expected ||
          ['branch', 'base', 'title', 'body', 'draft', 'updateBase'].some(
            (key) => layer[key as keyof typeof layer] !== expected[key as keyof typeof expected],
          )
        )
      })
    )
      throw new Error('Publication recovery differs from the immutable original layer choices.')
  }
  if (stack?.surgery) {
    const closes = stack.surgery.pullRequests.filter((step) => step.action === 'close')
    if (
      closes.length &&
      (original.action.type !== 'executeSurgery' ||
        !original.action.closePullRequests ||
        !original.preview ||
        !('closes' in original.preview) ||
        closes.some(
          (step) =>
            !original.preview ||
            !('closes' in original.preview) ||
            !original.preview.closes.includes(step.number),
        ))
    )
      throw new Error(
        'The recovery journal contains a close outside the immutable original consent.',
      )
  }
}
