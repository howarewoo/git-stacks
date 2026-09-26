import * as React from 'react'
import {
  Archive,
  ChevronRight,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  Plus,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react'
import type { ChangedFile, PullRequest, RepositorySnapshot } from '../../../shared/types'
import { LIST_PAGE_SIZE } from '../../../shared/performance'
import { useListWindow } from '../lib/list-window'
import { ListWindowMore } from './list-window'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Textarea } from './ui/textarea'
import { EmptyState, InlineAlert } from './ui/surface'
import { FileInspector } from './repository-views'
import { PullRequestHoverCard } from './repository-hover-cards'
import { cn } from '../lib/utils'
import {
  checkLabel,
  checksVariant,
  lifecycleLabel,
  lifecycleVariant,
  reviewLabel,
  reviewVariant,
} from '../lib/pull-request-state'
import type { RunAction, WorkflowRequest } from './workflow-dialog'

export function fileIsStaged(file: ChangedFile): boolean {
  return file.index !== '' && file.index !== ' ' && file.index !== '?'
}

export function fileIsUnstaged(file: ChangedFile): boolean {
  return file.worktree !== '' && file.worktree !== ' '
}

function statusLetter(value: string): string {
  if (!value || value === ' ') return '·'
  if (value === '?') return 'U'
  return value
}

export type ChangeGroups = {
  search: string
  staged: ChangedFile[]
  unstaged: ChangedFile[]
  conflicted: ChangedFile[]
  visibleStaged: ChangedFile[]
  visibleUnstaged: ChangedFile[]
}

/**
 * Groups and filters the changed files. Bulk actions read the visible lists so a
 * filtered "Stage shown" never includes a hidden file, and a rename keeps both of
 * its paths.
 */
export function changeGroups(files: readonly ChangedFile[], search: string): ChangeGroups {
  const staged = files.filter(fileIsStaged)
  const unstaged = files.filter(
    (file) => fileIsUnstaged(file) || (!fileIsStaged(file) && file.index === '?'),
  )
  const needle = search.trim().toLowerCase()
  const matches = (file: ChangedFile) =>
    `${file.path} ${file.originalPath ?? ''}`.toLowerCase().includes(needle)
  return {
    search: needle,
    staged,
    unstaged,
    conflicted: files.filter((file) => file.conflicted),
    visibleStaged: staged.filter(matches),
    visibleUnstaged: unstaged.filter(matches),
  }
}

/** Git needs both sides of a rename; duplicates collapse so a path is never sent twice. */
export function changePaths(files: readonly ChangedFile[]): string[] {
  return [
    ...new Set(
      files.flatMap((file) => (file.originalPath ? [file.path, file.originalPath] : [file.path])),
    ),
  ]
}

export function matchesPullRequest(pr: PullRequest, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return `${pr.title} ${pr.head} ${pr.base} #${pr.number}`.toLowerCase().includes(needle)
}

export function ChangesView({
  snapshot,
  groups,
  busy,
  busyAction,
  operationActive,
  runAction,
  inspectedPath,
  onInspect,
  commitMessage,
  onCommitMessageChange,
  commitAmend,
  onCommitAmendChange,
  onSubmitCommit,
  actionError,
  onStash,
}: {
  snapshot: RepositorySnapshot
  groups: ChangeGroups
  busy: boolean
  busyAction: string | null
  operationActive: boolean
  runAction: RunAction
  inspectedPath: string | null
  onInspect: (path: string | null) => void
  commitMessage: string
  onCommitMessageChange: (value: string) => void
  commitAmend: boolean
  onCommitAmendChange: (value: boolean) => void
  onSubmitCommit: (event: React.FormEvent<HTMLFormElement>) => void
  onStash: () => void
  actionError: string | null
}) {
  const stagedWindow = useListWindow(groups.visibleStaged)
  const unstagedWindow = useListWindow(groups.visibleUnstaged)
  // Bulk actions act on the retained listing. When the main process had to cut
  // that listing, staging "all" would silently skip the rest, so both are
  // locked and the limit is stated.
  const listingTruncated = snapshot.limits.filesTruncated
  const fileSearch = groups.search
  const renderFileRow = (file: ChangedFile, action: 'stage' | 'unstage') => (
    <div
      className={cn('file-row', file.conflicted && 'file-row-conflicted')}
      key={`${action}:${file.path}`}
    >
      <span
        className={cn('file-status', file.conflicted && 'file-status-conflicted')}
        title={
          file.conflicted
            ? 'Conflict'
            : `Index ${statusLetter(file.index)}, worktree ${statusLetter(file.worktree)}`
        }
      >
        {file.conflicted ? '!' : `${statusLetter(file.index)}${statusLetter(file.worktree)}`}
      </span>
      <button
        className="file-copy"
        title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
        type="button"
        onClick={() => onInspect(file.path)}
        aria-label={`${file.conflicted ? 'Resolve' : 'Inspect'} ${file.path}`}
      >
        {file.originalPath ? (
          <span className="file-path-rename">
            <span className="file-path-original">{file.originalPath}</span>
            <span aria-hidden="true"> → </span>
            <span className="file-path-current">{file.path}</span>
          </span>
        ) : (
          <span className="file-path-current">{file.path}</span>
        )}
        <span className="file-inspect" aria-hidden="true">
          {file.conflicted ? 'Resolve' : 'Inspect'}
        </span>
      </button>
      <Button
        disabled={busy}
        tooltip={
          action === 'stage'
            ? "Stage this file's working-tree changes for the next commit. Local index only."
            : 'Remove this file from the index; its working-tree edits remain. Nothing is discarded.'
        }
        onClick={() =>
          runAction(
            { type: action, paths: changePaths([file]) },
            action === 'stage' ? 'Stage file' : 'Unstage file',
          )
        }
        size="sm"
        variant="ghost"
      >
        {action === 'stage' ? 'Stage' : 'Unstage'}
      </Button>
    </div>
  )

  return (
    <div className="changes-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1>Working changes</h1>
          <span className="list-subtitle">
            {snapshot.files.length} file{snapshot.files.length === 1 ? '' : 's'}
          </span>
        </div>
        <Button
          disabled={snapshot.files.length === 0 || busy || listingTruncated}
          tooltip="Shelve tracked working changes into a local stash and restore a clean tree. Choose whether untracked files are included."
          onClick={onStash}
          size="sm"
          variant="secondary"
        >
          {busyAction === 'Stash changes' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Archive className="size-3.5" />
          )}
          Stash changes
        </Button>
      </div>
      {listingTruncated ? (
        <p className="workflow-note" role="status">
          Showing the first {snapshot.limits.filesListed} changed files. This repository reports
          more, so bulk stage, unstage, and stash are unavailable. Narrow the search, or use your
          editor or the command line for the remaining files.
        </p>
      ) : null}
      <div className="changes-columns">
        <section className="change-section" aria-labelledby="staged-heading">
          <div className="change-section-header">
            <div>
              <h2 id="staged-heading">Staged</h2>
              <span>
                {groups.staged.length} file{groups.staged.length === 1 ? '' : 's'} ready to commit
              </span>
            </div>
            <Badge variant={groups.staged.length > 0 ? 'accent' : 'secondary'}>
              {groups.staged.length}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !groups.visibleStaged.length || listingTruncated}
              tooltip={
                listingTruncated
                  ? 'The changed-file listing was cut at the read budget, so unstaging everything would skip files that are not shown. Inspect files individually.'
                  : fileSearch
                    ? 'Remove the shown files from the index; working-tree edits remain. Hidden staged files stay staged.'
                    : 'Remove all staged changes from the index; working-tree edits remain. Nothing is discarded.'
              }
              onClick={() =>
                runAction(
                  { type: 'unstage', paths: changePaths(groups.visibleStaged) },
                  'Unstage files',
                )
              }
            >
              {fileSearch ? 'Unstage shown' : 'Unstage all'}
            </Button>
          </div>
          {groups.visibleStaged.length > 0 ? (
            <div className="file-list">
              {stagedWindow.visible.map((file) => renderFileRow(file, 'unstage'))}
              <ListWindowMore
                pageSize={LIST_PAGE_SIZE}
                remaining={stagedWindow.remaining}
                previous={stagedWindow.hasPrevious}
                noun="staged files"
                onReveal={stagedWindow.reveal}
                onPrevious={stagedWindow.retreat}
              />
            </div>
          ) : (
            <p className="section-empty">
              {fileSearch
                ? 'No staged files match your search.'
                : 'Stage files from the working tree to prepare a commit.'}
            </p>
          )}
        </section>
        <section className="change-section" aria-labelledby="unstaged-heading">
          <div className="change-section-header">
            <div>
              <h2 id="unstaged-heading">Unstaged</h2>
              <span>Changes in the working tree</span>
            </div>
            <Badge variant={groups.unstaged.length > 0 ? 'warning' : 'secondary'}>
              {groups.unstaged.length}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              disabled={
                busy ||
                !groups.visibleUnstaged.length ||
                groups.conflicted.length > 0 ||
                listingTruncated
              }
              tooltip={
                listingTruncated
                  ? 'The changed-file listing was cut at the read budget, so staging everything would skip files that are not shown. Inspect files individually.'
                  : groups.conflicted.length > 0
                    ? 'Resolve conflicts before staging — conflicted files cannot be staged in bulk.'
                    : fileSearch
                      ? 'Stage the shown working-tree changes for the next commit. Hidden unstaged files stay unstaged.'
                      : 'Stage all working-tree changes for the next commit. Local index only; nothing is committed yet.'
              }
              onClick={() =>
                runAction(
                  { type: 'stage', paths: changePaths(groups.visibleUnstaged) },
                  'Stage files',
                )
              }
            >
              {fileSearch ? 'Stage shown' : 'Stage all'}
            </Button>
          </div>
          {groups.visibleUnstaged.length > 0 ? (
            <div className="file-list">
              {unstagedWindow.visible.map((file) => renderFileRow(file, 'stage'))}
              <ListWindowMore
                pageSize={LIST_PAGE_SIZE}
                remaining={unstagedWindow.remaining}
                previous={unstagedWindow.hasPrevious}
                noun="unstaged files"
                onReveal={unstagedWindow.reveal}
                onPrevious={unstagedWindow.retreat}
              />
            </div>
          ) : (
            <p className="section-empty">
              {fileSearch ? 'No unstaged files match your search.' : 'Your working tree is clean.'}
            </p>
          )}
        </section>
      </div>
      {inspectedPath && snapshot.files.some((file) => file.path === inspectedPath) ? (
        <FileInspector
          key={inspectedPath}
          path={inspectedPath}
          snapshot={snapshot}
          busy={busy}
          runAction={runAction}
          onClose={() => onInspect(null)}
          actionError={actionError}
        />
      ) : null}
      <form className="commit-panel" onSubmit={onSubmitCommit}>
        <div className="commit-panel-heading">
          <GitCommitHorizontal className="size-4" />
          <div>
            <h2>{commitAmend ? 'Amend the last commit' : 'Commit staged changes'}</h2>
            <span>
              {commitAmend
                ? 'Enter the full replacement message. Staged changes are included.'
                : 'Only staged files will be included.'}
            </span>
          </div>
        </div>
        <Checkbox
          id="commit-amend"
          className="commit-amend"
          label={
            <>
              Amend last commit
              {snapshot.currentBranch === snapshot.defaultBranch
                ? ' (protected on default branch)'
                : ''}
            </>
          }
          checked={commitAmend}
          disabled={
            busy ||
            operationActive ||
            !snapshot.headOid ||
            snapshot.currentBranch === snapshot.defaultBranch
          }
          onChange={(event) => onCommitAmendChange(event.target.checked)}
        />
        <div className="commit-form-row">
          <Field
            className="commit-message-field"
            id="commit-message"
            label="Commit message"
            description={
              commitAmend
                ? 'Replaces the last commit message. Review the rewritten commit before it is applied.'
                : 'Applies to staged files only. Unstaged edits stay in the working tree.'
            }
          >
            <Textarea
              aria-label="Commit message"
              disabled={(!commitAmend && groups.staged.length === 0) || busy || operationActive}
              onChange={(event) => onCommitMessageChange(event.target.value)}
              placeholder="Summary and optional commit body"
              rows={2}
              value={commitMessage}
            />
          </Field>
          <Button
            disabled={
              !commitMessage.trim() ||
              (!commitAmend && groups.staged.length === 0) ||
              busy ||
              operationActive
            }
            type="submit"
            variant="accent"
            tooltip={
              commitAmend
                ? 'Review rewriting the last commit with the new message plus staged changes. Rewrites local history; pushed commits will need force push.'
                : 'Create a local commit from staged changes only. Unstaged edits stay in the working tree; nothing is pushed.'
            }
          >
            {busyAction === 'Commit staged changes' ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal className="size-3.5" />
            )}
            {commitAmend ? 'Review amend…' : 'Commit'}
          </Button>
        </div>
      </form>
    </div>
  )
}

export function PullRequestListView({
  snapshot,
  pullRequests,
  busy,
  onRequest,
  onCreate,
  canCreate,
  createTooltip,
}: {
  snapshot: RepositorySnapshot
  pullRequests: PullRequest[]
  busy: boolean
  onRequest: (request: WorkflowRequest) => void
  onCreate: () => void
  canCreate: boolean
  createTooltip: React.ReactNode
}) {
  const filtered = pullRequests.length !== snapshot.pullRequests.length
  const prWindow = useListWindow(pullRequests)
  return (
    <div className="pull-requests-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1>Pull requests</h1>
          <span className="list-subtitle">
            {snapshot.github.available ? `${pullRequests.length} shown` : 'GitHub data unavailable'}
          </span>
        </div>
        <Button
          disabled={!canCreate}
          tooltip={createTooltip}
          onClick={onCreate}
          size="sm"
          variant="accent"
        >
          <Plus className="size-3.5" />
          Create PR
        </Button>
      </div>
      {!snapshot.github.available ? (
        <InlineAlert
          className="gh-banner"
          tone="warning"
          title="GitHub data unavailable"
          role="status"
        >
          {snapshot.github.message ||
            'Install and authenticate gh to list or create pull requests. Local Git actions remain available.'}
        </InlineAlert>
      ) : null}
      {pullRequests.length > 0 ? (
        <div className="pr-list">
          {prWindow.visible.map((pr) => (
            <PullRequestHoverCard pr={pr} key={pr.number}>
              <button
                className="pr-row"
                onClick={() => onRequest({ kind: 'pr', number: pr.number })}
                disabled={busy}
                type="button"
                aria-label={`Open pull request #${pr.number} ${pr.title}, ${lifecycleLabel(pr)}`}
              >
                <span className="pr-number">#{pr.number}</span>
                <span className="pr-copy">
                  <strong>{pr.title}</strong>
                  <small>
                    {pr.head} <span aria-hidden="true">→</span> {pr.base}
                  </small>
                </span>
                <span className="pr-badges">
                  <Badge variant={lifecycleVariant(pr)}>{lifecycleLabel(pr)}</Badge>
                  <Badge variant={checksVariant(pr.checks)}>
                    <ShieldCheck className="size-3" />
                    {checkLabel(pr.checks)}
                  </Badge>
                  <Badge variant={reviewVariant(pr)}>{reviewLabel(pr)}</Badge>
                </span>
                <ChevronRight className="size-4" />
              </button>
            </PullRequestHoverCard>
          ))}
          <ListWindowMore
            pageSize={LIST_PAGE_SIZE}
            remaining={prWindow.remaining}
            previous={prWindow.hasPrevious}
            noun="pull requests"
            onReveal={prWindow.reveal}
            onPrevious={prWindow.retreat}
          />
        </div>
      ) : (
        <EmptyState className="compact-empty">
          <GitPullRequest className="empty-icon" />
          <h2>
            {!snapshot.github.available
              ? 'Pull requests unavailable'
              : filtered
                ? 'No matching pull requests'
                : 'No pull requests'}
          </h2>
          <p>
            {!snapshot.github.available
              ? 'GitHub did not return pull request data, so the count is unknown rather than zero.'
              : filtered
                ? 'Change or clear the search to see the other pull requests.'
                : 'Create a pull request from the current branch when it is ready.'}
          </p>
        </EmptyState>
      )}
    </div>
  )
}

export function StashesView({
  snapshot,
  busy,
  busyAction,
  operationActive,
  runAction,
  onRequest,
  onStash,
}: {
  snapshot: RepositorySnapshot
  busy: boolean
  busyAction: string | null
  operationActive: boolean
  runAction: RunAction
  onRequest: (request: WorkflowRequest) => void
  onStash: () => void
}) {
  const stashWindow = useListWindow(snapshot.stashes)
  return (
    <div className="stashes-view">
      <div className="list-toolbar">
        <div className="list-title-group">
          <h1>Stashes</h1>
          <span className="list-subtitle">{snapshot.stashes.length} saved</span>
        </div>
        <Button
          disabled={snapshot.files.length === 0 || busy}
          tooltip="Shelve current working changes into a local stash and restore a clean tree. Choose whether untracked files are included."
          onClick={onStash}
          size="sm"
          variant="accent"
        >
          {busyAction === 'Stash changes' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Archive className="size-3.5" />
          )}
          Stash current changes
        </Button>
      </div>
      {snapshot.stashes.length > 0 ? (
        <div className="stash-list" role="list">
          {stashWindow.visible.map((stash) => (
            <div
              className="stash-row"
              key={stash.oid}
              role="listitem"
              aria-label={`Stash ${stash.ref}`}
            >
              <Archive className="size-4" />
              <span className="stash-copy">
                <strong>{stash.message || 'WIP'}</strong>
                <small>
                  {stash.ref} · <code>{stash.oid.slice(0, 8)}</code>
                </small>
              </span>
              <Button
                disabled={busy || operationActive}
                aria-label={`Apply ${stash.ref}`}
                tooltip="Restore this stash’s working changes and saved staging state, and keep the stash. May conflict with current edits."
                onClick={() =>
                  runAction({ type: 'stashApply', ref: stash.ref, oid: stash.oid }, 'Apply stash')
                }
                size="sm"
                variant="ghost"
              >
                Apply
              </Button>
              <Button
                disabled={busy}
                aria-label={`Pop ${stash.ref}`}
                tooltip="Reapply this stash to the working tree, then delete it from the list. Stops on conflicts so saved changes are not lost silently."
                onClick={() =>
                  runAction({ type: 'stashPop', ref: stash.ref, oid: stash.oid }, 'Pop stash')
                }
                size="sm"
                variant="secondary"
              >
                <RotateCcw className="size-3.5" />
                Pop
              </Button>
              <Button
                disabled={busy || operationActive}
                aria-label={`Drop ${stash.ref}`}
                tooltip="Preview permanently removing this saved stash without applying it. This app cannot restore a dropped stash."
                onClick={() =>
                  onRequest({
                    kind: 'confirm',
                    title: 'Drop this stash?',
                    description: `Permanently remove ${stash.ref}: ${stash.message}. Its saved changes will not be applied.`,
                    label: 'Drop stash',
                    action: { type: 'stashDrop', ref: stash.ref, oid: stash.oid },
                    destructive: true,
                  })
                }
                size="sm"
                variant="danger"
              >
                Drop…
              </Button>
            </div>
          ))}
          <ListWindowMore
            pageSize={LIST_PAGE_SIZE}
            remaining={stashWindow.remaining}
            previous={stashWindow.hasPrevious}
            noun="stashes"
            onReveal={stashWindow.reveal}
            onPrevious={stashWindow.retreat}
          />
        </div>
      ) : (
        <EmptyState className="compact-empty">
          <Archive className="empty-icon" />
          <h2>No stashes</h2>
          <p>Stash changes before switching context when you need a clean tree.</p>
        </EmptyState>
      )}
    </div>
  )
}
