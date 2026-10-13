import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getSnapshot, retireConfirmedGitHubPayloads } from '../src/main/git'
import { CommandCancelled } from '../src/main/git-core'
import { RepositoryScheduler } from '../src/main/repository-scheduler'
import { setGitHubHostTransport, type GitHubTransport } from '../src/main/github-transport'

interface Gate {
  promise: Promise<void>
  resolve: () => void
}

test('tracked detail failure degrades snapshots and retains only qualified background facts', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'tracked-payload-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  let authority = 'tracked-account'
  let detailFails = true
  let offline = false
  let cancel = false
  const node = {
    number: 7,
    title: 'Recorded PR',
    url: 'https://github.com/acme/widgets/pull/7',
    headRefName: 'main',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    isDraft: false,
    state: 'MERGED',
    body: '',
    headRepository: { nameWithOwner: 'acme/widgets' },
  }
  const transport: GitHubTransport = {
    kind: 'gh',
    destinationHost: 'github.com',
    async credentialAuthority() {
      return authority
    },
    async rest() {
      throw new Error('Native stacks unavailable in fixture')
    },
    async paginate() {
      throw new Error('Unexpected pagination')
    },
    async graphql<T>(query: string): Promise<T> {
      if (offline) throw new Error('network offline')
      if (query.includes('pullRequest(number:')) {
        if (cancel) throw new CommandCancelled()
        if (detailFails) throw new Error('tracked detail unavailable')
        return { repository: { pullRequest: node } } as T
      }
      const connection = {
        nodes: query.includes('issues(first:')
          ? []
          : [{ ...node, number: 8, state: 'OPEN', headRefName: 'feature' }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }
      return {
        repository: query.includes('issues(first:')
          ? { issues: connection }
          : { pullRequests: connection },
      } as T
    },
  }
  try {
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('commit', '--allow-empty', '-m', 'base')
    git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
    git('config', 'branch.main.gitstackspr', '7')
    await writeFile(join(root, 'local.txt'), 'local facts\n')
    setGitHubHostTransport('github.com', transport)
    retireConfirmedGitHubPayloads()
    const failed = await getSnapshot(root, undefined, 0, 'live')
    assert.equal(failed.files.length, 1)
    assert.deepEqual(
      failed.pullRequests.map((pr) => pr.number),
      [8],
    )
    assert.equal(failed.github.available, false)
    assert.match(failed.githubStale!.reason, /tracked detail unavailable/)
    detailFails = false
    const confirmed = await getSnapshot(root, undefined, 0, 'live')
    assert.equal(confirmed.github.available, true)
    assert.deepEqual(
      confirmed.pullRequests.map((pr) => pr.number),
      [8, 7],
    )
    detailFails = true
    const degraded = await getSnapshot(root, undefined, 0, 'on-failure')
    assert.deepEqual(
      degraded.pullRequests.map((pr) => pr.number),
      [8, 7],
    )
    assert.equal(degraded.github.available, false)
    assert.ok(degraded.githubStale)
    const strict = await getSnapshot(root, undefined, 0, 'live')
    assert.deepEqual(
      strict.pullRequests.map((pr) => pr.number),
      [8],
    )
    assert.equal(strict.github.available, false)
    offline = true
    const retained = await getSnapshot(root, undefined, 0, 'on-failure')
    assert.deepEqual(
      retained.pullRequests.map((pr) => pr.number),
      [8, 7],
    )
    assert.ok(retained.githubStale)
    offline = false
    authority = 'another-account'
    const replaced = await getSnapshot(root, undefined, 0, 'on-failure')
    assert.deepEqual(
      replaced.pullRequests.map((pr) => pr.number),
      [8],
    )
    cancel = true
    await assert.rejects(getSnapshot(root, undefined, 0, 'live'), CommandCancelled)
  } finally {
    retireConfirmedGitHubPayloads()
    setGitHubHostTransport('github.com', null)
    await rm(root, { recursive: true, force: true })
  }
})

test('independent clones share qualified provider reads without sharing local status', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'remote-authority-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
  let authority = 'account-one'
  let offline = false
  let reads = 0
  let gate: Gate | null = null
  let entered: Gate | null = null
  let revision = 'initial'
  const transport: GitHubTransport = {
    kind: 'gh',
    destinationHost: 'github.com',
    async credentialAuthority() {
      return authority
    },
    async rest() {
      throw new Error('Native stacks unavailable in this owned provider fixture')
    },
    async paginate() {
      throw new Error('Unexpected pagination')
    },
    async graphql<T>(query: string): Promise<T> {
      reads += 1
      const observed = revision
      entered?.resolve()
      await gate?.promise
      if (offline) throw new Error('network offline')
      const connection = {
        nodes: query.includes('issues(first:')
          ? [{ number: 1, title: observed, url: 'https://github.com/acme/widgets/issues/1' }]
          : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }
      return {
        repository: query.includes('issues(first:')
          ? { issues: connection }
          : { pullRequests: connection },
      } as T
    },
  }
  try {
    execFileSync('git', ['init', '-b', 'main', first], { stdio: 'pipe' })
    git(first, 'config', 'user.name', 'Fixture')
    git(first, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(first, 'tracked'), 'base\n')
    git(first, 'add', '.')
    git(first, 'commit', '-m', 'base')
    execFileSync('git', ['clone', first, second], { stdio: 'pipe' })
    git(first, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git')
    git(second, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
    await writeFile(join(first, 'tracked'), 'dirty\n')
    setGitHubHostTransport('github.com', transport)
    retireConfirmedGitHubPayloads()
    gate = Promise.withResolvers<void>()
    entered = Promise.withResolvers<void>()
    const initial = getSnapshot(first, undefined, 0, 'select')
    await entered.promise
    const sibling = getSnapshot(second, undefined, 0, 'select')
    gate.resolve()
    const [a, b] = await Promise.all([initial, sibling])
    assert.notEqual(a.path, b.path)
    const [firstGit, secondGit] = await Promise.all([
      stat(join(first, '.git')),
      stat(join(second, '.git')),
    ])
    assert.notDeepEqual([firstGit.dev, firstGit.ino], [secondGit.dev, secondGit.ino])
    assert.equal(a.files.length, 1)
    assert.equal(b.files.length, 0)
    assert.equal(reads, 2)
    await getSnapshot(second, undefined, 0, 'select')
    assert.equal(reads, 2)
    await getSnapshot(second, undefined, 0, 'live')
    assert.equal(reads, 4)
    offline = true
    const retained = await getSnapshot(first, undefined, 0, 'on-failure')
    offline = false
    gate = Promise.withResolvers<void>()
    entered = Promise.withResolvers<void>()
    revision = 'older'
    const older = getSnapshot(first, undefined, 0, 'live')
    await entered.promise
    const olderGate = gate
    gate = null
    entered = null
    revision = 'newer'
    await getSnapshot(second, undefined, 0, 'live')
    olderGate.resolve()
    await older
    const newest = await getSnapshot(first, undefined, 0, 'reuse')
    assert.equal(newest.issues?.[0]?.title, 'newer')
    assert.equal(retained.github.available, true)
    assert.ok(retained.githubStale)
    offline = true
    authority = 'account-two'
    const replaced = await getSnapshot(first, undefined, 0, 'select')
    assert.equal(replaced.github.available, false)
    assert.ok(replaced.githubFailure)
    offline = false
    git(second, 'remote', 'set-url', 'origin', 'https://github.com/other/widgets.git')
    const before = reads
    await getSnapshot(second, undefined, 0, 'select')
    assert.equal(reads, before + 2)
    git(
      second,
      'remote',
      'set-url',
      'origin',
      'https://github.enterprise.invalid/other/widgets.git',
    )
    setGitHubHostTransport('github.enterprise.invalid', transport)
    const hostReads = reads
    await getSnapshot(second, undefined, 0, 'select')
    assert.equal(reads, hostReads + 2)
    git(second, 'remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git')
    for (const mode of ['quiesce', 'mutate'] as const) {
      retireConfirmedGitHubPayloads()
      gate = Promise.withResolvers<void>()
      entered = Promise.withResolvers<void>()
      revision = `surviving-${mode}`
      const scheduler = new RepositoryScheduler()
      const controller = new AbortController()
      const cancelled = scheduler.read(
        first,
        (signal) => getSnapshot(first, signal, 0, 'select'),
        controller.signal,
      )
      const cancelledResult = assert.rejects(cancelled, CommandCancelled)
      await entered.promise
      let survivorSettled = false
      const survivor = scheduler
        .read(second, (signal) => getSnapshot(second, signal, 0, 'select'))
        .finally(() => {
          survivorSettled = true
        })
      const beforeRelease: number = reads
      if (mode === 'quiesce') {
        controller.abort()
        await scheduler.quiesce(first)
      }
      await scheduler.mutate(first, async () => {
        git(first, 'config', 'fixture.local-operation', mode)
      })
      await cancelledResult
      assert.equal(git(first, 'config', 'fixture.local-operation').toString().trim(), mode)
      assert.equal(survivorSettled, false)
      assert.equal(reads, beforeRelease)
      gate.resolve()
      const survived = await survivor
      assert.equal(survived.github.available, true)
      assert.equal(survived.issues?.[0]?.title, `surviving-${mode}`)
      assert.equal(survived.files.length, 0)
      const resumed = await getSnapshot(first, undefined, 0, 'reuse')
      assert.equal(resumed.issues?.[0]?.title, `surviving-${mode}`)
      assert.equal(resumed.files.length, 1)
      assert.equal(reads, beforeRelease)
    }
    gate = Promise.withResolvers<void>()
    entered = Promise.withResolvers<void>()
    const retired = getSnapshot(first, undefined, 0, 'live')
    const retiredResult = assert.rejects(retired)
    await entered.promise
    authority = 'account-three'
    retireConfirmedGitHubPayloads()
    gate.resolve()
    await retiredResult
    gate = null
    entered = null
    gate = Promise.withResolvers<void>()
    entered = Promise.withResolvers<void>()
    const moved = getSnapshot(first, undefined, 0, 'live')
    const movedResult = assert.rejects(moved)
    await entered.promise
    git(first, 'remote', 'set-url', 'origin', 'https://github.com/replaced/widgets.git')
    gate.resolve()
    await movedResult
    gate = null
    entered = null
    git(second, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git')
    const foreign = await getSnapshot(second, undefined, 0, 'reuse')
    assert.equal(foreign.github.available, false)
    assert.equal(foreign.files.length, 0)
  } finally {
    gate?.resolve()
    retireConfirmedGitHubPayloads()
    setGitHubHostTransport('github.com', null)
    setGitHubHostTransport('github.enterprise.invalid', null)
    await rm(root, { recursive: true, force: true })
  }
})
