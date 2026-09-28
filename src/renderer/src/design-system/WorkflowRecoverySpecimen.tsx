import React from 'react'
import type { PublishProgress, RepositorySnapshot, StackPreview } from '../../../shared/types'
import { WorkflowDialog } from '../components/workflow-dialog'
import { publishPreview } from './DialogSpecimenData'

/**
 * Renders the real submit dialog in the two states a recovered submission can be in while the
 * repository it came from has since moved: a fresh preview that describes something else, and
 * no fresh preview at all. Both are states the dialog has to get right on its own, so they are
 * exercised against the real component rather than a copy of its markup.
 *
 * `mismatch` gives the fresh preview a different base and a different pull request identity
 * than the journal records. `preview-failure` makes the fresh read fail while the journal read
 * still succeeds, which is what a repository that has gone offline looks like.
 */
const JOURNEY_LAYERS: PublishProgress['layers'] = [
  {
    branch: 'feature/checkout',
    base: 'main',
    create: true,
    pullRequest: 101,
    title: 'Checkout validation',
    body: 'The reviewed body.',
    draft: true,
    updateBase: false,
    force: false,
    createIntent: true,
  },
  {
    branch: 'feature/checkout-orders',
    base: 'feature/checkout',
    create: false,
    pullRequest: 102,
    title: 'Orders',
    body: 'The reviewed body.',
    draft: true,
    updateBase: true,
    force: true,
    createIntent: false,
  },
]

const journal: PublishProgress = {
  operationId: 'op-recovery-specimen',
  status: 'failed',
  message: 'Push failed: remote refused the update.',
  resumeAt: 1,
  steps: [
    {
      kind: 'push',
      branch: 'feature/checkout',
      label: 'Push feature/checkout',
      status: 'completed',
      pullRequest: null,
      detail: 'Pushed 1 branch.',
      failure: null,
    },
    {
      kind: 'push',
      branch: 'feature/checkout-orders',
      label: 'Push feature/checkout-orders',
      status: 'failed',
      pullRequest: null,
      detail: '',
      failure: {
        summary: 'Remote refused the update.',
        recovery: 'Fetch the remote, confirm nobody pushed to this branch, then retry this step.',
        retryable: true,
      },
    },
  ],
  layers: JOURNEY_LAYERS,
  allowForce: true,
}

/** A repository that has moved on: new base, new pull request numbers. */
const movedPreview: StackPreview = {
  ...publishPreview,
  token: 'preview-publish-moved',
  publish: {
    ...publishPreview.publish!,
    stackAction: 'extend',
    baseChanges: ['feature/checkout-orders'],
    layers: JOURNEY_LAYERS.map((layer) => ({
      ...layer,
      base: 'feature/moved-parent',
      pullRequest: (layer.pullRequest ?? 0) + 800,
      title: 'Unreviewed replacement title',
    })),
    steps: publishPreview.publish!.steps.map((step) => ({
      ...step,
      label: step.label.replace('feature/checkout-orders', 'feature/checkout-orders@2'),
    })),
  },
  warnings: ['feature/checkout-orders now targets a moved branch.'],
  blockers: [],
}

function branch(name: string, seed: string, current = false) {
  return {
    name,
    ref: `refs/heads/${name}`,
    current,
    remote: true,
    upstreamRef: `refs/remotes/origin/${name}`,
    oid: seed.repeat(40),
    ahead: 0,
    behind: 0,
    merged: false,
    protected: false,
    worktree: false,
    upstream: current ? `origin/${name}` : null,
  } as unknown as RepositorySnapshot['branches'][number]
}

const snapshot: RepositorySnapshot = {
  path: '/tmp/specimen',
  name: 'specimen',
  currentBranch: 'feature/checkout',
  defaultBranch: 'main',
  remoteUrl: 'git@github.com:acme/widgets.git',
  branches: [branch('main', 'a'), branch('feature/checkout', 'b', true)],
  pullRequests: [],
  files: [],
  stashes: [],
  rebaseInProgress: false,
  operation: null,
  stackOperation: null,
  headOid: 'b'.repeat(40),
  github: { available: true, message: '' },
}

const noop = () => undefined

function installDesktop(mode: string): () => void {
  // The design-system routes run without a preload bridge, so the specimen supplies the
  // backend surface the dialog reads. Where a bridge does exist, the three reads the recovery
  // path depends on are overridden on it instead.
  const existing = (window as unknown as { desktop?: Record<string, unknown> }).desktop
  const target = (existing ?? {}) as Record<string, unknown>
  const previous = {
    stackPreview: target.stackPreview,
    submitStackProgress: target.submitStackProgress,
    onSubmitStackProgress: target.onSubmitStackProgress,
  }
  target.stackPreview = async () => {
    if (mode === 'preview-failure') {
      throw new Error('fatal: unable to access remote')
    }
    return mode === 'mismatch' ? movedPreview : publishPreview
  }
  target.submitStackProgress = async () => journal
  target.onSubmitStackProgress = () => () => undefined
  if (!existing) {
    ;(window as unknown as { desktop?: Record<string, unknown> }).desktop = target
  }
  return () => {
    if (!existing) {
      delete (window as unknown as { desktop?: Record<string, unknown> }).desktop
      return
    }
    target.stackPreview = previous.stackPreview
    target.submitStackProgress = previous.submitStackProgress
    target.onSubmitStackProgress = previous.onSubmitStackProgress
  }
}

export function WorkflowRecoverySpecimen({ mode }: { mode: string }) {
  const restore = React.useMemo(() => installDesktop(mode), [mode])
  React.useEffect(() => restore, [restore])
  return (
    <WorkflowDialog
      request={{ kind: 'stack', branch: 'feature/checkout', operation: 'publish' }}
      snapshot={snapshot}
      busy={false}
      actionError={null}
      onClearActionError={noop}
      runAction={async () => true}
      onClose={noop}
      onRequest={noop}
    />
  )
}
