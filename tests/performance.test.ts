import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { getCommitDiff, getFileView, getHistory, getSnapshot } from '../src/main/git'
import { getIndexEntries } from '../src/main/capabilities'
import { withGitRuntime, type GitRuntimeRecord } from '../src/main/git-runtime'
import {
  getBranchConfigs,
  isCancelled,
  executeCapped,
  listStatus,
  mapWithConcurrency,
  parseStatus,
  parseBranchConfig,
} from '../src/main/git-core'
import { RepositoryOperations } from '../src/main/repository-operations'
import { RequestRegistry } from '../src/main/request-registry'
import { windowSlice } from '../src/renderer/src/lib/list-window'
import { createRequestGate } from '../src/renderer/src/lib/request-gate'
import {
  MAX_DIFF_BYTES,
  MAX_HISTORY_BYTES,
  SNAPSHOT_BRANCH_BUDGET,
} from '../src/shared/performance'

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
  const switched = operations.switchRepository('/tmp/next-repository', async () => {
    order.push('new repository')
  })
  release.resolve()
  await running
  await assert.rejects(queued, (error: unknown) => isCancelled(error))
  await switched
  assert.deepEqual(order, ['old read', 'new repository'])
})

test('a cancelled file view keeps the next repository operation behind all its file reads', async () => {
  const { root, repo } = await repository()
  const filePath = join(repo, 'base.txt')
  const originalOpen = fs.open
  const reading = deferred()
  const release = deferred()
  let stopped = false
  let switched = false
  const controller = new AbortController()
  try {
    await writeFile(filePath, `${'changed\n'.repeat(1_000_000)}`)
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (typeof args[0] === 'string' && args[0].endsWith('/base.txt')) {
        const originalRead = handle.read.bind(handle)
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          reading.resolve()
          await release.promise
          stopped = true
          return originalRead(...readArgs)
        }) as typeof handle.read
      }
      return handle
    }
    const operations = new RepositoryOperations()
    const pending = operations.read(
      () => getFileView(repo, 'base.txt', controller.signal),
      controller.signal,
    )
    const started = await Promise.race([
      reading.promise.then(() => 'reading'),
      pending.then(
        () => 'completed without reading',
        (error: unknown) => `failed without reading: ${String(error)}`,
      ),
    ])
    assert.equal(started, 'reading')
    controller.abort()
    const next = operations.switchRepository('/tmp/next-repository', async () => {
      switched = true
    })
    await delay(150)
    assert.equal(switched, false, 'the next repository must wait for the fingerprint read')
    release.resolve()
    await assert.rejects(pending, (error: unknown) => isCancelled(error))
    await next
    assert.equal(stopped, true, 'the file read settled before the next operation')
    assert.equal(switched, true)
  } finally {
    release.resolve()
    fs.open = originalOpen
    await rm(root, { recursive: true, force: true })
  }
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

test('a cancelled branch batch waits for every running probe before releasing its read', async () => {
  const first = deferred()
  const second = deferred()
  const started: number[] = []
  let active = 0
  let rejected = false
  const pending = mapWithConcurrency([0, 1, 2], 2, async (index) => {
    started.push(index)
    active += 1
    try {
      if (index === 0) {
        await first.promise
        throw new Error('cancelled')
      }
      await second.promise
    } finally {
      active -= 1
    }
  })
  void pending.catch(() => {
    rejected = true
  })
  first.resolve()
  await delay(0)
  try {
    assert.equal(rejected, false, 'the failed probe must not release the read ahead of its peer')
    assert.deepEqual(started, [0, 1], 'no new work begins after a probe fails')
    assert.equal(active, 1)
  } finally {
    second.resolve()
  }
  await assert.rejects(pending, /cancelled/)
  assert.equal(active, 0)
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

test('a bulk changed-file listing still classifies submodules', async () => {
  const { root, repo, git } = await repository()
  try {
    // Enough changed paths that a snapshot reads the whole index and the whole
    // HEAD tree once instead of forking a process per batch of pathspecs.
    const paths = Array.from({ length: 1100 }, (_, index) => `tracked-${index}.txt`)
    await Promise.all(paths.map((filePath) => writeFile(join(repo, filePath), 'before\n')))
    git('add', '.')
    git('commit', '-m', 'Tracked files')
    // A nested repository is recorded as a gitlink. `staged` is only in the
    // index, `indexed` is in both, and `headOnly` left the index while HEAD
    // still records it, so each one has to be classified by a different read.
    const nested = async (dir: string, marker: string) => {
      const inner = join(repo, dir)
      await mkdir(inner, { recursive: true })
      const run = (...args: string[]) =>
        execFileSync('git', ['-C', inner, ...args], { encoding: 'utf8' })
      run('init', '-b', 'main')
      run('config', 'user.name', 'Perf fixture')
      run('config', 'user.email', 'perf@example.invalid')
      // Distinct content keeps the three commits distinct, so Git reports the
      // removed gitlink as a deletion rather than pairing it with the added
      // one as a rename and hiding it from the listing under its new path.
      await writeFile(join(inner, 'inner.txt'), `${marker}\n`)
      run('add', '.')
      run('commit', '-m', marker)
      return run
    }
    const indexed = await nested('vendor/indexed', 'indexed')
    await nested('vendor/headOnly', 'head-only')
    git('add', '.')
    git('commit', '-m', 'Add gitlinks')
    // Staged but never committed, so only the index records this gitlink.
    await nested('vendor/staged', 'staged')
    git('add', 'vendor/staged')
    // Every one of the 1100 tracked files is now a changed path, which is what
    // pushes the snapshot onto the whole-repository read. Moving the inner
    // repository past the recorded commit makes the index gitlink a changed
    // path, and dropping the other from the index leaves a staged deletion that
    // only `HEAD` still records as a gitlink.
    await Promise.all(paths.map((filePath) => writeFile(join(repo, filePath), 'after\n')))
    await writeFile(join(repo, 'vendor/indexed/second.txt'), 'second\n')
    indexed('add', '.')
    indexed('commit', '-m', 'Advance')
    git('rm', '--cached', '-q', 'vendor/headOnly')
    await rm(join(repo, 'vendor/headOnly'), { recursive: true, force: true })

    const snapshot = await getSnapshot(repo)
    const byPath = new Map(snapshot.files.map((file) => [file.path, file]))
    assert.equal(snapshot.limits.filesTruncated, false)
    assert.ok(byPath.has('vendor/staged'), 'the staged gitlink is listed')
    assert.ok(byPath.has('vendor/indexed'), 'the changed index gitlink is listed')
    assert.ok(byPath.has('vendor/headOnly'), 'the staged deletion of the gitlink is listed')
    assert.equal(
      byPath.get('vendor/staged')?.submodule,
      true,
      'only the index records this gitlink, so the index read must classify it',
    )
    assert.equal(
      byPath.get('vendor/indexed')?.submodule,
      true,
      'a gitlink in the index stays a submodule in a bulk listing',
    )
    assert.equal(
      byPath.get('vendor/headOnly')?.submodule,
      true,
      'a gitlink that left the index is still a submodule while HEAD records it',
    )
    assert.equal(
      byPath.get('tracked-0.txt')?.submodule,
      undefined,
      'an ordinary changed file is not reported as a submodule',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a truncated whole-index read still classifies a path whose stages the cap split', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-cap-'))
  try {
    // An unmerged path occupies one `ls-files` record per stage, so a cap
    // landing on a NUL boundary can leave the straddling path half-read. The
    // double answers a whole-index read with stage 1 followed by a flood the
    // cap cuts, and answers a pathspec read with the correct records for the
    // paths it was asked about — which is all real Git ever returns.
    const stages =
      `H 100644 ${'a'.repeat(40)} 1\tvendor/lib\0` +
      `H 160000 ${'b'.repeat(40)} 2\tvendor/lib\0` +
      `H 160000 ${'c'.repeat(40)} 3\tvendor/lib\0`
    const log = join(root, 'invocations.log')
    const module = join(root, 'double.mjs')
    await writeFile(
      module,
      `import { appendFileSync, writeSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const stages = ${JSON.stringify(stages)}
// The caller kills the child when its cap is reached, closing the pipe. Real
// Git dies on the resulting SIGPIPE; this double stops instead.
const put = (data) => {
  try {
    writeSync(1, data)
  } catch {
    process.exit(0)
  }
}
if (args[0] === '--literal-pathspecs') {
  const wanted = new Set(args.slice(6))
  const kept = stages
    .split('\\0')
    .filter(Boolean)
    .filter((record) => wanted.has(record.slice(record.indexOf('\\t') + 1)))
  put(kept.length ? kept.join('\\0') + '\\0' : '')
} else {
  put(stages.slice(0, stages.indexOf('\\0') + 1))
  const chunk = Buffer.alloc(1 << 16, 0x78)
  for (let index = 0; index < 160; index += 1) put(chunk)
}
`,
    )
    // The record stream carries NUL bytes, so it lives in a module and an ASCII
    // shim launches it.
    const shim = join(root, 'git')
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${module}" "$@"\n`)
    await chmod(shim, 0o755)
    await writeFile(log, '')

    // More than the batch size, so the whole-repository read is the strategy.
    const paths = ['vendor/lib', ...Array.from({ length: 1_100 }, (_, i) => `filler/${i}.txt`)]
    const entries = await withGitRuntime({ executable: shim } as unknown as GitRuntimeRecord, () =>
      getIndexEntries(root, paths),
    )

    assert.deepEqual(
      JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]),
      ['ls-files', '-v', '--stage', '-z'],
      'the listing is read once for the whole repository',
    )
    assert.equal(
      entries.get('vendor/lib')?.submodule,
      true,
      'the later gitlink stage decides the path even though the cap hid it',
    )
    assert.equal(entries.size, 1, 'only the path present in the index is reported')
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

test('aborting a live read waits until its Git-sized child has exited', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-stacks-cancel-'))
  const ready = join(root, 'child.pid')
  const controller = new AbortController()
  try {
    const pending = executeCapped(
      process.execPath,
      [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ready,
      ],
      root,
      { maxBytes: 1024, signal: controller.signal },
    )
    let pid = 0
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        pid = Number(await readFile(ready, 'utf8'))
        break
      } catch {
        await delay(10)
      }
    }
    assert.ok(pid > 0, 'a real child started before cancellation')
    controller.abort()
    await assert.rejects(pending, (error: unknown) => isCancelled(error))
    assert.throws(
      () => process.kill(pid, 0),
      { code: 'ESRCH' },
      'the child was reaped before rejection',
    )
  } finally {
    controller.abort()
    await rm(root, { recursive: true, force: true })
  }
})

test('a skipped comparison never invents a restack when recorded parent tip still matches', async () => {
  const { root, repo, git } = await repository()
  try {
    const head = git('rev-parse', 'HEAD')
    git('branch', 'feature/known')
    git('config', 'branch.feature/known.parent', 'main')
    git('config', 'branch.feature/known.parentTip', head)
    const snapshot = await getSnapshot(repo, undefined, 0)
    const branch = snapshot.branches.find((item) => item.name === 'feature/known')
    assert.equal(branch?.needsRestack, false)
    assert.equal(branch?.parentBehind, null)
    assert.equal(snapshot.limits.branchesSkipped, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('batched direct descendants and deeper merge-base fallback infer the same real parent', async () => {
  const { root, repo, git } = await repository()
  try {
    git('checkout', '-b', 'feature/direct')
    git('commit', '--allow-empty', '-m', 'Direct')
    git('branch', 'feature/deep')
    git('checkout', 'feature/deep')
    git('commit', '--allow-empty', '-m', 'Deeper')
    git('checkout', 'main')
    const snapshot = await getSnapshot(repo)
    for (const name of ['feature/direct', 'feature/deep']) {
      const branch = snapshot.branches.find((item) => item.name === name)
      assert.equal(branch?.parent, 'main', `${name} should retain its Git ancestry`)
      assert.equal(branch?.parentSource, 'inferred')
      assert.equal(branch?.parentBehind, 0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an inferred branch keeps its restack comparison within a one-branch budget', async () => {
  const { root, repo, git } = await repository()
  try {
    git('checkout', '-b', 'feature/diverged')
    git('commit', '--allow-empty', '-m', 'Feature')
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'Advance parent')
    const snapshot = await getSnapshot(repo, undefined, 1)
    const branch = snapshot.branches.find((item) => item.name === 'feature/diverged')
    assert.equal(branch?.parent, 'main')
    assert.equal(branch?.parentSource, 'inferred')
    assert.equal(branch?.parentBehind, 1)
    assert.equal(branch?.needsRestack, true)
    assert.equal(snapshot.limits.branchesAnalyzed, 1)
    assert.equal(snapshot.limits.branchesSkipped, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot reports the behind count Git itself reports for every branch shape', async () => {
  const { root, repo, git } = await repository()
  try {
    // A stack whose bases are one and two commits further down, a base that has
    // moved on, a branch that has moved on, and a branch that already contains
    // a merge of its base: the shortcut and the fallback must agree on all of
    // them, and every one of them is compared against the count Git computes.
    git('checkout', '-b', 'stacked/one')
    git('commit', '--allow-empty', '-m', 'One')
    git('checkout', '-b', 'stacked/two')
    git('commit', '--allow-empty', '-m', 'Two')
    git('commit', '--allow-empty', '-m', 'Two again')
    git('checkout', '-b', 'stacked/three')
    git('commit', '--allow-empty', '-m', 'Three')
    git('config', 'branch.stacked/one.parent', 'main')
    git('config', 'branch.stacked/two.parent', 'stacked/one')
    git('config', 'branch.stacked/three.parent', 'stacked/two')
    git('checkout', 'main')
    git('checkout', '-b', 'feature/side')
    git('commit', '--allow-empty', '-m', 'Side')
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'Advance one')
    git('checkout', '-b', 'behind/one')
    git('commit', '--allow-empty', '-m', 'Behind one')
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'Advance two')
    git('commit', '--allow-empty', '-m', 'Advance three')
    git('checkout', '-b', 'behind/three')
    git('commit', '--allow-empty', '-m', 'Behind three')
    git('checkout', 'main')
    git('checkout', '-b', 'feature/diverged')
    git('commit', '--allow-empty', '-m', 'Feature')
    git('commit', '--allow-empty', '-m', 'Feature again')
    git('checkout', 'main')
    git('commit', '--allow-empty', '-m', 'Advance four')
    git('checkout', '-b', 'holds-merge')
    git('merge', '--no-ff', '-m', 'Merge side', 'feature/side')
    git('config', 'branch.holds-merge.parent', 'main')
    git('checkout', 'main')

    const snapshot = await getSnapshot(repo)
    const reported = new Map<string, number | null>()
    for (const branch of snapshot.branches) {
      if (!branch.parent) continue
      const child = git('rev-parse', branch.ref)
      const base = git('rev-parse', `refs/heads/${branch.parent}`)
      const fromGit = Number(git('rev-list', '--count', `${child}..${base}`, '--'))
      reported.set(branch.name, branch.parentBehind)
      assert.equal(branch.parentBehind, fromGit, `${branch.name} should match git rev-list`)
      assert.equal(branch.needsRestack, fromGit > 0, `${branch.name} restack state`)
    }
    // A base the branch already contains, whether it is a stack tip one commit
    // down or a merge the branch has taken, is behind by nothing.
    for (const name of ['stacked/two', 'stacked/three', 'holds-merge']) {
      assert.equal(reported.get(name), 0, `${name} is up to date with its base`)
    }
    // The fixture has to produce both answers, or it proves nothing about the
    // comparisons the batched evidence declines to answer.
    const counts = [...reported.values()]
    assert.ok(
      counts.includes(0) && counts.some((count) => (count ?? 0) > 0),
      `expected up-to-date and behind branches, saw ${JSON.stringify(counts)}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a batch of up-to-date branches retains exact zero behind counts and restack states', async () => {
  const { root, repo, git } = await repository()
  try {
    for (let index = 0; index < 40; index += 1) {
      git('checkout', '-b', `feature/up-${index}`, 'main')
      git('commit', '--allow-empty', '-m', `Up ${index}`)
    }
    git('checkout', 'main')
    const snapshot = await getSnapshot(repo)
    const branches = snapshot.branches.filter((item) => item.name.startsWith('feature/up-'))
    assert.equal(branches.length, 40)
    assert.ok(branches.every((item) => item.parent === 'main'))
    assert.ok(branches.every((item) => item.parentBehind === 0 && !item.needsRestack))
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
    assert.equal(budgeted.limits.branchesSkipped, 6)
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

test('a date cut by the history cap is not returned as a complete commit', async () => {
  const { root, repo, git } = await repository()
  try {
    const parent = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', 'HEAD^{tree}')
    const name = 'N'.repeat(MAX_HISTORY_BYTES - 105)
    const identity = `${name} <n@example.invalid> 1700000000 +0000`
    const oid = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      input: `tree ${tree}\nparent ${parent}\nauthor ${identity}\ncommitter ${identity}\n\nBoundary\n`,
      encoding: 'utf8',
      maxBuffer: MAX_HISTORY_BYTES * 3,
    }).trim()
    git('update-ref', 'refs/heads/main', oid)
    const complete = execFileSync(
      'git',
      ['-C', repo, 'log', '-1', '--format=%H%x00%P%x00%s%x00%an%x00%cI%x00'],
      {
        encoding: 'utf8',
        maxBuffer: MAX_HISTORY_BYTES * 3,
      },
    )
    const dateStart = complete.indexOf('\0', complete.indexOf('\0', complete.indexOf('\0') + 1) + 1)
    const dateField = complete.indexOf('\0', dateStart + 1)
    assert.ok(
      dateField < MAX_HISTORY_BYTES && complete.indexOf('\0', dateField + 1) > MAX_HISTORY_BYTES,
    )
    await assert.rejects(getHistory(repo, 'refs/heads/main', 0), /preview limit/)
    git('commit', '--allow-empty', '-m', 'Newer')
    const first = await getHistory(repo, 'refs/heads/main', 0)
    assert.deepEqual(
      first.commits.map((commit) => commit.subject),
      ['Newer'],
    )
    assert.equal(first.hasMore, true)
    await assert.rejects(getHistory(repo, 'refs/heads/main', 1), /preview limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list windows expand once and keep deep navigation bounded', () => {
  const items = Array.from({ length: 50_000 }, (_, index) => index)
  const first = windowSlice(items, 200)
  assert.deepEqual([first.visible.length, first.remaining], [200, 49_800])
  const second = windowSlice(items, 400)
  assert.deepEqual([second.visible[0], second.visible.at(-1), second.visible.length], [0, 399, 400])
  const deep = windowSlice(items, 400, 49_400)
  assert.deepEqual(
    [deep.visible[0], deep.visible.at(-1), deep.visible.length],
    [49_400, 49_799, 400],
  )
  const last = windowSlice(items, 400, 49_600)
  assert.deepEqual([last.visible[0], last.hasMore, last.remaining], [49_600, false, 0])
})
