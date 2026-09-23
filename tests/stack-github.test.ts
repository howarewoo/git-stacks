import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { getSnapshot, runAction } from '../src/main/git'
import { getPullRequest } from '../src/main/github'
import { previewStack } from '../src/main/stacks'
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
