import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PullRequestInboxFilters } from '../src/main/pr-inbox-filters'
import {
  evaluatePullRequestInbox,
  filterPullRequestInbox,
  parsePullRequestInboxFilterDraft,
  parsePullRequestInboxSavedFilters,
  sortPullRequestInbox,
  type PullRequestInboxFilter,
  type PullRequestInboxItem,
} from '../src/shared/pr-inbox'

const row: PullRequestInboxItem = {
  number: 42,
  title: 'Review the bounded queue',
  url: 'https://github.com/acme/app/pull/42',
  repository: 'acme/app',
  repositoryPath: '/app',
  host: 'github.com',
  head: 'feature',
  base: 'main',
  state: 'OPEN',
  draft: false,
  checks: 'passing',
  author: 'Ada',
  reviewRequested: ['Grace'],
  reviewRequestsComplete: true,
  reviewDecision: 'APPROVED',
  lastTurnLogin: null,
  updatedAt: '2026-10-01T00:00:00Z',
  mergedAt: null,
  metadata: 'full',
  groups: ['review-requested'],
  changeSize: { state: 'known', value: 0 },
  unresolvedThreads: { state: 'known', value: 0 },
}
const view: PullRequestInboxFilter = {
  group: 'review-requested',
  search: 'bounded',
  sort: 'size-asc',
  criteria: {
    repositories: ['acme/app', 'acme/lib'],
    authors: ['ada', 'Lin'],
    reviewers: ['grace'],
    lifecycle: ['open'],
    reviews: ['APPROVED'],
    checks: ['passing'],
    minSize: 0,
    maxSize: 10,
  },
}

test('structured conditions AND fields, OR values, case-insensitive identities and unconstrained absences', () => {
  const other = { ...row, repository: 'acme/lib', author: 'Lin', number: 43 }
  assert.deepEqual(
    filterPullRequestInbox([row, other, { ...row, number: 44, checks: 'failing' }], view).map(
      (item) => item.number,
    ),
    [42, 43],
  )
  assert.equal(evaluatePullRequestInbox({ ...row, author: 'Other' }, view), 'excluded')
  assert.equal(evaluatePullRequestInbox({ ...row, reviewRequested: ['Other'] }, view), 'excluded')
  assert.equal(evaluatePullRequestInbox({ ...row, draft: true }, view), 'excluded')
  assert.equal(
    evaluatePullRequestInbox({ ...row, changeSize: { state: 'known', value: 11 } }, view),
    'excluded',
  )
  assert.equal(filterPullRequestInbox([row], { ...view, criteria: {} }).length, 1)
})

test('zero matches zero but unavailable, stale and truncated facts cannot be evaluated', () => {
  const zero = { ...view, criteria: { minSize: 0, maxSize: 0 } }
  assert.equal(evaluatePullRequestInbox(row, zero), 'match')
  for (const state of ['unknown', 'unsupported', 'stale'] as const) {
    assert.equal(evaluatePullRequestInbox({ ...row, changeSize: { state } }, zero), 'unknown')
  }
  assert.equal(
    evaluatePullRequestInbox({ ...row, changeSize: { state: 'truncated', value: 0 } }, zero),
    'unknown',
  )
  assert.equal(evaluatePullRequestInbox({ ...row, metadata: 'degraded' }, view), 'unknown')
  assert.equal(evaluatePullRequestInbox({ ...row, checksKnown: false }, view), 'unknown')
  assert.equal(evaluatePullRequestInbox({ ...row, reviewKnown: false }, view), 'unknown')
  assert.equal(evaluatePullRequestInbox({ ...row, author: null }, view), 'unknown')
  assert.equal(
    evaluatePullRequestInbox({ ...row, reviewRequested: [], reviewRequestsComplete: false }, view),
    'unknown',
  )
})

test('size sort keeps unavailable last in either direction and uses complete PR identity ties', () => {
  const rows = [
    { ...row, number: 7, host: 'z.example', changeSize: { state: 'known' as const, value: 0 } },
    { ...row, number: 9, changeSize: { state: 'unknown' as const } },
    { ...row, number: 8, changeSize: { state: 'known' as const, value: 10 } },
    row,
  ]
  assert.deepEqual(
    sortPullRequestInbox(rows, 'size-asc').map((item) => item.number),
    [42, 7, 8, 9],
  )
  assert.deepEqual(
    sortPullRequestInbox(rows, 'size-desc').map((item) => item.number),
    [8, 42, 7, 9],
  )
  assert.deepEqual(
    sortPullRequestInbox([...rows].reverse(), 'size-asc'),
    sortPullRequestInbox(rows, 'size-asc'),
  )
})

test('legacy disk views migrate names, identities and exact membership without accepting legacy runtime drafts', () => {
  const legacy = {
    id: 'kept',
    name: 'Legacy',
    group: 'review-requested',
    search: 'bounded',
    repository: 'ACME/app',
  }
  const migrated = parsePullRequestInboxSavedFilters([legacy])[0]
  assert.equal(migrated.id, 'kept')
  assert.equal(migrated.name, 'Legacy')
  assert.deepEqual(migrated.criteria, { repositories: ['ACME/app'] })
  assert.deepEqual(filterPullRequestInbox([row, { ...row, repository: 'acme/lib' }], migrated), [
    row,
  ])
  assert.equal(parsePullRequestInboxFilterDraft(legacy), null)
  for (const criteria of [
    { minSize: -1 },
    { minSize: 10, maxSize: 1 },
    { checks: ['unknown'] },
    { nested: [] },
  ]) {
    assert.equal(parsePullRequestInboxFilterDraft({ ...view, name: 'Invalid', criteria }), null)
  }
})

test('saved-file legacy and structured entries require a string search without widening malformed questions', () => {
  for (const stored of [
    { id: 'legacy', name: 'Legacy', group: 'drafts', repository: null },
    { id: 'structured', name: 'Structured', group: 'drafts', criteria: {}, sort: 'updated-desc' },
  ]) {
    assert.deepEqual(parsePullRequestInboxSavedFilters([stored]), [])
    assert.deepEqual(parsePullRequestInboxSavedFilters([{ ...stored, search: null }]), [])
    assert.equal(parsePullRequestInboxSavedFilters([{ ...stored, search: '' }]).length, 1)
  }
  assert.equal(
    parsePullRequestInboxFilterDraft({ ...view, name: 'Runtime', search: undefined })?.search,
    '',
  )
})

test('atomic store restores all criteria and sort; initialization overlapping update and removal preserves unrelated views', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-views-'))
  const file = join(dir, 'views.json')
  try {
    await writeFile(
      file,
      JSON.stringify({
        filters: [
          { id: 'old', name: 'Old', group: 'review-requested', search: '', repository: null },
          { id: 'other', name: 'Other', group: 'drafts', search: '', repository: null },
        ],
      }),
    )
    const store = new PullRequestInboxFilters(file)
    const loading = store.settled()
    const updated = await store.save([
      { ...view, id: 'old', name: 'Old' },
      { ...view, id: 'other', name: 'Other', group: 'drafts', criteria: {}, sort: 'updated-desc' },
    ])
    await loading
    assert.deepEqual(
      updated.map((entry) => entry.id),
      ['old', 'other'],
    )
    assert.deepEqual(await store.settled(), updated)
    const reopened = new PullRequestInboxFilters(file)
    assert.deepEqual(await reopened.settled(), updated)
    assert.deepEqual(filterPullRequestInbox([row], (await reopened.settled())[0]), [row])
    const copy = reopened.list()
    copy[0].criteria.repositories?.push('intruder/repo')
    assert.deepEqual(reopened.list(), updated)
    const removed = await reopened.save([updated[1]])
    assert.deepEqual(removed, [updated[1]])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).filters, removed)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
