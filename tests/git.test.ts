import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getSnapshot, resolveRepository, runAction } from '../src/main/git'
import type { GitAction } from '../src/shared/types'
import { getCombinedBranches, sortBranchesByUpdatedAt } from '../src/renderer/src/lib/branches'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-test-'))
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

test('dirty switches and option-like branch names cannot change or discard work', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('branch', 'feature')
    await writeFile(join(repo, 'shared.txt'), 'unsaved work\n')
    await assert.rejects(runAction(repo, { type: 'switch', ref: 'refs/heads/feature' }))
    assert.equal(git('branch', '--show-current'), 'main')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'unsaved work\n')
    await assert.rejects(runAction(repo, { type: 'switch', ref: '--discard-changes' }))
    await assert.rejects(runAction(repo, { type: 'stage', paths: ['../outside.txt'] }))
    await assert.rejects(runAction(repo, { type: 'not-an-action' } as unknown as GitAction))
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'unsaved work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renamed files and literal pathspec characters retain both paths through unstage and stage', async () => {
  const { root, repo, git } = await fixture()
  try {
    const destination = 'renamed [draft]\nfile.txt'
    git('mv', 'shared.txt', destination)
    let snapshot = await getSnapshot(repo)
    const renamed = snapshot.files.find((file) => file.path === destination)
    assert.equal(renamed?.originalPath, 'shared.txt')
    await runAction(repo, { type: 'unstage', paths: [destination, 'shared.txt'] })
    assert.equal(git('diff', '--cached', '--name-only'), '')
    await runAction(repo, { type: 'stage', paths: [destination, 'shared.txt'] })
    await runAction(repo, { type: 'commit', message: 'Rename a literal path' })
    assert.equal(git('show', `HEAD:${destination}`), 'base')
    snapshot = await getSnapshot(repo)
    assert.deepEqual(snapshot.files, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rebase conflicts expose recovery and abort preserves the original branch tip', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'feature', parent: 'main' })
    await writeFile(join(repo, 'shared.txt'), 'feature change\n')
    git('add', '.')
    git('commit', '-m', 'Feature change')
    const originalTip = git('rev-parse', 'HEAD')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    await writeFile(join(repo, 'shared.txt'), 'main change\n')
    git('add', '.')
    git('commit', '-m', 'Main change')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/feature' })
    await assert.rejects(runAction(repo, { type: 'rebase', parent: 'main' }))
    const conflict = await getSnapshot(repo)
    assert.equal(conflict.rebaseInProgress, true)
    assert.equal(
      conflict.files.some((file) => file.conflicted),
      true,
    )
    await assert.rejects(runAction(repo, { type: 'switch', ref: 'refs/heads/main' }))
    await runAction(repo, { type: 'rebaseAbort' })
    assert.equal(git('branch', '--show-current'), 'feature')
    assert.equal(git('rev-parse', 'HEAD'), originalTip)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'feature change\n')
    assert.equal((await getSnapshot(repo)).rebaseInProgress, false)
    await assert.rejects(runAction(repo, { type: 'rebase', parent: 'main' }))
    await writeFile(join(repo, 'shared.txt'), 'resolved changes\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await runAction(repo, { type: 'rebaseContinue' })
    assert.equal((await getSnapshot(repo)).rebaseInProgress, false)
    assert.equal(git('branch', '--show-current'), 'feature')
    assert.equal(git('merge-base', 'HEAD', 'main'), git('rev-parse', 'main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unborn repositories support their first staged commit without GitHub', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-unborn-'))
  try {
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'pipe' })
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid'])
    const repo = await resolveRepository(root)
    const initial = await getSnapshot(repo)
    assert.equal(initial.currentBranch, 'main')
    assert.equal(initial.github.available, false)
    await writeFile(join(root, 'first.txt'), 'first\n')
    await runAction(repo, { type: 'stage', paths: ['first.txt'] })
    await runAction(repo, { type: 'unstage', paths: ['first.txt'] })
    assert.equal((await getSnapshot(repo)).files[0]?.index, '?')
    await runAction(repo, { type: 'stage', paths: ['first.txt'] })
    await runAction(repo, { type: 'commit', message: 'First commit' })
    assert.equal(
      execFileSync('git', ['-C', root, 'show', 'HEAD:first.txt'], { encoding: 'utf8' }),
      'first\n',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('divergent pull and push cannot rewrite either side of a remote branch', async () => {
  const { root, repo, git } = await fixture()
  try {
    const remote = join(root, 'remote.git')
    const peer = join(root, 'peer')
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    git('remote', 'add', 'origin', remote)
    git('push', '-u', 'origin', 'main')
    execFileSync('git', ['clone', '-b', 'main', remote, peer], { stdio: 'pipe' })
    const peerGit = (...args: string[]) =>
      execFileSync('git', ['-C', peer, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    peerGit('config', 'user.name', 'Peer')
    peerGit('config', 'user.email', 'peer@example.invalid')
    await writeFile(join(peer, 'peer.txt'), 'remote work\n')
    peerGit('add', '.')
    peerGit('commit', '-m', 'Remote commit')
    peerGit('push')
    const remoteTip = peerGit('rev-parse', 'HEAD')
    await writeFile(join(repo, 'local.txt'), 'local work\n')
    git('add', '.')
    git('commit', '-m', 'Local commit')
    const localTip = git('rev-parse', 'HEAD')
    await assert.rejects(runAction(repo, { type: 'pull' }))
    git('config', 'remote.origin.push', '+refs/heads/main:refs/heads/main')
    git('config', 'remote.origin.mirror', 'true')
    assert.equal(git('rev-parse', 'HEAD'), localTip)
    await assert.rejects(runAction(repo, { type: 'push' }))
    assert.equal(
      execFileSync('git', ['-C', remote, 'rev-parse', 'refs/heads/main'], {
        encoding: 'utf8',
      }).trim(),
      remoteTip,
    )
    assert.equal(await readFile(join(repo, 'local.txt'), 'utf8'), 'local work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stash removes untracked literal paths and restores their contents and staged state', async () => {
  const { root, repo } = await fixture()
  try {
    await writeFile(join(repo, 'notes [draft].txt'), 'untracked notes\n')
    await writeFile(join(repo, 'shared.txt'), 'staged work\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    await runAction(repo, { type: 'stash' })
    const stashed = await getSnapshot(repo)
    assert.deepEqual(stashed.files, [])
    await assert.rejects(readFile(join(repo, 'notes [draft].txt')))
    await runAction(repo, { type: 'stashPop', ref: stashed.stashes[0].ref })
    const restored = await getSnapshot(repo)
    assert.equal(await readFile(join(repo, 'notes [draft].txt'), 'utf8'), 'untracked notes\n')
    assert.equal(restored.files.find((file) => file.path === 'shared.txt')?.index, 'M')
    assert.deepEqual(restored.stashes, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('selected-branch rebase does not update other refs even when configured globally', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'middle')
    await writeFile(join(repo, 'middle.txt'), 'middle\n')
    git('add', '.')
    git('commit', '-m', 'Middle commit')
    const middleTip = git('rev-parse', 'HEAD')
    git('switch', '-c', 'top')
    await writeFile(join(repo, 'top.txt'), 'top\n')
    git('add', '.')
    git('commit', '-m', 'Top commit')
    git('switch', 'main')
    await writeFile(join(repo, 'main.txt'), 'main advances\n')
    git('add', '.')
    git('commit', '-m', 'Main advances')
    git('switch', 'top')
    git('config', 'rebase.updateRefs', 'true')
    await runAction(repo, { type: 'rebase', parent: 'main' })
    assert.equal(git('rev-parse', 'middle'), middleTip)
    assert.equal(git('merge-base', 'main', 'top'), git('rev-parse', 'main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('switch and child creation preserve ignored files that the target branch tracks', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'target')
    await writeFile(join(repo, 'local.env'), 'tracked target contents\n')
    git('add', '.')
    git('commit', '-m', 'Track environment example')
    git('switch', 'main')
    await writeFile(join(repo, '.gitignore'), 'local.env\n')
    git('add', '.')
    git('commit', '-m', 'Ignore local environment')
    await writeFile(join(repo, 'local.env'), 'private local contents\n')
    await assert.rejects(runAction(repo, { type: 'switch', ref: 'refs/heads/target' }))
    await assert.rejects(runAction(repo, { type: 'createBranch', name: 'child', parent: 'target' }))
    assert.equal(git('branch', '--show-current'), 'main')
    assert.equal(await readFile(join(repo, 'local.env'), 'utf8'), 'private local contents\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child branch uses the selected branch rather than a same-named tag', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('tag', 'release')
    git('switch', '-c', 'release')
    await writeFile(join(repo, 'release.txt'), 'branch contents\n')
    git('add', '.')
    git('commit', '-m', 'Release branch advances')
    const parentTip = git('rev-parse', 'refs/heads/release')
    await runAction(repo, { type: 'createBranch', name: 'child', parent: 'release' })
    assert.equal(git('rev-parse', 'HEAD'), parentTip)
    assert.equal(await readFile(join(repo, 'release.txt'), 'utf8'), 'branch contents\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local and remote branches with identical display names remain distinct', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('remote', 'add', 'origin', join(root, 'remote.git'))
    const remoteTip = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/feature', remoteTip)
    git('switch', '-c', 'origin/feature')
    await writeFile(join(repo, 'local-only.txt'), 'local namespaced branch\n')
    git('add', '.')
    git('commit', '-m', 'Local origin-prefixed branch')
    const localTip = git('rev-parse', 'HEAD')
    const snapshot = await getSnapshot(repo)
    assert.deepEqual(
      snapshot.branches
        .filter((branch) => branch.name === 'origin/feature')
        .map((branch) => branch.ref)
        .sort(),
      ['refs/heads/origin/feature', 'refs/remotes/origin/feature'],
    )
    await runAction(repo, { type: 'switch', ref: 'refs/remotes/origin/feature' })
    assert.equal(git('branch', '--show-current'), 'feature')
    assert.equal(git('rev-parse', 'HEAD'), remoteTip)
    assert.equal(git('rev-parse', 'refs/heads/origin/feature'), localTip)
    await runAction(repo, { type: 'switch', ref: 'refs/heads/origin/feature' })
    await runAction(repo, { type: 'switch', ref: 'refs/remotes/origin/feature' })
    assert.equal(git('branch', '--show-current'), 'feature')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('combined branches collapse tracked refs without hiding unrelated remotes or local name collisions', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('remote', 'add', 'origin', join(root, 'origin.git'))
    git('remote', 'add', 'other', join(root, 'other.git'))
    for (const ref of ['origin/main', 'origin/feature', 'origin/remote-only', 'other/feature']) {
      git('update-ref', `refs/remotes/${ref}`, 'HEAD')
    }
    git('branch', '--set-upstream-to=origin/main', 'main')
    git('branch', 'work', '--track', 'origin/feature')
    git('branch', 'origin/feature')

    const snapshot = await getSnapshot(repo)
    const combined = getCombinedBranches(snapshot.branches)
    assert.deepEqual(combined.map((branch) => branch.ref).sort(), [
      'refs/heads/main',
      'refs/heads/origin/feature',
      'refs/heads/work',
      'refs/remotes/origin/remote-only',
      'refs/remotes/other/feature',
    ])
    assert.deepEqual(
      snapshot.branches
        .filter((branch) => branch.remote)
        .map((branch) => branch.ref)
        .sort(),
      [
        'refs/remotes/origin/feature',
        'refs/remotes/origin/main',
        'refs/remotes/origin/remote-only',
        'refs/remotes/other/feature',
      ],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('untracked local branches represent same-name origin refs without conflating other remotes', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('remote', 'add', 'origin', join(root, 'origin.git'))
    git('remote', 'add', 'other', join(root, 'other.git'))
    git('branch', 'stack/topic')
    for (const ref of ['origin/main', 'origin/stack/topic', 'origin/remote-only', 'other/main']) {
      git('update-ref', `refs/remotes/${ref}`, 'HEAD')
    }
    git('commit', '--allow-empty', '-m', 'Local work not yet pushed')
    const originalConfig = git('config', '--local', '--list')

    const combined = getCombinedBranches((await getSnapshot(repo)).branches)
    assert.deepEqual(combined.map((branch) => branch.ref).sort(), [
      'refs/heads/main',
      'refs/heads/stack/topic',
      'refs/remotes/origin/remote-only',
      'refs/remotes/other/main',
    ])
    assert.equal(git('config', '--local', '--list'), originalConfig)

    git('branch', '--set-upstream-to=other/main', 'main')
    const explicitlyTracked = getCombinedBranches((await getSnapshot(repo)).branches)
    assert.deepEqual(explicitlyTracked.map((branch) => branch.ref).sort(), [
      'refs/heads/main',
      'refs/heads/stack/topic',
      'refs/remotes/origin/main',
      'refs/remotes/origin/remote-only',
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch recency sorting uses absolute timestamps, with stable ties and undated branches last', async () => {
  const { root, repo } = await fixture()
  try {
    const base = (await getSnapshot(repo)).branches[0]
    const branches = Object.freeze([
      { ...base, ref: 'refs/heads/parent', updatedAt: '2026-05-01T15:00:00+02:00' },
      { ...base, ref: 'refs/heads/unknown', updatedAt: 'invalid' },
      { ...base, ref: 'refs/heads/alpha', updatedAt: '2026-05-01T13:00:00Z' },
      {
        ...base,
        ref: 'refs/remotes/origin/recent',
        remote: true,
        updatedAt: '2026-05-01T13:30:00Z',
      },
      { ...base, ref: 'refs/heads/unborn', updatedAt: '' },
      {
        ...base,
        ref: 'refs/heads/child',
        parent: 'parent',
        updatedAt: '2026-05-01T14:00:00Z',
      },
    ])

    assert.deepEqual(
      sortBranchesByUpdatedAt(branches).map((branch) => branch.ref),
      [
        'refs/heads/child',
        'refs/remotes/origin/recent',
        'refs/heads/alpha',
        'refs/heads/parent',
        'refs/heads/unborn',
        'refs/heads/unknown',
      ],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stack ordering keeps descendants contiguous above parents and ranks sibling stacks by recency', async () => {
  const { root, repo } = await fixture()
  try {
    const base = (await getSnapshot(repo)).branches[0]
    const branches = [
      ['parent', null, '10'],
      ['child', 'parent', '04'],
      ['grandchild', 'child', '01'],
      ['sibling', 'parent', '02'],
      ['unrelated', null, '09'],
      ['missing-parent', 'absent', '03'],
    ].map(([name, parent, day]) => ({
      ...base,
      name: name!,
      ref: `refs/heads/${name}`,
      parent,
      updatedAt: `2026-05-${day}T00:00:00Z`,
    }))
    assert.deepEqual(
      sortBranchesByUpdatedAt(branches).map((branch) => branch.name),
      ['grandchild', 'child', 'sibling', 'parent', 'unrelated', 'missing-parent'],
    )

    const cyclic = [
      { ...base, ref: 'refs/heads/a', name: 'a', parent: 'b' },
      { ...base, ref: 'refs/heads/b', name: 'b', parent: 'a' },
      { ...base, ref: 'refs/heads/free', name: 'free', parent: null },
    ]
    assert.deepEqual(
      sortBranchesByUpdatedAt(cyclic).map((branch) => branch.name),
      ['free', 'a', 'b'],
    )

    const remoteParent = [
      { ...base, ref: 'refs/remotes/origin/main', name: 'origin/main', remote: true, parent: null },
      { ...base, ref: 'refs/heads/feature', name: 'feature', parent: 'main' },
    ]
    assert.deepEqual(
      sortBranchesByUpdatedAt(remoteParent).map((branch) => branch.ref),
      ['refs/heads/feature', 'refs/remotes/origin/main'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default fallback links ordinary descendants without overriding explicit parents or orphan roots', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('config', 'init.defaultBranch', 'main')
    git('branch', 'old')
    git('branch', 'feature')
    git('branch', 'configured')
    git('config', 'branch.configured.parent', 'feature')
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'Advance default'], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2030-01-02T00:00:00Z',
        GIT_COMMITTER_DATE: '2030-01-02T00:00:00Z',
      },
      stdio: 'pipe',
    })

    git('switch', '--orphan', 'orphan')
    await writeFile(join(repo, 'orphan.txt'), 'orphan history\n')
    git('add', '.')
    git('commit', '-m', 'Orphan history')

    const snapshot = await getSnapshot(repo)
    const branch = (name: string) => snapshot.branches.find((entry) => entry.name === name)
    assert.equal(snapshot.defaultBranch, 'main')
    assert.equal(branch('old')?.parent, 'main')
    assert.equal(branch('old')?.parentBehind, 1)
    assert.equal(branch('configured')?.parent, 'feature')
    assert.equal(branch('main')?.parent, null)
    assert.equal(branch('orphan')?.parent, null)
    assert.deepEqual(
      sortBranchesByUpdatedAt(snapshot.branches)
        .filter((entry) => entry.name === 'old' || entry.name === 'main')
        .map((entry) => entry.name),
      ['old', 'main'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('default fallback links origin descendants without linking default or other remotes', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('config', 'init.defaultBranch', 'main')
    const initialTip = git('rev-parse', 'main')
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'Advance default'], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2030-01-02T00:00:00Z',
        GIT_COMMITTER_DATE: '2030-01-02T00:00:00Z',
      },
      stdio: 'pipe',
    })
    const defaultTip = git('rev-parse', 'main')
    git('remote', 'add', 'origin', join(root, 'origin.git'))
    git('update-ref', 'refs/remotes/origin/staging', initialTip)
    git('update-ref', 'refs/remotes/origin/main', defaultTip)
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git('update-ref', 'refs/remotes/other/staging', initialTip)

    const snapshot = await getSnapshot(repo)
    const branch = (ref: string) => snapshot.branches.find((entry) => entry.ref === ref)
    assert.equal(snapshot.defaultBranch, 'main')
    assert.equal(branch('refs/remotes/origin/staging')?.parent, 'main')
    assert.equal(branch('refs/remotes/origin/staging')?.parentBehind, 1)
    assert.equal(branch('refs/remotes/origin/main')?.parent, null)
    assert.equal(branch('refs/remotes/other/staging')?.parent, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parent commit warnings propagate through a stack and clear after each child is rebased', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'parent', parent: 'main' })
    await writeFile(join(repo, 'parent.txt'), 'parent work\n')
    git('add', '.')
    git('commit', '-m', 'Parent work')
    await runAction(repo, { type: 'createBranch', name: 'child', parent: 'parent' })
    await writeFile(join(repo, 'child.txt'), 'child work\n')
    git('add', '.')
    git('commit', '-m', 'Child work')
    let snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'parent')?.parentBehind, 0)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, 0)

    git('switch', 'main')
    await writeFile(join(repo, 'root.txt'), 'updated base\n')
    git('add', '.')
    execFileSync('git', ['-C', repo, 'commit', '-m', 'Base advances with an older timestamp'], {
      env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' },
      stdio: 'pipe',
    })
    snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'parent')?.parentBehind, 1)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, 0)

    git('switch', 'parent')
    await runAction(repo, { type: 'rebase', parent: 'main' })
    snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'parent')?.parentBehind, 0)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, 2)

    git('switch', 'child')
    await runAction(repo, { type: 'rebase', parent: 'parent' })
    snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, 0)
    assert.equal(await readFile(join(repo, 'child.txt'), 'utf8'), 'child work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parent comparisons use fetched remote parents and remain unknown for missing parents', async () => {
  const { root, repo, git } = await fixture()
  try {
    await runAction(repo, { type: 'createBranch', name: 'child', parent: 'main' })
    git('switch', 'main')
    git('commit', '--allow-empty', '-m', 'Parent advances')
    git('update-ref', 'refs/remotes/origin/fetched-parent', 'HEAD')
    git('config', 'branch.child.parent', 'fetched-parent')
    let snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, 1)
    git('update-ref', '-d', 'refs/remotes/origin/fetched-parent')
    snapshot = await getSnapshot(repo)
    assert.equal(snapshot.branches.find((branch) => branch.name === 'child')?.parentBehind, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
