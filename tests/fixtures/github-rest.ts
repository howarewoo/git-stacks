import { execFileSync } from 'node:child_process'
import { delimiter } from 'node:path'

/**
 * The shared vocabulary of the GitHub fixture server.
 *
 * They live in their own module because the server is composed of more than one file: the
 * original transport double, and the surface the live end-to-end suite needs on top of it.
 * Both raise the same error, so a route either answers a result or fails the way the outer
 * handler already knows how to turn into an HTTP answer.
 *
 * Everything here is the *host's* side of GitHub's contracts, not the application's: which
 * repository a request is being served for and which real bare repository backs it, how a
 * paginated list is answered, how a ref-name condition is evaluated, what a rule set
 * creation has to carry before it is stored, and how the standing decisions of a pull
 * request's reviewers are derived. The double and the review surface consume these so a
 * rule cannot be enforced by one route and ignored by the next.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export type RestResult = { status: number; body: unknown; headers?: Record<string, string> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The numeric identity GitHub reports for a repository, derived from its name so the same
 * repository always has the same identity within a run and never collides with another's.
 */
export function repositoryIdentity(fullName: string): number {
  return [...fullName].reduce(
    (hash, character) => (hash * 33 + (character.codePointAt(0) ?? 0)) >>> 0,
    7,
  )
}

/**
 * One repository the host serves, and the real bare Git repository behind it.
 *
 * A fixture that answered a second repository's requests from the first repository's refs
 * would prove nothing about cross-repository behaviour: a fork or a foreign pull request
 * would look like the default one. Every repository therefore names its own bare
 * repository, and `alternates` lets Git read another repository's objects so a real
 * diff across a fork boundary is still Git's own comparison.
 */
export interface HostRepository {
  fullName: string
  bare: string
  /** Bare repositories whose objects are readable while serving this one. */
  alternates?: string[]
}

let served: HostRepository | null = null

/** The bare repository a Git command runs against right now. */
export function hostBarePath(): string {
  if (served) return served.bare
  const value = process.env.GIT_STACKS_FIXTURE_BARE
  if (!value) throw new Error('GIT_STACKS_FIXTURE_BARE is required by the GitHub fixture server')
  return value
}

function realGit(): string {
  return process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'
}

/** Serves `repository` for the duration of `run`, then restores the previous one. */
export function withHostRepository<T>(repository: HostRepository, run: () => T): T {
  const previous = served
  served = repository
  try {
    return run()
  } finally {
    served = previous
  }
}

/** Runs Git against the repository being served, and answers through its alternates. */
export function hostGit(args: string[], env?: NodeJS.ProcessEnv): string {
  const alternates = served?.alternates ?? []
  return execFileSync(realGit(), ['--git-dir', hostBarePath(), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(alternates.length > 0
        ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(delimiter) }
        : {}),
      ...env,
    },
  }).trim()
}

/** The same Git command, or `null` when Git refused it the way a missing ref does. */
export function hostGitOrNull(args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return hostGit(args, env) || null
  } catch {
    return null
  }
}

/**
 * Whether a `git` invocation against the repository being served succeeded.
 *
 * `merge-tree` reports a conflict it found by failing, so its exit status is the answer
 * rather than something to be read out of its output.
 */
export function hostGitSucceeds(args: string[]): boolean {
  try {
    hostGit(args)
    return true
  } catch {
    return false
  }
}

/** A ref that does not exist is a `null`, not a failure. */
export function hostRefSha(ref: string): string | null {
  return hostGitOrNull(['rev-parse', '--verify', '--end-of-options', ref])
}
/** The query string of an API path, which is where `per_page` and `page` arrive. */
export function queryStringOf(path: string): string {
  const index = path.indexOf('?')
  return index === -1 ? '' : path.slice(index + 1)
}

/**
 * One page of a REST list, and the page after it when the host holds more.
 *
 * The host keeps the whole list and answers `per_page`/`page`, so a reader that never
 * follows pages really does lose entries instead of silently receiving everything. A page
 * past the end is empty, which is how a client learns that a full page was the last one.
 */
export function restPage<T>(
  entries: readonly T[],
  rawQuery: string | undefined,
  defaultPerPage = 30,
): { entries: T[]; nextPage: number | null } {
  const queryParams = new URLSearchParams(rawQuery ?? '')
  const perPage = Math.max(1, Number(queryParams.get('per_page')) || defaultPerPage)
  const number = Math.max(1, Number(queryParams.get('page')) || 1)
  const start = (number - 1) * perPage
  const slice = entries.slice(start, start + perPage)
  return { entries: slice, nextPage: start + perPage < entries.length ? number + 1 : null }
}

/** One page of a list, for a reader that has no pages to follow. */
export function paginate<T>(entries: T[], rawQuery: string | undefined, defaultPerPage = 30): T[] {
  return restPage(entries, rawQuery, defaultPerPage).entries
}

/**
 * The `Link` header a real host answers a paged list with.
 *
 * A collection that has more to say names its next page in this header, and the caller
 * stops reading when it is absent — so a listing without one is a shorter conversation
 * than the host holds: invisible while a run holds few entries, and a missing answer once
 * it holds many. The next page is named as an absolute URL on the host the request arrived
 * on, because that is the only host a client may follow it to.
 */
export function nextPageHeaders(
  origin: string,
  path: string,
  rawQuery: string | undefined,
  nextPage: number | null,
  defaultPerPage = 30,
): Record<string, string> {
  if (nextPage === null) return {}
  const query = new URLSearchParams(rawQuery ?? '')
  query.set('per_page', String(Math.max(1, Number(query.get('per_page')) || defaultPerPage)))
  query.set('page', String(nextPage))
  return { link: `<${origin}/${path}?${query.toString()}>; rel="next"` }
}

/** A repository's default branch, which is what `~DEFAULT_BRANCH` resolves to. */
export interface RefContext {
  branch: string
  defaultBranch?: string
}

/**
 * A ref name as GitHub writes it in a rule set condition. A bare branch name is qualified
 * the way GitHub qualifies it for a branch rule set; anything already under `refs/` is
 * left alone, because a tag rule set and a branch rule set say the same words differently.
 */
export function fullyQualifiedRef(name: string, context: RefContext): string {
  const trimmed = name.trim()
  if (trimmed === '~ALL' || trimmed === '~DEFAULT_BRANCH') return trimmed
  if (trimmed.startsWith('refs/')) return trimmed
  return `refs/heads/${trimmed}`
}

/** Escaping inside a character class, where `u`-mode allows only these four. */
function escapeInClass(char: string): string {
  return /[\\\]^]/u.test(char) ? `\\${char}` : char
}

/** One character of a class, and where the next one starts. `\` makes the next literal. */
function classCharacter(pattern: string, at: number): { char: string; next: number } | null {
  const escaped = pattern[at] === '\\'
  const char = escaped ? pattern[at + 1] : pattern[at]
  if (char === undefined) return null
  return { char, next: at + (escaped ? 2 : 1) }
}

/**
 * One `[...]` class as a regular expression, or null when the bracket never closes and
 * is therefore a literal `[`.
 *
 * GitHub documents a class as "one character listed in the brackets or included in
 * ranges", with `!` at the front negating it and `\` escaping. Pathname semantics still
 * hold inside it, so the whole class is guarded against the `/` separator rather than only
 * its ranges.
 */
function characterClass(pattern: string, at: number): { source: string; end: number } | null {
  let index = at + 1
  const negated = pattern[index] === '!' || pattern[index] === '^'
  if (negated) index += 1
  let body = ''
  while (index < pattern.length && pattern[index] !== ']') {
    const start = classCharacter(pattern, index)
    if (start === null) return null
    index = start.next
    const rangeEnd =
      pattern[index] === '-' && pattern[index + 1] !== undefined && pattern[index + 1] !== ']'
        ? classCharacter(pattern, index + 1)
        : null
    if (rangeEnd === null) {
      body += escapeInClass(start.char)
      continue
    }
    body += `${escapeInClass(start.char)}-${escapeInClass(rangeEnd.char)}`
    index = rangeEnd.next
  }
  if (index >= pattern.length) return null
  return { source: `(?!/)${negated ? `[^${body}]` : `[${body}]`}`, end: index + 1 }
}

/**
 * A ref-name pattern as GitHub's documented fnmatch reads it.
 *
 * The documented syntax is pathname-aware: a single star stops at a separator, a doubled
 * star crosses one, and a doubled star followed by a separator spans zero or more whole
 * segments — so the documented `qa` globstar pattern still names a direct child. `?`
 * and `+` are quantifiers on the character before them, `[a-z]` is a set, and a leading
 * `!` negates one. Escaping every literal keeps a branch named `release/1.0` from
 * matching a pattern that means `release/1x0`.
 */
function fnmatchSource(pattern: string): string {
  const parts: string[] = []
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] as string
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        parts.push(pattern[index + 2] === '/' ? '(?:[^/]*/)*' : '.*')
        index += pattern[index + 2] === '/' ? 3 : 2
        continue
      }
      parts.push('[^/]*')
      index += 1
      continue
    }
    if (char === '[') {
      const parsed = characterClass(pattern, index)
      if (parsed !== null) {
        parts.push(parsed.source)
        index = parsed.end
        continue
      }
    }
    if (char === '\\' && pattern[index + 1] !== undefined) {
      parts.push((pattern[index + 1] as string).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      index += 2
      continue
    }
    if ((char === '?' || char === '+') && parts.length > 0) {
      parts[parts.length - 1] = `(?:${parts[parts.length - 1]})${char === '?' ? '?' : '+'}`
      index += 1
      continue
    }
    parts.push(char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    index += 1
  }
  return parts.join('')
}

function refPatternMatches(pattern: string, ref: string, context: RefContext): boolean {
  if (pattern === '~ALL') return true
  if (pattern === '~DEFAULT_BRANCH')
    return context.defaultBranch !== undefined && ref === `refs/heads/${context.defaultBranch}`
  return new RegExp(`^${fnmatchSource(fullyQualifiedRef(pattern, context))}$`, 'u').test(ref)
}

/**
 * Whether a rule set's ref-name condition covers this branch. GitHub evaluates an
 * `include` list as "any pattern matches" and an `exclude` list as "no pattern matches",
 * and a rule set that excludes the branch is not enforced for it. A rule set stored
 * without any ref-name condition is unconstrained; the creation endpoint requires one, so
 * that only applies to state a test wrote directly.
 */
export function refConditionMatches(conditions: unknown, context: RefContext): boolean {
  if (!record(conditions)) return true
  const refName = record(conditions.ref_name) ? conditions.ref_name : null
  if (!refName) return true
  const include = Array.isArray(refName.include) ? refName.include.map(String) : []
  const exclude = Array.isArray(refName.exclude) ? refName.exclude.map(String) : []
  const ref = `refs/heads/${context.branch}`
  if (exclude.some((pattern) => refPatternMatches(pattern, ref, context))) return false
  if (include.length === 0) return false
  return include.some((pattern) => refPatternMatches(pattern, ref, context))
}

const MERGE_QUEUE_NUMBERS = [
  'check_response_timeout_minutes',
  'max_entries_to_build',
  'max_entries_to_merge',
  'min_entries_to_merge',
  'min_entries_to_merge_wait_minutes',
] as const

const MERGE_QUEUE_METHODS = ['MERGE', 'SQUASH', 'REBASE'] as const

function invalid(message: string): never {
  throw new HttpError(422, 'Unprocessable Entity', message)
}

function requireBoolean(parameters: Record<string, unknown>, key: string, rule: string): void {
  if (typeof parameters[key] !== 'boolean') {
    invalid(`${rule} requires the boolean ${key}`)
  }
}

function requireNumber(parameters: Record<string, unknown>, key: string, rule: string): void {
  const value = parameters[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${rule} requires the number ${key}`)
  }
}

/**
 * What GitHub validates before it stores a rule set.
 *
 * A host that stores and echoes whatever it is sent cannot show a request GitHub would
 * have refused: a malformed merge queue body or a pull request rule missing its
 * review-thread policy would both come back as a created rule set, and the caller would
 * treat a capability it never had as proven. The required fields are the ones GitHub
 * documents, so an invalid body is refused with the same 422 the real API answers.
 */
export function validateRuleSetCreation(body: unknown): void {
  if (!record(body)) invalid('a rule set is created with an object body')
  const name = body.name
  if (typeof name !== 'string' || name.trim() === '') invalid('a rule set requires a name')
  const enforcement = body.enforcement
  if (enforcement !== 'active' && enforcement !== 'disabled' && enforcement !== 'evaluate') {
    invalid('enforcement must be active, disabled or evaluate')
  }
  const target = body.target ?? 'branch'
  if (target !== 'branch' && target !== 'tag' && target !== 'push') {
    invalid('target must be branch, tag or push')
  }
  const conditions = record(body.conditions) ? body.conditions : null
  const refName = conditions && record(conditions.ref_name) ? conditions.ref_name : null
  if (!refName) invalid('a rule set requires a ref_name condition')
  const include = Array.isArray(refName.include) ? refName.include.map(String) : []
  const exclude = refName.exclude === undefined ? [] : refName.exclude
  if (!Array.isArray(exclude) || exclude.some((entry) => typeof entry !== 'string')) {
    invalid('ref_name.exclude must be an array of ref names')
  }
  if (include.length === 0) invalid('ref_name.include must name the refs the rule set protects')
  // An unconstrained rule set is what the real API accepts and what this suite must not
  // rely on: a rule that applies to every branch cannot be shown to protect the one branch
  // a case is about. Naming the refs is also what lets every consumer below agree on which
  // base a rule applies to.
  if (include.some((pattern) => pattern.trim() === '~ALL')) {
    invalid('ref_name.include must name refs; ~ALL protects branches nothing can verify')
  }
  if (include.some((pattern) => pattern.trim() === '')) {
    invalid('ref_name.include must not contain an empty ref name')
  }
  if (!Array.isArray(body.rules)) invalid('rules must be an array')
  for (const rule of body.rules as unknown[]) {
    if (!record(rule)) invalid('every rule must be an object')
    const parameters = record(rule.parameters) ? rule.parameters : {}
    if (rule.type === 'merge_queue') {
      for (const key of MERGE_QUEUE_NUMBERS) requireNumber(parameters, key, 'merge_queue')
      const method = parameters.merge_method
      if (!MERGE_QUEUE_METHODS.includes(method as (typeof MERGE_QUEUE_METHODS)[number])) {
        invalid('merge_queue requires merge_method MERGE, SQUASH or REBASE')
      }
      if (
        parameters.grouping_strategy !== 'ALLGREEN' &&
        parameters.grouping_strategy !== 'HEADGREEN'
      ) {
        invalid('merge_queue requires grouping_strategy ALLGREEN or HEADGREEN')
      }
    }
    if (rule.type === 'pull_request') {
      requireNumber(parameters, 'required_approving_review_count', 'pull_request')
      requireBoolean(parameters, 'dismiss_stale_reviews_on_push', 'pull_request')
      requireBoolean(parameters, 'require_code_owner_review', 'pull_request')
      requireBoolean(parameters, 'require_last_push_approval', 'pull_request')
      requireBoolean(parameters, 'required_review_thread_resolution', 'pull_request')
      const methods = parameters.allowed_merge_methods
      if (
        methods !== undefined &&
        (!Array.isArray(methods) ||
          methods.length === 0 ||
          methods.some((entry) => !['merge', 'squash', 'rebase'].includes(String(entry))))
      ) {
        invalid('pull_request allows merge methods merge, squash and rebase')
      }
    }
    if (rule.type === 'required_status_checks') {
      const checks = parameters.required_status_checks
      if (
        !Array.isArray(checks) ||
        checks.length === 0 ||
        checks.some((entry) => !record(entry) || typeof entry.context !== 'string')
      ) {
        invalid('required_status_checks requires at least one named context')
      }
      requireBoolean(parameters, 'strict_required_status_checks_policy', 'required_status_checks')
    }
  }
}

/** The identity a rule set listing answers with, without its configuration. */
export interface RuleSetIdentity {
  id: number
  name: string
  target: string
  enforcement: string
  source: string
  source_type: string
  node_id: string
  _links: { self: { href: string }; html: { href: string } | null }
  created_at?: string
  updated_at?: string
}

/**
 * One entry of `GET /repos/{owner}/{repo}/rulesets`.
 *
 * The list is documented as an array of rule sets whose `conditions` and `rules` are not
 * required members, so it answers identities alone. A reader that decides what a rule set
 * protects from the listing therefore has to fetch the detail, which is where the real
 * configuration is read from.
 */
export function ruleSetIdentity(
  ruleset: {
    id?: number
    name?: unknown
    target?: unknown
    enforcement?: unknown
    created_at?: unknown
    updated_at?: unknown
  },
  repository: string,
): RuleSetIdentity {
  const id = Number(ruleset.id)
  return {
    id,
    name: String(ruleset.name ?? ''),
    target: String(ruleset.target ?? 'branch'),
    enforcement: String(ruleset.enforcement ?? 'active'),
    source: repository,
    source_type: 'Repository',
    node_id: `RRS_${repository}_${id}`,
    _links: {
      self: { href: `https://api.github.com/repos/${repository}/rulesets/${id}` },
      html: null,
    },
    ...(typeof ruleset.created_at === 'string' ? { created_at: ruleset.created_at } : {}),
    ...(typeof ruleset.updated_at === 'string' ? { updated_at: ruleset.updated_at } : {}),
  }
}

/** One reviewer's standing decision, which is the review that decided, not the last row. */
export interface StandingReviewDecision {
  login: string
  state: 'APPROVED' | 'CHANGES_REQUESTED'
}

function recordedState(review: unknown): StandingReviewDecision['state'] | null {
  if (!record(review)) return null
  const state = typeof review.state === 'string' ? review.state : ''
  if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') return state
  return null
}

/**
 * What each reviewer currently stands behind.
 *
 * A comment is feedback, not a decision: posting one neither approves nor requests
 * changes, so it never replaces what a reviewer last decided. Only the most recent
 * non-comment review of each reviewer counts, so the same person approving twice is one
 * approval and an approval given before a later change request is no longer standing.
 */
export function standingReviewDecisions(reviews: unknown): StandingReviewDecision[] {
  if (!Array.isArray(reviews)) return []
  const latest = new Map<string, StandingReviewDecision>()
  for (const review of reviews) {
    if (!record(review)) continue
    const state = recordedState(review)
    if (state === null) continue
    const user = record(review.user) ? review.user : null
    const login = user && typeof user.login === 'string' ? user.login : null
    if (!login) continue
    latest.set(login, { login, state })
  }
  return [...latest.values()]
}

/**
 * The pull request's `reviewDecision`, derived from the same standing decisions the merge
 * gate uses: one reviewer's change request outranks every approval, and comments change
 * nothing.
 */
export function aggregateReviewDecision(
  decisions: readonly StandingReviewDecision[],
): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  if (decisions.some((entry) => entry.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  return decisions.some((entry) => entry.state === 'APPROVED') ? 'APPROVED' : null
}
