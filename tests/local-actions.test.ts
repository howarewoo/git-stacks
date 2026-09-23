import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { getFileView, getPushPreview, getSnapshot, runAction } from '../src/main/git'
import type { GitAction } from '../src/shared/types'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-local-actions-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
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
  const shimDir = join(root, 'git-shim')
  await mkdir(shimDir)
  const shimPath = join(shimDir, 'git')
  const inserted = join(root, 'stash-inserted')
  const newerOid = join(root, 'newer-stash-oid')
  await writeFile(
    shimPath,
    `#!/bin/sh
real="$GIT_STACKS_TEST_REAL_GIT"
if [ ! -e "$GIT_STACKS_STASH_INSERTED" ]; then
  case "$1:$2:$3" in
    config:--get:extensions.refstorage|stash:apply:*|stash:pop:*|stash:drop:*)
      "$real" -C "$GIT_STACKS_STASH_REPO" stash push --include-untracked --message=newer >/dev/null 2>&1 || exit $?
      "$real" -C "$GIT_STACKS_STASH_REPO" rev-parse refs/stash > "$GIT_STACKS_STASH_NEWER_OID"
      : > "$GIT_STACKS_STASH_INSERTED"
      ;;
  esac
fi
exec "$real" "$@"
`,
    { mode: 0o755 },
  )
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim()
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}${delimiter}${savedPath ?? ''}`
  process.env.GIT_STACKS_TEST_REAL_GIT = realGit
  process.env.GIT_STACKS_STASH_REPO = repo
  process.env.GIT_STACKS_STASH_INSERTED = inserted
  process.env.GIT_STACKS_STASH_NEWER_OID = newerOid
  try {
    await action()
  } finally {
    process.env.PATH = savedPath
    delete process.env.GIT_STACKS_TEST_REAL_GIT
    delete process.env.GIT_STACKS_STASH_REPO
    delete process.env.GIT_STACKS_STASH_INSERTED
    delete process.env.GIT_STACKS_STASH_NEWER_OID
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
  const shimDir = join(root, 'parent-race-shim')
  await mkdir(shimDir)
  const triggered = join(root, 'parent-race-triggered')
  await writeFile(
    join(shimDir, 'git'),
    `#!/bin/sh
real="$GIT_STACKS_TEST_REAL_GIT"
trigger=false
if [ ! -e "$GIT_STACKS_RACE_TRIGGERED" ]; then
  case "$GIT_STACKS_RACE_COMMAND" in
    create)
      if [ "$1" = "switch" ] && [ "$4" = "--create" ]; then trigger=true; fi
      ;;
    rebase)
      if [ "$1" = "-c" ] && [ "$5" = "rebase" ]; then trigger=true; fi
      ;;
  esac
fi
if [ "$trigger" = true ]; then
  "$real" -C "$GIT_STACKS_RACE_REPO" update-ref refs/heads/main "$GIT_STACKS_RACE_ADVANCED" "$GIT_STACKS_RACE_EXPECTED" || exit $?
  : > "$GIT_STACKS_RACE_TRIGGERED"
fi
exec "$real" "$@"
`,
    { mode: 0o755 },
  )
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim()
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}${delimiter}${savedPath ?? ''}`
  process.env.GIT_STACKS_TEST_REAL_GIT = realGit
  process.env.GIT_STACKS_RACE_REPO = repo
  process.env.GIT_STACKS_RACE_COMMAND = command
  process.env.GIT_STACKS_RACE_EXPECTED = expectedOid
  process.env.GIT_STACKS_RACE_ADVANCED = advancedOid
  process.env.GIT_STACKS_RACE_TRIGGERED = triggered
  try {
    await action()
  } finally {
    process.env.PATH = savedPath
    delete process.env.GIT_STACKS_TEST_REAL_GIT
    delete process.env.GIT_STACKS_RACE_REPO
    delete process.env.GIT_STACKS_RACE_COMMAND
    delete process.env.GIT_STACKS_RACE_EXPECTED
    delete process.env.GIT_STACKS_RACE_ADVANCED
    delete process.env.GIT_STACKS_RACE_TRIGGERED
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
  const shimDir = join(root, 'file-race-shim')
  await mkdir(shimDir)
  const triggered = join(root, 'file-race-triggered')
  await writeFile(
    join(shimDir, 'git'),
    `#!/bin/sh
real="$GIT_STACKS_TEST_REAL_GIT"
trigger=false
if [ ! -e "$GIT_STACKS_FILE_RACE_TRIGGERED" ]; then
  case "$GIT_STACKS_FILE_RACE_ACTION" in
    discard)
      if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "restore" ]; then trigger=true; fi
      ;;
    resolve)
      if [ "$1" = "--literal-pathspecs" ] && [ "$2" = "checkout" ] && [ "$3" = "--ours" ]; then trigger=true; fi
      ;;
  esac
fi
if [ "$trigger" = true ]; then
  printf '%s' "$GIT_STACKS_FILE_RACE_CONTENT" > "$GIT_STACKS_FILE_RACE_FILE" || exit $?
  : > "$GIT_STACKS_FILE_RACE_TRIGGERED"
fi
exec "$real" "$@"
`,
    { mode: 0o755 },
  )
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim()
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}${delimiter}${savedPath ?? ''}`
  process.env.GIT_STACKS_TEST_REAL_GIT = realGit
  process.env.GIT_STACKS_FILE_RACE_ACTION = action
  process.env.GIT_STACKS_FILE_RACE_CONTENT = content
  process.env.GIT_STACKS_FILE_RACE_FILE = join(repo, 'shared.txt')
  process.env.GIT_STACKS_FILE_RACE_TRIGGERED = triggered
  try {
    await run()
  } finally {
    process.env.PATH = savedPath
    delete process.env.GIT_STACKS_TEST_REAL_GIT
    delete process.env.GIT_STACKS_FILE_RACE_ACTION
    delete process.env.GIT_STACKS_FILE_RACE_CONTENT
    delete process.env.GIT_STACKS_FILE_RACE_FILE
    delete process.env.GIT_STACKS_FILE_RACE_TRIGGERED
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
  const shimDir = join(root, 'head-race-shim')
  await mkdir(shimDir)
  const triggered = join(root, 'head-race-triggered')
  await writeFile(
    join(shimDir, 'git'),
    `#!/bin/sh
real="$GIT_STACKS_TEST_REAL_GIT"
if [ ! -e "$GIT_STACKS_HEAD_RACE_TRIGGERED" ] && [ "$1" = "-c" ] && [ "$3" = "$GIT_STACKS_HEAD_RACE_COMMAND" ]; then
  "$real" -C "$GIT_STACKS_HEAD_RACE_REPO" update-ref "$GIT_STACKS_HEAD_RACE_REF" "$GIT_STACKS_HEAD_RACE_ADVANCED" "$GIT_STACKS_HEAD_RACE_EXPECTED" || exit $?
  : > "$GIT_STACKS_HEAD_RACE_TRIGGERED"
fi
exec "$real" "$@"
`,
    { mode: 0o755 },
  )
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).trim()
  const savedPath = process.env.PATH
  process.env.PATH = `${shimDir}${delimiter}${savedPath ?? ''}`
  process.env.GIT_STACKS_TEST_REAL_GIT = realGit
  process.env.GIT_STACKS_HEAD_RACE_COMMAND = command
  process.env.GIT_STACKS_HEAD_RACE_REPO = repo
  process.env.GIT_STACKS_HEAD_RACE_REF = ref
  process.env.GIT_STACKS_HEAD_RACE_EXPECTED = expectedOid
  process.env.GIT_STACKS_HEAD_RACE_ADVANCED = advancedOid
  process.env.GIT_STACKS_HEAD_RACE_TRIGGERED = triggered
  try {
    await run()
  } finally {
    process.env.PATH = savedPath
    delete process.env.GIT_STACKS_TEST_REAL_GIT
    delete process.env.GIT_STACKS_HEAD_RACE_COMMAND
    delete process.env.GIT_STACKS_HEAD_RACE_REPO
    delete process.env.GIT_STACKS_HEAD_RACE_REF
    delete process.env.GIT_STACKS_HEAD_RACE_EXPECTED
    delete process.env.GIT_STACKS_HEAD_RACE_ADVANCED
    delete process.env.GIT_STACKS_HEAD_RACE_TRIGGERED
  }
  return triggered
}

test('branch creation uses the captured parent when its ref advances before switch', async () => {
  const { root, repo, git } = await fixture()
  try {
    const parentTip = git('rev-parse', 'refs/heads/main')
    const tree = git('rev-parse', `${parentTip}^{tree}`)
    const advancedTip = execFileSync(
      'git',
      ['-C', repo, 'commit-tree', tree, '-p', parentTip, '-m', 'Advanced parent'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()

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
    const advancedTip = execFileSync(
      'git',
      ['-C', repo, 'commit-tree', tree, '-p', parentTip, '-m', 'Advanced parent'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
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
    await runAction(repo, { type: 'operationAbort' })
    assert.equal((await getSnapshot(repo)).operation, null)
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
    const advancedHead = execFileSync(
      'git',
      ['-C', repo, 'commit-tree', tree, '-p', expectedHead, '-m', 'External conflict-time advance'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
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
        type: 'resolveFile',
        path: 'shared.txt',
        fingerprint: view.fingerprint,
        strategy: 'manual',
        content: tooLarge,
      }),
    )
    assert.equal((await getFileView(repo, 'shared.txt')).fingerprint, view.fingerprint)

    const resolved = 'é'.repeat(400_000)
    await runAction(repo, {
      type: 'resolveFile',
      path: 'shared.txt',
      fingerprint: view.fingerprint,
      strategy: 'manual',
      content: resolved,
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
            type: 'resolveFile',
            path: 'shared.txt',
            fingerprint: view.fingerprint,
            strategy: 'ours',
            content: '',
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
      const advancedHead = execFileSync(
        'git',
        ['-C', repo, 'commit-tree', tree, '-p', expectedHead, '-m', `External ${command} race`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim()
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
    await mkdir(hooks)
    await writeFile(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf called > "$GIT_STACKS_TEST_HOOK_MARKER"\n',
      { mode: 0o755 },
    )
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
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    git('remote', 'add', 'origin', remote)
    git('switch', '-c', 'feature')
    git('push', '-u', 'origin', 'feature')
    const preview = await getPushPreview(repo)
    execFileSync('git', ['clone', '-b', 'feature', remote, peer], { stdio: 'pipe' })
    execFileSync('git', ['-C', peer, 'config', 'user.name', 'Peer'])
    execFileSync('git', ['-C', peer, 'config', 'user.email', 'peer@example.invalid'])
    await writeFile(join(peer, 'peer.txt'), 'peer\n')
    execFileSync('git', ['-C', peer, 'add', '.'])
    execFileSync('git', ['-C', peer, 'commit', '-m', 'peer'])
    execFileSync('git', ['-C', peer, 'push'])
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
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    git('remote', 'add', 'origin', remote)
    git('switch', '-c', 'feature')
    git('push', '-u', 'origin', 'feature')
    const preview = await getPushPreview(repo)
    const tree = git('rev-parse', 'HEAD^{tree}')
    const advancedOid = execFileSync(
      'git',
      ['-C', repo, 'commit-tree', tree, '-p', preview.localOid, '-m', 'Local branch advanced'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()

    const shimDir = join(root, 'git-shim')
    await mkdir(shimDir)
    const shimPath = join(shimDir, 'git')
    const advanced = join(root, 'branch-advanced')
    await writeFile(
      shimPath,
      `#!/bin/sh
real="$GIT_STACKS_TEST_REAL_GIT"
if [ "$1" = "-c" ] && [ "$2" = "push.followTags=false" ] && [ "$3" = "push" ] && [ ! -e "$GIT_STACKS_BRANCH_ADVANCED" ]; then
  "$real" -C "$GIT_STACKS_PUSH_REPO" update-ref refs/heads/feature "$GIT_STACKS_ADVANCED_OID" "$GIT_STACKS_PREVIEW_OID" || exit $?
  : > "$GIT_STACKS_BRANCH_ADVANCED"
fi
exec "$real" "$@"
`,
      { mode: 0o755 },
    )
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim()
    const savedPath = process.env.PATH
    process.env.PATH = `${shimDir}${delimiter}${savedPath ?? ''}`
    process.env.GIT_STACKS_TEST_REAL_GIT = realGit
    process.env.GIT_STACKS_PUSH_REPO = repo
    process.env.GIT_STACKS_BRANCH_ADVANCED = advanced
    process.env.GIT_STACKS_ADVANCED_OID = advancedOid
    process.env.GIT_STACKS_PREVIEW_OID = preview.localOid
    try {
      await runAction(repo, { type: 'forcePush', preview })
    } finally {
      process.env.PATH = savedPath
      delete process.env.GIT_STACKS_TEST_REAL_GIT
      delete process.env.GIT_STACKS_PUSH_REPO
      delete process.env.GIT_STACKS_BRANCH_ADVANCED
      delete process.env.GIT_STACKS_ADVANCED_OID
      delete process.env.GIT_STACKS_PREVIEW_OID
    }

    assert.equal(await readFile(advanced, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/feature'), advancedOid)
    assert.equal(
      execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/feature'], {
        encoding: 'utf8',
      }).trim(),
      preview.localOid,
    )
  } finally {
    await cleanup(root)
  }
})
