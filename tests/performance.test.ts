import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getCommitDiff, getHistory, getSnapshot } from '../src/main/git'
import {
  getBranchConfigs,
  isCancelled,
  listStatus,
  mapWithConcurrency,
  parseStatus,
  parseBranchConfig,
} from '../src/main/git-core'
import { RepositoryOperations } from '../src/main/repository-operations'
import { RequestRegistry } from '../src/main/request-registry'
import { windowSlice } from '../src/renderer/src/lib/list-window'
import { createRequestGate } from '../src/renderer/src/lib/request-gate'
import { MAX_DIFF_BYTES, SNAPSHOT_BRANCH_BUDGET } from '../src/shared/performance'

/** The project targets ES2022, so the deferred helper is spelled out here. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-perf-'))
  const repo = join(root, 'repo')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' })
  git('config', 'user.name', 'Perf fixture')
  git('config', 'user.email', 'perf@example.invalid')
  await writeFile(join(repo, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Base')
  return { root, repo, git }
}

test('a stale refresh cannot be applied to a newly selected repository', () => {
  const gate = createRequestGate()
  const inFlight = gate.claim()
  assert.equal(gate.current(inFlight), true)
  gate.reset()
  assert.equal(gate.current(inFlight), false, 'switching repositories retires the read')
  const afterSwitch = gate.claim()
  assert.equal(gate.current(afterSwitch), true)
})

test('rapid refreshes supersede each other and only the newest applies', () => {
  const gate = createRequestGate()
  const first = gate.claim()
  const second = gate.claim()
  assert.equal(gate.current(first), false)
  assert.equal(gate.current(second), true)
  gate.reset()
  assert.equal(gate.current(second), false)
})

test('the request registry ends a superseded read and releases finished ones', () => {
  const registry = new RequestRegistry()
  const superseded = registry.claim('/repo', 'commit-diff:aaa')
  const current = registry.claim('/repo', 'commit-diff:aaa')
  assert.equal(superseded.signal.aborted, true, 'a newer diff for the same key cancels the old one')
  assert.equal(current.signal.aborted, false)
  const history = registry.claim('/repo', 'history:main')
  registry.release('/repo', 'commit-diff:aaa', superseded)
  assert.equal(current.signal.aborted, false, 'releasing a stale holder changes nothing')
  registry.cancelRoot('/repo')
  assert.equal(history.signal.aborted, true, 'switching repository ends its reads')
  assert.equal(current.signal.aborted, true)
})

test('a read cancelled while queued never starts', async () => {
  const operations = new RepositoryOperations()
  const started: string[] = []
  const release = deferred()
  const slow = operations.read(async () => {
    started.push('slow')
    await release.promise
  })
  const controller = new AbortController()
  const queued = operations.read(async () => {
    started.push('queued')
  }, controller.signal)
  controller.abort()
  release.resolve()
  await assert.rejects(queued, (error: unknown) => isCancelled(error))
  await slow
  assert.deepEqual(started, ['slow'], 'the cancelled read never ran its work')
})

test('a repository switch waits for a cancelled read instead of rejecting the switch', async () => {
  const operations = new RepositoryOperations()
  const release = deferred()
  const order: string[] = []
  const running = operations.read(async () => {
    order.push('old read')
    await release.promise
  })
  const controller = new AbortController()
  const queued = operations.read(async () => {
    order.push('obsolete read')
  }, controller.signal)
  controller.abort()
  const switched = operations.switchRepository(async () => {
    order.push('new repository')
  })
  release.resolve()
  await running
  await assert.rejects(queued, (error: unknown) => isCancelled(error))
  await switched
  assert.deepEqual(order, ['old read', 'new repository'])
})

test('branch parents and tips are read in one batched config pass', async () => {
  const { root, repo, git } = await repository()
  try {
    const configs = new Map([
      ['feature/one', { parent: 'main', parentTip: 'a'.repeat(40) }],
      ['feature/two', { parent: null, parentTip: 'b'.repeat(40) }],
    ])
    for (const [name, entry] of configs) {
      if (entry.parent) git('config', `branch.${name}.parent`, entry.parent)
      if (entry.parentTip) git('config', `branch.${name}.parentTip`, entry.parentTip)
    }
    const parsed = parseBranchConfig(
      'branch.feature/one.parent\nmain\0branch.feature/one.parentTip\naaaa\0',
    )
    assert.equal(parsed.get('feature/one')?.parent, 'main')
    assert.equal(parsed.get('feature/one')?.parentTip, 'aaaa')
    const read = await getBranchConfigs(repo)
    assert.equal(read.size, 2)
    assert.equal(read.get('feature/one')?.parent, 'main')
    assert.equal(read.get('feature/two')?.parent, null)
    assert.equal(read.get('feature/two')?.parentTip, 'b'.repeat(40))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('per-branch work runs under a concurrency ceiling', async () => {
  let active = 0
  let peak = 0
  const release = deferred()
  await mapWithConcurrency(
    Array.from({ length: 50 }, (_, index) => index),
    4,
    async () => {
      active += 1
      peak = Math.max(peak, active)
      // Every worker parks until the fourth arrives, so the observed peak is the
      // real ceiling rather than a guess about scheduling.
      if (active === 4) release.resolve()
      await release.promise
      active -= 1
    },
  )
  assert.ok(peak <= 4, `expected at most 4 concurrent workers, saw ${peak}`)
})

test('a huge changed-file listing is bounded and reported instead of hanging', async () => {
  const { root, repo, git } = await repository()
  try {
    for (let index = 0; index < 400; index += 1) {
      await writeFile(join(repo, `generated-${index}.txt`), `${index}\n`)
    }
    const listed = await listStatus(repo)
    assert.equal(listed.files.length, 400)
    assert.equal(listed.truncated, false)
    const snapshot = await getSnapshot(repo)
    assert.equal(snapshot.limits.filesListed, 400)
    assert.equal(snapshot.limits.filesTruncated, false)
    assert.equal(snapshot.branches.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a capped rename status drops only the incomplete final pair', () => {
  const complete = '?? standalone.txt\0R  new.txt\0old.txt\0'
  const partial = '?? standalone.txt\0R  new.txt\0'
  assert.equal(parseStatus(complete).length, 2)
  assert.deepEqual(
    parseStatus(partial, true).map((file) => file.path),
    ['standalone.txt'],
  )
  assert.throws(() => parseStatus(partial), /rename status without its original path/)
})

test('a large commit diff retains at most the diff budget', async () => {
  const { root, repo, git } = await repository()
  try {
    for (let index = 0; index < 1_200; index += 1) {
      await writeFile(join(repo, `chunk-${index}.txt`), `${'x'.repeat(4_000)}\n`)
    }
    git('add', '.')
    git('commit', '-m', 'Large change')
    const oid = git('rev-parse', 'HEAD')
    const diff = await getCommitDiff(repo, oid)
    assert.ok(
      Buffer.byteLength(diff.text, 'utf8') <= MAX_DIFF_BYTES,
      'retained diff text must stay inside the budget',
    )
    assert.equal(diff.truncated, true, 'a diff past the budget is reported as truncated')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelling a diff read ends the request instead of returning it', async () => {
  const { root, repo, git } = await repository()
  try {
    await writeFile(join(repo, 'changed.txt'), 'changed\n')
    git('add', '.')
    git('commit', '-m', 'Change')
    const oid = git('rev-parse', 'HEAD')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(getCommitDiff(repo, oid, controller.signal), (error: unknown) =>
      isCancelled(error),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot states the branches its analysis budget left out', async () => {
  const { root, repo, git } = await repository()
  try {
    const head = git('rev-parse', 'HEAD')
    const refs = Array.from(
      { length: 12 },
      (_, index) => `create refs/heads/feature/b${index} ${head}`,
    ).join('\n')
    execFileSync('git', ['-C', repo, 'update-ref', '--stdin'], {
      input: `${refs}\n`,
      encoding: 'utf8',
    })
    const budgeted = await getSnapshot(repo, undefined, 6)
    assert.equal(budgeted.branches.length, 13)
    // A budget of six buys exactly six branch analyses; everything past it is
    // reported instead of quietly analysed anyway.
    assert.equal(budgeted.limits.branchesAnalyzed, 6)
    assert.equal(budgeted.limits.branchesSkipped, 12)
    const full = await getSnapshot(repo)
    assert.equal(full.limits.branchesSkipped, 0)
    assert.equal(full.limits.branchesAnalyzed, 12, 'a branch is counted once across both probes')
    assert.ok(SNAPSHOT_BRANCH_BUDGET >= 12)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('history stays paged on a deep repository', async () => {
  const { root, repo, git } = await repository()
  try {
    for (let index = 0; index < 80; index += 1) {
      await writeFile(join(repo, 'log.txt'), `${index}\n`)
      git('add', '.')
      git('commit', '-m', `Commit ${index}`)
    }
    const first = await getHistory(repo, 'refs/heads/main', 0)
    assert.equal(first.commits.length, 50)
    assert.equal(first.hasMore, true)
    const second = await getHistory(repo, 'refs/heads/main', 50)
    assert.equal(second.commits.length, 31)
    assert.equal(second.hasMore, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized history entry reports its limit instead of hiding later commits', async () => {
  const { root, repo, git } = await repository()
  try {
    const message = join(repo, 'message.txt')
    await writeFile(message, 'x'.repeat(1024 * 1024 + 100))
    git('commit', '--quiet', '--allow-empty', '-F', message)
    await assert.rejects(getHistory(repo, 'refs/heads/main', 0), /preview limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list windows reveal a bounded prefix of a very large list', () => {
  const items = Array.from({ length: 50_000 }, (_, index) => index)
  const first = windowSlice(items, 200)
  assert.equal(first.visible.length, 200)
  assert.equal(first.hasMore, true)
  assert.equal(first.remaining, 49_800)
  const last = windowSlice(items, items.length)
  assert.equal(last.hasMore, false)
  assert.equal(last.remaining, 0)
})
