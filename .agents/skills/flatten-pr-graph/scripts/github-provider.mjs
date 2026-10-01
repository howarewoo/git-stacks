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
 *   capabilities()          -> reads the server version, and reports
 *                              `compareAndSwap: true` only because PATCH /pulls/{n}
 *                              accepts an `expected_base` the server enforces
 *   readPullRequest(number) -> GET /repos/{owner}/{repo}/pulls/{n}
 *   updatePullRequestBase(number, base, expectedBase)
 *                           -> PATCH /repos/{owner}/{repo}/pulls/{n}
 *                              with `base` and, when the caller pinned one, `expected_base`
 *
 * There is no merge, no queue, no ruleset, no check, no label, no reviewer, and no
 * branch-protection read here, and no code path that could be extended into one by
 * configuration: the endpoint, the verb, and the field names are literals.
 *
 * `expected_base` is GitHub's own precondition on the base branch, so a base retarget
 * that races a concurrent change is refused by the server instead of silently winning.
 * That is a genuine compare-and-swap, and the caller is told so rather than told it has a
 * read-before-write guard.
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

/** The repository `gh` is pointed at, read from gh itself so no name is hard-coded. */
function repositoryCoordinates() {
  const parsed = JSON.parse(gh(['repo', 'view', '--json', 'owner,name']))
  return { owner: parsed.owner.login, name: parsed.name }
}

function ghJson(args) {
  return JSON.parse(gh(args))
}

function toPullRequest(raw) {
  return {
    number: raw.number,
    state: raw.state,
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
  // A token without pull-request write scope fails here rather than at the first write.
  gh(['api', 'rate_limit', '--jq', '.resources.core.remaining'])
  return {
    operations: ['update-pull-request-base'],
    compareAndSwap: true,
    provider: `github:${repositoryCoordinates().owner}/${repositoryCoordinates().name}`,
  }
}

export function readPullRequest(number) {
  const { owner, name } = repositoryCoordinates()
  const raw = ghJson([
    'api',
    '--method',
    'GET',
    `repos/${owner}/${name}/pulls/${number}`,
    '-f',
    `per_page=1`,
  ])
  return { ok: true, pullRequest: toPullRequest(raw) }
}

export function updatePullRequestBase(number, base, expectedBase) {
  const { owner, name } = repositoryCoordinates()
  const fields = ['-f', `base=${base}`]
  if (typeof expectedBase === 'string' && expectedBase.length > 0) {
    fields.push('-f', `expected_base=${expectedBase}`)
  }
  const raw = ghJson([
    'api',
    '--method',
    'PATCH',
    `repos/${owner}/${name}/pulls/${number}`,
    ...fields,
  ])
  return {
    ok: true,
    applied: raw?.base?.ref === base,
    preconditionMet: typeof expectedBase === 'string' ? raw?.base?.ref === base : null,
    provider: 'github',
  }
}
