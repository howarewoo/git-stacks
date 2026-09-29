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
const MAX_STATUSES = 100

/** GitHub's own app id for Actions, the app every workflow run and its check run report. */
const ACTIONS_APP_ID = 15368

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
  /** True when a resource reported more pages than the bounded read followed. */
  truncated: boolean
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

/** The most pages one resource read follows before it admits it stopped early. */
const MAX_PAGES = 10

interface PagedResult {
  entries: unknown[]
  notModified: boolean
  etag: string | null
  rateLimit: GitHubRateLimitLike
  truncated: boolean
}

interface GitHubRateLimitLike {
  remaining: number | null
  reset: string | null
}

/**
 * Follow a REST list to its end, one bounded page at a time.
 *
 * A first page short of `perPage` is the whole list, so an ordinary read costs one
 * request. A full page means there may be more, and the read follows until GitHub
 * returns a short page or the page bound is reached. Reaching the bound is reported as
 * truncation rather than passed off as a complete list: a head with thousands of
 * check runs is unusual, and a silent cut would be a lie about what was inspected.
 *
 * The conditional validator belongs to the first page. A later page answering 304 is
 * not a question GitHub answers, so it is read unconditionally rather than treated as
 * proof that the remaining pages are current.
 */
async function readAllPages(
  path: string,
  options: {
    perPage: number
    etag?: string | null
    pick: (data: unknown) => unknown[]
    signal?: AbortSignal
  },
): Promise<PagedResult> {
  const separator = path.includes('?') ? '&' : '?'
  const entries: unknown[] = []
  let first: CheckRead | null = null
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const read = await conditionalRead({
      path: `${path}${separator}per_page=${options.perPage}&page=${page}`,
      ...(page === 1 ? { etag: options.etag ?? null } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (page === 1) {
      first = read
      if (read.notModified) {
        return {
          entries: [],
          notModified: true,
          etag: read.etag,
          rateLimit: read.rateLimit,
          truncated: false,
        }
      }
    }
    const pageEntries = options.pick(read.data)
    entries.push(...pageEntries)
    if (pageEntries.length < options.perPage) break
    if (page === MAX_PAGES) truncated = true
  }
  return {
    entries,
    notModified: false,
    etag: first?.etag ?? null,
    rateLimit: first?.rateLimit ?? { remaining: null, reset: null },
    truncated,
  }
}

/**
 * The pull request's own current head and base. A mutation proves identity through this
 * read, never through a value the renderer supplied earlier.
 */
async function readPullRequestIdentity(
  fullName: string,
  number: number,
  signal?: AbortSignal,
): Promise<{ headSha: string; base: string | null }> {
  const response = await githubTransport().rest({
    path: `repos/${fullName}/pulls/${number}`,
    ...(signal ? { signal } : {}),
  })
  const data = response.data
  if (!isRecord(data) || !isRecord(data.head) || typeof data.head.sha !== 'string') {
    throw new Error('GitHub returned a pull request without a head commit')
  }
  return {
    headSha: data.head.sha,
    base: isRecord(data.base) && typeof data.base.ref === 'string' ? data.base.ref : null,
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
 * The checks a repository requires, and whether that answer is complete.
 *
 * Two APIs can make a check required, and a read that ignores the second one is not
 * evidence that a check is optional. Legacy branch protection reports required
 * contexts, each optionally bound to a reporting app; repository rulesets can require
 * checks that appear nowhere in branch protection. So both are read, a ruleset
 * requirement is only claimed when the ruleset that declares it is the base branch's
 * own, and any read that does not succeed leaves the whole answer `unknown` rather
 * than presenting the checks it did read as the complete required set.
 */
async function requiredContexts(
  fullName: string,
  base: string | null,
  signal?: AbortSignal,
): Promise<{ known: boolean; contexts: Map<string, number | null> }> {
  if (!base) return { known: false, contexts: new Map() }
  let legacy: { known: boolean; contexts: Map<string, number | null> } = {
    known: false,
    contexts: new Map(),
  }
  try {
    const response = await githubTransport().rest({
      path: `repos/${fullName}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
      ...(signal ? { signal } : {}),
    })
    const data = response.data
    if (!isRecord(data)) return { known: false, contexts: new Map() }
    const contexts = new Map<string, number | null>()
    if (Array.isArray(data.contexts)) {
      for (const context of data.contexts) {
        if (typeof context === 'string' && context) contexts.set(context.toLowerCase(), null)
      }
    }
    if (Array.isArray(data.checks)) {
      for (const entry of data.checks) {
        if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
        // A context bound to an app is only that app's check; the app id is what keeps
        // another app's identically named check from being read as required.
        contexts.set(
          entry.context.toLowerCase(),
          typeof entry.app_id === 'number' ? entry.app_id : null,
        )
      }
    }
    legacy = { known: true, contexts }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return { known: false, contexts: new Map() }
  }

  const rulesets = await requiredRulesetContexts(fullName, base, signal)
  if (!rulesets.known) return { known: false, contexts: new Map() }
  for (const [context, appId] of rulesets.contexts) {
    if (!legacy.contexts.has(context)) legacy.contexts.set(context, appId)
  }
  return legacy
}

/**
 * Required checks declared by repository rulesets that target the base branch. A
 * ruleset GitHub will not let this account read is the reason the whole required set
 * stays unknown: a check no readable API mentions may still gate the merge.
 */
async function requiredRulesetContexts(
  fullName: string,
  base: string | null,
  signal?: AbortSignal,
): Promise<{ known: boolean; contexts: Map<string, number | null> }> {
  try {
    const response = await githubTransport().rest({
      path: `repos/${fullName}/rulesets?includes_parents=true&per_page=100`,
      ...(signal ? { signal } : {}),
    })
    const data = response.data
    if (!Array.isArray(data)) return { known: false, contexts: new Map() }
    const contexts = new Map<string, number | null>()
    for (const ruleset of data) {
      if (!isRecord(ruleset) || ruleset.target !== 'branch' || ruleset.enforcement !== 'active') {
        continue
      }
      if (!rulesetTargetsBranch(ruleset, base)) continue
      if (!Array.isArray(ruleset.rules)) continue
      for (const rule of ruleset.rules) {
        if (!isRecord(rule) || rule.type !== 'required_status_checks') continue
        const parameters = isRecord(rule.parameters) ? rule.parameters : null
        const entries =
          parameters && Array.isArray(parameters.required_status_checks)
            ? parameters.required_status_checks
            : []
        for (const entry of entries) {
          if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
          contexts.set(
            entry.context.toLowerCase(),
            typeof entry.integration_id === 'number' ? entry.integration_id : null,
          )
        }
      }
    }
    return { known: true, contexts }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return { known: false, contexts: new Map() }
  }
}

/**
 * Whether a branch ruleset applies to the base branch. GitHub returns the patterns under
 * `conditions.ref_name.include`, where `~DEFAULT_BRANCH` is its token for the repository's
 * own default branch; the literal base ref is accepted as well. A ruleset that names
 * neither the base nor the default branch is about other branches and proves nothing here.
 */
function rulesetTargetsBranch(ruleset: Record<string, unknown>, base: string | null): boolean {
  if (!base) return false
  const conditions = ruleset.conditions
  if (!isRecord(conditions)) return false
  const refName = conditions.ref_name
  const include = isRecord(refName) && Array.isArray(refName.include) ? refName.include : []
  return include.some(
    (value) => typeof value === 'string' && (value === '~DEFAULT_BRANCH' || value === base),
  )
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
  required: Map<string, number | null>,
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
      requirement: requirementKnown
        ? classifyRequirement(name, required, ACTIONS_APP_ID)
        : 'unknown',
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
      requirement: requirementKnown
        ? classifyRequirement(entry.name, required, checkRunAppId(entry))
        : 'unknown',
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
      requirement: requirementKnown
        ? classifyRequirement(entry.context, required, null)
        : 'unknown',
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
    for (const [context, appId] of required) {
      if (checks.some((check) => check.name.toLowerCase() === context && matchesApp(check, appId)))
        continue
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

function checkRunAppId(entry: Record<string, unknown>): number | null {
  return isRecord(entry.app) && typeof entry.app.id === 'number' ? entry.app.id : null
}

/**
 * Whether a reported check is the one the repository requires. A required context that
 * names an app is that app's check only, so an identically named check from another app
 * stays informational rather than counting as the required one that never reported.
 */
function classifyRequirement(
  name: string,
  required: Map<string, number | null>,
  appId: number | null,
): PullRequestCheckRequirement {
  const key = name.trim().toLowerCase()
  if (!required.has(key)) return 'informational'
  const requiredAppId = required.get(key) ?? null
  return requiredAppId === null || appId === requiredAppId ? 'required' : 'informational'
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
      truncated: remembered.truncated,
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
    truncated: false,
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
 * Whether a reported check is the app-bound context the repository requires. A context
 * bound to an app counts as reported when that app reported it, even when another app
 * reported a check of the same name.
 */
function withoutRerun(
  permissions: PullRequestChecksPermissions,
  reason: string,
): PullRequestChecksPermissions {
  return permissions.canRerun ? { ...permissions, canRerun: false, reason } : permissions
}

function matchesApp(check: PullRequestCheckDetail, appId: number | null): boolean {
  if (appId === null) return true
  if (check.source === 'workflow-run') return appId === ACTIONS_APP_ID
  return check.app === 'github-actions' && appId === ACTIONS_APP_ID
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
  // Identity is either proved in this call or reported as unproved. A read that could
  // not confirm which head the pull request has may still show the last good report,
  // but it is not current, and it cannot authorise a mutation.
  let identityReason: string | null = null
  if (!headSha) {
    try {
      const identity = await readPullRequestIdentity(fullName, number, options.signal)
      headSha = identity.headSha
      base = identity.base ?? base
    } catch (error) {
      if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
      if (!remembered?.headSha) throw error
      identityReason =
        'This pull request could not be re-read from GitHub, so these checks are the last ones Git Stacks read.'
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
      // A report served without asking GitHub anything is only as current as the identity
      // behind it, so an unproved head is labelled here too.
      if (identityReason) {
        return reportFrom(
          { ...remembered, permissions: withoutRerun(remembered.permissions, identityReason) },
          number,
          base,
          'stale',
          identityReason,
        )
      }
      return reportFrom(remembered, number, base, 'cached', null)
    }
  }

  try {
    const commitPath = `repos/${fullName}/commits/${encodeURIComponent(headSha)}`
    const checkRuns = await readAllPages(`${commitPath}/check-runs`, {
      perPage: MAX_CHECK_RUNS,
      etag: remembered?.etags.get('check-runs'),
      pick: checkRunEntries,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const status = await readAllPages(`${commitPath}/status`, {
      perPage: MAX_STATUSES,
      etag: remembered?.etags.get('status'),
      pick: statusEntries,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const workflowRuns = await readAllPages(
      `repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}`,
      {
        perPage: MAX_WORKFLOW_RUNS,
        etag: remembered?.etags.get('workflow-runs'),
        pick: workflowRunEntries,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )
    const rateLimit = checkRuns.rateLimit
    const truncated = checkRuns.truncated || status.truncated || workflowRuns.truncated

    // Requirement and permission are policy, not payload: neither has an ETag, and a
    // rerun must never act on a policy that was true at some earlier read. Both are
    // re-read on every path, including the one where all three payloads answered 304.
    const requirement = await requiredContexts(fullName, base, options.signal)
    const readPermissions = await actionsPermissions(fullName, options.signal)
    // An unproved head cannot authorise a mutation: the run behind the button may belong
    // to a commit Git Stacks never confirmed this pull request has.
    const permissions = identityReason
      ? withoutRerun(readPermissions, identityReason)
      : readPermissions

    if (checkRuns.notModified && status.notModified && workflowRuns.notModified && remembered) {
      // The payloads are still current, but they are rebuilt against the policy read
      // just now: a retargeted base or a withdrawn role must change the report even
      // when not one check result moved.
      const sources = remembered.sources
      const built = buildReport(
        sources.checkRuns,
        sources.statuses,
        sources.workflowRuns,
        requirement.known,
        requirement.contexts,
      )
      const confirmed: CachedReport = {
        ...remembered,
        checks: built.checks,
        rollup: built.rollup,
        summary: built.summary,
        base,
        rateLimit,
        permissions,
        truncated,
        failures: 0,
        nextAttemptAt: 0,
        lastReason: null,
      }
      cache.set(cacheKey, confirmed)
      return identityReason
        ? reportFrom(confirmed, number, base, 'stale', identityReason)
        : reportFrom(confirmed, number, base, 'not-modified', null)
    }

    // A resource that answered 304 keeps the entries this head was last seen with.
    const sources = {
      checkRuns: checkRuns.notModified ? (remembered?.sources.checkRuns ?? []) : checkRuns.entries,
      statuses: status.notModified ? (remembered?.sources.statuses ?? []) : status.entries,
      workflowRuns: workflowRuns.notModified
        ? (remembered?.sources.workflowRuns ?? [])
        : workflowRuns.entries,
    }
    const built = buildReport(
      sources.checkRuns,
      sources.statuses,
      sources.workflowRuns,
      requirement.known,
      requirement.contexts,
    )
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
      truncated,
      failures: 0,
      nextAttemptAt: 0,
      lastReason: null,
    }
    cache.set(cacheKey, entry)
    return identityReason
      ? reportFrom(entry, number, base, 'stale', identityReason)
      : reportFrom(entry, number, base, 'live', null)
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
    truncated: entry.truncated,
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
  options: { headSha?: string | null; base?: string | null; signal?: AbortSignal } = {},
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
  // Identity is proved here, from GitHub, before anything else. The head the caller
  // saw is what the user acted on, so a head that has moved since is refused outright
  // rather than rerun: the button described a different commit than the one GitHub has.
  const identity = await readPullRequestIdentity(fullName, number, options.signal)
  if (options.headSha && options.headSha !== identity.headSha) {
    throw new Error(
      'This pull request moved to a new head commit after these checks were read. Review the checks for the new commit, then rerun from there.',
    )
  }
  // The report behind the button is then re-read against that proved head. A cached or
  // stale report is not proof: it may name a run that has since been replaced.
  const report = await getPullRequestChecks(repoPath, number, {
    ...options,
    headSha: identity.headSha,
    base: identity.base ?? options.base ?? null,
    force: true,
  })
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
