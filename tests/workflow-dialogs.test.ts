import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BlockerList,
  OperationContext,
  OperationSteps,
  PhaseStatus,
  WarningNote,
  WorkflowFrame,
} from '../src/renderer/src/components/workflow-composition'
import {
  CLOSE_INTENT_MESSAGES,
  closeIntent,
  createDispatchLock,
  initialFocusTarget,
  partialProgress,
  PHASE_PRESENTATION,
  workflowBlocker,
  workflowPhase,
  type WorkflowGuardInput,
} from '../src/renderer/src/components/workflow-policy'
import {
  stackActionLabel,
  workflowAction,
  workflowActionLabel,
  type WorkflowActionInput,
} from '../src/renderer/src/components/workflow-action'
import {
  activeCherryPickSnapshot,
  baseSnapshot,
  blockedRestackPreview,
  completedRestackProgress,
  conflictedFiles,
  defaultBranch,
  featureBranch,
  followUpBranch,
  leasePreview,
  mergeCommit,
  mergePreview,
  openPullRequest,
  pausedRestackProgress,
  publishPreview,
  restackPreview,
  unavailableGitHubSnapshot,
  unstartedRestackProgress,
} from './fixtures/workflow-scenarios'

import type { StackPreview } from '../src/shared/types'

const context = { headOid: featureBranch.oid as string, currentBranch: 'feature/checkout' }

function guard(overrides: Partial<WorkflowGuardInput> = {}): WorkflowGuardInput {
  return {
    kind: 'rename',
    allowForce: false,
    requiresLeaseApproval: false,
    busy: false,
    loading: false,
    loaded: true,
    finished: false,
    capturedPath: baseSnapshot.path,
    currentPath: baseSnapshot.path,
    previewToken: null,
    rejectedTokens: [],
    previewBlockers: [],
    confirmationTarget: null,
    confirmation: '',
    expectedOidMissing: false,
    requiresName: true,
    name: 'feature/renamed',
    requiresMainline: false,
    mainline: '',
    requiresMergeMethod: false,
    mergeMethod: '',
    untitledBranches: [],
    pullRequestMissing: false,
    pullRequestMerged: false,
    pullRequestTitle: '',
    ...overrides,
  }
}

test('the visual state model resolves to one phase per snapshot truth', () => {
  assert.equal(
    workflowPhase({
      loading: true,
      busy: true,
      failed: true,
      stale: true,
      finished: true,
      partial: true,
      blocked: true,
    }),
    'loading',
    'a read in flight outranks every outcome it would produce',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: true,
      failed: true,
      stale: true,
      finished: true,
      partial: true,
      blocked: true,
    }),
    'submitting',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: true,
      stale: true,
      finished: true,
      partial: true,
      blocked: true,
    }),
    'failed',
    'a failure outranks a stale preview and a leftover blocker',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: false,
      stale: true,
      finished: true,
      partial: true,
      blocked: true,
    }),
    'stale',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: false,
      stale: false,
      finished: true,
      partial: true,
      blocked: true,
    }),
    'succeeded',
    'a completed step is not re-reported as blocked',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: false,
      stale: false,
      finished: false,
      partial: true,
      blocked: true,
    }),
    'partial',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: false,
      stale: false,
      finished: false,
      partial: false,
      blocked: true,
    }),
    'blocked',
  )
  assert.equal(
    workflowPhase({
      loading: false,
      busy: false,
      failed: false,
      stale: false,
      finished: false,
      partial: false,
      blocked: false,
    }),
    'ready',
  )
})

test('the ready phase stays silent so a refresh never repeats an announcement', () => {
  assert.equal(PHASE_PRESENTATION.ready.live, 'off')
  assert.equal(renderToStaticMarkup(React.createElement(PhaseStatus, { phase: 'ready' })), '')
  assert.equal(
    renderToStaticMarkup(
      React.createElement(PhaseStatus, { phase: 'ready', message: 'Preview is current.' }),
    ).includes('role='),
    false,
  )
})

test('failures interrupt and a rejected preview names the way out', () => {
  const failure = renderToStaticMarkup(
    React.createElement(PhaseStatus, { phase: 'failed', message: 'Rebase failed: conflict' }),
  )
  assert.match(failure, /role="alert"/)
  assert.match(failure, /Rebase failed: conflict/)

  const stale = renderToStaticMarkup(
    React.createElement(PhaseStatus, {
      phase: 'stale',
      message: 'This preview was already rejected.',
    }),
  )
  assert.match(stale, /aria-live="assertive"/)
  assert.match(stale, /Preview out of date/)
})

test('a busy dialog, an unfinished read, and a changed repository each block dispatch', () => {
  assert.equal(workflowBlocker(guard({ busy: true }))?.code, 'busy')
  assert.equal(workflowBlocker(guard({ loading: true }))?.code, 'loading')
  assert.equal(workflowBlocker(guard({ loaded: false }))?.code, 'unfinished')
  assert.equal(
    workflowBlocker(guard({ currentPath: '/private/tmp/some-other-repository' }))?.code,
    'repository-changed',
  )
  assert.equal(workflowBlocker(guard({ finished: true }))?.code, 'completed')
  assert.equal(workflowBlocker(guard()), null)
})

test('an incomplete typed confirmation cannot submit a destructive action', () => {
  const base = guard({
    kind: 'forcePush',
    requiresName: false,
    previewToken: 'lease-preview',
    confirmationTarget: defaultBranch.name,
  })
  assert.equal(workflowBlocker({ ...base, confirmation: '' })?.code, 'confirmation-incomplete')
  assert.equal(
    workflowBlocker({ ...base, confirmation: 'mai' })?.code,
    'confirmation-incomplete',
    'a partial name is still incomplete',
  )
  assert.equal(
    workflowBlocker({ ...base, confirmation: `${defaultBranch.name} ` })?.code,
    'confirmation-incomplete',
    'trailing whitespace is not an exact match',
  )
  assert.equal(workflowBlocker({ ...base, confirmation: defaultBranch.name }), null)
})

test('a rejected preview identity stays rejected until a fresh preview is read', () => {
  const input = guard({
    kind: 'stack',
    requiresName: false,
    previewToken: `stack:${restackPreview.token}`,
  })
  assert.equal(workflowBlocker(input), null)
  assert.equal(
    workflowBlocker({ ...input, rejectedTokens: [`stack:${restackPreview.token}`] })?.code,
    'preview-stale',
  )
  assert.equal(
    workflowBlocker({
      ...input,
      previewToken: 'stack:preview-restack-2',
      rejectedTokens: [`stack:${restackPreview.token}`],
    }),
    null,
    'a reloaded preview issues a new identity and is reviewable again',
  )
})

test('a rejected pull request preview cannot be updated until it is reloaded', () => {
  const pr = guard({
    kind: 'pr',
    requiresName: false,
    previewToken: 'pr:41:head-1',
    pullRequestTitle: 'Cover checkout',
  })
  assert.equal(workflowBlocker(pr), null)
  assert.equal(workflowBlocker({ ...pr, rejectedTokens: ['pr:41:head-1'] })?.code, 'preview-stale')
  assert.equal(
    workflowBlocker({
      ...pr,
      previewToken: 'pr:41:head-2',
      rejectedTokens: ['pr:41:head-1'],
    }),
    null,
    'a reloaded PR preview issues a new identity and can be reviewed',
  )
})

test('a blocked preview and a missing preview each name a recoverable next step', () => {
  const stack = guard({ kind: 'stack', requiresName: false })
  assert.equal(workflowBlocker(stack)?.code, 'preview-missing')
  const ready = { ...stack, previewToken: `stack:${restackPreview.token}` }
  assert.equal(workflowBlocker(ready), null)
  assert.equal(
    workflowBlocker({ ...ready, previewBlockers: blockedRestackPreview.blockers })?.code,
    'preview-blocked',
  )
  assert.match(workflowBlocker(stack)?.message ?? '', /Reload the preview/)
})

test('surgery needs its current preview, resolved blockers, and consent for remote rewrites', () => {
  const surgery = guard({ kind: 'surgery', requiresName: true, name: 'new-layer' })
  assert.equal(workflowBlocker(surgery)?.code, 'preview-missing')
  const ready = { ...surgery, previewToken: 'surgery:reviewed' }
  assert.equal(workflowBlocker(ready), null)
  assert.equal(workflowBlocker({ ...ready, name: '' })?.code, 'name-required')
  assert.equal(
    workflowBlocker({ ...ready, previewBlockers: ['unprovable boundary'] })?.code,
    'preview-blocked',
  )
  assert.equal(
    workflowBlocker({ ...ready, rejectedTokens: ['surgery:reviewed'] })?.code,
    'preview-stale',
  )
  assert.equal(
    workflowBlocker({ ...ready, requiresLeaseApproval: true })?.code,
    'lease-approval-required',
  )
  const forced = {
    ...ready,
    requiresLeaseApproval: true,
    allowForce: true,
    confirmationTarget: 'top',
  }
  assert.equal(workflowBlocker(forced)?.code, 'confirmation-incomplete')
  assert.equal(workflowBlocker({ ...forced, confirmation: 'top' }), null)
})

test('restack, publish, and merge keep their own requirements', () => {
  const publish = guard({
    kind: 'stack',
    requiresName: false,
    previewToken: `stack:${publishPreview.token}`,
  })
  assert.equal(
    workflowBlocker({ ...publish, untitledBranches: ['feature/checkout'] })?.code,
    'publish-title-required',
  )
  assert.equal(workflowBlocker(publish), null)

  const merge = guard({
    kind: 'stack',
    requiresName: false,
    requiresMergeMethod: true,
    previewToken: `stack:${mergePreview.token}`,
  })
  assert.equal(workflowBlocker(merge)?.code, 'merge-method-required')
  assert.equal(workflowBlocker({ ...merge, mergeMethod: 'squash' }), null)
})

test('a merge commit and a pull request keep their own requirements', () => {
  const commit = guard({
    kind: 'commitAction',
    requiresName: false,
    requiresMainline: true,
  })
  assert.equal(workflowBlocker(commit)?.code, 'mainline-required')
  assert.equal(workflowBlocker({ ...commit, mainline: '2' }), null)

  const pr = guard({ kind: 'pr', requiresName: false, pullRequestTitle: 'Cover checkout' })
  assert.equal(workflowBlocker(pr), null)
  assert.equal(
    workflowBlocker({ ...pr, pullRequestTitle: '  ' })?.code,
    'pull-request-title-required',
  )
  assert.equal(
    workflowBlocker({ ...pr, pullRequestMerged: true })?.code,
    'pull-request-unavailable',
  )
  assert.equal(
    workflowBlocker({ ...pr, pullRequestMissing: true })?.code,
    'pull-request-unavailable',
  )
})

test('every blocker states the next safe step instead of a bare invalid message', () => {
  const messages = [
    workflowBlocker(guard({ busy: true }))?.message,
    workflowBlocker(guard({ loading: true }))?.message,
    workflowBlocker(guard({ currentPath: '/elsewhere' }))?.message,
    workflowBlocker(
      guard({
        kind: 'forcePush',
        requiresName: false,
        previewToken: 'lease',
        confirmationTarget: 'feature/checkout',
        confirmation: '',
      }),
    )?.message,
    workflowBlocker(guard({ kind: 'stack', requiresName: false }))?.message,
  ]
  for (const message of messages) {
    assert.ok(message && message.length > 20, `blocker copy is actionable: ${message}`)
    assert.doesNotMatch(message, /invalid|failed$/i)
  }
})

test('the representative flows produce their exact reviewed payloads', () => {
  const inputs: Array<[WorkflowActionInput, unknown]> = [
    [
      { kind: 'rename', branch: featureBranch, name: '  feature/checkout-v2  ' },
      {
        type: 'renameBranch',
        ref: 'refs/heads/feature/checkout',
        name: 'feature/checkout-v2',
      },
    ],
    [
      { kind: 'parent', branch: followUpBranch, name: 'main' },
      {
        type: 'setParent',
        branch: 'feature/checkout-tests',
        parent: 'main',
      },
    ],
    [
      { kind: 'upstream', branch: featureBranch, name: '' },
      {
        type: 'setUpstream',
        ref: 'refs/heads/feature/checkout',
        upstream: null,
      },
    ],
    [
      { kind: 'pull', strategy: 'rebase' },
      { type: 'pull', strategy: 'rebase' },
    ],
    [
      { kind: 'stash', message: '  work in progress  ', includeUntracked: true },
      {
        type: 'stash',
        message: 'work in progress',
        includeUntracked: true,
      },
    ],
    [
      { kind: 'merge', ref: 'refs/heads/feature/checkout-tests' },
      {
        type: 'merge',
        ref: 'refs/heads/feature/checkout-tests',
        expectedHead: '2222222222222222222222222222222222222222',
        expectedHeadRef: 'refs/heads/feature/checkout',
      },
    ],
    [
      { kind: 'commitAction', commit: mergeCommit, mode: 'revert', mainline: '2' },
      {
        type: 'revert',
        oid: '4444444444444444444444444444444444444444',
        expectedHead: '2222222222222222222222222222222222222222',
        expectedHeadRef: 'refs/heads/feature/checkout',
        mainline: 2,
      },
    ],
    [
      {
        kind: 'stack',
        operation: 'restack',
        preview: restackPreview,
        mergeAction: 'default',
        confirmation: '',
        confirmationTarget: null,
        allowForce: false,
        mergeMethod: '',
      },
      {
        type: 'executeStack',
        token: 'preview-restack-1',
        allowForce: false,
        mergeMethod: 'squash',
      },
    ],
    [
      {
        kind: 'stack',
        operation: 'merge',
        preview: mergePreview,
        mergeAction: 'merge_queue',
        confirmation: '',
        confirmationTarget: null,
        allowForce: false,
        mergeMethod: '',
      },
      {
        type: 'executeStack',
        token: 'preview-merge-1',
        allowForce: false,
        mergeMethod: 'squash',
        mergeAction: 'merge_queue',
      },
    ],
    [
      {
        kind: 'stack',
        operation: 'merge',
        preview: mergePreview,
        mergeAction: 'direct_merge',
        confirmation: '',
        confirmationTarget: null,
        allowForce: false,
        mergeMethod: 'rebase',
      },
      {
        type: 'executeStack',
        token: 'preview-merge-1',
        allowForce: false,
        mergeMethod: 'rebase',
        mergeAction: 'direct_merge',
      },
    ],
    [
      { kind: 'pr', number: 41, title: '  Cover checkout validation ', body: 'Body', draft: true },
      {
        type: 'updatePr',
        number: 41,
        title: 'Cover checkout validation',
        body: 'Body',
        draft: true,
      },
    ],
  ]

  for (const [input, expected] of inputs) {
    assert.deepEqual(workflowAction(input, context), expected)
  }
})

test('a merge only dispatches an offered delivery action, and a method for a direct one', () => {
  const base = {
    kind: 'stack',
    operation: 'merge',
    preview: mergePreview,
    confirmation: '',
    confirmationTarget: null,
    allowForce: false,
  } as const
  assert.equal(
    workflowAction({ ...base, mergeAction: 'direct_merge', mergeMethod: '' }, context),
    null,
    'a direct merge with no chosen method would dispatch one the repository may not allow',
  )
  assert.deepEqual(
    workflowAction({ ...base, mergeAction: 'merge_queue', mergeMethod: 'rebase' }, context),
    {
      type: 'executeStack',
      token: 'preview-merge-1',
      allowForce: false,
      mergeMethod: 'squash',
      mergeAction: 'merge_queue',
    },
    'a queued merge lets the repository method win over the one left on screen',
  )
  const withoutQueue: StackPreview = {
    ...mergePreview,
    merge: { ...mergePreview.merge!, actions: ['default', 'direct_merge'] },
  }
  assert.equal(
    workflowAction(
      { ...base, preview: withoutQueue, mergeAction: 'merge_queue', mergeMethod: '' },
      context,
    ),
    null,
    'an action the preview does not offer is never dispatched',
  )
  assert.deepEqual(workflowAction({ ...base, mergeAction: 'default', mergeMethod: '' }, context), {
    type: 'executeStack',
    token: 'preview-merge-1',
    allowForce: false,
    mergeMethod: 'squash',
    mergeAction: 'default',
  })
})

test('a force-with-lease push only dispatches against a confirmed captured tip', () => {
  const input = { kind: 'forcePush', push: leasePreview, confirmation: 'feature/checkout' } as const
  assert.deepEqual(workflowAction(input, context), {
    type: 'forcePush',
    preview: leasePreview,
  })
  assert.equal(
    workflowAction({ ...input, confirmation: 'feature' }, context),
    null,
    'an incomplete typed name never reaches the dispatcher',
  )
  assert.equal(workflowAction({ ...input, push: null }, context), null)
  assert.equal(
    workflowBlocker(guard({ kind: 'forcePush', requiresName: false }))?.code,
    'preview-missing',
  )
})

test('a blocked preview and a missing captured HEAD never dispatch a mutation', () => {
  const stack = {
    kind: 'stack',
    operation: 'restack',
    preview: blockedRestackPreview,
    allowForce: false,
    confirmation: '',
    confirmationTarget: null,
    draft: true,
    titles: {},
    mergeMethod: '',
    mergeAction: 'default',
  } as const
  assert.equal(workflowAction(stack, context), null)
  assert.equal(
    workflowAction(
      { kind: 'merge', ref: 'refs/heads/feature/checkout-tests' },
      { headOid: null, currentBranch: null },
    ),
    null,
  )
  assert.equal(
    workflowAction(
      { kind: 'commitAction', commit: mergeCommit, mode: 'cherryPick', mainline: '' },
      {
        headOid: null,
        currentBranch: 'feature/checkout',
      },
    ),
    null,
  )
})

test('dispatch labels name the operation that actually runs', () => {
  assert.equal(workflowActionLabel({ kind: 'pull', strategy: 'ff-only' }), 'Pull changes')
  assert.equal(
    workflowActionLabel({
      kind: 'confirm',
      action: { type: 'stashDrop', ref: 'a', oid: 'b' },
      label: 'Drop stash',
    }),
    'Drop stash',
  )
  assert.equal(stackActionLabel('restack'), 'Restack stack')
  assert.equal(stackActionLabel('merge'), 'Merge pull request')
})

test('repeated activation while an action is in flight dispatches exactly once', async () => {
  const lock = createDispatchLock()
  let calls = 0
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const dispatch = async () => {
    calls += 1
    await gate
    return 'done'
  }

  const first = lock(dispatch)
  const second = lock(dispatch)
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(calls, 1, 'the second activation did not reach the backend')
  assert.equal(a.dispatched, true)
  assert.equal(a.value, 'done')
  assert.equal(b.dispatched, false)

  const third = await lock(async () => {
    calls += 1
    return 'again'
  })
  assert.equal(third.dispatched, true)
  assert.equal(calls, 2, 'the lock releases once the action settles')
})

test('a rejected dispatch releases the lock so the next attempt can run', async () => {
  const lock = createDispatchLock()
  await assert.rejects(
    lock(async () => {
      throw new Error('Rebase stopped on a conflict')
    }),
    /Rebase stopped on a conflict/,
  )
  const retry = await lock(async () => 'retried')
  assert.equal(retry.dispatched, true)
  assert.equal(retry.value, 'retried')
})

test('escape and backdrop cannot interrupt a mutation or silently discard entered work', () => {
  assert.equal(closeIntent({ busy: false, dirty: false }), 'allow')
  assert.equal(closeIntent({ busy: true, dirty: false }), 'blocked-busy')
  assert.equal(closeIntent({ busy: false, dirty: true }), 'blocked-unsaved')
  assert.equal(closeIntent({ busy: true, dirty: true }), 'blocked-busy')
  assert.match(CLOSE_INTENT_MESSAGES['blocked-busy'], /still running/)
  assert.match(CLOSE_INTENT_MESSAGES['blocked-unsaved'], /do not discard/)
  assert.match(CLOSE_INTENT_MESSAGES['blocked-unsaved'], /Cancel/)
})

test('destructive and reviewed operations open on Cancel; ordinary forms open on their first field', () => {
  assert.equal(initialFocusTarget('destructive'), 'cancel')
  assert.equal(initialFocusTarget('reviewed'), 'cancel')
  assert.equal(initialFocusTarget('form'), 'first-field')
})

test('the three compositions are distinguishable in the rendered surface', () => {
  const destructive = renderToStaticMarkup(
    React.createElement(WorkflowFrame, { composition: 'destructive' }, 'body'),
  )
  const reviewed = renderToStaticMarkup(
    React.createElement(WorkflowFrame, { composition: 'reviewed' }, 'body'),
  )
  const form = renderToStaticMarkup(
    React.createElement(WorkflowFrame, { composition: 'form' }, 'body'),
  )
  assert.match(destructive, /data-composition="destructive"/)
  assert.match(reviewed, /data-composition="reviewed"/)
  assert.match(form, /data-composition="form"/)
  assert.match(destructive, /max-w-lg/)
  assert.match(reviewed, /max-w-\[620px\]/)
  assert.match(
    renderToStaticMarkup(
      React.createElement(WorkflowFrame, { composition: 'reviewed', wide: true }, 'body'),
    ),
    /max-w-\[760px\]/,
  )
})

test('reviewed operations show the real source, target, and commit identifiers', () => {
  const markup = renderToStaticMarkup(
    React.createElement(OperationContext, {
      title: 'Replace origin/feature/checkout',
      description: 'Only the remote branch is replaced.',
      facts: [
        { label: 'Destination', value: 'origin/feature/checkout', code: true },
        { label: 'Expected remote tip', value: 'aaaa00000000', code: true },
        { label: 'Local tip', value: '2222222222', code: true },
      ],
    }),
  )
  assert.match(markup, /What this changes/)
  assert.match(markup, /origin\/feature\/checkout/)
  assert.match(markup, /aaaa00000000/)
  assert.match(markup, /2222222222/)
  assert.match(markup, /font-mono/)
})

test('preview steps list every reviewed branch with its parent, commits, and OID', () => {
  const markup = renderToStaticMarkup(
    React.createElement(OperationSteps, {
      steps: restackPreview.steps,
      label: 'Planned stack operations',
    }),
  )
  assert.match(markup, /aria-label="Planned stack operations"/)
  assert.match(markup, /feature\/checkout<\/strong>/)
  assert.match(markup, /into main · 2 commits/)
  assert.match(markup, /<code class="font-mono">2222222222<\/code>/)
  assert.match(markup, /feature\/checkout-tests/)
  assert.match(markup, /into feature\/checkout · 1 commit/)
  assert.match(markup, /<code class="font-mono">3333333333<\/code>/)
  assert.match(markup, />draft</)
  assert.match(markup, /#41 · feature\/checkout-tests → feature\/checkout/)
  assert.equal(
    renderToStaticMarkup(
      React.createElement(OperationSteps, { steps: [], label: 'Planned stack operations' }),
    ),
    '',
  )
})

test('blockers and warnings stay on screen with their reasons intact', () => {
  const blockers = renderToStaticMarkup(
    React.createElement(BlockerList, { items: blockedRestackPreview.blockers }),
  )
  assert.match(blockers, /role="alert"/)
  assert.match(blockers, /Resolve before continuing/)
  for (const blocker of blockedRestackPreview.blockers) {
    assert.ok(blockers.includes(blocker.slice(0, 24)))
  }
  assert.equal(renderToStaticMarkup(React.createElement(BlockerList, { items: [] })), '')

  const warning = renderToStaticMarkup(
    React.createElement(WarningNote, null, 'Remote-only commits may become unreachable.'),
  )
  assert.match(warning, /Remote-only commits may become unreachable\./)
})

test('recovery progress is counted from the snapshot, never invented', () => {
  const paused = partialProgress({
    completed: pausedRestackProgress.completed,
    remaining: pausedRestackProgress.remaining,
    message: pausedRestackProgress.message,
  })
  assert.equal(paused.completed, 1)
  assert.equal(paused.remaining, 1)
  assert.equal(paused.summary, '1 of 2 steps completed')

  const unstarted = partialProgress({
    completed: unstartedRestackProgress.completed,
    remaining: unstartedRestackProgress.remaining,
    message: unstartedRestackProgress.message,
  })
  assert.equal(unstarted.summary, 'No steps completed yet · 2 remaining')

  const done = partialProgress({
    completed: completedRestackProgress.completed,
    remaining: completedRestackProgress.remaining,
    message: completedRestackProgress.message,
  })
  assert.equal(done.summary, '2 of 2 steps completed')

  for (const progress of [paused, unstarted, done]) {
    assert.doesNotMatch(progress.summary, /%/)
  }
})

test('the conflict and recovery fixtures describe real interrupted states', () => {
  assert.equal(activeCherryPickSnapshot.operation, 'cherryPick')
  assert.equal(activeCherryPickSnapshot.files.filter((file) => file.conflicted).length, 1)
  assert.equal(pausedRestackProgress.remaining.length, 1)
  assert.equal(completedRestackProgress.remaining.length, 0)
  assert.deepEqual(
    conflictedFiles.filter((file) => file.conflicted).map((file) => file.path),
    ['src/checkout.ts'],
  )
  assert.equal(unavailableGitHubSnapshot.github.available, false)
  assert.match(unavailableGitHubSnapshot.github.message, /not authenticated/)
  assert.equal(openPullRequest.checks, 'pending')
  assert.equal(restackPreview.steps.length, 2)
  assert.deepEqual(restackPreview.blockers, [])
})

test('a forced publication still needs the exact branch name typed', () => {
  const forced = guard({
    kind: 'stack',
    requiresName: false,
    allowForce: true,
    previewToken: `stack:${publishPreview.token}`,
    confirmationTarget: featureBranch.name,
  })
  assert.equal(workflowBlocker(forced)?.code, 'confirmation-incomplete')
  const confirmed = { ...forced, confirmation: featureBranch.name }
  assert.equal(workflowBlocker(confirmed), null)
  const layers = {
    'feature/checkout': {
      title: 'Checkout validation',
      body: '',
      draft: true,
      updateBase: false,
    },
  }
  assert.equal(
    workflowAction(
      {
        kind: 'submit',
        preview: publishPreview,
        allowForce: true,
        layers,
        confirmation: '',
        confirmationTarget: featureBranch.name,
      },
      context,
    ),
    null,
    'the builder refuses a forced publish with an unconfirmed name even if the guard is bypassed',
  )
  assert.deepEqual(
    workflowAction(
      {
        kind: 'submit',
        preview: publishPreview,
        allowForce: true,
        layers,
        confirmation: featureBranch.name,
        confirmationTarget: featureBranch.name,
      },
      context,
    ),
    {
      type: 'submitStack',
      token: publishPreview.token,
      allowForce: true,
      layers,
    },
    'the confirmed name produces the submission, so the refusal above is the confirmation and not a missing offer',
  )
})

test('an unforced publication needs no typed name', () => {
  assert.equal(
    workflowBlocker(
      guard({
        kind: 'stack',
        requiresName: false,
        allowForce: false,
        previewToken: `stack:${publishPreview.token}`,
      }),
    ),
    null,
  )
})

test('a force push with a lease cannot run until its branch name is typed', () => {
  const loaded = guard({
    kind: 'forcePush',
    requiresName: false,
    previewToken: `push:${leasePreview.destination}`,
    expectedOidMissing: false,
    confirmationTarget: leasePreview.branch,
  })
  assert.equal(workflowBlocker(loaded)?.code, 'confirmation-incomplete')
  assert.equal(workflowBlocker({ ...loaded, confirmation: leasePreview.branch }), null)
  assert.equal(
    workflowAction({ kind: 'forcePush', push: leasePreview, confirmation: 'other' }, context),
    null,
  )
  assert.deepEqual(
    workflowAction(
      { kind: 'forcePush', push: leasePreview, confirmation: leasePreview.branch },
      context,
    ),
    { type: 'forcePush', preview: leasePreview },
  )
})

test('a merge carries the selected ref instead of dispatching nothing', () => {
  assert.deepEqual(workflowAction({ kind: 'merge', ref: 'main' }, context), {
    type: 'merge',
    ref: 'main',
    expectedHead: featureBranch.oid,
    expectedHeadRef: featureBranch.ref,
  })
})
