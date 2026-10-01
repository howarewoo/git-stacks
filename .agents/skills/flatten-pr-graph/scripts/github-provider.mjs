/**
 * The GitHub provider `flatten-pr-graph/1` publishes through.
 *
 * It is a module, not a client: `publish-stack.mjs` imports it and calls one of three
 * operations per call. Nothing here decides anything - it converts the three operations
 * into `gh api` calls and converts the answers back, so the publication logic stays
 * testable against a double while the shipped path talks to a real server.
 *
 * It exposes exactly the surface the contract allows:
 *
 *   capabilities()          -> reports both operations this module implements, and sets
 *                              `compareAndSwap: false` because GitHub's REST API
 *                              (`PATCH /repos/{owner}/{repo}/pulls/{n}`) does not offer
 *                              a server-side precondition check for base updates
 *   readPullRequest(number) -> GET /repos/{owner}/{repo}/pulls/{n}
 *   updatePullRequestBase(number, base)
 *                           -> PATCH /repos/{owner}/{repo}/pulls/{n} with `base`
 *
 * There is no merge, no queue, no ruleset, no check, no label, no reviewer, and no
 * branch-protection read here, and no code path that could be extended into one by
 * configuration: the endpoint, the verb, and the field names are literals.
 *
 * The repository is never inferred. `FLATTEN_PR_REPOSITORY` must name `owner/name`, and
 * every endpoint carries it literally; there is no `gh repo view`, no working-directory
 * fallback, and no `GH_REPO` substitution.
 *
 * Base retargets are guarded by an immediate read-before-write check, and the publication
 * result explicitly documents `residualMetadataRace: true`.
 *
 * Credentials: `gh` must already be authenticated. This module never reads, stores, logs,
 * or forwards a token, and never prints anything except the operation result.
 */

import { execFileSync } from 'node:child_process'

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

/**
 * The repository every operation addresses, taken from the environment and nothing else.
 *
 * A fallback to `gh repo view` or to the caller's working directory would let an ambient
 * checkout decide which repository gets its pull requests retargeted, which is exactly the
 * "assume `origin`" the skill forbids. A missing or malformed pin is a refusal, not a
 * guess.
 */
function repositoryCoordinates() {
  const pinned = process.env.FLATTEN_PR_REPOSITORY
  if (typeof pinned !== 'string' || pinned.trim().length === 0) {
    throw new Error(
      'FLATTEN_PR_REPOSITORY must be set to "owner/name"; this provider never infers a repository from the working directory',
    )
  }
  const parts = pinned.trim().split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `FLATTEN_PR_REPOSITORY must be "owner/name"; received ${JSON.stringify(pinned)}`,
    )
  }
  return { owner: parts[0], name: parts[1] }
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

/**
 * One REST pull request, in the contract's own vocabulary.
 *
 * REST spells the state lowercase (`open`) and the contract says `OPEN`; normalising here
 * is what lets the publisher's state check work against a real server rather than only
 * against a fixture that already used the contract's spelling. The commits are named
 * `headRefOid`/`baseRefOid` because an attempt records commits, not branch names.
 */
function toPullRequest(raw) {
  return {
    number: raw.number,
    state: typeof raw.state === 'string' ? raw.state.toUpperCase() : null,
    draft: raw.draft ?? false,
    headRef: raw.head?.ref ?? null,
    headRefOid: raw.head?.sha ?? null,
    headRepository: raw.head?.repo?.full_name ?? null,
    baseRef: raw.base?.ref ?? null,
    baseRefOid: raw.base?.sha ?? null,
    title: raw.title,
    body: raw.body,
    labels: (raw.labels ?? []).map((label) => label.name),
    reviewers: (raw.requested_reviewers ?? []).map((reviewer) => reviewer.login),
    autoMergeRequest: raw.auto_merge
      ? { enabled: true, method: raw.auto_merge.merge_method ?? null }
      : { enabled: false, method: null },
  }
}

export function capabilities() {
  const { owner, name } = repositoryCoordinates()
  return {
    // Both operations this module implements. A capability list that omits a read the
    // module can perform would let a caller believe the publication never looked at the
    // pull request it is about to retarget.
    operations: ['read-pull-request', 'update-pull-request-base'],
    compareAndSwap: false,
    provider: `github:${owner}/${name}`,
  }
}

export function readPullRequest(number) {
  const { owner, name } = repositoryCoordinates()
  // `gh api` has no `-R/--repo`: the endpoint below already names the repository
  // explicitly, and `GH_REPO` only fills endpoint placeholders.
  const raw = ghJson(['api', '--method', 'GET', `repos/${owner}/${name}/pulls/${number}`])
  return { ok: true, pullRequest: toPullRequest(raw) }
}

export function updatePullRequestBase(number, base) {
  const { owner, name } = repositoryCoordinates()
  const raw = ghJson([
    'api',
    '--method',
    'PATCH',
    `repos/${owner}/${name}/pulls/${number}`,
    '-f',
    `base=${base}`,
  ])
  return {
    ok: true,
    applied: raw?.base?.ref === base,
    // GitHub's PATCH documents no server-side precondition, so the outcome is only ever
    // known by re-reading. Saying `null` keeps the caller from claiming an enforcement
    // this interface does not provide.
    preconditionMet: null,
    provider: 'github',
  }
}
