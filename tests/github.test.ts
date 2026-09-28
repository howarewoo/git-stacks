import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getGitHubData, getPullRequest } from '../src/main/github'

async function githubFixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-gh-fixture-'))
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'GitHub fixture')
  git('config', 'user.email', 'github-fixture@example.invalid')
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
  await writeFile(join(repo, 'tracked.txt'), 'tracked\n')
  git('add', '.')
  git('commit', '-m', 'Fixture')
  git('config', 'branch.parent.gitStacksPr', '7')
  const gh = join(bin, 'gh')
  await writeFile(
    gh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : {}
const open = [
  { number: 3, title: 'Feature', url: 'https://github.com/acme/widgets/pull/3', headRefName: 'feature', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRepository: { nameWithOwner: 'acme/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
  { number: 4, title: 'Fork feature', url: 'https://github.com/acme/widgets/pull/4', headRefName: 'feature', headRefOid: 'b'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', headRepository: { nameWithOwner: 'evil/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
]
const tracked = { number: 7, title: 'Merged parent', url: 'https://github.com/acme/widgets/pull/7', body: 'body', state: 'MERGED', isDraft: false, headRefName: 'parent', headRefOid: 'c'.repeat(40), headRepository: { nameWithOwner: 'acme/widgets' }, baseRefName: 'main', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergeCommit: { oid: 'd'.repeat(40) }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
if (args.includes('--include')) process.stdout.write('HTTP/2 200 OK\\r\\nx-ratelimit-remaining: 4998\\r\\n\\r\\n')
const single = input.query?.includes('pullRequest(number:') && input.variables?.number === 7
if (args.includes('graphql') && single) {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: tracked } } }))
} else if (args.includes('graphql')) {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequests: { nodes: open, pageInfo: { hasNextPage: false, endCursor: null } } } } }))
} else {
  process.stderr.write('unexpected gh fixture request')
  process.exit(2)
}
`,
    'utf8',
  )
  await chmod(gh, 0o755)
  return { root, repo, bin }
}

test('GitHub fixture keeps fork heads separate and includes tracked closed parents', async () => {
  const { root, repo, bin } = await githubFixture()
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  try {
    const result = await getGitHubData(repo, 'https://github.com/acme/widgets.git')
    assert.equal(result.available, true)
    assert.equal(
      result.pullRequests.some((pr) => pr.number === 7 && pr.state === 'MERGED'),
      true,
    )
    const local = result.pullRequests.findIndex((pr) => pr.number === 3)
    const fork = result.pullRequests.findIndex((pr) => pr.number === 4)
    assert.equal(result.sameRepository(local), true)
    assert.equal(result.sameRepository(fork), false)
    assert.equal(result.pullRequests[local]?.headOid, 'a'.repeat(40))
    assert.equal(result.pullRequests[local]?.reviewDecision, 'APPROVED')
    assert.equal(result.pullRequests[local]?.mergeState, 'CLEAN')
  } finally {
    process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
})

test('canonical exact pull request reads body and head identity', async () => {
  const { root, repo, bin } = await githubFixture()
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  try {
    const pullRequest = await getPullRequest(repo, 7)
    assert.equal(pullRequest.number, 7)
    assert.equal(pullRequest.body, 'body')
    assert.equal(pullRequest.head, 'parent')
    assert.equal(pullRequest.headRepository, 'acme/widgets')
    assert.equal(pullRequest.state, 'MERGED')
  } finally {
    process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
})
