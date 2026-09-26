import * as React from 'react'
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Layers,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { Branch, PullRequest } from '../../../shared/types'
import { Badge } from './ui/badge'
import { Button, IconButton } from './ui/button'
import { CurrentBadge } from './branch-workspace'
import { formatBranchDate, parentProvenanceLabel, requiresRestack } from '../lib/branch-workspace'
import {
  checkLabel,
  checksVariant,
  mergeStateLabel,
  prStateLabel,
  prStateVariant,
  reviewLabel,
} from '../lib/pull-request-state'

export function InspectorSection({
  children,
  title,
  tone = 'default',
}: {
  children: React.ReactNode
  title: string
  tone?: 'default' | 'danger'
}) {
  return (
    <section
      className={
        tone === 'danger' ? 'inspector-section inspector-section-danger' : 'inspector-section'
      }
    >
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export type BranchInspectorProps = {
  branch: Branch
  pullRequest: PullRequest | null
  parent: Branch | null
  defaultBranch: string
  github: { available: boolean; message: string }
  busy: boolean
  operationActive: boolean
  deleteButtonRef?: React.Ref<HTMLButtonElement>
  onClose: () => void
  onSwitch: () => void
  onRebaseOntoParent: () => void
  onRestack: () => void
  onPublish: () => void
  onSetParent: () => void
  onPreviewMerge: () => void
  onCreatePullRequest: () => void
  onManagePullRequest: () => void
  onOpenExternal: (url: string) => void
  onRename: () => void
  onSetUpstream: () => void
  onDeleteLocal: () => void
  onDeleteRemote: () => void
}

export function BranchInspector({
  branch,
  pullRequest,
  parent,
  defaultBranch,
  github,
  busy,
  operationActive,
  deleteButtonRef,
  onClose,
  onSwitch,
  onRebaseOntoParent,
  onRestack,
  onPublish,
  onSetParent,
  onPreviewMerge,
  onCreatePullRequest,
  onManagePullRequest,
  onOpenExternal,
  onRename,
  onSetUpstream,
  onDeleteLocal,
  onDeleteRemote,
}: BranchInspectorProps) {
  const restack = requiresRestack(branch)
  const isDefaultBranch = branch.name === defaultBranch
  const canRebase = Boolean(
    branch.current && branch.parent && parent && !branch.remote && !operationActive,
  )
  const stackWorkflow = !branch.remote && !isDefaultBranch

  return (
    <aside className="details-pane" id="branch-inspector" aria-label="Selected branch details">
      <div className="details-header">
        <div className="details-identity">
          <h2 title={branch.name}>{branch.name}</h2>
          <span className="details-status-row">
            {branch.current ? (
              <CurrentBadge />
            ) : (
              <Badge variant="secondary">{branch.remote ? 'Remote' : 'Local'}</Badge>
            )}
            {pullRequest ? (
              <Badge variant={prStateVariant(pullRequest)}>{prStateLabel(pullRequest)}</Badge>
            ) : null}
            {pullRequest ? (
              <Badge variant={checksVariant(pullRequest.checks)}>
                {checkLabel(pullRequest.checks)}
              </Badge>
            ) : null}
          </span>
        </div>
        <IconButton label="Clear branch selection" onClick={onClose}>
          <X aria-hidden="true" className="size-4" />
        </IconButton>
      </div>
      <div className="details-scroll">
        <InspectorSection title="Stack position">
          <div className="detail-grid">
            <span>Parent</span>
            <strong className={branch.parent && !parent ? 'detail-missing' : undefined}>
              {branch.parent ?? 'No parent'}
            </strong>
            <span>Provenance</span>
            <strong>{parentProvenanceLabel(branch)}</strong>
            <span>Last update</span>
            <strong>{formatBranchDate(branch.updatedAt)}</strong>
          </div>
          {restack ? (
            <div className="restack-notice">
              <strong>Requires restack</strong>
              <p>
                {branch.parentTip
                  ? 'The parent or recorded boundary changed. Preview a stack restack to update this branch and its descendants together.'
                  : `${branch.parent} has ${branch.parentBehind ?? 0} commits not in this branch. Preview a restack before publishing.`}
              </p>
            </div>
          ) : null}
        </InspectorSection>

        <InspectorSection title="Upstream">
          <div className="detail-grid">
            <span>Upstream</span>
            <strong>{branch.upstream ?? 'Not tracking'}</strong>
          </div>
          <div className="sync-stat-grid">
            <div>
              <ArrowUp aria-hidden="true" className="size-3.5" />
              <strong>{branch.ahead}</strong>
              <span>ahead</span>
            </div>
            <div>
              <ArrowDown aria-hidden="true" className="size-3.5" />
              <strong>{branch.behind}</strong>
              <span>behind</span>
            </div>
          </div>
        </InspectorSection>

        {pullRequest ? (
          <InspectorSection title="Pull request">
            <div className="pr-detail">
              <div className="pr-detail-heading">
                <GitPullRequest aria-hidden="true" className="size-4" />
                <strong>
                  #{pullRequest.number} {pullRequest.title}
                </strong>
              </div>
              <div className="pr-detail-meta">
                <span>
                  {pullRequest.head} → {pullRequest.base}
                </span>
              </div>
              <dl className="detail-grid">
                <dt>Checks</dt>
                <dd>{checkLabel(pullRequest.checks)}</dd>
                <dt>Review</dt>
                <dd>{reviewLabel(pullRequest)}</dd>
                <dt>Merge</dt>
                <dd>{mergeStateLabel(pullRequest)}</dd>
              </dl>
              <div className="pr-detail-actions">
                <Button
                  onClick={() => onOpenExternal(pullRequest.url)}
                  size="sm"
                  tooltip="Open this pull request in the browser. Read-only; no local or remote changes."
                  variant="secondary"
                >
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  Open on GitHub
                </Button>
                <Button
                  disabled={busy}
                  onClick={onManagePullRequest}
                  size="sm"
                  tooltip="Preview checks, reviews, and merge or close options for this pull request. Nothing changes until confirmed."
                  variant="accent"
                >
                  Manage pull request
                </Button>
              </div>
            </div>
          </InspectorSection>
        ) : (
          <InspectorSection title="Pull request">
            <p className="detail-muted">No pull request for this branch.</p>
            <Button
              disabled={!branch.current || !github.available || busy}
              onClick={onCreatePullRequest}
              size="sm"
              tooltip={
                !github.available
                  ? github.message ||
                    'Connect an authenticated GitHub repository to create pull requests.'
                  : !branch.current
                    ? 'Switch to this branch to open its pull request on GitHub.'
                    : 'Review creating a PR from this branch’s published upstream. Unpushed commits are not included.'
              }
              variant="secondary"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5" />
              Create pull request
            </Button>
            {!branch.current ? (
              <small className="detail-muted">
                Switch to this branch to create its pull request.
              </small>
            ) : !github.available ? (
              <small className="detail-muted">
                {github.message || 'GitHub CLI is unavailable.'}
              </small>
            ) : null}
          </InspectorSection>
        )}

        {stackWorkflow ? (
          <InspectorSection title="Stack workflow">
            <Button
              disabled={busy || operationActive}
              onClick={onRestack}
              tooltip="Preview rebasing this stack onto updated parents locally, branch by branch. Remotes stay unchanged until published."
              variant="accent"
            >
              <Layers aria-hidden="true" className="size-3.5" />
              Restack stack…
            </Button>
            <Button
              disabled={busy || operationActive || !github.available}
              onClick={onPublish}
              tooltip={
                !github.available
                  ? github.message ||
                    'Connect an authenticated GitHub repository to publish stacks.'
                  : 'Push reviewed stack tips and update their pull requests without rebasing. Requires a clean, restacked stack.'
              }
              variant="secondary"
            >
              <Upload aria-hidden="true" className="size-3.5" />
              Publish stack…
            </Button>
            <Button
              disabled={busy || operationActive}
              onClick={onSetParent}
              tooltip="Record a different local parent without rewriting commits. Preview Restack next to move this branch and descendants."
              variant="ghost"
            >
              Set stack parent…
            </Button>
            {pullRequest?.state === 'OPEN' ? (
              <Button
                disabled={busy || operationActive}
                onClick={onPreviewMerge}
                tooltip="Preview merging this open pull request into the default branch. Nothing merges until confirmed; remaining branches still need restack."
                variant="secondary"
              >
                <GitMerge aria-hidden="true" className="size-3.5" />
                Preview PR merge
              </Button>
            ) : null}
          </InspectorSection>
        ) : null}

        <InspectorSection title="Branch actions">
          <Button
            disabled={branch.current || busy || operationActive}
            onClick={onSwitch}
            tooltip={
              branch.current
                ? 'This is already the checked-out branch.'
                : 'Switch the working tree to this branch. Requires a clean tree; remotes create a local tracking copy.'
            }
            variant="accent"
          >
            <ArrowLeftRight aria-hidden="true" className="size-3.5" />
            Switch to this branch
          </Button>
          <Button
            disabled={!canRebase || busy}
            onClick={onRebaseOntoParent}
            tooltip="Rebase only the current branch onto its recorded parent locally. Rewrites its history; use Restack to move descendants together."
            variant="secondary"
          >
            <GitMerge aria-hidden="true" className="size-3.5" />
            Rebase current onto parent
          </Button>
          {!branch.current ? (
            <span className="action-hint">Switch to this branch before rebasing.</span>
          ) : branch.remote ? (
            <span className="action-hint">Remote branches cannot be rebased directly.</span>
          ) : !branch.parent ? (
            <span className="action-hint">This branch has no recorded parent.</span>
          ) : null}
          {!branch.remote ? (
            <>
              <Button
                disabled={busy || operationActive || isDefaultBranch}
                onClick={onRename}
                tooltip={
                  isDefaultBranch
                    ? 'The default branch cannot be renamed here.'
                    : 'Rename this local branch. Remote tracking and open pull requests may need updating.'
                }
                variant="secondary"
              >
                Rename local branch…
              </Button>
              <Button
                disabled={busy || operationActive}
                onClick={onSetUpstream}
                tooltip="Choose which remote branch this branch pushes to and pulls from. Local config only; no commits move."
                variant="secondary"
              >
                Set upstream…
              </Button>
            </>
          ) : null}
        </InspectorSection>

        {branch.remote || !branch.current ? (
          <InspectorSection title="Destructive" tone="danger">
            {!branch.remote ? (
              <>
                <Button
                  ref={deleteButtonRef}
                  disabled={branch.current || isDefaultBranch || busy || operationActive}
                  onClick={onDeleteLocal}
                  tooltip={
                    isDefaultBranch
                      ? 'The default branch cannot be deleted.'
                      : branch.current
                        ? 'Cannot delete the checked-out branch — switch away first. Remotes and pull requests are kept.'
                        : 'Delete this local branch. Remotes and pull requests are kept; unmerged work needs force and can orphan commits.'
                  }
                  variant="danger"
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                  Delete local branch
                </Button>
                {isDefaultBranch ? (
                  <span className="action-hint">The default branch cannot be deleted.</span>
                ) : branch.current ? (
                  <span className="action-hint">
                    Switch to another branch before deleting this one.
                  </span>
                ) : null}
              </>
            ) : null}
            {branch.remote ? (
              <Button
                disabled={
                  busy ||
                  operationActive ||
                  !branch.oid ||
                  branch.name.endsWith(`/${defaultBranch}`)
                }
                onClick={onDeleteRemote}
                tooltip="Preview removing this branch from its remote. Local copies remain; open PRs may close and collaborators must prune."
                variant="danger"
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
                Delete remote branch…
              </Button>
            ) : null}
          </InspectorSection>
        ) : null}
      </div>
    </aside>
  )
}
