import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  MergeAction,
  MergeQueueEntry,
  MergeMethod,
  MergeQueueOutcome,
  MergeQueueState,
  MergeRequestOutcome,
} from '../shared/types'
import { runGit, stripTrailingNewline } from './git-core'
import { isRecord } from '../shared/guards'
import {
  GITHUB_STACKS_API_VERSION,
  GitHubTransportError,
  githubTransport,
  type GitHubTransport,
} from './github-transport'
import { hostTransport, type GitHubHostContext } from './github-host'

/**
 * What GitHub reports about one pull request's own merge-queue membership, read from the
 * GraphQL fields the schema documents: `isMergeQueueEnabled` for the base ref's capability and
 * `isInMergeQueue` with the entry itself for the pull request. Nothing here is derived from an
 * earlier enqueue, because an enqueue records acceptance and nothing about what the queue did
 * with the request afterwards.
 *
 * Every field is nullable. A host whose schema does not carry them, a refused credential, and a
 * malformed answer are all the same truthful answer here: unknown, never `not-queued`.
 */
export interface MergeQueueRead {
  /** True only when GitHub reports a merge queue enabled for this pull request's base ref. */
  enabled: boolean | null
  /** GitHub's own membership answer, or null when this read could not establish one. */
  membership: 'queued' | 'not-queued' | null
  /** The entry GitHub reports with a membership, which names the place in the queue. */
  entry: MergeQueueEntry | null
  /** The head and base this read observed, which fence the membership to one reviewed request. */
  headOid: string | null
  base: string | null
}

const UNKNOWN_QUEUE_READ: MergeQueueRead = {
  enabled: null,
  membership: null,
  entry: null,
  headOid: null,
  base: null,
}

const MERGE_QUEUE_FIELDS =
  'isMergeQueueEnabled isInMergeQueue mergeQueueEntry { position state enqueuedAt }'

/** The states GitHub's schema documents for a merge queue entry, and nothing else. */
const MERGE_QUEUE_ENTRY_STATES: Record<string, true> = {
  AWAITING_CHECKS: true,
  LOCKED: true,
  MERGEABLE: true,
  QUEUED: true,
  UNMERGEABLE: true,
}

/** The `DateTime` scalar as GitHub documents it: ISO-8601, with a UTC designator. */
const ISO_UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]00:00)$/u

/**
 * An entry a read reports, or null when what arrived is not one this build can stand behind.
 *
 * A position counts from one, a state is one of the enum's own values, and an enqueue time is
 * the ISO-8601 UTC string GitHub's `DateTime` scalar documents — not any string JavaScript
 * happens to read as a date. An entry that fails any of those is not a queue position to show,
 * and the membership that came with it stands on its own: the pull request is in the queue
 * either way, and the place in it is simply not known yet.
 */
function parseQueueEntry(value: unknown): MergeQueueEntry | null {
  if (!isRecord(value)) return null
  const { position, state, enqueuedAt } = value
  if (
    typeof position !== 'number' ||
    !Number.isInteger(position) ||
    position < 1 ||
    typeof state !== 'string' ||
    !Object.hasOwn(MERGE_QUEUE_ENTRY_STATES, state) ||
    typeof enqueuedAt !== 'string' ||
    !ISO_UTC_DATE_TIME.test(enqueuedAt) ||
    Number.isNaN(Date.parse(enqueuedAt))
  ) {
    return null
  }
  return { position, state, enqueuedAt }
}

/**
 * Read one pull request's merge-queue membership from the host that owns the repository. The
 * read never fails the caller: a host that cannot answer leaves queue state unknown, which is
 * reported as unconfirmed rather than as a queue that dropped the pull request.
 */
export async function readMergeQueueRead(input: {
  fullName: string
  number: number
  host?: GitHubHostContext
  signal?: AbortSignal
}): Promise<MergeQueueRead> {
  const [owner, name] = input.fullName.split('/')
  if (!owner || !name || !Number.isInteger(input.number) || input.number <= 0) {
    return UNKNOWN_QUEUE_READ
  }
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        headRefOid
        number
        baseRefName
        ${MERGE_QUEUE_FIELDS}
      }
    }
  }`
  try {
    const value = await mergeTransport(input.host).graphql(
      query,
      {
        owner,
        name,
        number: input.number,
      },
      input.signal ? { signal: input.signal } : {},
    )
    const repository = isRecord(value) ? value.repository : null
    const node = isRecord(repository) ? repository.pullRequest : null
    if (!isRecord(node) || node.number !== input.number) return UNKNOWN_QUEUE_READ
    const headOid = typeof node.headRefOid === 'string' ? node.headRefOid : null
    const base = typeof node.baseRefName === 'string' ? node.baseRefName : null
    const enabled = typeof node.isMergeQueueEnabled === 'boolean' ? node.isMergeQueueEnabled : null
    const membership =
      typeof node.isInMergeQueue === 'boolean'
        ? node.isInMergeQueue
          ? ('queued' as const)
          : ('not-queued' as const)
        : null
    if (enabled === null && membership === null) return { ...UNKNOWN_QUEUE_READ, headOid, base }
    return {
      enabled,
      membership,
      entry: membership === 'queued' ? parseQueueEntry(node.mergeQueueEntry) : null,
      headOid,
      base,
    }
  } catch {
    // A refused schema, a denied credential, or an answer this build cannot read leaves the
    // membership unknown. Reporting it as a removal would invent a queue decision GitHub
    // never published.
    return UNKNOWN_QUEUE_READ
  }
}

/**
 * The transport a merge request and its result reads travel on. A request is made
 * against the pull request the review was read from, so the request, its polling,
 * and a later resume of that request all have to reach the same host; a hostless
 * global transport would send them to github.com instead.
 */
function mergeTransport(host: GitHubHostContext | undefined): GitHubTransport {
  return host ? hostTransport(host) : githubTransport()
}

/**
 * GitHub's asynchronous merge API, which is the only documented way to land a pull request
 * that belongs to a stack, and the merge-queue view that goes with it.
 *
 * A merge request answers `pending` with a UUID, and the UUID's result is polled until it
 * reaches one of the documented terminal states. `enqueued` is terminal for a merge-queue
 * request: it means the pull request joined a queue, not that it merged, so the caller has
 * to read the pull request itself to learn what the queue did later.
 */

export const ASYNC_MERGE_HEADERS = {
  'X-GitHub-Api-Version': GITHUB_STACKS_API_VERSION,
}

export type AsyncMergeStatus = 'pending' | 'merged' | 'enqueued' | 'failed'

export interface AsyncMergeResult {
  status: AsyncMergeStatus
  uuid: string | null
  /** The failure text GitHub reported, or the note on a pending or enqueued result. */
  message: string | null
  mergeMethod: MergeMethod | null
  mergeAction: MergeAction | null
  expectedHeadSha: string | null
  /** The merge commit on a `merged` result. */
  mergeOid: string | null
}

const MERGE_METHODS: Record<string, MergeMethod> = {
  merge: 'merge',
  squash: 'squash',
  rebase: 'rebase',
}

const MERGE_ACTIONS: Record<string, MergeAction> = {
  default: 'default',
  direct_merge: 'direct_merge',
  merge_queue: 'merge_queue',
}

const MERGE_OUTCOMES: Record<string, MergeRequestOutcome> = {
  pending: 'pending',
  merged: 'merged',
  enqueued: 'enqueued',
  failed: 'failed',
  // Journal files written before the request outcome and the enqueue were separated.
  queued: 'enqueued',
  dropped: 'failed',
}

/** Read the documented merge-async result envelope, or null when GitHub sent something else. */
export function parseAsyncMergeResult(value: unknown): AsyncMergeResult | null {
  if (!isRecord(value)) return null
  const status = value.status
  if (status !== 'pending' && status !== 'merged' && status !== 'enqueued' && status !== 'failed') {
    return null
  }
  const details = isRecord(value.details) ? value.details : null
  const detail: Record<string, string> = {}
  if (details) {
    for (const [key, raw] of Object.entries(details)) {
      if (typeof raw === 'string' && raw) detail[key] = raw
    }
  }
  return {
    status,
    uuid: detail.uuid ?? null,
    message: detail.message ?? null,
    mergeMethod: MERGE_METHODS[detail.merge_method ?? ''] ?? null,
    mergeAction: MERGE_ACTIONS[detail.merge_action ?? ''] ?? null,
    expectedHeadSha: detail.expected_head_sha ?? null,
    mergeOid: detail.sha ?? null,
  }
}

export interface AsyncMergeStart {
  kind: 'result' | 'conflict'
  result: AsyncMergeResult
}

/**
 * Ask GitHub to land one pull request. The `sha` is the head the caller reviewed: GitHub
 * cancels the merge when the head is pushed in between, so a stale request cannot land
 * commits nobody looked at.
 */
export async function startAsyncMerge(input: {
  fullName: string
  number: number
  sha: string
  mergeMethod: MergeMethod | null
  mergeAction: MergeAction
  host?: GitHubHostContext
  signal?: AbortSignal
}): Promise<AsyncMergeStart> {
  const body: Record<string, unknown> = {
    sha: input.sha,
    merge_action: input.mergeAction,
  }
  // The merge method only applies to a direct merge; a queued merge runs the repository's
  // own settings, and sending one is not a request GitHub documents it will honour.
  if (input.mergeMethod && input.mergeAction === 'direct_merge') {
    body.merge_method = input.mergeMethod
  }
  try {
    const { data } = await mergeTransport(input.host).rest<unknown>({
      method: 'PUT',
      path: `repos/${input.fullName}/pulls/${input.number}/merge-async`,
      headers: ASYNC_MERGE_HEADERS,
      body,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    const result = parseAsyncMergeResult(data)
    if (!result) throw new Error('GitHub returned an invalid asynchronous merge result')
    return { kind: 'result', result }
  } catch (error) {
    // 409 means GitHub already holds a merge request for this pull request and hands back
    // that request's own identity. Adopting it is the only safe answer: issuing a second
    // request would race a merge this client never reviewed.
    const conflict = conflictResult(error)
    if (conflict) return { kind: 'conflict', result: conflict }
    throw error
  }
}

/**
 * A `409` response carries the enqueued request's own UUID and options, which is the only
 * way to tell an existing merge request apart from one this client would have made.
 */
function conflictResult(error: unknown): AsyncMergeResult | null {
  if (!(error instanceof GitHubTransportError) || error.status !== 409) return null
  const result = parseAsyncMergeResult(error.body)
  return result && result.uuid ? result : null
}

/** Read the current result of one asynchronous merge request. */
export async function readAsyncMerge(input: {
  fullName: string
  number: number
  uuid: string
  host?: GitHubHostContext
  signal?: AbortSignal
}): Promise<AsyncMergeResult> {
  const { data } = await mergeTransport(input.host).rest<unknown>({
    path: `repos/${input.fullName}/pulls/${input.number}/merge-async/${encodeURIComponent(input.uuid)}`,
    headers: ASYNC_MERGE_HEADERS,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const result = parseAsyncMergeResult(data)
  if (!result) throw new Error('GitHub returned an invalid asynchronous merge result')
  return result
}

export interface PollOptions {
  signal?: AbortSignal
  /** Bounded so a stuck merge cannot hold the repository's write queue open forever. */
  maxAttempts?: number
  intervalMs?: number
  onUpdate?: (result: AsyncMergeResult) => void
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Poll one asynchronous merge request until GitHub reports a terminal result. A run that
 * exhausts its attempts returns the last `pending` result rather than a failure: GitHub is
 * still working, and the caller has to say so instead of calling it merged or failed.
 */
export async function pollAsyncMerge(
  input: { fullName: string; number: number; uuid: string; host?: GitHubHostContext },
  options: PollOptions = {},
): Promise<AsyncMergeResult> {
  const maxAttempts = options.maxAttempts ?? 12
  const intervalMs = options.intervalMs ?? 500
  const sleep = options.sleep ?? defaultSleep
  let result: AsyncMergeResult = {
    status: 'pending',
    uuid: input.uuid,
    message: null,
    mergeMethod: null,
    mergeAction: null,
    expectedHeadSha: null,
    mergeOid: null,
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.signal?.aborted) break
    await sleep(Math.min(intervalMs * (attempt + 1), 4_000))
    result = await readAsyncMerge({
      ...input,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    options.onUpdate?.(result)
    if (result.status !== 'pending') return result
  }
  return result
}

/**
 * What Git Stacks last asked GitHub to do with a pull request.
 *
 * `request` is the identity GitHub handed back: the pull request whose endpoint serves the
 * result, and the UUID. One request covers every layer it carried, so those layers share
 * this identity and the result is read once, from the endpoint that owns it, and applied to
 * all of them. `enqueuedAt` is kept apart from the outcome because an accepted enqueue is the
 * only evidence that a base ref has a merge queue, while the outcome of any request is not.
 */
export interface MergeQueueObservation {
  pullRequest: number
  branch: string
  /** The base ref GitHub accepted the request for, which is the ref a queue belongs to. */
  base: string
  headOid: string
  action: MergeAction
  method: MergeMethod | null
  request: { pullRequest: number; uuid: string } | null
  /** Set when GitHub reported that it accepted an enqueue for this base ref. */
  enqueuedAt: number | null
  requestedAt: number
  outcome: MergeRequestOutcome
  /** GitHub's message for a terminal result, kept so a reopen does not need the request. */
  message: string | null
  /**
   * The pull request's state as last observed by this reader. Retain confirmed
   * outcomes across failed reads instead of reverting to the earlier enqueue.
   */
  confirmed: 'merged' | 'dropped' | null
  /**
   * GitHub's last confirmed queue membership for this pull request, and the entry it
   * reported with it. Retained so a read that cannot reach GitHub keeps what a read
   * confirmed instead of turning an unknown into a removal.
   */
  membership: 'queued' | 'not-queued' | null
  entry: MergeQueueEntry | null
}

async function observationPath(repoPath: string): Promise<string> {
  const commonDir = stripTrailingNewline(await runGit(repoPath, ['rev-parse', '--git-common-dir']))
  return path.resolve(repoPath, commonDir, 'git-stacks-merge-queue.json')
}

export async function readMergeObservations(
  repoPath: string,
): Promise<Map<number, MergeQueueObservation>> {
  const observations = new Map<number, MergeQueueObservation>()
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(await observationPath(repoPath), 'utf8'))
    if (!isRecord(parsed)) return observations
    for (const value of Object.values(parsed)) {
      if (
        !isRecord(value) ||
        typeof value.pullRequest !== 'number' ||
        typeof value.branch !== 'string' ||
        typeof value.base !== 'string' ||
        typeof value.headOid !== 'string' ||
        typeof value.requestedAt !== 'number'
      ) {
        continue
      }
      const action = MERGE_ACTIONS[typeof value.action === 'string' ? value.action : ''] ?? null
      const outcome = MERGE_OUTCOMES[typeof value.outcome === 'string' ? value.outcome : '']
      if (!action || !outcome) continue
      const method = MERGE_METHODS[typeof value.method === 'string' ? value.method : ''] ?? null
      const request = isRecord(value.request) ? value.request : null
      observations.set(value.pullRequest, {
        pullRequest: value.pullRequest,
        branch: value.branch,
        base: value.base,
        headOid: value.headOid,
        action,
        method,
        // A journal written before the owning pull request was kept alongside the UUID read
        // the request from the layer it observed, which was the request's own pull request
        // back when one request covered one layer.
        request:
          request && typeof request.uuid === 'string' && typeof request.pullRequest === 'number'
            ? { pullRequest: request.pullRequest, uuid: request.uuid }
            : typeof value.uuid === 'string' && value.uuid
              ? { pullRequest: value.pullRequest, uuid: value.uuid }
              : null,
        enqueuedAt: typeof value.enqueuedAt === 'number' ? value.enqueuedAt : null,
        requestedAt: value.requestedAt,
        outcome,
        message: typeof value.message === 'string' && value.message ? value.message : null,
        confirmed:
          value.confirmed === 'merged' || value.confirmed === 'dropped' ? value.confirmed : null,
        membership:
          value.membership === 'queued' || value.membership === 'not-queued'
            ? value.membership
            : null,
        entry: parseQueueEntry(value.entry),
      })
    }
  } catch {
    // An absent or unreadable journal means this repository has no remembered merge request.
  }
  return observations
}

export async function recordMergeObservation(
  repoPath: string,
  observation: MergeQueueObservation,
): Promise<void> {
  const target = await observationPath(repoPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const current = await readMergeObservations(repoPath)
  current.set(observation.pullRequest, observation)
  const payload: Record<string, MergeQueueObservation> = {}
  for (const [key, value] of current.entries()) payload[String(key)] = value
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
}

/**
 * Read the merge-queue state of a pull request from what GitHub actually reported.
 *
 * GitHub's own membership read decides it: a pull request the queue holds is `queued`, and one
 * it does not hold is `dropped`, whether it was ejected or closed. The terminal enqueue result
 * only proves a queue accepted the request, so it supplies the requested time and never the
 * membership. A read that could not answer leaves the last confirmed membership in place and
 * marks it stale, because an unknown is not a removal.
 *
 * A merged or closed pull request outranks membership: it has left the queue whatever the
 * entry says. Membership is only this observation's state while every identity a read reported
 * still matches the reviewed request. A read that names a different head or base — including
 * one that could not answer the queue fields — describes something else, so nothing is applied
 * and nothing is carried forward; an identity no read could report leaves the last confirmed
 * membership in place, because an unknown is not a removal.
 */
export function mergeQueueState(
  observation: MergeQueueObservation | undefined,
  pullRequestState: string,
  read: MergeQueueRead = UNKNOWN_QUEUE_READ,
  current: { headOid: string | null; base: string | null } | null = null,
): MergeQueueState | null {
  if (!observation) return null
  const state = pullRequestState.toUpperCase()
  // What a read confirmed outranks the request it confirmed it from, including when this
  // read could not reach GitHub at all: an unreadable pull request is not a queue that
  // somehow took the group back.
  const merged = state === 'MERGED' || observation.confirmed === 'merged'
  // Both identities are checked, not just the one that came with the membership. A pull
  // request whose head moved or whose base was retargeted has left the request this
  // observation describes, so its membership is neither applied nor retained.
  const mismatched =
    (read.headOid !== null && read.headOid !== observation.headOid) ||
    (read.base !== null && read.base !== observation.base) ||
    (current !== null &&
      ((current.headOid !== null && current.headOid !== observation.headOid) ||
        (current.base !== null && current.base !== observation.base)))
  // New membership is only evidence about this request when the membership read proved the
  // captured head and base itself. Another read's identity is never borrowed to fill in the
  // one this answer left out: a head read before a retarget says nothing about a base read
  // afterwards. An answer that proves no pair is no evidence about this request at all, so
  // it can neither replace the remembered membership nor remove it.
  const applies =
    read.membership !== null &&
    read.headOid === observation.headOid &&
    read.base === observation.base &&
    !mismatched
  const retained = !mismatched && !applies
  const membership = applies ? read.membership : retained ? observation.membership : null
  const entry = applies ? read.entry : retained ? observation.entry : null

  const outcome: MergeQueueOutcome = merged
    ? 'merged'
    : state === 'CLOSED' || observation.confirmed === 'dropped'
      ? 'dropped'
      : membership === 'queued'
        ? 'queued'
        : membership === 'not-queued'
          ? 'dropped'
          : observation.outcome === 'pending'
            ? 'pending'
            : 'unconfirmed'
  return {
    configured: observation.enqueuedAt !== null || read.enabled === true,
    outcome,
    requestedAt: new Date(observation.requestedAt).toISOString(),
    membership,
    entry: membership === 'queued' ? entry : null,
    stale: retained && observation.membership !== null,
  }
}

/**
 * Read what GitHub now reports for a request this client already made. Nothing is submitted:
 * the result is read through the identity GitHub returned, from the endpoint of the pull
 * request that owns it, because that is the only endpoint that serves it.
 */
export async function readMergeRequest(input: {
  fullName: string
  request: { pullRequest: number; uuid: string }
  host?: GitHubHostContext
}): Promise<AsyncMergeResult | null> {
  try {
    return await readAsyncMerge({
      fullName: input.fullName,
      number: input.request.pullRequest,
      uuid: input.request.uuid,
      ...(input.host ? { host: input.host } : {}),
    })
  } catch {
    // The result is retained for 24 hours and then the endpoint answers 404. A request this
    // client can no longer read is reported through the pull request itself instead.
    return null
  }
}

/**
 * True only when GitHub has accepted an enqueue for this base ref. A request that is still
 * running, or a direct merge that exceeded the polling bound, is no evidence of a queue.
 */
export function queueConfiguredFor(
  observations: Map<number, MergeQueueObservation>,
  base: string,
): boolean {
  for (const observation of observations.values()) {
    if (observation.base === base && observation.enqueuedAt !== null) return true
  }
  return false
}
