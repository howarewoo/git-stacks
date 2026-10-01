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
 *   capabilities()          -> reports supported operations, and sets
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
 * The repository `gh` is pointed at. Uses the pinned repository from environment if
 * available, otherwise falls back to inspecting the configured repository.
 */
function repositoryCoordinates() {
  const envRepo = process.env.FLATTEN_PR_REPOSITORY || process.env.GH_REPO
  if (envRepo && envRepo.includes('/')) {
    const parts = envRepo.trim().split('/')
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], name: parts[1] }
    }
  }
  const parsed = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']))
  return { owner: parsed.owner.login, name: parsed.name }
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

function toPullRequest(raw) {
  return {
    number: raw.number,
    state: typeof raw.state === 'string' ? raw.state.toUpperCase() : null,
    draft: raw.draft ?? false,
    headRef: raw.head?.ref ?? null,
    headSha: raw.head?.sha ?? null,
    headRepository: raw.head?.repo?.full_name ?? null,
    baseRef: raw.base?.ref ?? null,
    baseSha: raw.base?.sha ?? null,
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
    operations: ['update-pull-request-base'],
    compareAndSwap: false,
    provider: `github:${owner}/${name}`,
  }
}

export function readPullRequest(number) {
  const { owner, name } = repositoryCoordinates()
  const raw = ghJson([
    'api',
    '-R',
    `${owner}/${name}`,
    '--method',
    'GET',
    `repos/${owner}/${name}/pulls/${number}`,
    '-f',
    'per_page=1',
  ])
  return { ok: true, pullRequest: toPullRequest(raw) }
}

export function updatePullRequestBase(number, base) {
  const { owner, name } = repositoryCoordinates()
  const raw = ghJson([
    'api',
    '-R',
    `${owner}/${name}`,
    '--method',
    'PATCH',
    `repos/${owner}/${name}/pulls/${number}`,
    '-f',
    `base=${base}`,
  ])
  return {
    ok: true,
    applied: raw?.base?.ref === base,
    preconditionMet: null,
    provider: 'github',
  }
}
