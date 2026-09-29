import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MergeAction, MergeMethod, MergeQueueOutcome, MergeQueueState } from '../shared/types'
import { isRecord, runGit, stripTrailingNewline } from './git-core'
import {
  GITHUB_STACKS_API_VERSION,
  GitHubTransportError,
  githubTransport,
} from './github-transport'

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

const MERGE_OUTCOMES: Record<string, MergeQueueOutcome> = {
  queued: 'queued',
  merged: 'merged',
  dropped: 'dropped',
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
    const { data } = await githubTransport().rest<unknown>({
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
  signal?: AbortSignal
}): Promise<AsyncMergeResult> {
  const { data } = await githubTransport().rest<unknown>({
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
  input: { fullName: string; number: number; uuid: string },
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

/** What Git Stacks last asked GitHub to do with a pull request, so a queue outcome is readable later. */
export interface MergeQueueObservation {
  pullRequest: number
  branch: string
  /** The base ref GitHub accepted the enqueue for, which is the ref a queue belongs to. */
  base: string
  headOid: string
  action: MergeAction
  requestedAt: number
  outcome: MergeQueueOutcome
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
      observations.set(value.pullRequest, {
        pullRequest: value.pullRequest,
        branch: value.branch,
        base: value.base,
        headOid: value.headOid,
        action,
        requestedAt: value.requestedAt,
        outcome,
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
 * A queue is proven by an enqueue GitHub accepted. What happened afterwards is read from the
 * pull request itself, because the documentation is explicit that an `enqueued` result is
 * final and does not change when the queue later merges or drops the group. A pull request
 * that reports itself merged was landed; one that was closed without merging was dropped by
 * the queue or closed underneath it; one still open was neither, and GitHub publishes no
 * further state for it, so that fact is shown rather than guessed at.
 */
export function mergeQueueState(
  observation: MergeQueueObservation | undefined,
  pullRequestState: string,
): MergeQueueState | null {
  if (!observation) return null
  const state = pullRequestState.toUpperCase()
  const outcome: MergeQueueOutcome =
    state === 'MERGED' || observation.outcome === 'merged'
      ? 'merged'
      : state === 'CLOSED'
        ? 'dropped'
        : 'queued'
  return {
    configured: true,
    outcome,
    requestedAt: new Date(observation.requestedAt).toISOString(),
  }
}

/** True when GitHub has already accepted a merge-queue enqueue for this base ref. */
export function queueConfiguredFor(
  observations: Map<number, MergeQueueObservation>,
  base: string,
): boolean {
  for (const observation of observations.values()) {
    if (observation.base === base) return true
  }
  return false
}
