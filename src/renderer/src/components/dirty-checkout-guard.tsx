import * as React from 'react'
import { AlertCircle, Archive, Files } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { OperationContext, WorkflowActions, WorkflowFrame } from './workflow-composition'
import type { RepositorySnapshot } from '../../../shared/types'

export interface DirtyCheckoutGuardProps {
  target: { ref: string; name: string } | null
  snapshot: RepositorySnapshot | null
  onClose: () => void
  onStash: () => void
  onReviewChanges: () => void
}

export function DirtyCheckoutContent({
  target,
  snapshot,
  onClose,
  onStash,
  onReviewChanges,
}: DirtyCheckoutGuardProps) {
  const stagedCount =
    snapshot?.files.filter((f) => f.index !== '' && f.index !== ' ' && f.index !== '?').length ?? 0
  const totalCount = snapshot?.files.length ?? 0

  return (
    <WorkflowFrame composition="reviewed">
      <OperationContext
        title={`Check out ${target?.name ?? 'branch'}`}
        description="Git refuses to switch branches with uncommitted edits. Route through an existing safeguard below before checking out."
        facts={[
          { label: 'Target branch', value: target?.name ?? '—' },
          {
            label: 'Modified files',
            value: `${totalCount} file${totalCount === 1 ? '' : 's'} (${stagedCount} staged)`,
          },
          {
            label: 'Current branch',
            value: snapshot?.currentBranch ?? 'HEAD',
            code: true,
          },
        ]}
      />

      <div className="rounded-[var(--gs-semantic-radius-control)] border border-[var(--gs-semantic-border-essential)] bg-[var(--gs-semantic-surface-inset)] p-3 text-[13px] text-[var(--gs-semantic-text-secondary)]">
        <div className="flex items-start gap-2">
          <AlertCircle
            className="size-4 shrink-0 text-[var(--gs-semantic-feedback-warning-text)]"
            aria-hidden="true"
          />
          <span>
            You can stash your changes to restore a clean tree, review and commit them in Working
            changes, or cancel this checkout request.
          </span>
        </div>
      </div>

      <WorkflowActions>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            onClose()
            onReviewChanges()
          }}
          tooltip="Navigate to the Working changes view to stage, commit, or discard files"
        >
          <Files className="size-3.5 mr-1" aria-hidden="true" />
          Review changes
        </Button>
        <Button
          variant="accent"
          onClick={() => {
            onClose()
            onStash()
          }}
          tooltip="Open the Stash workflow to shelve changes and return to a clean tree"
        >
          <Archive className="size-3.5 mr-1" aria-hidden="true" />
          Stash changes…
        </Button>
      </WorkflowActions>
    </WorkflowFrame>
  )
}

export function DirtyCheckoutGuard(props: DirtyCheckoutGuardProps) {
  return (
    <Dialog open={props.target !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="workflow-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>Uncommitted changes in working tree</DialogTitle>
          <DialogDescription>
            Switching to <strong>{props.target?.name}</strong> requires a clean working tree. Choose
            how to handle your current changes.
          </DialogDescription>
        </DialogHeader>
        <DirtyCheckoutContent {...props} />
      </DialogContent>
    </Dialog>
  )
}
