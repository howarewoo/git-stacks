import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { capabilityAttentionCount, capabilityReport } from '../src/shared/capabilities'
import type { GitAction } from '../src/shared/types'
import type { RepositoryCapabilities } from '../src/shared/capabilities'
import { getFileView, getSnapshot, resolveRepository, runAction } from '../src/main/git'
import { getRepositoryCapabilities } from '../src/main/capabilities'

type Git = (...args: string[]) => string

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'git-stacks-compat-'))
}

function gitIn(repo: string): Git {
  return (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
}

async function initRepo(root: string, name = 'workspace', refFormat?: string): Promise<Git> {
  const repo = join(root, name)
  await mkdir(repo)
  const args = ['init', ...(refFormat ? [`--ref-format=${refFormat}`] : []), '-b', 'main', repo]
  const init = spawnSync('git', args, { encoding: 'utf8' })
  assert.equal(init.status, 0, init.stderr)
  const git = gitIn(repo)
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  return git
}

function reportEntry(capabilities: RepositoryCapabilities, id: string) {
  const entry = capabilityReport(capabilities).find((candidate) => candidate.id === id)
  assert.ok(entry, `expected a ${id} entry in the support matrix`)
  return entry
}

test('a standard repository reports a fully supported matrix', async () => {
  const root = await scratch()
  try {
    const git = await initRepo(root)
    await writeFile(join(root, 'workspace', 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')

    const capabilities = (await getSnapshot(join(root, 'workspace'))).capabilities
    assert.equal(capabilities.bare, false)
    assert.equal(capabilities.detachedHead, false)
    assert.equal(capabilities.linkedWorktree, false)
    assert.equal(capabilities.worktreeCount, 1)
    assert.equal(capabilities.refStorage, 'files')
    assert.equal(capabilities.submodules, false)
    assert.equal(capabilities.gitLfs, false)
    assert.equal(capabilities.sparseCheckout, false)
    assert.equal(capabilities.worktreeConfig, false)
    assert.equal(capabilities.objectFormat, 'sha1')
    assert.match(capabilities.gitVersion ?? '', /^git version /u)
    assert.deepEqual(
      capabilityReport(capabilities).map((entry) => entry.state),
      Array.from({ length: capabilityReport(capabilities).length }, () => 'supported'),
    )
    assert.equal(capabilityAttentionCount(capabilityReport(capabilities)), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an older Git echo of --show-ref-format falls back to files instead of inventing a backend', async () => {
  const root = await scratch()
  const originalPath = process.env.PATH
  try {
    await initRepo(root)
    const bin = join(root, 'bin')
    await mkdir(bin)
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const shim = join(bin, 'git')
    await writeFile(
      shim,
      `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-ref-format" ]; then
  printf '%s\\n' '--show-ref-format'
else
  exec '${realGit}' "$@"
fi
`,
    )
    await chmod(shim, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ''}`
    const capabilities = await getRepositoryCapabilities(join(root, 'workspace'))
    assert.equal(capabilities.refStorage, 'files')
    assert.equal(capabilities.refStorageDetail, null)
    assert.equal(reportEntry(capabilities, 'ref-storage').state, 'supported')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
})

test('a linked worktree reports the shared repository and keeps branch ownership', async () => {
  const root = await scratch()
  try {
    const git = await initRepo(root)
    const repo = join(root, 'workspace')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    const linked = join(root, 'linked')
    git('worktree', 'add', '-b', 'owned', linked)

    const linkedRoot = await resolveRepository(linked)
    const capabilities = (await getSnapshot(linkedRoot)).capabilities
    assert.equal(capabilities.linkedWorktree, true)
    assert.equal(capabilities.worktreeCount, 2)
    assert.equal(capabilities.bare, false)
    assert.match(reportEntry(capabilities, 'worktrees').detail, /2 worktrees share one repository/u)
    assert.equal(reportEntry(capabilities, 'worktrees').state, 'limited')
    const primaryCapabilities = (await getSnapshot(repo)).capabilities
    assert.equal(primaryCapabilities.linkedWorktree, false)
    assert.equal(primaryCapabilities.worktreeCount, 2)
    assert.equal(reportEntry(primaryCapabilities, 'worktrees').state, 'limited')

    // The branch the linked worktree holds cannot be deleted from this one.
    const ownedOid = git('rev-parse', 'owned')
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/owned',
        force: false,
        expectedOid: ownedOid,
      }),
      /checked out in another worktree/u,
    )
    assert.equal(git('rev-parse', 'owned'), ownedOid)

    // Stack parent metadata is repository-common, so the main worktree sees it.
    await runAction(linkedRoot, { type: 'createBranch', name: 'stacked', parent: 'main' })
    assert.equal(gitIn(repo)('config', '--get', 'branch.stacked.parent'), 'main')
    assert.equal(gitIn(linked)('config', '--get', 'branch.stacked.parent'), 'main')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a submodule shows its recorded commit and refuses content actions', async () => {
  const root = await scratch()
  try {
    const child = await initRepo(root, 'child')
    const childRepo = join(root, 'child')
    await writeFile(join(childRepo, 'inner.txt'), 'first\n')
    child('add', '.')
    child('commit', '-m', 'Child initial')

    const superGit = await initRepo(root, 'super')
    const superRepo = join(root, 'super')
    await writeFile(join(superRepo, 'shared.txt'), 'base\n')
    superGit('add', '.')
    superGit('commit', '-m', 'Super initial')
    superGit('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', childRepo, 'vendor/lib')
    superGit('commit', '-m', 'Add submodule')

    await writeFile(join(childRepo, 'inner.txt'), 'second\n')
    child('add', '.')
    child('commit', '-m', 'Child change')
    const linked = gitIn(join(superRepo, 'vendor', 'lib'))
    linked('-c', 'protocol.file.allow=always', 'fetch', '-q', 'origin')
    linked('checkout', '-q', child('rev-parse', 'HEAD'))

    const snapshot = await getSnapshot(superRepo)
    assert.equal(snapshot.capabilities.submodules, true)
    assert.equal(reportEntry(snapshot.capabilities, 'submodules').state, 'limited')
    const gitlink = snapshot.files.find((file) => file.path === 'vendor/lib')
    assert.equal(gitlink?.submodule, true)
    assert.equal(gitlink?.worktree, 'M')

    const view = await getFileView(superRepo, 'vendor/lib')
    assert.equal(view.submodule, true)
    assert.equal(view.content, null)
    assert.match(view.unstagedDiff, /\+Subproject commit [0-9a-f]{40}/u)

    await assert.rejects(
      runAction(superRepo, {
        type: 'discardFile',
        path: 'vendor/lib',
        fingerprint: view.fingerprint,
      }),
      /vendor\/lib is a submodule/u,
    )
    assert.equal(await readFile(join(childRepo, 'inner.txt'), 'utf8'), 'second\n')

    // Staging touches the recorded gitlink only; the submodule tree is left alone.
    await runAction(superRepo, { type: 'stage', paths: ['vendor/lib'] })
    assert.equal(superGit('diff', '--cached', '--name-only'), 'vendor/lib')
    assert.equal(superGit('ls-files', '--stage', '--', 'vendor/lib').split(' ')[0], '160000')
    assert.equal(await readFile(join(childRepo, 'inner.txt'), 'utf8'), 'second\n')
    assert.equal(child('status', '--porcelain'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Git LFS pointer is read as a pointer and a push says so', async () => {
  const root = await scratch()
  try {
    const remotePath = join(root, 'remote.git')
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'pipe' })
    const remote = gitIn(remotePath)
    const git = await initRepo(root)
    const repo = join(root, 'workspace')
    // `git lfs install` writes filter.lfs.*; a pass-through driver stands in for the client.
    git('config', 'filter.lfs.process', '')
    git('config', 'filter.lfs.clean', 'cat')
    git('config', 'filter.lfs.smudge', 'cat')
    git('config', 'filter.lfs.required', 'false')
    const oid = 'a'.repeat(64)
    await writeFile(join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    await writeFile(
      join(repo, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 2048\n`,
    )
    git('add', '.')
    git('commit', '-m', 'Add pointer')
    git('remote', 'add', 'origin', remotePath)

    const capabilities = (await getSnapshot(repo)).capabilities
    assert.equal(capabilities.gitLfs, true)
    assert.equal(reportEntry(capabilities, 'git-lfs').state, 'limited')

    await writeFile(
      join(repo, 'asset.bin'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 4096\n`,
    )
    const view = await getFileView(repo, 'asset.bin')
    assert.deepEqual(view.lfs, { oid: 'b'.repeat(64), size: 4096 })

    const result = await runAction(repo, { type: 'push' })
    assert.match(result.message, /Git LFS objects travel with the Git LFS client/u)
    assert.equal(remote('rev-parse', 'refs/heads/main'), git('rev-parse', 'main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a sparse checkout never treats an unmaterialized path as a change', async () => {
  const root = await scratch()
  try {
    const git = await initRepo(root)
    const repo = join(root, 'workspace')
    await mkdir(join(repo, 'keep'))
    await mkdir(join(repo, 'drop'))
    await writeFile(join(repo, 'keep', 'kept.txt'), 'kept\n')
    await writeFile(join(repo, 'drop', 'hidden.txt'), 'hidden\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('sparse-checkout', 'set', 'keep')

    const capabilities = (await getSnapshot(repo)).capabilities
    assert.equal(capabilities.sparseCheckout, true)
    assert.equal(capabilities.sparseCheckoutCone, true)
    assert.equal(capabilities.worktreeConfig, true)
    assert.equal(reportEntry(capabilities, 'sparse-checkout').state, 'limited')

    const snapshot = await getSnapshot(repo)
    assert.deepEqual(
      [...snapshot.files].map((file) => file.sparseExcluded),
      [],
    )
    assert.deepEqual(snapshot.files, [])

    await assert.rejects(getFileView(repo, 'drop/hidden.txt'), /outside this repository’s sparse/u)
    await assert.rejects(
      runAction(repo, { type: 'stage', paths: ['drop/hidden.txt'] }),
      /outside this repository’s sparse/u,
    )
    assert.equal(git('ls-files', '--', 'drop/hidden.txt'), 'drop/hidden.txt')
    assert.deepEqual((await getSnapshot(repo)).files, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a detached HEAD limits branch-owned operations and reports the reason', async () => {
  const root = await scratch()
  try {
    const git = await initRepo(root)
    const repo = join(root, 'workspace')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    git('checkout', '--detach', 'HEAD')

    const capabilities = (await getSnapshot(repo)).capabilities
    assert.equal(capabilities.detachedHead, true)
    const head = reportEntry(capabilities, 'head')
    assert.equal(head.state, 'limited')
    assert.equal(head.restrictions.length > 0, true)
    assert.deepEqual(head.restrictions.map((restriction) => restriction.operation).sort(), [
      'Cherry-pick',
      'Continue rebase',
      'Create pull request',
      'Force push',
      'Merge',
      'Pull',
      'Push',
      'Rebase',
      'Rename branch',
      'Revert commit',
      'Set upstream',
    ])
    for (const restriction of head.restrictions) {
      assert.match(restriction.reason, /HEAD is detached/u)
    }

    for (const action of [
      { type: 'push' },
      { type: 'rebase', parent: 'main' },
      {
        type: 'merge',
        ref: 'refs/heads/main',
        expectedHead: git('rev-parse', 'HEAD'),
        expectedHeadRef: 'HEAD',
      },
    ] as const) {
      await assert.rejects(runAction(repo, action), /HEAD is detached/u)
    }

    // Working-tree operations stay available and record against the detached HEAD.
    await writeFile(join(repo, 'shared.txt'), 'detached change\n')
    await runAction(repo, { type: 'stage', paths: ['shared.txt'] })
    const detachedTip = git('rev-parse', 'HEAD')
    await runAction(repo, {
      type: 'commit',
      message: 'Detached commit',
      amend: false,
      expectedHead: git('rev-parse', 'HEAD'),
      expectedHeadRef: 'HEAD',
    })
    assert.notEqual(git('rev-parse', 'HEAD'), detachedTip)
    assert.equal(git('branch', '--show-current'), '')

    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    assert.equal((await getSnapshot(repo)).capabilities.detachedHead, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a bare repository opens read-only and disables worktree actions', async () => {
  const root = await scratch()
  try {
    const source = await initRepo(root, 'source')
    const sourceRepo = join(root, 'source')
    await writeFile(join(sourceRepo, 'shared.txt'), 'base\n')
    source('add', '.')
    source('commit', '-m', 'Initial commit')
    source('branch', 'feature')
    const bare = join(root, 'mirror.git')
    execFileSync('git', ['clone', '--bare', sourceRepo, bare], { stdio: 'pipe' })
    const git = gitIn(bare)
    git('config', 'user.name', 'Git Stacks test')
    git('config', 'user.email', 'test@example.invalid')

    const bareRoot = await resolveRepository(bare)
    assert.equal(bareRoot, await realpath(bare))
    const snapshot = await getSnapshot(bare)
    assert.equal(snapshot.capabilities.bare, true)
    assert.equal(snapshot.capabilities.detachedHead, false)
    assert.equal(snapshot.currentBranch, 'main')
    assert.deepEqual(snapshot.files, [])
    assert.deepEqual(snapshot.stashes, [])
    assert.equal(
      snapshot.branches.some((branch) => branch.name === 'feature'),
      true,
    )

    const worktree = reportEntry(snapshot.capabilities, 'worktree')
    assert.equal(worktree.state, 'unsupported')
    assert.equal(worktree.restrictions.length > 0, true)
    for (const restriction of worktree.restrictions) {
      assert.match(restriction.reason, /no working tree/u)
    }

    const worktreeActions: GitAction[] = [
      { type: 'stage', paths: ['shared.txt'] },
      { type: 'switch', ref: 'refs/heads/feature' },
      { type: 'rebase', parent: 'main' },
      { type: 'createBranch', name: 'from-bare', parent: 'main' },
      {
        type: 'deleteBranch',
        ref: 'refs/heads/feature',
        force: true,
        expectedOid: git('rev-parse', 'feature'),
      },
      { type: 'setParent', branch: 'feature', parent: 'main' },
      { type: 'renameBranch', ref: 'refs/heads/feature', name: 'renamed' },
      {
        type: 'commit',
        message: 'nope',
        amend: false,
        expectedHead: git('rev-parse', 'HEAD'),
        expectedHeadRef: 'refs/heads/main',
      },
    ]
    for (const action of worktreeActions) {
      await assert.rejects(runAction(bare, action), /no working tree/u)
    }
    assert.equal(git('rev-parse', 'refs/heads/feature'), source('rev-parse', 'feature'))

    assert.equal(
      reportEntry(snapshot.capabilities, 'worktree').restrictions.some(
        (restriction) => restriction.operation === 'Delete branch',
      ),
      true,
    )

    // Reference and remote operations remain available.
    const target = join(root, 'target.git')
    execFileSync('git', ['init', '--bare', target], { stdio: 'pipe' })
    git('remote', 'add', 'mirror', target)
    git('config', 'branch.main.remote', 'mirror')
    git('config', 'branch.main.merge', 'refs/heads/main')
    await runAction(bare, { type: 'push' })
    assert.equal(gitIn(target)('rev-parse', 'refs/heads/main'), git('rev-parse', 'refs/heads/main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the reftable backend is reported and never manipulated as ref files', async (t) => {
  const root = await scratch()
  try {
    const probe = spawnSync(
      'git',
      ['init', '--ref-format=reftable', '-b', 'main', join(root, 'probe')],
      {
        encoding: 'utf8',
      },
    )
    if (probe.status !== 0) {
      const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
      t.skip(`${version} does not support the reftable backend: ${probe.stderr.trim()}`)
      return
    }

    const git = await initRepo(root, 'reftable', 'reftable')
    const repo = join(root, 'reftable')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    await writeFile(join(repo, 'shared.txt'), 'reftable stash\n')
    await runAction(repo, { type: 'stash', message: 'reftable stash', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]!

    const capabilities = (await getSnapshot(repo)).capabilities
    assert.equal(capabilities.refStorage, 'reftable')
    assert.equal(reportEntry(capabilities, 'ref-storage').state, 'limited')
    for (const type of ['stashPop', 'stashDrop'] as const) {
      await assert.rejects(
        runAction(repo, { type, ref: stash.ref, oid: stash.oid }),
        /reftable reference storage/u,
      )
      assert.equal(git('rev-parse', 'refs/stash'), stash.oid)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
