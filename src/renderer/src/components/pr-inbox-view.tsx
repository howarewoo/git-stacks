import * as React from 'react'
import { useForm, useSelector } from '@tanstack/react-form'
import { ChevronRight, Filter, Inbox, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import {
  PULL_REQUEST_INBOX_DEFAULT_FILTER,
  PULL_REQUEST_INBOX_GROUPS,
  filterPullRequestInbox,
  evaluatePullRequestInbox,
  pullRequestInboxGroupLabel,
  pullRequestInboxPresentation,
  pullRequestInboxQueueCount,
  type PullRequestInboxFilter,
  type PullRequestInboxFilterDraft,
  type PullRequestInboxGroupId,
  type PullRequestInboxItem,
  type PullRequestInboxReport,
  type PullRequestInboxSavedFilter,
  type PullRequestInboxCriteria,
  type PullRequestInboxCount,
} from '../../../shared/pr-inbox'
import { LIST_PAGE_SIZE } from '../../../shared/performance'
import { useListWindow } from '../lib/list-window'
import {
  checkLabel,
  checksVariant,
  lifecycleLabel,
  lifecycleVariant,
  reviewLabel,
  reviewVariant,
} from '../lib/pull-request-state'
import {
  claimsRovingKey,
  clampRovingIndex,
  rovingAction,
  rovingTabIndex,
  rovingTarget,
} from '../lib/tree-navigation'
import { ListWindowMore } from './list-window'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Select } from './ui/select'
import { EmptyState, InlineAlert } from './ui/surface'
import { cn } from '../lib/utils'
import { WORKSPACE_VIEW_HEADING_ID } from './workspace-navigation'
import type { PullRequest } from '../../../shared/types'

/**
 * `reviewLabel` and `reviewVariant` read the shared `PullRequest`, whose optional
 * review decision is absent rather than null. An Inbox row carries an explicit
 * null when the host reported no decision, which means the same thing, so the
 * badge vocabulary is reused rather than duplicated.
 */
function asSharedPullRequest(item: PullRequestInboxItem): PullRequest {
  return { ...item, reviewDecision: item.reviewDecision ?? undefined }
}

/** Relative freshness of a row, so a stale queue never looks current. */
function updatedLabel(item: PullRequestInboxItem, now: number): string {
  const updated = Date.parse(item.updatedAt ?? '')
  if (!Number.isFinite(updated)) return 'not dated by GitHub'
  const hours = Math.round((now - updated) / 3_600_000)
  if (hours < 1) return 'updated in the last hour'
  if (hours < 24) return `updated ${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 31) return `updated ${days}d ago`
  return `updated on ${new Date(updated).toLocaleDateString()}`
}

/**
 * Whether this row's check and review facts were read at all. A host that
 * refused the fields behind them never reported a result, and a row that says
 * "no checks" or "no review decision" for them states an absence the host
 * never confirmed.
 */
function hasMetadata(item: PullRequestInboxItem): boolean {
  return item.metadata !== 'degraded'
}

function inboxCheckLabel(item: PullRequestInboxItem): string {
  return hasMetadata(item) && item.checksKnown !== false ? checkLabel(item.checks) : 'unknown'
}

function inboxReviewLabel(item: PullRequestInboxItem): string {
  if (hasMetadata(item) && item.reviewKnown !== false) return reviewLabel(asSharedPullRequest(item))
  return 'review state unknown'
}

function inboxAuthorLabel(item: PullRequestInboxItem): string {
  return item.author ? `opened by ${item.author}` : 'author not reported'
}

function countLabel(count: PullRequestInboxCount | undefined): string {
  if (count?.state === 'known') return String(count.value)
  if (count?.state === 'truncated') return `${count.value}+ (truncated)`
  return count?.state ?? 'unknown'
}

function rowLabel(item: PullRequestInboxItem, now: number): string {
  const pr = asSharedPullRequest(item)
  const layer = item.stack
    ? `, layer ${item.stack.position} of ${item.stack.size} in native stack #${item.stack.stackNumber}`
    : ''
  return `Open pull request #${item.number} ${item.title} in ${item.repository}, ${inboxAuthorLabel(item)}, ${item.head} into ${item.base}, ${lifecycleLabel(pr)}, checks ${inboxCheckLabel(item)}, ${inboxReviewLabel(item)}${layer}, ${updatedLabel(item, now)}, changed lines ${countLabel(item.changeSize)}, unresolved threads ${countLabel(item.unresolvedThreads)}`
}

function groupCounts(
  report: PullRequestInboxReport | null,
): Record<PullRequestInboxGroupId, number> {
  const counts = Object.fromEntries(
    PULL_REQUEST_INBOX_GROUPS.map((group) => [group.id, 0]),
  ) as Record<PullRequestInboxGroupId, number>
  for (const item of report?.items ?? []) {
    for (const group of item.groups) counts[group] += 1
  }
  return counts
}

/**
 * The PR Inbox: a GitHub-derived triage queue over every registered repository.
 *
 * This is not GitHub's notification inbox and never reads one. Every row comes
 * from the pull request, review, and check data the host reported, and the
 * group rail states each group's rule where a person can read it before
 * choosing. The list is one composite widget with a single Tab stop and
 * arrow-key movement, matching the branch tree, the stack rail, and the commit
 * history.
 */
export function PullRequestInboxView({
  report,
  loading,
  refreshing,
  activating,
  error,
  savedFilters,
  savingFilters,
  filtersReady,
  onOpen,
  onRefresh,
  onSaveFilters,
  onDismissError,
  searchInputRef,
}: {
  report: PullRequestInboxReport | null
  loading: boolean
  /** A repository is opening, so a row cannot start a second one. */
  activating: boolean
  refreshing: boolean
  error: string | null
  savedFilters: readonly PullRequestInboxSavedFilter[]
  /**
   * A saved-filter write is in flight. Every one of these mutations replaces
   * the whole list, so a second one started from the same list would drop the
   * first; the controls wait for the stored answer instead of racing it.
   */
  savingFilters: boolean
  /**
   * Whether the stored filter list has been read. Every mutation replaces the
   * whole list, so one taken before that read has landed would send back a list
   * that does not yet exist and store it in its place.
   */
  filtersReady: boolean
  onOpen: (item: PullRequestInboxItem) => void
  onRefresh: () => void
  onSaveFilters: (drafts: PullRequestInboxFilterDraft[]) => void
  onDismissError: () => void
  /**
   * The queue's own search field. The advertised search shortcut is routed here
   * while this destination is on screen, because the field that answers it is
   * the one that filters these rows.
   */
  searchInputRef: React.RefObject<HTMLInputElement | null>
}) {
  // A whole-list write must not be started before the stored list has been
  // read: the name field, Enter, Save and Remove all share this one wait.
  const filtersSettling = savingFilters || !filtersReady
  const [filter, setFilter] = React.useState<PullRequestInboxFilter>(
    PULL_REQUEST_INBOX_DEFAULT_FILTER,
  )
  const saveFilterForm = useForm({
    defaultValues: { name: '' },
    validators: {
      onSubmit: ({ value }) => (value.name.trim() ? undefined : 'Name the filter.'),
    },
    onSubmit: ({ value, formApi }) => {
      const name = value.name.trim()
      if (filtersSettling) return
      // Reusing a name replaces that filter while preserving its stored identity.
      const existing = savedFilters.find((entry) => entry.name === name)
      onSaveFilters([
        ...draftsWithout(existing),
        {
          ...(existing ? { id: existing.id } : {}),
          name,
          ...filter,
        },
      ])
      formApi.reset()
    },
  })
  const saveName = useSelector(saveFilterForm.store, (state) => state.values.name)
  const saveSubmitting = useSelector(saveFilterForm.store, (state) => state.isSubmitting)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const now = Date.now()

  const items = report?.items ?? []
  // Only rows that belong to a group are in the queue; a pull request nobody
  // asked this viewer about is fetched, but no group can ever show it.
  const queued = React.useMemo(() => pullRequestInboxQueueCount(items), [items])
  const counts = React.useMemo(() => groupCounts(report), [report])
  const shown = React.useMemo(() => filterPullRequestInbox(items, filter), [items, filter])
  const window = useListWindow(shown)
  const unknownExcluded = React.useMemo(
    () =>
      items.reduce(
        (count, item) => count + (evaluatePullRequestInbox(item, filter) === 'unknown' ? 1 : 0),
        0,
      ),
    [items, filter],
  )
  const filtering =
    filter.search.trim().length > 0 ||
    Object.keys(filter.criteria).length > 0 ||
    filter.group !== PULL_REQUEST_INBOX_DEFAULT_FILTER.group
  const presentation = pullRequestInboxPresentation({
    refresh: report?.refresh ?? {
      state: 'stale',
      confirmedAt: null,
      checkedAt: now ? new Date().toISOString() : '',
      viewer: null,
      requests: 0,
      budget: { maxRequests: 0, reserve: 0 },
      repositories: [],
      truncated: [],
      detail: 'The queue has not been read from GitHub yet.',
    },
    total: queued,
    shown: shown.length,
    filtering,
    loading,
  })

  React.useEffect(() => {
    setActiveIndex((index) => clampRovingIndex(index, window.visible.length))
  }, [window.visible.length])

  const focusRow = (index: number) => {
    const row = listRef.current?.querySelectorAll<HTMLButtonElement>('.pr-row')[index]
    if (!row) return
    setActiveIndex(index)
    row.focus()
  }

  const repositories = React.useMemo(
    () =>
      [
        ...new Set([
          ...(report?.refresh.repositories.map((entry) => entry.repository) ?? []),
          ...items.map((item) => item.repository),
        ]),
      ].sort(),
    [items, report?.refresh.repositories],
  )
  const activeGroup = PULL_REQUEST_INBOX_GROUPS.find((group) => group.id === filter.group)
  const setCriteria = (criteria: PullRequestInboxCriteria) => {
    const present = Object.fromEntries(
      Object.entries(criteria).filter(
        ([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0),
      ),
    )
    setFilter({ ...filter, criteria: present })
  }

  /** Every stored filter except `drop`, re-expressed as a draft for the main process. */
  const draftsWithout = (drop?: { id: string }): PullRequestInboxFilterDraft[] =>
    savedFilters.filter((entry) => entry.id !== drop?.id).map((entry) => ({ ...entry }))

  const removeSavedFilter = (id: string) => {
    if (filtersSettling) return
    onSaveFilters(draftsWithout({ id }))
  }

  return (
    <div className="pull-requests-view pr-inbox-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1 id={WORKSPACE_VIEW_HEADING_ID} tabIndex={-1}>
            PR Inbox
          </h1>
          <span className="list-subtitle">
            GitHub pull requests across your registered repositories — not GitHub notifications
          </span>
        </div>
        <div className="workflow-row">
          <Button
            aria-label="Refresh the PR Inbox"
            disabled={refreshing}
            onClick={onRefresh}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <div className="pr-inbox-body">
        <nav aria-label="Inbox groups" className="pr-inbox-rail">
          <span className="nav-label">Groups</span>
          {PULL_REQUEST_INBOX_GROUPS.map((group) => {
            const active = group.id === filter.group
            return (
              <Button
                aria-current={active ? 'true' : undefined}
                className={cn('inbox-group', active && 'inbox-group-active')}
                key={group.id}
                onClick={() => setFilter({ ...filter, group: group.id })}
                title={group.rule}
                type="button"
                variant="unstyled"
              >
                <span className="inbox-group-label">{group.label}</span>
                <span className="nav-count">{counts[group.id]}</span>
              </Button>
            )
          })}
          {savedFilters.length > 0 ? (
            <>
              <span className="nav-label pr-inbox-rail-section">Saved filters</span>
              {savedFilters.map((saved) => (
                <div className="inbox-saved" key={saved.id}>
                  <Button
                    className="inbox-group inbox-group-saved"
                    variant="unstyled"
                    onClick={() =>
                      setFilter({
                        group: saved.group,
                        search: saved.search,
                        criteria: structuredClone(saved.criteria),
                        sort: saved.sort,
                      })
                    }
                    title={`${pullRequestInboxGroupLabel(saved.group)} · ${saved.search || 'no search'}${
                      saved.criteria.repositories?.length
                        ? ` · ${saved.criteria.repositories.join(', ')}`
                        : ''
                    }`}
                    type="button"
                  >
                    <span className="inbox-group-label">{saved.name}</span>
                  </Button>
                  <Button
                    aria-label={`Remove saved filter ${saved.name}`}
                    disabled={filtersSettling}
                    onClick={() => removeSavedFilter(saved.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </>
          ) : null}
        </nav>
        <div className="pr-inbox-content">
          <div className="pr-inbox-filters">
            <Field className="pr-inbox-search" id="pr-inbox-search" label="Search the queue">
              <Input
                onChange={(event) => setFilter({ ...filter, search: event.target.value })}
                placeholder="Title, #number, repository, branch, or author"
                ref={searchInputRef}
                type="search"
                value={filter.search}
              />
            </Field>
            <Field id="pr-inbox-sort" label="Sort">
              <Select
                controlSize="compact"
                value={filter.sort}
                onValueChange={(value) =>
                  setFilter({ ...filter, sort: value as PullRequestInboxFilter['sort'] })
                }
                options={[
                  { value: 'updated-desc', label: 'Recently updated' },
                  { value: 'size-desc', label: 'Largest change' },
                  { value: 'size-asc', label: 'Smallest change' },
                ]}
              />
            </Field>
            <form
              className="pr-inbox-save"
              onSubmit={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void saveFilterForm.handleSubmit()
              }}
            >
              {/* The label names the input itself, so clicking it focuses the
                  name field and assistive technology reads the two together. */}
              <saveFilterForm.Field name="name">
                {(field) => (
                  <Field id="pr-inbox-save" label="Save this filter">
                    <Input
                      disabled={filtersSettling || saveSubmitting}
                      onChange={(event) => field.handleChange(event.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="Filter name"
                      type="text"
                      value={field.state.value}
                    />
                  </Field>
                )}
              </saveFilterForm.Field>
              <Button
                disabled={filtersSettling || saveSubmitting || !saveName.trim()}
                type="submit"
                size="sm"
                variant="secondary"
              >
                <Filter className="size-3.5" />
                Save
              </Button>
            </form>
          </div>
          <details className="pr-inbox-criteria" open={Object.keys(filter.criteria).length > 0}>
            <summary>Structured criteria · AND across fields, OR within each field</summary>
            <div className="pr-inbox-criteria-fields">
              <fieldset>
                <legend>Repositories</legend>
                {repositories.map((repository) => {
                  const identity = repository.toLowerCase()
                  return (
                    <label key={repository}>
                      <input
                        type="checkbox"
                        checked={
                          filter.criteria.repositories?.some(
                            (value) => value.toLowerCase() === identity,
                          ) ?? false
                        }
                        onChange={(event) => {
                          const others =
                            filter.criteria.repositories?.filter(
                              (value) => value.toLowerCase() !== identity,
                            ) ?? []
                          setCriteria({
                            ...filter.criteria,
                            repositories: event.target.checked ? [...others, repository] : others,
                          })
                        }}
                      />
                      {repository}
                    </label>
                  )
                })}
              </fieldset>
              {(['authors', 'reviewers'] as const).map((key) => (
                <Field
                  key={key}
                  id={`pr-inbox-${key}`}
                  label={
                    key === 'authors'
                      ? 'Authors (comma separated)'
                      : 'Requested reviewers (comma separated)'
                  }
                >
                  <Input
                    key={JSON.stringify(filter.criteria[key])}
                    defaultValue={filter.criteria[key]?.join(', ') ?? ''}
                    onBlur={(event) =>
                      setCriteria({
                        ...filter.criteria,
                        [key]: event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </Field>
              ))}
              {(
                [
                  ['lifecycle', 'Lifecycle', ['open', 'draft', 'closed', 'merged']],
                  [
                    'reviews',
                    'Review decision',
                    ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'none'],
                  ],
                  ['checks', 'Checks', ['passing', 'failing', 'pending', 'none']],
                ] as const
              ).map(([key, label, values]) => (
                <fieldset key={key}>
                  <legend>{label}</legend>
                  {values.map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={
                          (filter.criteria[key] as readonly string[] | undefined)?.includes(
                            value,
                          ) ?? false
                        }
                        onChange={(event) =>
                          setCriteria({
                            ...filter.criteria,
                            [key]: event.target.checked
                              ? [...(filter.criteria[key] ?? []), value]
                              : filter.criteria[key]?.filter((entry) => entry !== value),
                          })
                        }
                      />
                      {value.toLowerCase().replaceAll('_', ' ')}
                    </label>
                  ))}
                </fieldset>
              ))}
              {(['minSize', 'maxSize'] as const).map((key) => (
                <Field
                  key={key}
                  id={`pr-inbox-${key}`}
                  label={key === 'minSize' ? 'Minimum changed lines' : 'Maximum changed lines'}
                >
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={filter.criteria[key] ?? ''}
                    onChange={(event) =>
                      setCriteria({
                        ...filter.criteria,
                        [key]: event.target.value === '' ? undefined : Number(event.target.value),
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </details>
          <div className="pr-inbox-results" aria-live="polite">
            <span>
              {shown.length} matching pull requests · {unknownExcluded} excluded because required
              facts are unavailable
            </span>
            {Object.keys(filter.criteria).length > 0 ? (
              <span>
                Criteria:{' '}
                {Object.entries(filter.criteria)
                  .map(
                    ([key, value]) =>
                      `${key}: ${Array.isArray(value) ? value.join(' or ') : value}`,
                  )
                  .join(' · ')}
              </span>
            ) : (
              <span>No structured criteria</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFilter(PULL_REQUEST_INBOX_DEFAULT_FILTER)}
            >
              Clear filters
            </Button>
          </div>
          {activeGroup ? (
            <p className="pr-inbox-rule">
              <strong>{activeGroup.label}:</strong> {activeGroup.rule}
            </p>
          ) : null}
          {presentation.notice ? (
            <InlineAlert
              className="gh-banner"
              role={presentation.notice.tone === 'error' ? 'alert' : 'status'}
              title={presentation.notice.title}
              tone={presentation.notice.tone}
            >
              {presentation.notice.detail}
            </InlineAlert>
          ) : null}
          {report?.refresh.truncated.length ? (
            <InlineAlert className="gh-banner" title="Merged history is bounded" tone="info">
              Recently merged shows the newest pages only for {report.refresh.truncated.join(', ')}.
              Older merged pull requests were not read.
            </InlineAlert>
          ) : null}
          {error ? (
            <InlineAlert
              className="gh-banner"
              onClick={onDismissError}
              role="alert"
              title="The queue could not be refreshed"
              tone="error"
            >
              {error}
            </InlineAlert>
          ) : null}
          {presentation.list === 'rows' ? (
            <div className="pr-list" ref={listRef} role="list" aria-label="Pull request inbox rows">
              {window.visible.map((item, index) => {
                const pr = asSharedPullRequest(item)
                return (
                  <div
                    className="pr-inbox-item"
                    key={`${item.host}/${item.repository}#${item.number}`}
                    role="listitem"
                  >
                    <Button
                      aria-label={rowLabel(item, now)}
                      className="pr-row"
                      variant="unstyled"
                      disabled={activating}
                      onClick={() => onOpen(item)}
                      onFocus={() => setActiveIndex(index)}
                      onKeyDown={(event) => {
                        if (!claimsRovingKey(event)) return
                        const action = rovingAction(event.key)
                        if (!action) return
                        const target = rovingTarget(action, index, window.visible.length)
                        if (target === null) return
                        event.preventDefault()
                        focusRow(target)
                      }}
                      tabIndex={rovingTabIndex(index, activeIndex)}
                      type="button"
                    >
                      <span className="pr-number">#{item.number}</span>
                      <span className="pr-copy">
                        <strong>{item.title}</strong>
                        <small>
                          {item.repository} · {inboxAuthorLabel(item)}
                        </small>
                        <small title={`${item.head} into ${item.base}`}>
                          {item.head} into {item.base}
                        </small>
                      </span>
                      <span className="pr-inbox-facts">
                        <span title={item.updatedAt ?? 'Update time unknown'}>
                          {updatedLabel(item, now)}
                        </span>
                        <span>Lines {countLabel(item.changeSize)}</span>
                        <span>
                          {item.stack
                            ? `Layer ${item.stack.position}/${item.stack.size}`
                            : 'Stack not reported'}
                        </span>
                        <span>Unresolved threads {countLabel(item.unresolvedThreads)}</span>
                      </span>
                      <span className="pr-badges">
                        <Badge variant={lifecycleVariant(pr)}>{lifecycleLabel(pr)}</Badge>
                        {hasMetadata(item) && item.checksKnown !== false ? (
                          <Badge variant={checksVariant(item.checks)}>
                            <ShieldCheck className="size-3" />
                            {checkLabel(item.checks)}
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            <ShieldCheck className="size-3" />
                            checks unknown
                          </Badge>
                        )}
                        <Badge
                          variant={
                            hasMetadata(item) && item.reviewKnown !== false
                              ? reviewVariant(pr)
                              : 'outline'
                          }
                        >
                          {inboxReviewLabel(item)}
                        </Badge>
                      </span>
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                )
              })}
              <ListWindowMore
                noun="pull requests"
                onPrevious={window.retreat}
                onReveal={window.reveal}
                pageSize={LIST_PAGE_SIZE}
                previous={window.hasPrevious}
                remaining={window.remaining}
              />
            </div>
          ) : presentation.list === 'loading' ? (
            <p className="workflow-loading" role="status">
              <Inbox className="size-4" />
              Reading the pull request queue from GitHub…
            </p>
          ) : presentation.list === 'unconfirmed' ? (
            <EmptyState className="compact-empty">
              <Search className="empty-icon" />
              {/* The notice's own heading, because every state that reaches
                  here already says something more exact than "unconfirmed"
                  would: which read ended, and why. The generic line stays for a
                  report that carries no notice at all. */}
              <h2>{presentation.notice?.title ?? 'The queue is unconfirmed'}</h2>
              <p>
                {presentation.notice?.detail ??
                  'GitHub has not confirmed this queue yet, so the rows below are not known to be current.'}
              </p>
              <Button onClick={onRefresh} size="sm" variant="secondary">
                Try again
              </Button>
            </EmptyState>
          ) : presentation.list === 'filtered-empty' ? (
            <EmptyState className="compact-empty">
              <Search className="empty-icon" />
              <h2>No matching pull requests</h2>
              <p>
                {queued > 0
                  ? `${queued} pull request${queued === 1 ? '' : 's'} in the queue; this group, search, and repository show none of them.`
                  : 'Change or clear the search and the repository filter to see the other pull requests.'}
              </p>
            </EmptyState>
          ) : (
            <EmptyState className="compact-empty">
              <Inbox className="empty-icon" />
              <h2>
                Nothing in {activeGroup ? pullRequestInboxGroupLabel(filter.group) : 'this group'}
              </h2>
              <p>
                {activeGroup?.rule ??
                  'GitHub confirmed the queue and this group is empty across your registered repositories.'}
              </p>
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}
