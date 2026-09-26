#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const statePath = process.env.GIT_STACKS_FIXTURE_STATE
const barePath = process.env.GIT_STACKS_FIXTURE_BARE
const realGit = process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'
if (!statePath || !barePath) fail('fixture state and bare paths are required')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (error) {
    fail(`cannot read fixture state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function saveState(state) {
  const temporary = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, statePath)
}

function valueFor(args, flag) {
  const index = args.lastIndexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function formValues(args) {
  const result = new Map()
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-f' && args[index] !== '-F') continue
    const value = args[index + 1]
    if (typeof value !== 'string') continue
    const separator = value.indexOf('=')
    if (separator <= 0) continue
    result.set(value.slice(0, separator), value.slice(separator + 1))
    index += 1
  }
  return result
}

function bareGit(args, options = {}) {
  const result = spawnSync(realGit, ['--git-dir', barePath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  })
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(detail || `git ${args.join(' ')} failed`)
  }
  return String(result.stdout || '').trim()
}

function bareRef(ref) {
  try {
    return bareGit(['rev-parse', '--verify', '--end-of-options', ref])
  } catch {
    return null
  }
}

function currentHead(pr) {
  const value = bareRef(`refs/heads/${pr.head}`)
  pr.headOid = value
  return value
}

function checkEntry(pr) {
  if (pr.checks === 'passing') return { state: 'SUCCESS' }
  if (pr.checks === 'failing') return { state: 'FAILURE' }
  if (pr.checks === 'pending') return { state: 'PENDING' }
  return null
}

function graphPullRequest(pr, withBody) {
  const merged = pr.state === 'MERGED'
  const value = {
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
  if (checks) value.commits.nodes.push({ commit: { statusCheckRollup: checks } })
  if (withBody) value.body = pr.body || ''
  return value
}

function restPullRequest(pr) {
  const merged = pr.state === 'MERGED'
  return {
    number: pr.number,
    title: pr.title,
    html_url: pr.url,
    body: pr.body || '',
    state: merged ? 'closed' : pr.state.toLowerCase(),
    merged_at: merged ? pr.mergedAt || '2026-01-01T00:00:00.000Z' : null,
    draft: pr.draft === true,
    head: { ref: pr.head, sha: currentHead(pr), repo: { full_name: pr.headRepository } },
    base: { ref: pr.base },
    mergeable_state: String(pr.mergeState || 'clean').toLowerCase(),
    merge_commit_sha: pr.mergeOid || null,
    reviewDecision: pr.reviewDecision || null,
  }
}

function repositoryName(args) {
  const repoFlag = valueFor(args, '--repo')
  if (repoFlag) return repoFlag.replace(/^github\.com\//u, '').replace(/\.git$/u, '')
  return null
}

function requireRepository(state, args) {
  const forms = formValues(args)
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

function record(state, args) {
  if (!Array.isArray(state.requests)) state.requests = []
  state.requests.push({
    argv: [...args],
    cwd: process.cwd(),
    at: new Date().toISOString(),
  })
}

function parseNumberFromEndpoint(endpoint, segment) {
  const match = new RegExp(`${segment}/(\\d+)(?:/|$)`, 'u').exec(endpoint)
  return match ? Number(match[1]) : null
}

function mergePullRequest(state, pr, fields) {
  const requestedSha = fields.get('sha')
  const method = fields.get('merge_method')
  const allowed = {
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
  const parentArgs = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base]
  const mergeMessage =
    method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number}`
  const mergedOid = bareGit(['commit-tree', tree, ...parentArgs, '-m', mergeMessage], {
    env: {
      GIT_AUTHOR_NAME: 'GitHub Fixture',
      GIT_AUTHOR_EMAIL: 'github-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'GitHub Fixture',
      GIT_COMMITTER_EMAIL: 'github-fixture@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
  bareGit(['update-ref', baseRef, mergedOid, base])
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

function handleApi(state, args) {
  requireRepository(state, args)
  const endpoint = args.find((arg) => /^repos\//u.test(arg) || arg === 'user')
  const method = valueFor(args, '--method') || 'GET'
  const forms = formValues(args)
  if (endpoint === 'user') return actor(state.currentUser)
  if (!endpoint) fail(`unknown gh api endpoint: ${args.join(' ')}`)
  const repository = `${state.repository.owner}/${state.repository.name}`
  const prefix = `repos/${repository}`
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
    const pr = createPullRequest(state, forms)
    return { ...restPullRequest(pr), html_url: pr.url }
  }
  const prNumber = parseNumberFromEndpoint(endpoint, `${prefix}/pulls`)
  if (prNumber !== null && endpoint.endsWith(`/pulls/${prNumber}`)) {
    const pr = findPr(state, prNumber)
    if (method === 'GET') return restPullRequest(pr)
    if (method !== 'PATCH') fail(`unsupported pull request method ${method}`)
    if (forms.has('draft')) fail('draft cannot be updated through REST')
    if (forms.has('title')) pr.title = forms.get('title')
    if (forms.has('body')) pr.body = forms.get('body')
    if (forms.has('base')) pr.base = forms.get('base')
    if (forms.has('state')) {
      const requested = String(forms.get('state')).toLowerCase()
      if (requested === 'open' && pr.state !== 'MERGED') pr.state = 'OPEN'
      else if (requested === 'closed' && pr.state !== 'MERGED') pr.state = 'CLOSED'
    }
    return restPullRequest(pr)
  }
  const mergeNumber = parseNumberFromEndpoint(endpoint, `${prefix}/pulls`)
  if (mergeNumber !== null && endpoint.endsWith(`/pulls/${mergeNumber}/merge`)) {
    if (method !== 'PUT') fail(`unsupported merge method ${method}`)
    return mergePullRequest(state, findPr(state, mergeNumber), forms)
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

function handleGraphql(state, args) {
  const forms = formValues(args)
  requireRepository(state, args)
  const query = forms.get('query') || ''
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
  if (query.includes('pullRequest(number:')) {
    const pr = findPr(state, Number(forms.get('number')))
    return { data: { repository: { pullRequest: graphPullRequest(pr, true) } } }
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
          nodes: open.slice(start, start + 1).map((pr) => graphPullRequest(pr, false)),
          pageInfo: {
            hasNextPage: next < open.length,
            endCursor: next < open.length ? `cursor:${next}` : null,
          },
        },
      },
    },
  }
}

function createPullRequest(state, forms) {
  const head = forms.get('head') || ''
  const separator = head.indexOf(':')
  const owner = separator >= 0 ? head.slice(0, separator) : state.repository.owner
  const branch = separator >= 0 ? head.slice(separator + 1) : head
  const headOid = bareRef(`refs/heads/${branch}`)
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

const args = process.argv.slice(2)
const state = loadState()
record(state, args)
let result
try {
  if (args.includes('--hostname')) {
    const hostname = valueFor(args, '--hostname')
    if (hostname !== 'github.com') fail(`fixture does not serve hostname ${hostname}`)
  }
  if (args[0] === 'api' && args.includes('graphql')) result = handleGraphql(state, args)
  else if (args[0] === 'api') result = handleApi(state, args)
  else fail(`unknown gh request: ${args.join(' ')}`)
  saveState(state)
  if (args.includes('--include')) {
    const status =
      args.includes('repos/' + state.repository.owner + '/' + state.repository.name + '/pulls') &&
      args.includes('POST')
        ? 201
        : 200
    process.stdout.write(
      `HTTP/2 ${status} OK\r\nx-ratelimit-limit: 5000\r\nx-ratelimit-remaining: 4998\r\nx-ratelimit-reset: 1800000000\r\nx-ratelimit-resource: core\r\n\r\n`,
    )
  }
  if (typeof result === 'string') process.stdout.write(result)
  else process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  saveState(state)
  fail(error instanceof Error ? error.message : String(error))
}
