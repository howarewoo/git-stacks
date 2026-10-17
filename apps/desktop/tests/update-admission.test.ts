import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  useDraftAdmissionLocked,
  isDraftAdmissionLocked,
  setupReviewDraftReadinessListener,
} from '../src/renderer/src/components/review-view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReviewConversation } from '../src/renderer/src/components/review-conversation'
import type { ReviewDraftRecord, ReviewThreadRead } from '@git-stacks/shared/review-threads'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateService } from '../src/main/update/service'
import type { UpdateStatus } from '@git-stacks/shared/update'
import {
  InstallAdmissionFence,
  RendererReadinessCoordinator,
  coordinateSafeInstall,
  type MutationAuthority,
  type WebContentsLike,
} from '../src/main/update/admission'

function extractNonce(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'nonce' in payload &&
    typeof payload.nonce === 'string'
  ) {
    return payload.nonce
  }
  throw new Error('Expected payload with string nonce')
}

function extractAdmitted(payload: unknown): boolean {
  if (
    payload &&
    typeof payload === 'object' &&
    'admitted' in payload &&
    typeof payload.admitted === 'boolean'
  ) {
    return payload.admitted
  }
  throw new Error('Expected payload with boolean admitted')
}

class MockWebContents extends EventEmitter implements WebContentsLike {
  sentEvents: Array<{ channel: string; args: unknown[] }> = []
  destroyed = false

  send(channel: string, ...args: unknown[]) {
    this.sentEvents.push({ channel, args })
  }

  isDestroyed() {
    return this.destroyed
  }
}

test('InstallAdmissionFence admits atomically when idle and no mutations are active', () => {
  const fence = new InstallAdmissionFence()
  assert.equal(fence.isFenced, false)
  assert.equal(fence.state, 'idle')

  const result = fence.admit()
  assert.equal(result.ok, true)
  assert.equal(fence.isFenced, true)
  assert.equal(fence.state, 'fenced')

  // A second admit while fenced is refused
  const duplicate = fence.admit()
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.reason ?? '', /already in progress/i)

  fence.release()
  assert.equal(fence.isFenced, false)
  assert.equal(fence.state, 'idle')
})

test('InstallAdmissionFence refuses atomically when a registered authority has active mutations', () => {
  const fence = new InstallAdmissionFence()
  let hasMutations = true
  const authority: MutationAuthority = {
    hasActiveOrQueuedMutations: () => hasMutations,
  }

  const unregister = fence.registerAuthority(authority)
  assert.equal(fence.hasActiveOrQueuedMutations(), true)

  const result = fence.admit()
  assert.equal(result.ok, false)
  assert.equal(fence.isFenced, false)
  assert.match(result.reason ?? '', /repository mutations are queued or running/i)

  // Once mutations clear, admission succeeds
  hasMutations = false
  assert.equal(fence.hasActiveOrQueuedMutations(), false)
  const retry = fence.admit()
  assert.equal(retry.ok, true)
  assert.equal(fence.isFenced, true)

  fence.release()
  unregister()
})

test('InstallAdmissionFence refuses atomically while a clone is in flight', async () => {
  const fence = new InstallAdmissionFence()

  let cloneFinished = false
  const clonePromise = fence.trackClone(async () => {
    assert.equal(fence.hasActiveClones(), true)
    assert.equal(fence.hasActiveOrQueuedMutations(), true)
    const refused = fence.admit()
    assert.equal(refused.ok, false)
    assert.match(refused.reason ?? '', /repository clone is in progress/i)
    cloneFinished = true
  })

  await clonePromise
  assert.equal(cloneFinished, true)
  assert.equal(fence.hasActiveClones(), false)

  const admitted = fence.admit()
  assert.equal(admitted.ok, true)
})

test('InstallAdmissionFence permits in-flight and FIFO successor draft saves to drain while fenced', async () => {
  const fence = new InstallAdmissionFence()
  // Admit fence
  const admitted = fence.admit()
  assert.equal(admitted.ok, true)
  assert.equal(fence.isFenced, true)

  // In-flight/FIFO successor draft saves proceed under fenced state
  let draftRan = false
  const draftPromise = fence.trackDraftWrite(async () => {
    assert.equal(fence.hasActiveDraftWrites(), true)
    draftRan = true
  })

  // Drain helper waits for active draft saves to finish
  const drained = await fence.waitForActiveDraftWrites(5000)
  assert.equal(drained, true)
  await draftPromise
  assert.equal(draftRan, true)
  assert.equal(fence.hasActiveDraftWrites(), false)

  // Sealing the fence blocks late draft saves during preparation
  fence.seal()
  assert.equal(fence.state, 'sealed')
  await assert.rejects(
    fence.trackDraftWrite(async () => {}),
    /Cannot save review drafts: an update installation preparation is in progress/i,
  )

  // Once native cutover begins (state = installing), new draft saves are also blocked
  fence.markInstalling()
  await assert.rejects(
    fence.trackDraftWrite(async () => {}),
    /Cannot save review drafts: an update installation preparation is in progress/i,
  )

  fence.release()
})

test('RendererReadinessCoordinator fails closed on missing or destroyed renderer', async () => {
  const coordinator = new RendererReadinessCoordinator()

  // Null webContents fails closed
  const nullReport = await coordinator.checkReadiness(null)
  assert.equal(nullReport.ready, false)
  assert.match(nullReport.reason ?? '', /Active application window is required/i)

  // Destroyed webContents fails closed
  const mockWebContents = new MockWebContents()
  mockWebContents.destroyed = true
  const destroyedReport = await coordinator.checkReadiness(mockWebContents)
  assert.equal(destroyedReport.ready, false)
  assert.match(destroyedReport.reason ?? '', /Active application window is required/i)
})

test('RendererReadinessCoordinator handles readiness flow and window lifecycle invalidation', async () => {
  const coordinator = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  // 1. Successful ready response
  const readyPromise = coordinator.checkReadiness(mockWebContents)
  assert.equal(mockWebContents.sentEvents.length, 1)
  assert.equal(mockWebContents.sentEvents[0].channel, 'update:prepare-readiness')
  const nonce = extractNonce(mockWebContents.sentEvents[0].args[0])

  const handled = coordinator.reportReadiness({ nonce, ready: true })
  assert.equal(handled, true)
  const report = await readyPromise
  assert.equal(report.ready, true)
  assert.ok(report.session)

  // Revalidate session is valid while window is intact
  const validity = coordinator.revalidate(report.session)
  assert.equal(validity.valid, true)

  // If window is destroyed before cutover, session revalidation fails
  mockWebContents.emit('destroyed')
  const invalidatedValidity = coordinator.revalidate(report.session)
  assert.equal(invalidatedValidity.valid, false)
  assert.match(invalidatedValidity.reason ?? '', /destroyed/i)
  report.session.cleanup()

  // 2. Window reloads or navigates during readiness check
  mockWebContents.sentEvents.length = 0
  const reloadPromise = coordinator.checkReadiness(mockWebContents)
  mockWebContents.emit('did-start-navigation')
  const reloadReport = await reloadPromise
  assert.equal(reloadReport.ready, false)
  assert.match(reloadReport.reason ?? '', /navigated or reloaded/i)
})

test('coordinateSafeInstall releases fence on returned refusal without native cutover', async () => {
  const fence = new InstallAdmissionFence()
  const readiness = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  let settledReported: boolean | null = null
  const originalSend = mockWebContents.send.bind(mockWebContents)
  mockWebContents.send = (channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args)
    if (channel === 'update:prepare-readiness') {
      const nonce = extractNonce(args[0])
      readiness.reportReadiness({ nonce, ready: true })
    }
    if (channel === 'update:admission-settled') {
      settledReported = extractAdmitted(args[0])
    }
  }

  // UpdateService returns a failed status (e.g. signature refused, unsigned app) without cutover
  const refusedStatus: UpdateStatus = {
    phase: 'failed',
    offer: null,
    failure: { reason: 'bad-signature', message: 'Binary verification failed' },
    progress: null,
    currentVersion: '0.1.0',
    channel: 'stable',
    supported: true,
    trust: 'release',
    readyToInstall: true,
    restartRequired: false,
  }

  const result = await coordinateSafeInstall({
    fence,
    readiness,
    getWebContents: () => mockWebContents,
    install: async (_options) => {
      // onNativeCutover was NOT called
      return refusedStatus
    },
  })

  assert.equal(result, refusedStatus)
  // Fence MUST be released back to idle, not stuck in installing!
  assert.equal(fence.isFenced, false)
  assert.equal(fence.state, 'idle')
  assert.equal(settledReported, false)
})

test('coordinateSafeInstall holds fence only on explicit native cutover handoff', async () => {
  const fence = new InstallAdmissionFence()
  const readiness = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  const originalSend = mockWebContents.send.bind(mockWebContents)
  mockWebContents.send = (channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args)
    if (channel === 'update:prepare-readiness') {
      const nonce = extractNonce(args[0])
      readiness.reportReadiness({ nonce, ready: true })
    }
  }

  const cutoverStatus: UpdateStatus = {
    phase: 'installing',
    offer: null,
    failure: null,
    progress: null,
    currentVersion: '0.1.0',
    channel: 'stable',
    supported: true,
    trust: 'release',
    readyToInstall: false,
    restartRequired: true,
  }

  const result = await coordinateSafeInstall({
    fence,
    readiness,
    getWebContents: () => mockWebContents,
    install: async (options) => {
      // Native installer replaces files / spawns detached
      options.onNativeCutover?.()
      return cutoverStatus
    },
  })

  assert.equal(result, cutoverStatus)
  // Fence remains held in installing state across cutover into restart/quit!
  assert.equal(fence.isFenced, true)
  assert.equal(fence.state, 'installing')
})

test('coordinateSafeInstall preserves fence if native cutover occurred even if subsequent code throws', async () => {
  const fence = new InstallAdmissionFence()
  const readiness = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  const originalSend = mockWebContents.send.bind(mockWebContents)
  mockWebContents.send = (channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args)
    if (channel === 'update:prepare-readiness') {
      const nonce = extractNonce(args[0])
      readiness.reportReadiness({ nonce, ready: true })
    }
  }

  await assert.rejects(
    coordinateSafeInstall({
      fence,
      readiness,
      getWebContents: () => mockWebContents,
      install: async (options) => {
        // Native cutover was dispatched!
        options.onNativeCutover?.()
        // But marker write or relaunch/quit threw an error
        throw new Error('Post-cutover exit failure')
      },
    }),
    /Post-cutover exit failure/i,
  )

  // Because native cutover owns the files, fence MUST NOT be released!
  assert.equal(fence.isFenced, true)
  assert.equal(fence.state, 'installing')
})

test('coordinateSafeInstall fails closed and releases fence if window is invalidated before native cutover', async () => {
  const fence = new InstallAdmissionFence()
  const readiness = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  const originalSend = mockWebContents.send.bind(mockWebContents)
  mockWebContents.send = (channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args)
    if (channel === 'update:prepare-readiness') {
      const nonce = extractNonce(args[0])
      readiness.reportReadiness({ nonce, ready: true })
    }
  }

  await assert.rejects(
    coordinateSafeInstall({
      fence,
      readiness,
      getWebContents: () => mockWebContents,
      install: async (options) => {
        // Window destroys while updater was hashing or preparing copy
        mockWebContents.emit('destroyed')
        // beforeNativeCutover revalidates and must throw
        options.beforeNativeCutover?.()
        options.onNativeCutover?.()
        return {} as UpdateStatus
      },
    }),
    /Renderer readiness was invalidated during preparation: Renderer window was destroyed/i,
  )

  // Fence is safely released back to idle because native cutover was not reached
  assert.equal(fence.isFenced, false)
  assert.equal(fence.state, 'idle')
})

test('coordinateSafeInstall retries the same verified candidate after lifecycle loss during preparation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-stacks-test-service-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const artifactPath = join(dir, 'artifact.dmg')
  const content = Buffer.from('simulated artifact binary')
  writeFileSync(artifactPath, content)
  const sha256 = createHash('sha256').update(content).digest('hex')

  const fence = new InstallAdmissionFence()
  const readiness = new RendererReadinessCoordinator()
  const mockWebContents = new MockWebContents()

  const originalSend = mockWebContents.send.bind(mockWebContents)
  mockWebContents.send = (channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args)
    if (channel === 'update:prepare-readiness') {
      const nonce = extractNonce(args[0])
      readiness.reportReadiness({ nonce, ready: true })
    }
  }

  let nativeCutoverCalled = false
  let preparationCalls = 0
  const service = new UpdateService({
    packaged: false,
    currentVersion: '0.1.0',
    appPath: '/mock/app/path',
    userDataPath: dir,
    platform: 'darwin',
    arch: 'arm64',
    relaunch: () => {},
    quit: () => {},
    prepare: async (staged) => {
      preparationCalls += 1
      // Simulate window crashing during the first handoff preparation only.
      if (preparationCalls === 1) mockWebContents.emit('render-process-gone')
      return staged
    },
    install: async (_staged, options) => {
      options.beforeNativeCutover?.()
      options.onNativeCutover?.()
      nativeCutoverCalled = true
      return { installed: true, reason: 'installed' }
    },
  })

  const mutableService = service as unknown as {
    phase: string
    candidate: unknown
  }
  mutableService.phase = 'downloaded'
  mutableService.candidate = {
    staged: { path: artifactPath },
    sha256,
    version: '0.2.0',
    arch: 'arm64',
  }

  const status = await coordinateSafeInstall({
    fence,
    readiness,
    getWebContents: () => mockWebContents,
    install: (options) => service.install(options),
  })

  assert.equal(status.phase, 'downloaded')
  assert.equal(status.readyToInstall, true)

  assert.equal(nativeCutoverCalled, false)
  assert.equal(fence.isFenced, false)
  assert.equal(fence.state, 'idle')

  const retry = await coordinateSafeInstall({
    fence,
    readiness,
    getWebContents: () => mockWebContents,
    install: (options) => service.install(options),
  })

  assert.equal(retry.phase, 'installing')
  assert.equal(nativeCutoverCalled, true)
  assert.equal(preparationCalls, 2)
  assert.equal(fence.state, 'installing')
})

test('ReviewConversation genuinely disables DraftList inline comment editors when frozen for update admission', () => {
  const draftRecord: ReviewDraftRecord = {
    viewer: 'testuser',
    repo: 'owner/repo',
    number: 42,
    comparison: { baseOid: 'b1', headOid: 'h1', baseRef: 'refs/heads/main' },
    updatedAt: new Date().toISOString(),
    drafts: [
      {
        id: 'draft-1',
        ref: {
          path: 'src/main.ts',
          line: 12,
          side: 'head',
          hunkId: 'h1',
          anchor: 'a1',
          context: 'c1',
        },
        startRef: null,
        body: 'Existing authored comment on line 12',
        createdAt: new Date().toISOString(),
      },
    ],
  }

  const baseProps = {
    desktop: undefined,
    number: 42,
    files: null,
    read: {
      owner: { repo: 'owner/repo', viewer: 'testuser' },
      permissions: {
        viewer: 'testuser',
        isAuthor: false,
        state: 'OPEN',
        permission: 'WRITE',
        blocked: {},
      },
      threads: {
        number: 42,
        comparison: { baseOid: 'b1', headOid: 'h1', baseRef: 'refs/heads/main' },
        threads: [],
        totalCount: 0,
        truncated: false,
      },
    } satisfies ReviewThreadRead,
    readState: 'ready' as const,
    readError: null,
    getDrafts: () => draftRecord,
    resolutions: [],
    selection: null,
    onSelect: () => {},
    onClearSelection: () => {},
    onDraftChange: () => {},
    onComposerChange: () => {},
    onReload: () => {},
  }

  const queryClient = new QueryClient()
  // 1. When frozen for update installation (canCompose=false and frozenReason set):
  const frozenMarkup = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ReviewConversation, {
        ...baseProps,
        canCompose: false,
        frozenReason:
          'An update installation is in progress. Composing and saving comments are temporarily paused until installation finishes or is released.',
      }),
    ),
  )

  // The inline textarea for the draft MUST be disabled
  const frozenTextareaMatch = frozenMarkup.match(
    /<textarea[^>]*placeholder="What should the author know about these lines\?"[^>]*>/,
  )
  assert.ok(frozenTextareaMatch !== null)
  assert.match(frozenTextareaMatch[0], /disabled=""/)

  // The discard draft button MUST be disabled
  const frozenButtonMatch = frozenMarkup.match(
    /<button[^>]*aria-label="Discard pending comment[^>]*>/,
  )
  assert.ok(frozenButtonMatch !== null)
  assert.match(frozenButtonMatch[0], /disabled=""/)
  // The info alert must be visible
  assert.match(frozenMarkup, /An update installation is in progress/)

  // 2. When unlocked and composing allowed:
  const normalMarkup = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ReviewConversation, {
        ...baseProps,
        canCompose: true,
        frozenReason: null,
      }),
    ),
  )

  // In normal mode, textarea is not disabled
  const normalTextareaMatch = normalMarkup.match(
    /<textarea[^>]*placeholder="What should the author know about these lines\?"[^>]*>/,
  )

  // 3. Regression test: ordinary pending write with submission-only frozenReason remains editable
  const pendingSaveMarkup = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ReviewConversation, {
        ...baseProps,
        canCompose: true,
        frozenReason:
          'These local edits have not been saved yet. Keep editing while the write finishes, or explicitly save the retained drafts before submitting.',
      }),
    ),
  )

  const pendingTextareaMatch = pendingSaveMarkup.match(
    /<textarea[^>]*placeholder="What should the author know about these lines\?"[^>]*>/,
  )
  assert.ok(pendingTextareaMatch !== null)
  assert.doesNotMatch(pendingTextareaMatch[0], /disabled=""/)

  const pendingButtonMatch = pendingSaveMarkup.match(
    /<button[^>]*aria-label="Discard pending comment[^>]*>/,
  )
  assert.ok(pendingButtonMatch !== null)
  assert.doesNotMatch(pendingButtonMatch[0], /disabled=""/)

  // 4. Regression test: stale comparison prevents adding new draft comments but permits editing existing drafts
  const staleComparisonMarkup = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(ReviewConversation, {
        ...baseProps,
        selection: { path: 'src/main.ts', side: 'head', anchor: 10, head: 10 },
        canCompose: true,
        frozenReason:
          'Your unsent comments retain an earlier head or base comparison. Their original anchors cannot be moved to this diff.',
      }),
    ),
  )

  const addDraftButtonMatch = staleComparisonMarkup.match(
    /<button[^>]*>Add pending comment<\/button>/,
  )
  assert.ok(addDraftButtonMatch !== null)
  assert.match(addDraftButtonMatch[0], /disabled=""/)

  const staleDraftTextareaMatch = staleComparisonMarkup.match(
    /<textarea[^>]*placeholder="What should the author know about these lines\?"[^>]*>/,
  )
  assert.ok(staleDraftTextareaMatch !== null)
  assert.doesNotMatch(staleDraftTextareaMatch[0], /disabled=""/)
  assert.ok(normalTextareaMatch !== null)
  assert.doesNotMatch(normalTextareaMatch[0], /disabled=""/)
})

test('readiness listener tracks attempt nonce ownership and ignores obsolete waits and settlements', async () => {
  type ReadinessReport = { nonce: string; ready: boolean; reason?: string }
  let prepareCallback: ((payload: { nonce: string }) => void) | undefined
  let settleCallback: ((payload: { admitted: boolean; nonce?: string }) => void) | undefined
  const reports: ReadinessReport[] = []
  let report2Resolvers = Promise.withResolvers<ReadinessReport>()

  const mockDesktop = {
    onPrepareUpdateReadiness: (cb: (payload: { nonce: string }) => void): (() => void) => {
      prepareCallback = cb
      return () => {
        prepareCallback = undefined
      }
    },
    reportUpdateReadiness: async (report: ReadinessReport): Promise<boolean> => {
      reports.push(report)
      if (report.nonce === 'attempt-2') {
        report2Resolvers.resolve(report)
      }
      return true
    },
    onUpdateAdmissionSettled: (
      cb: (payload: { admitted: boolean; nonce?: string }) => void,
    ): (() => void) => {
      settleCallback = cb
      return () => {
        settleCallback = undefined
      }
    },
  }

  type MutationItem = { options: { meta?: Record<string, unknown> }; state: { status: string } }
  const mutationList: MutationItem[] = []
  const listeners = new Set<() => void>()

  const mockQueryClient = {
    getMutationCache: () => ({
      getAll: () => mutationList,
      subscribe: (l: () => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    }),
  }

  const cleanup = setupReviewDraftReadinessListener(mockDesktop, mockQueryClient)
  assert.ok(typeof prepareCallback === 'function')
  assert.ok(typeof settleCallback === 'function')
  const onPrepare = prepareCallback
  const onSettle = settleCallback

  // Initially unlocked
  assert.equal(isDraftAdmissionLocked(), false)

  // Simulate in-flight draft write
  const pendingDraft: MutationItem = {
    options: { meta: { retainedReviewDraft: true } },
    state: { status: 'pending' },
  }
  mutationList.push(pendingDraft)

  // Attempt 1 starts and acquires lock
  onPrepare({ nonce: 'attempt-1' })
  assert.equal(isDraftAdmissionLocked(), true)

  // While attempt 1 is waiting on drafts, main times out and user triggers Attempt 2
  onPrepare({ nonce: 'attempt-2' })
  assert.equal(isDraftAdmissionLocked(), true)

  // Late timeout settlement for attempt 1 arrives from main
  onSettle({ admitted: false, nonce: 'attempt-1' })
  // Must NOT unlock attempt 2!
  assert.equal(isDraftAdmissionLocked(), true)

  // Now draft write finishes for attempt 2
  pendingDraft.state.status = 'success'
  for (const l of listeners) l()

  const rep2 = await report2Resolvers.promise
  assert.equal(rep2.nonce, 'attempt-2')
  assert.equal(rep2.ready, true)

  // Verify attempt 1 never reported
  assert.equal(
    reports.some((r) => r.nonce === 'attempt-1'),
    false,
  )

  // Settlement for attempt 2 unlocks editing
  onSettle({ admitted: false, nonce: 'attempt-2' })
  assert.equal(isDraftAdmissionLocked(), false)
  cleanup()
})
