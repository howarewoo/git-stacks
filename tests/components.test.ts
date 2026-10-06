import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, IconButton } from '../src/renderer/src/components/ui/button'
import { Checkbox } from '../src/renderer/src/components/ui/checkbox'
import { Field } from '../src/renderer/src/components/ui/field'
import { Input } from '../src/renderer/src/components/ui/input'
import { Textarea } from '../src/renderer/src/components/ui/textarea'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { ShellSpecimen } from '../src/renderer/src/design-system/ShellSpecimen'
import {
  ImmutableApproval,
  MergeOutcomePanel,
} from '../src/renderer/src/components/workflow-composition'
import type { MergeProgress } from '../src/shared/types'
import {
  liveGuardBase,
  publishPreview as specimenPublishPreview,
} from '../src/renderer/src/design-system/DialogSpecimenData'
import { workflowAction } from '../src/renderer/src/components/workflow-action'
import { workflowBlocker } from '../src/renderer/src/components/workflow-policy'

test('loading buttons retain their label, busy state, and disabled lock', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      Button,
      { loading: true },
      React.createElement('span', null, 'Save branch'),
    ),
  )

  assert.match(markup, /Save branch/)
  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /disabled/)
})

test('icon-only actions expose an accessible name and disabled reason remains focusable', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(IconButton, { label: 'Refresh preview', disabled: true }, '↻'),
    ),
  )

  assert.match(markup, /aria-label="Refresh preview"/)
  assert.match(markup, /tabindex="0"/)
  assert.match(markup, /Refresh preview/)
})

test('fields associate labels, required state, helper text, and errors', () => {
  const markup = renderToStaticMarkup(
    React.createElement(Field, {
      id: 'branch-name',
      label: 'Branch name',
      description: 'Use a short feature name.',
      error: 'A branch name is required.',
      required: true,
      children: React.createElement(Input),
    }),
  )

  assert.match(markup, /<label[^>]+for="branch-name"/)
  assert.match(markup, /id="branch-name"/)
  assert.match(markup, /required/)
  assert.match(markup, /aria-invalid="true"/)
  assert.match(markup, /branch-name-description/)
  assert.match(markup, /branch-name-error/)
})

test('field errors remain visible on textarea and checkbox controls', () => {
  const textarea = renderToStaticMarkup(
    React.createElement(Field, {
      id: 'description',
      label: 'Description',
      error: 'A description is required.',
      children: React.createElement(Textarea),
    }),
  )
  const checkbox = renderToStaticMarkup(
    React.createElement(Field, {
      id: 'include-files',
      label: 'Include files',
      error: 'Choose whether to include files.',
      children: React.createElement(Checkbox),
    }),
  )

  assert.match(textarea, /aria-invalid="true"/)
  assert.match(checkbox, /aria-invalid="true"/)
})

test('shell specimen captions are not rendered as labels without controls', () => {
  const markup = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(ShellSpecimen)),
  )

  assert.match(markup, /<label for="shell-fixture-draft">In-progress commit message<\/label>/)
  assert.match(markup, /id="shell-fixture-draft"/)
  assert.doesNotMatch(markup, /for="shell-fixture-search-result"/)
})

test('a recovered submission shows its saved consent as fixed text, not an unchecked box', () => {
  const granted = renderToStaticMarkup(
    React.createElement(ImmutableApproval, {
      label: 'Saved approval for rewritten branches',
      summary: 'Recorded: branches with a rewritten history are pushed with exact leases.',
    }),
  )
  assert.match(granted, /Saved approval for rewritten branches/)
  assert.match(granted, /exact leases/)
  // No control is offered, so the person cannot read the value as something they can change.
  assert.doesNotMatch(granted, /type="checkbox"/u)

  const withheld = renderToStaticMarkup(
    React.createElement(ImmutableApproval, {
      label: 'Saved approval for rewritten branches',
      summary: 'Not given: no branch is pushed by replacing remote history.',
    }),
  )
  assert.match(withheld, /Not given/u)
  assert.doesNotMatch(withheld, /Recorded:/u)
})

test('the guarded publish specimen is ready only when the builder produces a submission', () => {
  const context = {
    headOid: '1111111111111111111111111111111111111111',
    currentBranch: 'feature/checkout',
  }
  const layers = {
    'feature/checkout': {
      title: 'Checkout validation',
      body: 'Fixture layer for the guarded publish specimen.',
      draft: true,
      updateBase: false,
    },
  }
  // What the specimen shows when the name has not been typed.
  const beforeName = workflowBlocker({
    ...liveGuardBase,
    kind: 'stack',
    allowForce: true,
    requiresLeaseApproval: false,
    name: '',
    requiresName: false,
    previewToken: `stack:${specimenPublishPreview.token}`,
    confirmationTarget: 'feature/checkout',
    confirmation: '',
    untitledBranches: [],
  })
  assert.equal(beforeName?.code, 'confirmation-incomplete')

  // With the exact name the real builder produces the real submission, so ready is truthful.
  const action = workflowAction(
    {
      kind: 'submit',
      preview: specimenPublishPreview,
      allowForce: true,
      confirmation: 'feature/checkout',
      confirmationTarget: 'feature/checkout',
      layers,
    },
    context,
  )
  assert.deepEqual(action, {
    type: 'submitStack',
    token: specimenPublishPreview.token,
    allowForce: true,
    layers,
  })

  // A specimen preview with no offer cannot dispatch anything, so it must not read as ready.
  const noOffer = workflowAction(
    {
      kind: 'submit',
      preview: { ...specimenPublishPreview, publish: null },
      allowForce: true,
      confirmation: 'feature/checkout',
      confirmationTarget: 'feature/checkout',
      layers,
    },
    context,
  )
  assert.equal(noOffer, null)
})

test('merge outcome text distinguishes retained queue membership from a fresh read', () => {
  for (const membership of ['queued', 'not-queued'] as const) {
    const progress: MergeProgress = {
      action: 'merge_queue',
      status: 'queued',
      message: 'Queue membership read.',
      layers: [
        {
          branch: 'feature/checkout',
          pullRequest: 42,
          status: membership === 'queued' ? 'enqueued' : 'not-merged',
          detail: 'Queue membership detail.',
          mergedOid: null,
          requestUuid: null,
          queue: {
            configured: true,
            outcome: membership === 'queued' ? 'queued' : 'dropped',
            requestedAt: '2026-10-03T00:00:00Z',
            membership,
            entry: null,
            stale: false,
          },
        },
      ],
    }
    const fresh = renderToStaticMarkup(React.createElement(MergeOutcomePanel, { progress }))
    assert.doesNotMatch(fresh, /last confirmed queue state/u)
    if (membership === 'queued') assert.match(fresh, /The queue holds this pull request/u)
    else assert.match(fresh, /No local branch was changed for this pull request/u)

    progress.layers[0].queue!.stale = true
    const stale = renderToStaticMarkup(React.createElement(MergeOutcomePanel, { progress }))
    assert.match(stale, /GitHub could not be read just now.*last confirmed queue state/u)
    assert.doesNotMatch(stale, /The queue holds this pull request/u)
    assert.match(stale, /Refresh to read the queue again/u)
  }
})
