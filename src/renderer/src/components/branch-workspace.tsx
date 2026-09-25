import * as React from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Circle,
  Cloud,
  GitBranch,
  ShieldCheck,
} from 'lucide-react'
import type { Branch, PullRequest } from '../../../shared/types'
import { Badge } from './ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { BranchHoverCard, PullRequestHoverCard } from './repository-hover-cards'
import { cn } from '../lib/utils'
import {
  branchRowLabel,
  describeBranchAncestry,
  formatBranchDate,
  indexVisibleParentNames,
  requiresRestack,
  type BranchTreeRow,
} from '../lib/branch-workspace'
import {
  checkLabel,
  checksVariant,
  prStateLabel,
  prStateVariant,
  reviewLabel,
} from '../lib/pull-request-state'

/** Checked-out state is its own role and never borrows the selection surface. */
export function CurrentBadge() {
  return (
    <Badge className="branch-current-badge" variant="info">
      <Circle aria-hidden="true" className="size-2 fill-current" />
      Current
    </Badge>
  )
}

function BranchStatusGroup({
  pullRequest,
  restack,
}: {
  pullRequest: PullRequest | null
  restack: boolean
}) {
  if (!pullRequest && !restack) return null
  return (
    <span className="branch-status-group">
      {pullRequest ? (
        <Badge variant={prStateVariant(pullRequest)}>{prStateLabel(pullRequest)}</Badge>
      ) : null}
      {pullRequest ? (
        <Badge variant={checksVariant(pullRequest.checks)}>
          <ShieldCheck aria-hidden="true" className="size-3" />
          {checkLabel(pullRequest.checks)}
        </Badge>
      ) : null}
      {pullRequest?.reviewDecision ? (
        <span className="branch-review">{reviewLabel(pullRequest)}</span>
      ) : null}
      {restack ? <Badge variant="warning">Requires restack</Badge> : null}
    </span>
  )
}

export function BranchRow({
  branch,
  tree,
  selected,
  ancestryId,
  ancestry,
  onSelect,
  onOpenPullRequest,
}: {
  branch: Branch
  tree: BranchTreeRow
  selected: boolean
  ancestryId: string
  ancestry: string
  onSelect: (ref: string) => void
  onOpenPullRequest: (pullRequest: PullRequest) => void
}) {
  const restack = requiresRestack(branch)
  const pullRequest = branch.pr
  const states = [
    branch.current ? 'current' : null,
    selected ? 'selected' : null,
    tree.cycle ? 'cycle' : null,
    tree.missingParent ? 'missing-parent' : null,
  ].filter(Boolean)

  return (
    <div
      className={cn(
        'branch-row',
        selected && 'branch-row-selected',
        branch.current && 'branch-row-current',
      )}
      data-ref={branch.ref}
      data-state={states.length ? states.join(' ') : undefined}
      role="listitem"
      style={{ '--branch-depth': tree.depth } as React.CSSProperties}
    >
      <BranchHoverCard branch={branch}>
        <button
          aria-current={selected ? 'true' : undefined}
          aria-describedby={ancestryId}
          aria-label={branchRowLabel(branch, tree, ancestry)}
          className="branch-select"
          onClick={() => onSelect(branch.ref)}
          type="button"
        />
      </BranchHoverCard>
      {tree.trunks.map((trunk, segmentIndex) => (
        <span
          aria-hidden="true"
          className={cn('branch-tree-trunk', `branch-tree-trunk-${trunk.kind}`)}
          key={`trunk-${segmentIndex}`}
          style={{ '--branch-lane': trunk.lane } as React.CSSProperties}
        />
      ))}
      {tree.elbows.map((elbow, segmentIndex) => (
        <span
          aria-hidden="true"
          className="branch-tree-elbow"
          key={`elbow-${segmentIndex}`}
          style={{ '--branch-lane': elbow.lane } as React.CSSProperties}
        />
      ))}
      <span className={cn('branch-node', branch.current && 'branch-node-current')}>
        {branch.remote ? (
          <Cloud aria-hidden="true" className="size-3.5" />
        ) : (
          <GitBranch aria-hidden="true" className="size-3.5" />
        )}
      </span>
      <span className="branch-copy">
        <span className="branch-name-line">
          <strong>{branch.name}</strong>
          {branch.current ? <CurrentBadge /> : null}
          {branch.remote ? <Badge variant="outline">remote</Badge> : null}
          {tree.cycle ? <Badge variant="warning">parent cycle</Badge> : null}
          {tree.missingParent ? <Badge variant="warning">parent missing</Badge> : null}
        </span>
        <span className="branch-summary">
          {pullRequest ? (
            <PullRequestHoverCard pr={pullRequest}>
              <a
                aria-label={`Open pull request #${pullRequest.number} on GitHub`}
                className="branch-pr-link"
                href={pullRequest.url}
                onClick={(event) => {
                  event.preventDefault()
                  onOpenPullRequest(pullRequest)
                }}
              >
                #{pullRequest.number}
              </a>
            </PullRequestHoverCard>
          ) : null}
          <span className="branch-subject">{branch.subject || 'No commit subject'}</span>
        </span>
        <span className="branch-ancestry" id={ancestryId}>
          {ancestry}
        </span>
      </span>
      <BranchStatusGroup pullRequest={pullRequest} restack={restack} />
      <span className="branch-metrics">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={
                branch.upstream
                  ? `${branch.ahead} ahead, ${branch.behind} behind ${branch.upstream}`
                  : 'No upstream configured'
              }
              className="ahead-behind"
              tabIndex={0}
            >
              <span className={branch.ahead > 0 ? 'metric-positive' : 'metric-muted'}>
                <ArrowUp aria-hidden="true" className="size-3" />
                {branch.ahead}
              </span>
              <span className={branch.behind > 0 ? 'metric-negative' : 'metric-muted'}>
                <ArrowDown aria-hidden="true" className="size-3" />
                {branch.behind}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {branch.upstream
              ? `${branch.ahead} commits ahead and ${branch.behind} behind ${branch.upstream}`
              : 'Set an upstream to compare this branch with its remote.'}
          </TooltipContent>
        </Tooltip>
        <span className="branch-updated">{formatBranchDate(branch.updatedAt)}</span>
      </span>
      <ChevronRight aria-hidden="true" className="branch-chevron size-4" />
    </div>
  )
}

export function BranchTree({
  branches,
  rows,
  selectedRef,
  onSelect,
  onOpenPullRequest,
}: {
  branches: readonly Branch[]
  rows: readonly BranchTreeRow[]
  selectedRef: string | null
  onSelect: (ref: string) => void
  onOpenPullRequest: (pullRequest: PullRequest) => void
}) {
  const visibleParentNames = indexVisibleParentNames(branches)
  return (
    <div className="branch-list" role="list" aria-label="Repository branches">
      {branches.map((branch, index) => {
        const tree = rows[index]
        const ancestryId = `branch-ancestry-${encodeURIComponent(branch.ref)}`
        return (
          <BranchRow
            ancestry={describeBranchAncestry(branch, tree, visibleParentNames)}
            ancestryId={ancestryId}
            branch={branch}
            key={branch.ref}
            onOpenPullRequest={onOpenPullRequest}
            onSelect={onSelect}
            selected={branch.ref === selectedRef}
            tree={tree}
          />
        )
      })}
    </div>
  )
}
