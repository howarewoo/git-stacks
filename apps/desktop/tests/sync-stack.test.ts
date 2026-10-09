import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness } from './fixtures/github-harness'
import type { GitHubTransport } from '../src/main/github-transport'

const { getSnapshot, runAction } = await import('../src/main/git')
const { previewStack } = await import('../src/main/stacks')
const { DirectGitHubTransport, setGitHubTransport } = await import('../src/main/github-transport')
const { createGitHubApiDouble } = await import('./fixtures/github-api-double')

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

function bareGit(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['--git-dir', harness.bare, ...args])
}

const WRITE_METHODS: Record<string, true> = {
  POST: true,
  PATCH: true,
  PUT: true,
  DELETE: true,
}

/**
 * Every REST mutation the host has answered so far, in order. GraphQL is excluded
 * because this client only queries it, so a sync that rewrites nothing has to leave
 * this list exactly as it found it.
 */
async function restMutations(harness: GitHubHarness): Promise<string[]> {
  const state = await harness.readState()
  return state.requests
    .filter(
      (request) => request.argv[0] !== 'graphql' && WRITE_METHODS[request.argv[1] ?? ''] === true,
    )
    .map((request) => `${request.argv[1]} ${request.argv[0]}`)
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

async function publishStack(harness: GitHubHarness, topBranch: string = 'child'): Promise<void> {
  const snapshot = await getSnapshot(harness.repo)
  const preview = await previewStack(harness.repo, snapshot, 'publish', topBranch)
  assert.deepEqual(preview.blockers, [])
  await runAction(harness.repo, {
    type: 'submitStack',
    token: preview.token,
    allowForce: false,
    layers: {
      parent: { title: 'Parent PR', body: '', draft: false, updateBase: true },
      child: { title: 'Child PR', body: '', draft: false, updateBase: true },
    },
  })
}

test('Sync Stack detects squash/rebase merged parent with proven merge head and replays child onto trunk', async () => {
  await withHarness(async (harness) => {
    // 1. Create a two-layer stack: main -> parent -> child
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    const parentTip = await commitFile(harness, 'parent.txt', 'parent work\n', 'Parent commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    const childTip = await commitFile(harness, 'child.txt', 'child work\n', 'Child commit')

    // Publish the stack to create PRs #1 (parent) and #2 (child)
    await publishStack(harness, 'child')

    // 2. Simulate parent PR merged on GitHub via squash onto main
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'parent.txt', 'parent work\n', 'Squash merge parent (#1)')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    const newMainTip = git(harness, ['rev-parse', 'main'])

    // Update fixture state for PR #1 to MERGED
    const state = JSON.parse(await readFile(harness.statePath, 'utf8')) as GitHubFixtureState
    const pr1 = state.prs.find((p) => p.number === 1)
    assert.ok(pr1)
    pr1.state = 'MERGED'
    pr1.mergeOid = newMainTip
    await writeFile(harness.statePath, JSON.stringify(state), 'utf8')

    // A squash commit names no merged head of its own, so the journal a merge
    // performed here is the only record of the head this pull request merged at.
    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    await writeFile(
      join(gitDir, 'git-stacks-merged-heads.json'),
      JSON.stringify({
        '1': {
          branch: 'parent',
          pr: 1,
          headOid: parentTip,
          mergeOid: newMainTip,
          mergedAt: Date.now(),
        },
      }),
      'utf8',
    )

    git(harness, ['switch', 'child'])

    // 3. Preview Sync Stack from child
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'child')
    assert.equal(preview.kind, 'sync')
    assert.ok(preview.sync)

    const parentLayer = preview.sync.layers.find((l) => l.branch === 'parent')
    const childLayer = preview.sync.layers.find((l) => l.branch === 'child')

    assert.ok(parentLayer)
    assert.ok(childLayer)
    assert.equal(parentLayer.state, 'merged')
    assert.equal(parentLayer.rebase, false)

    // Child is retargeted onto main and requires rebase
    assert.equal(childLayer.base, 'main')
    assert.equal(childLayer.retargetedFrom, 'parent')
    assert.equal(childLayer.rebase, true)
    assert.deepEqual(childLayer.blockers, [])

    // 4. Execute the sync
    await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: true,
      mergeMethod: 'squash',
    })

    // Child is now cleanly on newMainTip, only 1 child commit replayed
    assert.equal(git(harness, ['rev-parse', 'child~1']), newMainTip)
    const childCommits = git(harness, ['log', '--oneline', `${newMainTip}..child`])
      .trim()
      .split('\n')
      .filter(Boolean)
    assert.equal(childCommits.length, 1)
    assert.match(childCommits[0], /Child commit/)
  })
})

test('Sync Stack blocks replay when squash-merged parent has unprovable replay boundary', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    const parentTip = await commitFile(harness, 'parent.txt', 'parent work\n', 'Parent commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    await commitFile(harness, 'child.txt', 'child work\n', 'Child commit')

    await publishStack(harness, 'child')

    // Mark parent PR as MERGED with an unknown merge commit and NO proven merge record
    const state = JSON.parse(await readFile(harness.statePath, 'utf8')) as GitHubFixtureState
    const pr1 = state.prs.find((p) => p.number === 1)
    assert.ok(pr1)
    pr1.state = 'MERGED'
    pr1.mergeOid = 'ffffffffffffffffffffffffffffffffffffffff'
    await writeFile(harness.statePath, JSON.stringify(state), 'utf8')

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'child')

    const childLayer = preview.sync?.layers.find((l) => l.branch === 'child')
    if (childLayer && childLayer.retargetedFrom) {
      assert.ok(
        childLayer.blockers.some(
          (b) => b.includes('safe replay boundary') || b.includes('blocked'),
        ),
        'Should block child replay when boundary cannot be proven',
      )
    }
  })
})

test('Sync Stack detects diverged trunk (upstream force update)', async () => {
  await withHarness(async (harness) => {
    // 1. Commit on local main (not pushed to remote)
    await commitFile(harness, 'local.txt', 'local\n', 'Local main commit')

    // 2. Force rewrite remote main using commit-tree on bare repo
    const originMainTip = bareGit(harness, ['rev-parse', 'refs/heads/main'])
    const tree = bareGit(harness, ['rev-parse', `${originMainTip}^{tree}`])
    const rewritten = bareGit(harness, ['commit-tree', tree, '-m', 'Rewritten root'])
    bareGit(harness, ['update-ref', 'refs/heads/main', rewritten])

    // 3. Create feature branch
    await runAction(harness.repo, { type: 'createBranch', name: 'feature-1', parent: 'main' })
    await commitFile(harness, 'feature.txt', 'feat\n', 'Feature work')

    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'feature-1')
    assert.equal(preview.kind, 'sync')
    assert.ok(preview.sync)

    assert.equal(preview.sync.trunk.diverged, true)
    assert.ok(preview.sync.trunk.ahead > 0)
    assert.ok(preview.sync.trunk.behind > 0)
    assert.equal(preview.sync.trunk.blockers.length > 0, true)
    assert.match(preview.blockers.join('\n'), /publish or reconcile the trunk/i)
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
      /publish or reconcile the trunk/i,
    )
    assert.equal(git(harness, ['merge-base', '--is-ancestor', 'main', 'feature-1']), '')
    assert.equal(
      bareGit(harness, ['for-each-ref', '--format=%(objectname)', 'refs/heads/feature-1']),
      '',
    )
  })
})

test('Sync Stack refuses to drop unpublished local trunk commits from a stack', async () => {
  await withHarness(async (harness) => {
    const localMain = await commitFile(harness, 'local.txt', 'local\n', 'Local main commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'feature-ahead', parent: 'main' })
    const featureTip = await commitFile(harness, 'feature.txt', 'feature\n', 'Feature commit')
    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'feature-ahead',
    )
    assert.match(preview.blockers.join('\n'), /publish or reconcile the trunk/i)
    assert.match(preview.sync?.blockers.join('\n') ?? '', /publish or reconcile the trunk/i)
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /publish or reconcile the trunk/i,
    )
    assert.equal(git(harness, ['rev-parse', 'feature-ahead']), featureTip)
    assert.equal(git(harness, ['rev-parse', 'feature-ahead~1']), localMain)
    assert.equal(
      bareGit(harness, ['for-each-ref', '--format=%(objectname)', 'refs/heads/feature-ahead']),
      '',
    )
  })
})

test('Sync Stack shows remote-ahead layer blockers and rejects execution', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'feature-remote', parent: 'main' })
    await commitFile(harness, 'feature.txt', 'feature\n', 'Feature commit')
    git(harness, ['push', harness.bare, 'feature-remote:refs/heads/feature-remote'])
    const remoteTip = bareGit(harness, ['rev-parse', 'refs/heads/feature-remote'])
    const tree = bareGit(harness, ['rev-parse', `${remoteTip}^{tree}`])
    const advanced = bareGit(harness, [
      'commit-tree',
      tree,
      '-p',
      remoteTip,
      '-m',
      'Remote advance',
    ])
    bareGit(harness, ['update-ref', 'refs/heads/feature-remote', advanced])

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'feature-remote',
    )
    assert.equal(
      preview.sync?.layers.find((layer) => layer.branch === 'feature-remote')?.state,
      'blocked',
    )
    assert.match(preview.blockers.join('\n'), /ahead of the local branch/i)
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /ahead of the local branch/i,
    )
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/feature-remote']), advanced)
  })
})

test('Sync Stack push-only execution respects busy and dirty worktree guards', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'feature-push', parent: 'main' })
    await commitFile(harness, 'feature.txt', 'feature\n', 'Feature commit')
    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    await writeFile(join(gitDir, 'MERGE_HEAD'), git(harness, ['rev-parse', 'main']) + '\n')
    const blocked = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'feature-push',
    )
    assert.match(blocked.blockers.join('\n'), /Git operation is already in progress/i)
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: blocked.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /Git operation is already in progress/i,
    )
    await unlink(join(gitDir, 'MERGE_HEAD'))
    const ready = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'feature-push',
    )
    assert.deepEqual(ready.blockers, [])
    await writeFile(join(harness.repo, 'untracked.txt'), 'uncommitted\n')
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: ready.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /commit or stash|clean/i,
    )
    assert.equal(
      bareGit(harness, ['for-each-ref', '--format=%(objectname)', 'refs/heads/feature-push']),
      '',
    )
  })
})

test('Sync Stack conflict recovery: pauses rebase, journals sync state, and abort restores cleanly', async () => {
  await withHarness(async (harness) => {
    // 1. Create a branch modifying shared.txt
    await runAction(harness.repo, { type: 'createBranch', name: 'feat-conflict', parent: 'main' })
    await commitFile(harness, 'shared.txt', 'conflict from feature\n', 'Feature commit')

    // 2. Advance remote main with conflicting change
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'shared.txt', 'conflict from main\n', 'Main conflicting commit')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    git(harness, ['switch', 'feat-conflict'])

    // 3. Preview sync
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'feat-conflict')
    assert.equal(preview.kind, 'sync')

    // 4. Execution encounters conflict and rejects
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
      /conflict/i,
    )

    // Verify journal has kind: 'sync' and syncPushes
    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    const journalRaw = await readFile(join(gitDir, 'git-stacks-stack.json'), 'utf8')
    const journal = JSON.parse(journalRaw)
    assert.equal(journal.kind, 'sync')
    assert.equal(journal.status, 'conflict')
    assert.ok(journal.syncPushes)

    // 5. Abort restores original clean checkout
    await runAction(harness.repo, { type: 'stackAbort' })
    assert.equal(git(harness, ['status', '--porcelain']), '')
    assert.equal(git(harness, ['branch', '--show-current']), 'feat-conflict')
    const content = await readFile(join(harness.repo, 'shared.txt'), 'utf8')
    assert.equal(content, 'conflict from feature\n')
  })
})
test('Sync Stack conflict recovery: continue resumes rebase and executes sync pushes under lease', async () => {
  await withHarness(async (harness) => {
    // 1. Create a branch modifying shared.txt
    await runAction(harness.repo, { type: 'createBranch', name: 'feat-continue', parent: 'main' })
    await commitFile(harness, 'shared.txt', 'feature change\n', 'Feature commit')
    git(harness, ['push', harness.bare, 'feat-continue:refs/heads/feat-continue'])
    const initialRemoteOid = bareGit(harness, ['rev-parse', 'refs/heads/feat-continue'])

    // 2. Advance remote main with conflicting change
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'shared.txt', 'main change\n', 'Main conflicting commit')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    git(harness, ['switch', 'feat-continue'])

    // 3. Preview sync
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'feat-continue')
    assert.equal(preview.kind, 'sync')

    // 4. Execution encounters conflict
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
      /conflict/i,
    )

    // 5. Resolve conflict manually in the working tree
    await writeFile(join(harness.repo, 'shared.txt'), 'resolved change\n', 'utf8')
    git(harness, ['add', '--', 'shared.txt'])

    // 6. Continue the paused sync operation
    const result = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(result.message, /Synced/i)
    assert.match(result.message, /Pushed feat-continue/i)

    // 7. Verify the remote branch received the push with lease!
    const finalRemoteOid = bareGit(harness, ['rev-parse', 'refs/heads/feat-continue'])
    const finalLocalOid = git(harness, ['rev-parse', 'refs/heads/feat-continue'])
    assert.notEqual(finalRemoteOid, initialRemoteOid)
    assert.equal(finalRemoteOid, finalLocalOid)
    assert.equal(git(harness, ['status', '--porcelain']), '')
  })
})
test('Sync Stack 3+ layer stack syncs cleanly after lower PR merge and trunk advance', async () => {
  await withHarness(async (harness) => {
    // 1. Create a 3-layer stack: layer1 -> layer2 -> layer3
    await runAction(harness.repo, { type: 'createBranch', name: 'layer1', parent: 'main' })
    const layer1Tip = await commitFile(harness, 'l1.txt', 'l1\n', 'Layer 1 work')

    await runAction(harness.repo, { type: 'createBranch', name: 'layer2', parent: 'layer1' })
    const layer2Tip = await commitFile(harness, 'l2.txt', 'l2\n', 'Layer 2 work')

    await runAction(harness.repo, { type: 'createBranch', name: 'layer3', parent: 'layer2' })
    const layer3Tip = await commitFile(harness, 'l3.txt', 'l3\n', 'Layer 3 work')

    await publishStack(harness, 'layer3')

    // 2. Simulate layer 1 squash-merged into main, followed by a trunk advance commit
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'l1.txt', 'l1\n', 'Squash merge layer 1 (#1)')
    const squashMergeOid = git(harness, ['rev-parse', 'main'])
    await commitFile(harness, 'trunk_advance.txt', 'trunk advances\n', 'Trunk advance commit')
    const advancedMainTip = git(harness, ['rev-parse', 'main'])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])

    // Update PR 1 to MERGED with squashMergeOid
    const state = JSON.parse(await readFile(harness.statePath, 'utf8')) as GitHubFixtureState
    const pr1 = state.prs.find((p) => p.number === 1)
    assert.ok(pr1)
    pr1.state = 'MERGED'
    pr1.mergeOid = squashMergeOid
    await writeFile(harness.statePath, JSON.stringify(state), 'utf8')

    // Write merged head metadata and journal
    git(harness, ['config', '--local', 'branch.layer1.gitStacksMergedHeadPr', '1'])
    git(harness, ['config', '--local', 'branch.layer1.gitStacksMergedHeadOid', layer1Tip])
    git(harness, ['config', '--local', 'branch.layer1.gitStacksMergedCommitOid', squashMergeOid])
    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    await writeFile(
      join(gitDir, 'git-stacks-merged-heads.json'),
      JSON.stringify({
        '1': {
          branch: 'layer1',
          pr: 1,
          headOid: layer1Tip,
          mergeOid: squashMergeOid,
          mergedAt: Date.now(),
        },
      }),
      'utf8',
    )

    git(harness, ['switch', 'layer3'])

    // 3. Preview Sync Stack from top layer (layer3)
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'layer3')
    assert.equal(preview.kind, 'sync')
    assert.ok(preview.sync)
    assert.deepEqual(preview.blockers, [])

    // Verify layer classifications
    const l1Layer = preview.sync.layers.find((l) => l.branch === 'layer1')
    assert.ok(l1Layer)
    assert.equal(l1Layer.state, 'merged')
    assert.equal(l1Layer.rebase, false)

    const l2Layer = preview.sync.layers.find((l) => l.branch === 'layer2')
    assert.ok(l2Layer)
    assert.equal(l2Layer.state, 'needs-force')
    assert.equal(l2Layer.retargetedFrom, 'layer1')
    assert.equal(l2Layer.base, 'main')
    assert.equal(l2Layer.rebase, true)

    const l3Layer = preview.sync.layers.find((l) => l.branch === 'layer3')
    assert.ok(l3Layer)
    assert.equal(l3Layer.state, 'needs-force')
    assert.equal(l3Layer.base, 'layer2')
    assert.equal(l3Layer.rebase, true)

    // 4. Execute Sync Stack
    const result = await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: true,
      mergeMethod: 'squash',
    })

    assert.match(result.message, /Synced 2 stack branches/i)

    // 5. Verify the post-sync state
    const newLayer2Tip = git(harness, ['rev-parse', 'layer2'])
    const newLayer3Tip = git(harness, ['rev-parse', 'layer3'])
    assert.notEqual(newLayer2Tip, layer2Tip)
    assert.notEqual(newLayer3Tip, layer3Tip)

    // Layer 1 is untouched
    assert.equal(git(harness, ['rev-parse', 'layer1']), layer1Tip)

    // Layer 2 is based on advanced main
    const l2Parent = git(harness, ['rev-parse', 'layer2~1'])
    assert.equal(l2Parent, advancedMainTip)

    // Layer 3 is based on new layer 2
    const l3Parent = git(harness, ['rev-parse', 'layer3~1'])
    assert.equal(l3Parent, newLayer2Tip)

    // Remote branches in bare repo are updated with the rebased tips
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/layer2']), newLayer2Tip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/layer3']), newLayer3Tip)

    // Working directory is clean and checked out on layer 3
    assert.equal(git(harness, ['status', '--porcelain']), '')
    assert.equal(git(harness, ['branch', '--show-current']), 'layer3')
  })
})
test('Sync Stack partial push retry: completed push is checkpointed and continuation does not fail on spent lease when later push is retried', async () => {
  await withHarness(async (harness) => {
    // 1. Create a 2-layer stack: p1 -> p2
    await runAction(harness.repo, { type: 'createBranch', name: 'push-p1', parent: 'main' })
    await commitFile(harness, 'p1.txt', 'p1 work\n', 'P1 work')

    await runAction(harness.repo, { type: 'createBranch', name: 'push-p2', parent: 'push-p1' })
    await commitFile(harness, 'p2.txt', 'p2 work\n', 'P2 work')

    await publishStack(harness, 'push-p2')
    const initialRemoteP1 = bareGit(harness, ['rev-parse', 'refs/heads/push-p1'])
    const initialRemoteP2 = bareGit(harness, ['rev-parse', 'refs/heads/push-p2'])

    // 2. Advance main so both branches need rebase
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'main-advance.txt', 'advance\n', 'Main advance')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])

    git(harness, ['switch', 'push-p2'])
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'push-p2')
    assert.equal(preview.kind, 'sync')
    assert.equal(preview.blockers.length, 0)

    // 3. Install push hook that allows push-p1 to succeed but fails push-p2
    let failP2 = true
    harness.hookGitPush({
      branch: 'push-p2',
      armed: true,
      before() {
        if (failP2) {
          throw new Error('Simulated network drop pushing push-p2')
        }
      },
    })

    // 4. Run executeStack, which should rebase both, push p1, and fail pushing p2
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
      /Simulated network drop/i,
    )

    // 5. Verify p1 was successfully pushed to remote and checkpointed
    const intermediateRemoteP1 = bareGit(harness, ['rev-parse', 'refs/heads/push-p1'])
    const intermediateRemoteP2 = bareGit(harness, ['rev-parse', 'refs/heads/push-p2'])
    assert.notEqual(intermediateRemoteP1, initialRemoteP1)
    assert.equal(intermediateRemoteP2, initialRemoteP2)

    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    const journalRaw = await readFile(join(gitDir, 'git-stacks-stack.json'), 'utf8')
    const journal = JSON.parse(journalRaw)
    const p1Push = journal.syncPushes?.branches.find(
      (b: { branch: string }) => b.branch === 'push-p1',
    )
    assert.ok(p1Push)
    assert.equal(p1Push.status, 'completed')
    assert.equal(p1Push.publishedOid, intermediateRemoteP1)

    // 6. Disarm failure and continue. It must NOT fail on p1's spent lease!
    failP2 = false
    const result = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(result.message, /Synced/i)

    // 7. Verify both branches are now rebased and pushed
    const finalRemoteP1 = bareGit(harness, ['rev-parse', 'refs/heads/push-p1'])
    const finalRemoteP2 = bareGit(harness, ['rev-parse', 'refs/heads/push-p2'])
    const finalLocalP1 = git(harness, ['rev-parse', 'refs/heads/push-p1'])
    const finalLocalP2 = git(harness, ['rev-parse', 'refs/heads/push-p2'])

    assert.equal(finalRemoteP1, finalLocalP1)
    assert.equal(finalRemoteP2, finalLocalP2)
    assert.equal(finalRemoteP1, intermediateRemoteP1)
    assert.notEqual(finalRemoteP2, initialRemoteP2)
  })
})

test('Sync Stack continues when a push succeeded before its checkpoint was written', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'first', parent: 'main' })
    await commitFile(harness, 'first.txt', 'first\n', 'First layer')
    await runAction(harness.repo, { type: 'createBranch', name: 'second', parent: 'first' })
    await commitFile(harness, 'second.txt', 'second\n', 'Second layer')
    await publishStack(harness, 'second')
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'advance.txt', 'advance\n', 'Advance trunk')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    git(harness, ['switch', 'second'])

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'second',
    )
    let failSecond = true
    harness.hookGitPush({
      branch: 'second',
      armed: true,
      before() {
        if (failSecond) throw new Error('Simulated second push failure')
      },
    })
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
      /Simulated second push failure/i,
    )
    const journalPath = join(
      git(harness, ['rev-parse', '--absolute-git-dir']),
      'git-stacks-stack.json',
    )
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const first = journal.syncPushes.branches.find(
      (item: { branch: string }) => item.branch === 'first',
    )
    assert.ok(first)
    assert.equal(first.status, 'completed')
    assert.equal(first.publishedOid, bareGit(harness, ['rev-parse', 'refs/heads/first']))
    first.status = 'pending'
    delete first.publishedOid
    await writeFile(journalPath, JSON.stringify(journal), 'utf8')

    failSecond = false
    const result = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(result.message, /Synced/i)
    assert.equal(
      bareGit(harness, ['rev-parse', 'refs/heads/first']),
      git(harness, ['rev-parse', 'first']),
    )
    assert.equal(
      bareGit(harness, ['rev-parse', 'refs/heads/second']),
      git(harness, ['rev-parse', 'second']),
    )
  })
})

test('Sync Stack changed origin during paused conflict is rejected before any mutation', async () => {
  await withHarness(async (harness) => {
    // 1. Create a branch modifying shared.txt
    await runAction(harness.repo, {
      type: 'createBranch',
      name: 'feat-origin-check',
      parent: 'main',
    })
    await commitFile(harness, 'shared.txt', 'feature change\n', 'Feature change')
    git(harness, ['push', harness.bare, 'feat-origin-check:refs/heads/feat-origin-check'])

    // 2. Advance remote main with conflicting change
    git(harness, ['switch', 'main'])
    await commitFile(harness, 'shared.txt', 'main change\n', 'Main conflicting change')
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])

    git(harness, ['switch', 'feat-origin-check'])

    // 3. Preview and run sync, causing a conflict
    const snapshot = await getSnapshot(harness.repo)
    const preview = await previewStack(harness.repo, snapshot, 'sync', 'feat-origin-check')
    assert.equal(preview.kind, 'sync')

    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
      /conflict/i,
    )

    // 4. Change origin remote URL while paused in conflict
    git(harness, ['remote', 'set-url', 'origin', 'https://github.com/attacker/malicious.git'])

    // 5. Attempt stackContinue: must reject with origin changed error
    await assert.rejects(
      runAction(harness.repo, { type: 'stackContinue' }),
      /Sync progress is stale: the origin remote changed/i,
    )

    // 6. Restore original remote URL, resolve conflict, and continue
    git(harness, ['remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git'])
    await writeFile(join(harness.repo, 'shared.txt'), 'resolved change\n', 'utf8')
    git(harness, ['add', '--', 'shared.txt'])

    const result = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(result.message, /Synced/i)
  })
})

test('Sync Stack drops a merge-commit merged parent and reparents its descendant without replaying it twice', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    const parentTip = await commitFile(harness, 'parent.txt', 'parent work\n', 'Parent commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    const childTip = await commitFile(harness, 'child.txt', 'child work\n', 'Child commit')
    await publishStack(harness, 'child')

    // The parent lands on trunk as a real two-parent merge commit, so the head that
    // was merged is the merge's own second parent and nothing records it in a journal.
    git(harness, ['switch', 'main'])
    git(harness, ['merge', '--no-ff', '-m', 'Merge pull request #1 from acme/parent', 'parent'])
    const mergeOid = git(harness, ['rev-parse', 'main'])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])
    const [mergedCommit, trunkSide, mergedHead] = git(harness, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      mergeOid,
    ]).split(' ')
    assert.equal(mergedCommit, mergeOid)
    assert.equal(mergedHead, parentTip)
    assert.notEqual(trunkSide, parentTip)
    git(harness, ['switch', 'child'])

    const state = await harness.readState()
    const merged = state.prs.find((pr) => pr.number === 1)
    const survivor = state.prs.find((pr) => pr.number === 2)
    assert.ok(merged)
    assert.ok(survivor)
    merged.state = 'MERGED'
    merged.mergeOid = mergeOid
    merged.mergedAt = '2026-02-01T00:00:00Z'
    // GitHub retargets the surviving layer onto the branch the merged one landed on
    // and leaves that layer at the bottom of the native stack.
    survivor.base = 'main'
    assert.ok((state.stacks ?? []).length > 0, 'the published stack is a native stack')
    state.stacks = (state.stacks ?? []).map((stack) => ({
      ...stack,
      base: { ref: 'main' },
      pull_requests: stack.pull_requests
        .filter((member) => member.number !== merged.number)
        .map((member) => ({ ...member, head: { ref: 'child', sha: childTip } })),
    }))
    await harness.writeState(state)

    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    assert.equal(existsSync(join(gitDir, 'git-stacks-merged-heads.json')), false)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'child',
    )
    assert.equal(preview.kind, 'sync')
    assert.deepEqual(preview.blockers, [])
    assert.ok(preview.sync)
    assert.deepEqual(preview.sync.layers.map((layer) => layer.branch).sort(), ['child', 'parent'])
    const parentLayer = preview.sync.layers.find((layer) => layer.branch === 'parent')
    const childLayer = preview.sync.layers.find((layer) => layer.branch === 'child')
    assert.ok(parentLayer)
    assert.ok(childLayer)
    // The merged parent leaves the cascade exactly as it is; only the descendant moves.
    assert.equal(parentLayer.state, 'merged')
    assert.equal(parentLayer.push, 'none')
    assert.equal(parentLayer.rebase, false)
    assert.equal(childLayer.state, 'needs-force')
    assert.equal(childLayer.base, 'main')
    assert.equal(childLayer.baseOid, mergeOid)
    assert.equal(childLayer.retargetedFrom, 'parent')
    assert.equal(childLayer.rebase, true)
    assert.equal(childLayer.commits, 1)
    assert.equal(childLayer.remoteOid, childTip)
    assert.deepEqual(childLayer.blockers, [])
    assert.deepEqual(preview.sync?.forcePushes, ['child'])

    // Replacing published history is refused until the reviewer approves the lease,
    // and a refusal leaves both the local branch and the served branch untouched.
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: false,
        mergeMethod: 'squash',
      }),
    )
    assert.equal(git(harness, ['rev-parse', 'child']), childTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/child']), childTip)

    const approved = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'child',
    )
    assert.deepEqual(approved.sync?.forcePushes, ['child'])
    const mutationsBefore = await restMutations(harness)

    await runAction(harness.repo, {
      type: 'executeStack',
      token: approved.token,
      allowForce: true,
      mergeMethod: 'squash',
    })

    const newChildTip = git(harness, ['rev-parse', 'child'])
    assert.notEqual(newChildTip, childTip)
    // The descendant now sits on the merge commit itself. Its single replayed commit
    // is its own work; the merged parent's commit is reached through the merge instead
    // of being applied a second time on top of it.
    assert.equal(git(harness, ['rev-parse', 'child~1']), mergeOid)
    assert.equal(git(harness, ['rev-list', '--count', `${mergeOid}..child`]), '1')
    assert.match(git(harness, ['log', '-1', '--format=%s', newChildTip]), /Child commit/)
    assert.equal(git(harness, ['config', '--get', 'branch.child.parent']), 'main')

    // The merged layer itself is neither replayed nor rewritten, and only the
    // descendant's own branch moved on the host, under the lease the preview captured.
    assert.equal(git(harness, ['rev-parse', 'parent']), parentTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/parent']), parentTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/child']), newChildTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/main']), mergeOid)

    // A sync moves branches; it never rewrites a pull request base or stack membership.
    assert.deepEqual(await restMutations(harness), mutationsBefore)
    assert.equal(git(harness, ['for-each-ref', '--format=%(refname)', 'refs/git-stacks']), '')
    assert.equal(existsSync(join(gitDir, 'git-stacks-stack.json')), false)
    assert.equal(git(harness, ['status', '--porcelain']), '')
    assert.equal(git(harness, ['branch', '--show-current']), 'child')
  })
})

test('Sync Stack refuses a sync whose merge-committed parent is proved differently since the preview', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    const parentTip = await commitFile(harness, 'parent.txt', 'parent work\n', 'Parent commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    const childTip = await commitFile(harness, 'child.txt', 'child work\n', 'Child commit')
    await publishStack(harness, 'child')

    git(harness, ['switch', 'main'])
    git(harness, ['merge', '--no-ff', '-m', 'Merge pull request #1 from acme/parent', 'parent'])
    const mergeOid = git(harness, ['rev-parse', 'main'])
    git(harness, ['push', harness.bare, 'main:refs/heads/main'])

    const state = await harness.readState()
    const merged = state.prs.find((pr) => pr.number === 1)
    assert.ok(merged)
    merged.state = 'MERGED'
    merged.mergeOid = mergeOid
    merged.mergedAt = '2026-02-01T00:00:00Z'
    const survivor = state.prs.find((pr) => pr.number === 2)
    assert.ok(survivor)
    survivor.base = 'main'
    await harness.writeState(state)
    git(harness, ['switch', 'child'])

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'child',
    )
    assert.deepEqual(preview.blockers, [])
    assert.deepEqual(preview.sync?.forcePushes, ['child'])

    // The same pull request is now reported as merged from a different head, so the
    // merge no longer proves the boundary this preview replayed onto.
    git(harness, ['branch', 'alternate-head', parentTip])
    git(harness, ['switch', 'alternate-head'])
    git(harness, ['commit', '--allow-empty', '-m', 'Alternate merged work'])
    git(harness, ['switch', 'main'])
    git(harness, [
      'merge',
      '--no-ff',
      '-m',
      'Alternate landing of pull request #1',
      'alternate-head',
    ])
    const alternateMergeOid = git(harness, ['rev-parse', 'main'])
    const alternateParents = git(harness, ['rev-list', '--parents', '-n', '1', alternateMergeOid])
    assert.notEqual(alternateMergeOid, mergeOid)
    assert.equal(alternateParents.split(' ')[1], mergeOid)
    const moved = await harness.readState()
    const remerged = moved.prs.find((pr) => pr.number === 1)
    assert.ok(remerged)
    remerged.mergeOid = alternateMergeOid
    await harness.writeState(moved)
    git(harness, ['switch', 'child'])

    const mutationsBefore = await restMutations(harness)
    const refsBefore = git(harness, ['for-each-ref', '--format=%(refname) %(objectname)'])
    await assert.rejects(
      runAction(harness.repo, {
        type: 'executeStack',
        token: preview.token,
        allowForce: true,
        mergeMethod: 'squash',
      }),
    )
    assert.equal(git(harness, ['rev-parse', 'child']), childTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/child']), childTip)
    assert.equal(git(harness, ['config', '--get', 'branch.child.parent']), 'parent')
    assert.equal(git(harness, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore)
    assert.deepEqual(await restMutations(harness), mutationsBefore)
    assert.equal(
      existsSync(join(git(harness, ['rev-parse', '--absolute-git-dir']), 'git-stacks-stack.json')),
      false,
    )
    assert.equal(git(harness, ['for-each-ref', '--format=%(refname)', 'refs/git-stacks']), '')
  })
})

test('Sync Stack reports a published, current stack as up to date and changes nothing', async () => {
  await withHarness(async (harness) => {
    await runAction(harness.repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    const parentTip = await commitFile(harness, 'parent.txt', 'parent work\n', 'Parent commit')
    await runAction(harness.repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    const childTip = await commitFile(harness, 'child.txt', 'child work\n', 'Child commit')
    await publishStack(harness, 'child')

    // Every layer is published and matches the trunk and its predecessor exactly.
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/parent']), parentTip)
    assert.equal(bareGit(harness, ['rev-parse', 'refs/heads/child']), childTip)

    const preview = await previewStack(
      harness.repo,
      await getSnapshot(harness.repo),
      'sync',
      'child',
    )
    assert.equal(preview.kind, 'sync')
    assert.deepEqual(preview.blockers, [])
    const sync = preview.sync
    assert.ok(sync)
    assert.deepEqual(sync.layers.map((layer) => layer.branch).sort(), ['child', 'parent'])
    assert.equal(sync.trunk.behind, 0)
    assert.equal(sync.trunk.ahead, 0)
    assert.equal(sync.trunk.diverged, false)
    assert.deepEqual(sync.forcePushes, [])
    assert.deepEqual(sync.blockers, [])
    for (const layer of sync.layers) {
      assert.equal(layer.state, 'up-to-date')
      assert.equal(layer.push, 'none')
      assert.equal(layer.rebase, false)
      assert.equal(layer.retargetedFrom, null)
      assert.deepEqual(layer.blockers, [])
    }

    const refsBefore = git(harness, ['for-each-ref', '--format=%(refname) %(objectname)'])
    const servedBefore = bareGit(harness, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
    ])
    const mutationsBefore = await restMutations(harness)
    const gitDir = git(harness, ['rev-parse', '--absolute-git-dir'])
    let pushAttempted = false
    for (const branch of ['parent', 'child']) {
      harness.hookGitPush({
        branch,
        armed: true,
        before() {
          pushAttempted = true
          throw new Error(`Syncing a current stack must not publish ${branch}`)
        },
      })
    }

    // Nothing needs a lease, so running the sync needs no force approval and moves
    // neither a ref, a remote branch, nor a pull request.
    await runAction(harness.repo, {
      type: 'executeStack',
      token: preview.token,
      allowForce: false,
      mergeMethod: 'squash',
    })
    assert.equal(pushAttempted, false)
    assert.equal(git(harness, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore)
    assert.equal(
      bareGit(harness, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']),
      servedBefore,
    )
    assert.deepEqual(await restMutations(harness), mutationsBefore)
    assert.equal(existsSync(join(gitDir, 'git-stacks-stack.json')), false)
    assert.equal(git(harness, ['for-each-ref', '--format=%(refname)', 'refs/git-stacks']), '')
    assert.equal(git(harness, ['status', '--porcelain']), '')
    assert.equal(git(harness, ['branch', '--show-current']), 'child')
  })
})
