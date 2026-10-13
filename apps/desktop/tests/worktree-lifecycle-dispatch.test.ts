import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

// Exercise a real Git removal whose callback loses confirmation, not a mocked
// lifecycle result. Install this process boundary before production captures it.
const original = childProcess.execFile
const execute = promisify(original)
let loseRemovalConfirmation = false
childProcess.execFile = Object.assign(
  ((...args: Parameters<typeof original>) =>
    Reflect.apply(original, childProcess, args)) as typeof original,
  {
    [promisify.custom]: async (
      file: string,
      args: string[],
      options: childProcess.ExecFileOptions,
    ) => {
      const result = await execute(file, args, options)
      if (loseRemovalConfirmation && args.includes('worktree') && args.includes('remove')) {
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
    loseRemovalConfirmation = true
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
  }
})
