import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { ProgressivePullRequestIndex, type PullRequestIndexPage } from '../src/main/pr-index'
import type { PullRequest } from '../src/shared/types'

const pr = (number: number): PullRequest => ({
  number,
  title: String(number),
  url: `https://github.com/acme/widgets/pull/${number}`,
  head: `h${number}`,
  base: 'main',
  state: 'OPEN',
  draft: false,
  checks: 'none',
  author: 'someone',
  reviewRequested: [],
  reviewRequestsComplete: true,
  metadata: 'degraded',
})
const page = (number: number, next: string | null): PullRequestIndexPage => ({
  pullRequests: [pr(number)],
  next,
  viewer: null,
  conservative: false,
})

test('first usable page precedes enumeration; a failed later page retains topology', async () => {
  const second = Promise.withResolvers<PullRequestIndexPage>()
  const published: number[][] = []
  let calls = 0
  const index = new ProgressivePullRequestIndex(
    async () => (++calls === 1 ? page(1, 'more') : second.promise),
    async () => 'account-one',
    (state) => published.push(state.pullRequests.map((item) => item.number)),
    () => true,
  )
  const first = await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  assert.deepEqual(
    first.pullRequests.map((item) => item.number),
    [1],
  )
  assert.equal(first.complete, false)
  assert.equal(first.state, 'partial')
  second.reject(new Error('network failed'))
  await nextTurn()
  assert.equal(index.current()?.state, 'error')
  assert.deepEqual(
    index.current()?.pullRequests.map((item) => item.number),
    [1],
  )
  assert.equal(
    published.some((items) => items.length === 0),
    true,
  )
  assert.equal(calls, 2)
})

test('cancel and account replacement reject a pending first page without publishing it', async () => {
  const pending = Promise.withResolvers<PullRequestIndexPage>()
  let identity = 'first'
  let count = 0
  const index = new ProgressivePullRequestIndex(
    async () => {
      count++
      return pending.promise
    },
    async () => identity,
    () => {},
    () => true,
  )
  const read = index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  await nextTurn()
  index.cancel()
  await assert.rejects(read)
  pending.resolve(page(1, null))
  await nextTurn()
  assert.equal(index.current()?.state, 'stale')
  const next = Promise.withResolvers<PullRequestIndexPage>()
  const replaced = new ProgressivePullRequestIndex(
    async () => next.promise,
    async () => identity,
    () => {},
    () => true,
  )
  const request = replaced.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  await nextTurn()
  identity = 'second'
  next.resolve(page(9, null))
  await assert.rejects(request)
  assert.equal(replaced.current(), null)
  assert.equal(count, 1)
})

test('out-of-order pages from retired generation cannot undo newer full snapshot; detail retention is bounded', async () => {
  const delayed = Promise.withResolvers<PullRequestIndexPage>()
  let calls = 0
  const index = new ProgressivePullRequestIndex(
    async () => (++calls === 1 ? page(1, 'more') : delayed.promise),
    async () => 'account',
    () => {},
    () => true,
  )
  await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  await nextTurn()
  index.adopt('/tmp/repo', 'github.com', 'acme/widgets', [pr(10)])
  delayed.resolve(page(2, null))
  await nextTurn()
  assert.deepEqual(
    index.current()?.pullRequests.map((item) => item.number),
    [10],
  )
  let reads = 0
  for (let number = 1; number <= 5; number++)
    await index.selected(number, async () => {
      reads++
      return { ...pr(number), body: String(number) }
    })
  await index.selected(5, async () => {
    reads++
    return { ...pr(5), body: 'wrong' }
  })
  assert.equal(reads, 5)
  await index.selected(1, async () => {
    reads++
    return { ...pr(1), body: 'new' }
  })
  assert.equal(reads, 6)
})

test('host budget parks later pages without claiming complete scope or losing confirmed topology', async () => {
  let calls = 0
  let fail = false
  const index = new ProgressivePullRequestIndex(
    async () => {
      calls++
      if (fail) throw new Error('network failed')
      return page(2, 'more')
    },
    async () => 'account',
    () => {},
    () => false,
  )
  index.adopt('/tmp/repo', 'github.com', 'acme/widgets', [pr(1)])
  index.cancel()
  const first = await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  await nextTurn()
  assert.equal(first.complete, false)
  assert.deepEqual(
    first.pullRequests.map((item) => item.number),
    [1, 2],
  )
  assert.equal(calls, 1)
  assert.match(index.current()?.message ?? '', /paused/)
  index.cancel()
  fail = true
  const failed = await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  assert.equal(failed.state, 'error')
  assert.equal(failed.complete, false)
  assert.deepEqual(
    failed.pullRequests.map((item) => item.number),
    [1, 2],
  )
})

for (const changedHead of [false, true]) {
  test(`refreshed ${changedHead ? 'head and base' : 'same-head base'} retires selected detail`, async () => {
    let source = { ...pr(1), headOid: 'a'.repeat(40) }
    let reads = 0
    const index = new ProgressivePullRequestIndex(
      async () => ({
        ...page(1, null),
        pullRequests: [source],
      }),
      async () => 'account',
      () => {},
      () => true,
    )
    await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
    const read = async () => {
      reads++
      return { ...source, body: `body-${reads}` }
    }
    assert.equal((await index.selected(1, read)).base, 'main')
    index.cancel()
    source = {
      ...source,
      base: 'new-base',
      headOid: changedHead ? 'b'.repeat(40) : source.headOid,
    }
    await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
    const selected = await index.selected(1, read)
    assert.equal(selected.base, 'new-base')
    assert.equal(selected.headOid, source.headOid)
    assert.equal(reads, 2)
  })
}

test('complete adoption before first page does not starve independently sourced viewer facts', async () => {
  const pending = Promise.withResolvers<PullRequestIndexPage>()
  let calls = 0
  const index = new ProgressivePullRequestIndex(
    async () => (++calls === 1 ? pending.promise : { ...page(1, null), viewer: 'alice' }),
    async () => 'account',
    () => {},
    () => true,
  )
  const initial = index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  await nextTurn()
  index.adopt('/tmp/repo', 'github.com', 'acme/widgets', [pr(1)])
  assert.equal((await initial).viewer, null)
  const complete = await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  assert.equal(complete.viewer, 'alice')
  assert.equal(complete.complete, true)
  assert.equal(calls, 2)
  pending.resolve({ ...page(9, null), viewer: 'obsolete-account' })
  await nextTurn()
  assert.equal(index.current()?.viewer, 'alice')
  index.invalidate()
  assert.equal(index.current(), null)
})

test('a selected read overtaken by a later page cannot return its old revision', async () => {
  const later = Promise.withResolvers<PullRequestIndexPage>()
  const detail = Promise.withResolvers<PullRequest & { body: string }>()
  let calls = 0
  const old = { ...pr(1), headOid: 'a'.repeat(40) }
  const index = new ProgressivePullRequestIndex(
    async () => (++calls === 1 ? { ...page(1, 'more'), pullRequests: [old] } : later.promise),
    async () => 'account',
    () => {},
    () => true,
  )
  await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  const selected = index.selected(1, () => detail.promise)
  await nextTurn()
  later.resolve({
    ...page(1, null),
    pullRequests: [{ ...old, base: 'retargeted' }],
  })
  await nextTurn()
  detail.resolve({ ...old, body: 'old body' })
  await assert.rejects(selected)
})

test('source changes during the final authority fence cannot revive old selected detail', async () => {
  const later = Promise.withResolvers<PullRequestIndexPage>()
  const finalAuthority = Promise.withResolvers<string>()
  const authorityStarted = Promise.withResolvers<void>()
  let blockNextAuthority = false
  let pages = 0
  const old = { ...pr(1), headOid: 'a'.repeat(40) }
  const index = new ProgressivePullRequestIndex(
    async () => (++pages === 1 ? { ...page(1, 'more'), pullRequests: [old] } : later.promise),
    async () => {
      if (blockNextAuthority) {
        blockNextAuthority = false
        authorityStarted.resolve()
        return finalAuthority.promise
      }
      return 'account'
    },
    () => {},
    () => true,
  )
  await index.load('/tmp/repo', 'github.com', 'https://github.com/acme/widgets')
  const selected = index.selected(1, async () => {
    blockNextAuthority = true
    return { ...old, body: 'old body' }
  })
  await authorityStarted.promise
  later.resolve({ ...page(1, null), pullRequests: [{ ...old, base: 'retargeted' }] })
  await nextTurn()
  finalAuthority.resolve('account')
  await assert.rejects(selected)
})
