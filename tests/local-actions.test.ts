import assert from 'node:assert/strict'
import { promises as fs, writeFileSync } from 'node:fs'
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { beginGitRace, runRealGit } from './fixtures/git-race-shim'
import type { GitAction } from '../src/shared/types'

// Git Stacks captures Node's spawn API when its own modules load, and the race
// fixture shims that API, so the Git Stacks modules under test are loaded here.
const { getFileView, getPushPreview, getSnapshot, resolveRepository, runAction } = await import(
  '../src/main/git'
)
// Loaded after the race fixture owns the spawn API, so the queue under test is
// the one the window's own action handler submits Git work through.
const { RepositoryOperations } = await import('../src/main/repository-operations')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-local-actions-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) => runRealGit(repo, args)
  git('init', '-b', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Initial commit')
  return { root, repo, git }
}

async function cleanup(root: string) {
  await rm(root, { recursive: true, force: true })
}

async function withNewerStashAfterIdentityCheck(
  root: string,
  repo: string,
  action: () => Promise<void>,
): Promise<{ inserted: string; newerOid: string }> {
  const inserted = join(root, 'stash-inserted')
  const newerOid = join(root, 'newer-stash-oid')
  // A stash action reads the ref storage format and the displayed stash ref
  // before it touches the stash, so the newer stash lands after that check and
  // before the action applies or drops the object the user selected.
  const race = beginGitRace({
    matches: (args) =>
      (args[0] === 'config' && args[1] === '--get' && args[2] === 'extensions.refstorage') ||
      (args[0] === 'stash' && ['apply', 'pop', 'drop'].includes(args[1] ?? '')),
    inject: () => {
      runRealGit(repo, ['stash', 'push', '--include-untracked', '--message=newer'])
      writeFileSync(newerOid, runRealGit(repo, ['rev-parse', 'refs/stash']))
      writeFileSync(inserted, '')
    },
  })
  try {
    await action()
  } finally {
    race.end()
  }
  return { inserted, newerOid }
}

async function withParentBranchRace(
  root: string,
  repo: string,
  command: 'create' | 'rebase',
  expectedOid: string,
  advancedOid: string,
  action: () => Promise<void>,
): Promise<string> {
  const triggered = join(root, 'parent-race-triggered')
  // Branch creation switches with
  // `switch --no-overwrite-ignore --no-recurse-submodules --create <name> <tip>`
  // and a rebase runs with `-c rebase.updateRefs=false -c
  // rebase.autoStash=false rebase <tip>`, so the parent ref advances after Git
  // Stacks captured the parent it resolved and before the branch moves.
  const race = beginGitRace({
    matches: (args) =>
      command === 'create'
        ? args[0] === 'switch' && args[3] === '--create'
        : args[0] === '-c' && args[4] === 'rebase',
    inject: () => {
      runRealGit(repo, ['update-ref', 'refs/heads/main', advancedOid, expectedOid])
      writeFileSync(triggered, '')
    },
  })
  try {
    await action()
  } finally {
    race.end()
  }
  return triggered
}

async function withConcurrentFileEdit(
  root: string,
  repo: string,
  action: 'discard' | 'resolve',
  content: string,
  run: () => Promise<void>,
): Promise<string> {
  const triggered = join(root, 'file-race-triggered')
  // A discard materializes the indexed content with `--literal-pathspecs
  // restore --worktree -- <path>` and a resolution takes a side with
  // `--literal-pathspecs checkout --ours -- <path>`, so the editor's save lands
  // after Git Stacks fingerprinted the file and before it replaces the content.
  const race = beginGitRace({
    matches: (args) =>
      args[0] === '--literal-pathspecs' &&
      (action === 'discard'
        ? args[1] === 'restore'
        : args[1] === 'checkout' && args[2] === '--ours'),
    inject: () => {
      writeFileSync(join(repo, 'shared.txt'), content)
      writeFileSync(triggered, '')
    },
  })
  try {
    await run()
  } finally {
    race.end()
  }
  return triggered
}

async function withHeadAdvanceBeforeCommand(
  root: string,
  repo: string,
  command: 'commit' | 'merge' | 'cherry-pick' | 'revert',
  ref: string,
  expectedOid: string,
  advancedOid: string,
  run: () => Promise<void>,
): Promise<string> {
  const triggered = join(root, 'head-race-triggered')
  // Every guarded command runs behind the reference-transaction guard as
  // `-c core.hooksPath=<guard> <command> ...`, so the ref advances after Git
  // Stacks captured HEAD and before the command records the new commit.
  const race = beginGitRace({
    matches: (args) => args[0] === '-c' && args[2] === command,
    inject: () => {
      runRealGit(repo, ['update-ref', ref, advancedOid, expectedOid])
      writeFileSync(triggered, '')
    },
  })
  try {
    await run()
  } finally {
    race.end()
  }
  return triggered
}

test('branch creation uses the captured parent when its ref advances before switch', async () => {
  const { root, repo, git } = await fixture()
  try {
    const parentTip = git('rev-parse', 'refs/heads/main')
    const tree = git('rev-parse', `${parentTip}^{tree}`)
    const advancedTip = runRealGit(repo, [
      'commit-tree',
      tree,
      '-p',
      parentTip,
      '-m',
      'Advanced parent',
    ])

    const triggered = await withParentBranchRace(
      root,
      repo,
      'create',
      parentTip,
      advancedTip,
      async () => {
        await runAction(repo, { type: 'createBranch', name: 'feature', parent: 'main' })
      },
    )

    assert.equal(await readFile(triggered, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/main'), advancedTip)
    assert.equal(git('rev-parse', 'refs/heads/feature'), parentTip)
    assert.equal(git('config', '--get', 'branch.feature.parentTip'), parentTip)
  } finally {
    await cleanup(root)
  }
})

test('rebase uses the captured parent when its ref advances before rebase', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'feature')
    await writeFile(join(repo, 'feature.txt'), 'feature\n')
    git('add', '.')
    git('commit', '-m', 'Feature change')
    git('switch', 'main')
    await writeFile(join(repo, 'main.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'Main change')
    const parentTip = git('rev-parse', 'refs/heads/main')
    const tree = git('rev-parse', `${parentTip}^{tree}`)
    const advancedTip = runRealGit(repo, [
      'commit-tree',
      tree,
      '-p',
      parentTip,
      '-m',
      'Advanced parent',
    ])
    git('switch', 'feature')

    const triggered = await withParentBranchRace(
      root,
      repo,
      'rebase',
      parentTip,
      advancedTip,
      async () => {
        await runAction(repo, { type: 'rebase', parent: 'main' })
      },
    )

    assert.equal(await readFile(triggered, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/main'), advancedTip)
    assert.equal(git('rev-parse', 'refs/heads/feature^'), parentTip)
    assert.equal(git('config', '--get', 'branch.feature.parentTip'), parentTip)
  } finally {
    await cleanup(root)
  }
})

test('discard preserves staged content and rejects stale fingerprints', async () => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'staged\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await writeFile(join(repo, 'shared.txt'), 'unstaged\n')
    const view = await getFileView(repo, 'shared.txt')
    await runAction(repo, {
      type: 'discardFile',
      path: 'shared.txt',
      fingerprint: view.fingerprint,
    })
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'staged\n')
    assert.match(git('diff', '--cached', '--', 'shared.txt'), /staged/)

    const stale = await getFileView(repo, 'shared.txt')
    await writeFile(join(repo, 'shared.txt'), 'newer\n')
    await assert.rejects(
      runAction(repo, { type: 'discardFile', path: 'shared.txt', fingerprint: stale.fingerprint }),
    )
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'newer\n')
  } finally {
    await cleanup(root)
  }
})

test('file actions reject traversal and symlink paths', async () => {
  const { root, repo } = await fixture()
  try {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside\n')
    await symlink(outside, join(repo, 'link.txt'))
    await assert.rejects(getFileView(repo, 'link.txt'))
    await assert.rejects(runAction(repo, { type: 'stage', paths: ['../outside.txt'] }))
  } finally {
    await cleanup(root)
  }
})

test('amend requires the captured head and never amends the default branch', async () => {
  const { root, repo, git } = await fixture()
  try {
    const initial = git('rev-parse', 'HEAD')
    git('switch', '-c', 'feature')
    await assert.rejects(
      runAction(repo, {
        type: 'commit',
        message: 'stale amend',
        amend: true,
        expectedHead: initial.slice(0, -1) + (initial.endsWith('0') ? '1' : '0'),
        expectedHeadRef: 'refs/heads/feature',
      }),
    )
    await assert.rejects(
      runAction(repo, {
        type: 'commit',
        message: 'same commit on different branch',
        amend: true,
        expectedHead: initial,
        expectedHeadRef: 'refs/heads/main',
      }),
      /HEAD changed/u,
    )
    await runAction(repo, {
      type: 'commit',
      message: 'amended feature',
      amend: true,
      expectedHead: initial,
      expectedHeadRef: 'refs/heads/feature',
    })
    assert.equal(git('log', '-1', '--format=%s'), 'amended feature')
    git('switch', 'main')
    const mainHead = git('rev-parse', 'HEAD')
    await assert.rejects(
      runAction(repo, {
        type: 'commit',
        message: 'forbidden',
        amend: true,
        expectedHead: mainHead,
        expectedHeadRef: 'refs/heads/main',
      }),
    )
  } finally {
    await cleanup(root)
  }
})

test('merge operation recovery continues through explicit abort and cannot skip merge', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'side')
    await writeFile(join(repo, 'shared.txt'), 'side\n')
    git('add', '.')
    git('commit', '-m', 'side change')
    git('switch', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'main change')
    const mainHead = git('rev-parse', 'HEAD')
    await assert.rejects(
      runAction(repo, {
        type: 'merge',
        ref: 'refs/heads/side',
        expectedHead: mainHead,
        expectedHeadRef: 'refs/heads/main',
      }),
    )
    assert.equal((await getSnapshot(repo)).operation, 'merge')
    await assert.rejects(runAction(repo, { type: 'operationSkip' }))
    const operationHead = resolve(
      repo,
      git('rev-parse', '--git-path', 'git-stacks-expected-operation-head.json'),
    )
    await writeFile(operationHead, 'not JSON')
    await runAction(repo, { type: 'operationAbort' })
    await assert.rejects(readFile(operationHead), /ENOENT/u)

    assert.equal((await getSnapshot(repo)).operation, null)
  } finally {
    await cleanup(root)
  }
})

test('a conflict is staged and continued while the view read it needs is still running', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'side')
    await writeFile(join(repo, 'shared.txt'), 'side\n')
    git('add', '.')
    git('commit', '-m', 'side change')
    git('switch', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'main change')
    const mainHead = git('rev-parse', 'HEAD')
    const sideHead = git('rev-parse', 'refs/heads/side')

    // The queue the window's action handler submits through: a person resolves
    // the conflict the merge left while the view reads that describe it are
    // still being answered, so the stage has to run after them, not be refused.
    const operations = new RepositoryOperations()
    await assert.rejects(
      operations.write(() =>
        runAction(repo, {
          type: 'merge',
          ref: 'refs/heads/side',
          expectedHead: mainHead,
          expectedHeadRef: 'refs/heads/main',
        }),
      ),
    )
    const conflicted = await operations.read(() => getFileView(repo, 'shared.txt'))
    assert.equal(conflicted.conflicted, true)

    // The window asks for the file view again the moment the conflict is
    // resolved, and that read is still being answered when the resolver's
    // stage is submitted. The stage has to run after it, not be refused.
    let reopen!: () => void
    const viewing = new Promise<void>((resolveGate) => {
      reopen = resolveGate
    })
    const reading = operations.read(async () => {
      await viewing
      return getFileView(repo, 'shared.txt')
    })
    const staging = operations.write(() =>
      runAction(repo, {
        type: 'resolveConflict',
        path: 'shared.txt',
        fingerprint: conflicted.fingerprint,
        resolution: { kind: 'content', content: 'side\n' },
      }),
    )
    reopen()
    await staging
    // That read still describes the conflict, which it can only do by finishing
    // before the stage it was submitted ahead of.
    assert.equal((await reading).conflicted, true)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'side\n')

    await operations.write(() => runAction(repo, { type: 'operationContinue' }))
    assert.equal((await getSnapshot(repo)).operation, null)
    assert.equal(git('log', '-1', '--pretty=%P'), `${mainHead} ${sideHead}`)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'side\n')
  } finally {
    await cleanup(root)
  }
})

test('a no-op merge rejects a branch advanced after preflight', async () => {
  const { root, repo, git } = await fixture()
  try {
    const expectedHead = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', `${expectedHead}^{tree}`)
    const advancedHead = runRealGit(repo, [
      'commit-tree',
      tree,
      '-p',
      expectedHead,
      '-m',
      'Advanced during merge',
    ])
    const triggered = await withHeadAdvanceBeforeCommand(
      root,
      repo,
      'merge',
      'refs/heads/main',
      expectedHead,
      advancedHead,
      async () => {
        await assert.rejects(
          runAction(repo, {
            type: 'merge',
            ref: expectedHead,
            expectedHead,
            expectedHeadRef: 'refs/heads/main',
          }),
          /HEAD changed/u,
        )
      },
    )
    assert.equal(await readFile(triggered, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/main'), advancedHead)
  } finally {
    await cleanup(root)
  }
})

test('merge continuation rejects a branch advanced during conflict resolution', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'side')
    await writeFile(join(repo, 'shared.txt'), 'side\n')
    git('add', '.')
    git('commit', '-m', 'side change')
    git('switch', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git('add', '.')
    git('commit', '-m', 'main change')
    const expectedHead = git('rev-parse', 'HEAD')
    await assert.rejects(
      runAction(repo, {
        type: 'merge',
        ref: 'refs/heads/side',
        expectedHead,
        expectedHeadRef: 'refs/heads/main',
      }),
    )
    const tree = git('rev-parse', `${expectedHead}^{tree}`)
    const advancedHead = runRealGit(repo, [
      'commit-tree',
      tree,
      '-p',
      expectedHead,
      '-m',
      'External conflict-time advance',
    ])
    git('update-ref', 'refs/heads/main', advancedHead, expectedHead)

    await assert.rejects(runAction(repo, { type: 'operationContinue' }), /HEAD changed/u)
    assert.equal(git('rev-parse', 'refs/heads/main'), advancedHead)
    assert.equal((await getSnapshot(repo)).operation, 'merge')
  } finally {
    await cleanup(root)
  }
})

test('stash actions require both the displayed ref and captured stash object', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'first\n')
    await runAction(repo, { type: 'stash', message: 'first', includeUntracked: false })
    const first = (await getSnapshot(repo)).stashes[0]
    await writeFile(join(repo, 'shared.txt'), 'second\n')
    await runAction(repo, { type: 'stash', message: 'second', includeUntracked: false })
    await assert.rejects(runAction(repo, { type: 'stashDrop', ref: first.ref, oid: first.oid }))
  } finally {
    await cleanup(root)
  }
})

test('stash pop applies and removes the selected object when a newer stash arrives', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'selected stash\n')
    await runAction(repo, { type: 'stash', message: 'selected', includeUntracked: false })
    const selected = (await getSnapshot(repo)).stashes[0]
    assert.ok(selected)
    await writeFile(join(repo, 'newer.txt'), 'newer stash\n')

    const race = await withNewerStashAfterIdentityCheck(root, repo, async () => {
      await runAction(repo, { type: 'stashPop', ref: selected.ref, oid: selected.oid })
    })
    const newerOid = (await readFile(race.newerOid, 'utf8')).trim()
    const snapshot = await getSnapshot(repo)

    assert.equal(await readFile(race.inserted, 'utf8'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'selected stash\n')
    await assert.rejects(readFile(join(repo, 'newer.txt'), 'utf8'))
    assert.equal(snapshot.stashes.length, 1)
    assert.equal(snapshot.stashes[0].oid, newerOid)
    assert.equal(
      snapshot.stashes.some((stash) => stash.oid === selected.oid),
      false,
    )
  } finally {
    await cleanup(root)
  }
})

test('snapshot completes a stash removal interrupted after reflog replacement', async () => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'first stash\n')
    await runAction(repo, { type: 'stash', message: 'first', includeUntracked: false })
    const first = (await getSnapshot(repo)).stashes[0]
    assert.ok(first)
    await writeFile(join(repo, 'shared.txt'), 'second stash\n')
    await runAction(repo, { type: 'stash', message: 'second', includeUntracked: false })
    const stashes = (await getSnapshot(repo)).stashes
    assert.equal(stashes.length, 2)

    const commonPath = join(repo, git('rev-parse', '--git-common-dir'))
    const refPath = join(commonPath, 'refs', 'stash')
    const logPath = join(commonPath, 'logs', 'refs', 'stash')
    const refLockPath = `${refPath}.lock`
    const logLockPath = `${logPath}.lock`
    const oldRef = await readFile(refPath)
    const oldLog = await readFile(logPath)
    const oldRows = oldLog.toString('utf8').trimEnd().split('\n')
    const nextRef = Buffer.from(`${first.oid}\n`)
    const nextLog = Buffer.from(`${oldRows.slice(0, -1).join('\n')}\n`)
    await writeFile(refLockPath, nextRef, { flag: 'wx' })
    await writeFile(logLockPath, nextLog, { flag: 'wx' })
    const refLockInfo = await lstat(refLockPath)
    const logLockInfo = await lstat(logLockPath)
    await writeFile(
      join(commonPath, 'git-stacks-stash-drop.json'),
      JSON.stringify({
        version: 1,
        changesRef: true,
        oldRef: oldRef.toString('base64'),
        oldLog: oldLog.toString('base64'),
        nextRef: nextRef.toString('base64'),
        nextLog: nextLog.toString('base64'),
        refLock: nextRef.toString('base64'),
        logLock: nextLog.toString('base64'),
        refLockIdentity: { dev: String(refLockInfo.dev), ino: String(refLockInfo.ino) },
        logLockIdentity: { dev: String(logLockInfo.dev), ino: String(logLockInfo.ino) },
      }),
    )
    await rename(logLockPath, logPath)

    const recovered = await getSnapshot(repo)
    assert.deepEqual(
      recovered.stashes.map((stash) => stash.oid),
      [first.oid],
    )
    assert.equal(git('rev-parse', 'refs/stash'), first.oid)
    assert.equal((await getSnapshot(repo)).stashes.length, 1)
  } finally {
    await cleanup(root)
  }
})

test('snapshot completes a packed stash removal interrupted after reflog replacement', async () => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'packed stash\n')
    await runAction(repo, { type: 'stash', message: 'packed', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]
    assert.ok(stash)
    git('pack-refs', '--all', '--prune')

    const commonPath = resolve(repo, git('rev-parse', '--git-common-dir'))
    const refPath = resolve(repo, git('rev-parse', '--git-path', 'refs/stash'))
    const refLockPath = resolve(repo, git('rev-parse', '--git-path', 'refs/stash.lock'))
    const packedRefsPath = resolve(repo, git('rev-parse', '--git-path', 'packed-refs'))
    const packedRefsLockPath = resolve(repo, git('rev-parse', '--git-path', 'packed-refs.lock'))
    const logPath = resolve(repo, git('rev-parse', '--git-path', 'logs/refs/stash'))
    const logLockPath = resolve(repo, git('rev-parse', '--git-path', 'logs/refs/stash.lock'))
    await assert.rejects(readFile(refPath))

    const oldPacked = await readFile(packedRefsPath)
    const packedRows = oldPacked.toString('utf8').split('\n')
    const stashRow = packedRows.findIndex((row) => row.endsWith(' refs/stash'))
    assert.notEqual(stashRow, -1)
    assert.equal(packedRows[stashRow], `${stash.oid} refs/stash`)
    const hasPeeledRow = /^\^[0-9a-f]{40,128}$/iu.test(packedRows[stashRow + 1] ?? '')
    packedRows.splice(stashRow, hasPeeledRow ? 2 : 1)
    const nextPacked = Buffer.from(packedRows.join('\n'), 'utf8')
    const oldLog = await readFile(logPath)
    const nextLog = Buffer.alloc(0)
    const emptyRefLock = Buffer.alloc(0)
    await writeFile(refLockPath, emptyRefLock, { flag: 'wx' })
    await writeFile(packedRefsLockPath, nextPacked, { flag: 'wx' })
    await writeFile(logLockPath, nextLog, { flag: 'wx' })
    const [refLockInfo, packedLockInfo, logLockInfo] = await Promise.all([
      lstat(refLockPath),
      lstat(packedRefsLockPath),
      lstat(logLockPath),
    ])
    const journalPath = join(commonPath, 'git-stacks-stash-drop.json')
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 2,
        changesRef: true,
        changesLooseRef: false,
        changesPackedRefs: true,
        oldRefExists: false,
        oldRef: '',
        oldPacked: oldPacked.toString('base64'),
        oldLog: oldLog.toString('base64'),
        nextRef: null,
        nextPacked: nextPacked.toString('base64'),
        nextLog: nextLog.toString('base64'),
        refLock: emptyRefLock.toString('base64'),
        packedLock: nextPacked.toString('base64'),
        logLock: nextLog.toString('base64'),
        refLockIdentity: { dev: String(refLockInfo.dev), ino: String(refLockInfo.ino) },
        packedLockIdentity: { dev: String(packedLockInfo.dev), ino: String(packedLockInfo.ino) },
        logLockIdentity: { dev: String(logLockInfo.dev), ino: String(logLockInfo.ino) },
      }),
    )
    await rename(logLockPath, logPath)

    const recovered = await getSnapshot(repo)
    assert.deepEqual(recovered.stashes, [])
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/stash'), '')
    assert.equal((await readFile(packedRefsPath, 'utf8')).includes('refs/stash'), false)
    await assert.rejects(readFile(journalPath))
  } finally {
    await cleanup(root)
  }
})

test('snapshot completes a prepared stash drop after an interrupted ref commit', async () => {
  const { root, repo, git } = await fixture()
  const originalRename = fs.rename
  let interrupted = false
  try {
    await writeFile(join(repo, 'shared.txt'), 'recover prepared stash\n')
    await runAction(repo, { type: 'stash', message: 'prepared', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]
    assert.ok(stash)
    const canonicalRepo = await resolveRepository(repo)
    const logPath = resolve(canonicalRepo, git('rev-parse', '--git-path', 'logs/refs/stash'))
    const logLockPath = resolve(
      canonicalRepo,
      git('rev-parse', '--git-path', 'logs/refs/stash.lock'),
    )
    const journalPath = join(
      resolve(canonicalRepo, git('rev-parse', '--git-common-dir')),
      'git-stacks-stash-drop.json',
    )

    fs.rename = async (source, destination) => {
      if (!interrupted && String(source) === logLockPath && String(destination) === logPath) {
        interrupted = true
        throw Object.assign(new Error('simulated ref commit interruption'), { code: 'EIO' })
      }
      return originalRename(source, destination)
    }
    try {
      await assert.rejects(
        runAction(repo, { type: 'stashDrop', ref: stash.ref, oid: stash.oid }),
        /will be recovered on the next repository refresh/u,
      )
    } finally {
      fs.rename = originalRename
    }

    assert.equal(interrupted, true)
    assert.deepEqual((await getSnapshot(repo)).stashes, [])
    await assert.rejects(readFile(journalPath))
  } finally {
    fs.rename = originalRename
    await cleanup(root)
  }
})

test('snapshot recovers locks orphaned during stash lock acquisition', async () => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'recover stash lock\n')
    await runAction(repo, { type: 'stash', message: 'recover lock', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]!
    const commonPath = resolve(repo, git('rev-parse', '--git-common-dir'))
    const refLockPath = resolve(repo, git('rev-parse', '--git-path', 'refs/stash.lock'))
    const journalPath = join(commonPath, 'git-stacks-stash-drop.json')
    const transactionId = '11111111-1111-4111-8111-111111111111'
    const temporaryLockPath = `${refLockPath}.${transactionId}.tmp`
    await writeFile(refLockPath, Buffer.alloc(0), { flag: 'wx' })
    const lockInfo = await lstat(refLockPath)
    await link(refLockPath, temporaryLockPath)
    const journal = (ownerPid: number) =>
      JSON.stringify({
        version: 3,
        phase: 'acquiring',
        transactionId,
        ownerPid,
        refLockIdentity: { dev: String(lockInfo.dev), ino: String(lockInfo.ino) },
        packedLockIdentity: null,
        logLockIdentity: null,
      })
    await writeFile(journalPath, journal(process.pid))

    await assert.rejects(getSnapshot(repo), /Another stash update is in progress/u)
    assert.equal(String((await lstat(refLockPath)).ino), String(lockInfo.ino))

    await writeFile(journalPath, journal(999999999))
    const recovered = await getSnapshot(repo)
    assert.deepEqual(
      recovered.stashes.map((entry) => entry.oid),
      [stash.oid],
    )
    await assert.rejects(readFile(refLockPath))
    await assert.rejects(readFile(temporaryLockPath))
    await assert.rejects(readFile(journalPath))

    await runAction(repo, { type: 'stashDrop', ref: stash.ref, oid: stash.oid })
    assert.deepEqual((await getSnapshot(repo)).stashes, [])
  } finally {
    await cleanup(root)
  }
})

test('stash drop removes the selected object when a newer stash arrives', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'selected stash\n')
    await runAction(repo, { type: 'stash', message: 'selected', includeUntracked: false })
    const selected = (await getSnapshot(repo)).stashes[0]
    assert.ok(selected)
    await writeFile(join(repo, 'newer.txt'), 'newer stash\n')

    const race = await withNewerStashAfterIdentityCheck(root, repo, async () => {
      await runAction(repo, { type: 'stashDrop', ref: selected.ref, oid: selected.oid })
    })
    const newerOid = (await readFile(race.newerOid, 'utf8')).trim()
    const snapshot = await getSnapshot(repo)

    assert.equal(await readFile(race.inserted, 'utf8'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'base\n')
    await assert.rejects(readFile(join(repo, 'newer.txt'), 'utf8'))
    assert.equal(snapshot.stashes.length, 1)
    assert.equal(snapshot.stashes[0].oid, newerOid)
    assert.equal(
      snapshot.stashes.some((stash) => stash.oid === selected.oid),
      false,
    )
  } finally {
    await cleanup(root)
  }
})

test('optional empty stash messages use Git defaults and preserve validation', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'stash me\n')
    await assert.rejects(
      runAction(repo, {
        type: 'stash',
        message: 'bad\0message',
        includeUntracked: false,
      } as unknown as GitAction),
    )
    await assert.rejects(
      runAction(repo, {
        type: 'stash',
        message: 'x'.repeat(256 * 1024 + 1),
        includeUntracked: false,
      }),
    )
    await assert.rejects(
      runAction(repo, {
        type: 'stash',
        message: 42,
        includeUntracked: false,
      } as unknown as GitAction),
    )

    await runAction(repo, { type: 'stash', message: '', includeUntracked: false })
    const snapshot = await getSnapshot(repo)
    assert.deepEqual(snapshot.files, [])
    assert.equal(snapshot.stashes.length, 1)
    await runAction(repo, {
      type: 'stashApply',
      ref: snapshot.stashes[0].ref,
      oid: snapshot.stashes[0].oid,
    })
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'stash me\n')
  } finally {
    await cleanup(root)
  }
})

test('manual conflict resolution accepts UTF-8 content through the file byte limit', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'feature', parent: 'main' })
    await writeFile(join(repo, 'shared.txt'), 'feature change\n')
    git('add', '.')
    git('commit', '-m', 'Feature change')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    await writeFile(join(repo, 'shared.txt'), 'main change\n')
    git('add', '.')
    git('commit', '-m', 'Main change')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/feature' })
    await assert.rejects(runAction(repo, { type: 'rebase', parent: 'main' }))

    const view = await getFileView(repo, 'shared.txt')
    assert.equal(view.conflicted, true)
    const tooLarge = 'é'.repeat(1_100_000)
    await assert.rejects(
      runAction(repo, {
        type: 'resolveConflict',
        path: 'shared.txt',
        fingerprint: view.fingerprint,
        resolution: { kind: 'content', content: tooLarge },
      }),
    )
    assert.equal((await getFileView(repo, 'shared.txt')).fingerprint, view.fingerprint)

    const resolved = 'é'.repeat(400_000)
    await runAction(repo, {
      type: 'resolveConflict',
      path: 'shared.txt',
      fingerprint: view.fingerprint,
      resolution: { kind: 'content', content: resolved },
    })
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), resolved)
    await runAction(repo, { type: 'rebaseAbort' })
    assert.equal((await getSnapshot(repo)).rebaseInProgress, false)
  } finally {
    await cleanup(root)
  }
})

test('discard preserves a file edited after preflight', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'indexed\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await writeFile(join(repo, 'shared.txt'), 'preflight content\n')
    const view = await getFileView(repo, 'shared.txt')
    const triggered = await withConcurrentFileEdit(
      root,
      repo,
      'discard',
      'newer editor save\n',
      async () => {
        await assert.rejects(
          runAction(repo, {
            type: 'discardFile',
            path: 'shared.txt',
            fingerprint: view.fingerprint,
          }),
          /file changed during the action/u,
        )
      },
    )

    assert.equal(await readFile(triggered, 'utf8'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'newer editor save\n')
  } finally {
    await cleanup(root)
  }
})

test('conflict resolution preserves a file edited after preflight', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'feature', parent: 'main' })
    await writeFile(join(repo, 'shared.txt'), 'feature change\n')
    git('add', '.')
    git('commit', '-m', 'Feature change')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    await writeFile(join(repo, 'shared.txt'), 'main change\n')
    git('add', '.')
    git('commit', '-m', 'Main change')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/feature' })
    await assert.rejects(runAction(repo, { type: 'rebase', parent: 'main' }))
    const view = await getFileView(repo, 'shared.txt')

    const triggered = await withConcurrentFileEdit(
      root,
      repo,
      'resolve',
      'newer editor save\n',
      async () => {
        await assert.rejects(
          runAction(repo, {
            type: 'resolveConflict',
            path: 'shared.txt',
            fingerprint: view.fingerprint,
            resolution: { kind: 'choice', choice: 'current' },
          }),
          /file changed during the action/u,
        )
      },
    )

    assert.equal(await readFile(triggered, 'utf8'), '')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'newer editor save\n')
  } finally {
    await cleanup(root)
  }
})

test('file actions reject a parent replaced by a symlink before mutation', async () => {
  const { root, repo, git } = await fixture()
  const canonicalRepo = await resolveRepository(repo)
  const parent = join(canonicalRepo, 'nested')
  const movedParent = join(root, 'nested-moved')
  const filePath = join(parent, 'shared.txt')
  const outside = join(root, 'outside')
  const outsideFile = join(outside, 'shared.txt')
  const originalCopyFile = fs.copyFile
  let swapped = false
  try {
    await mkdir(parent)
    await writeFile(filePath, 'base\n')
    git('add', '.')
    git('commit', '-m', 'Add nested file')
    await writeFile(filePath, 'modified\n')
    await mkdir(outside)
    await link(filePath, outsideFile)
    const view = await getFileView(repo, 'nested/shared.txt')

    fs.copyFile = async (source, destination, mode) => {
      const result = await originalCopyFile(source, destination, mode)
      const destinationPath = String(destination)
      const stagingDirectory = dirname(destinationPath)
      const stagingName = basename(stagingDirectory)
      if (
        !swapped &&
        dirname(stagingDirectory) === parent &&
        stagingName.startsWith('.git-stacks-')
      ) {
        swapped = true
        await rename(parent, movedParent)
        await symlink(outside, parent)
        const outsideStaging = join(outside, stagingName)
        await mkdir(outsideStaging)
        await originalCopyFile(
          join(movedParent, stagingName, 'replacement'),
          join(outsideStaging, 'replacement'),
        )
      }
      return result
    }
    await assert.rejects(
      runAction(repo, {
        type: 'discardFile',
        path: 'nested/shared.txt',
        fingerprint: view.fingerprint,
      }),
      /parent directory changed|Symlink paths are not supported/u,
    )
    assert.equal(swapped, true)

    assert.equal(await readFile(outsideFile, 'utf8'), 'modified\n')
  } finally {
    fs.copyFile = originalCopyFile
    await cleanup(root)
  }
})

test('file actions accept POSIX filenames with backslash dot segments', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Backslash is a path separator on Windows')
    return
  }
  const { root, repo } = await fixture()
  const relativePath = 'literal\\..\\filename.txt'
  const absolutePath = join(repo, relativePath)
  try {
    await writeFile(absolutePath, 'untracked\n')
    const view = await getFileView(repo, relativePath)
    await runAction(repo, {
      type: 'discardFile',
      path: relativePath,
      fingerprint: view.fingerprint,
    })

    await assert.rejects(readFile(absolutePath))
    assert.equal(
      (await getSnapshot(repo)).files.some((file) => file.path === relativePath),
      false,
    )
  } finally {
    await cleanup(root)
  }
})

test('snapshot restores a file quarantined before replacement completed', async () => {
  const { root, repo, git } = await fixture()
  try {
    const transactionId = '22222222-2222-4222-8222-222222222222'
    const stagingName = `.git-stacks-${transactionId}`
    const stagingDirectory = join(repo, stagingName)
    const targetPath = join(repo, 'shared.txt')
    await writeFile(targetPath, 'user data before crash\n')
    await mkdir(stagingDirectory, { mode: 0o700 })
    const replacementPath = join(stagingDirectory, 'replacement')
    await writeFile(replacementPath, 'replacement\n')
    const [rootInfo, stagingInfo, originalInfo, replacementInfo] = await Promise.all([
      lstat(repo),
      lstat(stagingDirectory),
      lstat(targetPath),
      lstat(replacementPath),
    ])
    await rename(targetPath, join(stagingDirectory, 'original'))

    const journalDirectory = join(
      resolve(repo, git('rev-parse', '--git-dir')),
      'git-stacks-file-actions',
    )
    await mkdir(journalDirectory, { mode: 0o700 })
    const journalPath = join(journalDirectory, `${transactionId}.json`)
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 1,
        transactionId,
        ownerPid: 999999999,
        phase: 'prepared',
        repoPath: await resolveRepository(repo),
        relativePath: 'shared.txt',
        stagingName,
        stagingIdentity: { dev: String(stagingInfo.dev), ino: String(stagingInfo.ino) },
        parentDirectories: [
          { relativePath: '', dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
        ],
        originalIdentity: { dev: String(originalInfo.dev), ino: String(originalInfo.ino) },
        replacementIdentity: {
          dev: String(replacementInfo.dev),
          ino: String(replacementInfo.ino),
        },
      }),
    )

    const snapshot = await getSnapshot(repo)
    assert.equal(await readFile(targetPath, 'utf8'), 'user data before crash\n')
    assert.equal(
      snapshot.files.some((file) => file.path === 'shared.txt'),
      true,
    )
    await assert.rejects(readFile(join(stagingDirectory, 'original')))
    await assert.rejects(readFile(replacementPath))
    await assert.rejects(readFile(journalPath))
  } finally {
    await cleanup(root)
  }
})

test('commit, merge, cherry-pick, and revert reject a ref advanced after preflight', async () => {
  for (const command of ['commit', 'merge', 'cherry-pick', 'revert'] as const) {
    const { root, repo, git } = await fixture()
    try {
      let targetOid = ''
      if (command === 'commit') {
        await writeFile(join(repo, 'staged.txt'), 'staged\n')
        git('add', '.')
      } else if (command === 'revert') {
        await writeFile(join(repo, 'revert.txt'), 'revert this\n')
        git('add', '.')
        git('commit', '-m', 'Commit to revert')
        targetOid = git('rev-parse', 'HEAD')
      } else {
        git('switch', '-c', 'side')
        await writeFile(join(repo, 'side.txt'), 'side\n')
        git('add', '.')
        git('commit', '-m', 'Side change')
        targetOid = git('rev-parse', 'HEAD')
        git('switch', 'main')
      }

      const expectedHead = git('rev-parse', 'HEAD')
      const tree = git('rev-parse', `${expectedHead}^{tree}`)
      const advancedHead = runRealGit(repo, [
        'commit-tree',
        tree,
        '-p',
        expectedHead,
        '-m',
        `External ${command} race`,
      ])
      const run = async () => {
        if (command === 'commit') {
          await assert.rejects(
            runAction(repo, {
              type: 'commit',
              message: 'Must not commit on the new head',
              amend: false,
              expectedHead,
              expectedHeadRef: 'refs/heads/main',
            }),
            /HEAD changed/u,
          )
        } else if (command === 'merge') {
          await assert.rejects(
            runAction(repo, {
              type: 'merge',
              ref: 'refs/heads/side',
              expectedHead,
              expectedHeadRef: 'refs/heads/main',
            }),
            /HEAD changed/u,
          )
        } else {
          await assert.rejects(
            runAction(repo, {
              type: command === 'cherry-pick' ? 'cherryPick' : 'revert',
              oid: command === 'cherry-pick' ? targetOid : targetOid,
              expectedHead,
              expectedHeadRef: 'refs/heads/main',
              mainline: null,
            }),
            /HEAD changed/u,
          )
        }
      }
      const triggered = await withHeadAdvanceBeforeCommand(
        root,
        repo,
        command,
        'refs/heads/main',
        expectedHead,
        advancedHead,
        run,
      )

      assert.equal(await readFile(triggered, 'utf8'), '')
      assert.equal(git('rev-parse', 'refs/heads/main'), advancedHead)
    } finally {
      await cleanup(root)
    }
  }
})

test('the HEAD guard preserves configured user hooks', async () => {
  const { root, repo, git } = await fixture()
  try {
    const hooks = join(root, 'custom-hooks')
    const marker = join(root, 'pre-commit-ran')
    const helpers = join(hooks, 'helpers')
    await mkdir(hooks)
    await mkdir(helpers)
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\nset -e\n. "$(dirname "$0")/helpers/common.sh"\n',
      { mode: 0o755 },
    )
    await writeFile(
      join(helpers, 'common.sh'),
      'printf called > "$GIT_STACKS_TEST_HOOK_MARKER"\n',
      { mode: 0o644 },
    )
    await writeFile(join(hooks, 'pre-commit.sample'), '#!/bin/sh\nexit 1\n', { mode: 0o644 })
    git('config', 'core.hooksPath', hooks)
    await writeFile(join(repo, 'staged.txt'), 'staged\n')
    git('add', '.')
    const savedMarker = process.env.GIT_STACKS_TEST_HOOK_MARKER
    process.env.GIT_STACKS_TEST_HOOK_MARKER = marker
    try {
      await runAction(repo, {
        type: 'commit',
        message: 'Run existing hooks',
        amend: false,
        expectedHead: git('rev-parse', 'HEAD'),
        expectedHeadRef: 'refs/heads/main',
      })
    } finally {
      if (savedMarker === undefined) delete process.env.GIT_STACKS_TEST_HOOK_MARKER
      else process.env.GIT_STACKS_TEST_HOOK_MARKER = savedMarker
    }
    assert.equal(await readFile(marker, 'utf8'), 'called')
  } finally {
    await cleanup(root)
  }
})

test('renaming a parent updates every recorded child parent without touching remotes', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    await runAction(repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    await runAction(repo, { type: 'renameBranch', ref: 'refs/heads/parent', name: 'renamed' })
    assert.equal(git('config', '--get', 'branch.child.parent'), 'renamed')
    assert.equal(
      (await getSnapshot(repo)).branches.find((branch) => branch.name === 'child')?.parent,
      'renamed',
    )
  } finally {
    await cleanup(root)
  }
})

test('force push rejects a remote lease race using the exact preview destination', async () => {
  const { root, repo, git } = await fixture()
  try {
    const remote = join(root, 'remote.git')
    const peer = join(root, 'peer')
    runRealGit(root, ['init', '--bare', remote])
    git('remote', 'add', 'origin', remote)
    git('switch', '-c', 'feature')
    git('push', '-u', 'origin', 'feature')
    const preview = await getPushPreview(repo)
    runRealGit(root, ['clone', '-b', 'feature', remote, peer])
    runRealGit(peer, ['config', 'user.name', 'Peer'])
    runRealGit(peer, ['config', 'user.email', 'peer@example.invalid'])
    await writeFile(join(peer, 'peer.txt'), 'peer\n')
    runRealGit(peer, ['add', '.'])
    runRealGit(peer, ['commit', '-m', 'peer'])
    runRealGit(peer, ['push'])
    await assert.rejects(
      runAction(repo, {
        type: 'forcePush',
        preview,
      }),
    )
  } finally {
    await cleanup(root)
  }
})

test('force push publishes the preview OID when the local branch advances after its check', async () => {
  const { root, repo, git } = await fixture()
  try {
    const remote = join(root, 'remote.git')
    runRealGit(root, ['init', '--bare', remote])
    git('remote', 'add', 'origin', remote)
    git('switch', '-c', 'feature')
    git('push', '-u', 'origin', 'feature')
    const preview = await getPushPreview(repo)
    const tree = git('rev-parse', 'HEAD^{tree}')
    const advancedOid = runRealGit(repo, [
      'commit-tree',
      tree,
      '-p',
      preview.localOid,
      '-m',
      'Local branch advanced',
    ])

    const advanced = join(root, 'branch-advanced')
    // The push runs as `-c push.followTags=false push --force-with-lease=...`, so
    // the branch advances after Git Stacks checked the lease and before the push
    // publishes the previewed commit.
    const race = beginGitRace({
      matches: (args) =>
        args[0] === '-c' && args[1] === 'push.followTags=false' && args[2] === 'push',
      inject: () => {
        runRealGit(repo, ['update-ref', 'refs/heads/feature', advancedOid, preview.localOid])
        writeFileSync(advanced, '')
      },
    })
    try {
      await runAction(repo, { type: 'forcePush', preview })
    } finally {
      race.end()
    }

    assert.equal(await readFile(advanced, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/feature'), advancedOid)
    assert.equal(runRealGit(remote, ['rev-parse', 'refs/heads/feature']), preview.localOid)
  } finally {
    await cleanup(root)
  }
})
