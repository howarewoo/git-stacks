import assert from 'node:assert/strict'
import { chmod, copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import {
  getGitHubData,
  getGitHubIssues,
  getPullRequest,
  getPullRequestIndexPage,
} from '../src/main/github'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'
import { ProgressivePullRequestIndex } from '../src/main/pr-index'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import { configuredHostContext, hostTransport } from '../src/main/github-host'

/**
 * Fake `gh` answering the three GraphQL shapes Git Stacks sends: the paginated
 * open pull request listing, the single tracked pull request lookup, and the
 * open issue listing. Anything else fails loudly so a broken query no longer
 * passes as an empty result.
 */
const fakeGitHubCli = `'use strict'
const { readFileSync, writeSync } = require('node:fs')
const { basename } = require('node:path')
const open = [
  { number: 3, title: 'Feature', url: 'https://github.com/acme/widgets/pull/3', headRefName: 'feature', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', author: { login: 'alice' }, reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'fixture-user' } }], pageInfo: { hasNextPage: false } }, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRepository: { nameWithOwner: 'acme/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
  { number: 4, title: 'Fork feature', url: 'https://github.com/acme/widgets/pull/4', headRefName: 'feature', headRefOid: 'b'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', author: { login: 'unrelated-author' }, reviewRequests: { nodes: [], pageInfo: { hasNextPage: true } }, headRepository: { nameWithOwner: 'evil/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
]
const tracked = { number: 7, title: 'Merged parent', url: 'https://github.com/acme/widgets/pull/7', body: 'body', state: 'MERGED', isDraft: false, headRefName: 'parent', headRefOid: 'c'.repeat(40), headRepository: { nameWithOwner: 'acme/widgets' }, baseRefName: 'main', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergeCommit: { oid: 'd'.repeat(40) }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
const issues = [
  { number: 17, title: 'Improve navigation', url: 'https://github.com/acme/widgets/issues/17' }
]
// The script is the executable on POSIX, where argv still holds every gh argument.
// Windows runs the same script preloaded inside a copy of Node named gh.exe, which
// treats 'api' as its entry script and reports it as a resolved absolute path.
const argv = process.argv.slice(1)
const entry = argv.findIndex((value) => basename(value) === 'api')
const args = entry === -1 ? argv.slice(1) : argv.slice(entry)
const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : {}
let response = null
// The credential this run's CLI holds, the account it names, and the way it
// reports both are the CLI's own protocol: an app that cannot ask the CLI who it
// is has no account to read as, so a fixture that answers only queries would
// fail a run that is otherwise answering them.
const credential = 'fixture-token'
const account = 'fixture-user'
if (args[0] === 'auth' && args[1] === 'token') {
  writeSync(1, credential + '\\n')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (args.includes('--json')) {
    writeSync(1, JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: account, host: 'github.com' }] } }))
  } else {
    writeSync(1, 'github.com\\n  Logged in to github.com as ' + account + '\\n')
  }
  process.exit(0)
}
if (basename(args[0] || '') === 'api' && args.includes('graphql')) {
  const text = String(input.query || '')
  if (text.includes('pullRequest(number:') && input.variables?.number === 7) {
    response = { data: { repository: { pullRequest: tracked } } }
  } else if (text.includes('viewer') && !text.includes('pullRequests(first:')) {
    response = { data: { viewer: { login: account } } }
  } else if (text.includes('issues(first:')) {
    response = { data: { repository: { issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } } } } }
  } else {
    const lightweight = text.includes('pullRequests(first: 50')
    const second = input.variables?.cursor === 'page-two'
    response = { data: { viewer: { login: account }, repository: { pullRequests: { nodes: lightweight ? [open[second ? 1 : 0]] : open, pageInfo: { hasNextPage: lightweight && !second, endCursor: lightweight && !second ? 'page-two' : null } } } } }
  }
}
if (!response) {
  process.stderr.write('unexpected gh fixture request: ' + argv.join(' ') + '\\n')
  process.exit(2)
}
if (args.includes('--include')) {
  writeSync(1, 'HTTP/2 200 OK\\r\\nx-ratelimit-remaining: 4998\\r\\n\\r\\n')
}
writeSync(1, JSON.stringify(response))
process.exit(0)
`

const isWindows = process.platform === 'win32'

/**
 * Put a runnable `gh` on PATH and return the `NODE_OPTIONS` preload it needs.
 * Windows resolves `gh` to `gh.exe` and cannot read a shebang, so the fixture is
 * a copy of the running Node binary that preloads the CommonJS fixture script;
 * elsewhere the script is the executable itself.
 *
 * Node parses the `gh` argv before the preload runs, so a leading-dash request
 * would be consumed by Node's own CLI instead of the fixture. Both `gh` call
 * sites start with `api graphql`, and the fixture rejects every other shape, so
 * a changed request fails the test instead of quietly passing.
 */
async function installFakeGitHubCli(root: string, bin: string): Promise<string | null> {
  const script = join(root, 'gh-fixture.cjs')
  await writeFile(script, fakeGitHubCli, 'utf8')
  if (isWindows) {
    const launcher = join(bin, 'gh.exe')
    try {
      await link(process.execPath, launcher)
    } catch {
      await copyFile(process.execPath, launcher)
    }
    return `--require "${script.replace(/\\/gu, '/')}"`
  }
  const gh = join(bin, 'gh')
  await writeFile(gh, `#!/usr/bin/env node\n${fakeGitHubCli}`, 'utf8')
  await chmod(gh, 0o755)
  // Admitted by name, so the boundary answers for the file the real app would
  // start and refuses the machine's own CLI.
  admitOwnedProviderCliRoot(bin)
  return null
}

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
  const nodeOptions = await installFakeGitHubCli(root, bin)
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  }
  if (nodeOptions) {
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(' ')
  }
  return { root, repo, env }
}

async function withGitHubFixture(run: (repo: string) => Promise<void>): Promise<void> {
  const { root, repo, env } = await githubFixture()
  const original = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS }
  try {
    process.env.PATH = env.PATH
    if (env.NODE_OPTIONS) process.env.NODE_OPTIONS = env.NODE_OPTIONS
    await run(repo)
  } finally {
    if (original.PATH === undefined) delete process.env.PATH
    else process.env.PATH = original.PATH
    if (original.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = original.NODE_OPTIONS
    await rm(root, { recursive: true, force: true })
  }
}

test('GitHub fixture keeps fork heads separate and includes tracked closed parents', async () => {
  await withGitHubFixture(async (repo) => {
    const result = await getGitHubData(repo, 'https://github.com/acme/widgets.git')
    assert.equal(result.available, true)
    assert.equal(
      result.pullRequests.some((pr) => pr.number === 7 && pr.state === 'MERGED'),
      true,
    )
    const local = result.pullRequests.findIndex((pr) => pr.number === 3)
    const fork = result.pullRequests.findIndex((pr) => pr.number === 4)
    assert.notEqual(fork, -1)
    assert.equal(result.sameRepository(local), true)
    assert.equal(result.sameRepository(fork), false)
    assert.equal(result.pullRequests[local]?.headOid, 'a'.repeat(40))
    assert.equal(result.pullRequests[local]?.reviewDecision, 'APPROVED')
    assert.equal(result.pullRequests[local]?.mergeState, 'CLEAN')
  })
})
test('lightweight transport page includes unrelated authors and direct-request completeness', async () => {
  await withGitHubFixture(async (repo) => {
    const index = await getPullRequestIndexPage('https://github.com/acme/widgets.git', null, false)
    assert.equal(index.viewer, 'fixture-user')
    assert.equal(index.next, 'page-two')
    assert.equal(index.pullRequests[0]?.author, 'alice')
    assert.equal(index.pullRequests[0]?.reviewRequestsComplete, true)
    const second = await getPullRequestIndexPage(
      'https://github.com/acme/widgets.git',
      index.next,
      false,
    )
    assert.equal(second.next, null)
    assert.equal(second.pullRequests[0]?.author, 'unrelated-author')
    assert.equal(second.pullRequests[0]?.reviewRequestsComplete, false)
    assert.equal(second.pullRequests[0]?.headRepository, 'evil/widgets')
  })
})
test('production progressive service publishes real host transport pages through the existing scheduler', async () => {
  await withGitHubFixture(async (repo) => {
    const scheduler = new RepositoryScheduler()
    const published: string[] = []
    const finished = Promise.withResolvers<void>()
    const service = new ProgressivePullRequestIndex(
      (origin, cursor, basic, signal) =>
        scheduler.read(
          repo,
          (readSignal) => getPullRequestIndexPage(origin, cursor, basic, readSignal),
          signal,
        ),
      (host) => hostTransport(configuredHostContext(host)).credentialAuthority(),
      (state) => {
        published.push(state.state)
        if (state.complete) finished.resolve()
      },
      () => true,
    )
    const first = await service.load(repo, 'github.com', 'https://github.com/acme/widgets.git')
    assert.equal(first.fullName, 'acme/widgets')
    assert.equal(first.complete, false)
    assert.deepEqual(
      first.pullRequests.map((pr) => pr.number),
      [3],
    )
    await finished.promise
    assert.deepEqual(
      service.current()?.pullRequests.map((pr) => pr.number),
      [3, 4],
    )
    assert.deepEqual(published, ['loading', 'partial', 'complete'])
    const detail = await service.selected(7, () => getPullRequest(repo, 7))
    assert.equal(detail.body, 'body')
    service.invalidate()
    assert.equal(service.current(), null)
  })
})
test('GitHub issue discovery returns open issue identities from the repository', async () => {
  await withGitHubFixture(async (repo) => {
    const result = await getGitHubIssues(repo, 'https://github.com/acme/widgets.git')
    assert.equal(result.message, '')
    assert.deepEqual(result.issues, [
      {
        number: 17,
        title: 'Improve navigation',
        url: 'https://github.com/acme/widgets/issues/17',
      },
    ])
  })
})

test('canonical exact pull request reads body and head identity', async () => {
  await withGitHubFixture(async (repo) => {
    const pullRequest = await getPullRequest(repo, 7)
    assert.equal(pullRequest.number, 7)
    assert.equal(pullRequest.body, 'body')
    assert.equal(pullRequest.head, 'parent')
    assert.equal(pullRequest.headRepository, 'acme/widgets')
    assert.equal(pullRequest.state, 'MERGED')
  })
})
