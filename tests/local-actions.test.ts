import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      }),
    )
    await runAction(repo, {
      type: 'commit',
      message: 'amended feature',
      amend: true,
      expectedHead: initial,
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
      runAction(repo, { type: 'merge', ref: 'refs/heads/side', expectedHead: mainHead }),
    )
    assert.equal((await getSnapshot(repo)).operation, 'merge')
    await assert.rejects(runAction(repo, { type: 'operationSkip' }))
    await runAction(repo, { type: 'operationAbort' })
    assert.equal((await getSnapshot(repo)).operation, null)
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
