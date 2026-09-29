import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness, GitPushHook } from './fixtures/github-harness'
import type { GitHubTransport } from '../src/main/github-transport'

// Git Stacks captures Node's spawn API when its own modules load, and the GitHub
// harness answers `git` and `gh` on that API, so Git Stacks is loaded here.
// Nothing may reach `node:child_process` through an ESM import before the harness
// module body runs: the builtin facade keeps the export it first sees, so a
// static import above would hand Git Stacks the unpatched `execFile`.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getGitHubData, getPullRequest } = await import('../src/main/github')
const { previewStack, recoverStaleBranchLocks } = await import('../src/main/stacks')
const { DirectGitHubTransport, GhGitHubTransport, setGitHubTransport } =
  await import('../src/main/github-transport')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['--git-dir', harness.bare, ...args])
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

test(
  'publish refuses a PR created after a no-PR preview during the push',
  { concurrency: false },
  async () => {
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
      const inner = createGitHubApiDouble()
      const mergeRequests: Array<{ url: string; body: Record<string, unknown> }> = []
      setGitHubTransport(
        new DirectGitHubTransport({
          token: 'fixture-token',
          fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input)
            if (url.endsWith('/merge-async') && init?.method === 'PUT')
              mergeRequests.push({ url, body: JSON.parse(String(init.body)) })
            return inner(input, init)
          }) as typeof globalThis.fetch,
        }),
      )
      await runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      })
      state = await harness.readState()
      const mergedParent = prFor(state, 'parent')
      assert.equal(mergedParent.state, 'MERGED')
      assert.ok(mergedParent.mergeOid)
      assert.equal(mergedParent.mergeOid, remoteOid(harness, 'main'))
      assert.notEqual(mergedParent.mergeOid, headBeforeMerge)
      assert.equal(prFor(state, 'child').state, 'OPEN')
      assert.deepEqual(mergeRequests, [
        {
          url: 'https://api.github.com/repos/acme/widgets/pulls/1/merge-async',
          body: { sha: headBeforeMerge, merge_method: 'squash', merge_action: 'direct_merge' },
        },
      ])
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
  },
)

test(
  'branch lock recovery accepts the literal files ref-storage setting',
  { concurrency: false },
  async () => {
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
  },
)

test(
  'stale branch lock cleanup preserves live locks and removes dead journals',
  { concurrency: false },
  async () => {
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
  },
)

test(
  'branch lock recovery preserves journals for invalid numeric PIDs',
  { concurrency: false },
  async () => {
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
  },
)

test(
  'branch lock recovery preserves journals for mismatched live lock metadata',
  { concurrency: false },
  async () => {
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
      assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).lockPath, victimLock)
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
  'branch lock recovery preserves parseable locks with mismatched transaction metadata',
  { concurrency: false },
  async () => {
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

test(
  'the optional gh adapter serves the same pull request reads without a direct transport',
  { concurrency: false },
  async () => {
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
  },
)
