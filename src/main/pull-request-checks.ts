import {
  classifyCheckRun,
  classifyCommitStatus,
  deriveCheckRollup,
  safeGitHubUrl,
  summariseChecks,
  type PullRequestCheckDetail,
  type PullRequestCheckRequirement,
  type PullRequestCheckRollup,
  type PullRequestChecksFreshness,
  type PullRequestChecksPermissions,
  type PullRequestChecksRateLimit,
  type PullRequestChecksReport,
  type PullRequestChecksSummary,
} from '../shared/pull-request-checks'
import { getConfigValue, isRecord, parseRemote } from './git-core'
import {
  GitHubTransportError,
  githubTransport,
  type GitHubRateLimit,
  type GitHubRestResponse,
} from './github-transport'

export type {
  PullRequestChecksFreshness,
  PullRequestChecksPermissions,
  PullRequestChecksReport,
} from '../shared/pull-request-checks'

export interface PullRequestChecksOptions {
  /** Read the pull request for its head when the caller has no head commit to offer. */
  headSha?: string | null
  base?: string | null
  signal?: AbortSignal
  /** Ignore the minimum interval between refreshes. It never ignores a backoff. */
  force?: boolean
}

/** Two refreshes closer together than this reuse the last report instead of re-reading. */
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CEILING_MS = 120_000
const MINIMUM_INTERVAL_MS = 15_000
const MAX_CHECK_RUNS = 100
const MAX_WORKFLOW_RUNS = 100

interface CachedReport {
  etags: Map<string, string>
  /** The raw entries per resource, kept so one 304 does not discard the others. */
  sources: { checkRuns: unknown[]; statuses: unknown[]; workflowRuns: unknown[] }
  rateLimit: PullRequestChecksReport['rateLimit']
  checks: PullRequestCheckDetail[]
  rollup: PullRequestCheckRollup
  summary: PullRequestChecksSummary
  headSha: string | null
  base: string | null
  fetchedAt: string
  permissions: PullRequestChecksPermissions
  failures: number
  nextAttemptAt: number
  lastReason: string | null
}

const cache = new Map<string, CachedReport>()

/** Test seam: drops every remembered report so one case cannot read another's. */
export function clearPullRequestChecksCache(): void {
  cache.clear()
}

function key(fullName: string, number: number): string {
  return `${fullName}#${number}`
}

function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_CEILING_MS)
}

/**
 * The validator GitHub returned with this body, when the transport parses response
 * headers. A transport that cannot surface them simply never produces one, and the
 * read stays unconditional rather than sending a validator it never received.
 */
function responseEtag(response: GitHubRestResponse<unknown>): string | null {
  return response.headers instanceof Headers ? response.headers.get('etag') : null
}

/** A read that produced no body, plus the rate-limit metadata GitHub still returned. */
interface CheckRead {
  data: unknown
  etag: string | null
  notModified: boolean
  rateLimit: PullRequestChecksReport['rateLimit']
}

function responseRateLimit(rateLimit: GitHubRateLimit): PullRequestChecksReport['rateLimit'] {
  return { remaining: rateLimit.remaining, reset: rateLimit.reset?.toISOString() ?? null }
}

interface CheckRequest {
  path: string
  etag?: string | null
  signal?: AbortSignal
}

/**
 * One conditional GET. The remembered ETag goes out as `if-none-match` and the
 * returned validator is kept for the next read. A transport that does not surface
 * response headers never gets a validator, so every read stays an unconditional 200.
 *
 * A 304 arrives either as a response or, on a transport that still treats 3xx as
 * failure, as a thrown error carrying the same status. Both mean the remembered body
 * is current; neither means the report is stale, so the caller records when GitHub
 * last confirmed it.
 */
async function conditionalRead(request: CheckRequest): Promise<CheckRead> {
  const transport = githubTransport()
  const headers: Record<string, string> = {}
  if (request.etag) headers['if-none-match'] = request.etag
  try {
    const response = await transport.rest({
      path: request.path,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    return {
      data: response.data,
      etag: responseEtag(response),
      notModified: response.status === 304,
      rateLimit: responseRateLimit(response.rateLimit),
    }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.status === 304) {
      return {
        data: null,
        etag: null,
        notModified: true,
        rateLimit: responseRateLimit(error.rateLimit),
      }
    }
    throw error
  }
}

function checkRunEntries(data: unknown): unknown[] {
  if (!isRecord(data) || !Array.isArray(data.check_runs)) return []
  return data.check_runs
}

function statusEntries(data: unknown): unknown[] {
  if (!isRecord(data)) return []
  return Array.isArray(data.statuses) ? data.statuses : []
}

function workflowRunEntries(data: unknown): unknown[] {
  if (!isRecord(data) || !Array.isArray(data.workflow_runs)) return []
  return data.workflow_runs
}

/**
 * The check contexts a repository requires on its base branch. GitHub answers 403 for
 * anyone without admin read on branch protection and 404 when no rule exists; both
 * mean "unknown", never "none", so every check stays informational-but-unproven.
 */
async function requiredContexts(
  fullName: string,
  base: string | null,
  signal?: AbortSignal,
): Promise<{ known: boolean; contexts: Set<string> }> {
  if (!base) return { known: false, contexts: new Set() }
  try {
    const response = await githubTransport().rest({
      path: `repos/${fullName}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
      ...(signal ? { signal } : {}),
    })
    const data = response.data
    if (!isRecord(data)) return { known: false, contexts: new Set() }
    const contexts = new Set<string>()
    if (Array.isArray(data.contexts)) {
      for (const context of data.contexts) {
        if (typeof context === 'string' && context) contexts.add(context.toLowerCase())
      }
    }
    if (Array.isArray(data.checks)) {
      for (const entry of data.checks) {
        if (isRecord(entry) && typeof entry.context === 'string' && entry.context) {
          contexts.add(entry.context.toLowerCase())
        }
      }
    }
    return { known: true, contexts }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return { known: false, contexts: new Set() }
  }
}

/**
 * Whether GitHub Actions are enabled for the repository. `GET /repos/{o}/{r}/actions/
 * permissions` reports repository policy only, never the viewer's rights.
 */
async function actionsEnabled(fullName: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const { data } = await githubTransport().rest({
      path: `repos/${fullName}/actions/permissions`,
      ...(signal ? { signal } : {}),
    })
    if (!isRecord(data)) return null
    return data.enabled === true
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return null
  }
}

/**
 * Whether the authenticated account may write to the repository. Rerunning a workflow
 * needs the same write role as pushing, and `GET /repos/{o}/{r}` is the only read that
 * reports it; read access alone must not be dressed up as a rerun button.
 */
async function viewerCanWrite(fullName: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const { data } = await githubTransport().rest({
      path: `repos/${fullName}`,
      ...(signal ? { signal } : {}),
    })
    if (!isRecord(data) || !isRecord(data.permissions)) return null
    const role = data.permissions
    return role.push === true || role.maintain === true || role.admin === true
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return null
  }
}

/**
 * Whether the viewer may rerun a workflow. GitHub reports repository policy and the
 * viewer's role in two different reads, and a rerun needs both. An unread answer stays
 * unavailable instead of offering a button that can only fail.
 */
async function actionsPermissions(
  fullName: string,
  signal?: AbortSignal,
): Promise<PullRequestChecksPermissions> {
  const [enabled, canWrite] = await Promise.all([
    actionsEnabled(fullName, signal),
    viewerCanWrite(fullName, signal),
  ])
  if (enabled === false) {
    return {
      actionsEnabled: false,
      canRerun: false,
      reason: 'GitHub Actions are disabled for this repository.',
    }
  }
  if (canWrite === false) {
    return {
      actionsEnabled: enabled === true,
      canRerun: false,
      reason: 'Your role on this repository cannot run workflows, so rerun is unavailable.',
    }
  }
  if (enabled !== true || canWrite !== true) {
    return {
      actionsEnabled: enabled === true,
      canRerun: false,
      reason: 'GitHub did not confirm permission to rerun workflows; rerun stays unavailable.',
    }
  }
  return { actionsEnabled: true, canRerun: true, reason: '' }
}

interface BuiltReport {
  checks: PullRequestCheckDetail[]
  rollup: PullRequestCheckRollup
  summary: PullRequestChecksSummary
}

/**
 * Merge the three sources into one list, deduplicated by what GitHub actually
 * reports. An Actions run and the check run it creates describe the same work, so a
 * run only becomes its own entry when GitHub reported no check run for it.
 */
function buildReport(
  checkRuns: unknown[],
  statuses: unknown[],
  workflowRuns: unknown[],
  requirementKnown: boolean,
  required: Set<string>,
): BuiltReport {
  const checks: PullRequestCheckDetail[] = []
  // An Actions run and the check run it creates are one piece of work, joined by the
  // run URL GitHub puts in the check run's details link.
  const runIdByUrl = new Map<string, number>()
  for (const entry of workflowRuns) {
    if (!isRecord(entry) || typeof entry.id !== 'number') continue
    const details = safeGitHubUrl(entry.html_url)
    if (details) runIdByUrl.set(details, entry.id)
  }

  for (const entry of workflowRuns) {
    if (!isRecord(entry) || typeof entry.id !== 'number') continue
    const details = safeGitHubUrl(entry.html_url)
    if (!details) continue
    const reportedByCheckRun = checkRuns.some((run) => isRecord(run) && run.details_url === details)
    // A run GitHub already reported as a check run is that run, not a second check.
    if (reportedByCheckRun) continue
    const name = typeof entry.name === 'string' && entry.name ? entry.name : 'Workflow run'
    checks.push({
      key: `workflow-run:${entry.id}`,
      name,
      source: 'workflow-run',
      app: 'github-actions',
      state: classifyCheckRun(entry.status, entry.conclusion),
      requirement: requirementKnown ? classifyRequirement(name, required) : 'unknown',
      summary: typeof entry.run_number === 'number' ? `Run #${entry.run_number}` : null,
      detailsUrl: details,
      startedAt: typeof entry.run_started_at === 'string' ? entry.run_started_at : null,
      completedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      workflowRunId: entry.id,
      expected: false,
    })
  }

  for (const entry of checkRuns) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue
    const app = isRecord(entry.app) && typeof entry.app.slug === 'string' ? entry.app.slug : null
    const details = safeGitHubUrl(entry.details_url)
    const id = typeof entry.id === 'number' ? entry.id : null
    checks.push({
      key: id === null ? `check-run:${entry.name}` : `check-run:${id}`,
      name: entry.name,
      source: 'check-run',
      app,
      state: classifyCheckRun(entry.status, entry.conclusion),
      requirement: requirementKnown ? classifyRequirement(entry.name, required) : 'unknown',
      summary:
        isRecord(entry.output) && typeof entry.output.title === 'string'
          ? entry.output.title
          : null,
      detailsUrl: details,
      startedAt: typeof entry.started_at === 'string' ? entry.started_at : null,
      completedAt: typeof entry.completed_at === 'string' ? entry.completed_at : null,
      workflowRunId: details ? (runIdByUrl.get(details) ?? null) : null,
      expected: false,
    })
  }

  for (const entry of statuses) {
    if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
    const state = classifyCommitStatus(entry.state)
    checks.push({
      key: `commit-status:${entry.context}`,
      name: entry.context,
      source: 'commit-status',
      app: null,
      state,
      requirement: requirementKnown ? classifyRequirement(entry.context, required) : 'unknown',
      summary:
        typeof entry.description === 'string' && entry.description ? entry.description : null,
      detailsUrl: safeGitHubUrl(entry.target_url),
      startedAt: null,
      completedAt: null,
      workflowRunId: null,
      expected: false,
    })
  }

  if (requirementKnown) {
    for (const context of required) {
      if (checks.some((check) => check.name.toLowerCase() === context)) continue
      // GitHub lists this context as required but has reported nothing for it yet.
      checks.push({
        key: `expected:${context}`,
        name: context,
        source: 'expected',
        app: null,
        state: 'waiting',
        requirement: 'required',
        summary: 'Expected: waiting for this check to report',
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        workflowRunId: null,
        expected: true,
      })
    }
  }

  return {
    checks,
    rollup: deriveCheckRollup(checks),
    summary: summariseChecks(checks),
  }
}

function classifyRequirement(name: string, required: Set<string>): PullRequestCheckRequirement {
  return required.has(name.trim().toLowerCase()) ? 'required' : 'informational'
}

function failureReport(
  number: number,
  headSha: string | null,
  base: string | null,
  error: unknown,
  remembered: CachedReport | null,
): PullRequestChecksReport {
  const rateLimit =
    error instanceof GitHubTransportError
      ? {
          remaining: error.rateLimit.remaining,
          reset: error.rateLimit.reset?.toISOString() ?? null,
        }
      : { remaining: null, reset: null }
  if (remembered) {
    return {
      number,
      headSha: remembered.headSha,
      base: remembered.base,
      available: true,
      message: describeFailure(error),
      checks: remembered.checks,
      rollup: remembered.rollup,
      summary: remembered.summary,
      fetchedAt: remembered.fetchedAt,
      checkedAt: remembered.fetchedAt,
      freshness: 'stale',
      staleReason: describeFailure(error),
      rateLimit,
      nextAttemptAt: new Date(remembered.nextAttemptAt).toISOString(),
      permissions: remembered.permissions,
    }
  }
  return {
    number,
    headSha,
    base,
    available: false,
    message: describeFailure(error),
    checks: [],
    rollup: deriveCheckRollup([]),
    summary: 'none',
    fetchedAt: null,
    checkedAt: null,
    freshness: 'stale',
    staleReason: describeFailure(error),
    rateLimit,
    nextAttemptAt: null,
    permissions: { actionsEnabled: false, canRerun: false, reason: '' },
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof GitHubTransportError) {
    if (error.kind === 'rate-limited' || error.kind === 'secondary-rate-limit') {
      return `Checks could not be refreshed: GitHub's rate limit was reached (${error.detail})`
    }
    if (error.kind === 'unauthorized') {
      return 'Checks could not be refreshed: GitHub authentication is required.'
    }
    if (error.kind === 'forbidden') {
      return `Checks could not be refreshed: GitHub refused the read (${error.detail})`
    }
    if (error.kind === 'cancelled') return 'Checks refresh was cancelled.'
    return `Checks could not be refreshed: ${error.detail}`
  }
  return `Checks could not be refreshed: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * Read the detailed checks for one pull request head.
 *
 * The read is conditional per resource (check runs, commit status, workflow runs) and
 * rate-limited twice over: a minimum interval between refreshes, and an exponential
 * backoff after a failure that remembers the last good report. Every path that serves
 * remembered data says so through `freshness`, so the UI can show it as stale rather
 * than as current.
 */
export async function getPullRequestChecks(
  repoPath: string,
  number: number,
  options: PullRequestChecksOptions = {},
): Promise<PullRequestChecksReport> {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('Pull request number must be a positive integer')
  }
  const remote = parseRemote(await getConfigValue(repoPath, 'remote.origin.url'))
  if (!remote || remote.host !== 'github.com') {
    throw new Error('Pull request integration requires a github.com origin remote.')
  }
  const fullName = remote.fullName
  const cacheKey = key(fullName, number)
  const remembered = cache.get(cacheKey) ?? null
  const now = Date.now()

  let headSha = options.headSha ?? null
  let base = options.base ?? null
  if (!headSha) {
    try {
      const response = await githubTransport().rest({
        path: `repos/${fullName}/pulls/${number}`,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const data = response.data
      if (!isRecord(data) || !isRecord(data.head) || typeof data.head.sha !== 'string') {
        throw new Error('GitHub returned a pull request without a head commit')
      }
      headSha = data.head.sha
      if (isRecord(data.base) && typeof data.base.ref === 'string') base = data.base.ref
    } catch (error) {
      if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
      // The last head this view resolved is still worth showing, marked stale, rather
      // than discarding a report because one lookup failed.
      if (!remembered?.headSha) throw error
      headSha = remembered.headSha
      base = base ?? remembered.base
    }
  }
  // A report for a head that has since moved describes work that is no longer current.
  if (remembered && remembered.headSha && headSha && remembered.headSha !== headSha) {
    cache.delete(cacheKey)
    return getPullRequestChecks(repoPath, number, { ...options, headSha, base, force: true })
  }

  if (remembered) {
    // Backoff outranks a forced refresh. Asking sooner is a user preference; asking
    // again after GitHub said to wait is the behaviour the backoff exists to stop, so
    // the last good report is served as stale with the reason instead.
    if (now < remembered.nextAttemptAt) {
      return reportFrom(
        remembered,
        number,
        base,
        'stale',
        remembered.lastReason ??
          'GitHub asked Git Stacks to wait before reading these checks again.',
      )
    }
    if (!options.force && now - Date.parse(remembered.fetchedAt) < MINIMUM_INTERVAL_MS) {
      return reportFrom(remembered, number, base, 'cached', null)
    }
  }

  try {
    const commitPath = `repos/${fullName}/commits/${encodeURIComponent(headSha)}`
    const checkRuns = await conditionalRead({
      path: `${commitPath}/check-runs?per_page=${MAX_CHECK_RUNS}`,
      etag: remembered?.etags.get('check-runs'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const status = await conditionalRead({
      path: `${commitPath}/status?per_page=${MAX_CHECK_RUNS}`,
      etag: remembered?.etags.get('status'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const workflowRuns = await conditionalRead({
      path: `repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=${MAX_WORKFLOW_RUNS}`,
      etag: remembered?.etags.get('workflow-runs'),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const rateLimit = checkRuns.rateLimit

    if (checkRuns.notModified && status.notModified && workflowRuns.notModified && remembered) {
      const confirmed: CachedReport = {
        ...remembered,
        rateLimit,
        failures: 0,
        nextAttemptAt: 0,
        lastReason: null,
      }
      cache.set(cacheKey, confirmed)
      return reportFrom(confirmed, number, base, 'not-modified', null)
    }

    // A resource that answered 304 keeps the entries this head was last seen with.
    const sources = {
      checkRuns: checkRuns.notModified
        ? (remembered?.sources.checkRuns ?? [])
        : checkRunEntries(checkRuns.data),
      statuses: status.notModified
        ? (remembered?.sources.statuses ?? [])
        : statusEntries(status.data),
      workflowRuns: workflowRuns.notModified
        ? (remembered?.sources.workflowRuns ?? [])
        : workflowRunEntries(workflowRuns.data),
    }
    const requirement = await requiredContexts(fullName, base, options.signal)
    const built = buildReport(
      sources.checkRuns,
      sources.statuses,
      sources.workflowRuns,
      requirement.known,
      requirement.contexts,
    )
    const permissions = await actionsPermissions(fullName, options.signal)
    const etags = new Map(remembered?.etags ?? [])
    if (checkRuns.etag) etags.set('check-runs', checkRuns.etag)
    if (status.etag) etags.set('status', status.etag)
    if (workflowRuns.etag) etags.set('workflow-runs', workflowRuns.etag)
    const entry: CachedReport = {
      etags,
      sources,
      rateLimit,
      checks: built.checks,
      rollup: built.rollup,
      summary: built.summary,
      headSha,
      base,
      fetchedAt: new Date().toISOString(),
      permissions,
      failures: 0,
      nextAttemptAt: 0,
      lastReason: null,
    }
    cache.set(cacheKey, entry)
    return reportFrom(entry, number, base, 'live', null)
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    if (!remembered) return failureReport(number, headSha, base, error, null)
    // The last good report is kept and dated, not thrown away: a refresh that failed
    // is not evidence that the checks stopped existing. It is served as stale with the
    // delay before the next attempt, so a caller cannot turn a failure into a poll.
    const failed: CachedReport = {
      ...remembered,
      failures: remembered.failures + 1,
      nextAttemptAt: Date.now() + backoffDelay(remembered.failures + 1),
      lastReason: describeFailure(error),
    }
    cache.set(cacheKey, failed)
    return failureReport(number, remembered.headSha, remembered.base, error, failed)
  }
}

function reportFrom(
  entry: CachedReport,
  number: number,
  base: string | null,
  freshness: PullRequestChecksFreshness,
  staleReason: string | null,
): PullRequestChecksReport {
  return {
    number,
    headSha: entry.headSha,
    base: base ?? entry.base,
    available: true,
    message: '',
    checks: entry.checks,
    rollup: entry.rollup,
    summary: entry.summary,
    fetchedAt: entry.fetchedAt,
    checkedAt:
      freshness === 'not-modified' || freshness === 'live'
        ? new Date().toISOString()
        : entry.fetchedAt,
    freshness,
    staleReason: staleReason ?? entry.lastReason,
    rateLimit: entry.rateLimit,
    nextAttemptAt: entry.nextAttemptAt > 0 ? new Date(entry.nextAttemptAt).toISOString() : null,
    permissions: entry.permissions,
  }
}

/**
 * Rerun one Actions workflow run behind a pull request's checks. This is a mutation, so
 * it re-proves at the boundary what the button claimed: the report is re-read, the run
 * must still belong to this head, and the viewer must still be allowed to run it.
 */
export async function rerunPullRequestCheck(
  repoPath: string,
  number: number,
  runId: number,
  options: { headSha?: string | null; signal?: AbortSignal } = {},
): Promise<PullRequestChecksReport> {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error('Pull request number must be a positive integer')
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('Workflow run id must be a positive integer')
  }
  const remote = parseRemote(await getConfigValue(repoPath, 'remote.origin.url'))
  if (!remote || remote.host !== 'github.com') {
    throw new Error('Pull request integration requires a github.com origin remote.')
  }
  const fullName = remote.fullName
  // A rerun is a mutation, so the report behind the button is re-read and the run has
  // to be proved against a read GitHub confirmed in this call. A cached or stale report
  // is not proof: it may name a run that has since been replaced on this head.
  const report = await getPullRequestChecks(repoPath, number, { ...options, force: true })
  if (!report.available) {
    throw new Error(
      `Could not re-read this pull request's checks before rerunning: ${report.message}`,
    )
  }
  if (report.freshness !== 'live' && report.freshness !== 'not-modified') {
    throw new Error(
      report.staleReason
        ? `Could not confirm this pull request's checks before rerunning: ${report.staleReason}`
        : 'Could not confirm this pull request’s checks before rerunning. Refresh and try again.',
    )
  }
  const check = report.checks.find((entry) => entry.workflowRunId === runId)
  if (!check) {
    throw new Error('That workflow run no longer belongs to this pull request head.')
  }
  if (!report.permissions.canRerun) {
    throw new Error(report.permissions.reason || 'Rerunning workflows is not permitted here.')
  }
  try {
    await githubTransport().rest({
      method: 'POST',
      path: `repos/${fullName}/actions/runs/${runId}/rerun`,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof GitHubTransportError) throw new Error(describeFailure(error))
    throw error
  }
  cache.delete(key(fullName, number))
  return getPullRequestChecks(repoPath, number, { ...options, force: true })
}
