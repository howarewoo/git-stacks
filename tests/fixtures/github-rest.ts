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

/**
 * The same Git command, or `null` when Git refused it the way a missing ref does.
 *
 * Git says why on its own stderr and that stays: a tolerated refusal is a deliberate
 * question, and its answer is worth reading rather than having been hidden.
 */
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

/** One thing a ref-name pattern asks for, in the syntax GitHub documents for it. */
type PatternPart =
  | { readonly kind: 'literal'; readonly matches: (char: string) => boolean }
  | { readonly kind: 'class'; readonly matches: (char: string) => boolean }
  | { readonly kind: 'star' }
  | { readonly kind: 'any' }
  | { readonly kind: 'directories' }

/**
 * One `[...]` class, or null when the bracket never closes and is therefore a `[`.
 *
 * GitHub documents a class as one character listed in the brackets or included in its
 * ranges, with `!` at the front negating it. `^` is not documented as negating anything,
 * so it is a character like any other in here. A hyphen between two characters is a
 * range; a hyphen with nothing after it before the closing bracket is the last character
 * of the class, because `]` cannot end a range. Pathname semantics hold inside the class
 * too: no class matches the separator, whether or not it was negated.
 */
function classPart(
  pattern: string,
  at: number,
): { readonly part: PatternPart; readonly end: number } | null {
  let index = at + 1
  const negated = pattern[index] === '!'
  if (negated) index += 1
  const members: { from: string; to: string }[] = []
  while (index < pattern.length && pattern[index] !== ']') {
    const from = pattern[index] as string
    if (
      pattern[index + 1] === '-' &&
      pattern[index + 2] !== undefined &&
      pattern[index + 2] !== ']'
    ) {
      members.push({ from, to: pattern[index + 2] as string })
      index += 3
      continue
    }
    members.push({ from, to: from })
    index += 1
  }
  if (index >= pattern.length) return null
  return {
    part: {
      kind: 'class',
      matches: (char) => {
        if (char === '/') return false
        const inside = members.some(({ from, to }) =>
          from === to ? char === from : char >= from && char <= to,
        )
        return negated ? !inside : inside
      },
    },
    end: index + 1,
  }
}

/**
 * A ref-name pattern read the way GitHub's documented fnmatch reads it.
 *
 * A star matches a run of characters inside one segment and stops at the separator, `?` is
 * exactly one of those characters, `[a-z]` and `[!a-z]` are one character from a set or
 * from everything outside it, and `+` is an ordinary character. A doubled star is more
 * than a star only when it is a whole segment of the pathname followed by a separator, at
 * the start of the pattern or straight after another separator; anywhere else the stars
 * sit inside a segment and cross nothing. Backslash quoting is not supported.
 */
function patternParts(pattern: string): PatternPart[] {
  const parts: PatternPart[] = []
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] as string
    if (char === '*') {
      const doubled = pattern[index + 1] === '*'
      // A globstar is a whole segment or it is not a globstar: the stars have to start
      // one, and the separator has to end it. `qa**/` is a segment of its own, so the
      // doubled star inside it stays inside it and the branch it names is one segment
      // deep — reading it as a directory walk would enforce rules on branches GitHub
      // does not protect.
      const segmentStart = index === 0 || pattern[index - 1] === '/'
      if (doubled && segmentStart && pattern[index + 2] === '/') {
        parts.push({ kind: 'directories' })
        index += 3
        continue
      }
      parts.push({ kind: 'star' })
      index += doubled ? 2 : 1
      continue
    }
    if (char === '?') {
      parts.push({ kind: 'any' })
      index += 1
      continue
    }
    if (char === '[') {
      const parsed = classPart(pattern, index)
      if (parsed !== null) {
        parts.push(parsed.part)
        index = parsed.end
        continue
      }
    }
    parts.push({ kind: 'literal', matches: (candidate) => candidate === char })
    index += 1
  }
  return parts
}

/**
 * Whether the ref name matches every part of the pattern from `index` on, starting at
 * `at` in the name.
 *
 * A part that takes a run of characters tries every length that run could have, from
 * empty upwards, and asks the same question of what is left: a star as far as the
 * separator, a doubled-star segment as far as each whole segment or not at all. Matching
 * everything but the end is still a refusal, because a pattern names a whole ref.
 */
function partsMatch(
  parts: readonly PatternPart[],
  index: number,
  ref: string,
  at: number,
): boolean {
  if (index >= parts.length) return at === ref.length
  const part = parts[index] as PatternPart
  if (part.kind === 'directories') {
    if (partsMatch(parts, index + 1, ref, at)) return true
    for (let next = ref.indexOf('/', at); next !== -1; next = ref.indexOf('/', next + 1)) {
      if (partsMatch(parts, index + 1, ref, next + 1)) return true
    }
    return false
  }
  if (part.kind === 'star') {
    for (let end = at; ; end += 1) {
      if (partsMatch(parts, index + 1, ref, end)) return true
      if (end >= ref.length || ref[end] === '/') return false
    }
  }
  if (part.kind === 'any') {
    if (at >= ref.length || ref[at] === '/') return false
    return partsMatch(parts, index + 1, ref, at + 1)
  }
  if (at >= ref.length || !part.matches(ref[at] as string)) return false
  return partsMatch(parts, index + 1, ref, at + 1)
}

function refPatternMatches(pattern: string, ref: string, context: RefContext): boolean {
  if (pattern === '~ALL') return true
  if (pattern === '~DEFAULT_BRANCH')
    return context.defaultBranch !== undefined && ref === `refs/heads/${context.defaultBranch}`
  return partsMatch(patternParts(fullyQualifiedRef(pattern, context)), 0, ref, 0)
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

/**
 * Merge queue parameters a client may send but this contract does not have. They are
 * refusable rather than merely ignored on purpose: the real API rejects the whole
 * creation with a 422 when it sees one, so a host that quietly stores the rule lets a
 * caller prove a capability from a request the real host never accepts.
 */
const UNSUPPORTED_MERGE_QUEUE_PARAMETERS = [
  'queue_type',
  'merge_commit_message',
  'merge_commit_title',
] as const

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
      for (const key of UNSUPPORTED_MERGE_QUEUE_PARAMETERS) {
        if (parameters[key] !== undefined) {
          invalid(`merge_queue has no ${key} parameter; the request is refused whole`)
        }
      }
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
      // `integration_id` is documented as the integer an originating integration must
      // have, so it is either absent or an id. Accepting `null` here would let a
      // request the real API answers 422 for become a rule that gates on a context
      // nobody can satisfy, which reads as a check that never arrives.
      for (const entry of checks as Array<Record<string, unknown>>) {
        const integration = entry.integration_id
        if (integration !== undefined && !Number.isInteger(integration)) {
          invalid('required_status_checks takes an integer integration_id or none at all')
        }
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
