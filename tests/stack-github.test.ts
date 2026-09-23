import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { getSnapshot, runAction } from '../src/main/git'
import { getPullRequest } from '../src/main/github'
import { previewStack, recoverStaleBranchLocks } from '../src/main/stacks'
import {
  createGitHubHarness,
  type GitHubHarness,
  type GitHubFixtureState,
} from './fixtures/github-harness'

const marker = '<!-- git-stacks:stack-links:v1 -->'

function git(harness: GitHubHarness, args: string[]): string {
  return execFileSync(harness.env.GIT_STACKS_REAL_GIT || 'git', ['-C', harness.repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...harness.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return execFileSync(
    harness.env.GIT_STACKS_REAL_GIT || 'git',
    ['--git-dir', harness.bare, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...harness.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

async function withHarness(run: (harness: GitHubHarness) => Promise<void>): Promise<void> {
  const harness = await createGitHubHarness()
  const original = { ...process.env }
  try {
    for (const [key, value] of Object.entries(harness.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await run(harness)
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await harness.close()
  }
}

async function commitFile(
  harness: GitHubHarness,
  filePath: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(`${harness.repo}/${filePath}`, contents, 'utf8')
  git(harness, ['add', '--', filePath])
  git(harness, ['commit', '-m', message])
  return git(harness, ['rev-parse', 'HEAD'])
}

async function createStack(
  harness: GitHubHarness,
): Promise<{ parentTip: string; childTip: string }> {
  await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
  const parentTip = await commitFile(harness, 'parent.txt', 'parent\n', 'Parent work')
  await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
  const childTip = await commitFile(harness, 'child.txt', 'child\n', 'Child work')
  return { parentTip, childTip }
}

function localOid(harness: GitHubHarness, branch: string): string {
  return git(harness, ['rev-parse', `refs/heads/${branch}`])
}

function remoteOid(harness: GitHubHarness, branch: string): string {
  return bareGit(harness, ['rev-parse', `refs/heads/${branch}`])
}

function prFor(state: GitHubFixtureState, branch: string) {
  const pr = state.prs.find((entry) => entry.head === branch)
  assert.ok(pr, `fixture has no PR for ${branch}`)
  return pr
}

function updatePr(
  state: GitHubFixtureState,
  branch: string,
  update: Partial<GitHubFixtureState['prs'][number]>,
) {
  const pr = prFor(state, branch)
  Object.assign(pr, update)
}

async function publishStack(
  harness: GitHubHarness,
  options: { draft?: boolean; allowForce?: boolean; titles?: Record<string, string> } = {},
): Promise<void> {
  const snapshot = await getSnapshot(harness.repo)
  const preview = await previewStack(harness.repo, snapshot, 'publish', 'child')
  assert.deepEqual(preview.blockers, [])
  await runAction(harness.repo, {
    type: 'executeStack',
    token: preview.token,
    allowForce: options.allowForce ?? false,
    draft: options.draft ?? false,
    titles: options.titles ?? { parent: 'Parent title', child: 'Child title' },
    mergeMethod: 'squash',
  })
}

async function makeRemoteDivergence(harness: GitHubHarness, branch: string): Promise<string> {
  const old = remoteOid(harness, branch)
  const tree = bareGit(harness, ['rev-parse', `${old}^{tree}`])
  const next = bareGit(harness, ['commit-tree', tree, '-p', old, '-m', 'Remote drift'])
  bareGit(harness, ['update-ref', `refs/heads/${branch}`, next, old])
  return next
}

async function installGitPublicationHook(
  harness: GitHubHarness,
  options: {
    branch: string
    removeBranchAtPush?: string
    closePrBranch?: string
    appearPrBranch?: string
  },
): Promise<void> {
  const bin = join(harness.root, 'publication-hook-bin')
  await mkdir(bin)
  await writeFile(
    join(bin, 'git'),
    `#!/usr/bin/env node
'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const branch = process.env.GIT_STACKS_TEST_HOOK_BRANCH
const targetSuffix = \`:refs/heads/\${branch}\`
const targetPush = args.includes('push') && args.some((arg) => arg.endsWith(targetSuffix))
if (targetPush && process.env.GIT_STACKS_TEST_HOOK_REMOVE_BRANCH) {
  const update = spawnSync(process.env.GIT_STACKS_REAL_GIT, [
    '-C',
    process.env.GIT_STACKS_TEST_HOOK_REPO,
    'update-ref',
    '-d',
    \`refs/heads/\${branch}\`,
    process.env.GIT_STACKS_TEST_HOOK_REMOVE_BRANCH,
  ], { encoding: 'utf8' })
  if (update.status !== 0) {
    process.stderr.write(String(update.stderr || 'could not delete the test branch ref'))
    process.exit(1)
  }
}
const result = spawnSync(process.env.GIT_STACKS_TEST_HOOK_FIXTURE_GIT, args, {
  stdio: 'inherit',
  env: process.env,
})
if (result.status === 0 && targetPush && process.env.GIT_STACKS_TEST_HOOK_CLOSE_PR) {
  const statePath = process.env.GIT_STACKS_FIXTURE_STATE
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const pr = state.prs.find(
    (candidate) => candidate.head === process.env.GIT_STACKS_TEST_HOOK_CLOSE_PR,
  )
  if (!pr) {
    process.stderr.write('the test could not find the PR to close')
    process.exit(1)
  }
  pr.state = 'CLOSED'
  fs.writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`, 'utf8')
}
if (result.status === 0 && targetPush && process.env.GIT_STACKS_TEST_HOOK_APPEAR_PR) {
  const statePath = process.env.GIT_STACKS_FIXTURE_STATE
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const branch = process.env.GIT_STACKS_TEST_HOOK_APPEAR_PR
  const number = state.nextNumber++
  state.prs.push({
    number,
    title: 'Racing pull request',
    body: '',
    base: state.repository.defaultBranch,
    head: branch,
    headRepository: \`\${state.repository.owner}/\${state.repository.name}\`,
    draft: false,
    state: 'OPEN',
    checks: 'none',
    reviewDecision: null,
    mergeState: 'CLEAN',
    url: \`https://github.com/\${state.repository.owner}/\${state.repository.name}/pull/\${number}\`,
    headOid: null,
    mergeOid: null,
    mergedAt: null,
  })
  fs.writeFileSync(statePath, \`\${JSON.stringify(state, null, 2)}\\n\`, 'utf8')
}
process.exit(typeof result.status === 'number' ? result.status : 1)
`,
    { mode: 0o755 },
  )
  process.env.PATH = `${bin}${delimiter}${process.env.PATH || ''}`
  process.env.GIT_STACKS_TEST_HOOK_BRANCH = options.branch
  process.env.GIT_STACKS_TEST_HOOK_REPO = harness.repo
  process.env.GIT_STACKS_TEST_HOOK_FIXTURE_GIT = join(harness.bin, 'git')
  process.env.GIT_STACKS_TEST_HOOK_CLOSE_PR = options.closePrBranch || ''
  process.env.GIT_STACKS_TEST_HOOK_APPEAR_PR = options.appearPrBranch || ''
  process.env.GIT_STACKS_TEST_HOOK_REMOVE_BRANCH = options.removeBranchAtPush || ''
}

async function pushedGitTransports(harness: GitHubHarness): Promise<string[][]> {
  const log = await readFile(join(harness.root, 'git-transport.jsonl'), 'utf8')
  return log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line)
      if (
        !value ||
        typeof value !== 'object' ||
        !('argv' in value) ||
        !Array.isArray(value.argv) ||
        !value.argv.every((arg) => typeof arg === 'string')
      ) {
        throw new Error('Malformed Git transport fixture record')
      }
      return value.argv
    })
    .filter((args) => args.includes('push'))
}

async function assertPublicationRejectsConcurrentRefDeletion(allowForce: boolean): Promise<void> {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const originalChild = localOid(harness, 'child')
    let capturedTip: string
    if (allowForce) {
      const parent = git(harness, ['rev-parse', `${originalChild}^`])
      const tree = git(harness, ['rev-parse', `${originalChild}^{tree}`])
      capturedTip = git(harness, ['commit-tree', tree, '-p', parent, '-m', 'Rewritten child tip'])
      git(harness, ['update-ref', 'refs/heads/child', capturedTip, originalChild])
    } else {
      capturedTip = await commitFile(harness, 'child-next.txt', 'child next\n', 'Advance child')
    }
    const remoteBefore = remoteOid(harness, 'child')
    const pushesBefore = await pushedGitTransports(harness)
    await installGitPublicationHook(harness, {
      branch: 'child',
      removeBranchAtPush: capturedTip,
    })

    await assert.rejects(publishStack(harness, { allowForce }), /cannot lock ref/iu)

    assert.equal(localOid(harness, 'child'), capturedTip)
    assert.equal(remoteOid(harness, 'child'), remoteBefore)
    assert.equal((await pushedGitTransports(harness)).length, pushesBefore.length)
    process.env.GIT_STACKS_TEST_HOOK_REMOVE_BRANCH = ''
    await publishStack(harness, { allowForce })
    assert.equal(remoteOid(harness, 'child'), capturedTip)
  })
}

test('normal publication refuses branch deletion during push', { concurrency: false }, async () =>
  assertPublicationRejectsConcurrentRefDeletion(false),
)

test(
  'force-with-lease publication refuses branch deletion during push',
  { concurrency: false },
  async () => assertPublicationRejectsConcurrentRefDeletion(true),
)

test(
  'publish refuses a PR created after a no-PR preview during the push',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      const { parentTip } = await createStack(harness)
      await installGitPublicationHook(harness, {
        branch: 'parent',
        appearPrBranch: 'parent',
      })
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.deepEqual(preview.blockers, [])
      assert.equal((await harness.readState()).prs.length, 0)

      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /Pull request for parent changed during publication/u,
      )

      assert.equal(remoteOid(harness, 'parent'), parentTip)
      const state = await harness.readState()
      assert.equal(state.prs.length, 1)
      assert.equal(prFor(state, 'parent').title, 'Racing pull request')
      assert.equal(
        state.requests.filter((request) => request.argv[0] === 'pr' && request.argv[1] === 'create')
          .length,
        0,
      )
    })
  },
)

test(
  'publish rejects a closed tracked PR before updating any stack branch',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const pendingChild = await commitFile(
        harness,
        'child-next.txt',
        'child next\n',
        'Advance child',
      )
      let state = await harness.readState()
      updatePr(state, 'child', { state: 'CLOSED' })
      await harness.writeState(state)

      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.deepEqual(preview.blockers, [])
      const parentRemoteBefore = remoteOid(harness, 'parent')
      const childRemoteBefore = remoteOid(harness, 'child')
      const pushesBefore = await pushedGitTransports(harness)
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /pull request for child changed/u,
      )

      assert.equal(remoteOid(harness, 'parent'), parentRemoteBefore)
      assert.equal(remoteOid(harness, 'child'), childRemoteBefore)
      assert.equal(localOid(harness, 'child'), pendingChild)
      assert.equal((await pushedGitTransports(harness)).length, pushesBefore.length)
      state = await harness.readState()
      assert.equal(state.prs.length, 2)
      assert.equal(
        state.requests.filter((request) => request.argv[0] === 'pr' && request.argv[1] === 'create')
          .length,
        2,
      )
    })
  },
)

test(
  'publish rechecks each tracked PR before pushing later branches',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      git(harness, ['switch', 'parent'])
      const parentTip = await commitFile(
        harness,
        'parent-next.txt',
        'parent next\n',
        'Advance parent',
      )
      git(harness, ['switch', 'child'])
      const restack = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(restack.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: restack.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      const childTip = localOid(harness, 'child')
      assert.equal(git(harness, ['config', '--get', 'branch.child.parentTip']), parentTip)

      const childRemoteBefore = remoteOid(harness, 'child')
      assert.notEqual(git(harness, ['merge-base', childRemoteBefore, childTip]), childRemoteBefore)
      const pushesBefore = await pushedGitTransports(harness)
      await installGitPublicationHook(harness, {
        branch: 'parent',
        closePrBranch: 'child',
      })
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.deepEqual(preview.blockers, [])
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: true,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /Pull request for child changed during publication/u,
      )

      assert.equal(remoteOid(harness, 'parent'), parentTip)
      assert.equal(remoteOid(harness, 'child'), childRemoteBefore)
      assert.equal(localOid(harness, 'child'), childTip)
      const pushesAfter = await pushedGitTransports(harness)
      assert.equal(pushesAfter.length, pushesBefore.length + 1)
      assert.ok(pushesAfter[pushesBefore.length].some((arg) => arg.endsWith(':refs/heads/parent')))
      const state = await harness.readState()
      assert.equal(prFor(state, 'child').state, 'CLOSED')
    })
  },
)

test(
  'GitHub publish creates a real base chain, preserves descriptions, and is idempotent',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const before = {
        parent: localOid(harness, 'parent'),
        child: localOid(harness, 'child'),
      }
      await publishStack(harness, {
        titles: { parent: 'Human parent title', child: 'Human child title' },
      })
      const first = await harness.readState()
      assert.equal(first.prs.length, 2)
      assert.equal(prFor(first, 'parent').base, 'main')
      assert.equal(prFor(first, 'child').base, 'parent')
      assert.equal(prFor(first, 'parent').headOid, remoteOid(harness, 'parent'))
      assert.equal(prFor(first, 'child').headOid, remoteOid(harness, 'child'))
      assert.equal(first.repository.owner, 'acme')
      assert.equal(first.repository.name, 'widgets')
      assert.equal(
        git(harness, ['remote', 'get-url', 'origin']),
        'https://github.com/acme/widgets.git',
      )
      assert.equal(
        git(harness, ['remote', 'get-url', '--push', '--all', 'origin']),
        'https://github.com/acme/widgets.git',
      )

      for (const branch of ['parent', 'child']) {
        const pr = prFor(first, branch)
        const comments = first.comments[String(pr.number)] || []
        assert.equal(comments.filter((comment) => comment.body.includes(marker)).length, 1)
        assert.match(
          comments.find((comment) => comment.body.includes(marker))?.body || '',
          new RegExp(`#${pr.number}`),
        )
      }
      assert.equal(localOid(harness, 'parent'), before.parent)
      assert.equal(localOid(harness, 'child'), before.child)

      const parentPr = prFor(first, 'parent')
      const childPr = prFor(first, 'child')
      const parentComments = first.comments[String(parentPr.number)] || []
      parentPr.body = 'Human parent description that Git Stacks must preserve.'
      childPr.body = 'Human child description that Git Stacks must preserve.'
      parentComments.push({ id: 9001, body: 'A human review note', user: { login: 'reviewer' } })
      await harness.writeState(first)

      const secondBefore = {
        parent: localOid(harness, 'parent'),
        child: localOid(harness, 'child'),
      }
      await publishStack(harness, {
        titles: { parent: 'Ignored replacement', child: 'Ignored replacement' },
      })
      const second = await harness.readState()
      assert.equal(second.prs.length, 2)
      assert.equal(
        prFor(second, 'parent').body,
        'Human parent description that Git Stacks must preserve.',
      )
      assert.equal(
        prFor(second, 'child').body,
        'Human child description that Git Stacks must preserve.',
      )
      assert.equal(
        (second.comments[String(parentPr.number)] || []).some(
          (comment) => comment.body === 'A human review note',
        ),
        true,
      )
      assert.equal(localOid(harness, 'parent'), secondBefore.parent)
      assert.equal(localOid(harness, 'child'), secondBefore.child)
      assert.equal(
        second.requests.filter(
          (request) => request.argv[0] === 'pr' && request.argv[1] === 'create',
        ).length,
        2,
      )
    })
  },
)

test(
  'changed roots require explicit restack, all-branch force consent, and stale remote/base rejection',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const initialParent = localOid(harness, 'parent')
      const initialChild = localOid(harness, 'child')

      git(harness, ['switch', 'main'])
      const changedMain = await commitFile(
        harness,
        'base.txt',
        'base\nroot change\n',
        'Advance main',
      )
      await runAction(harness.repo, { type: 'push' })
      await runAction(harness.repo, { type: 'fetch' })
      assert.equal(remoteOid(harness, 'main'), changedMain)
      git(harness, ['switch', 'child'])

      const publishBeforeRestack = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.match(publishBeforeRestack.blockers.join('\n'), /needs an explicit Restack/u)
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: publishBeforeRestack.token,
          allowForce: true,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /needs an explicit Restack/u,
      )
      assert.equal(localOid(harness, 'parent'), initialParent)
      assert.equal(localOid(harness, 'child'), initialChild)

      const restackPreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(restackPreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: restackPreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      const rebasedParent = localOid(harness, 'parent')
      const rebasedChild = localOid(harness, 'child')
      assert.notEqual(rebasedParent, initialParent)
      assert.notEqual(rebasedChild, initialChild)
      assert.equal(git(harness, ['config', '--get', 'branch.parent.parentTip']), changedMain)

      const forcePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.deepEqual(forcePreview.blockers, [])
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: forcePreview.token,
          allowForce: false,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /requires explicit force-with-lease permission/u,
      )
      assert.equal(remoteOid(harness, 'parent'), initialParent)
      assert.equal(remoteOid(harness, 'child'), initialChild)
      assert.equal(localOid(harness, 'parent'), rebasedParent)
      assert.equal(localOid(harness, 'child'), rebasedChild)

      const staleBasePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      let staleState = await harness.readState()
      updatePr(staleState, 'child', { base: 'main' })
      await harness.writeState(staleState)
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: staleBasePreview.token,
          allowForce: true,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /pull request for child changed/u,
      )
      staleState = await harness.readState()
      updatePr(staleState, 'child', { base: 'parent' })
      await harness.writeState(staleState)

      const stalePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      const staleRemoteChild = await makeRemoteDivergence(harness, 'child')
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: stalePreview.token,
          allowForce: true,
          draft: false,
          titles: { parent: 'Parent title', child: 'Child title' },
          mergeMethod: 'squash',
        }),
        /remote child changed/u,
      )
      assert.equal(remoteOid(harness, 'child'), staleRemoteChild)
      assert.equal(localOid(harness, 'child'), rebasedChild)
    })
  },
)

test(
  'PR title, body, draft, close, and reopen actions use canonical fixture state',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await runAction(harness.repo, { type: 'createBranch', name: 'topic', parent: 'main' })
      await commitFile(harness, 'topic.txt', 'topic\n', 'Topic work')
      await runAction(harness.repo, { type: 'push' })
      const created = await runAction(harness.repo, {
        type: 'createPr',
        title: 'Original title',
        body: 'Original human description',
        base: 'main',
        draft: true,
      })
      assert.match(created.url || '', /\/pull\/1$/u)
      let state = await harness.readState()
      const pr = prFor(state, 'topic')
      assert.equal(pr.title, 'Original title')
      assert.equal(pr.body, 'Original human description')
      assert.equal(pr.draft, true)
      assert.equal(pr.base, 'main')
      assert.equal(pr.headOid, remoteOid(harness, 'topic'))

      await runAction(harness.repo, {
        type: 'updatePr',
        number: pr.number,
        title: 'Updated title',
        body: 'Updated human description',
        draft: false,
      })
      state = await harness.readState()
      assert.equal(prFor(state, 'topic').title, 'Updated title')
      assert.equal(prFor(state, 'topic').body, 'Updated human description')
      assert.equal(prFor(state, 'topic').draft, false)
      assert.equal(
        (await getPullRequest(harness.repo, pr.number)).body,
        'Updated human description',
      )

      await runAction(harness.repo, { type: 'closePr', number: pr.number })
      state = await harness.readState()
      assert.equal(prFor(state, 'topic').state, 'CLOSED')
      await runAction(harness.repo, { type: 'reopenPr', number: pr.number })
      state = await harness.readState()
      assert.equal(prFor(state, 'topic').state, 'OPEN')
      assert.equal(prFor(state, 'topic').body, 'Updated human description')

      await runAction(harness.repo, {
        type: 'updatePr',
        number: pr.number,
        title: 'Updated title',
        body: '',
        draft: false,
      })
      state = await harness.readState()
      assert.equal(prFor(state, 'topic').title, 'Updated title')
      assert.equal(prFor(state, 'topic').body, '')
      assert.equal((await getPullRequest(harness.repo, pr.number)).body, '')
    })
  },
)

test(
  'merge enforces bottom-only, draft/check/review/method gates, and sends the current head SHA',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness, { draft: true })
      let state = await harness.readState()
      const parent = prFor(state, 'parent')
      const child = prFor(state, 'child')

      let preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      assert.match(preview.blockers.join('\n'), /Only the bottom pull request/u)

      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.match(preview.blockers.join('\n'), /still a draft/u)

      updatePr(state, 'parent', { draft: false, checks: 'pending' })
      await harness.writeState(state)
      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.match(preview.blockers.join('\n'), /checks are pending/u)

      state = await harness.readState()
      updatePr(state, 'parent', { checks: 'passing', reviewDecision: 'CHANGES_REQUESTED' })
      await harness.writeState(state)
      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.ok(preview.blockers.length > 0, 'requested changes must prevent merging')

      state = await harness.readState()
      updatePr(state, 'parent', { reviewDecision: 'APPROVED', mergeState: 'BLOCKED' })
      await harness.writeState(state)
      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.ok(preview.blockers.length > 0, 'GitHub branch policy must prevent merging')

      state = await harness.readState()
      updatePr(state, 'parent', { mergeState: 'CLEAN' })
      state.repository.allowSquashMerge = false
      await harness.writeState(state)
      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.equal(preview.mergeMethods.includes('squash'), false)
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: {},
          mergeMethod: 'squash',
        }),
        /not allowed by the repository/u,
      )

      state = await harness.readState()
      state.repository.allowSquashMerge = true
      await harness.writeState(state)
      const headBeforeMerge = parent.headOid
      preview = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'parent')
      assert.deepEqual(preview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedParent = prFor(state, 'parent')
      assert.equal(mergedParent.state, 'MERGED')
      assert.ok(mergedParent.mergeOid)
      assert.equal(mergedParent.mergeOid, remoteOid(harness, 'main'))
      assert.notEqual(mergedParent.mergeOid, headBeforeMerge)
      assert.equal(prFor(state, 'child').state, 'OPEN')
      assert.equal(
        state.requests.some(
          (request) =>
            request.argv.includes('repos/acme/widgets/pulls/1/merge') &&
            request.argv.includes(`sha=${headBeforeMerge}`) &&
            request.argv.includes('merge_method=squash'),
        ),
        true,
      )
      assert.equal(bareGit(harness, ['cat-file', '-t', mergedParent.mergeOid]), 'commit')
    })
  },
)

test(
  'merged-root restack uses fetched remote main, preserves merged content, and retargets child PR',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      let state = await harness.readState()
      updatePr(state, 'parent', {
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
      })
      const childPr = prFor(state, 'child')
      childPr.body = 'Human child description before parent merge'
      await harness.writeState(state)

      const localMainBefore = localOid(harness, 'main')
      const parentBranchBefore = localOid(harness, 'parent')
      const parentHeadBefore = prFor(state, 'parent').headOid
      const mergePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'parent',
      )
      assert.deepEqual(mergePreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: mergePreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })

      state = await harness.readState()
      const mergedParent = prFor(state, 'parent')
      assert.equal(mergedParent.state, 'MERGED')
      assert.ok(mergedParent.mergeOid)
      assert.equal(localOid(harness, 'main'), localMainBefore)
      assert.equal(localOid(harness, 'parent'), parentBranchBefore)
      assert.equal(remoteOid(harness, 'main'), mergedParent.mergeOid)
      assert.equal(mergedParent.headOid, parentHeadBefore)

      const restackPreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(restackPreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: restackPreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      assert.equal(git(harness, ['config', '--get', 'branch.child.parent']), 'main')
      assert.equal(
        git(harness, ['config', '--get', 'branch.child.parentTip']),
        mergedParent.mergeOid,
      )
      assert.equal(git(harness, ['show', 'child:parent.txt']), 'parent')
      assert.equal(git(harness, ['show', 'child:child.txt']), 'child')
      assert.equal(localOid(harness, 'main'), localMainBefore)
      assert.equal(localOid(harness, 'parent'), parentBranchBefore)
      const remainingChild = (await getSnapshot(harness.repo)).branches.find(
        (branch) => branch.name === 'child' && !branch.remote,
      )
      assert.equal(remainingChild?.needsRestack, false)

      const mergedRootPreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'parent',
      )
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: mergedRootPreview.token,
          allowForce: true,
          draft: false,
          titles: {},
          mergeMethod: 'squash',
        }),
      )

      const publishPreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      assert.deepEqual(publishPreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: publishPreview.token,
        allowForce: true,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      assert.equal(prFor(state, 'child').base, 'main')
      assert.equal(prFor(state, 'child').body, 'Human child description before parent merge')
      assert.equal(prFor(state, 'child').headOid, remoteOid(harness, 'child'))
      assert.equal(prFor(state, 'parent').state, 'MERGED')
    })
  },
)

test(
  'restack preserves unpublished commits after a merged parent',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      let state = await harness.readState()
      updatePr(state, 'parent', {
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
      })
      await harness.writeState(state)

      const mergePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'parent',
      )
      assert.deepEqual(mergePreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: mergePreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedParent = prFor(state, 'parent')
      const mergedParentHead = mergedParent.headOid
      const mergedParentMergeOid = mergedParent.mergeOid
      assert.equal(mergedParent.state, 'MERGED')
      assert.ok(mergedParentHead)
      assert.ok(mergedParentMergeOid)

      git(harness, ['switch', 'parent'])
      const laterParentTip = await commitFile(
        harness,
        'parent-after-merge.txt',
        'parent two\n',
        'Later parent work',
      )
      git(harness, ['switch', 'child'])
      git(harness, ['rebase', '--onto', 'parent', mergedParentHead, 'child'])
      git(harness, ['config', '--local', 'branch.child.parentTip', laterParentTip])
      const childTip = localOid(harness, 'child')
      assert.equal(git(harness, ['show', 'child:parent-after-merge.txt']), 'parent two')

      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(preview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      assert.notEqual(localOid(harness, 'child'), childTip)
      assert.equal(git(harness, ['show', 'child:parent-after-merge.txt']), 'parent two')
      assert.equal(git(harness, ['show', 'child:child.txt']), 'child')
      assert.equal(localOid(harness, 'parent'), laterParentTip)
      assert.equal(
        git(harness, ['config', '--get', 'branch.child.parentTip']),
        mergedParentMergeOid,
      )
      assert.equal(remoteOid(harness, 'main'), mergedParentMergeOid)
    })
  },
)
test(
  'restack preserves commits added to a merged PR source after its merge',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      let state = await harness.readState()
      updatePr(state, 'parent', {
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
      })
      await harness.writeState(state)

      const mergePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'parent',
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: mergePreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedHead = prFor(state, 'parent').headOid
      assert.ok(mergedHead)
      assert.equal(
        git(harness, ['config', '--get', 'branch.parent.gitStacksMergedHeadOid']),
        mergedHead,
      )
      assert.ok(prFor(state, 'parent').mergeOid)
      assert.equal(
        git(harness, ['config', '--get', 'branch.parent.gitStacksMergedCommitOid']),
        prFor(state, 'parent').mergeOid,
      )

      git(harness, ['switch', 'parent'])
      const laterParentTip = await commitFile(
        harness,
        'later-parent.txt',
        'later parent work\n',
        'Advance merged source branch',
      )
      await runAction(harness.repo, { type: 'push' })
      await getSnapshot(harness.repo)
      state = await harness.readState()
      assert.equal(prFor(state, 'parent').headOid, laterParentTip)

      git(harness, ['rebase', '--onto', 'parent', mergedHead, 'child'])
      git(harness, ['switch', 'child'])
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(preview.blockers, [])
      const childBeforeStalePreview = localOid(harness, 'child')
      git(harness, ['config', '--local', 'branch.parent.gitStacksMergedHeadOid', laterParentTip])
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: {},
          mergeMethod: 'squash',
        }),
        /merged pull request boundary for parent changed/u,
      )
      assert.equal(localOid(harness, 'child'), childBeforeStalePreview)
      git(harness, ['config', '--local', 'branch.parent.gitStacksMergedHeadOid', mergedHead])
      const freshPreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(freshPreview.blockers, [])
      await runAction(harness.repo, {
        type: 'executeStack',
        token: freshPreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })

      assert.equal(git(harness, ['show', 'child:later-parent.txt']), 'later parent work')
      assert.equal(git(harness, ['show', 'child:child.txt']), 'child')
    })
  },
)

test(
  'foreign and ambiguous managed-link comments are never overwritten',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      let state = await harness.readState()
      const parent = prFor(state, 'parent')
      const managed = (state.comments[String(parent.number)] || []).find((comment) =>
        comment.body.includes(marker),
      )
      assert.ok(managed)
      const foreign = {
        id: 9901,
        body: `${marker}\nHuman-authored navigation that must remain untouched`,
        user: { login: 'human-reviewer' },
      }
      state.comments[String(parent.number)] = [
        foreign,
        ...(state.comments[String(parent.number)] || []),
      ]
      await harness.writeState(state)

      await publishStack(harness)
      state = await harness.readState()
      assert.equal(
        state.comments[String(parent.number)]?.find((comment) => comment.id === foreign.id)?.body,
        foreign.body,
      )
      assert.equal(
        (state.comments[String(parent.number)] || []).filter((comment) =>
          comment.body.includes(marker),
        ).length,
        2,
      )

      const managedComments =
        state.comments[String(parent.number)]?.filter((comment) => comment.body.includes(marker)) ||
        []
      assert.equal(managedComments.length, 2)
      const duplicate = { ...managedComments[1], id: 9902 }
      state.comments[String(parent.number)] = [
        ...(state.comments[String(parent.number)] || []),
        duplicate,
      ]
      const beforeBodies = state.comments[String(parent.number)]?.map((comment) => [
        comment.id,
        comment.body,
      ])
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'publish',
        'child',
      )
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          draft: false,
          titles: {},
          mergeMethod: 'squash',
        }),
      )
      const after = await harness.readState()
      assert.deepEqual(
        after.comments[String(parent.number)]?.map((comment) => [comment.id, comment.body]),
        beforeBodies,
      )
    })
  },
)
test(
  'restack reconstructs merge-time head from journal and rejects unproven metadata pointing at child tip',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      let state = await harness.readState()
      updatePr(state, 'parent', {
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
      })
      await harness.writeState(state)

      const mergePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'parent',
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: mergePreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedHead = prFor(state, 'parent').headOid
      assert.ok(mergedHead)

      const journalPath = join(harness.repo, '.git', 'git-stacks-merged-heads.json')
      const journalContent = JSON.parse(await readFile(journalPath, 'utf8'))
      assert.equal(journalContent.parent.headOid, mergedHead)
      assert.equal(journalContent[String(prFor(state, 'parent').number)].headOid, mergedHead)

      git(harness, ['config', '--local', '--unset', 'branch.parent.gitStacksMergedHeadOid'])
      git(harness, ['config', '--local', '--unset', 'branch.parent.gitStacksMergedCommitOid'])

      git(harness, ['switch', 'child'])
      const previewAfterConfigCleared = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(previewAfterConfigCleared.blockers, [])

      const childOid = git(harness, ['rev-parse', 'refs/heads/child'])
      git(harness, ['config', '--local', 'branch.parent.gitStacksMergedHeadOid', childOid])
      const previewUnprovenChildTip = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.ok(
        previewUnprovenChildTip.blockers.some((b) =>
          b.includes(
            'has no validated merge-time head for child that can be used as a safe replay boundary',
          ),
        ),
      )
    })
  },
)

test(
  'branch publication recovers orphaned branch ref locks left by dead processes',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
      const deadPid = 99999999
      const lockData = {
        pid: deadPid,
        branch: 'child',
        lockPath,
        createdAt: Date.now() - 10000,
        transactionId: 'dead-lock-uuid',
      }
      await writeFile(lockPath, JSON.stringify(lockData), 'utf8')

      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })
      await writeFile(join(locksDir, 'dead-lock-uuid.json'), JSON.stringify(lockData), 'utf8')

      await publishStack(harness)
      const state = await harness.readState()
      assert.ok(prFor(state, 'child'))

      await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
      await assert.rejects(readFile(join(locksDir, 'dead-lock-uuid.json')), { code: 'ENOENT' })
    })
  },
)

test(
  'branch lock recovery accepts an exact custom files ref-storage lock path',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const customRoot = join(harness.root, 'custom refs')
      const customHeadsDir = join(customRoot, 'refs', 'heads')
      const customLockPath = join(customHeadsDir, 'child.lock')
      const refStorage = `files://${encodeURI(customRoot)}`
      const shimDir = join(harness.root, 'ref-storage-shim')
      const transactionId = 'deadbeef-dead-beef-dead-beefdeadbeef'
      const lockData = {
        pid: 99999999,
        branch: 'child',
        lockPath: customLockPath,
        createdAt: Date.now() - 30000,
        transactionId,
      }
      await mkdir(customHeadsDir, { recursive: true })
      await mkdir(shimDir)
      await writeFile(
        join(shimDir, 'git'),
        `#!/bin/sh
repo=''
if [ "$1" = "-C" ]; then
  repo=$2
  shift 2
fi
if [ "$1" = "config" ] && [ "$2" = "--get" ] && [ "$3" = "extensions.refstorage" ]; then
  printf '%s\\n' "$GIT_STACKS_TEST_REF_STORAGE"
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ]; then
  case "$3" in
    refs/heads/*)
      printf '%s\\n' "$3"
      exit 0
      ;;
  esac
fi
if [ -n "$repo" ]; then
  exec "$GIT_STACKS_TEST_DELEGATE_GIT" -C "$repo" "$@"
fi
exec "$GIT_STACKS_TEST_DELEGATE_GIT" "$@"
`,
        { mode: 0o755 },
      )
      await writeFile(customLockPath, JSON.stringify(lockData), 'utf8')
      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })
      const journalPath = join(locksDir, `${transactionId}.json`)
      await writeFile(journalPath, JSON.stringify(lockData), 'utf8')

      process.env.PATH = `${shimDir}:${process.env.PATH || ''}`
      process.env.GIT_STACKS_TEST_REF_STORAGE = refStorage
      process.env.GIT_STACKS_TEST_DELEGATE_GIT = join(harness.bin, 'git')

      await recoverStaleBranchLocks(harness.repo)
      await assert.rejects(readFile(customLockPath), { code: 'ENOENT' })
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' })

      await publishStack(harness)
      assert.ok(prFor(await harness.readState(), 'child'))
    })
  },
)

test(
  'stale branch lock cleanup preserves live locks and removes dead journals',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
      const liveLockData = {
        pid: process.pid,
        branch: 'child',
        lockPath,
        createdAt: Date.now(),
        transactionId: 'live-lock-uuid',
      }
      await writeFile(lockPath, JSON.stringify(liveLockData), 'utf8')

      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })
      const deadJournalPath = join(locksDir, 'dead-lock-uuid.json')
      const deadLockData = {
        pid: 99999999,
        branch: 'child',
        lockPath,
        createdAt: Date.now() - 20000,
        transactionId: 'dead-lock-uuid',
      }
      await writeFile(deadJournalPath, JSON.stringify(deadLockData), 'utf8')

      await recoverStaleBranchLocks(harness.repo)

      const liveContent = JSON.parse(await readFile(lockPath, 'utf8'))
      assert.equal(liveContent.transactionId, 'live-lock-uuid')
      await assert.rejects(readFile(deadJournalPath), { code: 'ENOENT' })
    })
  },
)

test(
  'stale branch lock cleanup preserves a replacement created during identity validation',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })

      const transactionId = 'deadbeef-dead-beef-dead-beefdeadbeef'
      const deadLockData = {
        pid: 99999999,
        branch: 'child',
        lockPath,
        createdAt: Date.now() - 30000,
        transactionId,
      }
      await writeFile(lockPath, JSON.stringify(deadLockData), 'utf8')
      await writeFile(join(locksDir, `${transactionId}.json`), JSON.stringify(deadLockData), 'utf8')

      const originalLstat = fs.promises.lstat
      let replacementCreated = false
      Object.defineProperty(fs.promises, 'lstat', {
        configurable: true,
        value: async (candidate: fs.PathLike) => {
          const stat = await originalLstat(candidate)
          if (!replacementCreated && candidate === lockPath) {
            replacementCreated = true
            await unlink(lockPath)
            await writeFile(
              lockPath,
              JSON.stringify({
                pid: process.pid,
                branch: 'child',
                lockPath,
                createdAt: Date.now(),
                transactionId: 'live-replacement-uuid',
              }),
              'utf8',
            )
          }
          return stat
        },
        writable: true,
      })

      try {
        await recoverStaleBranchLocks(harness.repo)
      } finally {
        Object.defineProperty(fs.promises, 'lstat', {
          configurable: true,
          value: originalLstat,
          writable: true,
        })
      }

      const remainingLock = JSON.parse(await readFile(lockPath, 'utf8'))
      assert.equal(remainingLock.transactionId, 'live-replacement-uuid')
      assert.equal(remainingLock.pid, process.pid)
      assert.equal(replacementCreated, true)
      const preservedJournal = JSON.parse(
        await readFile(join(locksDir, `${transactionId}.json`), 'utf8'),
      )
      assert.equal(preservedJournal.transactionId, transactionId)
    })
  },
)

test(
  'branch lock recovery rejects journals without a branch before touching the candidate lock',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      const victimLock = join(harness.repo, '.git', 'refs', 'heads', 'victim.lock')
      await mkdir(locksDir, { recursive: true })
      await mkdir(join(harness.repo, '.git', 'refs', 'heads'), { recursive: true })
      await writeFile(victimLock, 'unrelated lock\n', 'utf8')

      const transactionId = 'deadbeef-dead-beef-dead-beefdeadbeef'
      const journalPath = join(locksDir, `${transactionId}.json`)
      await writeFile(
        journalPath,
        JSON.stringify({
          pid: 99999999,
          lockPath: victimLock,
          createdAt: Date.now() - 30000,
          transactionId,
        }),
        'utf8',
      )

      await recoverStaleBranchLocks(harness.repo)

      assert.equal(await readFile(victimLock, 'utf8'), 'unrelated lock\n')
      await assert.rejects(readFile(journalPath), { code: 'ENOENT' })
    })
  },
)

test(
  'branch lock recovery rejects path traversal in journal lockPath and transactionId',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })

      // Create victim files that must NOT be touched
      const victimFile = join(harness.repo, 'victim.txt')
      await writeFile(victimFile, 'do not delete me\n', 'utf8')

      const victimLock = join(harness.repo, 'victim.lock')
      await writeFile(victimLock, 'victim lock\n', 'utf8')

      // Create a malicious journal with traversal in lockPath
      const maliciousJournal1 = join(locksDir, 'malicious-lockpath.json')
      await writeFile(
        maliciousJournal1,
        JSON.stringify({
          pid: 99999999,
          branch: 'child',
          lockPath: victimLock,
          createdAt: Date.now() - 30000,
          transactionId: 'valid-tx-uuid-1',
        }),
        'utf8',
      )

      // Create a malicious journal with traversal in transactionId
      const maliciousJournal2 = join(locksDir, 'malicious-txid.json')
      await writeFile(
        maliciousJournal2,
        JSON.stringify({
          pid: 99999999,
          branch: 'child',
          lockPath: join(harness.repo, '.git', 'refs', 'heads', 'child.lock'),
          createdAt: Date.now() - 30000,
          transactionId: '../../victim.txt',
        }),
        'utf8',
      )

      await recoverStaleBranchLocks(harness.repo)

      // Victim files must still exist untouched
      assert.equal(await readFile(victimFile, 'utf8'), 'do not delete me\n')
      assert.equal(await readFile(victimLock, 'utf8'), 'victim lock\n')
    })
  },
)

test(
  'branch lock recovery preserves malformed partial locks and blocks publication',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await createStack(harness)
      const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
      const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
      await mkdir(locksDir, { recursive: true })

      const deadTxId = 'dead-partial-lock-uuid'
      const deadJournalPath = join(locksDir, `${deadTxId}.json`)
      const deadJournalData = {
        pid: 99999999,
        branch: 'child',
        lockPath,
        createdAt: Date.now() - 30000,
        transactionId: deadTxId,
      }
      await writeFile(deadJournalPath, JSON.stringify(deadJournalData), 'utf8')
      await writeFile(lockPath, '', 'utf8')

      await recoverStaleBranchLocks(harness.repo)

      assert.equal(await readFile(lockPath, 'utf8'), '')
      assert.deepEqual(JSON.parse(await readFile(deadJournalPath, 'utf8')), deadJournalData)
      await assert.rejects(publishStack(harness), /being updated/u)
    })
  },
)

test(
  'restack rejects stale ancestor candidate when journal records the true merge head',
  { concurrency: false },
  async () => {
    await withHarness(async (harness) => {
      await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
      const parentFirstCommit = await commitFile(harness, 'parent1.txt', '1\n', 'Parent one')
      const parentTip = await commitFile(harness, 'parent2.txt', '2\n', 'Parent two')
      await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
      await commitFile(harness, 'child.txt', 'child\n', 'Child work')

      await publishStack(harness)
      let state = await harness.readState()
      updatePr(state, 'parent', {
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
      })
      await harness.writeState(state)

      const mergePreview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'parent',
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: mergePreview.token,
        allowForce: false,
        draft: false,
        titles: {},
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedHead = prFor(state, 'parent').headOid
      assert.equal(mergedHead, parentTip)

      // Stale config points at parentFirstCommit (an ancestor of mergedHead)
      git(harness, ['switch', 'child'])
      git(harness, ['config', '--local', 'branch.parent.gitStacksMergedHeadOid', parentFirstCommit])

      // 1. Stale ancestor candidate in config is rejected by isProvenMergeHead against durable journal
      const previewStaleConfig = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.ok(
        previewStaleConfig.blockers.some((b) =>
          b.includes(
            'has no validated merge-time head for child that can be used as a safe replay boundary',
          ),
        ),
      )

      // 2. Unsetting stale config allows restack to pick up journal's true merge head and succeed
      git(harness, ['config', '--local', '--unset', 'branch.parent.gitStacksMergedHeadOid'])
      const previewWithJournal = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.deepEqual(previewWithJournal.blockers, [])

      // 3. If journal is removed, stale ancestor candidate in config is also rejected by graph fallback
      git(harness, ['config', '--local', 'branch.parent.gitStacksMergedHeadOid', parentFirstCommit])
      const journalPath = join(harness.repo, '.git', 'git-stacks-merged-heads.json')
      await writeFile(journalPath, '{}', 'utf8')
      const previewWithoutJournal = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'restack',
        'child',
      )
      assert.ok(
        previewWithoutJournal.blockers.some((b) =>
          b.includes(
            'has no validated merge-time head for child that can be used as a safe replay boundary',
          ),
        ),
      )
    })
  },
)
