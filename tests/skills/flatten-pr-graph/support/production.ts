/**
 * The production driver for the shipped `prepareStack` and `publishStack`.
 *
 * A case seeds real branches in a disposable bare remote, calls the helper, and then reads
 * the outcome back out of Git and out of the provider double's own record of what it was
 * asked to do. Nothing here builds a result document, a prepared commit, or a provider
 * state change: the only way a case can report a head, a base, or a write is for the real
 * helper to have produced it.
 *
 * The provider double is a module on disk with the three operations the contract allows,
 * loaded by `publishStack` through its normal `import`. It seeds itself from real remote
 * object ids, so a pinned snapshot and the double always agree about what existed before
 * the run, and it records every call including the ones it refuses or loses the
 * acknowledgement of.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStack } from '../../../../.agents/skills/flatten-pr-graph/scripts/prepare-stack.mjs'
import { publishStack } from '../../../../.agents/skills/flatten-pr-graph/scripts/publish-stack.mjs'
import type { ScratchWorkspace, UserFingerprint, World } from './real-git'
import type { PinnedEdge } from './production-verdict'

export const CONTRACT_VERSION = 'flatten-pr-graph/1'
export const DEFAULT_BRANCH = 'main'
export const ROOT_REF = 'refs/heads/main'
export const REPOSITORY = { owner: 'acme', name: 'widgets' }

/** The head branch each pull request in this matrix publishes. */
export const BRANCHES: Record<number, string> = {
  12: 'feat-a',
  13: 'feat-b',
  14: 'feat-c',
  15: 'feat-d',
  16: 'feat-e',
}

export interface PreparedBranch {
  number: number
  originalHead: string
  preparedHead: string
  basedOn: string
  retainedOriginalCommits: string[]
  historyPolicy: string
}

export interface PreparedRun {
  contractVersion: string
  ok: boolean
  status: string
  errors: Array<{ code: string; detail: string; evidence?: string }>
  run: {
    runId: string
    runDirectory: string
    storage: string
    journalPath: string
    workspaces: string[]
    backupRefs: string[]
    note: string
  } | null
  preparation: {
    contractVersion: string
    workspaceKind: string
    branches: PreparedBranch[]
    lostOriginalCommits: string[]
    cumulativeIntegration: Array<{ number: number; integratedPreparedStateOf: number; evidence: string }>
    conflicts: Array<{ number: number; path: string; resolution: string }>
    unresolved: string[]
    indexState: {
      unmergedEntries: string[]
      operationsInProgress: string[]
      conflictMarkersInTree: string[]
    }
  } | null
  verification: Array<{ invariant: string; method?: string; observed?: string; result: string }>
  continuation: { prepared: number[]; remaining: number[]; resumeFrom: number | null }
  conflicts: Array<{
    number: number
    path: string
    kind?: string
    structural?: boolean
    needsDecision?: boolean
    decision?: unknown
  }>
  decisions: Array<{ number: number; path: string; intent: string; reason: string }>
  controls: Array<{ control: string; value: string; blocking: boolean }>
  userWorkspace: UserFingerprint | null
}

export interface PublicationAttempt {
  sequence: number
  kind: 'ref-update' | 'pr-base-update'
  target: string
  from?: string
  to?: string
  acknowledged?: boolean
  outcome: string
  lease?: { expectedRemote?: string; usedForceWithLease?: boolean }
}

export interface PublicationResult {
  contractVersion: string
  ok: boolean
  status: string
  errors: Array<{ code: string; detail: string; evidence?: string }>
  publication: {
    contractVersion: string
    attempts: PublicationAttempt[]
    confirmed: Array<{ kind: string; target: string; oid: string }>
    unconfirmed: Array<{ kind: string; target: string; why: string }>
    denials: Array<{ kind: string; target: string; reason: string; acknowledged: boolean }>
    remoteClaims: Array<{ kind: string; target: string; observed: string }>
    interrupted: boolean
    concurrency: { leaseHeld: boolean; conflictingRemoteMoveDetected: boolean }
  }
  capability: {
    atomicRefTransaction: string
    providerCompareAndSwap: boolean | null
    baseWritesGuardedBy: string | null
    residualMetadataRace: boolean | null
    blockedControls: string[]
  }
  rootAdvance: { pinned: string; observed: string; integrated: boolean; note?: string } | null
  verification: Array<{ invariant: string; method?: string; observed?: string; result: string }>
  recovery: {
    acknowledgedChanges: string[]
    unconfirmedAttempts: string[]
    recommended: string
  } | null
  nextSafeAction: { action: string; requires: string[] } | null
  journalPath: string | null
}

export type PublicationConversations = Record<string, unknown>

/** The fault a provider double injects, at the exact operation the case needs. */
export interface ProviderScript {
  /** Pull requests whose base update the server refuses. */
  refuseBaseUpdate?: number[]
  /** Apply the base update, then lose the acknowledgement by throwing. */
  applyThenThrow?: boolean
  /** Fail every provider read after this many have succeeded. */
  failReadAfter?: number
  /** Change the title server-side after this many acknowledged base writes. */
  driftTitleAfterWrite?: number
}

export interface ProviderCall {
  sequence: number
  op: string
  number: number | null
  base: string | null
  outcome: string
}

export interface ProviderAdapter {
  module: string
  /** Every operation the helper asked for, in order, including refusals. */
  calls(): Promise<ProviderCall[]>
  /** The pull-request metadata the double currently serves. */
  pullRequests(): Promise<Record<string, { number: number; baseRef: string; headRef: string; title: string }>>
}

export interface PinnedPullRequest {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  headRef: string
  headRepository: string
  baseRef: string
  headRefOid: string | null
  baseRefOid: string | null
  title: string
  body: string
  labels: string[]
  reviewers: string[]
  autoMergeRequest: { enabled: boolean; method: string | null }
}

const unique = (values: string[]): string[] => [...new Set(values)].sort()

/** A ref name the way the helpers require one: fully qualified. */
export function qualify(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
}

export function prepareCodes(result: PreparedRun): string[] {
  return unique(result.errors.map((error) => error.code))
}

export function publishCodes(result: PublicationResult): string[] {
  return unique(result.errors.map((error) => error.code))
}

/**
 * The authorized snapshot of one pull request, pinned from real object ids.
 *
 * It is the same value the provider double starts from, so a document that pins it is
 * asserting what existed before the run rather than what the run would like to see.
 */
export function pinnedPullRequest(
  world: World,
  request: { number: number; branch: string; base?: string; state?: 'OPEN' | 'CLOSED' | 'MERGED' },
): PinnedPullRequest {
  const base = request.base ?? DEFAULT_BRANCH
  const live = world.remoteRefs()
  return {
    number: request.number,
    state: request.state ?? 'OPEN',
    draft: false,
    headRef: request.branch,
    headRepository: `${REPOSITORY.owner}/${REPOSITORY.name}`,
    baseRef: base,
    // The real object ids the remote holds now, so the pinned snapshot records the state
    // this run was authorized against and a divergence in either id is detectable.
    headRefOid: live[`refs/heads/${request.branch}`] ?? null,
    baseRefOid: live[`refs/heads/${base}`] ?? null,
    title: `Feature #${request.number}`,
    body: `the body of #${request.number}`,
    labels: [],
    reviewers: [],
    autoMergeRequest: { enabled: false, method: null },
  }
}

let providerCounter = 0

/**
 * Writes a provider double with exactly the three operations the contract allows.
 *
 * The module is loaded by `publishStack` through `import`, so it is the same module
 * instance the test reads afterwards: the record the test inspects is the record the
 * helper produced, not a parallel log the test kept for itself.
 */
function writeProviderModule(
  world: World,
  pinned: PinnedPullRequest[],
  script: ProviderScript,
): ProviderAdapter {
  providerCounter += 1
  const module = join(world.root, `provider-${providerCounter}.mjs`)
  const seeded = Object.fromEntries(pinned.map((pr) => [pr.number, pr]))
  const remotePath = world.remote
  writeFileSync(
    module,
    `import { execFileSync } from 'node:child_process'
const remotePath = ${JSON.stringify(remotePath)}
const seeded = ${JSON.stringify(seeded)}
const script = ${JSON.stringify(script)}
const pullRequests = new Map(Object.entries(seeded).map(([number, pr]) => [Number(number), structuredClone(pr)]))
/** The remote's own refs, so every served id is read state and never a remembered one. */
function liveOids() {
  const stdout = execFileSync('git', ['ls-remote', '--heads', remotePath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' },
  })
  const oids = {}
  for (const line of stdout.split('\n')) {
    const [oid, ref] = line.trim().split(/\s+/)
    if (oid && ref) oids[ref.replace('refs/heads/', '')] = oid
  }
  return oids
}
function refresh() {
  const oids = liveOids()
  for (const pullRequest of pullRequests.values()) {
    if (oids[pullRequest.headRef] !== undefined) pullRequest.headRefOid = oids[pullRequest.headRef]
    if (oids[pullRequest.baseRef] !== undefined) pullRequest.baseRefOid = oids[pullRequest.baseRef]
  }
}
refresh()
const calls = []
let reads = 0
let writes = 0
function record(op, number, base, outcome) {
  calls.push({ sequence: calls.length + 1, op, number: number ?? null, base: base ?? null, outcome })
}
export function capabilities() {
  record('capabilities', null, null, 'observed')
  return {
    operations: ['read-pull-request', 'update-pull-request-base'],
    compareAndSwap: false,
    provider: 'production-double',
  }
}
export function readPullRequest(number) {
  reads += 1
  if (script.failReadAfter !== undefined && reads > script.failReadAfter) {
    record('readPullRequest', number, null, 'unreadable')
    throw new Error('the provider could not be reached')
  }
  refresh()
  record('readPullRequest', number, pullRequest?.baseRef ?? null, pullRequest ? 'observed' : 'absent')
  return { ok: true, pullRequest: pullRequest ? structuredClone(pullRequest) : null }
}
export function updatePullRequestBase(number, base, expectedBase) {
  const pullRequest = pullRequests.get(number)
  if (!pullRequest) {
    record('updatePullRequestBase', number, base, 'missing')
    return { ok: false, applied: false }
  }
  if ((script.refuseBaseUpdate ?? []).includes(number)) {
    record('updatePullRequestBase', number, base, 'denied')
    return { ok: false, applied: false }
  }
  const preconditionMet =
    expectedBase === undefined || expectedBase === null ? null : expectedBase === pullRequest.baseRef
  if (preconditionMet === false) {
    record('updatePullRequestBase', number, base, 'precondition-failed')
    return { ok: false, applied: false, preconditionMet: false }
  }
  pullRequest.baseRef = base
  refresh()
  writes += 1
  record('updatePullRequestBase', number, base, 'acknowledged')
  if (script.driftTitleAfterWrite !== undefined && writes === script.driftTitleAfterWrite) {
    pullRequest.title = pullRequest.title + ' (edited by somebody else)'
  }
  if (script.applyThenThrow === true) {
    throw new Error('the acknowledgement was lost in transit')
  }
  return { ok: true, applied: true, preconditionMet }
}
export function __calls() {
  return calls
}
export function __state() {
  return Object.fromEntries(
    [...pullRequests].map(([number, pullRequest]) => [String(number), structuredClone(pullRequest)]),
  )
}
`,
    'utf8',
  )
  const loaded = (): Promise<Record<string, (...args: never[]) => unknown>> =>
    import(pathToFileURL(module).href) as Promise<Record<string, (...args: never[]) => unknown>>
  return {
    module,
    async calls() {
      return (await loaded()).__calls() as unknown as Promise<ProviderCall[]>
    },
    async pullRequests() {
      return (await loaded()).__state() as unknown as Awaited<
        ReturnType<ProviderAdapter['pullRequests']>
      >
    },
  }
}

export interface PrepareOptions {
  order: number[]
  originalHeads: Record<number, string>
  selection?: number[]
  branches?: Record<number, string>
  heads?: Record<number, string>
  runDirectory?: string
  userWorkspace?: string | null
  resolutions?: unknown[]
  justifiedDrops?: unknown[]
  resume?: boolean
}

export interface PublishOptions {
  order: number[]
  /** The root this publication was authorized against, not the one the remote holds now. */
  root?: { ref: string; oid: string }
  branches?: Record<number, string>
  intendedBases: Record<number, string>
  pullRequests: Record<number, PinnedPullRequest>
  providerModule: string
  granted?: string[]
  selection?: number[]
  observedRefs?: Record<string, string>
  runDirectory?: string
  resume?: boolean
  /** `null` names no task-owned run at all, which the contract does not allow. */
  preparationRunDirectory?: string | null
}

/** Everything a production case needs, over one disposable real Git world. */
export class Production {
  /**
   * The most recent authorized snapshot this driver was asked to serve, kept so the
   * independent verdict can derive hard dependency edges from the evidence that existed
   * before the run rather than from anything the helper produced.
   */
  lastPinned: PinnedPullRequest[] = []

  constructor(readonly world: World) {}

  prepareRun(): string {
    return join(this.world.root, 'prepare-run')
  }

  publishRun(): string {
    return join(this.world.root, 'publish-run')
  }

  storage(): string {
    return join(this.prepareRun(), 'storage.git')
  }

  workspace(number: number): string {
    return join(this.prepareRun(), 'workspaces', `pr-${number}`)
  }

  root(): string {
    return this.world.remoteRefs()[ROOT_REF]
  }

  refs(): Record<string, string> {
    return this.world.remoteRefs()
  }

  storageAncestor(ancestor: string, descendant: string): boolean {
    return this.world.isAncestor(this.storage(), ancestor, descendant)
  }

  remoteAncestor(ancestor: string, descendant: string): boolean {
    return this.world.isRemoteAncestor(ancestor, descendant)
  }

  scratch(name: string): Promise<ScratchWorkspace> {
    return this.world.createScratch(name)
  }

  /** Moves the root forward on the remote and returns the new root commit id. */
  advanceRoot(files: Record<string, string>): string {
    const repo = this.world.repo
    this.world.gitIn(repo, 'checkout', '--quiet', DEFAULT_BRANCH)
    for (const [path, content] of Object.entries(files)) {
      this.writeBytes(repo, path, Buffer.from(content, 'utf8'))
    }
    this.world.gitIn(repo, 'add', '--all')
    this.world.gitIn(repo, 'commit', '--quiet', '-m', 'the root branch moves on')
    this.world.gitIn(repo, 'push', '--quiet', 'origin', DEFAULT_BRANCH)
    return this.root()
  }

  /** Publishes one real branch to the remote and returns the commit id it holds. */
  async seedBranch(
    branch: string,
    files: Record<string, string>,
    options: { base?: string } = {},
  ): Promise<string> {
    const scratch = await this.world.createScratch(`seed-${branch}`)
    scratch.fetch()
    scratch.checkout(options.base ?? DEFAULT_BRANCH)
    for (const [path, content] of Object.entries(files)) {
      this.writeBytes(scratch.path, path, Buffer.from(content, 'utf8'))
    }
    const oid = scratch.commit(`work on ${branch}`)
    scratch.push(branch, { force: true })
    return oid
  }

  /** Writes a path, creating parents, without going through the string-only writer. */
  writeBytes(target: string, path: string, bytes: Buffer): void {
    const full = join(target, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, bytes)
  }

  writeSymlink(target: string, path: string, link: string): void {
    const full = join(target, path)
    mkdirSync(dirname(full), { recursive: true })
    if (existsSync(full)) rmSync(full, { force: true })
    symlinkSync(link, full)
  }

  /** Writes entries into the world's own global Git configuration. */
  writeGlobalConfig(entries: Record<string, string>): void {
    const config = join(this.world.root, 'gitconfig')
    const lines = Object.entries(entries).map(([key, value]) => `[${key}]\n\t${value}\n`)
    writeFileSync(config, `${existsSync(config) ? readFileSync(config, 'utf8') : ''}${lines.join('')}`)
  }

  /** The real `git push` the helper would run, for a fault at an exact moment. */
  realPush(
    repository: string,
    endpoint: string,
    refspecs: string[],
    leases: string[],
  ): { ok: boolean; status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('git', ['push', '--atomic', ...leases, endpoint, ...refspecs], {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, status: 0, stdout, stderr: '' }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number }
      return {
        ok: false,
        status: typeof failure.status === 'number' ? failure.status : 1,
        stdout: String(failure.stdout ?? ''),
        stderr: String(failure.stderr ?? ''),
      }
    }
  }

  prepare(options: PrepareOptions): PreparedRun {
    const branches = options.branches ?? BRANCHES
    return prepareStack({
      repository: this.world.remote,
      userWorkspace: options.userWorkspace ?? null,
      runDirectory: options.runDirectory ?? this.prepareRun(),
      root: { ref: ROOT_REF, oid: this.root() },
      selection: options.selection ?? options.order,
      order: options.order,
      // `git check-ref-format` refuses a one-level name unless `--allow-onelevel` is
      // passed, and the helper asks Git itself rather than inventing a looser rule. The
      // plan therefore carries fully qualified refs, as the shipped example does.
      heads: Object.fromEntries(
        options.order.map((number) => [
          number,
          qualify(options.heads?.[number] ?? branches[number]),
        ]),
      ),
      originalHeads: options.originalHeads,
      hardDependencies: [],
      resolutions: options.resolutions ?? [],
      justifiedDrops: options.justifiedDrops ?? [],
      resume: options.resume === true,
    }) as PreparedRun
  }

  /** The publication document as the helper receives it, for a case that edits it. */
  publishInput(prepared: PreparedRun, options: PublishOptions): Record<string, unknown> {
    const branches = options.branches ?? BRANCHES
    return {
      repository: this.storage(),
      remote: this.world.remote,
      runDirectory: options.runDirectory ?? this.publishRun(),
      root: options.root ?? { ref: ROOT_REF, oid: this.root() },
      preparation: prepared.preparation,
      order: options.order,
      heads: Object.fromEntries(
        options.order.map((number) => [number, `refs/heads/${branches[number]}`]),
      ),
      intendedBases: options.intendedBases,
      authority: {
        intent: 'execute',
        selection: options.selection ?? options.order,
        granted: options.granted ?? ['ref-update', 'pr-base-update'],
        hostVerified: true,
      },
      observedRefs: options.observedRefs ?? this.refs(),
      pullRequests: options.pullRequests,
      provider: { module: options.providerModule },
      preparationRunDirectory:
        options.preparationRunDirectory === undefined
          ? this.prepareRun()
          : options.preparationRunDirectory,
      resume: options.resume === true,
    }
  }

  publish(
    prepared: PreparedRun,
    options: PublishOptions,
    conversations: PublicationConversations = {},
  ): Promise<PublicationResult> {
    return publishStack(
      this.publishInput(prepared, options) as never,
      conversations as never,
    ) as Promise<PublicationResult>
  }

  /** Publishes a document the case built or edited itself. */
  publishRaw(
    raw: Record<string, unknown>,
    conversations: PublicationConversations = {},
  ): Promise<PublicationResult> {
    return publishStack(raw as never, conversations as never) as Promise<PublicationResult>
  }

  /**
   * The pull requests this run was authorized against, in the oracle's vocabulary, so the
   * independent verdict can derive hard dependency edges from the pre-run evidence rather
   * than from any document the helper produced.
   */
  pinned(): PinnedEdge[] {
    return this.lastPinned.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      base: pr.baseRef.replace('refs/heads/', ''),
      head: pr.headRef.replace('refs/heads/', ''),
      headRepository: pr.headRepository,
      author: 'production-matrix',
    }))
  }

  adapter(pullRequests: PinnedPullRequest[], script: ProviderScript = {}): ProviderAdapter {
    this.lastPinned = pullRequests
    return writeProviderModule(this.world, pullRequests, script)
  }
}

/** The provider operations that actually changed remote state, in the order they were asked. */
export async function acknowledgedBaseWrites(
  adapter: ProviderAdapter,
): Promise<number[]> {
  const calls = await adapter.calls()
  return calls
    .filter((call) => call.op === 'updatePullRequestBase' && call.outcome === 'acknowledged')
    .map((call) => call.number as number)
}

/**
 * Configures Git for the duration of one synchronous call. `GIT_CONFIG_*` is inherited by
 * every Git command the callee spawns, which is how a configured driver reaches
 * task-owned storage.
 */
export function withGitConfig<T>(entries: Record<string, string>, body: () => T): T {
  const saved = new Map<string, string | undefined>()
  const set = (name: string, value: string): void => {
    if (!saved.has(name)) saved.set(name, process.env[name])
    process.env[name] = value
  }
  const keys = Object.keys(entries)
  set('GIT_CONFIG_COUNT', String(keys.length))
  keys.forEach((key, index) => {
    set(`GIT_CONFIG_KEY_${index}`, key)
    set(`GIT_CONFIG_VALUE_${index}`, entries[key])
  })
  try {
    return body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Configures the world's global Git file for the duration of one synchronous call, and
 * points the callee at it. `GIT_CONFIG_GLOBAL` is how the world's isolation reaches a
 * helper that spawns Git itself.
 */
export function withWorldGitConfig<T>(world: World, body: () => T): T {
  const saved = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = join(world.root, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    return body()
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
    delete process.env.GIT_CONFIG_NOSYSTEM
  }
}

/** A task-owned bare repository holding the published branches, for the measurement probe. */
export function probeStorage(production: Production): string {
  const path = join(production.world.root, 'probe-storage.git')
  production.world.gitIn(
    production.world.root,
    'init',
    '--bare',
    '--quiet',
    '--initial-branch=main',
    path,
  )
  production.world.gitIn(
    production.world.root,
    '--git-dir',
    path,
    'fetch',
    '--quiet',
    production.world.remote,
    '+refs/heads/*:refs/heads/*',
  )
  return path
}
