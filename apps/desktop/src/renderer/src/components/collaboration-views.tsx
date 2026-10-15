import * as React from 'react'
import { Badge, Button, Input, Select } from '@git-stacks/ui'
import type { RepositoryInventory } from '@git-stacks/shared/worktree-inventory'
import type { PullRequestPage } from '@git-stacks/shared/types'
import { LIST_PAGE_SIZE } from '@git-stacks/shared/performance'
import {
  evaluatePullRequestInbox,
  type PullRequestInboxFilter,
  type PullRequestInboxFilterDraft,
  type PullRequestInboxSavedFilter,
} from '@git-stacks/shared/pr-inbox'
import type { AttentionItem, CollaborationTarget, ObservedActivity } from '../lib/collaboration'

export interface PullRequestListState {
  query: string
  lifecycle: string
  page: number
  scroll: number
  cursor: string | null
}

function Pages({
  page,
  count,
  onChange,
}: {
  page: number
  count: number
  onChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(count / LIST_PAGE_SIZE))
  return (
    <div className="wb-list-pages">
      <Button variant="ghost" disabled={!page} onClick={() => onChange(page - 1)}>
        Previous page
      </Button>
      <span>
        Page {page + 1} / {pages} · {count} observed items
      </span>
      <Button variant="ghost" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}>
        Next page
      </Button>
    </div>
  )
}

export function PullRequestList({
  repository,
  source,
  pending,
  state,
  onChange,
  onOpen,
  onCreate,
  error,
}: {
  repository: RepositoryInventory | undefined
  source: PullRequestPage | undefined
  pending: boolean
  state: PullRequestListState
  onChange: (state: PullRequestListState) => void
  onOpen: (target: CollaborationTarget) => void
  onCreate: () => void
  error: string | null
}) {
  const scroll = React.useRef<HTMLDivElement>(null)
  const numbers = source ? new Set(source.pullRequests.map((pr) => pr.number)) : null
  const rows = (repository?.pullRequests ?? []).filter((pr) => {
    if (numbers && !numbers.has(pr.number)) return false
    const lifecycleMatches =
      state.lifecycle === 'all' ||
      (state.lifecycle === 'draft'
        ? pr.facts.state === 'OPEN' && pr.facts.draft
        : state.lifecycle === pr.facts.state.toLowerCase())
    const query = state.query.trim().toLowerCase()
    return (
      lifecycleMatches &&
      `${pr.number} ${pr.facts.title} ${pr.facts.author ?? ''} ${pr.facts.headRepository ?? ''} ${pr.headRef} ${pr.facts.base}`
        .toLowerCase()
        .includes(query)
    )
  })
  const page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / LIST_PAGE_SIZE) - 1))
  React.useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = state.scroll
  }, [repository?.identity.id, page, state.cursor, state.lifecycle, state.query])
  const filter = (patch: Partial<PullRequestListState>) =>
    onChange({
      ...state,
      ...patch,
      ...(patch.lifecycle !== undefined ? { cursor: null } : {}),
      page: 0,
      scroll: 0,
    })
  return (
    <div className="wb-collaboration">
      <div className="wb-list-toolbar">
        <Input
          aria-label="Search pull requests"
          placeholder="Search title, number, author or ref"
          value={state.query}
          onChange={(event) => filter({ query: event.target.value })}
        />
        <Select
          aria-label="Pull request lifecycle"
          value={state.lifecycle}
          onValueChange={(lifecycle) => filter({ lifecycle })}
          options={[
            { value: 'all', label: 'All pull requests' },
            { value: 'open', label: 'Open' },
            { value: 'draft', label: 'Draft' },
            { value: 'closed', label: 'Closed' },
            { value: 'merged', label: 'Merged' },
          ]}
        />
        <Button variant="secondary" onClick={onCreate} disabled={!repository}>
          Create pull request
        </Button>
      </div>
      <p className="wb-source-status" role="status">
        {repository?.remote
          ? `${repository.remote.host}/${repository.remote.fullName}`
          : 'Choose a registered repository'}{' '}
        ·{' '}
        {pending
          ? 'Reading captured provider page…'
          : source
            ? `Page observed ${new Date(source.observedAt).toLocaleString()}${source.next ? '; more pull requests are available' : '; end of this lifecycle listing'}`
            : 'Provider page not observed'}
        . Search applies to this observed page. Local unpublished commits are not part of these
        published heads.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {repository?.remoteFreshness?.detail ? <p>{repository.remoteFreshness.detail}</p> : null}
      {source?.nativeMessage ? <p className="wb-source-status">{source.nativeMessage}</p> : null}
      <div
        className="wb-secondary-list"
        ref={scroll}
        onScroll={(event) => onChange({ ...state, scroll: event.currentTarget.scrollTop })}
      >
        {rows.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE).map((pr) => (
          <Button
            key={pr.id}
            variant="ghost"
            className="wb-pr-row"
            onClick={() =>
              onOpen({
                repositoryId: repository!.identity.id,
                pullRequestId: pr.id,
                number: pr.number,
              })
            }
          >
            <span className="wb-row-title">
              #{pr.number} {pr.facts.title}
            </span>
            <span>
              By {pr.facts.author ?? 'author unknown'} ·{' '}
              <code>
                {repository?.remote?.host}/{pr.facts.headRepository ?? 'head repository unknown'}:
                {pr.headRef}
              </code>{' '}
              →{' '}
              <code>
                {repository?.remote?.host}/{repository?.remote?.fullName}:{pr.facts.base}
              </code>
            </span>
            <span className="wb-row-facts">
              <Badge>{pr.facts.state}</Badge>
              {pr.facts.draft ? <Badge>Draft</Badge> : null}
              <span>
                {pr.facts.metadata === 'full' ? `Checks ${pr.facts.checks}` : 'Checks unknown'}
              </span>
              <span>
                {pr.facts.metadata === 'full'
                  ? (pr.facts.reviewDecision ?? 'Review decision not reported')
                  : 'Review unknown'}
              </span>
              <span>
                {pr.facts.stack
                  ? `Native stack #${pr.facts.stack.stackNumber} · layer ${pr.facts.stack.position}/${pr.facts.stack.size}`
                  : 'Native membership not reported'}
              </span>
            </span>
            <small>
              Published head {pr.headOid?.slice(0, 12) ?? 'unknown'} · review without checkout
            </small>
          </Button>
        ))}
        {!rows.length ? (
          <p>
            {repository?.remoteFreshness?.state === 'fresh'
              ? 'No observed pull requests match these filters.'
              : 'No matching pull requests are available; this is not proof that none exist.'}
          </p>
        ) : null}
      </div>
      <Pages
        page={page}
        count={rows.length}
        onChange={(page) => onChange({ ...state, page, scroll: 0 })}
      />
      <div className="wb-list-pages">
        <Button
          variant="ghost"
          disabled={pending || !state.cursor}
          onClick={() => onChange({ ...state, cursor: null, page: 0, scroll: 0 })}
        >
          Newest provider page
        </Button>
        <Button
          variant="secondary"
          disabled={pending || !source?.next}
          onClick={() => onChange({ ...state, cursor: source!.next, page: 0, scroll: 0 })}
        >
          Next provider page
        </Button>
      </div>
    </div>
  )
}

const ATTENTION_GROUPS: { id: AttentionItem['group']; label: string }[] = [
  { id: 'review', label: 'Review requested and new published heads' },
  { id: 'response', label: 'Needs response or changes' },
  { id: 'checks', label: 'Failed checks' },
  { id: 'local', label: 'Local conflicts, recovery and dependencies' },
]
export interface AttentionViewState {
  page: number
  scroll: number
  filterName: string
  savedFilterId: string
}
export interface ActivityViewState {
  repositoryId: string
  page: number
  scroll: number
}
export function AttentionView({
  items,
  repositories,
  sourceStatus,
  loading,
  error,
  filter,
  onFilterChange,
  savedFilters,
  onSaveFilters,
  saving,
  onOpen,
  onRefresh,
  searchInputRef,
  state,
  onStateChange,
}: {
  items: readonly AttentionItem[]
  repositories: readonly string[]
  sourceStatus: string
  loading: boolean
  error: string | null
  filter: PullRequestInboxFilter
  onFilterChange: (filter: PullRequestInboxFilter) => void
  savedFilters: readonly PullRequestInboxSavedFilter[]
  onSaveFilters: (drafts: PullRequestInboxFilterDraft[]) => Promise<PullRequestInboxSavedFilter[]>
  saving: boolean
  onOpen: (target: CollaborationTarget) => void
  onRefresh: () => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  state: AttentionViewState
  onStateChange: (state: AttentionViewState) => void
}) {
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const list = React.useRef<HTMLDivElement>(null)
  const shown = items.filter((item) => {
    const query = filter.search.trim().toLowerCase()
    if (!`${item.repository} ${item.title} ${item.reasons.join(' ')}`.toLowerCase().includes(query))
      return false
    if (
      !item.source &&
      filter.criteria.repositories?.length &&
      !filter.criteria.repositories.some(
        (repository) => repository === item.repository || repository === item.source?.repository,
      )
    )
      return false
    if (item.source)
      return evaluatePullRequestInbox(item.source, { ...filter, search: '' }) === 'match'
    return (
      filter.group === 'all' && !Object.keys(filter.criteria).some((key) => key !== 'repositories')
    )
  })
  const currentPage = Math.min(
    state.page,
    Math.max(0, Math.ceil(shown.length / LIST_PAGE_SIZE) - 1),
  )
  const mounted = shown.slice(currentPage * LIST_PAGE_SIZE, (currentPage + 1) * LIST_PAGE_SIZE)
  React.useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = state.scroll
  }, [currentPage])
  const change = (patch: Partial<PullRequestInboxFilter>) => {
    onStateChange({ ...state, page: 0, scroll: 0 })
    onFilterChange({ ...filter, ...patch })
  }
  const save = async () => {
    setSaveError(null)
    const existing = savedFilters.find((entry) => entry.name === state.filterName.trim())
    const confirmed = await onSaveFilters([
      ...savedFilters.filter((entry) => entry !== existing),
      { ...filter, name: state.filterName.trim(), ...(existing ? { id: existing.id } : {}) },
    ])
    onStateChange({
      ...state,
      savedFilterId: confirmed.find((entry) => entry.name === state.filterName.trim())?.id ?? '',
      filterName: '',
    })
  }
  return (
    <div className="wb-collaboration">
      <div className="wb-list-toolbar">
        <Input
          ref={searchInputRef}
          aria-label="Search needs attention"
          value={filter.search}
          placeholder="Search attention"
          onChange={(event) => change({ search: event.target.value })}
        />
        <Select
          aria-label="Attention repository"
          value={filter.criteria.repositories?.[0] ?? ''}
          onValueChange={(repository) =>
            change({ criteria: repository ? { repositories: [repository] } : {} })
          }
          options={[
            { value: '', label: 'All repositories' },
            ...repositories.map((repository) => ({ value: repository, label: repository })),
          ]}
        />
        <Button variant="secondary" loading={loading} onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <div className="wb-list-toolbar">
        <Select
          aria-label="Saved attention filter"
          value={state.savedFilterId}
          onValueChange={(id) => {
            const saved = savedFilters.find((item) => item.id === id)
            if (saved) {
              onFilterChange(saved)
              onStateChange({
                ...state,
                savedFilterId: id,
                filterName: saved.name,
                page: 0,
                scroll: 0,
              })
            }
          }}
          options={[
            { value: '', label: 'Saved filters' },
            ...savedFilters.map((item) => ({ value: item.id, label: item.name })),
          ]}
        />
        <Input
          disabled={saving}
          aria-label="Attention filter name"
          placeholder="Name this filter"
          value={state.filterName}
          onChange={(event) => onStateChange({ ...state, filterName: event.target.value })}
        />
        <Button
          variant="ghost"
          disabled={saving || !state.filterName.trim()}
          onClick={() =>
            void save().catch((error) =>
              setSaveError(error instanceof Error ? error.message : String(error)),
            )
          }
        >
          Save filter
        </Button>
        <Button
          variant="ghost"
          disabled={saving || !state.savedFilterId}
          onClick={() => {
            setSaveError(null)
            void onSaveFilters(savedFilters.filter((entry) => entry.id !== state.savedFilterId))
              .then(() => onStateChange({ ...state, savedFilterId: '' }))
              .catch((error) =>
                setSaveError(error instanceof Error ? error.message : String(error)),
              )
          }}
        >
          Delete saved filter
        </Button>
        <Button variant="ghost" onClick={() => change({ group: 'all', search: '', criteria: {} })}>
          Clear filters
        </Button>
      </div>
      {saveError ? <p role="alert">{saveError}</p> : null}
      <p className="wb-source-status" role="status">
        {sourceStatus} · {items.length} distinct observed items; reasons are not added to the item
        count.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div
        className="wb-secondary-list"
        ref={list}
        onScroll={(event) => onStateChange({ ...state, scroll: event.currentTarget.scrollTop })}
      >
        {ATTENTION_GROUPS.map((group) => {
          const rows = mounted.filter((item) => item.group === group.id)
          if (!rows.length) return null
          return (
            <section key={group.id}>
              <h2>
                {group.label} <span>{shown.filter((item) => item.group === group.id).length}</span>
              </h2>
              {rows.map((item) => (
                <Button
                  className="wb-attention-row"
                  key={item.id}
                  variant="ghost"
                  onClick={() => onOpen(item.target)}
                >
                  <span>{item.repository}</span>
                  <strong>{item.title}</strong>
                  <span>{item.reasons.join(' · ')}</span>
                  <small>
                    {item.target.number ? 'Open full review' : 'Inspect exact local context'}
                  </small>
                </Button>
              ))}
            </section>
          )
        })}
        {!shown.length ? (
          <p>
            {loading
              ? 'Reading source-backed attention…'
              : 'No matching observed items. Incomplete sources may contain work not listed here.'}
          </p>
        ) : null}
      </div>
      <Pages
        page={currentPage}
        count={shown.length}
        onChange={(page) => onStateChange({ ...state, page, scroll: 0 })}
      />
      <p className="wb-source-status">
        Browsing does not acknowledge Notifications, resolve conflicts, approve reviews or dismiss
        recovery. Team requests are not direct requests; unknown viewers cannot establish work owed
        to you.
      </p>
    </div>
  )
}

export function ActivityView({
  events,
  repositories,
  onOpen,
  state,
  onStateChange,
}: {
  events: readonly ObservedActivity[]
  repositories: readonly { id: string; name: string }[]
  onOpen: (target: CollaborationTarget) => void
  state: ActivityViewState
  onStateChange: (state: ActivityViewState) => void
}) {
  const list = React.useRef<HTMLDivElement>(null)
  const shown = events.filter(
    (event) => !state.repositoryId || event.target.repositoryId === state.repositoryId,
  )
  const currentPage = Math.min(
    state.page,
    Math.max(0, Math.ceil(shown.length / LIST_PAGE_SIZE) - 1),
  )
  React.useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = state.scroll
  }, [currentPage, state.repositoryId])
  return (
    <div className="wb-collaboration">
      <div className="wb-list-toolbar">
        <Select
          aria-label="Activity repository"
          value={state.repositoryId}
          onValueChange={(repositoryId) =>
            onStateChange({ ...state, repositoryId, page: 0, scroll: 0 })
          }
          options={[
            { value: '', label: 'All repositories' },
            ...repositories.map((repo) => ({ value: repo.id, label: repo.name })),
          ]}
        />
      </div>
      <p className="wb-source-status">
        Observed changes and app outcomes in this window, newest first. Initial snapshots are not
        history; unobserved past and external-tool activity are unavailable.
      </p>
      <div
        className="wb-secondary-list"
        ref={list}
        onScroll={(event) => onStateChange({ ...state, scroll: event.currentTarget.scrollTop })}
      >
        {shown
          .slice(currentPage * LIST_PAGE_SIZE, (currentPage + 1) * LIST_PAGE_SIZE)
          .map((event) => (
            <Button variant="ghost" key={event.id} onClick={() => onOpen(event.target)}>
              <strong>{event.repository}</strong>
              <span>{event.label}</span>
              <small>
                {event.eventAt ? 'Event' : 'Observed'}{' '}
                {new Date(event.eventAt ?? event.observedAt).toLocaleString()}
              </small>
            </Button>
          ))}
        {!shown.length ? (
          <p>
            No transitions observed yet. Existing repository state is not a fabricated historical
            event.
          </p>
        ) : null}
      </div>
      <Pages
        page={currentPage}
        count={shown.length}
        onChange={(page) => onStateChange({ ...state, page, scroll: 0 })}
      />
    </div>
  )
}
