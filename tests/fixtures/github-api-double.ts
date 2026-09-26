import { execFileSync } from 'node:child_process'
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
) {
  const requestedSha = fields.sha
  const method = String(fields.merge_method || '')
  const allowed: Record<string, boolean> = {
    merge: state.repository.allowMergeCommit === true,
    squash: state.repository.allowSquashMerge === true,
    rebase: state.repository.allowRebaseMerge === true,
  }
  if (!allowed[method]) return { merged: false, message: `merge method ${method} is disabled` }
  const head = currentHead(pr)
  if (!head || requestedSha !== head)
    return { merged: false, message: 'head SHA no longer matches' }
  if (pr.state !== 'OPEN') return { merged: false, message: 'pull request is not open' }
  const baseRef = `refs/heads/${pr.base}`
  const base = bareRef(baseRef)
  if (!base) return { merged: false, message: `base branch ${pr.base} is missing` }
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message)
  }
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

function handleRest(
  state: GitHubFixtureState,
  request: GitHubApiDoubleRequest,
): { status: number; body: unknown } {
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
      if (!stack) throw new HttpError(404, 'Not Found', `Stack #${stackNum} not found`)
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
  if (path === prefix && method === 'GET') {
    return {
      status: 200,
      body: {
        full_name: repository,
        default_branch: state.repository.defaultBranch,
        allow_merge_commit: state.repository.allowMergeCommit === true,
        allow_squash_merge: state.repository.allowSquashMerge === true,
        allow_rebase_merge: state.repository.allowRebaseMerge === true,
      },
    }
  }
  const pull = new RegExp(`^${prefix}/pulls/(\\d+)$`, 'u').exec(path)
  if (pull) {
    const pr = findPr(state, Number(pull[1]))
    if (method === 'GET') return { status: 200, body: restPullRequest(state, pr) }
    if (method === 'PATCH') {
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
    return { status: 200, body: mergePullRequest(state, findPr(state, Number(merge[1])), body) }
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

function handleGraphql(
  state: GitHubFixtureState,
  body: Record<string, unknown>,
): { status: number; body: unknown } {
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
    try {
      const result =
        request.path === 'graphql' ? handleGraphql(state, body) : handleRest(state, request)
      saveState(state)
      return json(result.status, result.body)
    } catch (error) {
      saveState(state)
      if (error instanceof HttpError) return json(error.status, { message: error.message })
      throw error
    }
  }) as typeof globalThis.fetch
  return double
}
