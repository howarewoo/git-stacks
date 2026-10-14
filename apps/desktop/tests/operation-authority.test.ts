import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  captureOperation,
  revalidateOperation,
  readOperationRecords,
  runRecordedOperation,
  recordOperationResult,
  validateRecordedRecovery,
  createOperationEffectValidator,
  createOperationProviderValidator,
  unresolvedOperationRecords,
} from '../src/main/operation-authority'
import { previewWorktreeLifecycle, executeWorktreeLifecycle } from '../src/main/worktree-lifecycle'
import { discoverWorktrees } from '../src/main/worktree-inventory'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import { getSnapshot, runAction } from '../src/main/git'
import { previewStack, getStackProgress } from '../src/main/stacks'
import { inspectionAuthority, operationEffectGuard } from '../src/main/inspection-context'
import { runGit, getOriginUrl } from '../src/main/git-core'
import { readMergeObservations } from '../src/main/merge-async'
import { writeJournal } from '../src/main/review-journal'
import { randomUUID } from 'node:crypto'

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Operation fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Operation fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-operation-'))
  const repo = join(root, 'primary')
  const remote = join(root, 'remote.git')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'tracked.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Base')
  git(repo, 'init', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const scope = { repositoryPath: repo, remoteUrl: remote, authority: 'local-fixture' }
  return { root, repo, remote, scope }
}
async function linked(repo: string, directory: string, branch: string) {
  git(repo, 'worktree', 'add', '-b', branch, directory, 'main')
  git(repo, 'push', '-u', 'origin', branch)
  return (await discoverWorktrees(repo)).worktrees.find((tree) => tree.path === directory)!
}

test('captures reject index, same-status content, ref and physical directory drift without changing another checkout', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const directory = join(root, 'selected')
    const tree = await linked(repo, directory, 'feature')
    const inventory = await discoverWorktrees(repo)
    const context = { repositoryId: inventory.identity.id, worktreeId: tree.id, refId: tree.refId! }
    const selectedScope = { ...scope, repositoryPath: directory }
    const primaryHead = git(repo, 'rev-parse', 'HEAD')
    const clean = await captureOperation(directory, context, selectedScope)
    await writeFile(join(directory, 'tracked.txt'), 'first edit\n')
    git(directory, 'add', 'tracked.txt')
    await assert.rejects(revalidateOperation(clean, selectedScope))
    const staged = await captureOperation(directory, context, selectedScope)
    await writeFile(join(directory, 'tracked.txt'), 'second edit\n')
    const dirty = await captureOperation(directory, context, selectedScope)
    await writeFile(join(directory, 'tracked.txt'), 'third edit\n')
    await assert.rejects(revalidateOperation(dirty, selectedScope))
    await assert.rejects(revalidateOperation(staged, selectedScope))
    const beforeRef = await captureOperation(directory, context, selectedScope)
    git(repo, 'branch', 'external', 'main')
    await assert.rejects(revalidateOperation(beforeRef, selectedScope))
    const beforePath = await captureOperation(directory, context, selectedScope)
    const moved = join(root, 'moved')
    await rename(directory, moved)
    await cp(moved, directory, { recursive: true })
    await assert.rejects(revalidateOperation(beforePath, selectedScope))
    assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worktree creation refuses collisions and confirms a real new directory without registering or switching existing checkouts', async () => {
  const { root, repo } = await fixture()
  try {
    const inventory = await discoverWorktrees(repo)
    const main = inventory.refs.find((ref) => ref.name === 'refs/heads/main')!
    const directory = join(root, 'new worktree')
    const preview = await previewWorktreeLifecycle(repo, {
      kind: 'create',
      repositoryId: inventory.identity.id,
      sourceRefId: main.id,
      directory,
      newBranch: 'new-layer',
    })
    assert.deepEqual(preview.blockers, [])
    const result = await executeWorktreeLifecycle(repo, preview.token, true)
    assert.equal(result.targets[0].state, 'completed')
    assert.equal(
      (await discoverWorktrees(repo)).worktrees.find((tree) => tree.id === result.createdWorktreeId)
        ?.path,
      directory,
    )
    assert.equal(git(directory, 'symbolic-ref', 'HEAD'), 'refs/heads/new-layer')
    assert.equal(await readFile(join(directory, 'tracked.txt'), 'utf8'), 'base\n')
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
    const collision = join(root, 'collision')
    const pending = await previewWorktreeLifecycle(repo, {
      kind: 'create',
      repositoryId: inventory.identity.id,
      sourceRefId: main.id,
      directory: collision,
      newBranch: 'not-created',
    })
    await mkdir(collision)
    await writeFile(join(collision, 'external.txt'), 'external owner\n')
    await assert.rejects(executeWorktreeLifecycle(repo, pending.token, true))
    assert.equal(await readFile(join(collision, 'external.txt'), 'utf8'), 'external owner\n')
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/not-created'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup preflights the whole subset and persists actual partial effects while retaining every branch', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const a = await linked(repo, join(root, 'first'), 'first')
    const b = await linked(repo, join(root, 'second'), 'second')
    const c = await linked(repo, join(root, 'third'), 'third')
    const inventory = await discoverWorktrees(repo)
    const request = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [a.id, b.id, c.id],
    }
    await writeFile(join(b.path, 'untracked.txt'), 'keep me\n')
    const blocked = await previewWorktreeLifecycle(repo, request)
    assert.ok(blocked.targets.find((target) => target.worktreeId === b.id)!.blockers.length)
    await assert.rejects(executeWorktreeLifecycle(repo, blocked.token, true))
    assert.equal(
      (await discoverWorktrees(repo)).worktrees.some((tree) => tree.id === a.id),
      true,
    )
    await rm(join(b.path, 'untracked.txt'))
    const preview = await previewWorktreeLifecycle(repo, request)
    assert.deepEqual(preview.blockers, [])
    const primary = inventory.worktrees.find((tree) => tree.path === repo)!
    const capture = await captureOperation(
      repo,
      { repositoryId: inventory.identity.id, worktreeId: primary.id },
      scope,
    )
    let replaced = false
    const result = await runRecordedOperation(
      capture,
      { type: 'executeWorktreeLifecycle', token: preview.token, coordinationConfirmed: true },
      async () => {
        const lifecycle = await executeWorktreeLifecycle(
          repo,
          preview.token,
          true,
          async (progress) => {
            await recordOperationResult({ message: progress.message, worktreeLifecycle: progress })
            if (!replaced && progress.targets[0].state === 'completed') {
              replaced = true
              const moved = join(root, 'second-owned-externally')
              await rename(b.path, moved)
              await cp(moved, b.path, { recursive: true })
            }
          },
        )
        return { message: lifecycle.message, worktreeLifecycle: lifecycle }
      },
    )
    assert.deepEqual(
      result.worktreeLifecycle!.targets.map((target) => target.state),
      ['completed', 'failed', 'not-run'],
    )
    assert.equal(await readFile(join(b.path, 'tracked.txt'), 'utf8'), 'base\n')
    assert.equal(await readFile(join(c.path, 'tracked.txt'), 'utf8'), 'base\n')
    for (const branch of ['first', 'second', 'third'])
      assert.equal(git(repo, 'rev-parse', `refs/heads/${branch}`), git(repo, 'rev-parse', 'main'))
    const records = await readOperationRecords(repo)
    assert.equal(records[0].state, 'failed')
    assert.deepEqual(
      records[0].result!.worktreeLifecycle!.targets.map((target) => target.state),
      ['completed', 'failed', 'not-run'],
    )
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('linked mutation lanes serialize common refs while an independent clone sharing the remote remains usable', async () => {
  const { root, repo } = await fixture()
  try {
    const tree = await linked(repo, join(root, 'linked'), 'feature')
    const clone = join(root, 'independent')
    git(repo, 'clone', '--', repo, clone)
    const common = (await discoverWorktrees(repo)).identity.id
    const independent = (await discoverWorktrees(clone)).identity.id
    assert.notEqual(independent, common)
    const scheduler = new RepositoryScheduler()
    await Promise.all([
      scheduler.bind(repo, common),
      scheduler.bind(tree.path, common),
      scheduler.bind(clone, independent),
    ])
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const first = scheduler.mutate(repo, async () => {
      events.push('first')
      entered.resolve()
      await release.promise
      events.push('released')
    })
    await entered.promise
    const second = scheduler.mutate(tree.path, async () => {
      events.push('second')
      git(tree.path, 'branch', 'after-lane')
    })
    await scheduler.mutate(clone, async () => {
      events.push('independent')
      git(clone, 'branch', 'independent-write')
    })
    assert.deepEqual(events, ['first', 'independent'])
    release.resolve()
    await Promise.all([first, second])
    assert.deepEqual(events, ['first', 'independent', 'released', 'second'])
    assert.equal(git(repo, 'rev-parse', 'after-lane'), git(tree.path, 'rev-parse', 'HEAD'))
    assert.equal(git(clone, 'rev-parse', 'independent-write'), git(clone, 'rev-parse', 'HEAD'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('selected linked restack includes hidden descendants base-first and leaves primary and dirty sibling checkouts untouched', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const base = git(repo, 'rev-parse', 'main')
    git(repo, 'switch', '-c', 'layer-a')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'A')
    const oldA = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'config', 'branch.layer-a.parent', 'main')
    git(repo, 'config', 'branch.layer-a.parentTip', base)
    git(repo, 'switch', '-c', 'layer-b')
    await writeFile(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'B')
    const oldB = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'config', 'branch.layer-b.parent', 'layer-a')
    git(repo, 'config', 'branch.layer-b.parentTip', oldA)
    git(repo, 'switch', 'main')
    await writeFile(join(repo, 'trunk.txt'), 'new trunk\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Advance trunk')
    const primaryHead = git(repo, 'rev-parse', 'HEAD')
    const selected = join(root, 'owning-a')
    git(repo, 'worktree', 'add', selected, 'layer-a')
    const sibling = await linked(repo, join(root, 'dirty-sibling'), 'unrelated')
    await writeFile(join(sibling.path, 'external.txt'), 'external unsent work\n')
    const inventory = await discoverWorktrees(repo)
    const owner = inventory.worktrees.find((tree) => tree.path === selected)!
    const captured = await captureOperation(
      selected,
      { repositoryId: inventory.identity.id, worktreeId: owner.id, refId: owner.refId! },
      { ...scope, repositoryPath: selected },
    )
    const snapshot = await getSnapshot(selected, undefined, undefined, 'reuse', true, true)
    const preview = await previewStack(selected, snapshot, 'restack', 'layer-a')
    assert.deepEqual(preview.blockers, [])
    assert.deepEqual(
      preview.steps.map((step) => step.branch),
      ['layer-a', 'layer-b'],
    )
    await revalidateOperation(captured, captured.scope)
    await runRecordedOperation(
      captured,
      { type: 'executeStack', token: preview.token, allowForce: false, mergeMethod: 'squash' },
      () =>
        runAction(selected, {
          type: 'executeStack',
          token: preview.token,
          allowForce: false,
          mergeMethod: 'squash',
        }),
    )
    const newA = git(repo, 'rev-parse', 'layer-a')
    assert.notEqual(newA, oldA)
    assert.notEqual(git(repo, 'rev-parse', 'layer-b'), oldB)
    git(repo, 'merge-base', '--is-ancestor', primaryHead, 'layer-a')
    git(repo, 'merge-base', '--is-ancestor', 'layer-a', 'layer-b')
    assert.equal(git(repo, 'config', 'branch.layer-b.parentTip'), newA)
    assert.equal(git(selected, 'symbolic-ref', 'HEAD'), 'refs/heads/layer-a')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
    assert.equal(git(sibling.path, 'symbolic-ref', 'HEAD'), 'refs/heads/unrelated')
    assert.equal(
      await readFile(join(sibling.path, 'external.txt'), 'utf8'),
      'external unsent work\n',
    )
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup refuses ignored unpublished data, including contents introduced after approval', async () => {
  const { root, repo } = await fixture()
  try {
    const policy = join(root, 'ignored-policy')
    await writeFile(policy, '.secret\n')
    git(repo, 'config', 'core.excludesFile', policy)
    const tree = await linked(repo, join(root, 'ignored-owner'), 'safe-owner')
    const inventory = await discoverWorktrees(repo)
    const request = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [tree.id],
    }
    const clean = await previewWorktreeLifecycle(repo, request)
    assert.deepEqual(clean.blockers, [])
    await writeFile(join(tree.path, '.secret'), 'unpublished private data\n')
    assert.equal(git(tree.path, 'status', '--porcelain'), '')
    await assert.rejects(
      executeWorktreeLifecycle(repo, clean.token, true),
      /entire selected batch was refused/,
    )
    const blocked = await previewWorktreeLifecycle(repo, request)
    assert.ok(
      blocked.targets[0].blockers.some((reason) => reason.includes('Ignored local contents')),
    )
    await assert.rejects(executeWorktreeLifecycle(repo, blocked.token, true))
    assert.equal(await readFile(join(tree.path, '.secret'), 'utf8'), 'unpublished private data\n')
    assert.equal(git(tree.path, 'symbolic-ref', 'HEAD'), 'refs/heads/safe-owner')
    assert.equal(git(repo, 'rev-parse', 'safe-owner'), git(repo, 'rev-parse', 'main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('owned Skip drops only the conflicted commit, keeps the later commit and resolves the original durable recovery identity', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const base = git(repo, 'rev-parse', 'main')
    git(repo, 'switch', '-c', 'layer')
    await writeFile(join(repo, 'tracked.txt'), 'layer conflict\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'Explicitly skipped conflicting commit')
    await writeFile(join(repo, 'kept.txt'), 'keep this later commit\n')
    git(repo, 'add', 'kept.txt')
    git(repo, 'commit', '-m', 'Retained later commit')
    await writeFile(join(repo, 'tracked.txt'), 'later conflicting layer\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'Resolved remaining conflicting commit')
    git(repo, 'config', 'branch.layer.parent', 'main')
    git(repo, 'config', 'branch.layer.parentTip', base)
    git(repo, 'switch', 'main')
    await writeFile(join(repo, 'tracked.txt'), 'new trunk\n')
    git(repo, 'add', 'tracked.txt')
    git(repo, 'commit', '-m', 'Conflicting trunk advancement')
    const primaryHead = git(repo, 'rev-parse', 'HEAD')
    const directory = join(root, 'owning-layer')
    git(repo, 'worktree', 'add', directory, 'layer')
    const sibling = await linked(repo, join(root, 'dirty-sibling'), 'sibling')
    await writeFile(join(sibling.path, 'unsent.txt'), 'untouched sibling draft\n')
    const inventory = await discoverWorktrees(repo)
    const owner = inventory.worktrees.find((tree) => tree.path === directory)!
    const context = {
      repositoryId: inventory.identity.id,
      worktreeId: owner.id,
      refId: owner.refId!,
    }
    const originalScope = { ...scope, repositoryPath: directory }
    const approval = await captureOperation(directory, context, originalScope)
    const preview = await previewStack(
      directory,
      await getSnapshot(directory, undefined, undefined, 'reuse', true, true),
      'restack',
      'layer',
    )
    const execute = {
      type: 'executeStack' as const,
      token: preview.token,
      allowForce: false,
      mergeMethod: 'squash' as const,
    }
    await assert.rejects(
      runRecordedOperation(approval, execute, () => runAction(directory, execute)),
      /Restack paused on layer/,
    )
    const paused = await getStackProgress(directory)
    assert.ok(paused)
    const original = (await readOperationRecords(repo)).find(
      (record) => record.action.type === 'executeStack',
    )!
    assert.equal(original.state, 'paused')
    assert.equal(original.recovery?.id, paused.operationId)
    const originalJournal = join(
      approval.commonDirectory,
      'git-stacks-operations',
      `${original.id}.json`,
    )
    const originalBytes = await readFile(originalJournal)
    assert.ok((await unresolvedOperationRecords(repo)).some((record) => record.id === original.id))
    const cleanupRequest = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [owner.id],
    }
    const interruptedCleanup = await previewWorktreeLifecycle(repo, cleanupRequest)
    assert.ok(interruptedCleanup.blockers.some((reason) => reason.includes(original.id)))
    const otherPrincipal = await captureOperation(directory, context, {
      ...originalScope,
      authority: 'different-principal',
    })
    await assert.rejects(
      validateRecordedRecovery(otherPrincipal, { type: 'operationSkip' }),
      /Original physical worktree or provider authority/,
    )
    const recovery = await captureOperation(directory, context, originalScope)
    await validateRecordedRecovery(recovery, { type: 'operationSkip' })
    assert.equal(recovery.operationCommitOid, git(directory, 'rev-parse', 'REBASE_HEAD'))
    await assert.rejects(
      runRecordedOperation(recovery, { type: 'operationSkip' }, () =>
        runAction(directory, { type: 'operationSkip' }),
      ),
      /Restack remains paused/,
    )
    assert.equal((await getStackProgress(directory))?.operationId, paused.operationId)
    await assert.rejects(revalidateOperation(recovery, originalScope))
    await writeFile(join(directory, 'tracked.txt'), 'explicit remaining resolution\n')
    git(directory, 'add', 'tracked.txt')
    const continued = await captureOperation(directory, context, originalScope)
    await validateRecordedRecovery(continued, { type: 'stackContinue' })
    await runRecordedOperation(continued, { type: 'stackContinue' }, () =>
      runAction(directory, { type: 'stackContinue' }),
    )
    assert.equal(await getStackProgress(directory), null)
    assert.equal(
      await readFile(join(directory, 'tracked.txt'), 'utf8'),
      'explicit remaining resolution\n',
    )
    assert.equal(await readFile(join(directory, 'kept.txt'), 'utf8'), 'keep this later commit\n')
    assert.equal(
      git(directory, 'log', '--format=%s', `${primaryHead}..layer`),
      'Resolved remaining conflicting commit\nRetained later commit',
    )
    assert.equal(git(directory, 'symbolic-ref', 'HEAD'), 'refs/heads/layer')
    assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(
      await readFile(join(sibling.path, 'unsent.txt'), 'utf8'),
      'untouched sibling draft\n',
    )
    assert.equal(git(repo, 'stash', 'list'), '')
    const records = await readOperationRecords(repo)
    const retained = records.find((record) => record.id === original.id)!
    assert.equal(retained.resolution, 'completed')
    assert.equal(retained.stackProgress, null)
    assert.deepEqual(retained.action, original.action)
    assert.deepEqual(retained.preview, original.preview)
    const skipped = records.find((record) => record.action.type === 'operationSkip')!
    assert.equal(skipped.recovery?.id, paused.operationId)
    assert.equal(
      (await unresolvedOperationRecords(repo)).some((record) => record.id === original.id),
      false,
    )
    assert.deepEqual(await readFile(originalJournal), originalBytes)
    // Publish and prove landing through real disposable Git without changing
    // the primary checkout. Confirmed history must not permanently retain it.
    git(directory, 'push', '-u', 'origin', 'layer')
    git(directory, 'push', 'origin', 'layer:main')
    const recoveredCleanup = await previewWorktreeLifecycle(repo, cleanupRequest)
    assert.deepEqual(recoveredCleanup.blockers, [])
    assert.deepEqual(await readFile(originalJournal), originalBytes)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup refuses an unproven non-main landing instead of borrowing either execution checkout as its default', async () => {
  const { root, repo } = await fixture()
  try {
    const selected = await linked(repo, join(root, 'feature'), 'feature')
    git(repo, 'branch', '-m', 'main', 'trunk')
    git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(repo, 'push', '-u', 'origin', 'trunk')
    const inventory = await discoverWorktrees(repo)
    const request = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [selected.id],
    }
    for (const execution of [repo, selected.path]) {
      const preview = await previewWorktreeLifecycle(execution, request)
      assert.ok(preview.blockers.some((reason) => reason.includes('not proven merged')))
      await assert.rejects(executeWorktreeLifecycle(execution, preview.token, true))
    }
    assert.equal(await readFile(join(selected.path, 'tracked.txt'), 'utf8'), 'base\n')
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/trunk')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup preserves assume-unchanged and materialized skip-worktree bytes and never rewrites their index flags', async () => {
  const { root, repo } = await fixture()
  try {
    const selected = await linked(repo, join(root, 'hidden'), 'hidden')
    const inventory = await discoverWorktrees(repo)
    const request = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [selected.id],
    }
    for (const flag of ['assume-unchanged', 'skip-worktree']) {
      git(selected.path, 'update-index', `--${flag}`, 'tracked.txt')
      await writeFile(join(selected.path, 'tracked.txt'), `private ${flag}\n`)
      const indexBefore = await readFile(join(selected.gitDirectory!, 'index'))
      const preview = await previewWorktreeLifecycle(repo, request)
      assert.ok(
        preview.blockers.some((reason) =>
          reason.includes(
            flag === 'assume-unchanged' ? 'Assume-unchanged' : 'Materialized skip-worktree',
          ),
        ),
      )
      await assert.rejects(executeWorktreeLifecycle(repo, preview.token, true))
      assert.deepEqual(await readFile(join(selected.gitDirectory!, 'index')), indexBefore)
      assert.equal(await readFile(join(selected.path, 'tracked.txt'), 'utf8'), `private ${flag}\n`)
      git(selected.path, 'update-index', `--no-${flag}`, 'tracked.txt')
      await writeFile(join(selected.path, 'tracked.txt'), 'base\n')
    }
    const preview = await previewWorktreeLifecycle(repo, request)
    assert.deepEqual(preview.blockers, [])
    git(selected.path, 'update-index', '--assume-unchanged', 'tracked.txt')
    await writeFile(join(selected.path, 'tracked.txt'), 'late private contents\n')
    await assert.rejects(executeWorktreeLifecycle(repo, preview.token, true))
    assert.equal(
      await readFile(join(selected.path, 'tracked.txt'), 'utf8'),
      'late private contents\n',
    )
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup retains an incarnation-qualified unresolved owner and allows only confirmed terminal history', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const selected = await linked(repo, join(root, 'owner'), 'owner')
    const inventory = await discoverWorktrees(repo)
    const capture = await captureOperation(
      selected.path,
      { repositoryId: inventory.identity.id, worktreeId: selected.id },
      { ...scope, repositoryPath: selected.path },
    )
    const id = randomUUID()
    const record = {
      id,
      repositoryId: capture.repositoryId,
      context: capture.context,
      scope: capture.scope,
      capture,
      worktreePath: selected.path,
      action: {
        type: 'executeNativeOperation',
        token: 'original-resource-preview',
        confirmed: true,
      },
      state: 'unconfirmed',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: 'Original native dispatch retained',
      result: null,
      remoteDispatch: 'intent',
      resolution: 'completed',
    }
    const journal = join(capture.commonDirectory, 'git-stacks-operations', `${id}.json`)
    await writeJournal(journal, 'records', [record])
    const request = {
      kind: 'remove' as const,
      repositoryId: inventory.identity.id,
      worktreeIds: [selected.id],
    }
    const blocked = await previewWorktreeLifecycle(repo, request)
    assert.ok(blocked.blockers.some((reason) => reason.includes(id)))
    await assert.rejects(executeWorktreeLifecycle(repo, blocked.token, true))
    await writeJournal(journal, 'records', [{ ...record, state: 'completed' }])
    const terminal = await previewWorktreeLifecycle(repo, request)
    assert.deepEqual(terminal.blockers, [])
    await writeJournal(journal, 'records', [{ ...record, capture: {} }])
    await assert.rejects(previewWorktreeLifecycle(repo, request))
    await writeJournal(journal, 'records', [{ ...record, state: 'completed' }])
    await writeFile(journal, '{unreadable original intent')
    await assert.rejects(executeWorktreeLifecycle(repo, terminal.token, true))
    assert.equal(await readFile(join(selected.path, 'tracked.txt'), 'utf8'), 'base\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const drift of ['physical owner', 'origin', 'private credential'] as const) {
  test(`combined final Git effect authority refuses ${drift} retirement during evolved target preflight`, async () => {
    const { root, repo, scope } = await fixture()
    try {
      const tree = await linked(repo, join(root, 'selected'), 'selected')
      const inventory = await discoverWorktrees(repo)
      const selectedScope = { ...scope, repositoryPath: tree.path }
      const capture = await captureOperation(
        tree.path,
        { repositoryId: inventory.identity.id, worktreeId: tree.id },
        selectedScope,
      )
      const primaryHead = git(repo, 'rev-parse', 'HEAD')
      const primaryIndex = await readFile(join(repo, '.git', 'index'))
      let credential = 'original-private-authority'
      const validate = createOperationEffectValidator(capture, selectedScope, async () => {
        const currentOrigin = await getOriginUrl(tree.path)
        if (currentOrigin !== scope.remoteUrl || credential !== 'original-private-authority')
          throw new Error('Original origin or private provider authority retired.')
      })
      const authority = {
        root: tree.path,
        context: capture.context,
        signal: new AbortController().signal,
        origin: scope.remoteUrl,
        originUrl: scope.remoteUrl,
        validate,
        validateEffect: validate,
      }
      // Prove later effects use evolved facts, not the original fingerprint:
      // this actual admitted first Git write legitimately changes local config.
      await inspectionAuthority.run(authority, () =>
        runGit(tree.path, ['config', 'gitStacks.approvedStep', 'written']),
      )
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const effect = inspectionAuthority.run(authority, () =>
        operationEffectGuard.run(
          async () => {
            reached.resolve()
            await release.promise
            // An ordinary engine guard can complete successfully while the
            // original owner/provider independently retires.
            assert.equal(git(repo, 'rev-parse', 'selected'), tree.headOid)
          },
          () =>
            runGit(tree.path, [
              '-c',
              'advice.detachedHead=false',
              'config',
              'gitStacks.unapproved',
              'written',
            ]),
        ),
      )
      await reached.promise
      if (drift === 'physical owner') {
        const moved = join(root, 'retained')
        await rename(tree.path, moved)
        await cp(moved, tree.path, { recursive: true })
      } else if (drift === 'origin') {
        git(repo, 'config', 'remote.origin.url', join(root, 'unapproved-origin.git'))
      } else credential = 'replacement-private-authority'
      release.resolve()
      await assert.rejects(effect, /replaced|retired/)
      assert.equal(git(repo, 'config', 'gitStacks.approvedStep'), 'written')
      assert.equal(git(repo, 'config', '--list').includes('gitstacks.unapproved='), false)
      assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
      assert.deepEqual(await readFile(join(repo, '.git', 'index')), primaryIndex)
      assert.equal(git(repo, 'stash', 'list'), '')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('strict merge-history reads distinguish absence from malformed remembered requests without retiring them', async () => {
  const { root, repo } = await fixture()
  try {
    assert.equal((await readMergeObservations(repo, { strict: true })).size, 0)
    const journal = join(repo, '.git', 'git-stacks-merge-queue.json')
    for (const contents of [
      '{truncated',
      JSON.stringify({ '41': { pullRequest: 41, headOid: 'a'.repeat(40) } }),
    ]) {
      await writeFile(journal, contents)
      await assert.rejects(readMergeObservations(repo, { strict: true }))
      assert.equal(await readFile(journal, 'utf8'), contents)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the combined final provider-await fence refuses a rewired Git administrative binding without writing either clone', async () => {
  const { root, repo, remote, scope } = await fixture()
  try {
    const tree = await linked(repo, join(root, 'selected'), 'selected')
    const other = join(root, 'independent-clone')
    git(repo, 'clone', '--no-checkout', remote, other)
    const inventory = await discoverWorktrees(repo)
    const selectedScope = { ...scope, repositoryPath: tree.path }
    const capture = await captureOperation(
      tree.path,
      { repositoryId: inventory.identity.id, worktreeId: tree.id },
      selectedScope,
    )
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let holdProvider = false
    const validate = createOperationEffectValidator(capture, selectedScope, async () => {
      assert.equal(await getOriginUrl(tree.path), scope.remoteUrl)
      if (holdProvider) {
        reached.resolve()
        await release.promise
      }
    })
    const authority = {
      root: tree.path,
      context: capture.context,
      signal: new AbortController().signal,
      origin: scope.remoteUrl,
      originUrl: scope.remoteUrl,
      validate,
      validateEffect: validate,
    }
    await inspectionAuthority.run(authority, () =>
      runGit(tree.path, ['config', 'gitStacks.approvedStep', 'written']),
    )
    const originalIndex = await readFile(join(repo, '.git', 'index'))
    const originalHead = git(repo, 'rev-parse', 'HEAD')
    holdProvider = true
    const effect = inspectionAuthority.run(authority, () =>
      runGit(tree.path, ['config', 'gitStacks.unapproved', 'written']),
    )
    await reached.promise
    const pointer = join(tree.path, '.git')
    const originalPointer = await readFile(pointer)
    await writeFile(pointer, `gitdir: ${join(other, '.git')}\n`)
    release.resolve()
    await assert.rejects(effect, /administrative\/common binding was replaced/)
    assert.equal(git(repo, 'config', '--list').includes('gitstacks.unapproved='), false)
    assert.equal(git(other, 'config', '--list').includes('gitstacks.unapproved='), false)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), originalIndex)
    // Restore only this intentionally corrupted disposable fixture file.
    await writeFile(pointer, originalPointer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production provider callback refuses same-physical origin retirement during the final credential await before a real Git effect', async () => {
  const { root, repo, scope } = await fixture()
  try {
    const tree = await linked(repo, join(root, 'selected'), 'selected')
    const inventory = await discoverWorktrees(repo)
    const selectedScope = { ...scope, repositoryPath: tree.path }
    const capture = await captureOperation(
      tree.path,
      { repositoryId: inventory.identity.id, worktreeId: tree.id },
      selectedScope,
    )
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let holdCredential = false
    const validate = createOperationEffectValidator(
      capture,
      selectedScope,
      createOperationProviderValidator(tree.path, async (origin) => {
        assert.equal(origin, scope.remoteUrl)
        if (holdCredential) {
          reached.resolve()
          await release.promise
        }
        // The private credential remains the original; only effective origin retires.
      }),
    )
    const authority = {
      root: tree.path,
      context: capture.context,
      signal: new AbortController().signal,
      origin: scope.remoteUrl,
      originUrl: scope.remoteUrl,
      validate,
      validateEffect: validate,
    }
    await inspectionAuthority.run(authority, () =>
      runGit(tree.path, ['config', 'gitStacks.approvedStep', 'written']),
    )
    const originalHead = git(repo, 'rev-parse', 'HEAD')
    const originalIndex = await readFile(join(repo, '.git', 'index'))
    const originalStash = git(repo, 'stash', 'list')
    holdCredential = true
    const effect = inspectionAuthority.run(authority, () =>
      runGit(tree.path, ['config', 'gitStacks.unapproved', 'written']),
    )
    await reached.promise
    git(repo, 'remote', 'set-url', 'origin', join(root, 'replacement.git'))
    const changedConfig = await readFile(join(repo, '.git', 'config'))
    release.resolve()
    await assert.rejects(effect, /Effective Git origin\/config changed/)
    assert.deepEqual(await readFile(join(repo, '.git', 'config')), changedConfig)
    assert.equal(git(repo, 'config', '--list').includes('gitstacks.unapproved='), false)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), originalHead)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), originalIndex)
    assert.equal(git(repo, 'stash', 'list'), originalStash)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
