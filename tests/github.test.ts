import assert from 'node:assert/strict'
import { chmod, copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { getGitHubData, getPullRequest } from '../src/main/github'

/**
 * Fake `gh` answering the two GraphQL shapes Git Stacks sends: the paginated open
 * pull request listing and the single tracked pull request lookup. Anything else
 * fails loudly so a broken query no longer passes as an empty result.
 */
const fakeGitHubCli = `'use strict'
const { writeSync } = require('node:fs')
const { basename } = require('node:path')
const open = [
  { number: 3, title: 'Feature', url: 'https://github.com/acme/widgets/pull/3', headRefName: 'feature', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRepository: { nameWithOwner: 'acme/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
  { number: 4, title: 'Fork feature', url: 'https://github.com/acme/widgets/pull/4', headRefName: 'feature', headRefOid: 'b'.repeat(40), baseRefName: 'main', isDraft: false, state: 'OPEN', headRepository: { nameWithOwner: 'evil/widgets' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
]
const tracked = { number: 7, title: 'Merged parent', url: 'https://github.com/acme/widgets/pull/7', body: 'body', state: 'MERGED', isDraft: false, headRefName: 'parent', headRefOid: 'c'.repeat(40), headRepository: { nameWithOwner: 'acme/widgets' }, baseRefName: 'main', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergeCommit: { oid: 'd'.repeat(40) }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }
// The script is the executable on POSIX, where argv still holds every gh argument.
// Windows runs the same script preloaded inside a copy of Node named gh.exe, which
// treats 'api' as its entry script and reports it as a resolved absolute path.
const argv = process.argv.slice(1)
const entry = argv.findIndex((value) => basename(value) === 'api')
const args = entry === -1 ? argv.slice(1) : argv.slice(entry)
let response = null
if (
  basename(args[0] || '') === 'api' &&
  args[1] === 'graphql' &&
  args.includes('owner=acme') &&
  args.includes('name=widgets')
) {
  if (args.includes('--paginate')) {
    response = [
      {
        data: {
          repository: {
            pullRequests: { nodes: open, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    ]
  } else if (args.includes('number=7')) {
    response = { data: { repository: { pullRequest: tracked } } }
  }
}
if (!response) {
  process.stderr.write('unexpected gh fixture request: ' + argv.join(' ') + '\\n')
  process.exit(2)
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
