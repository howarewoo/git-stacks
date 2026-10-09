import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createGitHubHarness } from './fixtures/github-harness'
import type { GitHubHarness } from './fixtures/github-harness'
import type { SurgeryRequest } from '@git-stacks/shared/types'

// The modules under test resolve the GitHub transport when they load, so they are
// imported after the harness installs its double rather than at the top of the file.
const { getSnapshot, runAction } = await import('../src/main/git')
const { getStackProgress, previewSurgery, runSurgery, validateSurgeryRequest } = await import(
  '../src/main/stacks'
)

test('IPC accepts each surgery request shape and rejects missing kind-specific fields', () => {
  for (const request of [
    { kind: 'insert', branch: 'base', name: 'new-layer' },
    { kind: 'move', branch: 'top', target: 'base' },
    { kind: 'remove', branch: 'middle' },
  ]) {
    assert.deepEqual(validateSurgeryRequest(request), request)
  }
  assert.throws(() => validateSurgeryRequest({ kind: 'insert', branch: 'base' }), /name/)
  assert.throws(() => validateSurgeryRequest({ kind: 'move', branch: 'top' }), /target/)
  assert.throws(() => validateSurgeryRequest({ kind: 'remove' }), /branch/)
})

function git(harness: GitHubHarness, args: string[]): string {
  return harness.runGit(['-C', harness.repo, ...args])
}

function config(harness: GitHubHarness, key: string): string {
  try {
    return git(harness, ['config', '--get', key]).trim()
  } catch {
    return ''
  }
}

function hasRef(harness: GitHubHarness, ref: string): boolean {
  return git(harness, ['for-each-ref', ref]).includes(ref)
}

async function withHarness(run: (harness: GitHubHarness) => Promise<void>): Promise<void> {
  const harness = await createGitHubHarness()
  // These tests exercise a local four-layer stack, so origin is the disposable bare
  // repository: a real fetch, real leases, and no GitHub in the way.
  harness.runGit(['-C', harness.repo, 'remote', 'set-url', 'origin', harness.bare])
  harness.runGit(['-C', harness.repo, 'remote', 'set-url', '--push', 'origin', harness.bare])
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
  await writeFile(join(harness.repo, filePath), contents, 'utf8')
  git(harness, ['add', '--', filePath])
  git(harness, ['commit', '-m', message])
  return git(harness, ['rev-parse', 'HEAD'])
}

/** main -> base -> middle -> top, four local layers with one commit each. */
async function fourLayerStack(harness: GitHubHarness): Promise<Record<string, string>> {
  const tips: Record<string, string> = {}
  let parent = 'main'
  for (const layer of ['base', 'middle', 'top']) {
    await runAction(harness.repo, { type: 'createBranch', name: layer, parent })
    tips[layer] = await commitFile(harness, `${layer}.txt`, `${layer} work\n`, `${layer} commit`)
    parent = layer
  }
  return tips
}

let aboveTip = ''

/** main -> left -> right -> above, where the top layer cannot be replayed onto left. */
async function buildConflictingStack(harness: GitHubHarness): Promise<void> {
  await runAction(harness.repo, { type: 'createBranch', name: 'left', parent: 'main' })
  await commitFile(harness, 'shared.txt', 'left side\n', 'Left edit')
  await runAction(harness.repo, { type: 'createBranch', name: 'right', parent: 'left' })
  await commitFile(harness, 'shared.txt', 'right side\n', 'Right edit')
  await runAction(harness.repo, { type: 'createBranch', name: 'above', parent: 'right' })
  aboveTip = await commitFile(harness, 'shared.txt', 'right side\nthird\n', 'Top edit')
}

async function preview(harness: GitHubHarness, request: SurgeryRequest) {
  const snapshot = await getSnapshot(harness.repo)
  return previewSurgery(harness.repo, snapshot, request)
}

test('insert above a layer replays only the layer that sat above it', async () => {
  await withHarness(async (harness) => {
    const tips = await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])

    const before = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    assert.deepEqual(before.blockers, [])
    assert.deepEqual(before.order, ['base', 'middle', 'helper', 'top'])
    assert.deepEqual(
      before.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['helper', 'insert'],
        ['top', 'rewrite'],
      ],
      'nothing below the new layer is replayed',
    )
    const rewritten = before.layers.find((layer) => layer.branch === 'top')
    assert.equal(rewritten?.fromParent, 'middle')
    assert.equal(rewritten?.toParent, 'helper')

    const result = await runSurgery(harness.repo, before.token, false, false)
    assert.match(result.message, /Applied the reviewed surgery/)

    assert.equal(git(harness, ['rev-parse', 'helper']), tips.middle)
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'helper', 'top']) === '',
      true,
      'the layer above now descends from the inserted layer',
    )
    assert.equal(git(harness, ['rev-list', '--count', 'helper..top']), '1')
    assert.equal(config(harness, 'branch.top.parent'), 'helper')
    assert.equal(config(harness, 'branch.helper.parent'), 'middle')
    assert.equal(config(harness, 'branch.helper.parentTip'), tips.middle)
    assert.equal(git(harness, ['config', 'branch.top.parentTip']), tips.middle)
    assert.equal(git(harness, ['status', '--porcelain']), '')
  })
})

test('insert at the bottom reparents every layer and insert at the top adds one', async () => {
  await withHarness(async (harness) => {
    const tips = await fourLayerStack(harness)
    git(harness, ['switch', 'main'])

    const bottom = await preview(harness, { kind: 'insert', branch: 'main', name: 'pilot' })
    assert.deepEqual(bottom.blockers, [])
    assert.deepEqual(bottom.order, ['pilot', 'base', 'middle', 'top'])
    assert.deepEqual(
      bottom.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['pilot', 'insert'],
        // The layers above the inserted branch keep their commits and their own
        // parents, so only the layer the new branch displaces is part of the plan.
        ['base', 'retarget'],
      ],
    )
    await runSurgery(harness.repo, bottom.token, false, false)
    assert.equal(config(harness, 'branch.base.parent'), 'pilot')
    assert.equal(config(harness, 'branch.middle.parent'), 'base')
    assert.equal(git(harness, ['merge-base', '--is-ancestor', 'base', 'top']) === '', true)
    assert.equal(git(harness, ['rev-list', '--count', 'pilot..top']), '3')

    const top = await preview(harness, { kind: 'insert', branch: 'top', name: 'spike' })
    assert.deepEqual(
      { blockers: top.blockers, order: top.order },
      { blockers: [], order: ['pilot', 'base', 'middle', 'top', 'spike'] },
    )
    assert.deepEqual(
      top.layers.map((layer) => [layer.branch, layer.action]),
      [['spike', 'insert']],
    )
    const topBefore = git(harness, ['rev-parse', 'top']).trim()
    await runSurgery(harness.repo, top.token, false, false)
    const spike = git(harness, ['rev-parse', 'spike']).trim()
    assert.equal(
      spike,
      topBefore,
      `spike ${spike} top ${git(harness, ['rev-parse', 'top']).trim()}`,
    )
    // The recorded boundary of a layer is its parent's tip, not its own.
    assert.equal(config(harness, 'branch.top.parentTip'), tips.middle)
  })
})

test('move down and move up reparent one layer and replay what sits above it', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'top'])

    const down = await preview(harness, { kind: 'move', branch: 'top', target: 'base' })
    assert.deepEqual(down.blockers, [])
    assert.deepEqual(down.order, ['base', 'top', 'middle'])
    assert.deepEqual(
      down.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['top', 'rewrite'],
        ['middle', 'rewrite'],
      ],
    )
    await runSurgery(harness.repo, down.token, false, false)
    assert.equal(config(harness, 'branch.top.parent'), 'base')
    assert.equal(config(harness, 'branch.middle.parent'), 'top')
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'top', 'middle']) === '',
      true,
      'the layer that was above now hangs off the moved layer',
    )
    assert.equal(git(harness, ['merge-base', '--is-ancestor', 'base', 'top']) === '', true)

    const up = await preview(harness, { kind: 'move', branch: 'middle', target: 'base' })
    assert.deepEqual(up.order, ['base', 'middle', 'top'])
    await runSurgery(harness.repo, up.token, false, false)
    assert.equal(config(harness, 'branch.top.parent'), 'middle')
    assert.equal(git(harness, ['merge-base', '--is-ancestor', 'middle', 'top']) === '', true)
  })
})

test('moving a layer up swaps it with the layer above and replays both', async () => {
  await withHarness(async (harness) => {
    const tips = await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])

    const up = await preview(harness, { kind: 'move', branch: 'middle', target: 'top' })
    assert.deepEqual(up.blockers, [])
    assert.deepEqual(up.order, ['base', 'top', 'middle'])
    assert.deepEqual(
      up.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['top', 'rewrite'],
        ['middle', 'rewrite'],
      ],
      'the layer passed drops onto the moved layer parent and is replayed first',
    )

    await runSurgery(harness.repo, up.token, false, false)
    assert.equal(config(harness, 'branch.top.parent'), 'base')
    assert.equal(config(harness, 'branch.middle.parent'), 'top')
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'base', 'top']) === '',
      true,
      'the passed layer no longer contains the moved layer commits',
    )
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'top', 'middle']) === '',
      true,
      'the moved layer sits on top of the layer it passed',
    )
    assert.notEqual(git(harness, ['rev-parse', 'top']), tips.top, 'the passed layer is rewritten')
    assert.equal(git(harness, ['status', '--porcelain']), '')
  })
})

test('a move carries the moved layer subtree so the stack stays one chain', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'top'])

    // Moving the top layer to the trunk takes the whole layer with it, and the two
    // layers it passes keep their own order above it.
    const moved = await preview(harness, { kind: 'move', branch: 'top', target: 'main' })
    assert.deepEqual(moved.blockers, [])
    assert.deepEqual(moved.order, ['top', 'base', 'middle'])
    await runSurgery(harness.repo, moved.token, false, false)
    assert.equal(config(harness, 'branch.top.parent'), 'main')
    assert.equal(config(harness, 'branch.base.parent'), 'top')
    assert.equal(config(harness, 'branch.middle.parent'), 'base')
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'top', 'middle']) === '',
      true,
      'every layer is still one chain from the trunk',
    )
  })
})

test('a repository with no origin plans the local rewrites and says nothing is pushed', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])
    git(harness, ['remote', 'remove', 'origin'])

    const before = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    assert.deepEqual(before.blockers, [], 'an unpublished stack needs no remote')
    assert.match(before.warnings.join(' '), /no origin remote/)
    assert.deepEqual(
      { forcePushes: before.forcePushes, retargets: before.retargets, closes: before.closes },
      { forcePushes: [], retargets: [], closes: [] },
      'nothing is pushed or retargeted without an origin',
    )
    await runSurgery(harness.repo, before.token, false, false)
    assert.equal(config(harness, 'branch.top.parent'), 'helper')
  })
})

test('a move onto the current parent is refused as a no-op', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    const blocked = await preview(harness, { kind: 'move', branch: 'top', target: 'middle' })
    assert.equal(blocked.blockers.length > 0, true)
    assert.match(blocked.blockers.join(' '), /already sits directly on middle/)
  })
})

test('remove deletes the top branch and leaves the layer below untouched', async () => {
  await withHarness(async (harness) => {
    const tips = await fourLayerStack(harness)
    git(harness, ['switch', 'top'])

    const removed = await preview(harness, { kind: 'remove', branch: 'top' })
    assert.deepEqual(removed.blockers, [])
    assert.deepEqual(removed.order, ['base', 'middle'])
    assert.match(removed.layers.find((layer) => layer.branch === 'top')?.note ?? '', /recovery ref/)
    assert.equal(
      removed.layers.some((layer) => layer.branch === 'middle'),
      false,
      'the layer below the removed one is not part of the surgery',
    )

    const result = await runSurgery(harness.repo, removed.token, false, false)
    assert.match(result.message, /Deleted local branch top/)
    assert.equal(hasRef(harness, 'refs/heads/top'), false, 'the branch ref is gone')
    assert.equal(config(harness, 'branch.top.parent'), '', 'its recorded parent is cleared')
    assert.equal(git(harness, ['for-each-ref', 'refs/git-stacks/']), '')
    assert.equal(git(harness, ['rev-parse', 'middle']), tips.middle)
  })
})

test('remove a middle layer replays the layer above it onto the removed parent', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'top'])

    const removed = await preview(harness, { kind: 'remove', branch: 'middle' })
    assert.deepEqual(removed.blockers, [])
    assert.deepEqual(removed.order, ['base', 'top'])
    const moved = removed.layers.find((layer) => layer.branch === 'top')
    assert.equal(moved?.action, 'rewrite')
    assert.equal(moved?.toParent, 'base')

    await runSurgery(harness.repo, removed.token, false, false)
    assert.equal(hasRef(harness, 'refs/heads/middle'), false)
    assert.equal(config(harness, 'branch.top.parent'), 'base')
    assert.equal(git(harness, ['merge-base', '--is-ancestor', 'base', 'top']) === '', true)
  })
})

test('an external change after the preview invalidates the plan before any ref moves', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])
    const before = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    const tipBefore = git(harness, ['rev-parse', 'top'])

    await commitFile(harness, 'outside.txt', 'someone else\n', 'External commit')
    git(harness, ['switch', 'middle'])

    await assert.rejects(() => runSurgery(harness.repo, before.token, false, false), /stale/i)
    assert.equal(git(harness, ['rev-parse', 'top']), tipBefore, 'no ref moved')
    assert.equal(hasRef(harness, 'refs/heads/helper'), false)
    assert.equal(await getStackProgress(harness.repo), null, 'no journal was left behind')
  })
})

test('a preview token cannot be run twice', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])
    const before = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    await runSurgery(harness.repo, before.token, false, false)
    await assert.rejects(
      () => runSurgery(harness.repo, before.token, false, false),
      /expired|missing/i,
    )
  })
})

test('a conflicting replay stops in a journal that abort restores exactly', async () => {
  await withHarness(async (harness) => {
    await buildConflictingStack(harness)
    git(harness, ['switch', 'right'])

    const surgery = await preview(harness, { kind: 'move', branch: 'above', target: 'left' })
    assert.deepEqual(surgery.blockers, [])

    await assert.rejects(() => runSurgery(harness.repo, surgery.token, false, false))
    const progress = await getStackProgress(harness.repo)
    assert.ok(progress, 'an interrupted surgery leaves a journal the banner can read')
    assert.ok((progress?.remaining.length ?? 0) > 0)

    const aborted = await runAction(harness.repo, { type: 'stackAbort' })
    assert.match(aborted.message, /Aborted/)
    assert.equal(git(harness, ['rev-parse', 'above']), aboveTip, 'the layer tip is restored')
    assert.equal(config(harness, 'branch.above.parent'), 'right')
    assert.equal(git(harness, ['for-each-ref', 'refs/git-stacks/']), '')
    assert.equal(await getStackProgress(harness.repo), null)
  })
})

test('an interrupted surgery resumes from its journal without repeating completed work', async () => {
  await withHarness(async (harness) => {
    // main -> base -> middle -> top. Moving top onto base replays top cleanly, then
    // middle onto top, where the two layers both create the same path.
    await runAction(harness.repo, { type: 'createBranch', name: 'base', parent: 'main' })
    await commitFile(harness, 'base.txt', 'base v1\n', 'Base add')
    await runAction(harness.repo, { type: 'createBranch', name: 'middle', parent: 'base' })
    // Both layers create the same path with different contents, so replaying the
    // top layer onto base is clean and replaying the middle layer onto it is not.
    await commitFile(harness, 'shared.txt', 'middle owns this\n', 'Middle add')
    await runAction(harness.repo, { type: 'createBranch', name: 'top', parent: 'middle' })
    // The top layer rewrites the path as an add of its own, so its replay onto base
    // lands cleanly where the middle layer's add of the same path cannot.
    git(harness, ['rm', '--quiet', 'shared.txt'])
    git(harness, ['commit', '-m', 'Top drops the shared path'])
    await commitFile(harness, 'shared.txt', 'top owns this\n', 'Top add')
    git(harness, ['switch', 'middle'])

    const surgery = await preview(harness, { kind: 'move', branch: 'top', target: 'base' })
    assert.deepEqual(surgery.blockers, [])
    assert.deepEqual(
      surgery.layers.map((layer) => [layer.branch, layer.action]),
      [
        ['top', 'rewrite'],
        ['middle', 'rewrite'],
      ],
    )
    const failure = await runSurgery(harness.repo, surgery.token, false, false).then(
      () => null,
      (error: Error) => error,
    )
    assert.ok(failure, 'the recorded conflict stops the cascade')

    const paused = await getStackProgress(harness.repo)
    assert.ok(paused, 'the interrupted surgery is readable from the banner')
    assert.equal(
      config(harness, 'branch.top.parent'),
      'base',
      `the first layer finished (${failure?.message ?? 'no failure'})`,
    )
    assert.equal(paused?.remaining.includes('top') ?? true, false, 'completed work is not repeated')
    assert.equal(paused?.remaining.includes('middle') ?? false, true)

    // Resolve the recorded conflict the way a person does, then Continue.
    await writeFile(join(harness.repo, 'shared.txt'), 'middle owns this\nresolved\n', 'utf8')
    git(harness, ['add', '--', 'shared.txt'])
    const resumed = await runAction(harness.repo, { type: 'stackContinue' })
    assert.match(resumed.message, /Surgery/i)
    assert.equal(config(harness, 'branch.top.parent'), 'base')
    assert.equal(config(harness, 'branch.middle.parent'), 'top')
    assert.equal(
      git(harness, ['merge-base', '--is-ancestor', 'top', 'middle']) === '',
      true,
      'the resumed layer hangs off the one replayed before it',
    )
    assert.equal(await getStackProgress(harness.repo), null, 'the journal is cleared')
  })
})

test('a layer whose replay boundary cannot be proven is blocked rather than guessed', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])
    git(harness, ['config', '--unset', 'branch.top.parentTip'])
    const blocked = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    const top = blocked.layers.find((layer) => layer.branch === 'top')
    assert.equal((top?.blockers.length ?? 0) > 0, true, 'a layer without a boundary blocks')
  })
})

test('an uncommitted working tree blocks the surgery before anything is read', async () => {
  await withHarness(async (harness) => {
    await fourLayerStack(harness)
    git(harness, ['switch', 'middle'])
    await writeFile(join(harness.repo, 'middle.txt'), 'dirty\n', 'utf8')
    const blocked = await preview(harness, { kind: 'insert', branch: 'middle', name: 'helper' })
    assert.match(blocked.blockers.join(' '), /uncommitted changes/i)
  })
})
