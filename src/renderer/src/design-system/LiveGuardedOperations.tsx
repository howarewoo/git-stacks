import * as React from 'react'
import { Button } from '../components/ui/button'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Checkbox } from '../components/ui/checkbox'
import {
  TypedConfirmation,
  WarningNote,
  WorkflowActions,
  WorkflowFrame,
} from '../components/workflow-composition'
import { workflowBlocker } from '../components/workflow-policy'
import { workflowAction } from '../components/workflow-action'
import { guardedBranch, liveGuardBase, publishPreview } from './DialogSpecimenData'

/**
 * The three reviewed operations, wired to the real guard and the real action
 * builder. Each card's submit is disabled by the same blocker the dialog uses,
 * and pressing it shows the Git action that would be dispatched, so the state a
 * person sees and the action that would run cannot drift apart.
 */
export function LiveGuardedOperations() {
  const [forceName, setForceName] = React.useState('')
  const [deleteName, setDeleteName] = React.useState('')
  const [ref, setRef] = React.useState('')
  const [ran, setRan] = React.useState<string | null>(null)

  const forceBlocker = workflowBlocker({
    ...liveGuardBase,
    kind: 'stack',
    allowForce: true,
    requiresLeaseApproval: false,
    name: '',
    requiresName: false,
    previewToken: `stack:${publishPreview.token}`,
    confirmationTarget: guardedBranch.name,
    confirmation: forceName,
    untitledBranches: [],
  })
  const deleteBlocker = workflowBlocker({
    ...liveGuardBase,
    kind: 'deleteRemote',
    allowForce: false,
    requiresLeaseApproval: false,
    name: '',
    requiresName: false,
    previewToken: null,
    confirmationTarget: guardedBranch.name,
    confirmation: deleteName,
  })
  const mergeBlocker = workflowBlocker({
    ...liveGuardBase,
    kind: 'merge',
    allowForce: false,
    requiresLeaseApproval: false,
    requiresName: true,
    name: ref,
    previewToken: null,
    confirmationTarget: null,
    confirmation: '',
  })

  // The HEAD captured when the dialog opened, exactly as the real dialog passes it.
  const captured = {
    headOid: guardedBranch.oid ?? null,
    currentBranch: guardedBranch.name,
  } as const

  const show = (input: Parameters<typeof workflowAction>[0]) =>
    setRan(JSON.stringify(workflowAction(input, captured)))

  // Ready means the real builder produces the real submission, not only that the guard
  // finds no reason to stop. A button that reads ready while the builder returns null is a
  // false confirmation: the person presses it and nothing is dispatched.
  const publishInput = {
    kind: 'submit' as const,
    preview: publishPreview,
    allowForce: true,
    confirmation: forceName,
    confirmationTarget: guardedBranch.name,
    layers: {
      [guardedBranch.name]: {
        title: 'Checkout validation',
        body: 'Fixture layer for the guarded publish specimen.',
        draft: true,
        updateBase: false,
      },
    },
  }
  const publishBlocker =
    forceBlocker ??
    (workflowAction(publishInput, captured)
      ? null
      : { code: 'no-action', message: 'These inputs produce no submission.' })
  return (
    <div className="specimen-grid">
      <section className="specimen-dialog" data-operation="publish">
        <header>
          <strong>Publish stack · forced</strong>
          <span>Replacing remote history always needs the exact branch name.</span>
        </header>
        <WorkflowFrame composition="reviewed">
          <WarningNote>
            Commits present only on the remote can become unreachable. A newer push by someone else
            is rejected rather than overwritten.
          </WarningNote>
          <TypedConfirmation
            id="live-force-name"
            label={`Type ${guardedBranch.name} to confirm`}
            value={forceName}
            onChange={setForceName}
            target={guardedBranch.name}
          />
          <WorkflowActions>
            <Button
              variant="accent"
              disabled={Boolean(publishBlocker)}
              tooltip={publishBlocker?.message ?? 'Publish every branch, replacing remote history.'}
              onClick={() => show(publishInput)}
            >
              Publish stack
            </Button>
          </WorkflowActions>
          <p className="specimen-banner-note" data-role="blocker">
            {publishBlocker ? publishBlocker.code : 'ready'}
          </p>
        </WorkflowFrame>
      </section>

      <section className="specimen-dialog" data-operation="delete-remote">
        <header>
          <strong>Delete remote branch</strong>
          <span>
            No preview exists for a local delete; the captured tip and the name are the guard.
          </span>
        </header>
        <WorkflowFrame composition="destructive">
          <TypedConfirmation
            id="live-delete-name"
            label={`Type ${guardedBranch.name} to confirm`}
            value={deleteName}
            onChange={setDeleteName}
            target={guardedBranch.name}
          />
          <WorkflowActions>
            <Button
              variant="danger"
              disabled={Boolean(deleteBlocker)}
              tooltip={deleteBlocker?.message ?? 'Delete the remote branch and its pull request.'}
              onClick={() =>
                show({ kind: 'deleteRemote', branch: guardedBranch, confirmation: deleteName })
              }
            >
              Delete remote branch
            </Button>
          </WorkflowActions>
          <p className="specimen-banner-note" data-role="blocker">
            {deleteBlocker ? deleteBlocker.code : 'ready'}
          </p>
        </WorkflowFrame>
      </section>

      <section className="specimen-dialog" data-operation="merge">
        <header>
          <strong>Merge into current branch</strong>
          <span>The selected ref becomes the merge action, guarded by the captured HEAD.</span>
        </header>
        <WorkflowFrame composition="form">
          <Field id="live-merge-ref" label="Branch to merge">
            <Select
              id="live-merge-ref"
              value={ref}
              onChange={(event) => setRef(event.target.value)}
            >
              <option value="">Choose a branch</option>
              <option value="main">main</option>
              <option value="release/1.x">release/1.x</option>
            </Select>
          </Field>
          <Checkbox id="live-merge-commit" label="Create a merge commit" />
          <WorkflowActions>
            <Button
              variant="accent"
              disabled={Boolean(mergeBlocker)}
              tooltip={
                mergeBlocker?.message ?? 'Merge the selected branch into the current branch.'
              }
              onClick={() => show({ kind: 'merge', ref })}
            >
              Merge into current branch
            </Button>
          </WorkflowActions>
          <p className="specimen-banner-note" data-role="blocker">
            {mergeBlocker ? mergeBlocker.code : 'ready'}
          </p>
        </WorkflowFrame>
      </section>

      {ran ? (
        <section className="specimen-dialog" data-operation="dispatched">
          <header>
            <strong>Dispatched action</strong>
            <span>What the builder returned for the last press.</span>
          </header>
          <p className="specimen-banner-note" data-role="dispatched">
            {ran}
          </p>
        </section>
      ) : null}
    </div>
  )
}
