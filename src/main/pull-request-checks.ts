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
  /** One validator per resource page, so a later page is asked about its own change. */
  etags: Map<string, string>
  /** The raw entries per resource page, kept so one 304 does not discard another page. */
  sources: { checkRuns: unknown[][]; statuses: unknown[][]; workflowRuns: unknown[][] }
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
  /** The entries, page by page, so one confirmed page never discards another. */
  pages: unknown[][]
  /** True only when every page this read asked about answered 304. */
  notModified: boolean
  etags: Map<string, string>
  rateLimit: GitHubRateLimitLike
  truncated: boolean
}

interface GitHubRateLimitLike {
  remaining: number | null
  reset: string | null
}

/**
 * Follow a REST list to its end, one bounded page at a time, with a validator per page.
 *
 * A first page short of `perPage` is the whole list, so an ordinary read costs one
 * request. A full page means there may be more, and the read follows until GitHub
 * returns a short page or the page bound is reached. Reaching the bound is reported as
 * truncation rather than passed off as a complete list: a head with thousands of check
 * runs is unusual, and a silent cut would be a lie about what was inspected.
 *
 * Each page carries its own ETag, because a collection's first page says nothing about
 * the pages behind it: a second page can gain a failing check while the first page's
 * validator is unchanged. So every page is asked conditionally, a 304 on a page reuses
 * that page's remembered entries, and the collection counts as unchanged only when every
 * page asked about confirmed itself.
 */
async function readAllPages(
  path: string,
  options: {
    key: string
    perPage: number
    etags: Map<string, string>
    remembered: unknown[][]
    pick: (data: unknown) => unknown[]
    signal?: AbortSignal
  },
): Promise<PagedResult> {
  const separator = path.includes('?') ? '&' : '?'
  const pages: unknown[][] = []
  const etags = new Map<string, string>()
  let first: CheckRead | null = null
  let confirmed = true
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const etag = options.etags.get(pageKey(options.key, page)) ?? null
    const read = await conditionalRead({
      path: `${path}${separator}per_page=${options.perPage}&page=${page}`,
      ...(etag ? { etag } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (page === 1) first = read
    if (read.notModified) {
      const remembered = options.remembered[page - 1]
      if (!remembered) {
        // A page GitHub says is unchanged that was never remembered cannot be reused.
        confirmed = false
        break
      }
      pages.push(remembered)
      if (etag) etags.set(pageKey(options.key, page), etag)
      // Every page this head was last read with has now confirmed itself, so there is
      // nothing further to ask about.
      if (options.remembered.length <= page) break
      continue
    }
    confirmed = false
    if (read.etag) etags.set(pageKey(options.key, page), read.etag)
    const pageEntries = options.pick(read.data)
    pages.push(pageEntries)
    if (pageEntries.length < options.perPage) break
    if (page === MAX_PAGES) truncated = true
  }
  return {
    pages,
    notModified: confirmed && pages.length > 0,
    etags,
    rateLimit: first?.rateLimit ?? { remaining: null, reset: null },
    truncated,
  }
}

function pageKey(resource: string, page: number): string {
  return `${resource}:${page}`
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
 * One required check, as GitHub states it: a context name bound to the app that must
 * report it, or unbound when any app may.
 */
interface RequiredConstraint {
  context: string
  appId: number | null
}

/**
 * Every applicable required check, kept as separate constraints. GitHub enforces all
 * applicable rules and the most restrictive one wins, so a repository rule and an
 * organisation rule that both require `build` are two requirements, not one that either
 * app can satisfy. An unbound requirement is likewise its own requirement: it does not
 * loosen a bound one.
 */
function addRequired(constraints: RequiredConstraint[], name: string, appId: number | null): void {
  const context = name.trim().toLowerCase()
  if (constraints.some((entry) => entry.context === context && entry.appId === appId)) return
  constraints.push({ context, appId })
}

/** Whether one reported check satisfies one required constraint. */
function satisfies(check: PullRequestCheckDetail, constraint: RequiredConstraint): boolean {
  if (check.name.trim().toLowerCase() !== constraint.context) return false
  if (constraint.appId === null) return true
  const appId = check.source === 'workflow-run' ? ACTIONS_APP_ID : check.appId
  return appId !== null && appId === constraint.appId
}

/**
 * The checks a repository requires on its base branch, and whether that answer is
 * complete.
 *
 * Two APIs make a check required, and reading only one is not evidence that a check is
 * optional. Legacy branch protection reports the contexts it requires. Rulesets, from
 * the repository and from its organisation, require checks that appear nowhere in
 * branch protection; GitHub answers "which active rules apply to this exact branch"
 * through `GET /repos/{o}/{r}/rules/branches/{branch}`, so which rulesets those come
 * from and which branches they match is GitHub's own evaluation rather than a pattern
 * match reimplemented here. Any read that does not succeed leaves the whole answer
 * `unknown` rather than presenting what was read as the complete required set.
 */
async function requiredContexts(
  fullName: string,
  base: string | null,
  viewerIsAdmin: boolean,
  signal?: AbortSignal,
): Promise<{ known: boolean; constraints: RequiredConstraint[] }> {
  if (!base) return { known: false, constraints: [] }
  const constraints: RequiredConstraint[] = []
  try {
    const response = await githubTransport().rest({
      path: `repos/${fullName}/branches/${encodeURIComponent(base)}/protection/required_status_checks`,
      ...(signal ? { signal } : {}),
    })
    const data = response.data
    if (!isRecord(data)) return { known: false, constraints: [] }
    // `checks` carries the app each required context is bound to; the deprecated
    // `contexts` list carries the same names with no app identity at all. Reading both
    // would make every context unbound, so `checks` is authoritative whenever GitHub
    // sends it and `contexts` is only the fallback for a response without it.
    if (Array.isArray(data.checks) && data.checks.length > 0) {
      for (const entry of data.checks) {
        if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
        addRequired(
          constraints,
          entry.context,
          typeof entry.app_id === 'number' ? entry.app_id : null,
        )
      }
    } else if (Array.isArray(data.contexts)) {
      for (const context of data.contexts) {
        if (typeof context === 'string' && context) addRequired(constraints, context, null)
      }
    }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    // GitHub answers 404 both for a branch that carries no protection and for one whose
    // protection the token may not read. An admin viewer can only be reading the first,
    // so only then is a 404 an answer; for anyone else the required set stays unknown.
    const unprotected =
      viewerIsAdmin && error instanceof GitHubTransportError && error.kind === 'not-found'
    if (!unprotected) return { known: false, constraints: [] }
  }

  const rules = await effectiveBranchRules(fullName, base, signal)
  if (!rules.known) return { known: false, constraints: [] }
  for (const entry of rules.constraints) addRequired(constraints, entry.context, entry.appId)
  return { known: true, constraints }
}

/**
 * Every active rule that applies to this exact branch, from the repository's own
 * rulesets and its organisation's. Rules this account cannot read, or a list longer than
 * the bounded read followed, are the reason the required set stays unknown: a check no
 * readable rule mentions may still gate the merge.
 */
async function effectiveBranchRules(
  fullName: string,
  base: string,
  signal?: AbortSignal,
): Promise<{ known: boolean; constraints: RequiredConstraint[] }> {
  const constraints: RequiredConstraint[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let rules: unknown
    try {
      const response = await githubTransport().rest({
        path: `repos/${fullName}/rules/branches/${encodeURIComponent(base)}?per_page=100&page=${page}`,
        ...(signal ? { signal } : {}),
      })
      rules = response.data
    } catch (error) {
      if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
      return { known: false, constraints: [] }
    }
    if (!Array.isArray(rules)) return { known: false, constraints: [] }
    for (const rule of rules) {
      if (!isRecord(rule) || rule.type !== 'required_status_checks') continue
      const parameters = isRecord(rule.parameters) ? rule.parameters : null
      const entries =
        parameters && Array.isArray(parameters.required_status_checks)
          ? parameters.required_status_checks
          : []
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
        addRequired(
          constraints,
          entry.context,
          typeof entry.integration_id === 'number' ? entry.integration_id : null,
        )
      }
    }
    if (rules.length < 100) return { known: true, constraints }
  }
  return { known: false, constraints: [] }
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
async function viewerRole(
  fullName: string,
  signal?: AbortSignal,
): Promise<{ canWrite: boolean | null; isAdmin: boolean | null }> {
  try {
    const { data } = await githubTransport().rest({
      path: `repos/${fullName}`,
      ...(signal ? { signal } : {}),
    })
    if (!isRecord(data) || !isRecord(data.permissions)) {
      return { canWrite: null, isAdmin: null }
    }
    const role = data.permissions
    return {
      canWrite: role.push === true || role.maintain === true || role.admin === true,
      isAdmin: role.admin === true,
    }
  } catch (error) {
    if (error instanceof GitHubTransportError && error.kind === 'cancelled') throw error
    return { canWrite: null, isAdmin: null }
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
  const [enabled, role] = await Promise.all([
    actionsEnabled(fullName, signal),
    viewerRole(fullName, signal),
  ])
  const canWrite = role.canWrite
  if (enabled === false) {
    return {
      actionsEnabled: false,
      canRerun: false,
      reason: 'GitHub Actions are disabled for this repository.',
      isAdmin: role.isAdmin === true,
    }
  }
  if (canWrite === false) {
    return {
      actionsEnabled: enabled === true,
      canRerun: false,
      reason: 'Your role on this repository cannot run workflows, so rerun is unavailable.',
      isAdmin: role.isAdmin === true,
    }
  }
  if (enabled !== true || canWrite !== true) {
    return {
      actionsEnabled: enabled === true,
      canRerun: false,
      reason: 'GitHub did not confirm permission to rerun workflows; rerun stays unavailable.',
      isAdmin: role.isAdmin === true,
    }
  }
  return { actionsEnabled: true, canRerun: true, reason: '', isAdmin: role.isAdmin === true }
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
  checkRuns: unknown[][],
  statuses: unknown[][],
  workflowRuns: unknown[][],
  requirementKnown: boolean,
  required: RequiredConstraint[],
): BuiltReport {
  const checks: PullRequestCheckDetail[] = []
  const checkRunEntriesFlat = checkRuns.flat()
  const statusEntriesFlat = statuses.flat()
  const workflowRunEntriesFlat = workflowRuns.flat()
  // An Actions run and the check run it creates are one piece of work, joined by the
  // run URL GitHub puts in the check run's details link.
  const runIdByUrl = new Map<string, number>()
  for (const entry of workflowRunEntriesFlat) {
    if (!isRecord(entry) || typeof entry.id !== 'number') continue
    const details = safeGitHubUrl(entry.html_url)
    if (details) runIdByUrl.set(details, entry.id)
  }

  for (const entry of workflowRunEntriesFlat) {
    if (!isRecord(entry) || typeof entry.id !== 'number') continue
    const details = safeGitHubUrl(entry.html_url)
    if (!details) continue
    const reportedByCheckRun = checkRunEntriesFlat.some(
      (run) => isRecord(run) && run.details_url === details,
    )
    // A run GitHub already reported as a check run is that run, not a second check.
    if (reportedByCheckRun) continue
    const name = typeof entry.name === 'string' && entry.name ? entry.name : 'Workflow run'
    checks.push({
      key: `workflow-run:${entry.id}`,
      name,
      source: 'workflow-run',
      app: 'github-actions',
      appId: ACTIONS_APP_ID,
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

  for (const entry of checkRunEntriesFlat) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name) continue
    const app = isRecord(entry.app) && typeof entry.app.slug === 'string' ? entry.app.slug : null
    const details = safeGitHubUrl(entry.details_url)
    const id = typeof entry.id === 'number' ? entry.id : null
    checks.push({
      key: id === null ? `check-run:${entry.name}` : `check-run:${id}`,
      name: entry.name,
      source: 'check-run',
      app,
      appId: checkRunAppId(entry),
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

  for (const entry of statusEntriesFlat) {
    if (!isRecord(entry) || typeof entry.context !== 'string' || !entry.context) continue
    const state = classifyCommitStatus(entry.state)
    checks.push({
      key: `commit-status:${entry.context}`,
      name: entry.context,
      source: 'commit-status',
      app: null,
      appId: null,
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
    for (const constraint of required) {
      // Every applicable required check must be satisfied, so one check satisfies one
      // constraint: a check from another app never hides a requirement still outstanding.
      if (checks.some((check) => satisfies(check, constraint))) continue
      checks.push({
        key: `expected:${constraint.context}:${constraint.appId ?? 'any'}`,
        name: constraint.context,
        source: 'expected',
        app: null,
        appId: constraint.appId,
        state: 'waiting',
        requirement: 'required',
        summary:
          constraint.appId === null
            ? 'Expected: waiting for this check to report'
            : 'Expected: waiting for this app to report this check',
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

/**
 * Whether a reported check is the one the repository requires. A required context that
 * names an app is that app's check only, so an identically named check from another app
 * stays informational rather than counting as the required one that never reported.
 */
function classifyRequirement(
  name: string,
  required: RequiredConstraint[],
  appId: number | null,
): PullRequestCheckRequirement {
  const key = name.trim().toLowerCase()
  return required.some(
    (constraint) =>
      constraint.context === key && (constraint.appId === null || constraint.appId === appId),
  )
    ? 'required'
    : 'informational'
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
    permissions: { actionsEnabled: false, canRerun: false, reason: '', isAdmin: false },
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

/** The app that reported a check, which is what a required context is bound to. */
function checkRunAppId(entry: Record<string, unknown>): number | null {
  return isRecord(entry.app) && typeof entry.app.id === 'number' ? entry.app.id : null
}

function withoutRerun(
  permissions: PullRequestChecksPermissions,
  reason: string,
): PullRequestChecksPermissions {
  return permissions.canRerun ? { ...permissions, canRerun: false, reason } : permissions
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
      key: 'check-runs',
      perPage: MAX_CHECK_RUNS,
      etags: new Map(remembered?.etags ?? []),
      remembered: remembered?.sources.checkRuns ?? [],
      pick: checkRunEntries,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const status = await readAllPages(`${commitPath}/status`, {
      key: 'status',
      perPage: MAX_STATUSES,
      etags: new Map(remembered?.etags ?? []),
      remembered: remembered?.sources.statuses ?? [],
      pick: statusEntries,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const workflowRuns = await readAllPages(
      `repos/${fullName}/actions/runs?head_sha=${encodeURIComponent(headSha)}`,
      {
        key: 'workflow-runs',
        perPage: MAX_WORKFLOW_RUNS,
        etags: new Map(remembered?.etags ?? []),
        remembered: remembered?.sources.workflowRuns ?? [],
        pick: workflowRunEntries,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    )
    const rateLimit = checkRuns.rateLimit
    const truncated = checkRuns.truncated || status.truncated || workflowRuns.truncated

    // Requirement and permission are policy, not payload: neither has an ETag, and a
    // rerun must never act on a policy that was true at some earlier read. Both are
    // re-read on every path, including the one where all three payloads answered 304.
    const readPermissions = await actionsPermissions(fullName, options.signal)
    const requirement = await requiredContexts(
      fullName,
      base,
      readPermissions.isAdmin,
      options.signal,
    )
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
        requirement.constraints,
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

    // Each resource keeps the pages this read actually saw: a page GitHub confirmed is
    // the page it remembered, and a page GitHub re-sent is the page it sent.
    const sources = {
      checkRuns: checkRuns.pages,
      statuses: status.pages,
      workflowRuns: workflowRuns.pages,
    }
    const built = buildReport(
      sources.checkRuns,
      sources.statuses,
      sources.workflowRuns,
      requirement.known,
      requirement.constraints,
    )
    // Validators accumulate across resources rather than replacing each other, so a
    // confirmed page keeps the validator that proved it.
    const etags = new Map(remembered?.etags ?? [])
    for (const [key, value] of checkRuns.etags) etags.set(key, value)
    for (const [key, value] of status.etags) etags.set(key, value)
    for (const [key, value] of workflowRuns.etags) etags.set(key, value)
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
