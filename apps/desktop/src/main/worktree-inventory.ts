import { createHash } from 'node:crypto'
import { realpath, stat, readFile, readdir } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import type {
  InventoryId,
  InventoryRequest,
  InventoryWorktree,
  RepositoryInventory,
  WorktreeInventory,
  InventoryRead,
  InventoryRef,
} from '@git-stacks/shared/worktree-inventory'
import type { RepositorySnapshot } from '@git-stacks/shared/types'
import {
  WORKTREE_READ_CONCURRENCY,
  WORKTREE_REFRESH_SETTLE_MS,
  MAX_COMMAND_BYTES,
  MAX_STATUS_BYTES,
} from '@git-stacks/shared/performance'
import {
  CommandCancelled,
  isCancelled,
  isExitCode,
  runGit,
  runGitCapped,
  parseStatus,
  parseRefRecords,
  parseTrack,
  parseRemote,
  mapWithConcurrency,
  getOperationState,
} from './git-core'
import { RepositoryScheduler } from './repository-scheduler'
import { RepositoryWatcher, type RepositoryWatcherOptions } from './git-watcher'
import { resolveGitRuntime, withGitRuntime } from './git-runtime'

// Remove one protocol terminator, not newline characters belonging to the path.
const GIT_PATH_TERMINATOR = process.platform === 'win32' ? /\r?\n$/ : /\n$/
const WORKTREE_STATE_PATHS = [
  'HEAD',
  'index',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'BISECT_LOG',
]

export function inventoryId(...parts: string[]): InventoryId {
  return JSON.stringify(parts)
}

interface ListedWorktree {
  path: string
  headOid: string | null
  ref: string | null
  bare: boolean
  detached: boolean
  locked: string | null
  prunable: string | null
}

/** -z disables Git's quoting, including paths containing literal newlines. */
export function parseWorktreeList(text: string, truncated = false): ListedWorktree[] {
  const result: ListedWorktree[] = []
  const records = text.split('\0\0')
  const unfinished = records.pop()
  if (unfinished && !truncated) throw new Error('Incomplete worktree listing')
  for (const record of records) {
    const fields = record.split('\0')
    const first = fields.shift()
    if (!first?.startsWith('worktree ') || !first.slice(9))
      throw new Error('Worktree path is missing')
    const entry: ListedWorktree = {
      path: first.slice(9),
      headOid: null,
      ref: null,
      bare: false,
      detached: false,
      locked: null,
      prunable: null,
    }
    for (const field of fields) {
      if (field.startsWith('HEAD '))
        entry.headOid = /^0+$/.test(field.slice(5)) ? null : field.slice(5)
      else if (field.startsWith('branch ')) entry.ref = field.slice(7)
      else if (field === 'detached') entry.detached = true
      else if (field === 'bare') entry.bare = true
      else if (field === 'locked' || field.startsWith('locked '))
        entry.locked = field.slice(7) || 'Administrative lock'
      else if (field === 'prunable' || field.startsWith('prunable '))
        entry.prunable = field.slice(9) || 'Prunable directory'
      else if (field.startsWith('worktree ')) throw new Error('Malformed worktree listing')
    }
    result.push(entry)
  }
  return result
}

const pendingRead = (): InventoryRead => ({
  state: 'failed',
  observedAt: null,
  error: 'Not inspected yet',
})
const observed = (partial = false): InventoryRead => ({
  state: partial ? 'partial' : 'complete',
  observedAt: new Date().toISOString(),
  error: partial ? 'Read exceeded the output limit' : null,
})
const failure = (error: unknown): InventoryRead => ({
  state: 'failed',
  observedAt: null,
  error: error instanceof Error ? error.message : 'Local Git read failed',
})

async function directoryId(directory: string): Promise<string> {
  const metadata = await stat(directory, { bigint: true })
  if (!metadata.isDirectory()) throw new Error('Git directory is not a directory')
  if (metadata.ino === 0n || metadata.birthtimeNs === 0n)
    throw new Error('Filesystem cannot qualify the Git directory incarnation')
  // Birth time identifies the inode incarnation, not external-tool activity or safety.
  return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`
}
async function signature(file: string): Promise<string | null> {
  try {
    const value = await stat(file, { bigint: true })
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
/** Local facts only. It never calls a provider, fetches, locks or changes an index. */
export async function discoverWorktrees(
  root: string,
  signal?: AbortSignal,
): Promise<RepositoryInventory> {
  const commonDirectory = await realpath(
    (
      await runGit(
        root,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        undefined,
        signal,
      )
    ).replace(GIT_PATH_TERMINATOR, ''),
  )
  const id = inventoryId('local', await directoryId(commonDirectory))
  const listing = await runGitCapped(root, ['worktree', 'list', '--porcelain', '-z'], {
    maxBytes: MAX_COMMAND_BYTES,
    boundary: '\0\0',
    signal,
  })
  const listed = parseWorktreeList(listing.text, listing.truncated)
  // Missing linked directories still have an administrative identity in common/worktrees.
  const administrativePaths = new Map<string, string>()
  try {
    for (const name of await readdir(join(commonDirectory, 'worktrees'))) {
      const directory = join(commonDirectory, 'worktrees', name)
      const gitFile = (await readFile(join(directory, 'gitdir'), 'utf8')).replace(
        GIT_PATH_TERMINATOR,
        '',
      )
      const worktreePath = resolve(gitFile, '..')
      if (administrativePaths.has(worktreePath))
        throw new Error('Git reported ambiguous linked administrative paths')
      administrativePaths.set(worktreePath, directory)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const worktrees: InventoryWorktree[] = []
  for (const item of listed) {
    if (signal?.aborted) throw new CommandCancelled()
    const path = resolve(item.path)
    const gitDirectory =
      administrativePaths.get(path) ?? (item === listed[0] ? commonDirectory : null)
    if (!gitDirectory) throw new Error('Git did not qualify a linked administrative directory')
    const missing = await stat(path).then(
      (value) => !value.isDirectory(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return true
        throw error
      },
    )
    worktrees.push({
      id: inventoryId(id, 'worktree', await directoryId(gitDirectory)),
      repositoryId: id,
      path,
      gitDirectory,
      kind: item.bare ? 'bare' : gitDirectory === commonDirectory ? 'primary' : 'linked',
      headOid: item.headOid,
      refId: item.detached || item.bare || !item.ref ? null : inventoryId(id, 'ref', item.ref),
      detached: item.detached,
      missing,
      prunable: item.prunable,
      locked: item.locked,
      status: 'unknown',
      counts: null,
      operation: null,
      indexSignature: null,
      read: pendingRead(),
    })
  }
  const remoteConfig = await runGit(
    root,
    ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'],
    undefined,
    signal,
  ).catch((error) => {
    if (isExitCode(error, 1)) return ''
    throw error
  })
  const remotes = remoteConfig
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('\n')
      const name = entry.slice(7, separator - 4)
      const remote = parseRemote(entry.slice(separator + 1))
      return {
        name,
        identity: remote
          ? {
              id: inventoryId('remote', remote.host.toLowerCase(), remote.fullName.toLowerCase()),
              host: remote.host,
              fullName: remote.fullName,
            }
          : null,
      }
    })
  remotes.sort((a, b) => b.name.length - a.name.length)
  let refs: InventoryRef[] = []
  let refsRead: InventoryRead
  try {
    const result = await runGitCapped(
      root,
      [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)%00%(subject)%00%(committerdate:iso-strict)%00%(symref)%00',
        'refs/heads',
        'refs/remotes',
      ],
      { maxBytes: MAX_COMMAND_BYTES, boundary: '\n', signal },
    )
    refs = parseRefRecords(result.text)
      .filter((ref) => !ref.symref)
      .map((ref) => ({
        id: inventoryId(id, 'ref', ref.refname),
        repositoryId: id,
        name: ref.refname,
        kind: ref.refname.startsWith('refs/heads/') ? 'local' : 'remote',
        oid: ref.objectName,
        remoteName:
          remotes.find((remote) => ref.refname.startsWith(`refs/remotes/${remote.name}/`))?.name ??
          null,
        remoteId:
          remotes.find((remote) => ref.refname.startsWith(`refs/remotes/${remote.name}/`))?.identity
            ?.id ?? null,
        upstream: ref.upstream ? inventoryId(id, 'ref', ref.upstream) : null,
        ahead: ref.upstream && !ref.track.includes('gone') ? parseTrack(ref.track).ahead : null,
        behind: ref.upstream && !ref.track.includes('gone') ? parseTrack(ref.track).behind : null,
        worktreeIds: worktrees
          .filter((worktree) => worktree.refId === inventoryId(id, 'ref', ref.refname))
          .map((worktree) => worktree.id),
        pullRequestIds: [],
      }))
    refsRead = observed(result.truncated)
  } catch (error) {
    if (isCancelled(error)) throw error
    refsRead = failure(error)
  }
  return {
    identity: { id, commonDirectory },
    registeredPaths: [root],
    remote: remotes.find((remote) => remote.name === 'origin')?.identity ?? null,
    remotes,
    discovery: observed(listing.truncated),
    refsRead,
    refs,
    worktrees,
    pullRequests: [],
    remoteFreshness: null,
  }
}

export async function inspectWorktree(
  worktree: InventoryWorktree,
  signal?: AbortSignal,
  maxStatusBytes = MAX_STATUS_BYTES,
): Promise<InventoryWorktree> {
  if (worktree.missing || worktree.kind === 'bare' || !worktree.gitDirectory)
    return {
      ...worktree,
      read: {
        ...pendingRead(),
        error: worktree.missing
          ? 'Worktree directory is missing'
          : 'Bare repository has no working tree',
      },
    }
  try {
    const identity = await directoryId(worktree.gitDirectory)
    if (inventoryId(worktree.repositoryId, 'worktree', identity) !== worktree.id)
      throw new Error('Worktree authority was replaced')
    const actualDirectory = await realpath(
      (
        await runGit(
          worktree.path,
          ['rev-parse', '--path-format=absolute', '--git-dir'],
          undefined,
          signal,
        )
      ).replace(GIT_PATH_TERMINATOR, ''),
    )
    if (actualDirectory !== worktree.gitDirectory)
      throw new Error('Worktree path now belongs to another authority')
    const headFileBefore = await readFile(join(actualDirectory, 'HEAD'), 'utf8')
    const observedRef = headFileBefore.startsWith('ref: ')
      ? inventoryId(
          worktree.repositoryId,
          'ref',
          headFileBefore.slice(5).replace(GIT_PATH_TERMINATOR, ''),
        )
      : null
    if (observedRef !== worktree.refId) throw new Error('Worktree branch changed after discovery')
    const before = await runGit(
      worktree.path,
      ['rev-parse', '--verify', 'HEAD'],
      undefined,
      signal,
    ).catch((error) => {
      if (isCancelled(error)) throw error
      return null
    })
    const indexBefore = await signature(join(worktree.gitDirectory, 'index'))
    const result = await runGitCapped(
      worktree.path,
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { maxBytes: Math.min(MAX_STATUS_BYTES, maxStatusBytes), boundary: '\0', signal },
    )
    const files = parseStatus(result.text, result.truncated)
    const headOid = await runGit(
      worktree.path,
      ['rev-parse', '--verify', 'HEAD'],
      undefined,
      signal,
    ).catch((error) => {
      if (isCancelled(error)) throw error
      return null
    })
    const operation = (await getOperationState(worktree.path, signal, worktree.gitDirectory))
      .operation
    const directoryAfter = await realpath(
      (
        await runGit(
          worktree.path,
          ['rev-parse', '--path-format=absolute', '--git-dir'],
          undefined,
          signal,
        )
      ).replace(GIT_PATH_TERMINATOR, ''),
    )
    const commonAfter = await realpath(
      (
        await runGit(
          worktree.path,
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          undefined,
          signal,
        )
      ).replace(GIT_PATH_TERMINATOR, ''),
    )
    if (
      directoryAfter !== actualDirectory ||
      inventoryId('local', await directoryId(commonAfter)) !== worktree.repositoryId
    )
      throw new Error('Worktree path or repository authority changed during inspection')
    const headFileAfter = await readFile(join(actualDirectory, 'HEAD'), 'utf8')
    if (
      headFileBefore !== headFileAfter ||
      (before?.trimEnd() ?? null) !==
        (worktree.headOid && !/^0+$/.test(worktree.headOid) ? worktree.headOid : null)
    )
      throw new Error('Worktree ref changed during discovery or inspection')
    const indexSignature = await signature(join(worktree.gitDirectory, 'index'))
    if (
      before !== headOid ||
      indexBefore !== indexSignature ||
      identity !== (await directoryId(worktree.gitDirectory))
    )
      throw new Error('HEAD or index changed during inspection')
    const counts = { staged: 0, unstaged: 0, untracked: 0, renamed: 0, conflicted: 0 }
    for (const file of files) {
      if (file.index === '?') counts.untracked++
      else {
        if (file.index !== ' ' && file.index !== '!') counts.staged++
        if (file.worktree !== ' ' && file.worktree !== '!') counts.unstaged++
      }
      if (file.index === 'R' || file.worktree === 'R') counts.renamed++
      if (file.conflicted) counts.conflicted++
    }
    return {
      ...worktree,
      headOid: headOid?.trimEnd() ?? null,
      counts,
      indexSignature,
      operation,
      status: result.truncated
        ? 'unknown'
        : counts.conflicted
          ? 'conflicted'
          : files.length
            ? 'dirty'
            : 'clean',
      read: observed(result.truncated),
    }
  } catch (error) {
    if (isCancelled(error)) throw error
    return {
      ...worktree,
      status: 'unknown',
      counts: null,
      indexSignature: null,
      operation: null,
      read: failure(error),
    }
  }
}

/** Revalidate a captured selection before app registration; no repository writes. */
export async function adoptionPaths(
  inventory: WorktreeInventory,
  requestedIds: InventoryId[],
  scheduler: RepositoryScheduler,
  signal?: AbortSignal,
): Promise<string[]> {
  const requested = new Set(requestedIds)
  const paths: string[] = []
  for (const repository of inventory.repositories) {
    if (!repository.worktrees.some((tree) => requested.has(tree.id))) continue
    const discovered = await scheduler.read(
      repository.registeredPaths[0],
      (signal) => discoverWorktrees(repository.registeredPaths[0], signal),
      signal,
    )
    if (discovered.identity.id !== repository.identity.id)
      throw new Error('Repository authority changed; discover again.')
    for (const tree of discovered.worktrees) {
      const captured = repository.worktrees.find((candidate) => candidate.id === tree.id)
      if (
        requested.has(tree.id) &&
        captured?.path === tree.path &&
        !tree.missing &&
        tree.kind !== 'bare'
      ) {
        const [actualDirectory, actualCommon] = await scheduler.read(
          repository.registeredPaths[0],
          async (signal) =>
            [
              await realpath(
                (
                  await runGit(
                    tree.path,
                    ['rev-parse', '--path-format=absolute', '--git-dir'],
                    undefined,
                    signal,
                  )
                ).replace(GIT_PATH_TERMINATOR, ''),
              ),
              await realpath(
                (
                  await runGit(
                    tree.path,
                    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
                    undefined,
                    signal,
                  )
                ).replace(GIT_PATH_TERMINATOR, ''),
              ),
            ] as const,
          signal,
        )
        if (
          actualDirectory !== tree.gitDirectory ||
          inventoryId(repository.identity.id, 'worktree', await directoryId(actualDirectory)) !==
            tree.id ||
          inventoryId('local', await directoryId(actualCommon)) !== repository.identity.id
        )
          throw new Error('Selected directory belongs to another local authority; discover again.')
        paths.push(tree.path)
      }
    }
  }
  if (signal?.aborted) throw new CommandCancelled()
  if (paths.length !== requested.size || !paths.length)
    throw new Error('A selected worktree moved or is unavailable; discover again.')
  return paths
}

/** Bounded inventory on the existing scheduler and watchers; no second polling or transport. */
export class WorktreeInventoryService {
  private generation = 0
  private publication = 0
  private selection: Omit<InventoryRequest, 'requestId'> = {}
  private roots: string[] = []
  private controller: AbortController | null = null
  private automaticController: AbortController | null = null
  private state: WorktreeInventory = {
    generation: 0,
    repositories: [],
    failures: [],
    state: 'complete',
  }
  private watchers = new Map<string, RepositoryWatcher>()
  private watchedIds = new Map<string, InventoryId>()
  private invalid = new Set<string>()
  private refreshTimer: NodeJS.Timeout | undefined
  private active = true
  private remote = new Map<string, Pick<RepositorySnapshot, 'path' | 'pullRequests' | 'remote'>>()
  private readonly watcherReads = new RepositoryScheduler(WORKTREE_READ_CONCURRENCY)
  private watcherController = new AbortController()
  constructor(
    private scheduler: RepositoryScheduler,
    private publish: (value: WorktreeInventory) => void,
    private onLocalChange?: (registeredPaths: readonly string[]) => void,
    private watcherOptions: Pick<RepositoryWatcherOptions, 'recursiveWatch'> = {},
  ) {}

  current(): WorktreeInventory {
    return this.state
  }
  register(roots: string[]): void {
    this.roots = [...new Set(roots)]
    if (this.watcherController.signal.aborted) this.watcherController = new AbortController()
    this.controller?.abort()
    this.generation++
    for (const [id, snapshot] of this.remote)
      if (!this.roots.includes(snapshot.path)) this.remote.delete(id)
    this.state = {
      generation: ++this.publication,
      repositories: this.state.repositories.filter((repository) =>
        repository.registeredPaths.some((path) => this.roots.includes(path)),
      ),
      failures: [],
      state: 'partial',
    }
    const observedPaths = new Set(
      this.state.repositories.flatMap((repository) => [
        repository.identity.commonDirectory,
        ...repository.worktrees.map((tree) => tree.path),
      ]),
    )
    for (const [path, watcher] of this.watchers)
      if (!observedPaths.has(path)) {
        watcher.stop()
        this.watchers.delete(path)
        this.watchedIds.delete(path)
      }
    this.publish(this.state)
    this.schedule()
  }
  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    if (!active) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
      this.watcherController.abort()
      if (this.automaticController) {
        this.automaticController.abort()
        if (this.controller === this.automaticController) this.generation++
      }
      this.stopWatchers()
      return
    }
    this.watcherController = new AbortController()
    for (const repository of this.state.repositories)
      for (const tree of repository.worktrees) this.invalid.add(tree.path)
    this.schedule()
  }
  retireRemote(): void {
    // Match main's authority retirement: configured transports may alias logical hosts.
    this.remote.clear()
    this.state = {
      ...this.state,
      generation: ++this.publication,
      repositories: this.state.repositories.map((repository) => ({
        ...repository,
        pullRequests: [],
        remoteFreshness: null,
        refs: repository.refs.map((ref) => ({ ...ref, pullRequestIds: [] })),
      })),
    }
    this.publish(this.state)
  }
  adoptRemote(
    snapshot: Pick<RepositorySnapshot, 'path' | 'remoteUrl' | 'pullRequests' | 'remote'>,
  ): void {
    const origin = parseRemote(snapshot.remoteUrl)
    if (origin)
      this.remote.set(
        inventoryId('remote', origin.host.toLowerCase(), origin.fullName.toLowerCase()),
        { path: snapshot.path, pullRequests: snapshot.pullRequests, remote: snapshot.remote },
      )
    this.state = {
      ...this.state,
      generation: ++this.publication,
      repositories: this.state.repositories.map((repository) => {
        const next = { ...repository, refs: repository.refs.map((ref) => ({ ...ref })) }
        this.joinRemote(next)
        return next
      }),
    }
    this.publish(this.state)
  }
  private joinRemote(repository: RepositoryInventory): void {
    repository.pullRequests = []
    for (const ref of repository.refs) ref.pullRequestIds = []
    if (!repository.remote) return
    const snapshot = this.remote.get(repository.remote.id)
    repository.remoteFreshness = snapshot?.remote ?? null
    if (!snapshot) return
    repository.pullRequests = snapshot.pullRequests.map((facts) => {
      const id = inventoryId(repository.remote!.id, 'pr', String(facts.number))
      // A same-name local branch alone is not proof it is the published head.
      const headRemoteId = facts.headRepository
        ? inventoryId(
            'remote',
            repository.remote!.host.toLowerCase(),
            facts.headRepository.toLowerCase(),
          )
        : null
      const published = repository.refs.filter(
        (ref) =>
          headRemoteId !== null &&
          ref.remoteId === headRemoteId &&
          ref.name === `refs/remotes/${ref.remoteName}/${facts.head}` &&
          ref.oid === facts.headOid,
      )
      const refs = [
        ...published,
        ...repository.refs.filter(
          (ref) =>
            ref.kind === 'local' &&
            (published.some((remote) => remote.id === ref.upstream) ||
              (ref.name === `refs/heads/${facts.head}` &&
                ref.oid === facts.headOid &&
                facts.headRepository?.toLowerCase() === repository.remote!.fullName.toLowerCase())),
        ),
      ]
      for (const ref of refs) ref.pullRequestIds.push(id)
      return {
        id,
        remoteId: repository.remote!.id,
        number: facts.number,
        headRef: facts.head,
        headOid: facts.headOid ?? null,
        refIds: refs.map((ref) => ref.id),
        facts,
      }
    })
  }
  async read(request: InventoryRequest, signal?: AbortSignal): Promise<WorktreeInventory> {
    return this.readInventory(request, signal, false)
  }
  private async readInventory(
    request: InventoryRequest,
    signal: AbortSignal | undefined,
    automatic: boolean,
  ): Promise<WorktreeInventory> {
    this.selection = {
      selectedWorktreeId: request.selectedWorktreeId,
      visibleWorktreeIds: request.visibleWorktreeIds,
    }
    clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.automaticController = automatic ? controller : null
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const generation = ++this.generation
    const old = new Map(
      this.state.repositories.flatMap((repo) =>
        repo.worktrees.map((tree) => [tree.id, tree] as const),
      ),
    )
    const invalid = new Set(this.invalid)
    this.invalid.clear()
    const repositories: RepositoryInventory[] = []
    const failures: WorktreeInventory['failures'] = []
    try {
      // Discovery order is stable. Shared common metadata is read once per registered authority.
      for (const root of this.roots) {
        try {
          const repository = await this.scheduler.read(
            root,
            async (signal) => {
              if (repositories.length) {
                const commonDirectory = await realpath(
                  (
                    await runGit(
                      root,
                      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
                      undefined,
                      signal,
                    )
                  ).replace(GIT_PATH_TERMINATOR, ''),
                )
                const id = inventoryId('local', await directoryId(commonDirectory))
                const existing = repositories.find((item) => item.identity.id === id)
                if (existing) {
                  existing.registeredPaths.push(root)
                  return null
                }
              }
              return discoverWorktrees(root, signal)
            },
            combined,
          )
          if (!repository) continue
          repositories.push(repository)
        } catch (error) {
          if (isCancelled(error)) throw error
          failures.push({ path: root, error: failure(error).error! })
        }
      }
      // Arm first: an edit between inspection and watch readiness must not become the baseline.
      await this.armWatchers({ generation, repositories, failures, state: 'partial' }, combined)
      const priority = new Set(request.visibleWorktreeIds ?? [])
      const prioritized = [...repositories].sort(
        (a, b) =>
          Number(b.worktrees.some((tree) => tree.id === request.selectedWorktreeId)) -
            Number(a.worktrees.some((tree) => tree.id === request.selectedWorktreeId)) ||
          Number(b.worktrees.some((tree) => priority.has(tree.id))) -
            Number(a.worktrees.some((tree) => priority.has(tree.id))),
      )
      for (const repository of prioritized) {
        const root = repository.registeredPaths[0]
        const ordered = [...repository.worktrees].sort(
          (a, b) =>
            Number(b.id === request.selectedWorktreeId) -
              Number(a.id === request.selectedWorktreeId) ||
            Number(priority.has(b.id)) - Number(priority.has(a.id)),
        )
        await mapWithConcurrency(ordered, WORKTREE_READ_CONCURRENCY, async (worktree) => {
          const previous = old.get(worktree.id)
          const stable =
            previous &&
            previous.read.state === 'complete' &&
            worktree.id !== request.selectedWorktreeId &&
            !invalid.has(worktree.path) &&
            previous.path === worktree.path &&
            previous.headOid === worktree.headOid &&
            previous.refId === worktree.refId &&
            previous.missing === worktree.missing
          const value = stable
            ? {
                ...worktree,
                counts: previous.counts,
                status: previous.status,
                read: previous.read,
                operation: previous.operation,
                indexSignature: previous.indexSignature,
              }
            : await this.scheduler.read(
                root,
                (signal) => inspectWorktree(worktree, signal),
                combined,
              )
          repository.worktrees[repository.worktrees.indexOf(worktree)] = value
        })
      }
      if (combined.aborted || generation !== this.generation) throw new CommandCancelled()
      const state: WorktreeInventory = {
        generation: ++this.publication,
        repositories,
        failures,
        state: failures.length
          ? repositories.length
            ? 'partial'
            : 'failed'
          : repositories.some(
                (repo) =>
                  repo.discovery.state !== 'complete' ||
                  repo.refsRead.state !== 'complete' ||
                  repo.worktrees.some(
                    (tree) =>
                      !tree.missing && tree.kind !== 'bare' && tree.read.state !== 'complete',
                  ),
              )
            ? 'partial'
            : 'complete',
      }
      for (const repository of repositories) this.joinRemote(repository)
      this.state = state
      this.publish(state)
      return state
    } catch (error) {
      for (const path of invalid) this.invalid.add(path)
      throw error
    } finally {
      if (this.automaticController === controller) this.automaticController = null
    }
  }
  private async armWatchers(state: WorktreeInventory, signal: AbortSignal): Promise<void> {
    const targets = new Map<
      string,
      { repository: RepositoryInventory | null; tree: InventoryWorktree | null; id: string }
    >()
    for (const repository of state.repositories) {
      for (const tree of repository.worktrees)
        if (tree.kind !== 'bare') targets.set(tree.path, { repository, tree, id: tree.id })
      // One common metadata subscription, not one recursively duplicated per worktree.
      targets.set(repository.identity.commonDirectory, {
        repository,
        tree: null,
        id: inventoryId(
          repository.identity.id,
          'metadata-watch',
          String(repository.worktrees.length),
        ),
      })
    }
    // Failed roots still need path monitoring, but carry no current Git authority.
    for (const { path } of state.failures)
      if (!targets.has(path))
        targets.set(path, { repository: null, tree: null, id: inventoryId('presence', path) })
    for (const [path, watcher] of this.watchers)
      if (!targets.has(path) || targets.get(path)!.id !== this.watchedIds.get(path)) {
        watcher.stop()
        this.watchers.delete(path)
        this.watchedIds.delete(path)
      }
    await mapWithConcurrency(
      [...targets],
      WORKTREE_READ_CONCURRENCY,
      async ([path, { repository, tree, id }]) => {
        if (!this.active || signal.aborted || this.watchers.has(path)) return
        if (!repository) {
          const watcher = new RepositoryWatcher(
            path,
            () => {
              this.onLocalChange?.([path])
              this.controller?.abort()
              this.generation++
              this.schedule()
            },
            {
              recursiveWatch: false,
              resolveGitDirectories: async () => [],
              readContentSignature: async () => '',
            },
          )
          this.watchers.set(path, watcher)
          this.watchedIds.set(path, id)
          await watcher.start()
          if (!this.active || signal.aborted) {
            watcher.stop()
            if (this.watchers.get(path) === watcher) {
              this.watchers.delete(path)
              this.watchedIds.delete(path)
            }
          }
          return
        }
        const commonDirectory = repository.identity.commonDirectory
        const watcher = new RepositoryWatcher(
          path,
          (event) => {
            const current =
              this.state.repositories.find(
                (candidate) => candidate.identity.id === repository.identity.id,
              ) ?? repository
            const changed = new Set<string>()
            if (tree) {
              if (
                event.reason !== 'change' ||
                event.paths.some(
                  (file) =>
                    (file !== commonDirectory && !file.startsWith(`${commonDirectory}${sep}`)) ||
                    (tree.gitDirectory !== null &&
                      WORKTREE_STATE_PATHS.some((name) => {
                        const target = relative(tree.gitDirectory!, file)
                        return target === name || target.startsWith(`${name}${sep}`)
                      })),
                )
              )
                changed.add(path)
            } else {
              const primary = current.worktrees.find((candidate) => candidate.kind === 'primary')
              if (
                primary &&
                (event.reason !== 'change' ||
                  event.paths.some((file) =>
                    WORKTREE_STATE_PATHS.some((name) => {
                      const target = relative(commonDirectory, file)
                      return target === name || target.startsWith(`${name}${sep}`)
                    }),
                  ))
              )
                changed.add(primary.path)
            }
            this.onLocalChange?.(current.registeredPaths)
            for (const affected of changed) this.invalid.add(affected)
            this.controller?.abort()
            this.generation++
            this.state = {
              ...this.state,
              generation: ++this.publication,
              state: 'partial',
              repositories: this.state.repositories.map((candidate) =>
                candidate.identity.id === repository.identity.id && changed.size > 0
                  ? {
                      ...candidate,
                      worktrees: candidate.worktrees.map((worktree) =>
                        changed.has(worktree.path)
                          ? { ...worktree, status: 'unknown', counts: null, read: pendingRead() }
                          : worktree,
                      ),
                    }
                  : candidate,
              ),
            }
            this.publish(this.state)
            this.schedule()
          },
          {
            // Common metadata uses sparse watches and one bounded ref/topology fallback.
            recursiveWatch: tree !== null && this.watcherOptions.recursiveWatch !== false,
            resolveGitDirectories: async () =>
              tree
                ? tree.gitDirectory && tree.gitDirectory !== commonDirectory
                  ? [tree.gitDirectory]
                  : []
                : [commonDirectory],
            readContentSignature: async () => {
              if (!this.active) return 'inactive'
              const root =
                this.state.repositories.find(
                  (candidate) => candidate.identity.id === repository.identity.id,
                )?.registeredPaths[0] ?? repository.registeredPaths[0]
              return this.watcherReads
                .read(
                  'inventory-watchers',
                  (outerSignal) =>
                    this.scheduler.read(
                      root,
                      async (signal) =>
                        withGitRuntime(await resolveGitRuntime(), async () => {
                          const hash = createHash('sha256')
                          const commands = tree
                            ? [
                                [
                                  '--no-optional-locks',
                                  'status',
                                  '--porcelain=v2',
                                  '--branch',
                                  '--untracked-files=all',
                                  '-z',
                                ],
                              ]
                            : [
                                ['worktree', 'list', '--porcelain', '-z'],
                                ['for-each-ref', '--format=%(refname) %(objectname) %(symref)'],
                              ]
                          for (const args of commands) {
                            const result = await runGitCapped(tree ? path : root, args, {
                              maxBytes: tree ? MAX_STATUS_BYTES : MAX_COMMAND_BYTES,
                              boundary: '\0',
                              signal,
                            })
                            hash.update(`${result.truncated}:`).update(result.text)
                          }
                          return hash.digest('hex')
                        }),
                      outerSignal,
                    ),
                  this.watcherController.signal,
                )
                .catch(() => 'unavailable')
            },
          },
        )
        this.watchers.set(path, watcher)
        this.watchedIds.set(path, id)
        await watcher.start()
        if (!this.active || signal.aborted) {
          watcher.stop()
          if (this.watchers.get(path) === watcher) {
            this.watchers.delete(path)
            this.watchedIds.delete(path)
          }
        }
      },
    )
  }
  private schedule(): void {
    if (!this.active || this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      const signal = this.watcherController.signal
      void resolveGitRuntime()
        .then((runtime) => {
          if (!this.active || signal.aborted) return
          return withGitRuntime(runtime, () =>
            this.readInventory({ requestId: 'inventory-watch', ...this.selection }, signal, true),
          )
        })
        .catch(() => {
          /* A retired read is replaced by the next observation. */
        })
    }, WORKTREE_REFRESH_SETTLE_MS)
    this.refreshTimer.unref()
  }
  private stopWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
    this.watchedIds.clear()
  }
  stop(): void {
    this.controller?.abort()
    this.watcherController.abort()
    clearTimeout(this.refreshTimer)
    this.stopWatchers()
  }
}
