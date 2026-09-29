import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { GitHubFixtureState } from './github-harness'

/**
 * Transport test double: serves the same fixture state the `gh` CLI fixture serves, but as
 * REST/GraphQL HTTP responses, so domain code exercises the direct transport end to end.
 */
export interface GitHubApiDoubleRequest {
  method: string
  path: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

const statePath = () => {
  const value = process.env.GIT_STACKS_FIXTURE_STATE
  if (!value) throw new Error('GIT_STACKS_FIXTURE_STATE is required by the GitHub API double')
  return value
}

const barePath = () => {
  const value = process.env.GIT_STACKS_FIXTURE_BARE
  if (!value) throw new Error('GIT_STACKS_FIXTURE_BARE is required by the GitHub API double')
  return value
}

const realGit = () => process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'

function loadState(): GitHubFixtureState {
  return JSON.parse(readFileSync(statePath(), 'utf8')) as GitHubFixtureState
}

function saveState(state: GitHubFixtureState): void {
  const temporary = `${statePath()}.${process.pid}.api.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, statePath())
}

function bareGit(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(realGit(), ['--git-dir', barePath(), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim()
}

function bareRef(ref: string): string | null {
  try {
    return bareGit(['rev-parse', '--verify', '--end-of-options', ref]) || null
  } catch {
    return null
  }
}

function currentHead(pr: GitHubFixtureState['prs'][number]): string | null {
  pr.headOid = bareRef(`refs/heads/${pr.head}`)
  return pr.headOid
}

function checkEntry(pr: GitHubFixtureState['prs'][number]) {
  if (pr.checks === 'passing') return { state: 'SUCCESS' }
  if (pr.checks === 'failing') return { state: 'FAILURE' }
  if (pr.checks === 'pending') return { state: 'PENDING' }
  return null
}

function graphPullRequest(pr: GitHubFixtureState['prs'][number], withBody: boolean) {
  const merged = pr.state === 'MERGED'
  const value: Record<string, unknown> = {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.head,
    headRefOid: currentHead(pr),
    baseRefName: pr.base,
    isDraft: pr.draft === true,
    state: pr.state,
    reviewDecision: pr.reviewDecision || null,
    mergeStateStatus: pr.mergeState || null,
    headRepository: { nameWithOwner: pr.headRepository },
    mergeCommit: merged && pr.mergeOid ? { oid: pr.mergeOid } : null,
    commits: { nodes: [] },
  }
  const checks = checkEntry(pr)
  if (checks)
    (value.commits as { nodes: unknown[] }).nodes.push({ commit: { statusCheckRollup: checks } })
  if (withBody) value.body = pr.body || ''
  return value
}

function restPullRequest(state: GitHubFixtureState, pr: GitHubFixtureState['prs'][number]) {
  const merged = pr.state === 'MERGED'
  const stack = (state.stacks ?? []).find((s) =>
    s.pull_requests.some((p) => p.number === pr.number),
  )
  let stackObj: Record<string, unknown> | null = null
  if (stack) {
    const position = stack.pull_requests.findIndex((p) => p.number === pr.number) + 1
    stackObj = {
      id: stack.id,
      number: stack.number,
      url: stack.url,
      size: stack.pull_requests.length,
      position,
      base: position === 1 ? stack.base.ref : stack.pull_requests[position - 2].head.ref,
    }
  }
  return {
    number: pr.number,
    title: pr.title,
    html_url: pr.url,
    body: pr.body || '',
    state: merged ? 'closed' : pr.state.toLowerCase(),
    draft: pr.draft === true,
    head: { ref: pr.head, sha: currentHead(pr), repo: { full_name: pr.headRepository } },
    base: { ref: pr.base },
    merge_commit_sha: pr.mergeOid || null,
    ...(stackObj ? { stack: stackObj } : {}),
  }
}

function formatStack(
  state: GitHubFixtureState,
  stack: NonNullable<GitHubFixtureState['stacks']>[number],
) {
  return {
    id: stack.id,
    number: stack.number,
    node_id: stack.node_id,
    url: stack.url,
    base: { ref: stack.base.ref },
    open: stack.open,
    created_at: stack.created_at,
    pull_requests: stack.pull_requests.map((p) => {
      const pr = state.prs.find((entry) => entry.number === p.number)
      return {
        number: p.number,
        state: p.state,
        draft: p.draft,
        merged_at: p.merged_at,
        head: {
          ref: p.head.ref,
          sha: (pr ? currentHead(pr) : null) ?? p.head.sha ?? '',
        },
      }
    }),
  }
}

function actor(login: string) {
  const id = [...login].reduce(
    (hash, character) => (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    5381,
  )
  return { id, login }
}

function findPr(state: GitHubFixtureState, number: number) {
  const pr = state.prs.find((entry) => entry.number === number)
  if (!pr) throw new HttpError(404, 'Not Found', `No pull request found for number ${number}`)
  return pr
}

function nextNumber(state: GitHubFixtureState): number {
  const number = Number.isInteger(state.nextNumber) ? state.nextNumber : 1
  state.nextNumber = number + 1
  return number
}

function mergePullRequest(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  fields: Record<string, unknown>,
): { merged: boolean; message: string; sha: string | null } {
  const requestedSha = fields.sha
  const method = String(fields.merge_method || '')
  const allowed: Record<string, boolean> = {
    merge: state.repository.allowMergeCommit === true,
    squash: state.repository.allowSquashMerge === true,
    rebase: state.repository.allowRebaseMerge === true,
  }
  if (!allowed[method])
    return { merged: false, message: `merge method ${method} is disabled`, sha: null }
  const head = currentHead(pr)
  if (!head || requestedSha !== head)
    return { merged: false, message: 'head SHA no longer matches', sha: null }
  if (pr.state !== 'OPEN') return { merged: false, message: 'pull request is not open', sha: null }
  // A stacked merge lands every pull request of the group on the branch the bottom one
  // targets, which is how GitHub merges a stack; no branch inside the stack moves.
  const baseName = typeof fields.base === 'string' ? fields.base : pr.base
  const baseRef = `refs/heads/${baseName}`
  const base = bareRef(baseRef)
  if (!base) return { merged: false, message: `base branch ${baseName} is missing`, sha: null }
  const tree = bareGit(['rev-parse', `${head}^{tree}`])
  const parents = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base]
  const mergedOid = bareGit(
    ['commit-tree', tree, ...parents, '-m', `${pr.title} (#${pr.number})`],
    {
      GIT_AUTHOR_NAME: 'GitHub Fixture',
      GIT_AUTHOR_EMAIL: 'github-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'GitHub Fixture',
      GIT_COMMITTER_EMAIL: 'github-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  )
  bareGit(['update-ref', baseRef, mergedOid, base])
  pr.state = 'MERGED'
  pr.mergedAt = new Date().toISOString()
  pr.mergeOid = mergedOid
  return { merged: true, sha: mergedOid, message: 'Pull Request successfully merged' }
}

/**
 * A stacked pull request's merge includes every open pull request below it in the same stack,
 * which is what the asynchronous merge endpoint documents. The downstack is merged first so
 * the upstack request lands on the same base it was reviewed against.
 */
function mergeStackedPullRequest(
  state: GitHubFixtureState,
  pr: GitHubFixtureState['prs'][number],
  sha: string,
  method: string,
) {
  const stack = (state.stacks ?? []).find((s) =>
    s.pull_requests.some((p) => p.number === pr.number),
  )
  if (!stack) return mergePullRequest(state, pr, { sha, merge_method: method })
  const order = stack.pull_requests.map((p) => p.number)
  const position = order.indexOf(pr.number)
  let last: { merged: boolean; message: string; sha: string | null } = {
    merged: false,
    message: 'no downstack pull request was merged',
    sha: null,
  }
  // GitHub merges a stack into the branch its bottom pull request targets, so no branch
  // inside the group is rewritten and the retargeting it does afterwards is observable.
  const bottom = state.prs.find((entry) => entry.number === order[0])
  const stackBase = bottom?.base ?? pr.base
  for (const number of order.slice(0, position + 1)) {
    const member = state.prs.find((entry) => entry.number === number)
    if (!member || member.state !== 'OPEN') continue
    last =
      number === pr.number
        ? mergePullRequest(state, member, { sha, merge_method: method, base: stackBase })
        : mergePullRequest(state, member, {
            sha: currentHead(member),
            merge_method: method === 'rebase' ? 'squash' : method,
            base: stackBase,
          })
    if (!last.merged) break
  }
  return last
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

type RestResult = { status: number; body: unknown; headers?: Record<string, string> }

function etagFor(body: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`
}

function checkRunResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string,
): RestResult {
  const runs = (state.checks?.checkRuns ?? []).filter((run) => run.headSha === headSha)
  const body = {
    total_count: runs.length,
    check_runs: runs.map((run) => ({
      id: run.id,
      head_sha: run.headSha,
      node_id: `CR_${run.id}`,
      external_id: null,
      url: `https://api.github.com/repos/acme/widgets/check-runs/${run.id}`,
      html_url: `https://github.com/acme/widgets/runs/${run.id}`,
      details_url: run.detailsUrl ?? null,
      status: run.status,
      conclusion: run.conclusion,
      started_at: run.startedAt ?? null,
      completed_at: run.completedAt ?? null,
      output: { title: run.title ?? null, summary: null, text: null, annotations_count: 0 },
      name: run.name,
      check_suite: { id: Math.floor(run.id / 10) },
      app: run.appSlug ? { id: 1, slug: run.appSlug, name: run.appSlug } : null,
      pull_requests: [],
    })),
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function commitStatusResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string,
): RestResult {
  const statuses = (state.checks?.commitStatuses ?? []).filter((entry) => entry.headSha === headSha)
  const body = {
    state: statuses.some((entry) => entry.state === 'failure' || entry.state === 'error')
      ? 'failure'
      : statuses.some((entry) => entry.state === 'pending')
        ? 'pending'
        : 'success',
    statuses: statuses.map((entry) => ({
      description: entry.description ?? null,
      id: 900_000,
      node_id: 'CS_1',
      state: entry.state,
      context: entry.context,
      target_url: entry.targetUrl ?? null,
      url: `https://api.github.com/repos/acme/widgets/statuses/900000`,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })),
    sha: headSha,
    total_count: statuses.length,
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function workflowRunsResponse(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  headSha: string | null,
): RestResult {
  const runs = (state.checks?.workflowRuns ?? []).filter(
    (run) => headSha === null || run.headSha === headSha,
  )
  const body = {
    total_count: runs.length,
    workflow_runs: runs.map((run) => ({
      id: run.id,
      name: run.name,
      node_id: `WR_${run.id}`,
      head_branch: null,
      head_sha: run.headSha,
      path: '.github/workflows/ci.yml',
      run_number: run.runNumber ?? run.id,
      run_attempt: 1,
      event: 'pull_request',
      status: run.status,
      conclusion: run.conclusion,
      workflow_id: 1,
      url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}`,
      html_url: run.htmlUrl ?? `https://github.com/acme/widgets/actions/runs/${run.id}`,
      pull_requests: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: run.updatedAt ?? '2026-01-01T00:01:00Z',
      run_started_at: run.startedAt ?? '2026-01-01T00:00:00Z',
      jobs_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/jobs`,
      logs_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/logs`,
      rerun_url: `https://api.github.com/repos/acme/widgets/actions/runs/${run.id}/rerun`,
    })),
  }
  return { status: 200, body, ...conditional(state, request, body) }
}

function conditional(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
  body: unknown,
): { status?: number; body?: unknown; headers?: Record<string, string> } {
  if (!state.checks?.conditional) return {}
  const etag = etagFor(body)
  if (request.headers['if-none-match'] === etag) {
    return { status: 304, body: null, headers: { etag } }
  }
  return { headers: { etag } }
}

/** A canned failure for every native-stacks endpoint, used to prove probe error propagation. */
function stacksFailure(state: GitHubFixtureState): HttpError | null {
  const failure = state.stacksFailure
  if (!failure) return null
  return new HttpError(
    failure.status,
    failure.reason,
    failure.message,
    failure.rateLimitRemaining === undefined
      ? {}
      : { 'x-ratelimit-remaining': String(failure.rateLimitRemaining) },
  )
}

function createPullRequest(state: GitHubFixtureState, body: Record<string, unknown>) {
  const head = String(body.head || '')
  const separator = head.indexOf(':')
  const owner = separator >= 0 ? head.slice(0, separator) : state.repository.owner
  const branch = separator >= 0 ? head.slice(separator + 1) : head
  const headRepository = `${owner}/${state.repository.name}`
  const headOid = bareRef(`refs/heads/${branch}`)
  if (!headOid) throw new HttpError(422, 'Unprocessable Entity', `head branch ${branch} is missing`)
  if (state.prs.some((pr) => pr.head === branch && pr.state === 'OPEN'))
    throw new HttpError(422, 'Unprocessable Entity', `a pull request for ${branch} already exists`)
  const number = nextNumber(state)
  const pr = {
    number,
    title: String(body.title || ''),
    body: String(body.body || ''),
    base: String(body.base || ''),
    head: branch,
    headRepository,
    draft: body.draft === true,
    state: 'OPEN' as const,
    checks: 'none' as const,
    reviewDecision: null as string | null,
    mergeState: 'CLEAN' as string | null,
    url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
    headOid,
    mergeOid: null as string | null,
    mergedAt: null as string | null,
  }
  state.prs.push(pr)
  if (!state.comments) state.comments = {}
  state.comments[String(number)] = []
  return pr
}

function commentResponse(
  state: GitHubFixtureState,
  comment: { id: number; body: string; user?: { login: string }; author?: string },
) {
  return {
    ...comment,
    user: actor(comment.user?.login || comment.author || state.currentUser),
  }
}

function handleRest(state: GitHubFixtureState, request: GitHubApiDoubleRequest): RestResult {
  const { method, path } = request
  const body = request.body
  const repository = `${state.repository.owner}/${state.repository.name}`
  const prefix = `repos/${repository}`
  if (path === 'user') return { status: 200, body: actor(state.currentUser) }
  const [rawPath, rawQuery] = path.split('?')
  const queryParams = new URLSearchParams(rawQuery ?? '')
  if (rawPath.startsWith(`${prefix}/stacks`)) {
    if (state.stacksPreviewDisabled) {
      throw new HttpError(404, 'Not Found', 'Not Found: stacks preview unavailable')
    }
    // Reads still work: a chain write GitHub rejects is a submission failure, not a
    // repository that cannot report anything.
    if (method !== 'GET') {
      const failure = stacksFailure(state)
      if (failure) throw failure
    }
    if (rawPath === `${prefix}/stacks`) {
      if (method === 'GET') {
        let stacks = state.stacks ?? []
        if (queryParams.has('pull_request')) {
          const prNum = Number(queryParams.get('pull_request'))
          stacks = stacks.filter((s) => s.pull_requests.some((p) => p.number === prNum))
        }
        const perPage = Number(queryParams.get('per_page')) || 30
        const page = Number(queryParams.get('page')) || 1
        const start = (page - 1) * perPage
        const paginated = stacks.slice(start, start + perPage)
        return { status: 200, body: paginated.map((s) => formatStack(state, s)) }
      }
      if (method === 'POST') {
        const pullRequestsInput = body.pull_requests
        if (!Array.isArray(pullRequestsInput) || pullRequestsInput.length === 0) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            'pull_requests must be a non-empty array',
          )
        }
        const prs = pullRequestsInput.map((num: unknown) => {
          if (typeof num !== 'number')
            throw new HttpError(422, 'Unprocessable Entity', 'invalid pull request number')
          return findPr(state, num)
        })
        const seen = new Set<number>()
        for (const pr of prs) {
          if (seen.has(pr.number))
            throw new HttpError(422, 'Unprocessable Entity', 'duplicate pull request in stack')
          seen.add(pr.number)
        }
        for (const s of state.stacks ?? []) {
          for (const pr of prs) {
            if (s.pull_requests.some((p) => p.number === pr.number)) {
              throw new HttpError(
                422,
                'Unprocessable Entity',
                `pull request #${pr.number} is already in a stack`,
              )
            }
          }
        }
        for (const pr of prs) {
          if (pr.headRepository.toLowerCase() !== repository.toLowerCase()) {
            throw new HttpError(
              422,
              'Unprocessable Entity',
              `pull request #${pr.number} is from a fork`,
            )
          }
        }
        for (let i = 1; i < prs.length; i++) {
          if (prs[i].base !== prs[i - 1].head) {
            throw new HttpError(
              422,
              'Unprocessable Entity',
              `chain invalid: PR #${prs[i].number} base ${prs[i].base} does not match PR #${prs[i - 1].number} head ${prs[i - 1].head}`,
            )
          }
        }
        const stackNumber = Number.isInteger(state.nextStackNumber) ? state.nextStackNumber!++ : 1
        const newStack = {
          id: stackNumber * 1000,
          number: stackNumber,
          node_id: `STACK_${stackNumber}`,
          url: `https://api.github.com/${prefix}/stacks/${stackNumber}`,
          base: { ref: prs[0].base },
          open: true,
          created_at: new Date().toISOString(),
          pull_requests: prs.map((pr) => ({
            number: pr.number,
            state:
              pr.state === 'MERGED' || pr.state === 'CLOSED'
                ? ('closed' as const)
                : ('open' as const),
            draft: pr.draft === true,
            merged_at: pr.mergedAt,
            head: { ref: pr.head, sha: currentHead(pr) ?? '' },
          })),
        }
        state.stacks = state.stacks ?? []
        state.stacks.push(newStack)
        return { status: 201, body: formatStack(state, newStack) }
      }
      throw new HttpError(405, 'Method Not Allowed', `unsupported stacks method ${method}`)
    }
    const stackMatch = new RegExp(`^${prefix}/stacks/(\\d+)$`, 'u').exec(rawPath)
    if (stackMatch) {
      const stackNum = Number(stackMatch[1])
      const stack = (state.stacks ?? []).find((s) => s.number === stackNum)
      if (!stack || (state.missingStackDetails ?? []).includes(stackNum)) {
        throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      }
      if (method === 'GET') {
        return { status: 200, body: formatStack(state, stack) }
      }
      throw new HttpError(405, 'Method Not Allowed', `unsupported stack method ${method}`)
    }
    const addMatch = new RegExp(`^${prefix}/stacks/(\\d+)/(?:add|pull_requests)$`, 'u').exec(
      rawPath,
    )
    if (addMatch) {
      const stackNum = Number(addMatch[1])
      const stack = (state.stacks ?? []).find((s) => s.number === stackNum)
      if (!stack) throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      if (method !== 'POST')
        throw new HttpError(405, 'Method Not Allowed', 'add pull requests requires POST')
      const pullRequestsInput = body.pull_requests
      if (!Array.isArray(pullRequestsInput) || pullRequestsInput.length === 0) {
        throw new HttpError(422, 'Unprocessable Entity', 'pull_requests must be a non-empty array')
      }
      const prs = pullRequestsInput.map((num: unknown) => {
        if (typeof num !== 'number')
          throw new HttpError(422, 'Unprocessable Entity', 'invalid pull request number')
        return findPr(state, num)
      })
      for (const pr of prs) {
        if (stack.pull_requests.some((p) => p.number === pr.number)) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `pull request #${pr.number} is already in stack #${stackNum}`,
          )
        }
        if (pr.headRepository.toLowerCase() !== repository.toLowerCase()) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `pull request #${pr.number} is from a fork`,
          )
        }
      }
      const topPr = stack.pull_requests[stack.pull_requests.length - 1]
      if (topPr && prs[0].base !== topPr.head.ref) {
        throw new HttpError(
          422,
          'Unprocessable Entity',
          `PR #${prs[0].number} base ${prs[0].base} does not match top of stack head ${topPr.head.ref}`,
        )
      }
      for (let i = 1; i < prs.length; i++) {
        if (prs[i].base !== prs[i - 1].head) {
          throw new HttpError(
            422,
            'Unprocessable Entity',
            `chain invalid: PR #${prs[i].number} base ${prs[i].base} does not match PR #${prs[i - 1].number} head ${prs[i - 1].head}`,
          )
        }
      }
      for (const pr of prs) {
        stack.pull_requests.push({
          number: pr.number,
          state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? 'closed' : 'open',
          draft: pr.draft === true,
          merged_at: pr.mergedAt,
          head: { ref: pr.head, sha: currentHead(pr) ?? '' },
        })
      }
      return { status: 200, body: formatStack(state, stack) }
    }
    const unstackMatch = new RegExp(`^${prefix}/stacks/(\\d+)/unstack$`, 'u').exec(rawPath)
    if (unstackMatch) {
      const stackNum = Number(unstackMatch[1])
      const stackIdx = (state.stacks ?? []).findIndex((s) => s.number === stackNum)
      if (stackIdx === -1) throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'unstack requires POST')
      const stack = state.stacks![stackIdx]
      const remaining = stack.pull_requests.filter(
        (p) => p.merged_at != null || p.state === 'closed',
      )
      if (remaining.length === 0) {
        state.stacks!.splice(stackIdx, 1)
        return { status: 204, body: null }
      } else {
        stack.pull_requests = remaining
        return { status: 200, body: formatStack(state, stack) }
      }
    }
    throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
  }
  if (path !== prefix && !path.startsWith(`${prefix}/`))
    throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
  if (rawPath === prefix && method === 'GET') {
    const role = state.checks?.viewerPermissions
    return {
      status: 200,
      body: {
        full_name: repository,
        default_branch: state.repository.defaultBranch,
        allow_merge_commit: state.repository.allowMergeCommit === true,
        allow_squash_merge: state.repository.allowSquashMerge === true,
        allow_rebase_merge: state.repository.allowRebaseMerge === true,
        // GitHub only reports the viewer's own role, and only when it is authenticated.
        ...(role ? { permissions: role } : {}),
      },
    }
  }
  if (rawPath === `${prefix}/actions/permissions` && method === 'GET') {
    return {
      status: 200,
      body: {
        enabled: state.checks?.actionsEnabled === true,
        allowed_actions: 'all',
        sha_pinning_required: false,
      },
    }
  }
  const rerun = new RegExp(`^${prefix}/actions/runs/(\\d+)/rerun$`, 'u').exec(rawPath)
  if (rerun) {
    if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed', 'rerun requires POST')
    const runId = Number(rerun[1])
    if (state.checks?.rerunForbidden)
      throw new HttpError(403, 'Forbidden', 'Resource not accessible by integration')
    const known = (state.checks?.workflowRuns ?? []).some((entry) => entry.id === runId)
    if (!known) throw new HttpError(404, 'Not Found', `Workflow run ${runId} not found`)
    state.checks = { ...state.checks, reruns: [...(state.checks?.reruns ?? []), runId] }
    return { status: 201, body: null }
  }
  if (rawPath === `${prefix}/actions/runs` && method === 'GET') {
    return workflowRunsResponse(state, request, queryParams.get('head_sha'))
  }
  const checkRuns = new RegExp(`^${prefix}/commits/([^/]+)/check-runs$`, 'u').exec(rawPath)
  if (checkRuns) {
    if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', 'check runs are read-only')
    return checkRunResponse(state, request, decodeURIComponent(checkRuns[1]))
  }
  const commitStatus = new RegExp(`^${prefix}/commits/([^/]+)/status$`, 'u').exec(rawPath)
  if (commitStatus) {
    if (method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'commit status is read-only')
    return commitStatusResponse(state, request, decodeURIComponent(commitStatus[1]))
  }
  const requiredChecks = new RegExp(
    `^${prefix}/branches/([^/]+)/protection/required_status_checks$`,
    'u',
  ).exec(rawPath)
  if (requiredChecks) {
    const rule = state.checks?.requiredStatusChecks
    const branch = decodeURIComponent(requiredChecks[1])
    if (!rule || rule.branch !== branch)
      throw new HttpError(404, 'Not Found', 'Branch not protected')
    return {
      status: 200,
      body: {
        url: `https://api.github.com/repos/${repository}/branches/${branch}/protection/required_status_checks`,
        strict: true,
        contexts: rule.contexts,
        checks: rule.contexts.map((context) => ({ context, app_id: 1 })),
        contexts_url: `https://api.github.com/repos/${repository}/branches/${branch}/protection/required_status_checks/contexts`,
      },
    }
  }
  const pull = new RegExp(`^${prefix}/pulls/(\\d+)$`, 'u').exec(path)
  if (pull) {
    const pr = findPr(state, Number(pull[1]))
    if (method === 'GET') return { status: 200, body: restPullRequest(state, pr) }
    if (method === 'PATCH') {
      if (state.prWriteFailure) {
        throw new HttpError(
          state.prWriteFailure.status,
          state.prWriteFailure.reason,
          state.prWriteFailure.message,
        )
      }
      if (body.draft !== undefined)
        throw new HttpError(422, 'Unprocessable Entity', 'draft cannot be updated through REST')
      if (pr.state === 'MERGED' && body.state === 'open')
        throw new HttpError(422, 'Unprocessable Entity', 'Pull request is merged')
      if (typeof body.title === 'string') pr.title = body.title
      if (typeof body.body === 'string') pr.body = body.body
      if (typeof body.base === 'string') pr.base = body.base
      if (typeof body.state === 'string') {
        if (body.state === 'open' && pr.state !== 'MERGED') pr.state = 'OPEN'
        else if (body.state === 'closed' && pr.state !== 'MERGED') pr.state = 'CLOSED'
      }
      return { status: 200, body: restPullRequest(state, pr) }
    }
    throw new HttpError(405, 'Method Not Allowed', `unsupported pull request method ${method}`)
  }
  if (method === 'POST' && path === `${prefix}/pulls`) {
    const pr = createPullRequest(state, body)
    return {
      status: 201,
      body: { ...restPullRequest(state, pr), number: pr.number, html_url: pr.url },
    }
  }
  const merge = new RegExp(`^${prefix}/pulls/(\\d+)/merge$`, 'u').exec(path)
  if (merge) {
    if (method !== 'PUT') throw new HttpError(405, 'Method Not Allowed', 'merge requires PUT')
    if (
      (state.stacks ?? []).some((stack) =>
        stack.pull_requests.some((pr) => pr.number === Number(merge[1])),
      )
    )
      throw new HttpError(405, 'Method Not Allowed', 'stacked pull requests require merge-async')
    return { status: 200, body: mergePullRequest(state, findPr(state, Number(merge[1])), body) }
  }
  const asyncMerge = new RegExp(`^${prefix}/pulls/(\\d+)/merge-async(?:/([^/]+))?$`, 'u').exec(path)
  if (asyncMerge) {
    const number = Number(asyncMerge[1])
    if (!asyncMerge[2] && method === 'PUT') {
      const pr = findPr(state, number)
      const action = String(body.merge_action || 'default')
      if (action !== 'default' && action !== 'direct_merge' && action !== 'merge_queue')
        throw new HttpError(422, 'Unprocessable Entity', 'merge_action must be a documented value')
      if (pr.state !== 'OPEN' || pr.draft)
        throw new HttpError(400, 'Bad Request', 'Pull request is not ready to be merged')
      // A second request for a pull request that already has one is refused with that
      // request's own identity, which is what a client has to adopt rather than duplicate.
      if (state.asyncMerge?.number === number)
        return {
          status: 409,
          body: {
            status: 'pending',
            details: {
              message: 'a merge request is already enqueued for this pull request',
              uuid: state.asyncMerge.uuid,
              merge_method: state.asyncMerge.method || 'squash',
              merge_action: state.asyncMerge.action,
              expected_head_sha: state.asyncMerge.sha,
            },
          },
        }
      const queued = action === 'merge_queue' || (action === 'default' && state.mergeQueue === true)
      // The documented `200`: this pull request is already in a merge queue, so the result
      // is terminal and GitHub hands back no request identity to read it through.
      if (queued && state.asyncMergeAlreadyQueued) {
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: state.asyncMergeResult?.message ?? 'Already in the merge queue' },
          },
        }
      }
      const uuid = `fixture-${number}`
      state.asyncMerge = {
        number,
        sha: String(body.sha),
        method: queued ? '' : String(body.merge_method || ''),
        action: queued ? 'merge_queue' : 'direct_merge',
        uuid,
      }
      return {
        status: 202,
        body: { status: 'pending', details: { uuid, message: 'merge request accepted' } },
      }
    }
    if (asyncMerge[2] && method === 'GET') {
      const pending = state.asyncMerge
      if (!pending || pending.uuid !== asyncMerge[2] || pending.number !== number)
        throw new HttpError(404, 'Not Found', 'Unknown merge request')
      if (state.asyncMergeStaysPending) {
        return {
          status: 200,
          body: {
            status: 'pending',
            details: { uuid: pending.uuid, message: 'merge in progress' },
          },
        }
      }
      const canned = state.asyncMergeResult
      const pr = findPr(state, number)
      if (canned?.status === 'enqueued') {
        delete state.asyncMerge
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: canned.message ?? 'Added to the merge queue' },
          },
        }
      }
      if (canned?.status === 'failed') {
        delete state.asyncMerge
        return {
          status: 200,
          body: { status: 'failed', details: { message: canned.message ?? 'merge failed' } },
        }
      }
      if (pending.action === 'merge_queue') {
        // An enqueued result is terminal and means the pull request joined a queue, not that
        // it merged; the queue itself is not simulated further.
        delete state.asyncMerge
        return {
          status: 200,
          body: {
            status: 'enqueued',
            details: { message: canned?.message ?? 'Added to the merge queue' },
          },
        }
      }
      const result = mergeStackedPullRequest(state, pr, pending.sha, pending.method)
      delete state.asyncMerge
      return {
        status: 200,
        body: result.merged
          ? { status: 'merged', details: { message: result.message, sha: result.sha } }
          : { status: 'failed', details: { message: result.message } },
      }
    }
    throw new HttpError(404, 'Not Found', 'Unknown merge request')
  }
  const comments = new RegExp(`^${prefix}/issues/(\\d+)/comments$`, 'u').exec(path)
  if (comments) {
    const key = String(Number(comments[1]))
    if (!Array.isArray(state.comments?.[key])) state.comments = { ...state.comments, [key]: [] }
    const list = state.comments[key]
    if (method === 'GET')
      return { status: 200, body: list.map((entry) => commentResponse(state, entry)) }
    if (method !== 'POST')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported comments method')
    const id = Number.isInteger(state.nextCommentId) ? state.nextCommentId++ : 2
    const comment = { id, body: String(body.body || ''), user: actor(state.currentUser) }
    list.push(comment)
    return { status: 201, body: commentResponse(state, comment) }
  }
  const comment = new RegExp(`^${prefix}/issues/comments/(\\d+)$`, 'u').exec(path)
  if (comment) {
    const id = Number(comment[1])
    const entry = Object.values(state.comments || {})
      .flat()
      .find((candidate) => candidate && candidate.id === id)
    if (!entry) throw new HttpError(404, 'Not Found', `Not Found: comment ${id}`)
    if (method === 'PATCH') entry.body = String(body.body || '')
    if (method !== 'PATCH' && method !== 'GET')
      throw new HttpError(405, 'Method Not Allowed', 'unsupported comment method')
    return { status: 200, body: commentResponse(state, entry) }
  }
  throw new HttpError(404, 'Not Found', `Not Found: ${path}`)
}

function handleGraphql(state: GitHubFixtureState, body: Record<string, unknown>): RestResult {
  const query = String(body.query || '')
  const variables = (body.variables ?? {}) as Record<string, unknown>
  const field = query.includes('convertPullRequestToDraft')
    ? 'convertPullRequestToDraft'
    : query.includes('markPullRequestReadyForReview')
      ? 'markPullRequestReadyForReview'
      : null
  if (field) {
    const match = /^PR_(\d+)$/u.exec(String(variables.pullRequestId || ''))
    if (!match) throw new HttpError(422, 'Unprocessable Entity', 'Invalid pull request ID')
    const pr = findPr(state, Number(match[1]))
    if (pr.state !== 'OPEN')
      throw new HttpError(422, 'Unprocessable Entity', 'Pull request is not open')
    pr.draft = field === 'convertPullRequestToDraft'
    return {
      status: 200,
      body: { data: { [field]: { pullRequest: { id: `PR_${pr.number}`, isDraft: pr.draft } } } },
    }
  }
  if (query.includes('search(query:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const rawQuery = String(variables.searchQuery ?? variables.query ?? '')
    const terms = rawQuery
      .replace(/repo:[^\s]+/gu, '')
      .replace(/is:issue/gu, '')
      .trim()
      .toLowerCase()
    const issues = state.issues ?? []
    let matched = issues
    if (terms) {
      matched = issues.filter((iss) => {
        if (String(iss.number) === terms || `#${iss.number}` === terms) return true
        return iss.title.toLowerCase().includes(terms)
      })
    }
    return {
      status: 200,
      body: {
        data: {
          search: {
            issueCount: matched.length,
            nodes: matched.map((iss) => ({
              __typename: 'Issue',
              number: iss.number,
              title: iss.title,
              url: iss.url,
              state: iss.state,
              repository: { nameWithOwner: iss.repository ?? 'acme/widgets' },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }
  }
  if (query.includes('issue(number:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const num = Number(variables.number)
    const iss = (state.issues ?? []).find((i) => i.number === num)
    return {
      status: 200,
      body: {
        data: {
          repository: {
            issue: iss
              ? { number: iss.number, title: iss.title, url: iss.url, state: iss.state }
              : null,
          },
        },
      },
    }
  }
  if (query.includes('issues(first:')) {
    if (state.issuesFailure) {
      throw new HttpError(
        state.issuesFailure.status,
        state.issuesFailure.reason,
        state.issuesFailure.message,
      )
    }
    const issues = (state.issues ?? []).filter((iss) => iss.state === 'OPEN')
    return {
      status: 200,
      body: {
        data: {
          repository: {
            issues: {
              nodes: issues.map((iss) => ({ number: iss.number, title: iss.title, url: iss.url })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }
  }
  if (query.includes('pullRequest(number:')) {
    const pr = findPr(state, Number(variables.number))
    return {
      status: 200,
      body: { data: { repository: { pullRequest: graphPullRequest(pr, true) } } },
    }
  }
  const after = typeof variables.endCursor === 'string' ? variables.endCursor : null
  const open = state.prs.filter((pr) => pr.state === 'OPEN')
  // One PR per page so a second request with a cursor proves the loop advanced.
  const start = after ? Number(after.replace('cursor:', '')) : 0
  const nodes = open.slice(start, start + 1).map((pr) => graphPullRequest(pr, false))
  const next = start + 1
  return {
    status: 200,
    body: {
      data: {
        repository: {
          pullRequests: {
            nodes,
            pageInfo: {
              hasNextPage: next < open.length,
              endCursor: next < open.length ? `cursor:${next}` : null,
            },
          },
        },
      },
    },
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const isNoBody = status === 204 || status === 205 || status === 304
  return new Response(isNoBody ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(isNoBody ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core',
      ...headers,
    },
  })
}

/** A `fetch` implementation that answers GitHub requests from the harness fixture state. */
export function createGitHubApiDouble(): typeof globalThis.fetch {
  const double = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : String(input))
    const method = (init?.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers || {}).forEach((value, key) => {
      headers[key] = value
    })
    let body: Record<string, unknown> = {}
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        return json(400, { message: 'Problems parsing JSON' })
      }
    }
    if (headers.authorization !== 'Bearer fixture-token')
      return json(401, { message: 'Bad credentials' })
    const state = loadState()
    if (!Array.isArray(state.requests)) state.requests = []
    const path = (url.pathname + url.search).replace(/^\//u, '')
    state.requests.push({
      argv: [path, method],
      cwd: process.cwd(),
      at: new Date().toISOString(),
      ...(Object.keys(body).length > 0 ? { body } : {}),
    })
    const request: GitHubApiDoubleRequest = { method, path, body, headers }
    const lost = (state.lostResponses ?? []).findIndex((rule) => {
      if (rule.method !== method || !request.path.includes(rule.pathIncludes)) return false
      if (rule.pathEndsWith !== undefined && !request.path.endsWith(rule.pathEndsWith)) return false
      if (rule.after === undefined) return true
      // A run can read the same path more than once, so a rule names which
      // occurrence it answers: zero is the first request that matches. The count
      // uses the rule's own path match, so a `POST /stacks/1/unstack` never
      // counts as a read of `/stacks/1`.
      const seen = (state.requests ?? []).filter((entry) => {
        const path = entry.argv?.[0] ?? ''
        if (!path.includes(rule.pathIncludes)) return false
        return rule.pathEndsWith === undefined || path.endsWith(rule.pathEndsWith)
      }).length
      return seen - 1 === rule.after
    })
    try {
      const result =
        request.path === 'graphql' ? handleGraphql(state, body) : handleRest(state, request)
      // Somebody else pushes and closes a pull request after the response above was built but
      // before the caller sees it. The listing the caller is holding is now a stale snapshot,
      // which is the window a single earlier read cannot cover.
      const drift = (state.driftOnRequest ?? []).findIndex((rule) => {
        if (!request.path.includes(rule.pathIncludes)) return false
        const seen = (state.requests ?? []).filter((entry) =>
          entry.argv[0]?.includes(rule.pathIncludes),
        ).length
        return seen - 1 === (rule.after ?? 0)
      })
      if (drift !== -1) {
        const rule = (state.driftOnRequest ?? [])[drift]
        state.driftOnRequest = (state.driftOnRequest ?? []).filter((_, index) => index !== drift)
        saveState(state)
        bareGit(['update-ref', rule.ref, rule.to])
      }
      const closeIndex = (state.closeOnRequest ?? []).findIndex((rule) => {
        if (!request.path.includes(rule.pathIncludes)) return false
        const seen = (state.requests ?? []).filter((entry) =>
          entry.argv[0]?.includes(rule.pathIncludes),
        ).length
        return seen - 1 === (rule.after ?? 0)
      })
      if (closeIndex !== -1) {
        const rule = (state.closeOnRequest ?? [])[closeIndex]
        state.closeOnRequest = (state.closeOnRequest ?? []).filter((_, i) => i !== closeIndex)
        const pr = state.prs.find((candidate) => candidate.number === rule.number)
        if (pr) pr.state = 'CLOSED'
        for (const stack of state.stacks ?? []) {
          const member = stack.pull_requests.find((item) => item.number === rule.number)
          if (member) member.state = 'closed'
        }
        saveState(state)
      }
      saveState(state)
      if (lost !== -1) {
        // GitHub took the change; the caller never hears about it, which is what a dropped
        // connection mid-request looks like to the person waiting.
        const rule = (state.lostResponses ?? [])[lost]
        state.lostResponses = (state.lostResponses ?? []).filter((_, index) => index !== lost)
        saveState(state)
        return json(rule.status, { message: rule.message })
      }
      return json(result.status, result.body, result.headers ?? {})
    } catch (error) {
      saveState(state)
      if (error instanceof HttpError) {
        return json(error.status, { message: error.message }, error.headers)
      }
      throw error
    }
  }) as typeof globalThis.fetch
  return double
}
