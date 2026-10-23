import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { test } from 'node:test'
import {
  adoptionPaths,
  discoverWorktrees,
  inspectWorktree,
  inventoryId,
  parseWorktreeList,
  WorktreeInventoryService,
} from '../src/main/worktree-inventory'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import { WORKTREE_READ_CONCURRENCY } from '@git-stacks/shared/performance'
import type { WorktreeInventory } from '@git-stacks/shared/worktree-inventory'
import type { PullRequest } from '@git-stacks/shared/types'
import { resolveGitRuntime, withGitRuntime } from '../src/main/git-runtime'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Inventory fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Inventory fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'git-stacks-inventory-')))
  const repo = join(root, 'primary workspace')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  await writeFile(join(repo, 'shared.txt'), 'base\n')
  await writeFile(join(repo, 'rename-source.txt'), 'rename fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Base')
  return { root, repo }
}

class MeasuredScheduler extends RepositoryScheduler {
  active = 0
  maximum = 0
  reads = 0
  override read<T>(
    root: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return super.read(
      root,
      async (combined) => {
        this.active++
        this.reads++
        this.maximum = Math.max(this.maximum, this.active)
        try {
          return await task(combined)
        } finally {
          this.active--
        }
      },
      signal,
    )
  }
}

function nextInventory(
  service: WorktreeInventoryService,
  install: (listener: (value: WorktreeInventory) => void) => void,
  predicate: (value: WorktreeInventory) => boolean,
): Promise<WorktreeInventory> {
  const { promise, resolve } = Promise.withResolvers<WorktreeInventory>()
  install((value) => {
    if (predicate(value)) resolve(value)
  })
  if (predicate(service.current())) resolve(service.current())
  return promise
}

test('discovery publishes unknown worktree facts before inspection without mutating its receipt', async () => {
  const { root, repo } = await fixture()
  git(repo, 'worktree', 'add', join(root, 'sibling'), '-b', 'sibling')
  const publications: WorktreeInventory[] = []
  const service = new WorktreeInventoryService(new RepositoryScheduler(), (value) =>
    publications.push(value),
  )
  try {
    service.register([repo])
    const complete = await service.read({ requestId: 'discovery-before-status' })
    const discovered = publications.find(
      (value) =>
        value.repositories[0]?.refs.length &&
        value.repositories[0].worktrees.every((tree) => tree.read.observedAt === null),
    )
    assert.ok(discovered, 'refs are published before sibling status inspections finish')
    assert.equal(discovered.state, 'partial')
    assert.equal(discovered.repositories[0].worktrees.length, 2)
    for (const tree of discovered.repositories[0].worktrees) {
      assert.notEqual(tree.read.state, 'complete')
      assert.equal(tree.read.observedAt, null)
      assert.equal(tree.counts, null)
    }
    assert.equal(complete.state, 'complete')
    assert.ok(complete.generation > discovered.generation)
    assert.ok(complete.repositories[0].worktrees.every((tree) => tree.read.state === 'complete'))
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

for (const invalidation of ['watcher', 'resume'] as const)
  test(`overlapping pending reads preserve ${invalidation} invalidation and confirmed sibling facts`, async () => {
    const { root, repo } = await fixture()
    const changed = join(root, 'changed')
    const unchanged = join(root, 'unchanged')
    git(repo, 'worktree', 'add', changed, '-b', 'changed')
    git(repo, 'worktree', 'add', unchanged, '-b', 'unchanged')
    const invalidated = Promise.withResolvers<void>()
    let replacePending = false
    let selectedWorktreeId: string | undefined
    let replacement: Promise<WorktreeInventory> | undefined
    const service = new WorktreeInventoryService(
      new RepositoryScheduler(),
      (value) => {
        if (
          replacePending &&
          value.repositories[0]?.worktrees.every((tree) => tree.read.observedAt === null)
        ) {
          replacePending = false
          // Start B synchronously: A has consumed its invalid flags but has not
          // reached its asynchronous abort/catch cleanup yet.
          replacement = service.read({ requestId: 'replacement', selectedWorktreeId })
        }
      },
      () => invalidated.resolve(),
    )
    try {
      service.register([repo])
      const initial = await service.read({ requestId: 'initial' })
      const primary = initial.repositories[0].worktrees.find((tree) => tree.path === repo)!
      const stable = initial.repositories[0].worktrees.find((tree) => tree.path === unchanged)!
      selectedWorktreeId = primary.id
      if (invalidation === 'resume') service.setActive(false)
      await writeFile(join(changed, 'external.txt'), 'external edit\n')
      if (invalidation === 'resume') service.setActive(true)
      else await invalidated.promise
      replacePending = true
      await assert.rejects(service.read({ requestId: 'interrupted', selectedWorktreeId }))
      assert.ok(replacement, 'the replacement overlaps the interrupted pending read')
      const refreshed = await replacement
      const dirty = refreshed.repositories[0].worktrees.find((tree) => tree.path === changed)!
      const retained = refreshed.repositories[0].worktrees.find((tree) => tree.id === stable.id)!
      assert.equal(dirty.status, 'dirty')
      assert.equal(dirty.counts?.untracked, 1)
      assert.equal(dirty.read.state, 'complete')
      assert.equal(retained.status, 'clean')
      assert.deepEqual(retained.counts, stable.counts)
      assert.equal(retained.read.state, 'complete')
      if (invalidation === 'watcher') assert.equal(retained.read.observedAt, stable.read.observedAt)
      else assert.notEqual(retained.read.observedAt, stable.read.observedAt)
      assert.notEqual(
        refreshed.repositories[0].worktrees.find((tree) => tree.id === primary.id)?.read.observedAt,
        primary.read.observedAt,
        'selected facts are inspected again',
      )
    } finally {
      service.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

test('resume fences an explicit read holding pre-resume sibling observations', async () => {
  const { root, repo } = await fixture()
  const sibling = join(root, 'sibling')
  git(repo, 'worktree', 'add', sibling, '-b', 'sibling')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  class HeldInspectionScheduler extends RepositoryScheduler {
    readsUntilHold = 0
    override read<T>(
      root: string,
      task: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const hold = this.readsUntilHold > 0 && --this.readsUntilHold === 0
      return super.read(
        root,
        async (combined) => {
          const result = await task(combined)
          if (hold) {
            entered.resolve()
            await release.promise
          }
          return result
        },
        signal,
      )
    }
  }
  const scheduler = new HeldInspectionScheduler()
  const service = new WorktreeInventoryService(scheduler, () => {})
  try {
    service.register([repo])
    const initial = await service.read({ requestId: 'initial' })
    const primary = initial.repositories[0].worktrees.find((tree) => tree.path === repo)!
    scheduler.readsUntilHold = 2 // Discovery, then the selected worktree inspection.
    const explicit = service.read({
      requestId: 'held-explicit',
      selectedWorktreeId: primary.id,
    })
    const retired = assert.rejects(explicit, 'pre-resume observations cannot publish after resume')
    await entered.promise
    service.setActive(false)
    await writeFile(join(sibling, 'external.txt'), 'changed while inactive\n')
    service.setActive(true)
    release.resolve()
    await retired
    const refreshed = await service.read({ requestId: 'after-resume' })
    const observed = refreshed.repositories[0].worktrees.find((tree) => tree.path === sibling)!
    assert.equal(observed.read.state, 'complete')
    assert.equal(observed.status, 'dirty')
    assert.equal(observed.counts?.untracked, 1)
    const repeated = await service.read({ requestId: 'reuse-after-resume' })
    assert.equal(
      repeated.repositories[0].worktrees.find((tree) => tree.id === observed.id)?.status,
      'dirty',
      'later reuse cannot resurrect the pre-resume clean observation',
    )
  } finally {
    release.resolve()
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed registered root automatically recovers when its directory returns', {
  timeout: 30_000,
}, async () => {
  const { root, repo } = await fixture()
  let listener = (_value: WorktreeInventory) => {}
  const service = new WorktreeInventoryService(new RepositoryScheduler(), (value) =>
    listener(value),
  )
  try {
    service.register([repo])
    const initial = await service.read({ requestId: 'initial' })
    const moved = join(root, 'moved')
    const failed = nextInventory(
      service,
      (next) => {
        listener = next
      },
      (value) => value.state === 'failed' && value.repositories.length === 0,
    )
    await rename(repo, moved)
    assert.equal((await failed).failures[0].path, repo)
    const restored = nextInventory(
      service,
      (next) => {
        listener = next
      },
      (value) => value.state === 'complete' && value.repositories.length === 1,
    )
    await rename(moved, repo)
    assert.equal((await restored).repositories[0].identity.id, initial.repositories[0].identity.id)
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})
test('NUL discovery preserves unusual paths and incomplete records never become directories', () => {
  const path = '/fixture/space Ω\nline '
  const result = parseWorktreeList(
    `worktree ${path}\0HEAD ${'a'.repeat(40)}\0detached\0locked maintenance\0\0`,
  )
  assert.equal(result[0].path, path)
  assert.equal(result[0].ref, null)
  assert.equal(result[0].locked, 'maintenance')
  assert.deepEqual(parseWorktreeList(`worktree ${path}\0HEAD a\0`, true), [])
  assert.throws(() => parseWorktreeList('HEAD abc\0\0'))
})

test('real clean, dirty, conflicted, detached, missing, locked, bare and independent clone authorities are read-only', {
  timeout: 60_000,
}, async () => {
  const { root, repo } = await fixture()
  const dirty = join(
    root,
    process.platform === 'win32' ? 'dirty Ω worktree' : 'dirty Ω\nworktree \n',
  )
  const conflicted = join(root, 'conflicted')
  const detached = join(root, 'detached')
  const missing = join(root, 'missing')
  const clone = join(root, 'independent clone')
  const bare = join(root, 'bare.git')
  const trace = join(root, 'read-trace.jsonl')
  const previousTrace = process.env.GIT_TRACE2_EVENT
  try {
    git(repo, 'worktree', 'add', '-b', 'feature/dirty', dirty)
    git(repo, 'worktree', 'add', '-b', 'feature/conflicted', conflicted)
    git(repo, 'worktree', 'add', '--detach', detached)
    git(repo, 'worktree', 'add', '-b', 'feature/missing', missing)
    git(repo, 'worktree', 'lock', '--reason', 'maintenance', dirty)
    await rm(missing, { recursive: true })
    await writeFile(join(dirty, 'untracked Ω.txt'), 'untracked\n')
    await writeFile(join(dirty, 'shared.txt'), 'dirty\n')
    git(dirty, 'add', 'shared.txt')
    await writeFile(join(dirty, 'shared.txt'), 'unstaged\n')
    git(dirty, 'mv', 'rename-source.txt', 'renamed.txt')
    await writeFile(join(conflicted, 'shared.txt'), 'topic\n')
    git(conflicted, 'add', '.')
    git(conflicted, 'commit', '-m', 'Topic')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Main')
    assert.throws(() => git(conflicted, '-c', 'commit.gpgsign=false', 'merge', 'main'))
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/inventory.git')
    git(repo, 'remote', 'add', 'second', 'https://other.example/example/inventory.git')
    git(repo, 'update-ref', 'refs/remotes/origin/same', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/second/same', 'HEAD')
    git(root, 'clone', '--no-hardlinks', repo, clone)
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/example/inventory.git')
    git(root, 'clone', '--bare', repo, bare)
    const configBefore = await readFile(join(repo, '.git', 'config'))
    const indexBefore = await readFile(join(repo, '.git', 'index'))
    const refsBefore = git(repo, 'show-ref')
    process.env.GIT_TRACE2_EVENT = trace
    const inventory = await discoverWorktrees(repo)
    const values = await Promise.all(inventory.worktrees.map((tree) => inspectWorktree(tree)))
    const at = (path: string) => values.find((tree) => tree.path === path)!
    assert.equal(at(repo).status, 'clean')
    assert.equal(at(dirty).status, 'dirty')
    assert.deepEqual(at(dirty).counts, {
      staged: 2,
      unstaged: 1,
      untracked: 1,
      renamed: 1,
      conflicted: 0,
    })
    assert.equal(at(dirty).locked, 'maintenance')
    assert.equal(at(conflicted).status, 'conflicted')
    assert.equal(at(conflicted).counts?.conflicted, 1)
    assert.equal(at(conflicted).operation, 'merge')
    assert.equal(at(detached).detached, true)
    assert.equal(at(detached).refId, null)
    assert.equal(at(missing).missing, true)
    assert.equal(at(missing).status, 'unknown')
    assert.equal(at(missing).counts, null)
    const cloneInventory = await discoverWorktrees(clone)
    assert.notEqual(cloneInventory.identity.id, inventory.identity.id)
    assert.equal(cloneInventory.remote?.id, inventory.remote?.id)
    const bareInventory = await discoverWorktrees(bare)
    assert.equal(bareInventory.worktrees[0].kind, 'bare')
    assert.equal((await inspectWorktree(bareInventory.worktrees[0])).status, 'unknown')
    const sameRefs = inventory.refs.filter((ref) => ref.name.endsWith('/same'))
    assert.equal(sameRefs.length, 2)
    assert.notEqual(sameRefs[0].id, sameRefs[1].id)
    assert.notEqual(sameRefs[0].remoteId, sameRefs[1].remoteId)
    const linkedInventory = await discoverWorktrees(dirty)
    assert.equal(linkedInventory.identity.id, inventory.identity.id)
    const starts = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start')
    assert.ok(starts.length > 10)
    const readonly = ['rev-parse', 'worktree', 'config', 'for-each-ref', 'status', '--version']
    for (const event of starts) {
      const args = event.argv.slice(1).filter((arg: string) => arg !== '--no-optional-locks')
      assert.ok(readonly.includes(args[0]), `Unexpected command ${JSON.stringify(args)}`)
      if (args[0] === 'worktree') assert.equal(args[1], 'list')
      if (args[0] === 'config') assert.ok(args.includes('--get-regexp'))
    }
    assert.deepEqual(await readFile(join(repo, '.git', 'config')), configBefore)
    assert.deepEqual(await readFile(join(repo, '.git', 'index')), indexBefore)
    assert.equal(git(repo, 'show-ref'), refsBefore)
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
    await rm(root, { recursive: true, force: true })
  }
})

test('truncation and authority replacement are unknown, and external branch movement retires discovered facts', async () => {
  const { root, repo } = await fixture()
  try {
    for (let index = 0; index < 10; index++)
      await writeFile(join(repo, `long-untracked-name-${index}.txt`), 'x')
    const discovered = await discoverWorktrees(repo)
    const limited = await inspectWorktree(discovered.worktrees[0], undefined, 48)
    assert.equal(limited.read.state, 'partial')
    assert.equal(limited.status, 'unknown')
    assert.ok(limited.counts && limited.counts.untracked < 10)
    git(repo, 'checkout', '-b', 'external')
    const moved = await inspectWorktree(discovered.worktrees[0])
    assert.equal(moved.read.state, 'failed')
    assert.equal(moved.status, 'unknown')
    assert.equal(moved.counts, null)
    const before = await discoverWorktrees(repo)
    await rename(repo, join(root, 'old-authority'))
    await mkdir(repo)
    git(repo, 'init', '-b', 'main')
    const replaced = await inspectWorktree(before.worktrees[0])
    assert.equal(replaced.status, 'unknown')
    assert.equal(replaced.counts, null)
    const after = await discoverWorktrees(repo)
    assert.notEqual(after.identity.id, before.identity.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('120 real worktrees use bounded concurrency and warm cache without detail read storms', {
  timeout: 120_000,
}, async () => {
  const { root, repo } = await fixture()
  const scheduler = new MeasuredScheduler()
  let listener: (value: WorktreeInventory) => void = () => {}
  const service = new WorktreeInventoryService(scheduler, (value) => listener(value), undefined, {
    recursiveWatch: false,
  })
  service.setActive(false)
  try {
    for (let index = 1; index < 120; index++)
      git(repo, 'worktree', 'add', '-b', `scale/${index}`, join(root, `worktree-${index}`))
    service.register([repo])
    const first = await service.read({ requestId: 'scale' })
    assert.equal(first.repositories[0].worktrees.length, 120)
    assert.ok(first.repositories[0].worktrees.every((tree) => tree.status === 'clean'))
    assert.ok(scheduler.maximum <= WORKTREE_READ_CONCURRENCY)
    const before = scheduler.reads
    await service.read({ requestId: 'warm' })
    assert.equal(scheduler.reads - before, 1)
    const selected = first.repositories[0].worktrees[119]
    await writeFile(join(selected.path, 'new.txt'), 'external\n')
    const selectedRead = await service.read({
      requestId: 'selected',
      selectedWorktreeId: selected.id,
    })
    assert.equal(
      selectedRead.repositories[0].worktrees.find((tree) => tree.id === selected.id)?.status,
      'dirty',
    )
    assert.equal(scheduler.reads - before, 3)
    console.log(
      JSON.stringify({
        scenario: '120-worktrees',
        maximumConcurrentReads: scheduler.maximum,
        coldScheduledReads: before,
        warmScheduledReads: 1,
        selectedScheduledReads: 2,
      }),
    )
    const background = first.repositories[0].worktrees[40]
    const nested = join(background.path, 'untracked', 'nested')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'before.txt'), 'before fallback\n')
    const trace = join(root, 'active-scale-trace.jsonl')
    const previousTrace = process.env.GIT_TRACE2_EVENT
    process.env.GIT_TRACE2_EVENT = trace
    try {
      const resumed = nextInventory(
        service,
        (next) => {
          listener = next
        },
        (value) =>
          value.state === 'complete' &&
          value.repositories[0]?.worktrees.find((tree) => tree.id === background.id)?.counts
            ?.untracked === 1,
      )
      service.setActive(true)
      await resumed
      const resumedEvents = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const resumeDetails = resumedEvents.filter(
        (event) => event.event === 'start' && event.argv.includes('--porcelain=v1'),
      )
      const priorityPaths = resumeDetails
        .slice(0, WORKTREE_READ_CONCURRENCY)
        .map(
          (start) =>
            resumedEvents.find((event) => event.sid === start.sid && event.event === 'def_repo')
              ?.worktree,
        )
      assert.ok(
        priorityPaths.includes(selected.path),
        'The selected checkout was not in the first bounded detail batch',
      )
      assert.equal(resumeDetails.length, 120)
      await writeFile(trace, '')
      const changed = nextInventory(
        service,
        (next) => {
          listener = next
        },
        (value) =>
          value.state === 'complete' &&
          value.repositories[0]?.worktrees.find((tree) => tree.id === background.id)?.counts
            ?.untracked === 2 &&
          value.repositories[0]?.worktrees.find((tree) => tree.id === selected.id)?.counts
            ?.untracked === 2,
      )
      await writeFile(join(nested, 'after.txt'), 'nested no-event fallback\n')
      await writeFile(join(selected.path, 'second.txt'), 'selected native event\n')
      const live = await changed
      assert.equal(
        live.repositories[0].worktrees.filter((tree) => tree.status === 'clean').length,
        118,
      )
      assert.ok(scheduler.maximum <= WORKTREE_READ_CONCURRENCY)
      const events = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const details = events.filter(
        (event) => event.event === 'start' && event.argv.includes('--porcelain=v1'),
      )
      const detailPaths = details.map(
        (start) =>
          events.find((event) => event.sid === start.sid && event.event === 'def_repo')?.worktree,
      )
      assert.ok(
        detailPaths.every((path) => path === selected.path || path === background.path),
        'A sparse sweep caused an unrelated detail-read storm',
      )
      assert.ok(detailPaths.includes(background.path))
      console.log(
        JSON.stringify({
          scenario: 'active-120-worktree-sparse-fallback',
          resumedDetailReads: resumeDetails.length,
          liveDetailReads: details.length,
          maximumConcurrentReads: scheduler.maximum,
          selectedInFirstBatch: true,
          unchangedCleanWorktrees: 118,
        }),
      )
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
    }
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('simultaneous external edits and watcher bursts update worktrees independently', {
  timeout: 40_000,
}, async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'linked')
  let listener: (value: WorktreeInventory) => void = () => {}
  const service = new WorktreeInventoryService(new RepositoryScheduler(), (value) =>
    listener(value),
  )
  try {
    git(repo, 'worktree', 'add', '-b', 'linked', linked)
    service.register([repo])
    await service.read({ requestId: 'start' })
    const observed = nextInventory(
      service,
      (next) => {
        listener = next
      },
      (value) => value.repositories[0]?.worktrees.every((tree) => tree.status === 'dirty') === true,
    )
    for (let index = 0; index < 30; index++) {
      await writeFile(join(repo, 'burst.txt'), String(index))
      await writeFile(join(linked, 'burst.txt'), String(index))
    }
    const result = await observed
    assert.equal(result.repositories[0].worktrees.length, 2)
    assert.ok(result.repositories[0].worktrees.every((tree) => tree.counts?.untracked === 1))
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelled late discovery cannot replace a newer repository', {
  timeout: 40_000,
}, async () => {
  const first = await fixture()
  const second = await fixture()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  class DelayedScheduler extends RepositoryScheduler {
    delayed = false
    override read<T>(
      root: string,
      task: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      return super.read(
        root,
        async (combined) => {
          const value = await task(combined)
          if (!this.delayed) {
            this.delayed = true
            entered.resolve()
            await gate.promise
          }
          return value
        },
        signal,
      )
    }
  }
  const emitted: WorktreeInventory[] = []
  const service = new WorktreeInventoryService(new DelayedScheduler(), (value) =>
    emitted.push(value),
  )
  service.setActive(false)
  try {
    service.register([first.repo])
    const late = service.read({ requestId: 'old' })
    const refused = assert.rejects(late)
    await entered.promise
    service.register([second.repo])
    const current = await service.read({ requestId: 'new' })
    gate.resolve()
    await refused
    assert.deepEqual(current.repositories[0].registeredPaths, [second.repo])
    assert.deepEqual(service.current().repositories[0].registeredPaths, [second.repo])
    assert.ok(
      emitted
        .filter((value) => value.state === 'complete')
        .every((value) => value.repositories[0].registeredPaths[0] === second.repo),
    )
  } finally {
    gate.resolve()
    service.stop()
    await rm(first.root, { recursive: true, force: true })
    await rm(second.root, { recursive: true, force: true })
  }
})

test('qualified PR joins retain unpublished heads, remote-only refs, no-worktree branches and PR-only records while offline', async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'second-main')
  const clone = join(root, 'clone')
  const service = new WorktreeInventoryService(new RepositoryScheduler(), () => {})
  service.setActive(false)
  try {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/inventory.git')
    const published = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'branch', 'topic')
    git(repo, 'update-ref', 'refs/remotes/origin/topic', published)
    git(repo, 'update-ref', 'refs/remotes/origin/remote-only', published)
    git(repo, 'branch', '--set-upstream-to=origin/topic', 'topic')
    git(repo, 'worktree', 'add', '--force', linked, 'main')
    await writeFile(join(repo, 'shared.txt'), 'unpublished\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'Unpublished')
    git(repo, 'update-ref', 'refs/heads/topic', 'HEAD')
    git(root, 'clone', '--no-hardlinks', repo, clone)
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/example/inventory.git')
    service.register([repo, linked, clone])
    const read = await service.read({ requestId: 'qualified' })
    assert.equal(read.repositories.length, 2)
    assert.deepEqual(read.repositories[0].registeredPaths, [repo, linked])
    const facts: PullRequest = {
      number: 7,
      title: 'Published topic',
      url: 'https://github.com/example/inventory/pull/7',
      head: 'topic',
      base: 'main',
      state: 'OPEN',
      draft: false,
      checks: 'none',
      headOid: published,
      headRepository: 'example/inventory',
    }
    service.adoptRemote({
      path: repo,
      remoteUrl: 'https://github.com/example/inventory.git',
      pullRequests: [facts, { ...facts, number: 8, head: 'absent' }],
      remote: {
        state: 'offline',
        fetchedAt: null,
        checkedAt: null,
        detail: 'Offline fixture',
        rateLimitReset: null,
        pendingMutations: [],
      },
    })
    const joined = service.current().repositories[0]
    const topic = joined.refs.find((ref) => ref.name === 'refs/heads/topic')!
    assert.equal(topic.worktreeIds.length, 0)
    assert.equal(topic.ahead, 1)
    assert.notEqual(topic.oid, joined.pullRequests[0].headOid)
    assert.deepEqual(topic.pullRequestIds, [inventoryId(joined.remote!.id, 'pr', '7')])
    assert.equal(joined.refs.find((ref) => ref.name === 'refs/heads/main')?.worktreeIds.length, 2)
    assert.ok(
      joined.refs.some(
        (ref) => ref.name === 'refs/remotes/origin/remote-only' && ref.worktreeIds.length === 0,
      ),
    )
    assert.deepEqual(joined.pullRequests.find((pr) => pr.number === 8)?.refIds, [])
    assert.equal(joined.remoteFreshness?.state, 'offline')
    assert.equal(service.current().repositories[1].pullRequests[0].id, joined.pullRequests[0].id)
    assert.notEqual(service.current().repositories[1].identity.id, joined.identity.id)
    service.retireRemote()
    assert.equal(service.current().repositories[0].pullRequests.length, 0)
    assert.ok(
      service.current().repositories[0].refs.every((ref) => ref.pullRequestIds.length === 0),
    )
    assert.equal(service.current().repositories[0].worktrees[0].status, 'clean')
    assert.equal(joined.pullRequests.length, 2, 'previously delivered snapshots remain immutable')
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('adoption revalidates exact discovered directories and rejects relocated or forged identities without Git writes', async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'existing')
  const moved = join(root, 'relocated')
  const scheduler = new RepositoryScheduler()
  const service = new WorktreeInventoryService(scheduler, () => {})
  service.setActive(false)
  try {
    git(repo, 'worktree', 'add', '-b', 'existing', linked)
    service.register([repo])
    const read = await service.read({ requestId: 'discovery' })
    const captured = read.repositories[0].worktrees.find((tree) => tree.path === linked)!
    const config = await readFile(join(repo, '.git', 'config'))
    const head = git(repo, 'rev-parse', 'HEAD')
    assert.deepEqual(await adoptionPaths(read, [captured.id], scheduler), [linked])
    await assert.rejects(adoptionPaths(read, ['forged'], scheduler))
    git(repo, 'worktree', 'move', linked, moved)
    await assert.rejects(adoptionPaths(read, [captured.id], scheduler))
    const fresh = await service.read({ requestId: 'relocated' })
    const relocated = fresh.repositories[0].worktrees.find((tree) => tree.path === moved)!
    assert.equal(relocated.id, captured.id)
    assert.deepEqual(await adoptionPaths(fresh, [relocated.id], scheduler), [moved])
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
    assert.deepEqual(await readFile(join(repo, '.git', 'config')), config)
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('credential retirement during a late local read cannot restore the old PR payload', async () => {
  const { root, repo } = await fixture()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  class HeldScheduler extends RepositoryScheduler {
    hold = false
    override read<T>(
      root: string,
      task: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      return super.read(
        root,
        async (combined) => {
          const result = await task(combined)
          if (this.hold) {
            this.hold = false
            entered.resolve()
            await gate.promise
          }
          return result
        },
        signal,
      )
    }
  }
  const scheduler = new HeldScheduler()
  const { getSnapshot } = await import('../src/main/git')
  const service = new WorktreeInventoryService(
    scheduler,
    () => {},
    () => {},
    {},
    (path, signal) => getSnapshot(path, signal, undefined, 'reuse', false, true),
  )
  service.setActive(false)
  try {
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/inventory.git')
    service.register([repo])
    await service.read({ requestId: 'initial' })
    const facts: PullRequest = {
      number: 7,
      title: 'Old account',
      url: 'https://github.com/example/inventory/pull/7',
      head: 'main',
      base: 'main',
      state: 'OPEN',
      draft: false,
      checks: 'none',
    }
    service.adoptRemote({
      path: repo,
      remoteUrl: 'https://github.com/example/inventory.git',
      pullRequests: [facts],
    })
    await service.read({ requestId: 'provider-dependencies' })
    assert.equal(service.current().repositories[0].dependenciesRead?.state, 'complete')
    assert.ok(service.current().repositories[0].dependencyRevision)
    const previousDependencyRevision = service.current().repositories[0].dependencyRevision
    service.adoptRemote({
      path: repo,
      remoteUrl: 'https://github.com/example/inventory.git',
      pullRequests: [{ ...facts, base: 'changed-base' }],
    })
    const changed = service.current().repositories[0]
    assert.equal(changed.dependencies, undefined)
    assert.equal(changed.dependencyDefaultBranch, undefined)
    assert.equal(changed.dependencyRevision, undefined)
    assert.equal(changed.dependenciesRead?.state, 'partial')
    await service.read({ requestId: 'changed-provider-dependencies' })
    assert.notEqual(
      service.current().repositories[0].dependencyRevision,
      previousDependencyRevision,
    )
    scheduler.hold = true
    const late = service.read({ requestId: 'late' })
    await entered.promise
    service.retireRemote()
    gate.resolve()
    const result = await late
    assert.deepEqual(result.repositories[0].pullRequests, [])
    assert.equal(result.repositories[0].worktrees[0].status, 'clean')
    assert.equal(result.repositories[0].dependencies, undefined)
    assert.equal(result.repositories[0].dependencyDefaultBranch, undefined)
    assert.equal(result.repositories[0].dependencyRevision, undefined)
    assert.equal(result.repositories[0].dependenciesRead?.state, 'partial')
    const failed = new WorktreeInventoryService(new RepositoryScheduler(), () => {})
    failed.setActive(false)
    try {
      failed.register([join(root, 'does-not-exist')])
      const missing = await failed.read({ requestId: 'failed' })
      assert.equal(missing.state, 'failed')
      assert.equal(missing.failures.length, 1)
    } finally {
      failed.stop()
    }
  } finally {
    gate.resolve()
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('shared-ref watcher bursts do not dispatch status reads for unaffected worktrees', {
  timeout: 30_000,
}, async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'linked')
  const trace = join(root, 'shared-ref-trace.jsonl')
  const previousTrace = process.env.GIT_TRACE2_EVENT
  let listener: (value: WorktreeInventory) => void = () => {}
  const notified: string[] = []
  const service = new WorktreeInventoryService(
    new RepositoryScheduler(),
    (value) => listener(value),
    (paths) => notified.push(...paths),
  )
  try {
    git(repo, 'worktree', 'add', '-b', 'linked', linked)
    service.register([repo, linked])
    await service.read({ requestId: 'initial-shared' })
    process.env.GIT_TRACE2_EVENT = trace
    const changed = nextInventory(
      service,
      (next) => {
        listener = next
      },
      (value) =>
        value.state === 'complete' &&
        value.repositories[0]?.refs.some((ref) => ref.name === 'refs/heads/external/29') === true,
    )
    for (let index = 0; index < 30; index++)
      git(repo, 'update-ref', `refs/heads/external/${index}`, 'HEAD')
    const result = await changed
    assert.ok(result.repositories[0].worktrees.every((tree) => tree.status === 'clean'))
    assert.ok(
      notified.includes(repo) && notified.includes(linked),
      'Shared metadata forwards local refresh to each actual context',
    )
    const starts = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === 'start')
    const detailReads = starts.filter(
      (event) => event.argv.includes('status') && event.argv.includes('--porcelain=v1'),
    )
    assert.equal(detailReads.length, 0, 'A common ref burst reread unrelated indexes')
    console.log(
      JSON.stringify({
        scenario: 'shared-ref-burst',
        externalRefWrites: 30,
        unrelatedStatusReads: detailReads.length,
      }),
    )
  } finally {
    service.stop()
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previousTrace
    await rm(root, { recursive: true, force: true })
  }
})

test('a path redirected to an independent clone cannot be inspected or adopted as the old worktree authority', async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'linked')
  const clone = join(root, 'replacement clone')
  const scheduler = new RepositoryScheduler()
  const service = new WorktreeInventoryService(scheduler, () => {})
  service.setActive(false)
  try {
    git(repo, 'worktree', 'add', '-b', 'linked', linked)
    git(root, 'clone', '--no-hardlinks', repo, clone)
    service.register([repo])
    const inventory = await service.read({ requestId: 'captured-authority' })
    const captured = inventory.repositories[0].worktrees.find((tree) => tree.path === linked)!
    await writeFile(join(linked, '.git'), `gitdir: ${join(clone, '.git')}\n`)
    const inspected = await inspectWorktree(captured)
    assert.equal(inspected.status, 'unknown')
    assert.equal(inspected.counts, null)
    await assert.rejects(adoptionPaths(inventory, [captured.id], scheduler))
    assert.notEqual(
      (await discoverWorktrees(clone)).identity.id,
      inventory.repositories[0].identity.id,
    )
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('inspection completion rejects an authority redirected while the real status process was held', {
  skip: process.platform === 'win32',
  timeout: 30_000,
}, async () => {
  const { root, repo } = await fixture()
  const linked = join(root, 'linked')
  const clone = join(root, 'same-head clone')
  const wrapper = join(root, 'held-git')
  const socketPath = join(root, 'inspection.sock')
  const held = Promise.withResolvers<Socket>()
  let socket: Socket | undefined
  const server = createServer((connection) => {
    socket = connection
    connection.once('data', () => held.resolve(connection))
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(socketPath, () => listening.resolve())
  await listening.promise
  try {
    git(repo, 'worktree', 'add', '-b', 'linked', linked)
    git(root, 'clone', '--no-hardlinks', repo, clone)
    git(clone, 'checkout', '-b', 'linked')
    await writeFile(join(clone, 'shared.txt'), 'foreign staged index\n')
    git(clone, 'add', 'shared.txt')
    const captured = (await discoverWorktrees(repo)).worktrees.find((tree) => tree.path === linked)!
    assert.equal(git(clone, 'rev-parse', 'HEAD').trimEnd(), captured.headOid)
    const runtime = await resolveGitRuntime()
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { createConnection } = require('node:net')
async function run() {
  const args = process.argv.slice(2)
  if (args.includes('status')) {
    const connection = createConnection(${JSON.stringify(socketPath)})
    const ready = Promise.withResolvers()
    connection.once('error', ready.reject)
    connection.once('connect', () => connection.write('status held'))
    connection.once('data', ready.resolve)
    await ready.promise
    connection.end()
  }
  const result = spawnSync(${JSON.stringify(runtime.executable)}, args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
run().catch((error) => { console.error(error); process.exit(1) })
`,
    )
    await chmod(wrapper, 0o755)
    const inspection = withGitRuntime({ ...runtime, executable: wrapper, source: 'system' }, () =>
      inspectWorktree(captured),
    )
    const connection = await Promise.race([
      held.promise,
      inspection.then(() => {
        throw new Error('Inspection completed before status hold')
      }),
    ])
    await writeFile(join(linked, '.git'), `gitdir: ${join(clone, '.git')}\n`)
    connection.write('resume')
    const result = await inspection
    assert.equal(result.status, 'unknown')
    assert.equal(result.counts, null)
    assert.match(result.read.error ?? '', /authority changed during inspection/)
    assert.notEqual(git(linked, 'status', '--porcelain'), '')
  } finally {
    socket?.destroy()
    const closed = Promise.withResolvers<void>()
    server.close((error) => (error ? closed.reject(error) : closed.resolve()))
    await closed.promise
    await rm(root, { recursive: true, force: true })
  }
})

test('deactivation retires a held automatic detail batch but preserves explicit reads and adoption', {
  skip: process.platform === 'win32',
  timeout: 40_000,
}, async () => {
  const { root, repo } = await fixture()
  const wrapper = join(root, 'held-inventory-git')
  const socketPath = join(root, 'inventory.sock')
  const scheduler = new MeasuredScheduler()
  const publications: WorktreeInventory[] = []
  let listener: (value: WorktreeInventory) => void = () => {}
  const service = new WorktreeInventoryService(
    scheduler,
    (value) => {
      publications.push(value)
      listener(value)
    },
    undefined,
    { recursiveWatch: false },
  )
  const connections: { socket: Socket; closed: Promise<void> }[] = []
  let hold = true
  let target = WORKTREE_READ_CONCURRENCY
  let held = Promise.withResolvers<void>()
  const server = createServer((socket) => {
    const closed = Promise.withResolvers<void>()
    socket.once('close', closed.resolve)
    socket.once('data', () => {
      connections.push({ socket, closed: closed.promise })
      if (!hold) socket.write('resume')
      if (connections.length === target) held.resolve()
    })
  })
  const listening = Promise.withResolvers<void>()
  server.once('error', listening.reject)
  server.listen(socketPath, listening.resolve)
  await listening.promise
  service.setActive(false)
  try {
    for (let index = 1; index < 5; index++)
      git(repo, 'worktree', 'add', '-b', `inactive/${index}`, join(root, `linked-${index}`))
    service.register([repo])
    const first = await service.read({ requestId: 'cold-inactive' })
    for (const tree of first.repositories[0].worktrees)
      await writeFile(join(tree.path, 'shared.txt'), 'changed while inactive\n')
    const runtime = await resolveGitRuntime()
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { createConnection } = require('node:net')
async function run() {
  const args = process.argv.slice(2)
  if (args.includes('--porcelain=v1')) {
    const connection = createConnection(${JSON.stringify(socketPath)})
    const ready = Promise.withResolvers()
    connection.once('error', ready.reject)
    connection.once('connect', () => connection.write('detail held'))
    connection.once('data', ready.resolve)
    await ready.promise
    connection.end()
  }
  const result = spawnSync(${JSON.stringify(runtime.executable)}, args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
run().catch((error) => { console.error(error); process.exit(1) })
`,
    )
    await chmod(wrapper, 0o755)
    await withGitRuntime({ ...runtime, executable: wrapper, source: 'system' }, async () => {
      service.setActive(true)
      await held.promise
      assert.equal(connections.length, WORKTREE_READ_CONCURRENCY)
      const beforeInactive = publications.length
      const heldInventory = structuredClone(service.current())
      assert.equal(heldInventory.state, 'partial')
      for (const tree of heldInventory.repositories[0].worktrees) {
        assert.equal(tree.counts, null)
        assert.equal(tree.read.observedAt, null)
      }
      service.setActive(false)
      await Promise.all(connections.map((connection) => connection.closed))
      await scheduler.quiesce(repo)
      assert.equal(
        connections.length,
        WORKTREE_READ_CONCURRENCY,
        'Queued details dispatched inactive',
      )
      assert.equal(publications.length, beforeInactive, 'Automatic batch published inactive')
      assert.deepEqual(service.current(), heldInventory, 'Retired automatic details changed facts')

      hold = false
      const automaticResume = nextInventory(
        service,
        (next) => {
          listener = next
        },
        (value) =>
          value.generation > first.generation &&
          value.state === 'complete' &&
          value.repositories[0]?.worktrees.every((tree) => tree.status === 'dirty'),
      )
      service.setActive(true)
      await automaticResume
      assert.equal(connections.length, WORKTREE_READ_CONCURRENCY + 5)
      service.setActive(false)

      // A caller can use the same request ID; origin is not inferred from payload data.
      held = Promise.withResolvers<void>()
      target = connections.length + 1
      hold = true
      service.setActive(true)
      const explicit = service.read({
        requestId: 'inventory-watch',
        selectedWorktreeId: first.repositories[0].worktrees[0].id,
      })
      await held.promise
      service.setActive(false)
      hold = false
      for (const connection of connections)
        if (!connection.socket.destroyed) connection.socket.write('resume')
      const authorized = await explicit
      assert.ok(authorized.repositories[0].worktrees.every((tree) => tree.status === 'dirty'))
      const selected = authorized.repositories[0].worktrees[0]
      assert.deepEqual(await adoptionPaths(authorized, [selected.id], scheduler), [selected.path])
      assert.ok(scheduler.maximum <= WORKTREE_READ_CONCURRENCY)

      for (const tree of authorized.repositories[0].worktrees)
        await writeFile(join(tree.path, 'shared.txt'), 'base\n')
      const resumed = nextInventory(
        service,
        (next) => {
          listener = next
        },
        (value) =>
          value.generation > authorized.generation &&
          value.state === 'complete' &&
          value.repositories[0]?.worktrees.every((tree) => tree.status === 'clean'),
      )
      service.setActive(true)
      const revalidated = await resumed
      assert.equal(revalidated.repositories[0].worktrees.length, 5)
      assert.ok(scheduler.maximum <= WORKTREE_READ_CONCURRENCY)
    })
  } finally {
    service.stop()
    for (const connection of connections) connection.socket.destroy()
    const closed = Promise.withResolvers<void>()
    server.close((error) => (error ? closed.reject(error) : closed.resolve()))
    await closed.promise
    await rm(root, { recursive: true, force: true })
  }
})

test('fork PR heads join only the qualified fork ref and its local upstream despite same-name same-OID remotes', async () => {
  const { root, repo } = await fixture()
  const service = new WorktreeInventoryService(new RepositoryScheduler(), () => {})
  service.setActive(false)
  try {
    const oid = git(repo, 'rev-parse', 'HEAD').trimEnd()
    git(repo, 'remote', 'add', 'origin', 'https://github.com/example/inventory.git')
    git(repo, 'remote', 'add', 'fork', 'https://github.com/contributor/inventory.git')
    git(
      repo,
      'remote',
      'add',
      'lookalike',
      'https://enterprise.example.test/contributor/inventory.git',
    )
    for (const remote of ['origin', 'fork', 'lookalike'])
      git(repo, 'update-ref', `refs/remotes/${remote}/topic`, oid)
    git(repo, 'branch', 'topic')
    git(repo, 'branch', 'origin-local')
    git(repo, 'branch', '--set-upstream-to=origin/topic', 'origin-local')
    git(repo, 'worktree', 'add', '-b', 'fork-local', join(root, 'fork checkout'))
    git(repo, 'branch', '--set-upstream-to=fork/topic', 'fork-local')
    service.register([repo])
    await service.read({ requestId: 'fork-initial' })
    service.adoptRemote({
      path: repo,
      remoteUrl: 'https://github.com/example/inventory.git',
      pullRequests: [
        {
          number: 17,
          title: 'Fork head',
          url: 'https://github.com/example/inventory/pull/17',
          head: 'topic',
          headOid: oid,
          headRepository: 'contributor/inventory',
          base: 'main',
          state: 'OPEN',
          draft: false,
          checks: 'none',
        },
      ],
    })
    const repository = service.current().repositories[0]
    const association = repository.pullRequests[0]
    const expected = repository.refs.filter(
      (ref) => ref.name === 'refs/remotes/fork/topic' || ref.name === 'refs/heads/fork-local',
    )
    assert.deepEqual([...association.refIds].sort(), expected.map((ref) => ref.id).sort())
    assert.equal(expected.find((ref) => ref.kind === 'local')?.worktreeIds.length, 1)
    assert.ok(
      repository.refs
        .filter((ref) => !expected.includes(ref))
        .every((ref) => !ref.pullRequestIds.includes(association.id)),
    )
  } finally {
    service.stop()
    await rm(root, { recursive: true, force: true })
  }
})
