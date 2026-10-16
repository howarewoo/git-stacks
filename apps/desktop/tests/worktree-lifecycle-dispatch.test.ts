import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

// Exercise a real Git removal whose callback loses confirmation, not a mocked
// lifecycle result. Install this process boundary before production captures it.
const original = childProcess.execFile
const execute = promisify(original)
let loseRemovalConfirmation: false | 'completed' | 'retained' = false
let interruptionTarget: string | null = null
childProcess.execFile = Object.assign(
  ((...args: Parameters<typeof original>) =>
    Reflect.apply(original, childProcess, args)) as typeof original,
  {
    [promisify.custom]: async (
      file: string,
      args: string[],
      options: childProcess.ExecFileOptions,
    ) => {
      const interruption =
        args.includes('worktree') &&
        args.includes('remove') &&
        (!interruptionTarget || args.at(-1) === interruptionTarget)
          ? loseRemovalConfirmation
          : false
      if (interruption === 'retained') {
        loseRemovalConfirmation = false
        const target = args.at(-1)!
        const external = join(target, 'external-untracked-after-final-fence')
        // A real external-tool race at child dispatch makes real Git refuse
        // removal. Lose that response, then independently remove only this
        // fixture-owned file so fresh facts alone would otherwise permit B.
        await writeFile(external, 'unsent external contents\n')
        let refused = false
        try {
          await execute(file, args, options)
        } catch {
          refused = true
        } finally {
          await rm(external, { force: true })
        }
        assert.equal(refused, true)
        await access(target)
        throw Object.assign(new Error('Fixture lost the real retained-target child response'), {
          code: 'ETIMEDOUT',
        })
      }
      const result = await execute(file, args, options)
      if (interruption === 'completed') {
        loseRemovalConfirmation = false
        throw Object.assign(new Error('Fixture lost the completed child response'), {
          code: 'ETIMEDOUT',
        })
      }
      return result
    },
  },
)
syncBuiltinESMExports()
const { previewWorktreeLifecycle, executeWorktreeLifecycle } = await import(
  '../src/main/worktree-lifecycle'
)
const { discoverWorktrees } = await import('../src/main/worktree-inventory')
const { captureOperation, runRecordedOperation, recordOperationResult, readOperationRecords } =
  await import('../src/main/operation-authority')

function git(root: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    })
    .trim()
}

test('a real removal with a lost child confirmation remains durable unconfirmed and stops the rest of the batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-lifecycle-dispatch-'))
  const repo = join(root, 'primary')
  try {
    await mkdir(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(repo, 'tracked'), 'retained base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Base')
    git(repo, 'init', '--bare', join(root, 'remote.git'))
    git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'))
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    for (const name of ['first', 'second']) {
      git(repo, 'worktree', 'add', '-b', name, join(root, name), 'main')
      git(repo, 'push', '-u', 'origin', name)
    }
    const inventory = await discoverWorktrees(repo)
    const owner = inventory.worktrees.find((tree) => tree.path === repo)!
    const targets = ['first', 'second'].map(
      (name) => inventory.worktrees.find((tree) => tree.path === join(root, name))!,
    )
    const approval = await captureOperation(
      repo,
      { repositoryId: inventory.identity.id, worktreeId: owner.id },
      { repositoryPath: repo, remoteUrl: join(root, 'remote.git'), authority: 'local-fixture' },
    )
    const preview = await previewWorktreeLifecycle(repo, {
      kind: 'remove',
      repositoryId: inventory.identity.id,
      worktreeIds: targets.map((tree) => tree.id),
    })
    assert.deepEqual(preview.blockers, [])
    loseRemovalConfirmation = 'completed'
    const result = await runRecordedOperation(
      approval,
      { type: 'executeWorktreeLifecycle', token: preview.token, coordinationConfirmed: true },
      async () => {
        const lifecycle = await executeWorktreeLifecycle(repo, preview.token, true, (value) =>
          recordOperationResult({ message: value.message, worktreeLifecycle: value }),
        )
        return { message: lifecycle.message, worktreeLifecycle: lifecycle }
      },
    )
    assert.equal(result.worktreeLifecycle!.targets[0].state, 'unconfirmed')
    assert.equal(result.worktreeLifecycle!.targets[1].state, 'not-run')
    await assert.rejects(access(targets[0].path), { code: 'ENOENT' })
    await access(targets[1].path)
    assert.equal(
      git(repo, 'rev-parse', 'refs/heads/first'),
      git(repo, 'rev-parse', 'refs/remotes/origin/first'),
    )
    assert.equal(git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main')
    const records = await readOperationRecords(repo)
    assert.equal(records[0].state, 'unconfirmed')
    assert.equal(records[0].result!.worktreeLifecycle!.targets[0].state, 'unconfirmed')
    await assert.rejects(
      executeWorktreeLifecycle(repo, preview.token, true),
      /expired|another execution/,
    )
  } finally {
    loseRemovalConfirmation = false
    await rm(root, { recursive: true, force: true })
    interruptionTarget = null
  }
})

test('fresh cleanup refuses a still-present uncertain target owned by another worktree but preserves completed and not-run peers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-lifecycle-retained-'))
  const repo = join(root, 'primary')
  try {
    await mkdir(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(repo, 'tracked'), 'retained base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Base')
    const remote = join(root, 'remote.git')
    git(repo, 'init', '--bare', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const names = ['completed', 'uncertain', 'not-run']
    for (const name of names) {
      git(repo, 'worktree', 'add', '-b', name, join(root, name), 'main')
      git(repo, 'push', '-u', 'origin', name)
    }
    const inventory = await discoverWorktrees(repo)
    const owner = inventory.worktrees.find((tree) => tree.path === repo)!
    const targets = names.map(
      (name) => inventory.worktrees.find((tree) => tree.path === join(root, name))!,
    )
    const scope = { repositoryPath: repo, remoteUrl: remote, authority: 'local-fixture' }
    const context = { repositoryId: inventory.identity.id, worktreeId: owner.id }
    const approval = await captureOperation(repo, context, scope)
    const primaryHead = git(repo, 'rev-parse', 'HEAD')
    const primaryIndex = await readFile(join(repo, '.git', 'index'))
    const preview = await previewWorktreeLifecycle(repo, {
      kind: 'remove',
      repositoryId: inventory.identity.id,
      worktreeIds: targets.map((tree) => tree.id),
    })
    assert.deepEqual(preview.blockers, [])
    interruptionTarget = targets[1].path
    loseRemovalConfirmation = 'retained'
    const result = await runRecordedOperation(
      approval,
      { type: 'executeWorktreeLifecycle', token: preview.token, coordinationConfirmed: true },
      async () => {
        const lifecycle = await executeWorktreeLifecycle(repo, preview.token, true, (value) =>
          recordOperationResult({ message: value.message, worktreeLifecycle: value }),
        )
        return { message: lifecycle.message, worktreeLifecycle: lifecycle }
      },
    )
    assert.deepEqual(
      result.worktreeLifecycle!.targets.map((target) => target.state),
      ['completed', 'unconfirmed', 'not-run'],
    )
    await assert.rejects(access(targets[0].path), { code: 'ENOENT' })
    await access(targets[1].path)
    await access(targets[2].path)
    const original = (await readOperationRecords(repo))[0]
    assert.equal(original.context.worktreeId, owner.id)
    assert.notEqual(original.context.worktreeId, targets[1].id)
    const journal = join(approval.commonDirectory, 'git-stacks-operations', `${original.id}.json`)
    const originalBytes = await readFile(journal)
    const freshCapture = await captureOperation(repo, context, scope)
    const fresh = await previewWorktreeLifecycle(repo, {
      kind: 'remove',
      repositoryId: inventory.identity.id,
      worktreeIds: [targets[1].id, targets[2].id],
    })
    assert.ok(fresh.targets[0].blockers.some((reason) => reason.includes(original.id)))
    assert.deepEqual(fresh.targets[1].blockers, [])
    await assert.rejects(
      runRecordedOperation(
        freshCapture,
        { type: 'executeWorktreeLifecycle', token: fresh.token, coordinationConfirmed: true },
        async () => {
          const lifecycle = await executeWorktreeLifecycle(repo, fresh.token, true)
          return { message: lifecycle.message, worktreeLifecycle: lifecycle }
        },
      ),
      /entire selected batch was refused/,
    )
    await access(targets[1].path)
    await access(targets[2].path)
    assert.deepEqual(await readFile(journal), originalBytes)
    // Confirmed earlier targets may be recreated independently and are not
    // permanently protected merely because another original peer is unknown.
    git(repo, 'worktree', 'add', targets[0].path, names[0])
    const recreated = (await discoverWorktrees(repo)).worktrees.find(
      (tree) => tree.path === targets[0].path,
    )!
    const knownPeers = await previewWorktreeLifecycle(repo, {
      kind: 'remove',
      repositoryId: inventory.identity.id,
      worktreeIds: [recreated.id, targets[2].id],
    })
    assert.deepEqual(knownPeers.blockers, [])
    // Deliberate legacy/truncation fault: retain unknown target authority,
    // fail closed for that path, and never repair journal bytes on inspection.
    const incomplete = JSON.parse(originalBytes.toString())
    delete incomplete.records[0].preview.targets[1].authority
    const incompleteBytes = Buffer.from(JSON.stringify(incomplete))
    await writeFile(journal, incompleteBytes)
    const unknown = await previewWorktreeLifecycle(repo, {
      kind: 'remove',
      repositoryId: inventory.identity.id,
      worktreeIds: [targets[1].id],
    })
    assert.ok(unknown.blockers.some((reason) => reason.includes('unknown original physical')))
    assert.deepEqual(await readFile(journal), incompleteBytes)
    await writeFile(journal, originalBytes)
    for (const name of names)
      assert.equal(
        git(repo, 'rev-parse', `refs/heads/${name}`),
        git(repo, 'rev-parse', `refs/remotes/origin/${name}`),
      )
    assert.equal(git(repo, 'rev-parse', 'HEAD'), primaryHead)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), primaryIndex)
    assert.equal(git(repo, 'stash', 'list'), '')
  } finally {
    loseRemovalConfirmation = false
    interruptionTarget = null
    await rm(root, { recursive: true, force: true })
  }
})
