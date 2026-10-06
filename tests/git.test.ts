import assert from 'node:assert/strict'
import type {
  ChildProcess,
  ExecFileOptions,
  execFileSync as ExecFileSyncFunction,
  spawnSync as SpawnSyncFunction,
} from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { beginGitRace, runRealGit } from './fixtures/git-race-shim'
import type { GitAction } from '../src/shared/types'
import { getCombinedBranches, sortBranchesByUpdatedAt } from '../src/renderer/src/lib/branches'

type ExecFileDone = (error: Error | null, stdout: string, stderr: string) => void
type PromisifiedExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>

interface ExecFileBoundary {
  (
    file: string,
    args?: readonly string[],
    options?: ExecFileOptions,
    callback?: ExecFileDone,
  ): ChildProcess
  /** Git Stacks promisifies this boundary, and only this form reports both streams. */
  [promisify.custom]: PromisifiedExecFile
}

interface SpawnBoundary {
  (command: string, args?: readonly string[], options?: unknown): ChildProcess
}

interface ChildProcessModule {
  execFile: ExecFileBoundary
  execFileSync: typeof ExecFileSyncFunction
  spawn: SpawnBoundary
  spawnSync: typeof SpawnSyncFunction
}

/**
 * A Git Stacks scenario that the shared race fixture cannot express, because it
 * does not wrap a boundary the fixture leaves alone or because the Git it would
 * have to answer is one no installed Git produces.
 */
interface ArmedScenario {
  /** Answers a claimed Git Stacks request itself; null runs real Git. */
  respond?: (args: readonly string[]) => string | null
  /** Runs before Git Stacks spawns its first reference transaction. */
  beforeRefTransaction?: () => void
  /** Runs once Git Stacks' first reference transaction has committed. */
  afterRefTransaction?: () => void
}

interface GitScenario {
  end(): void
}

/**
 * Node freezes a builtin's ESM named exports the first time a module links it,
 * so this file reaches `node:child_process` through `createRequire`: a runtime
 * import of the builtin would bind Git Stacks to the unpatched spawn API before
 * the race fixture shims it. Every boundary below is installed before the
 * dynamic import that loads the Git Stacks modules under test, because they
 * capture the spawn API when their own modules load.
 */
const childProcess = createRequire(import.meta.url)('node:child_process') as ChildProcessModule
const { execFileSync, spawnSync } = childProcess

// Git Stacks spawns the Git it resolved, `git.exe` on Windows and `git`
// elsewhere, which the shared race fixture matches on the same way.
const GIT_EXECUTABLE = /(?:^|[\\/])git(?:\.exe)?$/u

let armed: ArmedScenario | null = null
let refTransactionClaimed = false

const realExecFile = childProcess.execFile

/**
 * The answer an armed scenario gives a Git Stacks request, or null when the
 * real Git boundary has to run. Both forms of the boundary below decide this
 * the same way, because a divergence between them would arm a race on the
 * callback form only.
 */
function claimedResponse(file: string, args: readonly string[]): string | null {
  const respond = armed?.respond
  return respond && GIT_EXECUTABLE.test(file) ? respond(args) : null
}

childProcess.execFile = Object.assign(
  (
    file: string,
    args: readonly string[] = [],
    options?: ExecFileOptions | ExecFileDone,
    callback?: ExecFileDone,
  ): ChildProcess => {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    const stdout = claimedResponse(file, args)
    if (stdout === null) return realExecFile(file, args, options, callback)
    if (!callback) throw new Error(`Git Stacks read ${args.join(' ')} without a callback`)
    queueMicrotask(() => callback(null, `${stdout}\n`, ''))
    return {} as ChildProcess
  },
  {
    // Git Stacks reads command output only through the promisified form, and
    // only this form reports both streams the way the real one does.
    [promisify.custom]: (file: string, args: readonly string[], options: ExecFileOptions) => {
      const stdout = claimedResponse(file, args)
      if (stdout === null) return realExecFile[promisify.custom](file, args, options)
      return Promise.resolve({ stdout: `${stdout}\n`, stderr: '' })
    },
  },
)

const realSpawn = childProcess.spawn
childProcess.spawn = (
  command: string,
  args: readonly string[] = [],
  options?: unknown,
): ChildProcess => {
  const claims =
    !refTransactionClaimed &&
    GIT_EXECUTABLE.test(command) &&
    args[0] === 'update-ref' &&
    Boolean(armed?.beforeRefTransaction || armed?.afterRefTransaction)
  if (claims) refTransactionClaimed = true
  // The window before the child exists is the only one in which the branch ref
  // is still unlocked after Git Stacks' pre-check and before its recheck.
  if (claims) armed?.beforeRefTransaction?.()
  const child = realSpawn(command, args, options)
  if (claims && armed?.afterRefTransaction) {
    child.prependOnceListener('close', armed.afterRefTransaction)
  }
  return child
}

function beginScenario(scenario: ArmedScenario): GitScenario {
  if (armed) throw new Error('A Git Stacks scenario is already armed.')
  armed = scenario
  refTransactionClaimed = false
  return {
    end() {
      armed = null
      refTransactionClaimed = false
    },
  }
}

// Git Stacks captures Node's spawn API when its own modules load, and the race
// fixture shims that API, so the Git Stacks modules under test are loaded here.
const { getSnapshot, resolveRepository, runAction } = await import('../src/main/git')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-test-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  // Git is spawned by the name every platform resolves, because Windows has no
  // `which` and no extensionless executable on PATH.
  const git = (...args: string[]) => runRealGit(repo, args)
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
test('explicit carry keeps tracked and untracked edits and refuses overwrites', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('branch', 'feature')
    await writeFile(join(repo, 'shared.txt'), 'unsaved work\n')
    await writeFile(join(repo, 'private.txt'), 'untracked work\n')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/feature', carry: true })
    assert.equal(git('branch', '--show-current'), 'feature')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'unsaved work\n')
    assert.equal(await readFile(join(repo, 'private.txt'), 'utf8'), 'untracked work\n')
    await rm(join(repo, 'private.txt'))
    git('add', 'shared.txt')
    git('commit', '-m', 'Feature edits')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/main' })
    await writeFile(join(repo, 'shared.txt'), 'different main version\n')
    git('add', 'shared.txt')
    git('commit', '-m', 'Main edits')
    await runAction(repo, { type: 'switch', ref: 'refs/heads/feature' })
    await writeFile(join(repo, 'shared.txt'), 'new unsaved feature work\n')
    await assert.rejects(runAction(repo, { type: 'switch', ref: 'refs/heads/main', carry: true }))
    assert.equal(git('branch', '--show-current'), 'feature')
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'new unsaved feature work\n')
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
    await runAction(repo, {
      type: 'commit',
      message: 'Rename a literal path',
      amend: false,
      expectedHead: git('rev-parse', 'HEAD'),
      expectedHeadRef: 'refs/heads/main',
    })
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
    await runAction(repo, {
      type: 'commit',
      message: 'First commit',
      amend: false,
      expectedHead: null,
      expectedHeadRef: 'refs/heads/main',
    })
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
    await assert.rejects(runAction(repo, { type: 'pull', strategy: 'ff-only' }))
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
    await runAction(repo, { type: 'stash', message: 'test stash', includeUntracked: true })
    const stashed = await getSnapshot(repo)
    assert.deepEqual(stashed.files, [])
    await assert.rejects(readFile(join(repo, 'notes [draft].txt')))
    await runAction(repo, {
      type: 'stashPop',
      ref: stashed.stashes[0].ref,
      oid: stashed.stashes[0].oid,
    })
    const restored = await getSnapshot(repo)
    assert.equal(await readFile(join(repo, 'notes [draft].txt'), 'utf8'), 'untracked notes\n')
    assert.equal(restored.files.find((file) => file.path === 'shared.txt')?.index, 'M')
    assert.deepEqual(restored.stashes, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dropping the final packed stash removes refs/stash from packed-refs', async () => {
  const { root, repo, git } = await fixture()
  try {
    await writeFile(join(repo, 'shared.txt'), 'packed stash\n')
    await runAction(repo, { type: 'stash', message: 'packed stash', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]!
    git('tag', 'keep-packed-ref')
    git('pack-refs', '--all', '--prune')

    const refPath = resolve(repo, git('rev-parse', '--git-path', 'refs/stash'))
    const packedRefsPath = resolve(repo, git('rev-parse', '--git-path', 'packed-refs'))
    await assert.rejects(readFile(refPath))
    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/stash'), 'refs/stash')
    assert.match(
      await readFile(packedRefsPath, 'utf8'),
      new RegExp(`^${stash.oid} refs/stash$`, 'm'),
    )

    await runAction(repo, { type: 'stashDrop', ref: stash.ref, oid: stash.oid })

    assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/stash'), '')
    assert.equal(git('rev-parse', 'refs/tags/keep-packed-ref'), git('rev-parse', 'HEAD'))
    assert.equal((await readFile(packedRefsPath, 'utf8')).includes('refs/stash'), false)
    assert.deepEqual((await getSnapshot(repo)).stashes, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stash drop resolves relative ref paths from a custom files URI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-test-'))
  const repo = join(root, 'workspace')
  const refsStore = join(root, 'custom refs')
  await mkdir(repo)
  const git = (...args: string[]) => runRealGit(repo, args)
  const stashFiles = new Set([
    'refs/stash',
    'refs/stash.lock',
    'logs/refs/stash',
    'logs/refs/stash.lock',
    'packed-refs',
    'packed-refs.lock',
  ])
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Git Stacks test')
    git('config', 'user.email', 'test@example.invalid')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    await symlink(resolve(repo, git('rev-parse', '--git-common-dir')), refsStore)

    await writeFile(join(repo, 'shared.txt'), 'custom ref store stash\n')
    await runAction(repo, { type: 'stash', message: 'custom refs', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]!
    const refPath = join(refsStore, 'refs', 'stash')
    assert.equal((await readFile(refPath, 'utf8')).trim(), stash.oid)

    // No installed Git reports this ref storage: Git rejects a `files://…`
    // `extensions.refstorage` value while reading its own config, so the value
    // Git Stacks resolves and the repo-relative paths Git reports for the stash
    // files are answered here instead of by a Git on PATH. The files URI keeps
    // the platform's own path shape, which is what Git Stacks resolves back.
    const refStorage = `files://${pathToFileURL(refsStore).pathname}`
    let served = 0
    const race = beginScenario({
      respond: (args) => {
        if (args[0] === 'config' && args[1] === '--get' && args[2] === 'extensions.refstorage') {
          served += 1
          return refStorage
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path' && stashFiles.has(args[2] ?? '')) {
          return args[2]!
        }
        return null
      },
    })
    try {
      await runAction(repo, { type: 'stashDrop', ref: stash.ref, oid: stash.oid })
    } finally {
      race.end()
    }

    assert.ok(served > 0, 'Git Stacks never read the configured ref storage')
    await assert.rejects(readFile(refPath))
    assert.deepEqual((await getSnapshot(repo)).stashes, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stash drop safely rejects a non-files reference backend', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-test-'))
  const repo = join(root, 'workspace')
  await mkdir(repo)
  const git = (...args: string[]) => runRealGit(repo, args)
  try {
    const init = spawnSync('git', ['init', '--ref-format=reftable', '-b', 'main', repo], {
      encoding: 'utf8',
    })
    if (init.status !== 0) {
      const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
      t.skip(`${version} does not support the reftable backend: ${init.stderr.trim()}`)
      return
    }
    git('config', 'user.name', 'Git Stacks test')
    git('config', 'user.email', 'test@example.invalid')
    await writeFile(join(repo, 'shared.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'Initial commit')
    await writeFile(join(repo, 'shared.txt'), 'reftable stash\n')
    await runAction(repo, { type: 'stash', message: 'reftable stash', includeUntracked: false })
    const stash = (await getSnapshot(repo)).stashes[0]!

    await assert.rejects(
      runAction(repo, { type: 'stashDrop', ref: stash.ref, oid: stash.oid }),
      /reftable reference storage/u,
    )
    assert.equal(git('rev-parse', 'refs/stash'), stash.oid)
    assert.deepEqual(
      (await getSnapshot(repo)).stashes.map(({ oid }) => oid),
      [stash.oid],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stash drop preserves shared reference and reflog permissions', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('config', 'core.sharedRepository', 'group')
    for (const value of ['first stash\n', 'second stash\n', 'third stash\n']) {
      await writeFile(join(repo, 'shared.txt'), value)
      await runAction(repo, { type: 'stash', message: value.trim(), includeUntracked: false })
    }
    const refPath = resolve(repo, git('rev-parse', '--git-path', 'refs/stash'))
    const logPath = resolve(repo, git('rev-parse', '--git-path', 'logs/refs/stash'))
    const packedRefsPath = resolve(repo, git('rev-parse', '--git-path', 'packed-refs'))
    git('pack-refs', '--all', '--prune')
    await assert.rejects(readFile(refPath))

    const stashes = (await getSnapshot(repo)).stashes
    await runAction(repo, { type: 'stashDrop', ref: stashes[0]!.ref, oid: stashes[0]!.oid })

    const materializedRefMode = (await stat(refPath)).mode & 0o777
    const reflogMode = (await stat(logPath)).mode & 0o777
    assert.notEqual(materializedRefMode & 0o020, 0)
    assert.notEqual(reflogMode & 0o020, 0)
    assert.equal((await readFile(packedRefsPath, 'utf8')).includes('refs/stash'), false)

    await chmod(refPath, 0o660)
    await chmod(logPath, 0o660)
    const remaining = (await getSnapshot(repo)).stashes[0]!
    await runAction(repo, { type: 'stashDrop', ref: remaining.ref, oid: remaining.oid })

    assert.equal((await stat(refPath)).mode & 0o777, 0o660)
    assert.equal((await stat(logPath)).mode & 0o777, 0o660)
    assert.equal(git('rev-parse', 'refs/stash'), (await getSnapshot(repo)).stashes[0]!.oid)
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
    const unresolved = snapshot.reconciliation?.stacks.find((stack) =>
      stack.members.some((member) => member.branch === 'child'),
    )
    assert.equal(unresolved?.state, 'ambiguous')
    assert.match(unresolved.blockers.join(' '), /Recorded parent fetched-parent.*unavailable/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('local deletion preserves remote refs, child branches, and uncommitted work', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('branch', 'merged')
    git('branch', 'child', 'merged')
    git('config', 'branch.child.parent', 'merged')
    const tip = git('rev-parse', 'merged')
    git('update-ref', 'refs/remotes/origin/merged', tip)
    await writeFile(join(repo, 'shared.txt'), 'staged work\n')
    git('add', 'shared.txt')
    const staged = git('diff', '--cached')
    await writeFile(join(repo, 'shared.txt'), 'unsaved work\n')

    await runAction(repo, {
      type: 'deleteBranch',
      ref: 'refs/heads/merged',
      force: false,
      expectedOid: tip,
    })
    const snapshot = await getSnapshot(repo)
    assert.equal(
      snapshot.branches.some((branch) => branch.ref === 'refs/heads/merged'),
      false,
    )
    assert.equal(git('rev-parse', 'refs/remotes/origin/merged'), tip)
    assert.equal(git('rev-parse', 'refs/heads/child'), tip)
    assert.equal(git('config', '--get', 'branch.child.parent'), 'merged')
    assert.equal(git('branch', '--show-current'), 'main')
    assert.equal(git('diff', '--cached'), staged)
    assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), 'unsaved work\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bulk deletion removes local refs and their configurations without touching remote refs', async () => {
  const { root, repo, git } = await fixture()
  try {
    const expectedOid = git('rev-parse', 'main')
    const branches = ['first', 'second'].map((name) => {
      git('branch', name)
      git('config', `branch.${name}.parent`, 'main')
      git('update-ref', `refs/remotes/origin/${name}`, expectedOid)
      return { ref: `refs/heads/${name}`, expectedOid }
    })
    await runAction(repo, { type: 'deleteBranches', branches, force: false })
    for (const name of ['first', 'second']) {
      assert.throws(() => git('show-ref', '--verify', '--quiet', `refs/heads/${name}`))
      assert.throws(() => git('config', '--get', `branch.${name}.parent`))
      assert.equal(git('rev-parse', `refs/remotes/origin/${name}`), expectedOid)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bulk deletion rejects a member changed before transaction preparation without deleting its peers', async () => {
  const { root, repo, git } = await fixture()
  try {
    const expectedOid = git('rev-parse', 'main')
    git('branch', 'first')
    git('branch', 'second')
    git('commit', '--allow-empty', '-m', 'Replacement tip')
    const replacementOid = git('rev-parse', 'main')
    const race = beginScenario({
      beforeRefTransaction: () => {
        runRealGit(repo, ['update-ref', 'refs/heads/second', replacementOid])
      },
    })
    try {
      await assert.rejects(
        runAction(repo, {
          type: 'deleteBranches',
          branches: ['first', 'second'].map((name) => ({ ref: `refs/heads/${name}`, expectedOid })),
          force: false,
        }),
        /changed since it was selected/u,
      )
    } finally {
      race.end()
    }
    assert.equal(git('rev-parse', 'first'), expectedOid)
    assert.equal(git('rev-parse', 'second'), replacementOid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bulk deletion rejects unmerged and protected members as a batch, with force only bypassing merge checks', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('branch', 'merged')
    const mergedOid = git('rev-parse', 'merged')
    git('switch', '-c', 'unmerged')
    git('commit', '--allow-empty', '-m', 'Unmerged commit')
    const unmergedOid = git('rev-parse', 'unmerged')
    git('switch', 'main')
    const merged = { ref: 'refs/heads/merged', expectedOid: mergedOid }
    const unmerged = { ref: 'refs/heads/unmerged', expectedOid: unmergedOid }
    await assert.rejects(
      runAction(repo, { type: 'deleteBranches', branches: [merged, unmerged], force: false }),
      /not fully merged/u,
    )
    assert.equal(git('rev-parse', 'merged'), mergedOid)
    assert.equal(git('rev-parse', 'unmerged'), unmergedOid)
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranches',
        branches: [merged, { ref: 'refs/heads/main', expectedOid: git('rev-parse', 'main') }],
        force: true,
      }),
      /current branch/u,
    )
    assert.equal(git('rev-parse', 'merged'), mergedOid)
    git('worktree', 'add', join(root, 'linked'), 'unmerged')
    await assert.rejects(
      runAction(repo, { type: 'deleteBranches', branches: [merged, unmerged], force: true }),
    )
    assert.equal(git('rev-parse', 'merged'), mergedOid)
    assert.equal(git('rev-parse', 'unmerged'), unmergedOid)
    git('worktree', 'remove', join(root, 'linked'))
    await runAction(repo, { type: 'deleteBranches', branches: [merged, unmerged], force: true })
    assert.throws(() => git('show-ref', '--verify', '--quiet', merged.ref))
    assert.throws(() => git('show-ref', '--verify', '--quiet', unmerged.ref))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bulk deletion validates nonempty unique local targets and object IDs before changing refs', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('branch', 'selected')
    const expectedOid = git('rev-parse', 'selected')
    const target = { ref: 'refs/heads/selected', expectedOid }
    for (const branches of [
      [],
      [target, target],
      [target, { ref: 'refs/remotes/origin/main', expectedOid }],
      [target, { ref: 'refs/heads/other', expectedOid: 'invalid' }],
      [target, { ref: 'refs/heads/other', expectedOid }],
    ]) {
      await assert.rejects(runAction(repo, { type: 'deleteBranches', branches, force: true }))
      assert.equal(git('rev-parse', 'selected'), expectedOid)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bulk deletion rechecks every worktree claim while all target refs are locked', async () => {
  const { root, repo, git } = await fixture()
  try {
    const expectedOid = git('rev-parse', 'main')
    git('branch', 'first')
    git('branch', 'second')
    const race = beginScenario({
      beforeRefTransaction: () => {
        runRealGit(repo, ['worktree', 'add', join(root, 'linked'), 'second'])
      },
    })
    try {
      await assert.rejects(
        runAction(repo, {
          type: 'deleteBranches',
          branches: ['first', 'second'].map((name) => ({ ref: `refs/heads/${name}`, expectedOid })),
          force: true,
        }),
        /checked out in another worktree/u,
      )
    } finally {
      race.end()
    }
    assert.equal(git('rev-parse', 'first'), expectedOid)
    assert.equal(git('rev-parse', 'second'), expectedOid)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch deletion preserves config for a same-name branch recreated before cleanup', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    const deletedTip = git('rev-parse', 'HEAD')
    git('switch', 'main')
    git('commit', '--allow-empty', '-m', 'Advance replacement branch')
    const replacementTip = git('rev-parse', 'HEAD')
    git('config', 'branch.racing.parent', 'old-parent')

    const recreated = join(root, 'branch-recreated')
    // The branch has to reappear once the deletion transaction has committed and
    // before Git Stacks locks the absent ref for its configuration cleanup, so
    // the cleanup finds the ref present and leaves the new branch's config be.
    const race = beginScenario({
      afterRefTransaction: () => {
        runRealGit(repo, ['update-ref', 'refs/heads/racing', replacementTip])
        runRealGit(repo, ['config', 'branch.racing.parent', 'replacement-parent'])
        writeFileSync(recreated, '')
      },
    })
    try {
      await runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/racing',
        force: false,
        expectedOid: deletedTip,
      })
    } finally {
      race.end()
    }

    assert.equal(await readFile(recreated, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/racing'), replacementTip)
    assert.equal(git('config', '--get', 'branch.racing.parent'), 'replacement-parent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merged deletion resolves the upstream ref despite a same-named local branch', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
    git('switch', '-c', 'feature')
    git('commit', '--allow-empty', '-m', 'Feature commit')
    const featureTip = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/feature', featureTip)
    git('switch', 'main')
    git('branch', 'origin/feature', 'main')
    git('config', 'branch.feature.remote', 'origin')
    git('config', 'branch.feature.merge', 'refs/heads/feature')

    assert.equal(
      git('rev-parse', '--symbolic-full-name', 'feature@{upstream}'),
      'refs/remotes/origin/feature',
    )
    await runAction(repo, {
      type: 'deleteBranch',
      ref: 'refs/heads/feature',
      force: false,
      expectedOid: featureTip,
    })

    assert.throws(() => git('show-ref', '--verify', '--quiet', 'refs/heads/feature'))
    assert.equal(git('rev-parse', 'refs/heads/origin/feature'), git('rev-parse', 'main'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merged deletion uses the upstream object captured before a concurrent fetch', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('remote', 'add', 'origin', 'https://example.invalid/repo.git')
    git('switch', '-c', 'feature')
    git('commit', '--allow-empty', '-m', 'Feature commit')
    const featureTip = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/feature', featureTip)
    git('config', 'branch.feature.remote', 'origin')
    git('config', 'branch.feature.merge', 'refs/heads/feature')
    const baseTip = git('rev-parse', 'main')
    git('switch', 'main')

    const fetchFlag = join(root, 'upstream-advanced')
    // The merge check reads the upstream ref Git Stacks captured, so a fetch
    // that advances the remote branch lands between that capture and the
    // deletion the app then performs.
    const race = beginGitRace({
      matches: (args) => args[0] === 'merge-base' && args[1] === '--is-ancestor',
      inject: () => {
        runRealGit(repo, ['update-ref', 'refs/remotes/origin/feature', baseTip])
        writeFileSync(fetchFlag, '')
      },
    })
    try {
      await runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/feature',
        force: false,
        expectedOid: featureTip,
      })
    } finally {
      race.end()
    }

    assert.equal(await readFile(fetchFlag, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/remotes/origin/feature'), baseTip)
    assert.throws(() => git('show-ref', '--verify', '--quiet', 'refs/heads/feature'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unmerged deletion requires an explicit boolean force opt-in', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'unmerged')
    await writeFile(join(repo, 'unique.txt'), 'unmerged work\n')
    git('add', '.')
    git('commit', '-m', 'Unmerged work')
    const tip = git('rev-parse', 'HEAD')
    git('switch', 'main')
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/unmerged',
        force: false,
        expectedOid: tip,
      }),
    )
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/unmerged',
        force: 'false',
        expectedOid: tip,
      } as unknown as GitAction),
    )
    assert.equal(git('rev-parse', 'unmerged'), tip)

    await runAction(repo, {
      type: 'deleteBranch',
      ref: 'refs/heads/unmerged',
      force: true,
      expectedOid: tip,
    })
    assert.equal(
      (await getSnapshot(repo)).branches.some((branch) => branch.name === 'unmerged'),
      false,
    )
    assert.equal(git('branch', '--show-current'), 'main')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('force deletion cannot bypass root, current, worktree, remote, or operation protection', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('config', 'init.defaultBranch', 'main')
    git('worktree', 'add', '-b', 'occupied', join(root, 'linked'), 'main')
    git('switch', '-c', 'current')
    const tip = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/remote-only', tip)
    for (const ref of [
      'refs/heads/main',
      'refs/heads/current',
      'refs/heads/occupied',
      'refs/remotes/origin/remote-only',
    ]) {
      await assert.rejects(
        runAction(repo, { type: 'deleteBranch', ref, force: true, expectedOid: tip }),
      )
      assert.equal(git('rev-parse', ref), tip)
    }
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/-D',
        force: true,
        expectedOid: tip,
      }),
    )
    git('branch', 'during-operation')
    await writeFile(join(repo, '.git', 'CHERRY_PICK_HEAD'), `${tip}\n`)
    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/during-operation',
        force: true,
        expectedOid: tip,
      }),
    )
    assert.equal(git('rev-parse', 'during-operation'), tip)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch deletion protects a branch being rebased in a detached linked worktree', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'feature')
    await writeFile(join(repo, 'shared.txt'), 'feature change\n')
    git('add', '.')
    git('commit', '-m', 'Feature change')
    const featureTip = git('rev-parse', 'HEAD')
    git('switch', 'main')
    await writeFile(join(repo, 'shared.txt'), 'main change\n')
    git('add', '.')
    git('commit', '-m', 'Main change')

    const linked = join(root, 'linked')
    git('worktree', 'add', linked, 'feature')
    const linkedGit = (...args: string[]) => runRealGit(linked, args)
    assert.throws(() => linkedGit('rebase', 'main'))
    assert.match(git('worktree', 'list', '--porcelain'), /detached/u)
    const gitDir = linkedGit('rev-parse', '--absolute-git-dir')
    assert.equal(
      (await readFile(join(gitDir, 'rebase-merge', 'head-name'), 'utf8')).trim(),
      'refs/heads/feature',
    )

    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/feature',
        force: true,
        expectedOid: featureTip,
      }),
      /checked out in another worktree/u,
    )
    assert.equal(git('rev-parse', 'refs/heads/feature'), featureTip)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch deletion rechecks worktrees after locking the branch ref', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    git('commit', '--allow-empty', '-m', 'Racing branch')
    const racingTip = git('rev-parse', 'HEAD')
    git('switch', 'main')

    const linked = join(root, 'linked')
    const created = join(root, 'linked-created')
    // The linked worktree has to appear after the check Git Stacks makes before
    // it locks the branch ref and while that ref is still unlocked, so the
    // recheck it makes with the lock held is the one that refuses the deletion.
    const race = beginScenario({
      beforeRefTransaction: () => {
        runRealGit(repo, ['worktree', 'add', linked, 'racing'])
        writeFileSync(created, '')
      },
    })
    try {
      await assert.rejects(
        runAction(repo, {
          type: 'deleteBranch',
          ref: 'refs/heads/racing',
          force: true,
          expectedOid: racingTip,
        }),
        /checked out in another worktree/u,
      )
    } finally {
      race.end()
    }
    assert.equal(await readFile(created, 'utf8'), '')
    assert.equal(git('rev-parse', 'refs/heads/racing'), racingTip)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch deletion protects claims from missing prunable worktrees', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    git('commit', '--allow-empty', '-m', 'Racing branch')
    const racingTip = git('rev-parse', 'HEAD')
    git('switch', 'main')
    const linked = join(root, 'linked')
    git('worktree', 'add', linked, 'racing')
    await rm(linked, { recursive: true, force: true })
    const worktrees = git('worktree', 'list', '--porcelain')
    assert.match(worktrees, /branch refs\/heads\/racing/u)
    assert.match(worktrees, /prunable/u)

    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/racing',
        force: true,
        expectedOid: racingTip,
      }),
      /checked out in another worktree/u,
    )
    assert.equal(git('rev-parse', 'refs/heads/racing'), racingTip)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('force deletion rejects a branch that advanced after its tip was captured', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    await writeFile(join(repo, 'racing.txt'), 'racing work\n')
    git('add', '.')
    git('commit', '-m', 'Racing work')
    const captured = git('rev-parse', 'HEAD')
    git('switch', 'main')
    git('commit', '--allow-empty', '-m', 'Advance main')
    git('update-ref', 'refs/heads/racing', 'HEAD')
    const advanced = git('rev-parse', 'refs/heads/racing')
    assert.notEqual(advanced, captured)

    await assert.rejects(
      runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/racing',
        force: true,
        expectedOid: captured,
      }),
      { message: /refresh before deleting/ },
    )
    assert.equal(git('rev-parse', 'refs/heads/racing'), advanced)

    await runAction(repo, {
      type: 'deleteBranch',
      ref: 'refs/heads/racing',
      force: true,
      expectedOid: advanced,
    })
    assert.equal(
      (await getSnapshot(repo)).branches.some((branch) => branch.ref === 'refs/heads/racing'),
      false,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('force deletion rejects a branch that advances between validation and removal', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    await writeFile(join(repo, 'racing.txt'), 'racing work\n')
    git('add', '.')
    git('commit', '-m', 'Racing work')
    const captured = git('rev-parse', 'HEAD')
    git('switch', 'main')
    git('commit', '--allow-empty', '-m', 'Advance main')
    const advanced = git('rev-parse', 'HEAD')
    assert.notEqual(advanced, captured)

    // The race advances the ref in the window the action cannot close: after
    // Git Stacks read the tip it validated against the expected OID, and before
    // the deletion transaction it locks that tip with.
    let validated = false
    const race = beginGitRace({
      matches: (args) => {
        if (args.includes('refs/heads/racing^{commit}')) {
          validated = true
          return false
        }
        return validated && args[0] === 'worktree' && args[1] === 'list'
      },
      inject: () => {
        runRealGit(repo, ['update-ref', 'refs/heads/racing', advanced])
      },
    })
    try {
      await assert.rejects(
        runAction(repo, {
          type: 'deleteBranch',
          ref: 'refs/heads/racing',
          force: true,
          expectedOid: captured,
        }),
        { message: /refresh before deleting/ },
      )
    } finally {
      race.end()
    }
    assert.equal(git('rev-parse', 'refs/heads/racing'), advanced)
    assert.equal(
      (await getSnapshot(repo)).branches.some((branch) => branch.ref === 'refs/heads/racing'),
      true,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('branch deletion commits its ref before metadata cleanup', async () => {
  const { root, repo, git } = await fixture()
  try {
    git('switch', '-c', 'racing')
    git('commit', '--allow-empty', '-m', 'Captured branch tip')
    const captured = git('rev-parse', 'HEAD')
    git('switch', 'main')
    git('config', 'branch.racing.parent', 'old-parent')
    git('config', 'branch.racing.remote', 'old-remote')

    const cleanupState = join(root, 'ref-state-during-cleanup')
    // Recording the ref as Git Stacks removes the branch configuration shows
    // the deletion transaction had already committed when the cleanup ran.
    const race = beginGitRace({
      matches: (args) => args.includes('--remove-section') && args.includes('branch.racing'),
      inject: () => {
        let present = true
        try {
          runRealGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/racing'])
        } catch {
          present = false
        }
        writeFileSync(cleanupState, present ? 'present\n' : 'absent\n')
      },
    })
    try {
      await runAction(repo, {
        type: 'deleteBranch',
        ref: 'refs/heads/racing',
        force: true,
        expectedOid: captured,
      })
    } finally {
      race.end()
    }

    assert.equal(await readFile(cleanupState, 'utf8'), 'absent\n')
    assert.throws(() => git('show-ref', '--verify', '--quiet', 'refs/heads/racing'))
    assert.throws(() => git('config', '--get', 'branch.racing.parent'))
    git('branch', 'racing', captured)
    git('config', 'branch.racing.parent', 'new-parent')
    git('config', 'branch.racing.remote', 'new-remote')
    assert.equal(git('config', '--get', 'branch.racing.parent'), 'new-parent')
    assert.equal(git('config', '--get', 'branch.racing.remote'), 'new-remote')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
