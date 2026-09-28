import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, IconButton } from '../src/renderer/src/components/ui/button'
import { Checkbox } from '../src/renderer/src/components/ui/checkbox'
import { Field } from '../src/renderer/src/components/ui/field'
import { Input } from '../src/renderer/src/components/ui/input'
import { SegmentedControl } from '../src/renderer/src/components/ui/segmented-control'
import { Textarea } from '../src/renderer/src/components/ui/textarea'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { ShellSpecimen } from '../src/renderer/src/design-system/ShellSpecimen'
import { ImmutableApproval } from '../src/renderer/src/components/workflow-composition'
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
  assert.match(
    textarea,
    /aria-\[invalid=true\]:border-\[var\(--gs-semantic-feedback-error-text\)\]/,
  )
  assert.match(checkbox, /aria-invalid="true"/)
  assert.match(
    checkbox,
    /aria-\[invalid=true\]:border-\[var\(--gs-semantic-feedback-error-text\)\]/,
  )
})

test('checkbox and segmented controls expose independent state semantics', () => {
  const checkbox = renderToStaticMarkup(
    React.createElement(Checkbox, {
      id: 'include-files',
      label: 'Include files',
      checked: true,
      readOnly: true,
    }),
  )
  const segmented = renderToStaticMarkup(
    React.createElement(SegmentedControl, {
      label: 'Repository filter',
      value: 'local',
      onValueChange: () => undefined,
      options: [
        { value: 'all', label: 'All' },
        { value: 'local', label: 'Local' },
      ],
    }),
  )

  assert.match(checkbox, /for="include-files"/)
  assert.match(checkbox, /type="checkbox"/)
  assert.match(segmented, /role="group"/)
  assert.match(segmented, /aria-label="Repository filter"/)
  assert.match(segmented, /aria-pressed="true"[^>]*>Local/)
})

test('shell specimen captions are not rendered as labels without controls', () => {
  const markup = renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(ShellSpecimen)),
  )

  assert.match(markup, /<p class="shell-fixture-caption">Branch matching/)
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
