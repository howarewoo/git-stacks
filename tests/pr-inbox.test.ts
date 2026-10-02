import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_PULL_REQUEST_INBOX_BUDGET,
  PULL_REQUEST_INBOX_DEFAULT_FILTER,
  PULL_REQUEST_INBOX_GROUPS,
  derivePullRequestInboxState,
  filterPullRequestInbox,
  inboxGroupOverlapsAllowed,
  isPullRequestInboxGroupId,
  matchesPullRequestInboxSearch,
  parsePullRequestInboxSavedFilters,
  pullRequestInboxBudgetAllows,
  pullRequestInboxGroups,
  pullRequestInboxPresentation,
  pullRequestInboxQueueCount,
  pullRequestInboxRefreshFailure,
  pullRequestInboxRepositoryStatusLabel,
  sortPullRequestInbox,
  type PullRequestInboxFilter,
  type PullRequestInboxGroupId,
  type PullRequestInboxItem,
  type PullRequestInboxRefresh,
  type PullRequestInboxRepositoryReport,
  type PullRequestInboxSignals,
} from '../src/shared/pr-inbox'
import { PullRequestInboxFilters } from '../src/main/pr-inbox-filters'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const VIEWER = 'ada'

function signals(overrides: Partial<PullRequestInboxSignals> = {}): PullRequestInboxSignals {
  return {
    state: 'OPEN',
    draft: false,
    author: 'grace',
    reviewRequested: [],
    reviewDecision: 'REVIEW_REQUIRED',
    lastTurnLogin: null,
    updatedAt: '2026-02-28T12:00:00.000Z',
    mergedAt: null,
    metadata: 'full',
    ...overrides,
  }
}

function groupsOf(overrides: Partial<PullRequestInboxSignals> = {}): PullRequestInboxGroupId[] {
  return pullRequestInboxGroups(signals(overrides), { viewer: VIEWER, now: NOW })
}

function mergedDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString()
}

function groupsAt(
  overrides: Partial<PullRequestInboxSignals> = {},
  options: { mergedWithinDays?: number } = {},
): PullRequestInboxGroupId[] {
  return pullRequestInboxGroups(signals(overrides), { viewer: VIEWER, now: NOW, ...options })
}

function item(overrides: Partial<PullRequestInboxItem> = {}): PullRequestInboxItem {
  return {
    number: 1,
    title: 'A pull request',
    url: 'https://github.com/acme/app/pull/1',
    head: 'feature',
    base: 'main',
    state: 'OPEN',
    draft: false,
    checks: 'none',
    repository: 'acme/app',
    repositoryPath: '/repos/app',
    host: 'github.com',
    author: 'grace',
    reviewRequested: [],
    reviewDecision: null,
    lastTurnLogin: null,
    updatedAt: '2026-02-28T12:00:00.000Z',
    mergedAt: null,
    metadata: 'full',
    groups: ['review-requested'],
    ...overrides,
  }
}

function repositoryReport(
  repository: string,
  status: PullRequestInboxRepositoryReport['status'] = 'ok',
): PullRequestInboxRepositoryReport {
  return {
    repository,
    path: `/repos/${repository}`,
    host: 'github.com',
    status,
    viewer: VIEWER,
    detail: '',
  }
}

function refresh(overrides: Partial<PullRequestInboxRefresh> = {}): PullRequestInboxRefresh {
  return {
    state: 'fresh',
    confirmedAt: '2026-03-01T12:00:00.000Z',
    checkedAt: '2026-03-01T12:00:00.000Z',
    viewer: VIEWER,
    requests: 2,
    budget: DEFAULT_PULL_REQUEST_INBOX_BUDGET,
    repositories: [repositoryReport('acme/app')],
    truncated: [],
    detail: '1 registered repository read.',
    ...overrides,
  }
}

function filterWith(overrides: Partial<PullRequestInboxFilter>): PullRequestInboxFilter {
  return { ...PULL_REQUEST_INBOX_DEFAULT_FILTER, ...overrides }
}

test('review requested holds a direct open request from somebody else', () => {
  assert.deepEqual(groupsOf({ reviewRequested: [VIEWER] }), ['review-requested'])
  assert.deepEqual(groupsOf({ reviewRequested: ['ADA'] }), ['review-requested'])
  assert.deepEqual(groupsOf({ reviewRequested: ['someone', 'ada'] }), ['review-requested'])
})

test('a pull request you opened is your work, never a review you owe', () => {
  assert.deepEqual(groupsOf({ reviewRequested: [VIEWER], author: VIEWER }), ['my-prs-waiting'])
})

test('a draft is never in a review group, whoever asked for review', () => {
  assert.deepEqual(groupsOf({ reviewRequested: [VIEWER], draft: true }), ['drafts'])
})

test('a draft you owe a reply on is still only a draft', () => {
  assert.deepEqual(groupsOf({ draft: true, author: VIEWER, lastTurnLogin: 'grace' }), ['drafts'])
  assert.deepEqual(groupsOf({ draft: true, author: VIEWER, reviewDecision: 'CHANGES_REQUESTED' }), [
    'drafts',
  ])
})

test('needs my response is a reply you owe, not silence', () => {
  assert.deepEqual(groupsOf({ author: VIEWER, lastTurnLogin: null }), ['my-prs-waiting'])
  assert.deepEqual(groupsOf({ author: VIEWER, lastTurnLogin: 'grace' }), ['needs-response'])
  assert.deepEqual(groupsOf({ author: VIEWER, lastTurnLogin: VIEWER }), ['my-prs-waiting'])
  assert.deepEqual(
    groupsOf({ author: VIEWER, lastTurnLogin: null, reviewDecision: 'CHANGES_REQUESTED' }),
    ['needs-response'],
  )
})

test('a reply owed on somebody else pull request belongs to neither viewer group', () => {
  assert.deepEqual(groupsOf({ author: 'grace', lastTurnLogin: 'grace' }), [])
})

test('my pull requests separate waiting from approved', () => {
  assert.deepEqual(groupsOf({ author: VIEWER, reviewDecision: 'APPROVED' }), ['my-prs-approved'])
  assert.deepEqual(groupsOf({ author: VIEWER, reviewDecision: 'REVIEW_REQUIRED' }), [
    'my-prs-waiting',
  ])
  assert.deepEqual(groupsOf({ author: VIEWER, reviewDecision: null }), ['my-prs-waiting'])
  assert.deepEqual(groupsOf({ author: VIEWER, reviewDecision: 'APPROVED', draft: true }), [
    'drafts',
  ])
})

test('approved and then commented on is the one intended overlap', () => {
  assert.deepEqual(
    groupsOf({ author: VIEWER, reviewDecision: 'APPROVED', lastTurnLogin: 'grace' }),
    ['needs-response', 'my-prs-approved'],
  )
  assert.ok(inboxGroupOverlapsAllowed('my-prs-approved', 'needs-response'))
  assert.ok(inboxGroupOverlapsAllowed('needs-response', 'my-prs-approved'))
  assert.equal(inboxGroupOverlapsAllowed('drafts', 'needs-response'), false)
  assert.equal(inboxGroupOverlapsAllowed('my-prs-approved', 'my-prs-approved'), false)
})

test('no other pair of groups ever holds one pull request at once', () => {
  const everyFact: PullRequestInboxSignals[] = []
  for (const state of ['OPEN', 'CLOSED', 'MERGED'] as const) {
    for (const draft of [false, true]) {
      for (const author of [VIEWER, 'grace']) {
        for (const reviewRequested of [[], [VIEWER], ['grace']]) {
          for (const reviewDecision of [null, 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']) {
            for (const lastTurnLogin of [null, VIEWER, 'grace']) {
              for (const mergedAt of [null, mergedDaysAgo(1), mergedDaysAgo(60)]) {
                everyFact.push(
                  signals({
                    state,
                    draft,
                    author,
                    reviewRequested,
                    reviewDecision,
                    lastTurnLogin,
                    mergedAt,
                  }),
                )
              }
            }
          }
        }
      }
    }
  }
  for (const fact of everyFact) {
    const held = pullRequestInboxGroups(fact, { viewer: VIEWER, now: NOW })
    for (const first of held) {
      for (const second of held) {
        if (first === second) continue
        assert.ok(
          inboxGroupOverlapsAllowed(first, second),
          `${first} and ${second} both held ${JSON.stringify(fact)}`,
        )
      }
    }
  }
})

test('every group is reachable from some fact', () => {
  const reachable = new Set<PullRequestInboxGroupId>()
  const facts: PullRequestInboxSignals[] = [
    signals({ reviewRequested: [VIEWER] }),
    signals({ author: VIEWER, lastTurnLogin: 'grace' }),
    signals({ author: VIEWER, reviewDecision: 'REVIEW_REQUIRED' }),
    signals({ author: VIEWER, reviewDecision: 'APPROVED' }),
    signals({ draft: true }),
    signals({ state: 'MERGED', mergedAt: mergedDaysAgo(1) }),
  ]
  for (const fact of facts) {
    for (const group of pullRequestInboxGroups(fact, { viewer: VIEWER, now: NOW })) {
      reachable.add(group)
    }
  }
  assert.deepEqual([...reachable].sort(), PULL_REQUEST_INBOX_GROUPS.map((group) => group.id).sort())
})

test('membership is decided once, and in a fixed order, for the same facts', () => {
  const fact = signals({ author: VIEWER, reviewDecision: 'APPROVED', lastTurnLogin: 'grace' })
  assert.deepEqual(pullRequestInboxGroups(fact, { viewer: VIEWER, now: NOW }), [
    'needs-response',
    'my-prs-approved',
  ])
})

test('a read with no viewer places nothing in a viewer-relative group', () => {
  assert.deepEqual(
    pullRequestInboxGroups(signals({ reviewRequested: [VIEWER], author: VIEWER }), {
      viewer: null,
      now: NOW,
    }),
    [],
  )
})

test('recently merged is a window measured from the read, not a date field', () => {
  assert.deepEqual(groupsOf({ state: 'MERGED', mergedAt: mergedDaysAgo(1) }), ['recently-merged'])
  assert.deepEqual(groupsOf({ state: 'MERGED', mergedAt: mergedDaysAgo(29) }), ['recently-merged'])
  assert.deepEqual(groupsOf({ state: 'MERGED', mergedAt: mergedDaysAgo(31) }), [])
  assert.deepEqual(
    groupsAt({ state: 'MERGED', mergedAt: mergedDaysAgo(60) }, { mergedWithinDays: 90 }),
    ['recently-merged'],
  )
  // The window edge belongs to the window, not to the day after it.
  assert.deepEqual(
    groupsAt({ state: 'MERGED', mergedAt: mergedDaysAgo(30) }, { mergedWithinDays: 30 }),
    ['recently-merged'],
  )
  assert.deepEqual(
    groupsAt({ state: 'MERGED', mergedAt: mergedDaysAgo(31) }, { mergedWithinDays: 30 }),
    [],
  )
  // A merge instant GitHub never gave, or gave as the future, is not a new merge.
  assert.deepEqual(groupsOf({ state: 'MERGED', mergedAt: null }), [])
  assert.deepEqual(groupsOf({ state: 'MERGED', mergedAt: new Date(NOW + DAY).toISOString() }), [])
})

test('a closed pull request is in no group at all', () => {
  assert.deepEqual(groupsOf({ state: 'CLOSED', draft: true }), [])
})

test('no unknown group is accepted, by the renderer or by a saved filter', () => {
  for (const group of PULL_REQUEST_INBOX_GROUPS) {
    assert.ok(isPullRequestInboxGroupId(group.id))
  }
  assert.equal(isPullRequestInboxGroupId('notifications'), false)
  assert.deepEqual(
    parsePullRequestInboxSavedFilters([
      { id: 'a', name: 'Unknown group', group: 'notifications', search: '', repository: null },
    ]),
    [],
  )
})

test('search matches what a row already shows, and every term must match', () => {
  const row = item({ number: 42, title: 'Quiet workbench', head: 'feat/inbox', author: 'grace' })
  for (const search of ['#42', '42', 'workbench', 'QUIET', 'inbox', 'acme/app', 'main', 'grace']) {
    assert.equal(matchesPullRequestInboxSearch(row, search), true, search)
  }
  assert.equal(matchesPullRequestInboxSearch(row, 'grace nothing'), false)
  assert.equal(matchesPullRequestInboxSearch(row, '   '), true)
  assert.equal(filterPullRequestInbox([row], filterWith({ search: 'acme/app' })).length, 1)
  assert.equal(filterPullRequestInbox([row], filterWith({ search: 'nothing here' })).length, 0)
})

test('a repository filter is exact and ignores case', () => {
  const rows = [item({ repository: 'acme/app' }), item({ repository: 'acme/Other', number: 2 })]
  assert.deepEqual(
    filterPullRequestInbox(rows, filterWith({ repository: 'ACME/Other' })).map((row) => row.number),
    [2],
  )
  assert.equal(filterPullRequestInbox(rows, filterWith({ repository: 'acme' })).length, 0)
  assert.equal(filterPullRequestInbox(rows, filterWith({ repository: null })).length, 2)
})

test('a group filter shows only that group', () => {
  const rows = [
    item({ number: 1, groups: ['review-requested'] }),
    item({ number: 2, groups: ['my-prs-waiting', 'my-prs-approved'] }),
  ]
  assert.deepEqual(
    filterPullRequestInbox(rows, filterWith({ group: 'my-prs-approved' })).map((row) => row.number),
    [2],
  )
})

test('rows are ordered by recency, then repository, then number', () => {
  const rows = [
    item({ number: 3, repository: 'acme/app', updatedAt: '2026-02-20T00:00:00.000Z' }),
    item({ number: 9, repository: 'acme/app', updatedAt: '2026-02-28T00:00:00.000Z' }),
    item({ number: 1, repository: 'acme/aaa', updatedAt: '2026-02-28T00:00:00.000Z' }),
    item({ number: 2, repository: 'acme/app', updatedAt: '2026-02-28T00:00:00.000Z' }),
    item({ number: 4, repository: 'acme/app', updatedAt: null }),
  ]
  assert.deepEqual(
    sortPullRequestInbox(rows).map((row) => `${row.repository}#${row.number}`),
    ['acme/aaa#1', 'acme/app#2', 'acme/app#9', 'acme/app#3', 'acme/app#4'],
  )
})

test('a refresh refuses to start below the reserve, and names why', () => {
  const reserve = DEFAULT_PULL_REQUEST_INBOX_BUDGET.reserve
  assert.equal(pullRequestInboxBudgetAllows(null).allowed, true)
  assert.equal(pullRequestInboxBudgetAllows(Number.NaN).allowed, true)
  assert.equal(pullRequestInboxBudgetAllows(reserve).allowed, true)
  const refused = pullRequestInboxBudgetAllows(reserve - 1)
  assert.equal(refused.allowed, false)
  assert.ok(refused.reason.includes(String(reserve)))
})

test('a partial read is never promoted to a complete one', () => {
  assert.equal(
    derivePullRequestInboxState([repositoryReport('acme/app'), repositoryReport('acme/lib')], null),
    'fresh',
  )
  assert.equal(
    derivePullRequestInboxState(
      [repositoryReport('acme/app'), repositoryReport('acme/lib', 'forbidden')],
      null,
    ),
    'partial',
  )
  // A repository that was never attempted is not an empty repository.
  assert.equal(
    derivePullRequestInboxState(
      [repositoryReport('acme/app'), repositoryReport('acme/lib', 'skipped')],
      null,
    ),
    'partial',
  )
  assert.equal(
    derivePullRequestInboxState([], { state: 'auth-required', detail: 'Signed out.' }),
    'auth-required',
  )
  assert.equal(
    derivePullRequestInboxState([repositoryReport('acme/app', 'unauthorized')], {
      state: 'auth-required',
      detail: 'Signed out.',
    }),
    'auth-required',
  )
  assert.equal(derivePullRequestInboxState([], null), 'stale')
})

test('empty, filtered-empty, and unconfirmed are three different answers', () => {
  const confirmed = refresh()
  assert.deepEqual(
    pullRequestInboxPresentation({
      refresh: confirmed,
      total: 0,
      shown: 0,
      filtering: false,
      loading: false,
    }),
    { list: 'empty', notice: null },
  )
  assert.deepEqual(
    pullRequestInboxPresentation({
      refresh: confirmed,
      total: 1,
      shown: 0,
      filtering: true,
      loading: false,
    }),
    { list: 'filtered-empty', notice: null },
  )
  // A group that holds none of the rows is filtered-empty, not empty: the queue
  // itself answered, and the person is looking at one group.
  assert.deepEqual(
    pullRequestInboxPresentation({
      refresh: confirmed,
      total: 1,
      shown: 0,
      filtering: false,
      loading: false,
    }),
    { list: 'filtered-empty', notice: null },
  )
  for (const state of ['stale', 'offline', 'auth-required', 'rate-limited', 'partial'] as const) {
    const unconfirmed = pullRequestInboxPresentation({
      refresh: refresh({ state, confirmedAt: null, detail: 'Could not read GitHub.' }),
      total: 0,
      shown: 0,
      filtering: false,
      loading: false,
    })
    assert.equal(unconfirmed.list, 'unconfirmed', state)
    assert.ok(unconfirmed.notice, state)
  }
})

test('a partial read names the repositories it did not read', () => {
  const partial = pullRequestInboxPresentation({
    refresh: refresh({
      state: 'partial',
      repositories: [
        repositoryReport('acme/app'),
        repositoryReport('acme/private', 'forbidden'),
        repositoryReport('acme/other', 'skipped'),
      ],
    }),
    total: 1,
    shown: 1,
    filtering: false,
    loading: false,
  })
  assert.equal(partial.list, 'rows')
  assert.equal(partial.notice?.tone, 'warning')
  assert.ok(partial.notice?.detail.includes('acme/private'))
  assert.ok(partial.notice?.detail.includes('acme/other'))
})

test('rows stay on screen behind the reason a refresh is not current', () => {
  const kept = pullRequestInboxPresentation({
    refresh: refresh({
      state: 'stale',
      confirmedAt: '2026-02-27T00:00:00.000Z',
      detail: 'GitHub could not be reached.',
    }),
    total: 3,
    shown: 1,
    filtering: false,
    loading: false,
  })
  assert.equal(kept.list, 'rows')
  assert.equal(kept.notice?.tone, 'warning')
})

test('a queue nothing has ever confirmed reads as being read, not as unconfirmed', () => {
  const never = refresh({
    state: 'stale',
    confirmedAt: null,
    detail: 'GitHub could not be reached.',
  })
  const reading = pullRequestInboxPresentation({
    refresh: never,
    total: 0,
    shown: 0,
    filtering: false,
    loading: true,
  })
  assert.equal(reading.list, 'loading')
  assert.equal(reading.notice, null)
  // The read that is running decides this, not the state the last failed one
  // left behind: once it answers, the refusal is what the queue says.
  assert.equal(
    pullRequestInboxPresentation({
      refresh: never,
      total: 0,
      shown: 0,
      filtering: false,
      loading: false,
    }).list,
    'unconfirmed',
  )
})

test('a repository that was not attempted is named beside the ones that were', () => {
  const unread = pullRequestInboxPresentation({
    refresh: refresh({
      state: 'partial',
      repositories: [repositoryReport('acme/app'), repositoryReport('acme/other', 'skipped')],
    }),
    total: 1,
    shown: 1,
    filtering: false,
    loading: false,
  })
  assert.match(unread.notice?.detail ?? '', /acme\/other/)
  assert.equal(unread.notice?.detail.includes('acme/app (read)'), false)
})

test('a saved filter file that cannot be understood yields no filters, not a refusal', () => {
  assert.deepEqual(parsePullRequestInboxSavedFilters(null), [])
  assert.deepEqual(parsePullRequestInboxSavedFilters({}), [])
  assert.deepEqual(
    parsePullRequestInboxSavedFilters([
      { id: 'a', name: 'Mine', group: 'my-prs-waiting', search: '', repository: null },
      { id: 'b', name: 'Unknown group', group: 'notifications', search: '', repository: null },
      { id: '', name: 'No id', group: 'drafts', search: '', repository: null },
      { id: 'd', name: '', group: 'drafts', search: '', repository: null },
      'nonsense',
    ]),
    [{ id: 'a', name: 'Mine', group: 'my-prs-waiting', search: '', repository: null }],
  )
})

test('saving assigns identity, and saving again replaces the filter it names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-'))
  const file = join(dir, 'pull-request-inbox.json')
  try {
    const filters = new PullRequestInboxFilters(file)
    assert.deepEqual(await filters.load(), [])

    const first = await filters.save([
      { name: 'Waiting on reviewers', group: 'my-prs-waiting', search: '', repository: null },
    ])
    assert.equal(first.length, 1)
    assert.ok(first[0].id)

    // A second draft with no identity is a new filter, not an edit of the first.
    const second = await filters.save([
      ...first,
      { name: 'Needs me', group: 'needs-response', search: '', repository: null },
    ])
    assert.equal(second.length, 2)

    const replaced = await filters.save(
      second.map((entry) => (entry.name === 'Needs me' ? { ...entry, search: 'inbox' } : entry)),
    )
    assert.equal(replaced.length, 2)
    assert.equal(replaced.find((entry) => entry.name === 'Needs me')?.search, 'inbox')

    const reloaded = new PullRequestInboxFilters(file)
    assert.deepEqual(await reloaded.load(), replaced)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { filters: unknown }
    assert.deepEqual(stored.filters, replaced)

    assert.deepEqual(await reloaded.save([]), [])
    assert.deepEqual(await reloaded.load(), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('one invalid draft refuses the whole write rather than losing a filter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-'))
  const file = join(dir, 'pull-request-inbox.json')
  try {
    const filters = new PullRequestInboxFilters(file)
    const saved = await filters.save([
      { name: 'Kept', group: 'drafts', search: '', repository: null },
    ])
    await assert.rejects(
      filters.save([...saved, { name: '', group: 'drafts', search: '', repository: null }]),
    )
    assert.deepEqual(await filters.load(), saved)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a saved filter list is bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-'))
  const file = join(dir, 'pull-request-inbox.json')
  try {
    const filters = new PullRequestInboxFilters(file)
    const saved = await filters.save(
      Array.from({ length: 25 }, (_, index) => ({
        name: `Filter ${index}`,
        group: 'drafts' as const,
        search: '',
        repository: null,
      })),
    )
    assert.equal(saved.length, 20)
    assert.deepEqual(await filters.load(), saved)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('overlapping saves each store the list they were given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-'))
  const file = join(dir, 'pull-request-inbox.json')
  const draft = (name: string) => ({
    name,
    group: 'drafts' as const,
    search: name,
    repository: null,
  })
  try {
    const filters = new PullRequestInboxFilters(file)
    // The save controls stay live while a save is in flight, so two saves can
    // overlap. Sharing one temporary path let the second payload replace the
    // first before its rename, and the second rename then failed: the window was
    // told a list was stored that the file did not hold.
    const first = filters.save([draft('First'), draft('Second')])
    const second = filters.save([draft('Third')])
    const [firstSaved, secondSaved] = await Promise.all([first, second])
    assert.deepEqual(
      firstSaved.map((filter) => filter.name),
      ['First', 'Second'],
    )
    // The last save is the one on disk, and the window is told exactly that.
    const written = JSON.parse(await readFile(file, 'utf8')) as { filters: unknown }
    const stored = parsePullRequestInboxSavedFilters(written.filters)
    assert.deepEqual(stored, secondSaved)
    assert.deepEqual(await filters.load(), secondSaved)
    // A saved filter keeps its identity when it is saved again, so a later edit
    // replaces the filter it names rather than adding a second copy of it.
    const again = await filters.save([{ ...secondSaved[0], name: 'Renamed' }])
    assert.equal(again.length, 1)
    assert.equal(again[0].id, secondSaved[0].id)
    assert.equal(again[0].name, 'Renamed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a save that cannot be written does not wedge the ones after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-inbox-'))
  // A directory where the filter file belongs: the payload is written and the
  // rename onto it is refused, which is a write that cannot succeed.
  const blocked = join(dir, 'blocked')
  await mkdir(blocked)
  try {
    const filters = new PullRequestInboxFilters(blocked)
    await assert.rejects(
      filters.save([{ name: 'Lost', group: 'drafts', search: '', repository: null }]),
    )
    await rm(blocked, { recursive: true, force: true })
    const saved = await filters.save([
      { name: 'Kept', group: 'drafts', search: '', repository: null },
    ])
    assert.deepEqual(
      saved.map((filter) => filter.name),
      ['Kept'],
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an expired rate-limit window admits the queue again', () => {
  const budget = DEFAULT_PULL_REQUEST_INBOX_BUDGET
  // A count reported for a window that has already passed says nothing about the
  // requests available now, so refusing on it would park a queue that no admitted
  // request could ever unpark.
  assert.deepEqual(
    pullRequestInboxBudgetAllows(3, budget, {
      reset: new Date(NOW - 60_000),
      now: NOW,
    }),
    { allowed: true, reason: '' },
  )
  assert.equal(
    pullRequestInboxBudgetAllows(3, budget, { reset: new Date(NOW + 60_000), now: NOW }).allowed,
    false,
  )
  // A window still open keeps refusing, with the count that refuses it.
  assert.match(
    pullRequestInboxBudgetAllows(3, budget, { reset: new Date(NOW + 60_000), now: NOW }).reason,
    /3 requests left/,
  )
})

test('a refresh that read nothing says which failure it was, and names the repositories', () => {
  const offline = pullRequestInboxRefreshFailure(
    [repositoryReport('acme/app', 'offline'), repositoryReport('acme/widgets', 'offline')],
    null,
  )
  assert.equal(offline?.state, 'offline')
  assert.match(offline?.detail ?? '', /acme\/app/)
  assert.match(offline?.detail ?? '', /acme\/widgets/)

  const unreadable = pullRequestInboxRefreshFailure(
    [repositoryReport('acme/app', 'forbidden'), repositoryReport('acme/private', 'not-found')],
    null,
  )
  assert.equal(unreadable?.state, 'auth-required')
  assert.match(unreadable?.detail ?? '', /acme\/private/)

  // One repository that answered makes this a partial read, not a failure.
  assert.equal(
    pullRequestInboxRefreshFailure(
      [repositoryReport('acme/app'), repositoryReport('acme/widgets', 'offline')],
      null,
    ),
    null,
  )
  // A failure the refresh already established is reported as it stands.
  assert.equal(
    pullRequestInboxRefreshFailure([repositoryReport('acme/app', 'skipped')], {
      state: 'rate-limited',
      detail: 'budget spent',
    })?.state,
    'rate-limited',
  )
})

test('only pull requests that belong to a group are counted in the queue', () => {
  const rows = [
    item({ number: 1, groups: ['review-requested'] }),
    item({ number: 2, groups: [] }),
    item({ number: 3, groups: ['needs-response', 'my-prs-approved'] }),
  ]
  assert.equal(pullRequestInboxQueueCount(rows), 2)
  // A refresh that fetched only pull requests no group can hold is an empty
  // queue, not one whose rows are hidden by a filter: no group or search could
  // ever produce them.
  const ungrouped = rows.filter((row) => row.groups.length === 0)
  assert.deepEqual(
    pullRequestInboxPresentation({
      refresh: refresh(),
      total: pullRequestInboxQueueCount(ungrouped),
      shown: 0,
      filtering: false,
      loading: false,
    }).list,
    'empty',
  )
})
