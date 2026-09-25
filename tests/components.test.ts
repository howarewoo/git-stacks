import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button, IconButton } from '../src/renderer/src/components/ui/button'
import { Checkbox } from '../src/renderer/src/components/ui/checkbox'
import { Field } from '../src/renderer/src/components/ui/field'
import { Input } from '../src/renderer/src/components/ui/input'
import { SegmentedControl } from '../src/renderer/src/components/ui/segmented-control'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
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
