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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStack } from '../../../../.agents/skills/flatten-pr-graph/scripts/prepare-stack.mjs'
import { publishStack } from '../../../../.agents/skills/flatten-pr-graph/scripts/publish-stack.mjs'
import type { ScratchWorkspace, UserFingerprint, World } from './real-git'
import type { PinnedEdge } from './production-verdict'

export const CONTRACT_VERSION = 'flatten-pr-graph/1'
export const DEFAULT_BRANCH = 'main'
export const ROOT_REF = 'refs/heads/main'
export const REPOSITORY = { owner: 'acme', name: 'widgets' }

/**
 * The instant every fixture run stamps its commits and attempts with.
 *
 * Git derives a commit id from its timestamps, so a wall clock would give two identical
 * runs different objects and make any comparison between them a comparison of the clock.
 */
export const FIXED_CLOCK = '2026-10-01T09:00:00.000Z'

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
    cumulativeIntegration: Array<{
      number: number
      integratedPreparedStateOf: number
      evidence: string
    }>
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
  /**
   * Somebody else changes the base between this run's read-before-write and its PATCH.
   *
   * GitHub's `PATCH /repos/{owner}/{repo}/pulls/{n}` documents no server-side precondition,
   * so the retarget is applied over whatever the base has become. That is the residual
   * race `residualMetadataRace: true` names, and modelling it is the only honest way to
   * exercise the path: a double that refused on a base mismatch would be enforcing a
   * precondition its own capability document denies it has.
   */
  driftBaseBeforeWrite?: Record<number, string>
  /**
   * The check state the server holds for each pull request.
   *
   * The shipped provider has no operation that returns one, so the module still answers a
   * `readCheckState` call and records that it was asked. A case that varies this field over
   * an otherwise identical fixture can then say the decision did not depend on it, and can
   * say it from the provider's own record rather than from an absence of the word.
   */
  checkStates?: Record<number, 'passing' | 'failing' | 'pending' | 'unavailable'>
}

export interface ProviderCall {
  sequence: number
  op: string
  number: number | null
  base: string | null
  outcome: string
}

/**
 * The shim's log, read back into one record per invocation.
 *
 * `CWD` opens a record, `ARG` lines carry the arguments, `END` closes it. An argument that
 * contains a tab would break this, and no Git argument this driver produces does; a
 * separator that an argument can imitate would have been the worse choice.
 */
function parseNativeTrace(recorded: string): NativeCommand[] {
  const records: NativeCommand[] = []
  let current: NativeCommand | null = null
  for (const line of recorded.split('\n')) {
    if (line === 'END') {
      if (current) records.push(current)
      current = null
      continue
    }
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const tag = line.slice(0, tab)
    const value = line.slice(tab + 1)
    if (tag === 'CWD') current = { cwd: value, args: [] }
    else if (tag === 'ARG' && current) current.args.push(value)
  }
  if (current) records.push(current)
  return records
}

/** One native process the helper started, as the shim observed it. */
export interface NativeCommand {
  cwd: string
  args: string[]
}

/** One provider-side action, in the vocabulary the #84 oracle judges writes by. */
export interface ProviderAction {
  kind: 'update-pr-base' | 'push-selected-head' | 'read-check-state'
  target: string
  outcome: 'observed' | 'acknowledged' | 'denied'
}

export interface ProviderAdapter {
  module: string
  /** Every operation the helper asked for, in order, including refusals. */
  calls(): Promise<ProviderCall[]>
  /** The server's own record of what it did, independent of anything the helper reports. */
  actions(): Promise<ProviderAction[]>
  /** The pull-request metadata the double currently serves. */
  pullRequests(): Promise<
    Record<string, { number: number; baseRef: string; headRef: string; title: string }>
  >
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
let seedCounter = 0

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
  for (const line of stdout.split('\\n')) {
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
const actions = []
const checkStates = new Map(
  Object.entries(script.checkStates ?? {}).map(([number, state]) => [Number(number), state]),
)
let reads = 0
let writes = 0
function record(op, number, base, outcome) {
  calls.push({ sequence: calls.length + 1, op, number: number ?? null, base: base ?? null, outcome })
}
export function capabilities() {
  record('capabilities', null, null, 'observed')
  return {
    operations: ['read-pull-request', 'update-pull-request-base'],
    // The same answer the shipped provider gives: GitHub's PATCH documents no server-side
    // precondition for a base update, so nothing here may pretend to check one.
    compareAndSwap: false,
    provider: 'production-double',
  }
}
/**
 * Not part of the shipped provider's surface, and deliberately not in capabilities().
 *
 * It exists so a run that reaches for a check state is caught: the call is answered with
 * whatever the server holds, and recorded as an action, so the boundary is tested by
 * whether it was consulted rather than by what it then decided.
 */
export function readCheckState(number) {
  const state = checkStates.get(number) ?? null
  actions.push({
    kind: 'read-check-state',
    target: String(number),
    outcome: state ? 'observed' : 'denied',
  })
  record('readCheckState', number, null, state ?? 'unknown')
  return state
}
export function readPullRequest(number) {
  reads += 1
  if (script.failReadAfter !== undefined && reads > script.failReadAfter) {
    record('readPullRequest', number, null, 'unreadable')
    throw new Error('the provider could not be reached')
  }
  refresh()
  const pullRequest = pullRequests.get(number)
  record('readPullRequest', number, pullRequest?.baseRef ?? null, pullRequest ? 'observed' : 'absent')
  return { ok: true, pullRequest: pullRequest ? structuredClone(pullRequest) : null }
}
export function updatePullRequestBase(number, base) {
  const pullRequest = pullRequests.get(number)
  if (!pullRequest) {
    record('updatePullRequestBase', number, base, 'missing')
    actions.push({ kind: 'update-pr-base', target: String(number), outcome: 'denied' })
    return { ok: false, applied: false, preconditionMet: null }
  }
  if ((script.refuseBaseUpdate ?? []).includes(number)) {
    record('updatePullRequestBase', number, base, 'denied')
    actions.push({ kind: 'update-pr-base', target: String(number), outcome: 'denied' })
    return { ok: false, applied: false, preconditionMet: null }
  }
  // A concurrent base change lands here, between the caller's read-before-write and this
  // PATCH. There is nothing to reject: GitHub applies the retarget over it.
  const concurrent = (script.driftBaseBeforeWrite ?? {})[number]
  if (concurrent !== undefined && concurrent !== pullRequest.baseRef) {
    pullRequest.baseRef = concurrent
    record('updatePullRequestBase', number, base, 'concurrent-base-drift')
  }
  pullRequest.baseRef = base
  refresh()
  writes += 1
  record('updatePullRequestBase', number, base, 'acknowledged')
  actions.push({ kind: 'update-pr-base', target: String(number), outcome: 'acknowledged' })
  if (script.driftTitleAfterWrite !== undefined && writes === script.driftTitleAfterWrite) {
    pullRequest.title = pullRequest.title + ' (edited by somebody else)'
  }
  if (script.applyThenThrow === true) {
    // The write happened; only its acknowledgement was lost. The action record above is
    // the server's own, and it survives the exception.
    actions.push({ kind: 'update-pr-base', target: String(number), outcome: 'denied' })
    throw new Error('the acknowledgement was lost in transit')
  }
  return { ok: true, applied: true, preconditionMet: null, provider: 'github' }
}
export function __calls() {
  return calls
}
export function __actions() {
  return actions
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
    async actions() {
      return (await loaded()).__actions() as Promise<ProviderAction[]>
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
  justifiedDrops?: unknown[]
  selection?: number[]
  branches?: Record<number, string>
  heads?: Record<number, string>
  runDirectory?: string
  userWorkspace?: string | null
  resolutions?: unknown[]
  resume?: boolean
  /**
   * The clock the helper stamps its commits with. Pinned by default so two runs over the
   * same immutable input produce byte-identical objects and can be compared; a case that
   * wants a different clock says so.
   */
  now?: string
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
  repository?: string
  /** The clock the helper stamps its attempts with; pinned so runs are comparable. */
  now?: string
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
    seedCounter += 1
    // The name carries a counter because a case may seed the same branch twice - to move
    // it after planning, or to build a second plan - and a second clone into the same
    // directory fails for a reason that has nothing to do with the case.
    const scratch = await this.world.createScratch(`seed-${branch}-${seedCounter}`)
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
    writeFileSync(
      config,
      `${existsSync(config) ? readFileSync(config, 'utf8') : ''}${lines.join('')}`,
    )
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

  /**
   * The helper's own native `git` processes, in order, with the directory each ran in.
   *
   * `world.commands` records what the *driver* ran, and the helpers spawn their own Git,
   * so "no check was run" or "no fetch happened" cannot be answered from it. A `git` shim
   * placed ahead of the real executable on `PATH` records each process the helper started
   * and then execs the real Git, so the trace is an observation of the process table and
   * not a re-derivation of what the code says.
   *
   * It is opt-in because it costs a shell per Git invocation. A run makes hundreds of them,
   * and with the shim always on a three-second case took thirty. Only the cases that assert
   * on what the helper executed ask for it, and they pay for it.
   */
  private tracePath = ''
  private traceRecords: NativeCommand[] = []
  private traceNext = false
  private shimPath = ''
  private driverPath: string | undefined

  /**
   * Traces the helper call `run` makes, and only that one. The shim is built once per world.
   */
  async traceNextCall<T>(run: () => Promise<T> | T): Promise<{ result: T; trace: NativeCommand[] }> {
    this.traceNext = true
    try {
      const result = await run()
      return { result, trace: this.traceRecords }
    } finally {
      this.traceNext = false
    }
  }

  nativeTrace(): NativeCommand[] {
    return this.traceRecords
  }

  private ensureShim(): string {
    if (this.shimPath) return this.shimPath
    const shim = join(this.world.root, 'native-shim')
    mkdirSync(shim, { recursive: true })
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const script = join(shim, 'git')
    // One tab-separated record per invocation, terminated by END, so an argument
    // containing spaces or a quote cannot be mistaken for a record boundary.
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        '{ printf "CWD\\t%s\\n" "$PWD"',
        '  for a in "$@"; do printf "ARG\\t%s\\n" "$a"; done',
        '  printf "END\\n"; } >> "$FLATTEN_NATIVE_TRACE"',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(script, 0o755)
    this.shimPath = shim
    return shim
  }

  private beginTrace(): void {
    if (!this.traceNext) return
    this.tracePath = join(this.world.root, 'native-trace.txt')
    writeFileSync(this.tracePath, '')
    process.env.FLATTEN_NATIVE_TRACE = this.tracePath
    this.driverPath = process.env.PATH
    process.env.PATH = `${this.ensureShim()}${delimiter}${this.driverPath ?? ''}`
  }

  private endTrace(): void {
    if (!this.traceNext) return
    const recorded = this.tracePath ? readFileSync(this.tracePath, 'utf8') : ''
    this.traceRecords = parseNativeTrace(recorded)
    delete process.env.FLATTEN_NATIVE_TRACE
    if (this.driverPath) process.env.PATH = this.driverPath
  }

  /**
   * The provider's own action log, read out of the double after the run it describes.
   * Nothing here is taken from the helper's report.
   */
  private lastActions: ProviderAction[] = []

  observedActions(): ProviderAction[] {
    return this.lastActions
  }

  prepare(options: PrepareOptions): PreparedRun {
    const branches = options.branches ?? BRANCHES
    this.beginTrace()
    try {
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
        // The dependency edges the pre-run evidence actually implied, not an empty list.
        // Preparation refuses an order that contradicts a hard edge, and a driver that
        // declared none would let every order through - the run would never be asked the
        // question it exists to answer.
        hardDependencies: this.hardDependencies(options),
        resolutions: options.resolutions ?? [],
        justifiedDrops: options.justifiedDrops ?? [],
        resume: options.resume === true,
        // A fixed clock, so preparing the same immutable input twice produces the same
        // objects. Git derives a commit id from its timestamps, so a wall clock would make
        // two identical runs differ and any comparison of them meaningless.
        now: options.now ?? FIXED_CLOCK,
      }) as PreparedRun
    } finally {
      this.endTrace()
    }
  }

  /** The publication document as the helper receives it, for a case that edits it. */
  publishInput(prepared: PreparedRun, options: PublishOptions): Record<string, unknown> {
    const branches = options.branches ?? BRANCHES
    // The repository and the run directory name the same task-owned storage. A publication
    // pointed at a different preparation run directory than the one whose storage it is
    // reading is looking for prepared commits that were never written there.
    // `null` names no task-owned run at all, which the contract does not allow; it is kept
    // on the document so the helper can refuse it in its own words, and the storage path
    // falls back to the default so nothing is read from a directory this driver invented.
    const preparationRunDirectory =
      options.preparationRunDirectory == null ? this.prepareRun() : options.preparationRunDirectory
    return {
      repository: options.repository ?? join(preparationRunDirectory, 'storage.git'),
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
      now: options.now ?? FIXED_CLOCK,
    }
  }

  async publish(
    prepared: PreparedRun,
    options: PublishOptions,
    conversations: PublicationConversations = {},
  ): Promise<PublicationResult> {
    // Publication is traced unconditionally. A confirmed write is a claim about the
    // remote, and the only thing that backs it is a push this run actually issued and the
    // commit the remote now carries - so every publication case needs the process trace,
    // not only the ones that remembered to ask. It is cheap here: a publication starts tens
    // of Git processes where a preparation starts hundreds.
    this.traceNext = true
    this.beginTrace()
    let result: unknown
    try {
      result = await publishStack(
        this.publishInput(prepared, options) as never,
        conversations as never,
      )
    } finally {
      this.endTrace()
      this.traceNext = false
    }
    // Read the server's log back out of the double itself once the run is over, so the
    // action oracle compares the document against the provider and not against a copy.
    if (options.providerModule) {
      try {
        const module = (await import(pathToFileURL(options.providerModule).href)) as {
          __actions?: () => ProviderAction[]
        }
        this.lastActions = module.__actions?.() ?? []
      } catch {
        this.lastActions = []
      }
    } else {
      this.lastActions = []
    }
    return result as PublicationResult
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

  /**
   * The hard dependency edges this selection really implies, read off the remote as it is
   * *now* - that is, before this run has prepared anything.
   *
   * Two kinds, both facts about the authorized order rather than choices: `pr-base` when
   * one pull request's base is another selected pull request's head, and `ancestry` when
   * one selected head is a strict ancestor of another. They are derived from the state the
   * run was authorized against, so preparing the same selection twice derives them twice
   * and they never depend on the run under test.
   */
  private hardDependencies(options: PrepareOptions): Array<{
    before: number
    after: number
    source: string
    evidence: string
  }> {
    const pinned = this.lastPinned
    const refs = this.world.remoteRefs()
    const head = (number: number): string | undefined =>
      refs[`refs/heads/${BRANCHES[number]}`]
    const edges: Array<{ before: number; after: number; source: string; evidence: string }> = []
    for (const after of options.order) {
      for (const before of options.order) {
        if (before === after) continue
        const base = pinned.find((pr) => pr.number === after)?.baseRef
        if (base !== undefined && base === BRANCHES[before]) {
          edges.push({
            before,
            after,
            source: 'pr-base',
            evidence: `#${after} is based on #${before}`,
          })
          continue
        }
        const source = head(before)
        const target = head(after)
        if (source === undefined || target === undefined || source === target) continue
        if (!this.world.isRemoteAncestor(source, target)) continue
        edges.push({
          before,
          after,
          source: 'ancestry',
          evidence: `${source} is an ancestor of ${target}`,
        })
      }
    }
    return edges
  }
}

/** The provider operations that actually changed remote state, in the order they were asked. */
export async function acknowledgedBaseWrites(adapter: ProviderAdapter): Promise<number[]> {
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
