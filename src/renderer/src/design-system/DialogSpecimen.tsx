import * as React from 'react'
import { GitBranch, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Textarea } from '../components/ui/textarea'
import { InlineAlert } from '../components/ui/surface'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import {
  BlockerList,
  OperationContext,
  OperationSteps,
  PhaseStatus,
  TypedConfirmation,
  WarningNote,
  WorkflowActions,
  WorkflowFrame,
} from '../components/workflow-composition'
import {
  closeIntent,
  partialProgress,
  workflowPhase,
  type WorkflowPhase,
} from '../components/workflow-policy'
import {
  blockedRestackPreview,
  completedRestackProgress,
  leasePreview,
  pausedRestackProgress,
  publishPreview,
  restackPreview,
  unstartedRestackProgress,
} from './DialogSpecimenData'

function DialogFrame({
  composition,
  title,
  description,
  status,
  children,
}: {
  composition: 'form' | 'reviewed' | 'destructive'
  title: string
  description: string
  status?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="specimen-dialog">
      <header>
        <strong>{title}</strong>
        <span>{description}</span>
      </header>
      <WorkflowFrame composition={composition} wide={composition === 'reviewed'}>
        {status}
        {children}
      </WorkflowFrame>
    </section>
  )
}

function RecoveryRow({
  label,
  phase,
  message,
  continueDisabled,
  children,
}: {
  label: string
  phase: WorkflowPhase
  message: string
  continueDisabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <section className="specimen-banner">
      <PhaseStatus phase={phase} title={label} message={message} />
      <WorkflowActions>
        <Button size="sm" variant="secondary">
          View changes
        </Button>
        <Button
          size="sm"
          variant="accent"
          disabled={continueDisabled}
          tooltip={
            continueDisabled
              ? 'Blocked until every conflicted file is resolved and staged.'
              : undefined
          }
        >
          Continue
        </Button>
        <Button size="sm" variant="secondary">
          Abort…
        </Button>
        {children}
      </WorkflowActions>
      <p className="specimen-banner-note">{label}</p>
    </section>
  )
}

/**
 * The live dialog. It is the real primitive, so focus containment, Escape,
 * and focus restoration are exercised here exactly as a user meets them.
 */
function LiveDialog() {
  const [open, setOpen] = React.useState(false)
  const [stale] = React.useState(false)
  return (
    <div className="specimen-live">
      <Button variant="accent" onClick={() => setOpen(true)}>
        Open the restack dialog
      </Button>
      <p className="specimen-banner-note">
        Tab moves through the dialog only; Escape closes it and focus returns here.
      </p>
      <Dialog open={open} onOpenChange={(next) => (stale ? undefined : setOpen(next))}>
        <DialogContent className="gs-workflow-frame" data-composition="reviewed">
          <DialogHeader>
            <DialogTitle>Restack stack</DialogTitle>
            <DialogDescription>
              Rebase these branches onto the recorded boundary of main.
            </DialogDescription>
          </DialogHeader>
          <OperationContext
            title="What this changes"
            description="Rebase parent-first using each branch's recorded boundary."
            facts={[
              { label: 'Repository', value: 'git-stacks' },
              { label: 'HEAD', value: 'feature/checkout' },
            ]}
          />
          <OperationSteps steps={restackPreview.steps} label="Planned stack operations" />
          <WorkflowActions>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="accent"
              disabled
              tooltip="The reviewed preview was rejected. Reload it to continue."
            >
              Restack stack
            </Button>
          </WorkflowActions>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { LiveGuardedOperations } from './LiveGuardedOperations'

export function DialogSpecimen() {
  return (
    <div className="specimen-page">
      <header className="specimen-header">
        <GitBranch aria-hidden="true" className="size-4" />
        <strong>Workflow dialogs · operation feedback · recovery</strong>
        <span>
          Three compositions — ordinary form, reviewed operation, destructive confirmation — and the
          shared state model, rendered with fixture data.
        </span>
      </header>

      <div className="specimen-grid">
        <DialogFrame
          composition="form"
          title="Create a branch"
          description="Ordinary form. Focus starts on the first field; the primary action is the only filled role."
        >
          <Field
            id="specimen-branch-name"
            label="Branch name"
            required
            description="Local only. Nothing is pushed and no commit is created."
          >
            <Input defaultValue="feature/checkout" />
          </Field>
          <Field id="specimen-branch-parent" label="Parent branch" required>
            <Select defaultValue="main">
              <option value="main">main</option>
              <option value="feature/checkout">feature/checkout</option>
            </Select>
          </Field>
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="accent"
              tooltip="Create the local branch, record its stack parent, and switch to it. Nothing is pushed."
            >
              Create branch
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="reviewed"
          title="Restack stack"
          description="Reviewed operation. Source, target, per-branch steps, and the captured preview identity are all visible."
        >
          <OperationContext
            title="feature/checkout"
            description="Rebase parent-first using each branch’s recorded boundary. Conflicts pause the stack; your original checkout is restored on completion."
            facts={[
              { label: 'Preview identity', value: `stack:${restackPreview.token}`, code: true },
              { label: 'Scope', value: 'Local branches only · remotes unchanged' },
            ]}
          />
          <OperationSteps steps={restackPreview.steps} label="Planned stack operations" />
          {restackPreview.warnings.map((warning) => (
            <WarningNote key={warning}>{warning}</WarningNote>
          ))}
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button variant="accent">Restack stack</Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="reviewed"
          title="Publish stack"
          description="Publish stays separate from Restack. Every branch without a pull request needs a title before it can run."
          status={
            <PhaseStatus
              phase="blocked"
              message="Every branch without an existing pull request needs a title before publishing."
            />
          }
        >
          <OperationSteps steps={publishPreview.steps} label="Planned stack operations" />
          <Field
            id="specimen-title-feature-checkout"
            label="PR title for feature/checkout"
            required
          >
            <Input defaultValue="Add checkout validation" />
          </Field>
          <Field
            id="specimen-title-feature-checkout-tests"
            label="PR title for feature/checkout-tests"
            required
          >
            <Input placeholder="Cover checkout validation" />
          </Field>
          <Checkbox id="specimen-drafts" label="Create new PRs as drafts" defaultChecked />
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="accent"
              disabled
              tooltip="Every branch without an existing pull request needs a title before publishing."
            >
              Publish stack
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="reviewed"
          title="Restack stack · blocked"
          description="A blocked preview is visibly different from a ready one, and the action explains why it is unavailable."
          status={
            <PhaseStatus
              phase="blocked"
              message="The preview reports blockers. Resolve each one, then reload the preview."
            />
          }
        >
          <BlockerList items={blockedRestackPreview.blockers} />
          <OperationSteps steps={blockedRestackPreview.steps} label="Planned stack operations" />
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="accent"
              disabled
              tooltip="The preview reports blockers. Resolve each one, then reload the preview."
            >
              Reload preview
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="destructive"
          title="Force push with lease"
          description="Destructive confirmation. Focus starts on Cancel and the exact branch name must be typed."
        >
          <OperationContext
            title={`Replace ${leasePreview.remote}/${leasePreview.destination.replace(/^refs\/heads\//, '')}`}
            description="Replace remote history only if its tip still matches this preview. Someone else’s newer push will be rejected."
            facts={[
              { label: 'Destination', value: 'origin/feature/checkout', code: true },
              {
                label: 'Expected remote tip',
                value: leasePreview.remoteOid?.slice(0, 12) ?? '—',
                code: true,
              },
              { label: 'Local tip', value: leasePreview.localOid.slice(0, 12), code: true },
            ]}
          />
          <WarningNote>Commits present only on the remote can become unreachable.</WarningNote>
          <TypedConfirmation
            id="specimen-lease"
            value="feature/check"
            target="feature/checkout"
            onChange={() => undefined}
          />
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="danger"
              disabled
              tooltip="Type the exact name shown above to enable this action. Nothing runs until it matches."
            >
              Force push with lease
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="destructive"
          title="Delete remote branch"
          description="The action names its target, states the real remote tip, and keeps the loss of work explicit."
        >
          <OperationContext
            title="main"
            description="Delete this branch from its remote repository. Open PRs may close. Local branches and child relationships are not changed. A changed remote tip stops deletion."
            facts={[
              { label: 'Remote ref', value: 'refs/heads/main', code: true },
              { label: 'Expected remote tip', value: '111111111111', code: true },
            ]}
          />
          <WarningNote>
            Remote-only commits may become unreachable. This cannot be undone from the app.
          </WarningNote>
          <TypedConfirmation
            id="specimen-delete"
            value="main"
            target="main"
            onChange={() => undefined}
          />
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button variant="danger">
              <Trash2 aria-hidden="true" className="size-3.5" />
              Delete remote branch
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="reviewed"
          title="Stale preview · rejected"
          description="A preview that already failed cannot run again; only an explicit reload issues a new identity."
          status={
            <PhaseStatus
              phase="stale"
              message="This preview was already rejected. Reload it to read the current state; the rejected preview will not run again."
            />
          }
        >
          <OperationContext
            facts={[
              { label: 'Rejected identity', value: 'stack:preview-restack-1', code: true },
              { label: 'Replacement', value: 'Reload preview issues a new token', code: false },
            ]}
          />
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="secondary"
              tooltip="Read the latest repository and GitHub state to replace this preview. No Git changes are made."
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Reload preview
            </Button>
            <Button
              variant="accent"
              disabled
              tooltip="This preview was already rejected. Reload the preview to review the current state before retrying."
            >
              Restack stack
            </Button>
          </WorkflowActions>
        </DialogFrame>

        <DialogFrame
          composition="form"
          title="Create pull request · GitHub unavailable"
          description="Unavailable integration information is never presented as empty or successful."
          status={
            <PhaseStatus
              phase="blocked"
              message="GitHub CLI is not authenticated for this repository, so pull requests cannot be created or listed here."
            />
          }
        >
          <OperationContext
            title="feature/checkout-tests → feature/checkout"
            description="The pull request is created against this branch’s published upstream. Newer local commits are not pushed."
            facts={[{ label: 'Upstream', value: 'No upstream configured', code: true }]}
          />
          <Field id="specimen-pr-title" label="Title" required>
            <Input placeholder="What does this stack change?" />
          </Field>
          <Field id="specimen-pr-body" label="Description (optional)">
            <Textarea rows={3} placeholder="Add context for reviewers" />
          </Field>
          <WorkflowActions>
            <Button variant="secondary">Cancel</Button>
            <Button
              variant="accent"
              disabled
              tooltip="GitHub CLI is not authenticated for this repository, so pull requests cannot be created or listed here."
            >
              Create pull request
            </Button>
          </WorkflowActions>
        </DialogFrame>
      </div>

      <section className="specimen-live-section">
        <h2 className="specimen-heading">The live dialogs</h2>
        <LiveDialog />
      </section>

      <h2 className="specimen-heading">Reviewed operations wired to the real guard</h2>
      <LiveGuardedOperations />

      <h2 className="specimen-heading">Persistent operation feedback and recovery</h2>

      <div className="specimen-recovery">
        <RecoveryRow
          label="Active rebase · unresolved conflict"
          phase={workflowPhase({
            loading: false,
            busy: false,
            failed: false,
            stale: false,
            finished: false,
            partial: false,
            blocked: true,
          })}
          message="Rebase need attention — 1 conflicted file. Resolve and stage each file before continuing."
          continueDisabled
        />
        <RecoveryRow
          label="Paused restack · partial progress from a real snapshot"
          phase={workflowPhase({
            loading: false,
            busy: false,
            failed: false,
            stale: false,
            finished: false,
            partial: true,
            blocked: true,
          })}
          message={`${partialProgress(pausedRestackProgress).summary}. ${pausedRestackProgress.message}`}
          continueDisabled
        />
        <RecoveryRow
          label="Unstarted restack · no progress reported"
          phase={workflowPhase({
            loading: false,
            busy: false,
            failed: false,
            stale: false,
            finished: false,
            partial: false,
            blocked: false,
          })}
          message={`${partialProgress(unstartedRestackProgress).summary}. ${unstartedRestackProgress.message}`}
        />
        <RecoveryRow
          label="Completed restack · every step applied"
          phase={workflowPhase({
            loading: false,
            busy: false,
            failed: false,
            stale: false,
            finished: true,
            partial: false,
            blocked: false,
          })}
          message={`${partialProgress(completedRestackProgress).summary}. ${completedRestackProgress.message}`}
        />
        <RecoveryRow
          label="Interrupted recovery · app cannot drive this operation"
          phase={workflowPhase({
            loading: false,
            busy: false,
            failed: true,
            stale: false,
            finished: false,
            partial: false,
            blocked: true,
          })}
          message="Aborting the rebase discarded the in-progress resolutions. The saved pre-operation tips were restored."
        />
        <InlineAlert tone="error" title="Rebase failed: conflict in src/checkout.ts">
          Nothing was applied. Your entered text and the reviewed preview are kept — reload the
          preview to read the current state before trying again.
        </InlineAlert>
      </div>
    </div>
  )
}
