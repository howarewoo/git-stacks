'use strict'

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

/** A request the fixture refuses, reported to Git Stacks as a failed `gh` run. */
class GitHubCliFailure extends Error {
  constructor(message) {
    super(message)
    this.name = 'GitHubCliFailure'
    this.code = 2
  }
}

function fail(message) {
  throw new GitHubCliFailure(message)
}

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (error) {
    fail(`cannot read fixture state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function saveState(state, statePath) {
  const temporary = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, statePath)
}

function valueFor(args, flag) {
  const index = args.lastIndexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function jsonValues(args, input) {
  const flag = valueFor(args, '--input')
  if (flag === undefined) return {}
  if (flag !== '-') fail('the fixture expects JSON on stdin')
  try {
    return JSON.parse(input === undefined ? '' : input)
  } catch {
    fail('invalid JSON input')
  }
}

function bareGit(args, fixture, options = {}) {
  const result = spawnSync(fixture.realGit, ['--git-dir', fixture.barePath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return String(result.stdout || '').trim()
}

function bareRef(ref, fixture) {
  try {
    return bareGit(['rev-parse', '--verify', '--end-of-options', ref], fixture)
  } catch {
    return null
  }
}

function currentHead(pr, fixture) {
  const value = bareRef(`refs/heads/${pr.head}`, fixture)
  pr.headOid = value
  return value
}

function checkEntry(pr) {
  if (pr.checks === 'passing') return { state: 'SUCCESS' }
  if (pr.checks === 'failing') return { state: 'FAILURE' }
  if (pr.checks === 'pending') return { state: 'PENDING' }
  return null
}

function graphPullRequest(pr, withBody, fixture) {
  const merged = pr.state === 'MERGED'
  const value = {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.head,
    headRefOid: currentHead(pr, fixture),
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
  if (checks) value.commits.nodes.push({ commit: { statusCheckRollup: checks } })
  if (withBody) value.body = pr.body || ''
  return value
}

function restPullRequest(state, pr, fixture) {
  const merged = pr.state === 'MERGED'
  const stack = (state.stacks || []).find((s) =>
    s.pull_requests.some((p) => p.number === pr.number),
  )
  let stackObj = null
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
    merged_at: merged ? pr.mergedAt || '2026-01-01T00:00:00.000Z' : null,
    draft: pr.draft === true,
    head: { ref: pr.head, sha: currentHead(pr, fixture), repo: { full_name: pr.headRepository } },
    base: { ref: pr.base },
    mergeable_state: String(pr.mergeState || 'clean').toLowerCase(),
    merge_commit_sha: pr.mergeOid || null,
    reviewDecision: pr.reviewDecision || null,
    ...(stackObj ? { stack: stackObj } : {}),
  }
}

function formatStack(state, stack, fixture) {
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
          sha: pr ? currentHead(pr, fixture) : p.head.sha,
        },
      }
    }),
  }
}

function repositoryName(args) {
  const repoFlag = valueFor(args, '--repo')
  if (repoFlag) return repoFlag.replace(/^github\.com\//u, '').replace(/\.git$/u, '')
  return null
}

function requireRepository(state, args, forms) {
  const owner = forms.get('owner')
  const name = forms.get('name')
  const explicit = repositoryName(args)
  const requested = explicit || (owner && name ? `${owner}/${name}` : null)
  const expected = `${state.repository.owner}/${state.repository.name}`
  if (requested && requested.toLowerCase() !== expected.toLowerCase()) {
    fail(`fixture does not contain repository ${requested}`)
  }
}

function findPr(state, number) {
  const pr = state.prs.find((entry) => entry.number === number)
  if (!pr) fail(`unknown pull request #${number}`)
  return pr
}

function nextNumber(state) {
  const number = Number.isInteger(state.nextNumber) ? state.nextNumber : 1
  state.nextNumber = number + 1
  return number
}

function record(state, args, cwd) {
  if (!Array.isArray(state.requests)) state.requests = []
  state.requests.push({
    argv: [...args],
    cwd,
    at: new Date().toISOString(),
  })
}

function parseNumberFromEndpoint(endpoint, segment) {
  const match = new RegExp(`${segment}/(\\d+)(?:/|$)`, 'u').exec(endpoint)
  return match ? Number(match[1]) : null
}

function mergePullRequest(state, pr, fields, fixture) {
  const requestedSha = fields.get('sha')
  const method = fields.get('merge_method')
  const allowed = {
    merge: state.repository.allowMergeCommit === true,
    squash: state.repository.allowSquashMerge === true,
    rebase: state.repository.allowRebaseMerge === true,
  }
  if (!allowed[method]) return { merged: false, message: `merge method ${method} is disabled` }
  const head = currentHead(pr, fixture)
  if (!head || requestedSha !== head)
    return { merged: false, message: 'head SHA no longer matches' }
  if (pr.state !== 'OPEN') return { merged: false, message: 'pull request is not open' }
  const baseRef = `refs/heads/${pr.base}`
  const base = bareRef(baseRef, fixture)
  const tree = bareGit(['rev-parse', `${head}^{tree}`], fixture)
  const parentArgs = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base]
  const mergeMessage =
    method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number}`
  const mergedOid = bareGit(['commit-tree', tree, ...parentArgs, '-m', mergeMessage], fixture, {
    env: {
      GIT_AUTHOR_NAME: 'GitHub Fixture',
      GIT_AUTHOR_EMAIL: 'github-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'GitHub Fixture',
      GIT_COMMITTER_EMAIL: 'github-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
  bareGit(['update-ref', baseRef, mergedOid, base], fixture)
  pr.state = 'MERGED'
  pr.mergedAt = new Date().toISOString()
  pr.mergeOid = mergedOid
  return { merged: true, sha: mergedOid, message: 'Pull Request successfully merged' }
}

function actor(login) {
  const id = [...login].reduce(
    (hash, character) => (hash * 31 + character.codePointAt(0)) >>> 0,
    5381,
  )
  return { id, login }
}

function commentResponse(state, comment) {
  return { ...comment, user: actor(comment.user?.login || comment.author || state.currentUser) }
}

function handleApi(state, args, fixture) {
  const forms = new Map(Object.entries(jsonValues(args, fixture.input)))
  requireRepository(state, args, forms)
  const endpoint = args.find((arg) => /^repos\//u.test(arg) || arg === 'user')
  const method = valueFor(args, '--method') || 'GET'
  if (endpoint === 'user') return actor(state.currentUser)
  if (!endpoint) fail(`unknown gh api endpoint: ${args.join(' ')}`)
  const repository = `${state.repository.owner}/${state.repository.name}`
  const prefix = `repos/${repository}`
  const [rawEndpoint, rawQuery] = endpoint.split('?')
  const queryParams = new URLSearchParams(rawQuery || '')
  if (rawEndpoint.startsWith(`${prefix}/stacks`)) {
    if (state.stacksPreviewDisabled) {
      fail(`404: Not Found: preview API unavailable for ${endpoint}`)
    }
    if (rawEndpoint === `${prefix}/stacks`) {
      if (method === 'GET') {
        let stacks = state.stacks || []
        if (queryParams.has('pull_request')) {
          const prNum = Number(queryParams.get('pull_request'))
          stacks = stacks.filter((s) => s.pull_requests.some((p) => p.number === prNum))
        }
        const perPage = Number(queryParams.get('per_page')) || 30
        const page = Number(queryParams.get('page')) || 1
        const start = (page - 1) * perPage
        return stacks.slice(start, start + perPage).map((s) => formatStack(state, s, fixture))
      }
      if (method === 'POST') {
        const body = jsonValues(args, fixture.input)
        const pullRequestsInput = body.pull_requests || forms.get('pull_requests')
        if (!Array.isArray(pullRequestsInput) || pullRequestsInput.length === 0) {
          fail('422: pull_requests must be a non-empty array')
        }
        const prs = pullRequestsInput.map((num) => findPr(state, Number(num)))
        const stackNumber = Number.isInteger(state.nextStackNumber) ? state.nextStackNumber++ : 1
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
            state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? 'closed' : 'open',
            draft: pr.draft === true,
            merged_at: pr.mergedAt,
            head: { ref: pr.head, sha: currentHead(pr, fixture) },
          })),
        }
        state.stacks = state.stacks || []
        state.stacks.push(newStack)
        return formatStack(state, newStack, fixture)
      }
    }
    const stackNumber = parseNumberFromEndpoint(rawEndpoint, `${prefix}/stacks`)
    if (stackNumber !== null && rawEndpoint.endsWith(`/stacks/${stackNumber}`)) {
      const stack = (state.stacks || []).find((s) => s.number === stackNumber)
      if (!stack) fail(`404: stack #${stackNumber} not found`)
      if (method === 'GET') return formatStack(state, stack, fixture)
    }
    if (stackNumber !== null && rawEndpoint.endsWith(`/stacks/${stackNumber}/pull_requests`)) {
      const stack = (state.stacks || []).find((s) => s.number === stackNumber)
      if (!stack) fail(`404: stack #${stackNumber} not found`)
      if (method !== 'POST') fail(`unsupported method ${method}`)
      const body = jsonValues(args, fixture.input)
      const pullRequestsInput = body.pull_requests || forms.get('pull_requests')
      const prs = pullRequestsInput.map((num) => findPr(state, Number(num)))
      for (const pr of prs) {
        stack.pull_requests.push({
          number: pr.number,
          state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? 'closed' : 'open',
          draft: pr.draft === true,
          merged_at: pr.mergedAt,
          head: { ref: pr.head, sha: currentHead(pr, fixture) },
        })
      }
      return formatStack(state, stack, fixture)
    }
    if (stackNumber !== null && rawEndpoint.endsWith(`/stacks/${stackNumber}/unstack`)) {
      const stackIdx = (state.stacks || []).findIndex((s) => s.number === stackNumber)
      if (stackIdx === -1) fail(`404: stack #${stackNumber} not found`)
      const stack = state.stacks[stackIdx]
      const remaining = stack.pull_requests.filter(
        (p) => p.merged_at != null || p.state === 'closed',
      )
      if (remaining.length === 0) {
        state.stacks.splice(stackIdx, 1)
        return {}
      } else {
        stack.pull_requests = remaining
        return formatStack(state, stack, fixture)
      }
    }
  }
  if (endpoint === prefix && method === 'GET') {
    return {
      full_name: repository,
      default_branch: state.repository.defaultBranch,
      allow_merge_commit: state.repository.allowMergeCommit === true,
      allow_squash_merge: state.repository.allowSquashMerge === true,
      allow_rebase_merge: state.repository.allowRebaseMerge === true,
    }
  }
  if (endpoint === `${prefix}/pulls` && method === 'POST') {
    const pr = createPullRequest(state, forms, fixture)
    return { ...restPullRequest(state, pr, fixture), html_url: pr.url }
  }
  const prNumber = parseNumberFromEndpoint(endpoint, `${prefix}/pulls`)
  if (prNumber !== null && endpoint.endsWith(`/pulls/${prNumber}`)) {
    const pr = findPr(state, prNumber)
    if (method === 'GET') return restPullRequest(state, pr, fixture)
    if (method !== 'PATCH') fail(`unsupported pull request method ${method}`)
    if (state.prWriteFailure) {
      fail(state.prWriteFailure.message || 'Write failure', state.prWriteFailure.status || 403)
    }
    if (forms.has('draft')) fail('draft cannot be updated through REST')
    if (forms.has('title')) pr.title = forms.get('title')
    if (forms.has('body')) pr.body = forms.get('body')
    if (forms.has('base')) pr.base = forms.get('base')
    if (forms.has('state')) {
      const requested = String(forms.get('state')).toLowerCase()
      if (requested === 'open' && pr.state !== 'MERGED') pr.state = 'OPEN'
      else if (requested === 'closed' && pr.state !== 'MERGED') pr.state = 'CLOSED'
    }
    return restPullRequest(state, pr, fixture)
  }
  const mergeNumber = parseNumberFromEndpoint(endpoint, `${prefix}/pulls`)
  if (mergeNumber !== null && endpoint.endsWith(`/pulls/${mergeNumber}/merge`)) {
    if (method !== 'PUT') fail(`unsupported merge method ${method}`)
    return mergePullRequest(state, findPr(state, mergeNumber), forms, fixture)
  }
  const commentsPath = new RegExp(
    `^${prefix.replace('/', '\\/')}/issues/(\\d+)/comments$`,
    'u',
  ).exec(endpoint)
  if (commentsPath) {
    const number = Number(commentsPath[1])
    if (!state.comments || typeof state.comments !== 'object') state.comments = {}
    const key = String(number)
    if (!Array.isArray(state.comments[key])) state.comments[key] = []
    if (method === 'GET')
      return state.comments[key].map((comment) => commentResponse(state, comment))
    if (method !== 'POST') fail(`unsupported issue comments method ${method}`)
    const id = Number.isInteger(state.nextCommentId)
      ? state.nextCommentId++
      : (state.nextCommentId = 2)
    state.comments[key].push({
      id,
      body: forms.get('body') || '',
      user: actor(state.currentUser),
    })
    return state.comments[key][state.comments[key].length - 1]
  }
  const commentPath = new RegExp(
    `^${prefix.replace('/', '\\/')}/issues/comments/(\\d+)$`,
    'u',
  ).exec(endpoint)
  if (commentPath) {
    if (method !== 'PATCH' && method !== 'GET') fail(`unsupported comment method ${method}`)
    const id = Number(commentPath[1])
    const comments = Object.values(state.comments || {})
    const comment = comments.flat().find((entry) => entry && entry.id === id)
    if (!comment) fail(`unknown issue comment #${id}`)
    if (method === 'PATCH') comment.body = forms.get('body') || ''
    return commentResponse(state, comment)
  }
  if (endpoint.endsWith('/merge')) fail(`unhandled merge endpoint ${endpoint}`)
  fail(`unknown gh api endpoint ${endpoint}`)
}

function handleGraphql(state, args, fixture) {
  const body = jsonValues(args, fixture.input)
  const forms = new Map(Object.entries(body.variables || {}))
  requireRepository(state, args, forms)
  const query = body.query || ''
  const field = query.includes('convertPullRequestToDraft')
    ? 'convertPullRequestToDraft'
    : query.includes('markPullRequestReadyForReview')
      ? 'markPullRequestReadyForReview'
      : null
  if (field) {
    const match = /^PR_(\d+)$/u.exec(String(forms.get('pullRequestId') || ''))
    if (!match) fail('Invalid pull request ID')
    const pr = findPr(state, Number(match[1]))
    if (pr.state !== 'OPEN') fail('Pull request is not open')
    pr.draft = field === 'convertPullRequestToDraft'
    return { data: { [field]: { pullRequest: { id: `PR_${pr.number}`, isDraft: pr.draft } } } }
  }
  if (query.includes('search(query:')) {
    if (state.issuesFailure) {
      fail(state.issuesFailure.message || 'Issues failure', state.issuesFailure.status || 500)
    }
    const rawQuery = String(forms.get('searchQuery') || forms.get('query') || '')
    const terms = rawQuery
      .replace(/repo:[^\s]+/gu, '')
      .replace(/is:issue/gu, '')
      .trim()
      .toLowerCase()
    const issues = state.issues || []
    let matched = issues
    if (terms) {
      matched = issues.filter((iss) => {
        if (String(iss.number) === terms || `#${iss.number}` === terms) return true
        return String(iss.title || '')
          .toLowerCase()
          .includes(terms)
      })
    }
    return {
      data: {
        search: {
          issueCount: matched.length,
          nodes: matched.map((iss) => ({
            __typename: 'Issue',
            number: iss.number,
            title: iss.title,
            url: iss.url,
            state: iss.state || 'OPEN',
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }
  }
  if (query.includes('issue(number:')) {
    if (state.issuesFailure) {
      fail(state.issuesFailure.message || 'Issues failure', state.issuesFailure.status || 500)
    }
    const num = Number(forms.get('number'))
    const iss = (state.issues || []).find((i) => i.number === num)
    return {
      data: {
        repository: {
          issue: iss
            ? { number: iss.number, title: iss.title, url: iss.url, state: iss.state || 'OPEN' }
            : null,
        },
      },
    }
  }
  if (query.includes('issues(first:')) {
    return {
      data: {
        repository: {
          issues: {
            nodes: state.issues || [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }
  }
  if (query.includes('pullRequest(number:')) {
    const pr = findPr(state, Number(forms.get('number')))
    return { data: { repository: { pullRequest: graphPullRequest(pr, true, fixture) } } }
  }
  const open = state.prs.filter((pr) => pr.state === 'OPEN')
  // One PR per page, so a second request carrying a cursor proves pagination advanced.
  const after = forms.get('endCursor')
  const start = after && after !== 'null' ? Number(String(after).replace('cursor:', '')) : 0
  const next = start + 1
  return {
    data: {
      repository: {
        pullRequests: {
          nodes: open.slice(start, start + 1).map((pr) => graphPullRequest(pr, false, fixture)),
          pageInfo: {
            hasNextPage: next < open.length,
            endCursor: next < open.length ? `cursor:${next}` : null,
          },
        },
      },
    },
  }
}

function createPullRequest(state, forms, fixture) {
  const head = forms.get('head') || ''
  const separator = head.indexOf(':')
  const owner = separator >= 0 ? head.slice(0, separator) : state.repository.owner
  const branch = separator >= 0 ? head.slice(separator + 1) : head
  const headOid = bareRef(`refs/heads/${branch}`, fixture)
  if (!headOid) fail(`cannot create PR for missing branch ${branch}`)
  if (state.prs.some((pr) => pr.head === branch && pr.state === 'OPEN'))
    fail(`a pull request for ${branch} already exists`)
  const number = nextNumber(state)
  const pr = {
    number,
    title: forms.get('title') || '',
    body: forms.get('body') || '',
    base: forms.get('base') || '',
    head: branch,
    headRepository: `${owner}/${state.repository.name}`,
    draft: forms.get('draft') === 'true',
    state: 'OPEN',
    checks: 'none',
    reviewDecision: null,
    mergeState: 'CLEAN',
    url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
    headOid,
    mergeOid: null,
    mergedAt: null,
  }
  state.prs.push(pr)
  if (!state.comments) state.comments = {}
  state.comments[String(number)] = []
  return pr
}

/**
 * Answers one `gh` request the way the CLI would and returns what it would have
 * written to stdout. The harness calls this in the test process instead of
 * launching a `gh` executable, because `child_process` cannot run a shebang
 * script or a `.cmd` file on Windows without a shell.
 */
function runGitHubCli({ statePath, barePath, realGit, args, cwd, input }) {
  if (!statePath || !barePath || !realGit) {
    fail('fixture state, bare repository, and real Git are required')
  }
  const fixture = { statePath, barePath, realGit, input }
  const state = loadState(statePath)
  record(state, args, cwd)
  let result
  try {
    if (args.includes('--hostname')) {
      const hostname = valueFor(args, '--hostname')
      if (hostname !== 'github.com') fail(`fixture does not serve hostname ${hostname}`)
    }
    if (args[0] === 'api' && args.includes('graphql')) result = handleGraphql(state, args, fixture)
    else if (args[0] === 'api') result = handleApi(state, args, fixture)
    else if (args[0] === 'auth' && args[1] === 'status')
      result = 'github.com\n  Logged in to github.com as fixture-user\n'
    else if (args[0] === 'auth' && args[1] === 'token') result = 'fixture-token\n'
    else fail(`unknown gh request: ${args.join(' ')}`)
    saveState(state, statePath)
    return response(state, result, args)
  } catch (error) {
    saveState(state, statePath)
    throw error
  }
}

/**
 * The `gh api --include` envelope: the HTTP status line and rate limit headers
 * ahead of the body, which is what the `gh` transport parses before the JSON.
 */
function response(state, result, args) {
  const body = typeof result === 'string' ? result : `${JSON.stringify(result)}\n`
  if (!args.includes('--include')) return body
  const prefix = `repos/${state.repository.owner}/${state.repository.name}/pulls`
  const status = args.includes(prefix) && args.includes('POST') ? 201 : 200
  const headers =
    `HTTP/2 ${status} OK\r\n` +
    'x-ratelimit-limit: 5000\r\n' +
    'x-ratelimit-remaining: 4998\r\n' +
    'x-ratelimit-reset: 1800000000\r\n' +
    'x-ratelimit-resource: core\r\n\r\n'
  return `${headers}${body}`
}

module.exports = { GitHubCliFailure, runGitHubCli }
