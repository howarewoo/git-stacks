import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getFileView, getSnapshot, runAction } from '../src/main/git'
import { getStackProgress, previewStack } from '../src/main/stacks'

type Git = (...args: string[]) => string

type Fixture = {
  root: string
  repo: string
  git: Git
  base: string
}

const fixtureRoots = new Set<string>()

test.after(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })))
  fixtureRoots.clear()
})

function gitAt(repo: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function withEnv(
  changes: Record<string, string | undefined>,
  action: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await action()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function fixture(originUrl?: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-stack-regression-'))
  fixtureRoots.add(root)
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) => gitAt(repo, args)
  git('init', '-b', 'main')
  git('config', '--local', 'init.defaultBranch', 'main')
  git('config', 'user.name', 'Git Stacks test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', '--local', 'commit.gpgSign', 'false')
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Initial commit')
  if (originUrl) git('remote', 'add', 'origin', originUrl)
  return { root, repo, git, base: git('rev-parse', 'HEAD') }
}

async function commitFile(
  repo: string,
  git: Git,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repo, file), content)
  git('add', '--', file)
  git('commit', '-m', message)
  return git('rev-parse', 'HEAD')
}

function tip(git: Git, branch: string): string {
  return git('rev-parse', `refs/heads/${branch}`)
}

function recordParent(git: Git, branch: string, parent: string, parentTip: string): void {
  git('config', '--local', `branch.${branch}.parent`, parent)
  git('config', '--local', `branch.${branch}.parentTip`, parentTip)
}

function executePreview(repo: string, token: string) {
  return runAction(repo, {
    type: 'executeStack',
    token,
    allowForce: false,
    draft: false,
    titles: {},
    mergeMethod: 'squash',
  })
}

async function prepareSimpleStack(originUrl?: string) {
  const state = await fixture(originUrl)
  const { repo, git, base } = state
  git('switch', '-c', 'root', base)
  const rootTip = await commitFile(repo, git, 'root.txt', 'root\n', 'Root change')
  recordParent(git, 'root', 'main', base)
  git('switch', '-c', 'parking', base)
  return { ...state, rootTip, parkingTip: tip(git, 'parking') }
}

async function prepareConflictStack() {
  const state = await fixture()
  const { repo, git, base } = state
  git('switch', '-c', 'root', base)
  const rootTip = await commitFile(repo, git, 'root.txt', 'root\n', 'Root change')
  recordParent(git, 'root', 'main', base)
  git('switch', '-c', 'child', 'root')
  const childTip = await commitFile(repo, git, 'shared.txt', 'child\n', 'Child change')
  recordParent(git, 'child', 'root', rootTip)
  git('switch', '-c', 'parking', base)
  git('switch', 'main')
  const mainTip = await commitFile(repo, git, 'shared.txt', 'main\n', 'Main change')
  git('switch', 'parking')
  return { ...state, rootTip, childTip, mainTip, parkingTip: tip(git, 'parking') }
}

test('restack moves every connected local ref onto an advanced parent and preserves siblings with updateRefs enabled', async () => {
  const { root, repo, git, base } = await fixture()
  git('switch', '-c', 'root', base)
  const rootOld = await commitFile(repo, git, 'root.txt', 'root\n', 'Root-only change')
  recordParent(git, 'root', 'main', base)
  git('switch', '-c', 'child', 'root')
  const childOld = await commitFile(repo, git, 'child.txt', 'child\n', 'Child-only change')
  recordParent(git, 'child', 'root', rootOld)
  git('switch', '-c', 'grandchild', 'child')
  const grandchildOld = await commitFile(
    repo,
    git,
    'grandchild.txt',
    'grandchild\n',
    'Grandchild-only change',
  )
  recordParent(git, 'grandchild', 'child', childOld)
  git('switch', '-c', 'sibling', 'root')
  const siblingOld = await commitFile(repo, git, 'sibling.txt', 'sibling\n', 'Sibling-only change')
  recordParent(git, 'sibling', 'root', rootOld)
  git('switch', '-c', 'unrelated', base)
  const unrelatedOld = tip(git, 'unrelated')
  git('switch', 'main')
  const mainTip = await commitFile(repo, git, 'main.txt', 'advanced default\n', 'Advanced default')
  git('switch', 'unrelated')
  git('config', '--local', 'rebase.updateRefs', 'true')

  const globalConfig = join(root, 'global.gitconfig')
  const globalEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig }
  gitAt(repo, ['config', '--global', 'rebase.updateRefs', 'true'], globalEnv)
  const before = {
    root: rootOld,
    child: childOld,
    grandchild: grandchildOld,
    sibling: siblingOld,
  }

  await withEnv({ GIT_CONFIG_GLOBAL: globalConfig }, async () => {
    const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'grandchild')
    assert.deepEqual(preview.blockers, [])
    await executePreview(repo, preview.token)
  })

  assert.notEqual(tip(git, 'root'), before.root)
  assert.notEqual(tip(git, 'child'), before.child)
  assert.notEqual(tip(git, 'grandchild'), before.grandchild)
  assert.notEqual(tip(git, 'sibling'), before.sibling)
  assert.equal(tip(git, 'main'), mainTip)
  assert.equal(tip(git, 'unrelated'), unrelatedOld)
  assert.equal(git('branch', '--show-current'), 'unrelated')
  assert.equal(git('status', '--porcelain'), '')

  for (const [branch, file, content, subject] of [
    ['root', 'root.txt', 'root', 'Root-only change'],
    ['child', 'child.txt', 'child', 'Child-only change'],
    ['grandchild', 'grandchild.txt', 'grandchild', 'Grandchild-only change'],
    ['sibling', 'sibling.txt', 'sibling', 'Sibling-only change'],
  ] as const) {
    assert.equal(git('show', `${branch}:${file}`), content)
    assert.ok(git('log', '--format=%s', branch).includes(subject))
    assert.equal(git('show', `${branch}:main.txt`), 'advanced default')
  }
})

test('restack refuses a captured default tip change before moving any branch', async () => {
  const { repo, git, base, rootTip } = await prepareSimpleStack()
  git('switch', 'main')
  await commitFile(repo, git, 'main-v1.txt', 'v1\n', 'Default v1')
  git('switch', 'parking')
  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'root')
  const rootBefore = tip(git, 'root')

  git('switch', 'main')
  const mainAfterPreview = await commitFile(repo, git, 'main-v2.txt', 'v2\n', 'Default v2')
  git('switch', 'parking')
  await assert.rejects(executePreview(repo, preview.token))

  assert.equal(tip(git, 'root'), rootBefore)
  assert.equal(rootBefore, rootTip)
  assert.equal(tip(git, 'main'), mainAfterPreview)
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(await getStackProgress(repo), null)
})

test('restack refuses changed parent metadata before moving any branch', async () => {
  const { repo, git } = await prepareSimpleStack()
  git('branch', 'other')
  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'root')
  const rootBefore = tip(git, 'root')
  git('config', '--local', 'branch.root.parent', 'other')

  await assert.rejects(executePreview(repo, preview.token))

  assert.equal(tip(git, 'root'), rootBefore)
  assert.equal(git('config', '--get', 'branch.root.parent'), 'other')
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(await getStackProgress(repo), null)
})

test('conflict recovery persists completed progress and continues after manual file resolution', async () => {
  const { repo, git, rootTip, childTip } = await prepareConflictStack()
  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'child')
  assert.deepEqual(preview.blockers, [])
  await assert.rejects(executePreview(repo, preview.token))

  const rewrittenRoot = tip(git, 'root')
  assert.notEqual(rewrittenRoot, rootTip)
  assert.equal(tip(git, 'child'), childTip)
  const progress = await getStackProgress(repo)
  assert.deepEqual(progress?.completed, ['root'])
  assert.deepEqual(progress?.remaining, ['child'])
  assert.equal(progress?.currentBranch, 'child')
  assert.deepEqual((await getSnapshot(repo)).stackOperation?.completed, ['root'])

  const conflict = await getFileView(repo, 'shared.txt')
  assert.equal(conflict.conflicted, true)
  await runAction(repo, {
    type: 'resolveFile',
    path: 'shared.txt',
    fingerprint: conflict.fingerprint,
    strategy: 'manual',
    content: 'resolved\n',
  })
  await runAction(repo, { type: 'stackContinue' })

  assert.equal(await getStackProgress(repo), null)
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('show', 'child:shared.txt'), 'resolved')
  assert.equal(git('show', 'child:root.txt'), 'root')
  assert.equal(git('config', '--get', 'branch.child.parentTip'), rewrittenRoot)
})

test('abort restores completed refs, metadata, and the original clean checkout', async () => {
  const { repo, git, rootTip, childTip, parkingTip } = await prepareConflictStack()
  const rootBoundary = git('config', '--get', 'branch.root.parentTip')
  const childBoundary = git('config', '--get', 'branch.child.parentTip')
  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'child')
  await assert.rejects(executePreview(repo, preview.token))
  assert.notEqual(tip(git, 'root'), rootTip)

  await runAction(repo, { type: 'stackAbort' })

  assert.equal(tip(git, 'root'), rootTip)
  assert.equal(tip(git, 'child'), childTip)
  assert.equal(git('config', '--get', 'branch.root.parent'), 'main')
  assert.equal(git('config', '--get', 'branch.root.parentTip'), rootBoundary)
  assert.equal(git('config', '--get', 'branch.child.parent'), 'root')
  assert.equal(git('config', '--get', 'branch.child.parentTip'), childBoundary)
  assert.equal(tip(git, 'parking'), parkingTip)
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(await getStackProgress(repo), null)
})

test('abort refuses an externally drifted completed ref without rolling back its journal state', async () => {
  const { repo, git, rootTip, childTip, mainTip } = await prepareConflictStack()
  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'child')
  await assert.rejects(executePreview(repo, preview.token))
  const rewrittenRoot = tip(git, 'root')
  assert.notEqual(rewrittenRoot, rootTip)
  assert.notEqual(mainTip, rewrittenRoot)
  git('update-ref', 'refs/heads/root', mainTip)

  await assert.rejects(runAction(repo, { type: 'stackAbort' }))

  assert.equal(tip(git, 'root'), mainTip)
  assert.equal(tip(git, 'child'), childTip)
  assert.equal(git('config', '--get', 'branch.root.parentTip'), mainTip)
  const progress = await getStackProgress(repo)
  assert.deepEqual(progress?.completed, ['root'])
  assert.deepEqual(progress?.remaining, ['child'])
})

test('setParent rejects cycles and preserves the original cutoff while reparenting', async () => {
  const { repo, git, base } = await fixture()
  git('switch', '-c', 'a', base)
  const aTip = await commitFile(repo, git, 'a.txt', 'a\n', 'A change')
  recordParent(git, 'a', 'main', base)
  git('switch', '-c', 'b', 'a')
  const bTip = await commitFile(repo, git, 'b.txt', 'b\n', 'B change')
  recordParent(git, 'b', 'a', aTip)
  git('switch', '-c', 'c', base)
  await commitFile(repo, git, 'c.txt', 'c\n', 'C change')
  recordParent(git, 'c', 'main', base)
  git('switch', '-c', 'parking', base)

  await assert.rejects(runAction(repo, { type: 'setParent', branch: 'a', parent: 'b' }))
  assert.equal(git('config', '--get', 'branch.a.parent'), 'main')
  assert.equal(git('config', '--get', 'branch.a.parentTip'), base)

  await runAction(repo, { type: 'setParent', branch: 'b', parent: 'c' })
  assert.equal(tip(git, 'b'), bTip)
  assert.equal(git('config', '--get', 'branch.b.parent'), 'c')
  assert.equal(git('config', '--get', 'branch.b.parentTip'), aTip)
  assert.equal(git('branch', '--show-current'), 'parking')
})

test('restack blocks nonlinear merge ranges without losing a manual merge resolution', async () => {
  const { repo, git, base } = await fixture()
  git('switch', '-c', 'root', base)
  await commitFile(repo, git, 'shared.txt', 'root\n', 'Root side')
  recordParent(git, 'root', 'main', base)
  git('switch', '-c', 'side', base)
  await commitFile(repo, git, 'shared.txt', 'side\n', 'Side change')
  git('switch', 'root')
  try {
    git('merge', '--no-ff', 'side', '-m', 'Merge side')
  } catch {
    await writeFile(join(repo, 'shared.txt'), 'manual merge\n')
    git('add', '--', 'shared.txt')
    git('commit', '-m', 'Merge side manually')
  }
  const mergeTip = tip(git, 'root')
  git('switch', '-c', 'parking', base)

  const preview = await previewStack(repo, await getSnapshot(repo), 'restack', 'root')
  assert.ok(preview.blockers.length > 0)
  await assert.rejects(executePreview(repo, preview.token))

  assert.equal(tip(git, 'root'), mergeTip)
  assert.equal(git('show', 'root:shared.txt'), 'manual merge')
  assert.equal(git('rev-list', '--parents', '-n', '1', 'root').split(/\s+/u).length, 3)
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
})

test('offline local restack ignores an unavailable non-GitHub origin', async () => {
  const { root, repo, git } = await prepareSimpleStack('ssh://git@offline.invalid/owner/repo.git')
  git('switch', 'main')
  await commitFile(repo, git, 'main-only.txt', 'main\n', 'Advanced default')
  git('switch', 'parking')
  const sshCalls = join(root, 'ssh-calls.log')
  const sshScript = join(root, 'ssh-blocker.sh')
  await writeFile(sshScript, '#!/bin/sh\nprintf "called\\n" >> "$GIT_STACKS_SSH_LOG"\nexit 42\n')
  await chmod(sshScript, 0o755)

  await withEnv(
    {
      GIT_SSH_COMMAND: sshScript,
      GIT_STACKS_SSH_LOG: sshCalls,
    },
    async () => {
      const snapshot = await getSnapshot(repo)
      assert.equal(snapshot.github.available, false)
      const preview = await previewStack(repo, snapshot, 'restack', 'root')
      assert.deepEqual(preview.blockers, [])
      await executePreview(repo, preview.token)
    },
  )

  let calls = ''
  try {
    calls = await readFile(sshCalls, 'utf8')
  } catch {
    // No SSH invocation is the expected result.
  }
  assert.equal(calls, '')
  assert.equal(git('branch', '--show-current'), 'parking')
  assert.equal(git('status', '--porcelain'), '')
})
