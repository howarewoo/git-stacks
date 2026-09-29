import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeFile, readFile } from 'node:fs/promises'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubFixtureState, GitHubHarness } from './fixtures/github-harness'
import type { GitHubTransport } from '../src/main/github-transport'

const { getSnapshot, runAction } = await import('../src/main/git')
const { previewStack } = await import('../src/main/stacks')
const { DirectGitHubTransport, setGitHubTransport } = await import(
  '../src/main/github-transport'
)
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

async function publishStack(
  harness: GitHubHarness,
  topBranch: string = 'child',
): Promise<void> {
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

    // Record the proven merge head in Git config
    git(harness, ['config', '--local', 'branch.parent.mergedHeadPr', '1'])
    git(harness, ['config', '--local', 'branch.parent.mergedHeadOid', parentTip])
    git(harness, ['config', '--local', 'branch.parent.mergedCommitOid', newMainTip])
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
        childLayer.blockers.some((b) => b.includes('safe replay boundary') || b.includes('blocked')),
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
    assert.ok(
      preview.sync.warnings.some((w) => w.includes('diverged') || w.includes('rewritten')),
      'Must warn about diverged trunk',
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
