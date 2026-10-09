import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness, GitPushHook } from './fixtures/github-harness'
import type { GitHubTransport } from '../src/main/github-transport'
import { CommandCancelled } from '../src/main/git-core'

// Git Stacks captures Node's spawn API when its own modules load, and the GitHub
// harness answers `git` and `gh` on that API, so Git Stacks is loaded here.
// Nothing may reach `node:child_process` through an ESM import before the harness
// module body runs: the builtin facade keeps the export it first sees, so a
// static import above would hand Git Stacks the unpatched `execFile`.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getGitHubData, getPullRequest } = await import('../src/main/github')
const { getMergeStatus, previewStack, recoverStaleBranchLocks } = await import('../src/main/stacks')
const {
  clearGitHubRetryDeadline,
  DirectGitHubTransport,
  GhGitHubTransport,
  GitHubTransportError,
  githubRetryDeadlineFor,
  lastGitHubRateLimitFor,
  resetGitHubRateLimit,
  setGitHubObservationClock,
  setGitHubTransport,
} = await import('../src/main/github-transport')
const { retireConfirmedGitHubPayloads } = await import('../src/main/git')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['--git-dir', harness.bare, ...args])
}

/** Runs `body` against a harness whose GitHub transport is the one the caller recorded with. */
async function withHarnessTransport(
  harness: GitHubHarness,
  transport: GitHubTransport,
  body: () => Promise<void>,
): Promise<void> {
  setGitHubTransport(transport)
  try {
    await body()
  } finally {
    setGitHubTransport(
      new DirectGitHubTransport({ token: 'fixture-token', fetch: createGitHubApiDouble() }),
    )
  }
}

async function withHarness(
  run: (harness: GitHubHarness) => Promise<void>,
  options: { transport?: GitHubTransport } = {},
): Promise<void> {
  const harness = await createGitHubHarness()
  const original = { ...process.env }
  setGitHubTransport(
    options.transport ??
      new DirectGitHubTransport({ token: 'fixture-token', fetch: createGitHubApiDouble() }),
  )
  try {
    for (const [key, value] of Object.entries(harness.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await run(harness)
  } finally {
    setGitHubTransport(null)
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
  await writeFile(join(harness.repo, filePath), contents, 'utf8')
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
    type: 'submitStack',
    token: preview.token,
    allowForce: options.allowForce ?? false,
    layers: Object.fromEntries(
      Object.entries(options.titles ?? { parent: 'Parent title', child: 'Child title' }).map(
        ([branch, title]) => [
          branch,
          { title, body: '', draft: options.draft ?? false, updateBase: true },
        ],
      ),
    ),
  })
}

async function makeRemoteDivergence(harness: GitHubHarness, branch: string): Promise<string> {
  const old = remoteOid(harness, branch)
  const tree = bareGit(harness, ['rev-parse', `${old}^{tree}`])
  const next = bareGit(harness, ['commit-tree', tree, '-p', old, '-m', 'Remote drift'])
  bareGit(harness, ['update-ref', `refs/heads/${branch}`, next, old])
  return next
}

/**
 * Mutates the fixture at the moment Git Stacks publishes `branch`. The harness
 * answers every Git command Git Stacks starts, so a race belongs on that
 * boundary instead of on `PATH`: `before` runs once the push is claimed and
 * before real Git sees it, and `after` runs only once that push succeeded, which
 * is the window Git Stacks has to notice a concurrently deleted branch, a
 * closed pull request, or a pull request that appeared mid-publication.
 *
 * The shared race shim injects once, before a command runs, so it cannot express
 * a pull request that closes or appears only after its push succeeded; that is
 * the outcome these tests pin down.
 */
function installGitPublicationHook(
  harness: GitHubHarness,
  options: {
    branch: string
    removeBranchAtPush?: string
    closePrBranch?: string
    appearPrBranch?: string
  },
): GitPushHook {
  const readState = (): GitHubFixtureState =>
    JSON.parse(fs.readFileSync(harness.statePath, 'utf8')) as GitHubFixtureState
  const writeState = (state: GitHubFixtureState): void => {
    fs.writeFileSync(harness.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
  const removeBranch = options.removeBranchAtPush
  const closePrBranch = options.closePrBranch
  const appearPrBranch = options.appearPrBranch
  const hook: GitPushHook = {
    branch: options.branch,
    armed: true,
    ...(removeBranch
      ? {
          before() {
            git(harness, ['update-ref', '-d', `refs/heads/${options.branch}`, removeBranch])
          },
        }
      : {}),
    ...(closePrBranch || appearPrBranch
      ? {
          after() {
            const state = readState()
            if (closePrBranch) {
              const pr = state.prs.find((candidate) => candidate.head === closePrBranch)
              if (!pr) throw new Error('the test could not find the PR to close')
              pr.state = 'CLOSED'
            }
            if (appearPrBranch) {
              const number = state.nextNumber++
              state.prs.push({
                number,
                title: 'Racing pull request',
                body: '',
                base: state.repository.defaultBranch,
                head: appearPrBranch,
                headRepository: `${state.repository.owner}/${state.repository.name}`,
                draft: false,
                state: 'OPEN',
                checks: 'none',
                reviewDecision: null,
                mergeState: 'CLEAN',
                url: `https://github.com/${state.repository.owner}/${state.repository.name}/pull/${number}`,
                headOid: null,
                mergeOid: null,
                mergedAt: null,
              })
            }
            writeState(state)
          },
        }
      : {}),
  }
  harness.hookGitPush(hook)
  return hook
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
    const hook = installGitPublicationHook(harness, {
      branch: 'child',
      removeBranchAtPush: capturedTip,
    })

    await assert.rejects(publishStack(harness, { allowForce }), /cannot lock ref/iu)

    assert.equal(localOid(harness, 'child'), capturedTip)
    assert.equal(remoteOid(harness, 'child'), remoteBefore)
    assert.equal((await pushedGitTransports(harness)).length, pushesBefore.length)
    // The refused submission stays on record until it is dismissed, so the retry that
    // succeeds is the explicit next action a person takes. Dismissing also clears the recorded
    // operation, which a fresh publish would otherwise refuse to start alongside.
    await runAction(harness.repo, { type: 'submitStackDismiss' })
    // The deletion race only applies to the refused attempt; the retry must push normally.
    hook.armed = false
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

test('publish refuses a PR created after a no-PR preview during the push', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    const { parentTip } = await createStack(harness)
    installGitPublicationHook(harness, {
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
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
      }),
      /Pull request for parent changed during publication/u,
    )

    assert.equal(remoteOid(harness, 'parent'), parentTip)
    const state = await harness.readState()
    assert.equal(state.prs.length, 1)
    assert.equal(prFor(state, 'parent').title, 'Racing pull request')
    assert.equal(
      state.requests.filter(
        (request) => request.argv[0] === 'repos/acme/widgets/pulls' && request.argv[1] === 'POST',
      ).length,
      0,
    )
  })
})

test('publish rejects a closed tracked PR before updating any stack branch', {
  concurrency: false,
}, async () => {
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
        type: 'submitStack',
        token: preview.token,
        allowForce: false,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
      }),
    )

    assert.equal(remoteOid(harness, 'parent'), parentRemoteBefore)
    assert.equal(remoteOid(harness, 'child'), childRemoteBefore)
    assert.equal(localOid(harness, 'child'), pendingChild)
    assert.equal((await pushedGitTransports(harness)).length, pushesBefore.length)
    state = await harness.readState()
    assert.equal(state.prs.length, 2)
    assert.equal(
      state.requests.filter(
        (request) => request.argv[0] === 'repos/acme/widgets/pulls' && request.argv[1] === 'POST',
      ).length,
      2,
    )
  })
})

test('publish rechecks each tracked PR before pushing later branches', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
    })
    const childTip = localOid(harness, 'child')
    assert.equal(git(harness, ['config', '--get', 'branch.child.parentTip']), parentTip)

    const childRemoteBefore = remoteOid(harness, 'child')
    assert.notEqual(git(harness, ['merge-base', childRemoteBefore, childTip]), childRemoteBefore)
    const pushesBefore = await pushedGitTransports(harness)
    installGitPublicationHook(harness, {
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
        type: 'submitStack',
        token: preview.token,
        allowForce: true,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
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
})

test('GitHub publish creates a real base chain, preserves descriptions, and is idempotent', {
  concurrency: false,
}, async () => {
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
        (request) => request.argv[0] === 'repos/acme/widgets/pulls' && request.argv[1] === 'POST',
      ).length,
      2,
    )
  })
})

test('changed roots require explicit restack, all-branch force consent, and stale remote/base rejection', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const initialParent = localOid(harness, 'parent')
    const initialChild = localOid(harness, 'child')

    git(harness, ['switch', 'main'])
    const changedMain = await commitFile(harness, 'base.txt', 'base\nroot change\n', 'Advance main')
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
        type: 'submitStack',
        token: publishBeforeRestack.token,
        allowForce: true,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
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
        type: 'submitStack',
        token: forcePreview.token,
        allowForce: false,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
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
    // A pull request that changed on GitHub after the preview invalidates the plan
    // before anything runs. The refusal itself is the behaviour under test; the
    // exact wording belongs to no assertion.
    const beforeStaleBase = {
      parent: localOid(harness, 'parent'),
      child: localOid(harness, 'child'),
      remoteParent: remoteOid(harness, 'parent'),
      remoteChild: remoteOid(harness, 'child'),
    }
    await assert.rejects(
      runAction(harness.repo, {
        type: 'submitStack',
        token: staleBasePreview.token,
        allowForce: true,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
      }),
    )
    assert.deepEqual(
      {
        parent: localOid(harness, 'parent'),
        child: localOid(harness, 'child'),
        remoteParent: remoteOid(harness, 'parent'),
        remoteChild: remoteOid(harness, 'child'),
      },
      beforeStaleBase,
      'a stale pull request refuses the run before any ref or pull request moves',
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
        type: 'submitStack',
        token: stalePreview.token,
        allowForce: true,
        layers: {
          parent: { title: 'Parent title', body: '', draft: false, updateBase: true },
          child: { title: 'Child title', body: '', draft: false, updateBase: true },
        },
      }),
      /remote child changed/u,
    )
    assert.equal(remoteOid(harness, 'child'), staleRemoteChild)
    assert.equal(localOid(harness, 'child'), rebasedChild)
  })
})

test('PR title, body, draft, close, and reopen actions use canonical fixture state', {
  concurrency: false,
}, async () => {
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
    assert.equal((await getPullRequest(harness.repo, pr.number)).body, 'Updated human description')

    await runAction(harness.repo, {
      type: 'updatePr',
      number: pr.number,
      title: 'Updated title',
      body: 'Updated human description',
      draft: true,
    })
    state = await harness.readState()
    assert.equal(prFor(state, 'topic').draft, true)

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
})

/** Marks every pull request in a published stack as ready for a direct merge. */
async function makeStackMergeable(harness: GitHubHarness): Promise<GitHubFixtureState> {
  const state = await harness.readState()
  for (const pr of state.prs) {
    if (pr.state !== 'OPEN') continue
    updatePr(state, pr.head, {
      draft: false,
      checks: 'passing',
      reviewDecision: 'APPROVED',
      mergeState: 'CLEAN',
    })
  }
  await harness.writeState(state)
  return state
}

/** Records every asynchronous merge request and its polled result. */
function recordingMergeTransport(): {
  transport: GitHubTransport
  starts: Array<{ url: string; body: Record<string, unknown> }>
  polls: string[]
} {
  const inner = createGitHubApiDouble()
  const starts: Array<{ url: string; body: Record<string, unknown> }> = []
  const polls: string[] = []
  const transport = new DirectGitHubTransport({
    token: 'fixture-token',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/merge-async') && init?.method === 'PUT')
        starts.push({ url, body: JSON.parse(String(init.body)) })
      if (url.includes('/merge-async/') && (!init?.method || init.method === 'GET')) polls.push(url)
      return inner(input, init)
    }) as typeof globalThis.fetch,
  })
  return { transport, starts, polls }
}

test('a native stack on a release line merges against the branch it is registered against', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    // The repository default branch stays `main`; the stack is registered
    // against `release/1.x`, which is the only base its layers can hang from.
    await runAction(harness.repo, {
      type: 'createBranch',
      name: 'release/1.x',
      parent: 'main',
    })
    await commitFile(harness, 'release.txt', 'release\n', 'Release line')
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'release/1.x' })
    await commitFile(harness, 'parent.txt', 'parent\n', 'Parent work')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    await commitFile(harness, 'child.txt', 'child\n', 'Child work')
    await publishStack(harness)

    const state = await harness.readState()
    const parent = prFor(state, 'parent')
    const child = prFor(state, 'child')
    state.stacks = [
      {
        id: 1,
        number: 1,
        node_id: 'S_kwDOA',
        url: `https://github.com/${state.repository.owner}/${state.repository.name}/stacks/1`,
        base: { ref: 'release/1.x' },
        open: true,
        created_at: '2026-09-29T00:00:00Z',
        pull_requests: [
          {
            number: parent.number,
            state: 'open',
            draft: false,
            merged_at: null,
            head: { ref: 'parent', sha: localOid(harness, 'parent') },
          },
          {
            number: child.number,
            state: 'open',
            draft: false,
            merged_at: null,
            head: { ref: 'child', sha: localOid(harness, 'child') },
          },
        ],
      },
    ]
    await harness.writeState(state)
    await makeStackMergeable(harness)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.deepEqual(
      preview.blockers,
      [],
      'the release line the stack is registered against is its trunk, not a missing layer',
    )
    assert.ok(preview.merge, 'a merge preview must describe the layers it will land')
    assert.deepEqual(
      preview.merge.layers.map((layer) => [layer.pullRequest, layer.branch]),
      [
        [parent.number, 'parent'],
        [child.number, 'child'],
      ],
    )
    const beforeMain = git(harness, ['rev-parse', 'refs/remotes/origin/main'])
    const beforeRelease = git(harness, ['rev-parse', 'refs/remotes/origin/release/1.x'])
    const inner = createGitHubApiDouble()
    const transport = new DirectGitHubTransport({
      token: 'fixture-token',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await inner(input, init)
        const url = String(input instanceof Request ? input.url : input)
        if (!url.includes('/graphql') && !url.includes('/merge-async/')) return response
        const payload = await response.json()
        if (url.includes('/merge-async/')) {
          if (payload.details) delete payload.details.sha
        } else if (payload.data?.repository?.pullRequest) {
          payload.data.repository.pullRequest.mergeCommit = null
        }
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: response.headers,
        })
      }) as typeof globalThis.fetch,
    })
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'merge',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['merged', 'merged'],
      )
    })
    const after = await harness.readState()
    assert.equal(prFor(after, 'parent').state, 'MERGED')
    assert.equal(prFor(after, 'child').state, 'MERGED')
    assert.equal(git(harness, ['rev-parse', 'refs/remotes/origin/main']), beforeMain)
    assert.equal(remoteOid(harness, 'main'), beforeMain)
    assert.notEqual(remoteOid(harness, 'release/1.x'), beforeRelease)
    assert.equal(
      git(harness, ['rev-parse', 'refs/remotes/origin/release/1.x']),
      remoteOid(harness, 'release/1.x'),
    )
    assert.equal(
      git(harness, ['config', '--get', 'branch.child.gitStacksMergedCommitOid']),
      prFor(after, 'child').mergeOid,
      'fallback merge-commit discovery uses the fetched release trunk',
    )
  })
})

test('merge previews the contiguous downstack of a stacked pull request and lands it from one request', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const state = await harness.readState()
    const parent = prFor(state, 'parent')
    const child = prFor(state, 'child')

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.deepEqual(preview.blockers, [])
    assert.ok(preview.merge, 'a merge preview must describe the layers it will land')
    assert.equal(preview.merge.native, true)
    assert.deepEqual(
      preview.merge.layers.map((layer) => [layer.pullRequest, layer.branch]),
      [
        [parent.number, 'parent'],
        [child.number, 'child'],
      ],
      'the selected pull request and everything below it are reviewed together',
    )
    assert.equal(
      preview.merge.layers.every((layer) => layer.includedInRequest),
      true,
    )
    assert.deepEqual(preview.merge.actions, ['default', 'direct_merge'])
    assert.match(preview.steps[0].note, /same operation as #\d+/u)

    const { transport, starts, polls } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.match(
        result.message,
        new RegExp(`Merged pull requests #${parent.number}, #${child.number} on GitHub`, 'u'),
      )
      assert.ok(result.merge, 'the result reports what happened to every layer')
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['merged', 'merged'],
      )
      assert.deepEqual(
        result.merge?.remaining.map((entry) => [entry.pullRequest, entry.state]),
        [],
      )
    })
    const after = await harness.readState()
    assert.equal(prFor(after, 'parent').state, 'MERGED')
    assert.equal(prFor(after, 'child').state, 'MERGED')
    assert.equal(
      starts.length,
      1,
      'a GitHub-native stack lands from one request for its top pull request',
    )
    assert.equal(starts[0]?.url.endsWith(`/pulls/${child.number}/merge-async`), true)
    assert.deepEqual(starts[0]?.body, {
      sha: child.headOid,
      merge_method: 'squash',
      merge_action: 'direct_merge',
    })
    assert.equal(polls.length >= 1, true, 'the pending result is polled by UUID')
    assert.equal(
      remoteOid(harness, 'main'),
      prFor(after, 'child').mergeOid,
      'origin/main is refreshed to what GitHub merged',
    )
  })
})

test('a pull request whose head moved after the preview is refused before any merge is requested', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.deepEqual(preview.blockers, [])
    const { transport, starts } = recordingMergeTransport()
    // Somebody pushes to the branch the review was read from.
    await makeRemoteDivergence(harness, 'parent')
    await withHarnessTransport(harness, transport, async () => {
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
          mergeAction: 'direct_merge',
        }),
        // The refusal is the contract: nothing is requested and nothing moves.
        // Which words report it is not.
      )
    })
    assert.deepEqual(starts, [], 'a stale preview never reaches GitHub')
    assert.equal(prFor(await harness.readState(), 'parent').state, 'OPEN')
  })
})

test('a merge-queue repository enqueues the stack and reports that the queue, not GitHub, owns it', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const state = await harness.readState()
    // This repository has a merge queue, so the documented default action resolves to one.
    state.mergeQueue = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.ok(preview.merge)
    // GitHub's own capability answers before this repository has ever enqueued anything, so
    // the first merge can already choose the queue instead of discovering it afterwards.
    assert.ok(
      preview.merge.actions.includes('merge_queue'),
      'a queue this host reports for the base ref is offered on the first merge',
    )
    assert.ok(
      !preview.warnings.some((warning) => /reports a queue/u.test(warning)),
      'a queue this host reports is not also reported as unknown',
    )
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'default',
      })
      assert.match(result.message, /joined the merge queue/u)
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['enqueued', 'enqueued'],
        'the one enqueued request carries both pull requests of the stack',
      )
      assert.deepEqual(
        result.merge?.layers.map((layer) => [layer.status, layer.queue?.outcome ?? null]),
        [
          ['enqueued', 'queued'],
          ['enqueued', 'queued'],
        ],
        'the queue that accepted the group is reported as holding it, by GitHub membership',
      )
      assert.deepEqual(
        result.merge?.remaining.map((entry) => entry.state),
        ['OPEN', 'OPEN'],
        'an enqueued run has merged nothing, so every pull request of the stack is left open',
      )
    })
    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0]?.body, {
      sha: prFor(await harness.readState(), 'child').headOid,
      merge_action: 'default',
    })
    const queued = await harness.readState()
    assert.equal(prFor(queued, 'parent').state, 'OPEN', 'an enqueued pull request has not merged')
    assert.equal(prFor(queued, 'child').state, 'OPEN')

    // The enqueue is the only documented proof of a queue, so the next preview offers it.
    const next = await previewStack(harness.repo, await getSnapshot(harness.repo), 'merge', 'child')
    assert.ok(next.merge?.actions.includes('merge_queue'))
  })
})

test('a merge request GitHub already holds is adopted instead of duplicated, and its failure is shown', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const child = prFor(state, 'child')
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.deepEqual(preview.blockers, [])
    // GitHub already holds a pending request for this pull request, and it fails.
    const armed = await harness.readState()
    armed.asyncMerge = {
      number: prFor(armed, 'parent').number,
      sha: prFor(armed, 'parent').headOid ?? '',
      method: 'squash',
      action: 'direct_merge',
      uuid: 'fixture-held',
    }
    armed.asyncMergeResult = {
      status: 'failed',
      message: 'Required status check build is failing. At least 1 approving review is required.',
    }
    await harness.writeState(armed)
    const { transport, starts, polls } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.match(result.message, /Required status check build is failing/u)
      assert.equal(result.merge?.layers[0]?.status, 'failed')
      assert.equal(result.merge?.layers[0]?.detail, armed.asyncMergeResult?.message)
    })
    assert.equal(starts.length, 1, 'the existing request is not sent a second time')
    assert.equal(
      polls.includes(
        `https://api.github.com/repos/acme/widgets/pulls/${prFor(armed, 'parent').number}/merge-async/fixture-held`,
      ),
      true,
      "GitHub's own UUID for the request it already held is the one that gets read",
    )
    assert.equal(prFor(await harness.readState(), 'parent').state, 'OPEN')
    assert.equal(prFor(await harness.readState(), 'child').state, 'OPEN')
    void child
  })
})

test('merge requires an explicit delivery action and refuses one the repository cannot take', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.deepEqual(preview.blockers, [])
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /Choose how GitHub should land this stack/u,
    )
    // A run consumes its preview, so the second refusal is proved against a fresh one.
    const fresh = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: fresh.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      }),
      /Merge action merge_queue is not available for this repository/u,
    )
    assert.equal(prFor(await harness.readState(), 'parent').state, 'OPEN')
  })
})

test('a locally chained stack merges one request per layer and stops at the first refusal', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    // Nothing GitHub published links these pull requests, so each one is merged from its
    // own request, bottom-to-top.
    const stackNumber = (await harness.readState()).stacks?.[0]?.number
    assert.ok(stackNumber)
    await runAction(harness.repo, { type: 'unstackNativeStack', stackNumber })
    const state = await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.deepEqual(preview.blockers, [])
    assert.equal(preview.merge?.native, false)
    assert.deepEqual(
      preview.merge?.layers.map((layer) => [layer.pullRequest, layer.includedInRequest]),
      [
        [prFor(state, 'parent').number, false],
        [prFor(state, 'child').number, true],
      ],
    )

    // The pull request above the first merge has a failing required check, so the run stops
    // there instead of asking GitHub to merge something the review did not clear.
    const broken = await harness.readState()
    updatePr(broken, 'child', { checks: 'failing', mergeState: 'BLOCKED' })
    await harness.writeState(broken)
    const localBefore = {
      parent: localOid(harness, 'parent'),
      child: localOid(harness, 'child'),
      main: localOid(harness, 'main'),
    }
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['merged', 'failed'],
        'the partial run reports the pull request that landed and the one that did not',
      )
      assert.match(result.merge?.layers[1]?.detail ?? '', /checks are failing/u)
      assert.match(result.message, /No local branch was changed/u)
    })
    assert.equal(starts.length, 1, 'the refused layer never reaches GitHub')
    const after = await harness.readState()
    assert.equal(prFor(after, 'parent').state, 'MERGED')
    assert.equal(prFor(after, 'child').state, 'OPEN')
    assert.equal(localOid(harness, 'parent'), localBefore.parent)
    assert.equal(localOid(harness, 'child'), localBefore.child)
    assert.equal(localOid(harness, 'main'), localBefore.main)
  })
})

test('the merge method GitHub is asked for is the reviewed one, and a disabled one never is', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.deepEqual(preview.blockers, [])
    assert.deepEqual(preview.mergeMethods, ['merge', 'squash', 'rebase'])
    const disabled = await harness.readState()
    disabled.repository.allowRebaseMerge = false
    await harness.writeState(disabled)
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'rebase',
          mergeAction: 'direct_merge',
        }),
        /Merge method rebase is not allowed by the repository/u,
      )
    })
    assert.deepEqual(starts, [])
    assert.equal(prFor(await harness.readState(), 'parent').state, 'OPEN')

    // The reviewed method is the one GitHub is asked for, on the same endpoint as the docs.
    const enabled = await harness.readState()
    enabled.repository.allowRebaseMerge = true
    await harness.writeState(enabled)
    const second = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    const recording = recordingMergeTransport()
    await withHarnessTransport(harness, recording.transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: second.token,
        allowForce: false,
        mergeMethod: 'rebase',
        mergeAction: 'direct_merge',
      })
      assert.equal(result.merge?.layers[0]?.status, 'merged')
    })
    assert.deepEqual(recording.starts[0]?.body, {
      sha: prFor(state, 'parent').headOid,
      merge_method: 'rebase',
      merge_action: 'direct_merge',
    })
    assert.equal(prFor(await harness.readState(), 'parent').state, 'MERGED')
  })
})

test('a stack that is not contiguous below the selection is refused instead of merged across', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    // The middle layer is gone locally, so the stack below the selection is not the
    // contiguous run one merge would land.
    git(harness, ['branch', '-D', 'parent'])
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.ok(
      preview.blockers.some((blocker) => /not an unmerged stack layer/u.test(blocker)),
      `expected a contiguity blocker, got ${JSON.stringify(preview.blockers)}`,
    )
    assert.equal(preview.merge, null, 'a stack that is not contiguous is not offered for merge')
  })
})

test('merged-root restack uses fetched remote main, preserves merged content, and retargets child PR', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
      mergeAction: 'direct_merge',
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
      mergeMethod: 'squash',
    })
    assert.equal(git(harness, ['config', '--get', 'branch.child.parent']), 'main')
    assert.equal(git(harness, ['config', '--get', 'branch.child.parentTip']), mergedParent.mergeOid)
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
        type: 'submitStack',
        token: mergedRootPreview.token,
        allowForce: true,
        layers: {},
      }),
    )

    const publishPreview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'publish',
      'child',
    )
    assert.deepEqual(publishPreview.blockers, [])
    // The child pull request now has to move onto the merged root, and a base change is
    // only ever applied when the submission approved it for that layer.
    await runAction(harness.repo, {
      type: 'submitStack',
      token: publishPreview.token,
      allowForce: true,
      layers: { child: { title: 'Child', body: '', draft: false, updateBase: true } },
    })
    state = await harness.readState()
    assert.equal(prFor(state, 'child').base, 'main')
    assert.equal(prFor(state, 'child').body, 'Human child description before parent merge')
    assert.equal(prFor(state, 'child').headOid, remoteOid(harness, 'child'))
    assert.equal(prFor(state, 'parent').state, 'MERGED')
  })
})

test('restack preserves unpublished commits after a merged parent', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
      mergeAction: 'direct_merge',
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
      mergeMethod: 'squash',
    })
    assert.notEqual(localOid(harness, 'child'), childTip)
    assert.equal(git(harness, ['show', 'child:parent-after-merge.txt']), 'parent two')
    assert.equal(git(harness, ['show', 'child:child.txt']), 'child')
    assert.equal(localOid(harness, 'parent'), laterParentTip)
    assert.equal(git(harness, ['config', '--get', 'branch.child.parentTip']), mergedParentMergeOid)
    assert.equal(remoteOid(harness, 'main'), mergedParentMergeOid)
  })
})
test('restack preserves commits added to a merged PR source after its merge', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
      mergeAction: 'direct_merge',
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
      mergeMethod: 'squash',
    })

    assert.equal(git(harness, ['show', 'child:later-parent.txt']), 'later parent work')
    assert.equal(git(harness, ['show', 'child:child.txt']), 'child')
  })
})

test('restack reconstructs merge-time head from journal and rejects unproven metadata pointing at child tip', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
      mergeAction: 'direct_merge',
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
})

test('branch publication recovers orphaned branch ref locks left by dead processes', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const deadPid = 99999999
    const lockData = {
      pid: deadPid,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 10000,
      transactionId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    }
    await writeFile(lockPath, JSON.stringify(lockData), 'utf8')

    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    await mkdir(locksDir, { recursive: true })
    await writeFile(
      join(locksDir, 'deadbeefdeadbeefdeadbeefdeadbeef.json'),
      JSON.stringify(lockData),
      'utf8',
    )

    await publishStack(harness)
    const state = await harness.readState()
    assert.ok(prFor(state, 'child'))

    await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
    await assert.rejects(readFile(join(locksDir, 'deadbeefdeadbeefdeadbeefdeadbeef.json')), {
      code: 'ENOENT',
    })
  })
})

test('branch lock recovery accepts an exact custom files ref-storage lock path', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const customRoot = join(harness.root, 'custom refs')
    const customHeadsDir = join(customRoot, 'refs', 'heads')
    const customLockPath = join(customHeadsDir, 'child.lock')
    const refStorage = `files://${pathToFileURL(customRoot).pathname}`
    const transactionId = 'deadbeef-dead-beef-dead-beefdeadbeef'
    const lockData = {
      pid: 99999999,
      branch: 'child',
      lockPath: customLockPath,
      createdAt: Date.now() - 30000,
      transactionId,
    }
    await mkdir(customHeadsDir, { recursive: true })
    // A custom `files://` ref storage reports its ref storage setting and
    // answers `--git-path` for branch refs with the ref itself, which is where
    // the lock for this branch lives. The harness answers those two commands
    // and leaves every other Git command to real Git.
    harness.overrideGit({
      match: (args) =>
        (args[0] === 'config' && args[1] === '--get' && args[2] === 'extensions.refstorage') ||
        (args[0] === 'rev-parse' &&
          args[1] === '--git-path' &&
          String(args[2] || '').startsWith('refs/heads/')),
      run: (args) => (args[0] === 'config' ? `${refStorage}\n` : `${String(args[2])}\n`),
    })
    await writeFile(customLockPath, JSON.stringify(lockData), 'utf8')
    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    await mkdir(locksDir, { recursive: true })
    const journalPath = join(locksDir, `${transactionId}.json`)
    await writeFile(journalPath, JSON.stringify(lockData), 'utf8')

    await recoverStaleBranchLocks(harness.repo)
    await assert.rejects(readFile(customLockPath), { code: 'ENOENT' })
    await assert.rejects(readFile(journalPath), { code: 'ENOENT' })

    await publishStack(harness)
    assert.ok(prFor(await harness.readState(), 'child'))
  })
})

test('branch lock recovery accepts the literal files ref-storage setting', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    git(harness, ['config', 'core.repositoryFormatVersion', '1'])
    git(harness, ['config', 'extensions.refStorage', 'files'])

    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    const transactionId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const lockData = {
      pid: 99999999,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 30000,
      transactionId,
    }
    await mkdir(locksDir, { recursive: true })
    await writeFile(lockPath, JSON.stringify(lockData), 'utf8')
    const journalPath = join(locksDir, `${transactionId}.json`)
    await writeFile(journalPath, JSON.stringify(lockData), 'utf8')

    await recoverStaleBranchLocks(harness.repo)
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
    await assert.rejects(readFile(journalPath), { code: 'ENOENT' })

    await publishStack(harness)
    assert.ok(prFor(await harness.readState(), 'child'))
  })
})

test('stale branch lock cleanup preserves live locks and removes dead journals', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const transactionId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const liveLockData = {
      pid: process.pid,
      branch: 'child',
      lockPath,
      createdAt: Date.now(),
      transactionId,
    }
    await writeFile(lockPath, JSON.stringify(liveLockData), 'utf8')

    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    await mkdir(locksDir, { recursive: true })
    const deadJournalPath = join(locksDir, `${transactionId}.json`)
    const deadLockData = {
      pid: 99999999,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 20000,
      transactionId,
    }
    await writeFile(deadJournalPath, JSON.stringify(deadLockData), 'utf8')

    await recoverStaleBranchLocks(harness.repo)

    const liveContent = JSON.parse(await readFile(lockPath, 'utf8'))
    assert.equal(liveContent.transactionId, transactionId)
    await assert.rejects(readFile(deadJournalPath), { code: 'ENOENT' })
  })
})

test('branch lock recovery preserves journals for invalid numeric PIDs', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    const transactionId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const journalPath = join(locksDir, `${transactionId}.json`)
    const lockData = {
      pid: 0,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 30000,
      transactionId,
    }
    await mkdir(locksDir, { recursive: true })
    await writeFile(lockPath, JSON.stringify(lockData), 'utf8')
    await writeFile(journalPath, JSON.stringify(lockData), 'utf8')

    await assert.rejects(publishStack(harness), /being updated/u)
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), lockData)
    assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), lockData)
  })
})

test('branch lock recovery preserves journals for mismatched live lock metadata', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    const journalTransactionId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const journalPath = join(locksDir, `${journalTransactionId}.json`)
    const liveLockData = {
      pid: process.pid,
      branch: 'child',
      lockPath,
      createdAt: Date.now(),
      transactionId: 'ffffffffffffffffffffffffffffffff',
    }
    const journalData = {
      pid: 99999999,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 30000,
      transactionId: journalTransactionId,
    }
    await mkdir(locksDir, { recursive: true })
    await writeFile(lockPath, JSON.stringify(liveLockData), 'utf8')
    await writeFile(journalPath, JSON.stringify(journalData), 'utf8')

    await assert.rejects(publishStack(harness), /being updated/u)
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), liveLockData)
    assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), journalData)
  })
})

test('stale branch lock cleanup preserves a replacement created during identity validation', {
  concurrency: false,
}, async () => {
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
})

test('branch lock recovery rejects journals without a branch before touching the candidate lock', {
  concurrency: false,
}, async () => {
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
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).lockPath, victimLock)
  })
})

test('branch lock recovery rejects path traversal in journal lockPath and transactionId', {
  concurrency: false,
}, async () => {
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
        transactionId: 'deadbeefdeadbeefdeadbeefdeadbeef',
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
    assert.equal(JSON.parse(await readFile(maliciousJournal1, 'utf8')).lockPath, victimLock)
    assert.equal(
      JSON.parse(await readFile(maliciousJournal2, 'utf8')).transactionId,
      '../../victim.txt',
    )
  })
})

test('branch lock recovery preserves malformed partial locks and blocks publication', {
  concurrency: false,
}, async () => {
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
})

test('branch lock recovery preserves parseable locks with mismatched transaction metadata', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    const lockPath = join(harness.repo, '.git', 'refs', 'heads', 'child.lock')
    const locksDir = join(harness.repo, '.git', 'git-stacks-branch-locks')
    const journalTransactionId = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const lockTransactionId = 'ffffffffffffffffffffffffffffffff'
    const journalData = {
      pid: 99999999,
      branch: 'child',
      lockPath,
      createdAt: Date.now() - 30000,
      transactionId: journalTransactionId,
    }
    const lockData = {
      ...journalData,
      transactionId: lockTransactionId,
    }
    await mkdir(locksDir, { recursive: true })
    const journalPath = join(locksDir, `${journalTransactionId}.json`)
    await writeFile(journalPath, JSON.stringify(journalData), 'utf8')
    await writeFile(lockPath, JSON.stringify(lockData), 'utf8')

    await recoverStaleBranchLocks(harness.repo)
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), lockData)
    assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), journalData)
    await assert.rejects(publishStack(harness), /being updated/u)
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), lockData)
    assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')), journalData)
  })
})

test('restack rejects stale ancestor candidate when journal records the true merge head', {
  concurrency: false,
}, async () => {
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
      mergeMethod: 'squash',
      mergeAction: 'direct_merge',
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
})

test('the optional gh adapter serves the same pull request reads without a direct transport', {
  concurrency: false,
}, async () => {
  await withHarness(
    async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const state = await harness.readState()
      assert.deepEqual(state.prs.map((pr) => pr.head).sort(), ['child', 'parent'])
      const parent = prFor(state, 'parent')
      assert.equal(parent.headOid, remoteOid(harness, 'parent'))
      const data = await getGitHubData(harness.repo, 'https://github.com/acme/widgets.git')
      assert.equal(data.available, true)
      assert.deepEqual(
        data.pullRequests.map((pr) => pr.number).sort((a, b) => a - b),
        state.prs.map((pr) => pr.number).sort((a, b) => a - b),
      )
      const exact = await getPullRequest(harness.repo, parent.number)
      assert.equal(exact.body, parent.body)
      assert.equal(exact.headOid, parent.headOid)
    },
    { transport: new GhGitHubTransport() },
  )
})

test('a native stack whose membership moved after the preview is refused instead of merged across', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const state = await harness.readState()
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.deepEqual(preview.blockers, [])
    // A pull request joins the stack below the selection after the review. GitHub would land
    // it with the request, so the reviewed membership is re-read and the run is refused.
    const moved = await harness.readState()
    const stack = moved.stacks?.[0]
    assert.ok(stack)
    const stranger = stack.pull_requests[0]
    moved.stacks = [
      {
        ...stack,
        pull_requests: [
          {
            ...stranger,
            number: prFor(moved, 'parent').number + 90,
            state: 'open',
          },
          ...stack.pull_requests,
        ],
      },
    ]
    await harness.writeState(moved)
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
          mergeAction: 'direct_merge',
        }),
        // A membership that moved is a refusal, whichever words report it.
      )
    })
    assert.equal(starts.length, 0, 'a moved stack never reaches GitHub')
    const after = await harness.readState()
    assert.equal(prFor(after, 'parent').state, 'OPEN')
    assert.equal(prFor(after, 'child').state, 'OPEN')
    void state
  })
})

test('an enqueue for one local layer never reports a pull request this run did not request', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const stackNumber = (await harness.readState()).stacks?.[0]?.number
    assert.ok(stackNumber)
    await runAction(harness.repo, { type: 'unstackNativeStack', stackNumber })
    const state = await harness.readState()
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.equal(preview.merge?.native, false)
    // The bottom layer's request is accepted by a queue. Every other layer needs its own
    // request, so nothing above it can be reported as queued.
    const queued = await harness.readState()
    queued.asyncMergeResult = { status: 'enqueued' }
    await harness.writeState(queued)
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => [layer.pullRequest, layer.status]),
        [
          [prFor(state, 'parent').number, 'enqueued'],
          [prFor(state, 'child').number, 'not-requested'],
        ],
      )
      assert.match(result.message, /was not requested in this run/u)
    })
    assert.equal(starts.length, 1, 'the queue stops the run before the next request')
    const status = await getMergeStatus(harness.repo)
    assert.deepEqual(
      status?.layers.map((layer) => [layer.pullRequest, layer.queue?.outcome ?? null]),
      [[prFor(state, 'parent').number, 'queued']],
      'only the pull request GitHub accepted is remembered',
    )
  })
})

test('a merge GitHub is still running keeps its request identity and is read on refresh', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const running = await harness.readState()
    running.asyncMergeStaysPending = true
    await harness.writeState(running)
    const { transport, starts, polls } = recordingMergeTransport()
    let requestUuid: string | null = null
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['pending', 'pending'],
        'a request GitHub is still running is neither merged nor refused',
      )
      requestUuid = result.merge?.layers[1]?.requestUuid ?? null
      assert.ok(requestUuid, 'the accepted request keeps the UUID it can be read with')
      assert.match(result.message, /still running/u)
    })
    assert.equal(starts.length, 1)
    // The run ended without a terminal result, so the outcome is read, not resubmitted.
    const before = await getMergeStatus(harness.repo)
    assert.deepEqual(
      before?.layers.map((layer) => layer.status),
      ['pending', 'pending'],
    )
    const settled = await harness.readState()
    settled.asyncMergeStaysPending = false
    await harness.writeState(settled)
    const after = await getMergeStatus(harness.repo)
    assert.deepEqual(
      after?.layers.map((layer) => layer.status),
      ['merged', 'merged'],
      "the refresh reads the same request's result",
    )
    assert.equal(
      polls.filter((url) => url.endsWith(`/merge-async/${requestUuid}`)).length > 0,
      true,
    )
    assert.equal(starts.length, 1, 'reading the result never sends another merge request')
    void prFor(state, 'child')
  })
})

test('a merge request GitHub holds with another method is refused rather than adopted', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    const held = await harness.readState()
    held.asyncMerge = {
      number: prFor(held, 'parent').number,
      sha: prFor(held, 'parent').headOid ?? '',
      method: 'merge',
      action: 'direct_merge',
      uuid: 'fixture-held',
    }
    await harness.writeState(held)
    const { transport } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
          mergeAction: 'direct_merge',
        }),
        /already has a merge merge request/u,
      )
    })
    void prFor(state, 'parent')
  })
})

test('a failed native request still reads back the pull request it already landed', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const state = await harness.readState()
    const parentNumber = prFor(state, 'parent').number
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    // GitHub lands the bottom pull request and then refuses the one on top of it.
    const partial = await harness.readState()
    partial.asyncMergeResult = { status: 'failed', message: 'Required review is missing' }
    partial.prs = partial.prs.map((pr) =>
      pr.number === parentNumber ? { ...pr, state: 'MERGED', mergeState: 'MERGED' } : pr,
    )
    await harness.writeState(partial)
    const { transport } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => [layer.pullRequest, layer.status]),
        [
          [parentNumber, 'merged'],
          [prFor(state, 'child').number, 'failed'],
        ],
        'a partial merge reports the pull request that landed alongside the refusal',
      )
      assert.match(result.message, /Merged pull request #\d+/u)
    })
    const recorded = git(harness, ['config', '--get', 'branch.parent.gitStacksMergedHeadPr'])
    assert.equal(recorded, String(parentNumber), 'the landed pull request is recorded')
  })
})

test('a merge queue that later drops a pull request is reported by a read, not another merge', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    // This repository has a merge queue, so the documented default action resolves to one.
    state.mergeQueue = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'default',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['enqueued', 'enqueued'],
      )
    })
    // The queue is only offered once GitHub has accepted an enqueue for its base ref.
    const afterQueue = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    assert.ok(afterQueue.merge?.actions.includes('merge_queue'))
    // A pull request closed without merging is the one case the pull request itself settles:
    // the queue dropped it.
    const dropped = await harness.readState()
    dropped.prs = dropped.prs.map((pr) =>
      pr.number === childNumber ? { ...pr, state: 'CLOSED' } : pr,
    )
    await harness.writeState(dropped)
    const status = await getMergeStatus(harness.repo)
    assert.equal(status?.layers[1]?.status, 'not-merged')
    assert.equal(status?.layers[1]?.queue?.outcome, 'dropped')
    assert.match(status?.layers[1]?.detail ?? '', /closed without merging/u)
    assert.equal(starts.length, 1, 'reading a queue outcome submits no merge')
  })
})

test('a queue that holds a pull request, ejects it, and takes it again is read from GitHub membership', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    // This repository has a merge queue, so the documented default action resolves to one.
    state.mergeQueue = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'default',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['enqueued', 'enqueued'],
      )

      // The queue accepted the group, so it is reported as holding it, with the place it
      // named. An accepted enqueue is not that evidence; GitHub's membership is.
      const queued = await getMergeStatus(harness.repo)
      const held = queued?.layers.find((entry) => entry.pullRequest === childNumber)
      assert.equal(held?.status, 'enqueued')
      assert.equal(held?.queue?.outcome, 'queued')
      assert.equal(held?.queue?.membership, 'queued')
      assert.ok((held?.queue?.entry?.position ?? 0) > 0, 'the entry names the place in the queue')
      assert.equal(held?.queue?.stale, false)
      assert.equal(starts.length, 1, 'reading a queue outcome submits no merge')

      // The queue rejects it for a failing rule. Nothing merges and no ref moves; the pull
      // request is simply no longer held.
      const ejected = await harness.readState()
      delete ejected.mergeQueueMembers?.[String(childNumber)]
      const before = { local: localOid(harness, 'child'), remote: remoteOid(harness, 'child') }
      await harness.writeState(ejected)
      const dropped = await getMergeStatus(harness.repo)
      const out = dropped?.layers.find((entry) => entry.pullRequest === childNumber)
      assert.equal(out?.queue?.outcome, 'dropped', 'a pull request the queue let go is dropped')
      assert.equal(out?.queue?.membership, 'not-queued')
      assert.equal(out?.status, 'not-merged')
      assert.notEqual(
        dropped?.message,
        'GitHub reports no further change for these merge requests.',
        'the summary reports the removal GitHub published',
      )
      assert.equal(localOid(harness, 'child'), before.local, 'an ejection moves no ref')
      assert.equal(remoteOid(harness, 'child'), before.remote)

      // Enqueueing again is a new request, and the queue reports it again.
      const again = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      const requeued = await runAction(harness.repo, {
        type: 'executeStack',
        token: again.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      })
      assert.deepEqual(
        requeued.merge?.layers.map((layer) => layer.queue?.outcome ?? null),
        ['queued', 'queued'],
        'a second enqueue is reported as membership again',
      )
      assert.equal(starts.length, 2, 'the second run is one new request, not a replay')
    })
  })
})

test('a queue read this host cannot answer keeps the membership a read confirmed', {
  concurrency: false,
}, async () => {
  for (const mode of ['refused', 'absent', 'malformed'] as const) {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const state = await makeStackMergeable(harness)
      const childNumber = prFor(state, 'child').number
      state.mergeQueue = true
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      const { transport, starts } = recordingMergeTransport()
      await withHarnessTransport(harness, transport, async () => {
        await runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
          mergeAction: 'merge_queue',
        })
        const confirmed = await getMergeStatus(harness.repo)
        assert.equal(
          confirmed?.layers.find((entry) => entry.pullRequest === childNumber)?.queue?.outcome,
          'queued',
          'the queue accepted the group before the read broke',
        )

        // The host answers the queue fields with something this build cannot read: a
        // schema without them, a payload without them, or values of the wrong shape.
        const broken = await harness.readState()
        broken.mergeQueueFields = mode
        await harness.writeState(broken)
        const unread = await getMergeStatus(harness.repo)
        const layer = unread?.layers.find((entry) => entry.pullRequest === childNumber)
        assert.equal(layer?.queue?.outcome, 'queued', `a ${mode} queue read is not a removal`)
        assert.equal(layer?.queue?.stale, true, `a ${mode} queue read is reported as stale`)
        assert.match(layer?.detail ?? '', /last state a read confirmed/u)
        assert.match(unread?.message ?? '', /last confirmed queue state.*in the merge queue/u)
        assert.match(unread?.message ?? '', /current queue membership could not be confirmed/u)
        assert.doesNotMatch(unread?.message ?? '', /GitHub reports.*in the merge queue/u)

        delete broken.mergeQueueFields
        delete broken.mergeQueueMembers?.[String(childNumber)]
        await harness.writeState(broken)
        const removed = await getMergeStatus(harness.repo)
        assert.equal(
          removed?.layers.find((entry) => entry.pullRequest === childNumber)?.queue?.membership,
          'not-queued',
        )
        broken.mergeQueueFields = mode
        await harness.writeState(broken)
        const retainedRemoval = await getMergeStatus(harness.repo)
        const removedLayer = retainedRemoval?.layers.find(
          (entry) => entry.pullRequest === childNumber,
        )
        assert.equal(removedLayer?.queue?.membership, 'not-queued')
        assert.equal(removedLayer?.queue?.stale, true)
        assert.match(removedLayer?.detail ?? '', /last state a read confirmed/u)
        assert.match(
          retainedRemoval?.message ?? '',
          /last confirmed queue state.*outside the merge queue/u,
        )
        assert.match(
          retainedRemoval?.message ?? '',
          /current queue membership could not be confirmed/u,
        )
        assert.doesNotMatch(retainedRemoval?.message ?? '', /GitHub reports.*no longer/u)

        assert.equal(starts.length, 1, 'reading a queue state submits no merge')
      })
    })
  }
})

test('a head that moved after an enqueue leaves membership unconfirmed when the queue fields are unreadable', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    state.mergeQueue = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      mergeMethod: 'squash',
      mergeAction: 'merge_queue',
    })
    assert.equal(
      (await getMergeStatus(harness.repo))?.layers.find(
        (entry) => entry.pullRequest === childNumber,
      )?.queue?.outcome,
      'queued',
    )

    // Somebody pushes to the branch the request was made against, and the host then cannot
    // answer the queue fields at all.
    await makeRemoteDivergence(harness, 'child')
    const unread = await harness.readState()
    unread.mergeQueueFields = 'refused'
    await harness.writeState(unread)
    const layer = (await getMergeStatus(harness.repo))?.layers.find(
      (entry) => entry.pullRequest === childNumber,
    )
    assert.equal(
      layer?.queue?.outcome,
      'unconfirmed',
      'the reviewed head is gone, so its membership is neither applied nor carried forward',
    )
    assert.equal(layer?.queue?.membership, null)
    assert.equal(layer?.queue?.stale, false, 'nothing was re-confirmed, so nothing is stale')
  })
})

test('the membership a merge run confirmed survives a read that cannot reach the queue fields', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    state.mergeQueue = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const result = await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      mergeMethod: 'squash',
      mergeAction: 'merge_queue',
    })
    assert.equal(
      result.merge?.layers.find((entry) => entry.pullRequest === childNumber)?.queue?.outcome,
      'queued',
      'the run read the membership it accepted',
    )

    // The queue fields become unreadable: a read now has nothing of its own to report, so
    // what it can still say is what this run wrote down when it confirmed the membership.
    const offline = await harness.readState()
    offline.mergeQueueFields = 'refused'
    await harness.writeState(offline)
    const layer = (await getMergeStatus(harness.repo))?.layers.find(
      (entry) => entry.pullRequest === childNumber,
    )
    assert.equal(layer?.queue?.outcome, 'queued', 'the confirmed membership was journalled')
    assert.equal(layer?.queue?.stale, true)
  })
})

test('a pull request the queue released before the run read back is reported as dropped by that run', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    state.mergeQueue = true
    // GitHub accepts the group and releases it before this run reads the queue.
    state.mergeQueueEjects = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      })
      const layer = result.merge?.layers.find((entry) => entry.pullRequest === childNumber)
      assert.equal(layer?.status, 'not-merged', 'the run does not leave a removal as queued')
      assert.equal(layer?.queue?.outcome, 'dropped')
      assert.equal(layer?.queue?.membership, 'not-queued')
      assert.equal(starts.length, 1, 'reconciling with the queue submits no merge')
    })
    // The journal agrees with the run, so a later read does not resurrect the enqueue.
    const layer = (await getMergeStatus(harness.repo))?.layers.find(
      (entry) => entry.pullRequest === childNumber,
    )
    assert.equal(layer?.queue?.membership, 'not-queued')
    assert.equal(layer?.status, 'not-merged')
  })
})

test('a queue entry this build cannot stand behind leaves the membership confirmed and the place unknown', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    state.mergeQueue = true
    // The membership answers truthfully while the entry carries a negative position, a
    // state no queue has, and a time that is not a date.
    state.mergeQueueFields = 'entry'
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      mergeMethod: 'squash',
      mergeAction: 'merge_queue',
    })
    const layer = (await getMergeStatus(harness.repo))?.layers.find(
      (entry) => entry.pullRequest === childNumber,
    )
    assert.equal(layer?.queue?.membership, 'queued', 'membership stands on its own answer')
    assert.equal(layer?.queue?.outcome, 'queued')
    assert.equal(layer?.queue?.entry, null, 'an entry this build cannot read is not reported')
  })
})

test('one unusable queue-entry field leaves the membership confirmed and the place unknown', {
  concurrency: false,
}, async () => {
  for (const mode of ['state', 'date'] as const) {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const state = await makeStackMergeable(harness)
      const childNumber = prFor(state, 'child').number
      state.mergeQueue = true
      // Everything else in the answer is valid, including the position and, for `date`, the
      // enum state: only the named field is something this build cannot stand behind.
      state.mergeQueueFields = mode
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      })
      const layer = (await getMergeStatus(harness.repo))?.layers.find(
        (entry) => entry.pullRequest === childNumber,
      )
      assert.equal(layer?.queue?.membership, 'queued', `a ${mode} entry keeps the membership`)
      assert.equal(layer?.queue?.entry, null, `a ${mode} entry is not reported as a position`)
    })
  }
})

test('an answer that proves only half of the captured pair removes nothing', {
  concurrency: false,
}, async () => {
  for (const mode of ['no-head', 'no-base'] as const) {
    await withHarness(async (harness) => {
      await createStack(harness)
      await publishStack(harness)
      const state = await makeStackMergeable(harness)
      const childNumber = prFor(state, 'child').number
      state.mergeQueue = true
      await harness.writeState(state)
      const preview = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      })
      assert.equal(
        (await getMergeStatus(harness.repo))?.layers.find(
          (entry) => entry.pullRequest === childNumber,
        )?.queue?.outcome,
        'queued',
      )

      // The pull request reads cleanly on the captured head and base, and the membership
      // answer names the same pull request but leaves one half of that pair out while
      // reporting that the queue no longer holds it. Half a pair is no evidence about this
      // request, so the confirmed membership stays as the last confirmation.
      const half = await harness.readState()
      half.mergeQueueFields = mode
      await harness.writeState(half)
      const layer = (await getMergeStatus(harness.repo))?.layers.find(
        (entry) => entry.pullRequest === childNumber,
      )
      assert.equal(layer?.queue?.outcome, 'queued', `a ${mode} answer removes nothing`)
      assert.equal(layer?.queue?.membership, 'queued')
      assert.equal(layer?.queue?.stale, true, 'and it is labelled as the last confirmation')
    })
  }
})

test('an immediate enqueue with no request UUID is kept, never polled, and keeps its base ref', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const parentNumber = prFor(state, 'parent').number
    const childNumber = prFor(state, 'child').number
    // GitHub answers a pull request that is already in a queue immediately, with a terminal
    // result and no request identity at all.
    state.mergeQueue = true
    state.asyncMergeAlreadyQueued = true
    await harness.writeState(state)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const { transport, starts, polls } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'default',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['enqueued', 'enqueued'],
      )
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.requestUuid),
        [null, null],
        'no identity is invented for a result GitHub did not give one for',
      )
      // The terminal result is journalled anyway, so a reopened dialog and the next preview
      // both still know a queue accepted this base ref.
      const status = await getMergeStatus(harness.repo)
      assert.deepEqual(
        status?.layers.map((layer) => [layer.pullRequest, layer.status]),
        [
          [parentNumber, 'enqueued'],
          [childNumber, 'enqueued'],
        ],
        'the terminal enqueue is what a reopened dialog reports',
      )
      assert.equal(
        status?.layers.find((entry) => entry.pullRequest === childNumber)?.queue?.configured,
        true,
      )
      const offered = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      assert.equal(
        offered.merge?.actions.includes('merge_queue'),
        true,
        'an accepted enqueue is the base-ref evidence the next preview needs',
      )
    })
    assert.equal(starts.length, 1)
    assert.deepEqual(
      polls.filter((url) => url.includes('merge-async/')),
      [],
      'an absent request UUID is never polled for',
    )
  })
})

test('a request that later enqueues is read from the owning endpoint and stays enqueued', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const childNumber = prFor(state, 'child').number
    const parentNumber = prFor(state, 'parent').number
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'child',
    )
    const running = await harness.readState()
    running.asyncMergeStaysPending = true
    await harness.writeState(running)
    const { transport, polls } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      const result = await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
      assert.deepEqual(
        result.merge?.layers.map((layer) => layer.status),
        ['pending', 'pending'],
      )
      // The request belongs to the pull request it was made for, so it is read there, not
      // on the downstack layer that shares its identity.
      const settled = await harness.readState()
      settled.asyncMergeStaysPending = false
      settled.asyncMergeResult = { status: 'enqueued' }
      await harness.writeState(settled)
      const beforePolls = polls.length
      const status = await getMergeStatus(harness.repo)
      assert.deepEqual(
        status?.layers.map((layer) => [layer.pullRequest, layer.status]),
        [
          [parentNumber, 'enqueued'],
          [childNumber, 'enqueued'],
        ],
        "one request's enqueue covers the layers it carried",
      )
      assert.equal(
        polls.slice(beforePolls).some((url) => url.includes(`/pulls/${childNumber}/merge-async/`)),
        true,
        'the result is read from the pull request that owns the request',
      )
      assert.equal(
        polls.slice(beforePolls).some((url) => url.includes(`/pulls/${parentNumber}/merge-async/`)),
        false,
      )
      // The enqueue is terminal and persisted, so a read after the request expires still
      // reports the queue rather than a request that is somehow still running.
      const expired = await harness.readState()
      delete expired.asyncMerge
      await harness.writeState(expired)
      const reopened = await getMergeStatus(harness.repo)
      assert.deepEqual(
        reopened?.layers.map((layer) => [layer.pullRequest, layer.queue?.outcome ?? null]),
        [
          [parentNumber, 'queued'],
          [childNumber, 'queued'],
        ],
        'the queue that accepted the group still holds it after the request expires',
      )
      const offered = await previewStack(
        harness.repo,
        await getSnapshot(harness.repo),
        'merge',
        'child',
      )
      assert.equal(
        offered.merge?.actions.includes('merge_queue'),
        true,
        'an accepted enqueue is the evidence a queue exists for this base ref',
      )
    })
  })
})

test('a merge that exceeds the polling bound offers no queue and keeps its request readable', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    await makeStackMergeable(harness)
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    const running = await harness.readState()
    running.asyncMergeStaysPending = true
    await harness.writeState(running)
    const { transport } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
    })
    const next = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.equal(
      next.merge?.actions.includes('merge_queue'),
      false,
      'a direct merge that is still running is no evidence of a queue',
    )
    const status = await getMergeStatus(harness.repo)
    assert.equal(status?.layers[0]?.status, 'pending')
    assert.equal(status?.layers[0]?.queue, null, 'a request that never enqueued has no queue')
  })
})

test('a locally reviewed pull request attached to a native stack is refused before any request', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const stackNumber = (await harness.readState()).stacks?.[0]?.number
    assert.ok(stackNumber)
    await runAction(harness.repo, { type: 'unstackNativeStack', stackNumber })
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    assert.equal(preview.merge?.native, false)
    // The stack is rebuilt behind the review, so GitHub would apply stack semantics to a
    // request this review assumed was single.
    const restored = await harness.readState()
    const childNumber = prFor(restored, 'child').number
    restored.prs = restored.prs.map((pr) =>
      pr.number === childNumber ? { ...pr, stack: { stackNumber, position: 2 } } : pr,
    )
    restored.stacks = [
      {
        id: stackNumber,
        number: stackNumber,
        node_id: `S_${stackNumber}`,
        url: `https://api.github.com/repos/acme/widgets/stacks/${stackNumber}`,
        base: { ref: 'main' },
        open: true,
        created_at: '2026-09-01T00:00:00Z',
        pull_requests: restored.prs.map((pr) => ({
          number: pr.number,
          state: 'open',
          draft: false,
          merged_at: null,
          head: { ref: pr.head, sha: pr.headOid ?? '' },
        })),
      },
    ]
    await harness.writeState(restored)
    const { transport, starts } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await assert.rejects(
        runAction(harness.repo, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
          mergeAction: 'direct_merge',
        }),
        /now belongs to native stack/u,
      )
    })
    assert.equal(starts.length, 0, 'native membership is refused before a request is sent')
    void prFor(state, 'parent')
  })
})

test('a request GitHub failed keeps its reason for a later read', {
  concurrency: false,
}, async () => {
  await withHarness(async (harness) => {
    await createStack(harness)
    await publishStack(harness)
    const state = await makeStackMergeable(harness)
    const parentNumber = prFor(state, 'parent').number
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'merge',
      'parent',
    )
    const failing = await harness.readState()
    failing.asyncMergeResult = { status: 'failed', message: 'Required review is missing' }
    await harness.writeState(failing)
    const { transport } = recordingMergeTransport()
    await withHarnessTransport(harness, transport, async () => {
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'direct_merge',
      })
    })
    const status = await getMergeStatus(harness.repo)
    assert.equal(
      status?.layers[0]?.status,
      'failed',
      'a refusal GitHub already reported stays a failure on the read, not an unmerged layer',
    )
    assert.match(status?.layers[0]?.detail ?? '', /Required review is missing/u)
    // The result is kept, so the reason survives the request expiring.
    const expired = await harness.readState()
    delete expired.asyncMerge
    await harness.writeState(expired)
    const reopened = await getMergeStatus(harness.repo)
    assert.equal(reopened?.layers[0]?.status, 'failed')
    assert.match(reopened?.layers[0]?.detail ?? '', /Required review is missing/u)
    void parentNumber
  })
})

test('a live read whose credential is replaced while its reconciliation is still being built is refused, not delivered', async () => {
  await withHarness(async (harness) => {
    git(harness, ['checkout', '-b', 'feature', 'main'])
    fs.writeFileSync(join(harness.repo, 'feature.txt'), 'feature\n')
    git(harness, ['add', 'feature.txt'])
    git(harness, [
      '-c',
      'user.name=Feature',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-m',
      'Feature',
    ])
    const state = await harness.readState()
    state.prs = [
      {
        number: 7,
        title: 'Private work',
        body: 'body',
        base: 'main',
        head: 'feature',
        headRepository: `${state.repository.owner}/${state.repository.name}`,
        draft: false,
        state: 'OPEN',
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
        url: `https://github.com/${`${state.repository.owner}/${state.repository.name}`}/pull/7`,
        headOid: git(harness, ['rev-parse', 'feature']),
        mergeOid: null,
        mergedAt: null,
      },
    ]
    await harness.writeState(state)
    const confirmed = await getSnapshot(harness.repo, undefined, undefined, 'live')
    assert.ok(
      confirmed.pullRequests.some((pullRequest) => pullRequest.number === 7),
      'the read confirmed no payload for this one to lose',
    )

    // This read asks GitHub for a fresh answer, and the account is replaced inside
    // the last thing the read awaits — the reconciliation it builds from that
    // answer — so the replacement lands after every answer is in hand and before
    // the snapshot that would carry them is handed over.
    // The replacement happens in the middle of the report the read builds from that
    // answer: after the read has measured its branches and before the snapshot that
    // would carry them is handed over. The reconciliation's first question about
    // the repository is the one that follows that measurement, so the account goes
    // exactly there — the local report is being built, not yet attached.
    let measured = false
    let retiredDuringTheReconciliation = false
    harness.overrideGit({
      match: (args) => args.includes('--no-walk=unsorted'),
      run: (args) => {
        measured = true
        return harness.runGit(['-C', harness.repo, ...args])
      },
    })
    harness.overrideGit({
      match: (args) => measured && args.includes('--git-common-dir'),
      run: (args) => {
        retiredDuringTheReconciliation = true
        retireConfirmedGitHubPayloads()
        return harness.runGit(['-C', harness.repo, ...args])
      },
    })
    await assert.rejects(
      getSnapshot(harness.repo, undefined, undefined, 'live'),
      (error: unknown) => error instanceof CommandCancelled,
    )
    assert.ok(
      retiredDuringTheReconciliation,
      'the reconciliation asked for no ancestry, so the replacement never happened inside the read',
    )

    // And the account that answered is still not in the next read: the refusal was
    // of the snapshot, not of the repository, so the person still gets their local
    // work and simply has to ask again to see GitHub at all.
    const local = await getSnapshot(harness.repo, undefined, undefined, 'reuse')
    assert.deepEqual(local.pullRequests, [], 'the replaced account answered the next read')
    assert.deepEqual(
      local.branches.map((branch) => branch.name).sort(),
      ['feature', 'main', 'origin/main'],
      'the local work did not survive the refusal',
    )
  })
})

test('a local read that loses its account mid-read returns the local work and none of that account', async () => {
  await withHarness(async (harness) => {
    // A branch and a pull request for it, so this repository has a payload worth
    // protecting: private rows, a branch parent read from GitHub, and the
    // reconciliation built from both.
    git(harness, ['checkout', '-b', 'feature', 'main'])
    // A commit of its own, so the branch genuinely diverges and this read really
    // measures it against its base rather than settling it from the tip it shares.
    fs.writeFileSync(join(harness.repo, 'feature.txt'), 'feature\n')
    git(harness, ['add', 'feature.txt'])
    git(harness, [
      '-c',
      'user.name=Feature',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-m',
      'Feature',
    ])
    const head = git(harness, ['rev-parse', 'feature'])
    const state = await harness.readState()
    state.prs = [
      {
        number: 7,
        title: 'Private work',
        body: 'body',
        base: 'main',
        head: 'feature',
        headRepository: `${state.repository.owner}/${state.repository.name}`,
        draft: false,
        state: 'OPEN',
        checks: 'passing',
        reviewDecision: 'APPROVED',
        mergeState: 'CLEAN',
        url: `https://github.com/${`${state.repository.owner}/${state.repository.name}`}/pull/7`,
        headOid: head,
        mergeOid: null,
        mergedAt: null,
        author: state.currentUser,
      },
    ]
    await harness.writeState(state)

    const confirmed = await getSnapshot(harness.repo, undefined, undefined, 'live')
    assert.ok(
      confirmed.pullRequests.some((pullRequest) => pullRequest.number === 7),
      'this run confirmed no payload to protect',
    )
    assert.equal(
      confirmed.branches.find((branch) => branch.name === 'feature')?.pr?.number,
      7,
      'the branch had no pull request to inherit its parent from',
    )

    // The account is replaced while the next read is already past the point where
    // it read that payload: this read measures the branch tips against the graph
    // afterwards, and that is a real Git command it makes.
    let retired = false
    harness.overrideGit({
      match: (args) => args.includes('--no-walk=unsorted'),
      run: () => {
        if (retired) return '0'
        retired = true
        retireConfirmedGitHubPayloads()
        return '0'
      },
    })
    assert.equal(retired, false, 'the account was replaced before the read began')

    const local = await getSnapshot(harness.repo, undefined, undefined, 'reuse')
    assert.equal(retired, true, 'the read finished before its account was replaced')

    // The local work is the whole of what this read returns.
    assert.deepEqual(
      local.branches.map((branch) => branch.name).sort(),
      ['feature', 'main', 'origin/main'],
      'the local branches were lost with the account',
    )
    assert.equal(local.currentBranch !== undefined, true)
    assert.equal(local.name !== undefined, true)

    // And none of the account that has gone is in it: not its pull requests, its
    // issues, the branch parents read from them, or the report built from both.
    assert.deepEqual(local.pullRequests, [], "the replaced account's pull requests were returned")
    assert.deepEqual(local.issues, [], "the replaced account's issues were returned")
    assert.equal(local.github.available, false, 'a stale payload was published as a live answer')
    assert.match(local.github.message, /not been confirmed|unavailable|confirm/iu)
    assert.deepEqual(local.nativeStacks, [])
    assert.equal(local.nativeStackPreviewAvailable, false)
    for (const branch of local.branches) {
      assert.equal(branch.pr, null, `${branch.name} kept the replaced account's pull request`)
      // A parent this branch's own history or recorded configuration can name is
      // local Git and stays; one that could only have come from a pull request is
      // that account's and goes with it.
      assert.ok(
        branch.parentSource !== 'pullRequest' && branch.parentSource !== 'stack',
        `${branch.name} kept a parent named by the replaced account's pull request`,
      )
    }
    assert.equal(
      (local.reconciliation?.stacks ?? []).length,
      0,
      'the reconciliation still describes the replaced account',
    )

    // The replacement that retired the first account's answer has itself been
    // read since, so a second account's payload exists now. The read that follows
    // is the retry the first one became — one that asked GitHub nothing and can
    // therefore no longer re-read itself — and this account is replaced again
    // while that retry is measuring the worktree, after it took the payload.
    const second = await harness.readState()
    second.prs = [
      {
        ...second.prs[0],
        number: 9,
        title: 'Second account work',
        headOid: git(harness, ['rev-parse', 'feature']),
        url: `https://github.com/${`${second.repository.owner}/${second.repository.name}`}/pull/9`,
      },
    ]
    await harness.writeState(second)
    const confirmedSecond = await getSnapshot(harness.repo, undefined, undefined, 'live')
    assert.ok(
      confirmedSecond.pullRequests.some((pullRequest) => pullRequest.number === 9),
      'the second account confirmed no payload for this read to lose',
    )

    let retiredAgain = false
    harness.overrideGit({
      match: (args) => args.includes('--no-walk=unsorted'),
      run: () => {
        if (retiredAgain) return '0'
        retiredAgain = true
        retireConfirmedGitHubPayloads()
        return '0'
      },
    })
    const retried = await getSnapshot(harness.repo, undefined, undefined, 'reuse', true)
    assert.equal(retiredAgain, true, 'the retry finished before its account was replaced')

    // The local work is the whole of what this read returns, assembled from the
    // local graph itself: the branch stacks on the base its own history names,
    // and it is measured against that base rather than left with a number that
    // belonged to a parent the replaced account had named.
    assert.deepEqual(
      retried.branches.map((branch) => branch.name).sort(),
      ['feature', 'main', 'origin/main'],
      'the local work was lost with the second account',
    )
    const feature = retried.branches.find((branch) => branch.name === 'feature')
    assert.equal(feature?.parent, 'main', 'the branch lost the parent its own history names')
    assert.equal(feature?.parentSource, 'inferred')
    assert.equal(feature?.parentBehind, 0, 'the branch was not measured against its local base')

    // And none of the account that has gone is in it.
    assert.deepEqual(
      retried.pullRequests,
      [],
      "the replaced account's pull requests survived in the read that had already re-read itself",
    )
    assert.deepEqual(retried.issues, [], "the replaced account's issues were returned")
    assert.equal(retried.github.available, false, 'a retired payload was published as an answer')
    assert.deepEqual(retried.nativeStacks, [])
    assert.equal(retried.nativeStackPreviewAvailable, false)
    assert.equal((retried.reconciliation?.stacks ?? []).length, 0)
    assert.equal(retried.reconciliation?.evidence ?? null, null)
    for (const branch of retried.branches) {
      assert.equal(branch.pr, null, `${branch.name} kept the replaced account's pull request`)
      assert.ok(
        branch.parentSource !== 'pullRequest' && branch.parentSource !== 'stack',
        `${branch.name} kept a parent named by the replaced account's pull request`,
      )
    }
  })
})

test("a replaced account's late rate limit holds the host without becoming the new account's answer", async () => {
  resetGitHubRateLimit()
  let observed = 0
  setGitHubObservationClock(() => {
    observed += 1
    return observed
  })
  try {
    await withHarness(async (harness) => {
      const state = await harness.readState()
      // The host answers the account being replaced late, and with the refusal it
      // gives everyone: a secondary limit, with the wait it names. Its own budget
      // is not spent, which is what makes it the host's wait rather than A's.
      state.heldResponses = [
        {
          pathIncludes: 'graphql',
          credential: harness.primaryToken,
          ms: 250,
          refusal: {
            status: 429,
            message: 'You have exceeded a secondary rate limit.',
            retryAfterSeconds: 120,
            remaining: 4998,
          },
        },
      ]
      await harness.writeState(state)

      const env = { PATH: harness.env.PATH }
      const retired = new GhGitHubTransport({
        env: { ...env, GH_TOKEN: harness.primaryToken },
        host: 'github.com',
      })
      const current = new GhGitHubTransport({
        env: { ...env, GH_TOKEN: harness.reviewer.token },
        host: 'github.com',
      })
      const currentAuthority = await current.credentialAuthority()

      const refused = assert.rejects(
        retired.graphql<{ viewer: { login: string } }>('{ viewer { login } }'),
        GitHubTransportError,
      )
      // The account that is here reads, and answers, while that refusal is still
      // held: it publishes its own allowance for this host.
      await current.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
      const published = lastGitHubRateLimitFor('github.com')
      await refused
      assert.deepEqual((await harness.readState()).heldResponses, [])

      // What the host said to everyone is not the replaced account's to answer
      // with, and it did not become the allowance the new account published.
      assert.equal(
        lastGitHubRateLimitFor('github.com').authority,
        currentAuthority,
        "the replaced account's late answer became this host's own report",
      )
      assert.deepEqual(
        lastGitHubRateLimitFor('github.com').rateLimit,
        published.rateLimit,
        'the account that is here lost the allowance it published',
      )

      // The wait is the host's and it holds whoever asks next. This is the value
      // the inbox consults before it spends another request on the host.
      const deadline = githubRetryDeadlineFor('github.com')
      assert.ok(
        deadline !== null && deadline - published.at >= 120_000,
        `the host's own wait was dropped: ${String(deadline)}`,
      )

      // And once it has passed, the account that is here is admitted again.
      clearGitHubRetryDeadline('github.com')
      await current.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
      assert.equal(
        lastGitHubRateLimitFor('github.com').authority,
        currentAuthority,
        "the host's wait was still refusing the account that is here",
      )
    })
  } finally {
    setGitHubObservationClock(null)
    resetGitHubRateLimit()
  }
})

test("a replaced account's late answer is not what this host last said", async () => {
  resetGitHubRateLimit()
  // Every observation is stamped with a clock this test advances, so the answer a
  // scope ends up holding is identified by the moment it was seen rather than by
  // how far a real second happened to drift.
  let observed = 0
  setGitHubObservationClock(() => {
    observed += 1
    return observed
  })
  try {
    await withHarness(async (harness) => {
      const state = await harness.readState()
      state.heldResponses = [{ pathIncludes: 'graphql', credential: harness.primaryToken, ms: 250 }]
      await harness.writeState(state)

      const env = { PATH: harness.env.PATH }
      const retired = new GhGitHubTransport({
        env: { ...env, GH_TOKEN: harness.primaryToken },
        host: 'github.com',
      })
      const current = new GhGitHubTransport({
        env: { ...env, GH_TOKEN: harness.reviewer.token },
        host: 'github.com',
      })
      const leavingAuthority = await retired.credentialAuthority()
      const currentAuthority = await current.credentialAuthority()
      assert.notEqual(leavingAuthority, currentAuthority, 'both reads shared one credential')

      // The account being replaced is already reading when the one replacing it
      // reads and answers first.
      const inFlight = retired.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
      await current.graphql<{ viewer: { login: string } }>('{ viewer { login } }')
      await inFlight
      // The host held the answer the leaving credential was waiting for, so it
      // really did land after the one that replaced it.
      assert.deepEqual((await harness.readState()).heldResponses, [])

      for (const [what, report] of [
        ['the host', lastGitHubRateLimitFor('github.com')],
        ["the host's core resource", lastGitHubRateLimitFor('github.com', null, 'core')],
        [
          'the account that is here',
          lastGitHubRateLimitFor('github.com', currentAuthority, 'core'),
        ],
        ['the last observation anyone took', lastGitHubRateLimitFor('github.com')],
      ] as const) {
        assert.equal(
          report.authority,
          currentAuthority,
          `${what} is holding the answer of the credential that has left`,
        )
      }
      assert.equal(
        lastGitHubRateLimitFor('github.com', leavingAuthority).at,
        0,
        'a replaced credential is not recorded as having said anything about this host',
      )
    })
  } finally {
    setGitHubObservationClock(null)
    resetGitHubRateLimit()
  }
})
