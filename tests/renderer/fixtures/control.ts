import type { UpdateStatus } from '../../../src/shared/update'
import type {
  ActionResult,
  ConflictFile,
  DesktopAPI,
  GitAction,
  GitRuntimeInfo,
  GitRuntimeStatus,
  HistoryPage,
  MergeProgress,
  MergeStatus,
  PushPreview,
  RemoteFreshness,
  RepositorySnapshot,
  SyncActivity,
  StackKind,
  StackPreview,
  SurgeryPreview,
} from '../../../src/shared/types'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsSnapshot,
} from '../../../src/shared/settings'
import {
  conflictLabels,
  conflictRegions,
  parseConflictSegments,
} from '../../../src/shared/conflict'
import type { ReviewHistoryDiff } from '../../../src/shared/review-snapshots'
import {
  parsePullRequestInboxFilterDraft,
  parsePullRequestInboxSavedFilters,
  type PullRequestInboxFilterDraft,
  type PullRequestInboxSavedFilter,
} from '../../../src/shared/pr-inbox'
import type { ReviewHeadline, ReviewViewedRecord } from '../../../src/shared/review'
import {
  fileViewFixtures,
  historyCommits,
  longDiffText,
} from '../../../src/renderer/src/design-system/data-fixtures'
import {
  insertSurgeryPreview,
  leasePreview,
  mergePreview,
  mergeStatus,
  mergeStatusQueueSentence,
  publishPreview,
  restackPreview,
  syncPreview,
} from '../../fixtures/workflow-scenarios'
import {
  reviewCommits,
  reviewFileSet,
  reviewPermissions,
  reviewRail,
  reviewThreadSet,
  stackMember,
  textFile,
} from './review'
import type { ReviewFile, ReviewLine, ReviewSide } from '../../../src/shared/review'
import type {
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewEvent,
} from '../../../src/shared/review-threads'
import { checksReportFor, scenarios } from './scenarios'
import { updateStatusFixture } from './update-status'
import { DEFAULT_SCENARIO, type ScenarioName } from './manifest'
import type { PullRequestChecksReport } from '../../../src/shared/pull-request-checks'
import type { FixtureCall, FixtureCallRecord, FixtureControl, FixtureScenario } from './types'

/** The review state GitHub reports back for each submitted event. */
const REVIEW_SUBMIT_STATES: Record<ReviewEvent, string> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
}

/** Production labels of the controls that open a repository from the onboarding pane. */
const OPEN_REPOSITORY_LABELS = ['Open local repository', 'Open repository']

/** Commits per `history()` page; the fixture list is three commits long. */
const HISTORY_PAGE_SIZE = 2

const stackPreviewsByKind: Record<StackKind, StackPreview> = {
  restack: restackPreview,
  publish: publishPreview,
  merge: mergePreview,
  sync: syncPreview,
}

function unresolved(id: string, reason: string): ReviewDraftResolution {
  return { id, match: 'unresolved', side: null, line: null, startLine: null, reason }
}

/** The line a draft's address names, or null when the file set no longer has it. */
function lineAt(
  files: ReviewFile[],
  path: string,
  side: ReviewSide,
  number: number,
): ReviewLine | null {
  const file = files.find((entry) => entry.path === path)
  if (!file || file.diff.kind !== 'text') return null
  for (const hunk of file.diff.hunks) {
    for (const line of hunk.lines) {
      if (line.side !== side) continue
      if ((side === 'base' ? line.oldLine : line.newLine) === number) return line
    }
  }
  return null
}

const bundledRuntime: GitRuntimeInfo = {
  source: 'bundled',
  executable: '/Applications/Git Stacks.app/Contents/Resources/git/bin/git',
  platform: 'darwin',
  version: '2.51.0',
  versionOutput: 'git version 2.51.0',
  minimumVersion: '2.40.0',
  meetsMinimum: true,
  useSystemGit: false,
  packaged: true,
  capabilities: { referenceTransactions: true, rebaseUpdateRefs: true },
  bundled: {
    gitVersion: '2.51.0',
    sha256: 'b'.repeat(64),
    source: 'https://github.com/git/git/releases/download/v2.51.0/git-v2.51.0.tar.xz',
  },
  preservedEnvironment: ['GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR'],
  preservedConfiguration: [],
}

const runtimeStatus = (useSystemGit: boolean): GitRuntimeStatus => ({
  runtime: { ...bundledRuntime, useSystemGit, source: useSystemGit ? 'system' : 'bundled' },
  error: null,
  minimumVersion: bundledRuntime.minimumVersion,
  useSystemGit,
})

/** Deterministic status message per action, so success notices are screenshot-stable. */
function actionMessage(action: GitAction): string {
  switch (action.type) {
    case 'switch':
      return `Switched to ${action.ref}`
    case 'createBranch':
      return `Created ${action.name} from ${action.parent}`
    case 'deleteBranch':
      return `Deleted ${action.ref}`
    case 'stage':
      return `Staged ${action.paths.length} path${action.paths.length === 1 ? '' : 's'}`
    case 'unstage':
      return `Unstaged ${action.paths.length} path${action.paths.length === 1 ? '' : 's'}`
    case 'commit':
      return action.amend ? 'Amended the last commit' : 'Committed the staged changes'
    case 'fetch':
      return 'Fetched remote updates'
    case 'push':
      return 'Pushed the current branch'
    case 'rebaseContinue':
      return 'Continued the operation'
    case 'rebaseAbort':
      return 'Aborted the operation and restored the previous state'
    case 'pull':
      return `Pulled with the ${action.strategy} strategy`
    case 'forcePush':
      return `Force pushed ${action.preview.branch} to ${action.preview.destination}`
    case 'stash':
      return 'Stashed the working changes'
    case 'stashPop':
      return `Popped ${action.ref}`
    case 'stashApply':
      return `Applied ${action.ref}`
    case 'stashDrop':
      return `Dropped ${action.ref}`
    case 'rebase':
      return `Rebased onto ${action.parent}`
    case 'createPr':
      return `Opened a${action.draft ? ' draft' : ''} pull request into ${action.base}`
    case 'renameBranch':
      return `Renamed ${action.ref} to ${action.name}`
    case 'deleteRemoteBranch':
      return `Deleted ${action.ref} from its remote`
    case 'setUpstream':
      return action.upstream ? `Tracking ${action.upstream}` : 'Stopped tracking the remote branch'
    case 'merge':
      return `Merged ${action.ref}`
    case 'cherryPick':
      return `Cherry-picked ${action.oid.slice(0, 10)}`
    case 'revert':
      return `Reverted ${action.oid.slice(0, 10)}`
    case 'operationContinue':
      return 'Continued the operation'
    case 'operationSkip':
      return 'Skipped the current commit'
    case 'operationAbort':
      return 'Aborted the operation and restored the previous state'
    case 'discardFile':
      return `Discarded unstaged changes in ${action.path}`
    case 'resolveConflict':
      return `Resolved and staged ${action.path}`
    case 'stageHunk':
      return `Staged the selected hunk in ${action.path}`
    case 'unstageHunk':
      return `Unstaged the selected hunk in ${action.path}`
    case 'conflictMergeTool':
      return `Opened the merge tool for ${action.path}`
    case 'setParent':
      return `Recorded ${action.branch} on ${action.parent}`
    case 'executeStack':
      return `Ran the ${action.mergeMethod} ${action.token} stack operation`
    case 'submitStack':
      return 'Submitted the stack'
    case 'submitStackRetry':
      return 'Resumed the stack submission'
    case 'submitStackDismiss':
      return 'Dismissed the stack submission'
    case 'stackContinue':
      return 'Continued the stack restack'
    case 'stackAbort':
      return 'Aborted the stack restack and restored the saved branch tips'
    case 'updatePr':
      return `Updated pull request #${action.number}`
    case 'closePr':
      return `Closed pull request #${action.number}`
    case 'reopenPr':
      return `Reopened pull request #${action.number}`
    case 'createNativeStack':
      return `Stacked pull requests ${action.pullRequests.map((n) => `#${n}`).join(', ')}`
    case 'addPullRequestsToNativeStack':
      return `Added pull requests ${action.pullRequests.map((n) => `#${n}`).join(', ')} to stack #${action.stackNumber}`
    case 'unstackNativeStack':
      return `Removed pull requests from stack #${action.stackNumber}`
    case 'reconcileRepair':
      return `Applied ${action.ids.length} reconciliation repairs`
    case 'linkIssue':
      return `Linked issue #${action.issueNumber} to pull request #${action.prNumber}`
    case 'unlinkIssue':
      return `Removed issue #${action.issueNumber} from pull request #${action.prNumber}`
    case 'executeSurgery':
      return `Ran the reviewed surgery ${action.token}`
  }
}

interface WaitingCall {
  call: FixtureCall
  settle: () => void
}

/**
 * Installs the typed fixture double on `window.desktop` and the control surface on
 * `window.fixture`. The returned control stays valid across `setScenario`, because the
 * double reads the mounted scenario through a closure instead of rebuilding itself.
 */
export function installFixtureControl(options: {
  scenario: string
  onScenarioChange: (name: string) => void
}): FixtureControl {
  const actions: GitAction[] = []
  const externalUrls: string[] = []
  /** Pending drafts per pull request, held for the life of the page as the real journal is. */
  const heldDrafts = new Map<number, ReviewDraftRecord>()
  const calls: FixtureCallRecord[] = []
  const holds = new Set<FixtureCall>()
  const oneShotFailures = new Map<FixtureCall, string>()
  const oneShotAnswers = new Map<FixtureCall, unknown>()
  const dropListeners = new Set<(paths: string[]) => void>()
  const released = new Set<FixtureCall>()
  const waiting: WaitingCall[] = []
  let startsPending = new Set<FixtureCall>()
  let mergeStatusReads = 0
  const mergeListeners = new Set<(progress: MergeProgress | null) => void>()
  const publishMergeProgress = (progress: MergeProgress | null): void => {
    for (const listener of mergeListeners) listener(progress)
  }
  /** Saved filters, as the main process keeps them: whole-list writes, identities preserved. */
  let inboxFilters: PullRequestInboxSavedFilter[] = []

  const scenarioFor = (name: string): FixtureScenario =>
    scenarios[name as ScenarioName] ?? scenarios[DEFAULT_SCENARIO]

  let scenario = scenarioFor(options.scenario)
  startsPending = new Set(scenario.pending ?? [])

  const record = (call: FixtureCall, args: readonly unknown[]): void => {
    calls.push({ call, args })
  }

  function answer<T>(call: FixtureCall, produce: () => T, extraFailure?: string): Promise<T> {
    const permanent = extraFailure ?? scenario.failures?.[call]
    const held = holds.has(call) || (startsPending.has(call) && !released.has(call))
    const settle = (): Promise<T> => {
      const scripted = oneShotAnswers.get(call)
      if (scripted !== undefined) {
        oneShotAnswers.delete(call)
        return Promise.resolve(scripted as T)
      }
      const queued = oneShotFailures.get(call)
      if (queued !== undefined) {
        oneShotFailures.delete(call)
        return Promise.reject(new Error(queued))
      }
      if (permanent !== undefined) return Promise.reject(new Error(permanent))
      try {
        return Promise.resolve(produce())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!held) return settle()
    return new Promise<T>((resolve, reject) => {
      waiting.push({
        call,
        settle: () => {
          settle().then(resolve, reject)
        },
      })
    })
  }

  const updateListeners = new Set<(status: UpdateStatus) => void>()
  /**
   * The snapshot repository reads are answered from. Seeded from the scenario,
   * replaced by a successful open, and reset to the newly selected scenario's
   * own snapshot when the scenario changes, because that is the world the
   * double is answering for now.
   *
   * This is not what the window is displaying. `setScenario` installs another
   * scenario's answers without remounting anything, so the App keeps the
   * repository it already opened until it opens or refreshes one itself.
   */
  let active: RepositorySnapshot | null = scenario.snapshot
  const desktop: DesktopAPI = {
    recentRepositories: () => {
      record('recentRepositories', [])
      return answer('recentRepositories', () => [...scenario.recentRepositories])
    },
    openRepository: (path) => {
      record('openRepository', path === undefined ? [] : [path])
      return answer('openRepository', () => {
        const requested = path === undefined ? undefined : scenario.snapshotsByPath?.[path]
        const opened = requested ?? scenario.snapshot
        if (!opened) throw new Error('No repository is open in this fixture.')
        // Opened is the repository that is now on screen, so every read after it
        // is answered from it. Returning the snapshot is not the same thing: the
        // selected pull request's headline, files, and threads are looked up in
        // whichever snapshot is active, and leaving the previous one active is
        // how a row for a second repository reaches a Review workspace that says
        // the pull request is not there.
        active = opened
        return opened
      })
    },
    refresh: () => {
      record('refresh', [])
      return answer('refresh', () => {
        if (!active) throw new Error('No repository is open in this fixture.')
        return active
      })
    },
    runAction: (action) => {
      record('runAction', [action])
      actions.push(action)
      // A merge reports through the progress channel the way the main process does, and it
      // reports while the run is still going: the request is accepted, GitHub is still
      // running it, and the run returns before the result exists. What GitHub reports
      // afterwards comes from a read, not from this.
      if (action.type === 'executeStack' && action.mergeMethod) {
        const layer = mergePreview.merge?.layers[0]
        if (layer) {
          publishMergeProgress({
            action: 'default',
            status: 'running',
            message: `GitHub has not reported a result for pull request #${layer.pullRequest} yet`,
            layers: [
              {
                branch: layer.branch,
                pullRequest: layer.pullRequest,
                status: 'pending',
                detail: 'GitHub has not reported a result yet; refresh to read this request',
                mergedOid: null,
                queue: null,
                requestUuid: 'fixture-request-1',
              },
            ],
          })
        }
      }
      return answer<ActionResult>(
        'runAction',
        () => ({ message: actionMessage(action) }),
        scenario.actionFailures?.[action.type],
      )
    },
    fileView: (path) => {
      record('fileView', [path])
      return answer('fileView', () => {
        const override = scenario.fileViews?.[path]
        if (override) return override
        const known = Object.values(fileViewFixtures).find((view) => view.path === path)
        return { ...(known ?? fileViewFixtures.bothSides), path }
      })
    },
    conflictView: (path) => {
      record('conflictView', [path])
      return answer<ConflictFile>('conflictView', () => {
        const view = fileViewFixtures.conflicted
        if (
          path !== view.path ||
          view.content === null ||
          !active?.files.some((file) => file.path === path && file.conflicted)
        ) {
          throw new Error(`No conflict fixture exists for ${path}.`)
        }
        return {
          path,
          kind: 'content',
          stages: [1, 2, 3],
          stagePreviewTruncated: [],
          binary: false,
          labels: conflictLabels({
            operation: active.operation,
            currentBranch: active.currentBranch,
            incomingSubject: null,
            incomingRef: null,
            stash: null,
            stashAvailable: false,
          }),
          base: 'export const value = 0\n',
          current: 'export const value = 1\n',
          incoming: 'export const value = 2\n',
          worktree: view.content,
          worktreePresent: true,
          regions: conflictRegions(parseConflictSegments(view.content)),
          moves: [],
          truncated: false,
          fingerprint: view.fingerprint,
          mergeTool: { available: false, tool: null, reason: 'No merge tool configured.' },
        }
      })
    },
    history: (ref, skip) => {
      record('history', [ref, skip])
      return answer<HistoryPage>('history', () => {
        if (scenario.history) return scenario.history
        const commits = historyCommits.slice(skip, skip + HISTORY_PAGE_SIZE)
        return { commits, hasMore: skip + commits.length < historyCommits.length }
      })
    },
    commitDiff: (oid) => {
      record('commitDiff', [oid])
      return answer(
        'commitDiff',
        () => scenario.commitDiff ?? { text: longDiffText, truncated: false },
      )
    },
    pushPreview: () => {
      record('pushPreview', [])
      return answer<PushPreview>('pushPreview', () => scenario.pushPreview ?? leasePreview)
    },
    stackPreview: (kind, branch) => {
      record('stackPreview', [kind, branch])
      return answer<StackPreview>('stackPreview', () => {
        const preview = scenario.stackPreviews?.[kind] ?? stackPreviewsByKind[kind]
        return preview.kind === kind ? preview : { ...preview, kind }
      })
    },
    surgeryPreview: (request) => {
      record('surgeryPreview', [request])
      return answer<SurgeryPreview>('surgeryPreview', () => {
        const preview = scenario.surgeryPreview ?? insertSurgeryPreview
        return preview.kind === request.kind ? preview : { ...preview, kind: request.kind }
      })
    },
    mergeStatus: () => {
      record('mergeStatus', [])
      return answer<MergeStatus>('mergeStatus', () => {
        const base = scenario.mergeStatus ?? mergeStatus
        // The queue lands the group between reads, so a refresh visibly replaces the queued
        // layer with what GitHub now reports for it; a later read fails, standing in for a
        // transport error that must not erase the last result GitHub reported.
        const read = mergeStatusReads++
        if (read === 2) throw new Error('GitHub is unreachable')
        if (read === 0) return base
        return {
          ...base,
          layers: base.layers.map((layer) =>
            layer.status === 'enqueued'
              ? {
                  ...layer,
                  status: 'merged' as const,
                  detail: 'Merged on GitHub as 4444444444',
                  mergedOid: '4444444444444444444444444444444444444444',
                  queue: { ...layer.queue!, outcome: 'merged' as const },
                }
              : layer,
          ),
          message: base.message.replace(mergeStatusQueueSentence, 'Pull request #40 merged.'),
        }
      })
    },
    pullRequest: (number) => {
      record('pullRequest', [number])
      return answer('pullRequest', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        return {
          ...found,
          body: `${found.title}\n\nDeterministic fixture body for pull request #${number}.`,
        }
      })
    },
    onMergeProgress: (listener) => {
      mergeListeners.add(listener)
      return () => {
        mergeListeners.delete(listener)
      }
    },
    reviewHeadline: (number) => {
      record('reviewHeadline', [number])
      return answer('reviewHeadline', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        // A pull request carries only its own position; the layer list comes
        // from every pull request in the snapshot that names the same stack.
        const membership = found.stack
          ? (active?.pullRequests
              .filter((pr) => pr.stack?.stackNumber === found.stack?.stackNumber)
              .map((pr) =>
                stackMember(pr.stack?.position ?? 1, pr.number, found.stack?.size ?? 1),
              ) ?? null)
          : null
        const value: ReviewHeadline = {
          pullRequest: {
            ...found,
            body: `${found.title}\n\nDeterministic fixture body for pull request #${number}.`,
          },
          rail: reviewRail(found, membership),
        }
        return value
      })
    },
    reviewFiles: (number) => {
      record('reviewFiles', [number])
      return answer('reviewFiles', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        return reviewFileSet(number, scenario.reviewHeadOid ?? found.headOid ?? `head-${number}`)
      })
    },
    reviewCommits: (number) => {
      record('reviewCommits', [number])
      return answer('reviewCommits', () => reviewCommits(number))
    },
    reviewViewed: () => {
      record('reviewViewed', [])
      return answer('reviewViewed', () => null)
    },
    reviewSetViewed: (record_) => {
      record('reviewSetViewed', [record_])
      return answer('reviewSetViewed', () => record_ as ReviewViewedRecord)
    },
    reviewThreads: (number) => {
      record('reviewThreads', [number])
      return answer('reviewThreads', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const headOid = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        return {
          threads: reviewThreadSet(number, headOid),
          permissions: reviewPermissions(number, scenario.reviewPermissions),
        }
      })
    },
    reviewDrafts: (number) => {
      record('reviewDrafts', [number])
      // The real journal outlives the workspace, so the double keeps drafts for
      // the life of the page: leaving the review workspace and coming back has
      // to show the pending comments again, which is the behaviour being proven.
      return answer('reviewDrafts', () => heldDrafts.get(number) ?? null)
    },
    reviewSetDrafts: (draftRecord) => {
      record('reviewSetDrafts', [draftRecord])
      heldDrafts.set(draftRecord.number, draftRecord)
      return answer('reviewSetDrafts', () => draftRecord as ReviewDraftRecord)
    },
    reviewSubmit: (number, submission) => {
      record('reviewSubmit', [number, submission])
      return answer('reviewSubmit', () => ({
        id: `review-${number}`,
        state: REVIEW_SUBMIT_STATES[submission.event],
        url: `https://github.com/acme/widgets/pull/${number}#pullrequestreview-1`,
      }))
    },
    reviewReply: (number, threadId) => {
      record('reviewReply', [number, threadId])
      return answer('reviewReply', () => ({
        id: `reply-${threadId}`,
        state: 'COMMENTED',
        url: `https://github.com/acme/widgets/pull/${number}#discussion_r9`,
      }))
    },
    reviewSetResolved: (number, threadId, resolved) => {
      record('reviewSetResolved', [number, threadId, resolved])
      return answer('reviewSetResolved', () => ({
        id: threadId,
        state: resolved ? 'RESOLVED' : 'UNRESOLVED',
        url: null,
      }))
    },
    reviewHistory: (number) => {
      record('reviewHistory', [number])
      return answer('reviewHistory', () => {
        if (scenario.reviewHistory) {
          return typeof scenario.reviewHistory === 'function'
            ? scenario.reviewHistory(number)
            : scenario.reviewHistory
        }
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const historicalHead = '1111222233334444555566667777888899990000'
        return {
          number,
          current: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
          },
          latest: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-24T10:00:00.000Z',
            lastSeenAt: '2026-09-25T12:00:00.000Z',
            observations: 2,
            reviewed: false,
            reviewedAt: null,
            reviewId: null,
          },
          reviewed: {
            headOid: historicalHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-22T08:00:00.000Z',
            lastSeenAt: '2026-09-23T09:00:00.000Z',
            observations: 3,
            reviewed: true,
            reviewedAt: '2026-09-23T09:00:00.000Z',
            reviewId: 'PRR_reviewed_1',
          },
          snapshots: [
            {
              headOid: historicalHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-22T08:00:00.000Z',
              lastSeenAt: '2026-09-23T09:00:00.000Z',
              observations: 3,
              reviewed: true,
              reviewedAt: '2026-09-23T09:00:00.000Z',
              reviewId: 'PRR_reviewed_1',
            },
            {
              headOid: currentHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-24T10:00:00.000Z',
              lastSeenAt: '2026-09-25T12:00:00.000Z',
              observations: 2,
              reviewed: false,
              reviewedAt: null,
              reviewId: null,
            },
          ],
          gap: null,
        }
      })
    },
    reviewHistoryDiff: (number, fromOid) => {
      record('reviewHistoryDiff', [number, fromOid])
      return answer('reviewHistoryDiff', () => {
        if (scenario.reviewHistoryDiff) {
          return typeof scenario.reviewHistoryDiff === 'function'
            ? scenario.reviewHistoryDiff(number, fromOid)
            : scenario.reviewHistoryDiff
        }
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const fromSnapshot = {
          headOid: fromOid,
          baseOid: 'b'.repeat(40),
          baseRef: 'main',
          firstSeenAt: '2026-09-22T08:00:00.000Z',
          lastSeenAt: '2026-09-23T09:00:00.000Z',
          observations: 1,
          reviewed: true,
          reviewedAt: '2026-09-23T09:00:00.000Z',
          reviewId: 'PRR_reviewed_1',
        }
        if (fromOid.startsWith('missing') || fromOid === 'deadbeef'.padEnd(40, '0')) {
          const diff: ReviewHistoryDiff = {
            number,
            state: 'unavailable',
            reason: `Historical commit ${fromOid.slice(0, 7)} is no longer in this repository (it may have been garbage-collected after a force-push).`,
            from: fromSnapshot,
            to: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
            mergeBaseOid: null,
            files: [],
            additions: 0,
            deletions: 0,
            truncated: false,
          }
          return diff
        }
        const diff: ReviewHistoryDiff = {
          number,
          state: 'files',
          reason: '',
          from: fromSnapshot,
          to: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
          mergeBaseOid: 'b'.repeat(40),
          files: [
            textFile('src/main/review.ts', '@@ -2,2 +2,2 @@', [
              ['-  return stagedDiff()', 2, null],
              ['+  return transportDiff()', null, 2],
            ]),
          ],
          additions: 1,
          deletions: 1,
          truncated: false,
        }
        return diff
      })
    },
    reviewClearHistory: (number) => {
      record('reviewClearHistory', [number])
      return answer('reviewClearHistory', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const currentHead = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        return {
          number,
          current: { headOid: currentHead, baseOid: 'b'.repeat(40), baseRef: 'main' },
          latest: {
            headOid: currentHead,
            baseOid: 'b'.repeat(40),
            baseRef: 'main',
            firstSeenAt: '2026-09-25T12:00:00.000Z',
            lastSeenAt: '2026-09-25T12:00:00.000Z',
            observations: 1,
            reviewed: false,
            reviewedAt: null,
            reviewId: null,
          },
          reviewed: null,
          snapshots: [
            {
              headOid: currentHead,
              baseOid: 'b'.repeat(40),
              baseRef: 'main',
              firstSeenAt: '2026-09-25T12:00:00.000Z',
              lastSeenAt: '2026-09-25T12:00:00.000Z',
              observations: 1,
              reviewed: false,
              reviewedAt: null,
              reviewId: null,
            },
          ],
          gap: null,
        }
      })
    },
    reviewResolveDrafts: (number, drafts) => {
      record('reviewResolveDrafts', [number, drafts])
      return answer('reviewResolveDrafts', () => {
        const found = active?.pullRequests.find((pr) => pr.number === number)
        const headOid = scenario.reviewHeadOid ?? found?.headOid ?? `head-${number}`
        const files = reviewFileSet(number, headOid)
        // The main process re-resolves each anchor against a freshly read file
        // set; the double answers for the set it already serves, so a draft the
        // reviewer just wrote is exact and a draft naming a line the fixture does
        // not have is unresolved with a reason. A range is never re-anchored
        // across a side, exactly as the real resolver refuses.
        return drafts.map((draft) => {
          const line = lineAt(files.files, draft.ref.path, draft.ref.side, draft.ref.line)
          const start = draft.startRef ?? null
          const startLine = start ? lineAt(files.files, start.path, start.side, start.line) : null
          if (start && (start.side !== draft.ref.side || start.line > draft.ref.line)) {
            return unresolved(
              draft.id,
              'The two ends of this comment are not one range on the same side of the diff.',
            )
          }
          if (!line) {
            return unresolved(
              draft.id,
              `${draft.ref.path} no longer holds line ${draft.ref.line} on the ${draft.ref.side}.`,
            )
          }
          if (start && !startLine) {
            return unresolved(
              draft.id,
              `${start.path} no longer holds the first line of this comment.`,
            )
          }
          return {
            id: draft.id,
            match: 'exact' as const,
            side: draft.ref.side,
            line: draft.ref.side === 'base' ? line.oldLine : line.newLine,
            startLine:
              startLine && draft.startRef?.side === 'base'
                ? startLine.oldLine
                : (startLine?.newLine ?? null),
            reason: '',
          }
        })
      })
    },
    openExternal: (url) => {
      record('openExternal', [url])
      externalUrls.push(url)
      return answer('openExternal', () => undefined)
    },
    pullRequestChecks: (number, options) => {
      record('pullRequestChecks', [number, options])
      return answer<PullRequestChecksReport>('pullRequestChecks', () => {
        const report = checksReportFor(scenario, number, active)
        if (!report) throw new Error(`Pull request #${number} is not in this scenario.`)
        return report
      })
    },
    rerunPullRequestCheck: (number, runId) => {
      record('rerunPullRequestCheck', [number, runId])
      return answer<PullRequestChecksReport>('rerunPullRequestCheck', () => {
        const report = checksReportFor(scenario, number, active)
        if (!report) throw new Error(`Pull request #${number} is not in this scenario.`)
        if (!report.checks.some((check) => check.workflowRunId === runId)) {
          throw new Error('That workflow run no longer belongs to this pull request head.')
        }
        return {
          ...report,
          freshness: 'live',
          staleReason: null,
          message: `Rerun requested for workflow run ${runId}.`,
          checkedAt: report.checkedAt ?? report.fetchedAt,
        }
      })
    },
    gitRuntimeStatus: () => {
      record('gitRuntimeStatus', [])
      return answer('gitRuntimeStatus', () => runtimeStatus(false))
    },
    setSystemGit: (enabled) => {
      record('setSystemGit', [enabled])
      return answer('setSystemGit', () => runtimeStatus(enabled))
    },
    cancel: (requestId) => {
      record('cancel', [requestId])
      return answer('cancel', () => undefined)
    },
    searchIssues: (query) => {
      record('searchIssues', [query])
      return answer('searchIssues', () => {
        const terms = query.toLowerCase().replace(/^#+/u, '')
        const issues = (active?.issues ?? []).filter((iss) => {
          if (String(iss.number) === terms || `#${iss.number}` === terms) return true
          return iss.title.toLowerCase().includes(terms)
        })
        return { issues, message: '' }
      })
    },
    pullRequestIssueLinks: (prNumber) => {
      record('pullRequestIssueLinks', [prNumber])
      return answer('pullRequestIssueLinks', () => ({
        prNumber,
        links: [...(scenario.issueLinks?.[prNumber] ?? [])],
      }))
    },
    previewIssueLink: (prNumber, issueNumber, relation, action) => {
      record('previewIssueLink', [prNumber, issueNumber, relation, action])
      return answer('previewIssueLink', () => {
        const found = active?.pullRequests.find((pr) => pr.number === prNumber)
        const closing = (scenario.issueLinks?.[prNumber] ?? []).find(
          (link) => link.relation === 'closing',
        )
        const existingClause = closing ? `\n\nCloses #${closing.number}\n` : '\n'
        const currentBody = found
          ? `${found.title}\n\nDeterministic fixture body for pull request #${prNumber}.${existingClause}`
          : ''
        const closingSyntax = `Closes #${issueNumber}`
        const newBody =
          action === 'link'
            ? `${currentBody.trimEnd()}\n\n${closingSyntax}\n`
            : closing
              ? currentBody.replace(`\n\nCloses #${closing.number}\n`, '\n')
              : currentBody
        return {
          prNumber,
          issueNumber,
          relation,
          action,
          currentBody,
          newBody,
          changed: newBody !== currentBody,
          ...(relation === 'closing' ? { closingSyntax } : {}),
        }
      })
    },

    gitEnvironment: (requestId) => {
      record('gitEnvironment', [requestId])
      return answer('gitEnvironment', () => ({
        ok: true as const,
        value: {
          identity: { name: 'Ada Lovelace', email: 'ada@example.invalid' },
          defaultBranch: 'main',
          httpsCredentials: { configured: true, helper: 'osxkeychain' },
          ssh: { available: true, version: '9.8p1' },
        },
      }))
    },
    searchRepositories: (request) => {
      record('searchRepositories', [request])
      return answer('searchRepositories', () => {
        const query = request.query?.trim() ?? ''
        if (query === 'sso-error') {
          return {
            ok: false as const,
            failure: {
              reason: 'sso-denied' as const,
              message: 'This organization requires single sign-on.',
            },
          }
        }
        const items =
          query === 'empty-repo'
            ? [
                {
                  name: 'empty-repo',
                  fullName: 'acme/empty-repo',
                  owner: 'acme',
                  description: 'An empty repository with no commits yet',
                  private: false,
                  fork: false,
                  archived: false,
                  empty: true,
                  language: null,
                  defaultBranch: 'main',
                  pushedAt: null,
                  url: 'https://github.com/acme/empty-repo',
                  httpsUrl: 'https://github.com/acme/empty-repo.git',
                  sshUrl: 'git@github.com:acme/empty-repo.git',
                  canPush: true,
                  host: 'github.com',
                },
              ]
            : [
                {
                  name: 'git-stacks',
                  fullName: 'howarewoo/git-stacks',
                  owner: 'howarewoo',
                  description: 'Stacked Git pull requests on GitHub',
                  private: false,
                  fork: false,
                  archived: false,
                  empty: false,
                  language: 'TypeScript',
                  defaultBranch: 'main',
                  pushedAt: '2026-09-29T00:00:00Z',
                  url: 'https://github.com/howarewoo/git-stacks',
                  httpsUrl: 'https://github.com/howarewoo/git-stacks.git',
                  sshUrl: 'git@github.com:howarewoo/git-stacks.git',
                  canPush: true,
                  host: 'github.com',
                },
                {
                  name: 'widgets',
                  fullName: 'acme/widgets',
                  owner: 'acme',
                  description: 'Sample widget repository',
                  private: true,
                  fork: false,
                  archived: false,
                  empty: false,
                  language: 'TypeScript',
                  defaultBranch: 'main',
                  pushedAt: '2026-09-28T00:00:00Z',
                  url: 'https://github.com/acme/widgets',
                  httpsUrl: 'https://github.com/acme/widgets.git',
                  sshUrl: 'git@github.com:acme/widgets.git',
                  canPush: true,
                  host: 'github.com',
                },
              ]
        return {
          ok: true as const,
          value: {
            repositories: items,
            query,
            totalCount: items.length,
            truncated: false,
          },
        }
      })
    },
    previewCloneCommand: (request) => {
      record('previewCloneCommand', [request])
      const url =
        request.protocol === 'ssh' ? request.repository.sshUrl : request.repository.httpsUrl
      return answer('previewCloneCommand', () => ({
        ok: true as const,
        value: {
          gitCommand: `git clone ${url} "${request.parentDirectory}/${request.directoryName}"`,
          ghCommand: `gh repo clone ${request.repository.fullName} "${request.parentDirectory}/${request.directoryName}"`,
        },
      }))
    },
    chooseDestinationDirectory: (current) => {
      record('chooseDestinationDirectory', [current])
      return answer('chooseDestinationDirectory', () => '/mock/workspaces')
    },
    cloneRepository: (request) => {
      record('cloneRepository', [request])
      return answer('cloneRepository', () => {
        if (request.directoryName === 'collision') {
          return {
            ok: false as const,
            failure: {
              reason: 'destination-exists' as const,
              message: 'collision already exists in that folder. Choose another name.',
            },
          }
        }
        return {
          ok: true as const,
          value: {
            path: `${request.parentDirectory}/${request.directoryName}`,
            name: request.directoryName,
            empty: request.repository.empty,
            gitCommand: `git clone https://github.com/${request.repository.fullName}.git "${request.parentDirectory}/${request.directoryName}"`,
            ghCommand: `gh repo clone ${request.repository.fullName} "${request.parentDirectory}/${request.directoryName}"`,
          },
        }
      })
    },
    addRepository: (path) => {
      record('addRepository', [path])
      return answer('addRepository', () => scenario.snapshot)
    },
    onRepositoryDropped: (listener) => {
      dropListeners.add(listener)
      return () => dropListeners.delete(listener)
    },
    updateStatus: () => {
      record('updateStatus', [])
      return answer('updateStatus', () => updateStatusFixture.idle)
    },
    checkForUpdates: () => {
      record('checkForUpdates', [])
      return answer('checkForUpdates', () => updateStatusFixture.available)
    },
    downloadUpdate: () => {
      record('downloadUpdate', [])
      return answer('downloadUpdate', () => updateStatusFixture.downloaded)
    },
    installUpdate: () => {
      record('installUpdate', [])
      return answer('installUpdate', () => updateStatusFixture.downloaded)
    },
    cancelUpdate: () => {
      record('cancelUpdate', [])
      return answer('cancelUpdate', () => updateStatusFixture.cancelled)
    },
    onUpdateStatus: (listener) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    pullRequestInbox: (request) => {
      record('pullRequestInbox', request ? [request] : [])
      return answer('pullRequestInbox', () => {
        if (!scenario.inbox) throw new Error('This fixture has no PR Inbox read behind it.')
        return scenario.inbox
      })
    },
    pullRequestInboxFilters: () => {
      record('pullRequestInboxFilters', [])
      return answer('pullRequestInboxFilters', () => [...inboxFilters])
    },
    savePullRequestInboxFilters: (drafts) => {
      record('savePullRequestInboxFilters', [drafts])
      return answer('savePullRequestInboxFilters', () => {
        // The main process owns the file and the identities in it: a draft that
        // names a filter it already stored keeps that filter's id, and every
        // other one is minted here. The window only ever sees what came back.
        //
        // Every draft is validated before anything is replaced, and an invalid
        // one refuses the whole write. Dropping just that draft would delete a
        // filter the person believes is still there, because the view removes
        // the old version from the submitted list before appending its
        // replacement: the stored filter would vanish with no error at all.
        const known = new Set(inboxFilters.map((filter) => filter.id))
        const used = new Set<string>()
        const next: PullRequestInboxSavedFilter[] = []
        for (const draft of drafts) {
          const parsed = parsePullRequestInboxFilterDraft(draft)
          if (!parsed) throw new Error('A saved filter needs a name, a group, and a valid search.')
          const id =
            parsed.id && known.has(parsed.id) && !used.has(parsed.id)
              ? parsed.id
              : crypto.randomUUID()
          if (used.has(id)) continue
          used.add(id)
          next.push({
            id,
            name: parsed.name,
            group: parsed.group,
            search: parsed.search,
            repository: parsed.repository,
          })
        }
        inboxFilters = parsePullRequestInboxSavedFilters(next)
        return [...inboxFilters]
      })
    },
  }

  /**
   * The settings file and the account behind it, for a scenario that declares
   * them.
   *
   * Both surfaces are installed only where they were asked for. A window with
   * no settings has no host to compare its queue against, so nothing retires
   * that queue at mount — and giving every scenario both would retire it on
   * mount for a reason those fixtures are not built to show, which would hide
   * the difference instead of demonstrating it.
   */
  // Read only from inside the surfaces below, which exist only where a scenario
  // declared an identity. The fallback stands in for a window that declared
  // none, where nothing here is ever called.
  let settings: AppSettings = scenario.identity?.settings ?? DEFAULT_SETTINGS
  const identity = scenario.identity
  if (identity) {
    const settingsSnapshot = (): SettingsSnapshot => ({
      settings: { ...settings },
      locks: [],
      issues: [],
      recovered: false,
      file: '/tmp/git-stacks-fixture-settings.json',
    })
    desktop.settings = () => {
      record('settings', [])
      return answer('settings', settingsSnapshot)
    }
    desktop.updateSettings = (patch) => {
      record('updateSettings', [patch])
      return answer('updateSettings', () => {
        // Whole-file writes, exactly as Main keeps them: an omitted group keeps
        // its stored value, and a group that was offered is folded into the one
        // already stored, so the window only ever sees what came back.
        settings = {
          ...settings,
          github: { ...settings.github, ...patch.github },
          git: { ...settings.git, ...patch.git },
          appearance: { ...settings.appearance, ...patch.appearance },
          privacy: { ...settings.privacy, ...patch.privacy },
          updates: { ...settings.updates, ...patch.updates },
          shortcuts: { ...settings.shortcuts, ...patch.shortcuts },
        }
        return settingsSnapshot()
      })
    }
    // Main always answers with a status: a host that has named none reports
    // itself signed out, never nothing at all.
    desktop.githubAccountStatus = () => {
      record('githubAccountStatus', [])
      return answer('githubAccountStatus', () => identity.account)
    }
  }

  const control: FixtureControl = {
    get scenario() {
      return scenario.name
    },
    actions,
    externalUrls,
    calls,
    get pending(): FixtureCall[] {
      const kinds = new Set<FixtureCall>(holds)
      for (const call of startsPending) {
        if (!released.has(call)) kinds.add(call)
      }
      // A call the scenario being left started pending is still outstanding
      // once that scenario's list is gone, so it stays visible here until it
      // actually settles. Hiding it would report a busy window as idle.
      for (const item of waiting) kinds.add(item.call)
      return [...kinds]
    },
    setScenario(name) {
      scenario = scenarioFor(name)
      // This double is installed once and outlives any number of scenario
      // changes. Only the answers change here: the mounted window keeps the
      // repository it opened, its destination, and its reads in flight, so
      // what it displays is deliberately not reset along with them.
      active = scenario.snapshot
      startsPending = new Set(scenario.pending ?? [])
      released.clear()
      options.onScenarioChange(scenario.name)
    },
    hold(call) {
      holds.add(call)
    },
    release(call, occurrence?: 'oldest' | 'newest') {
      // Retained waiters are release-all targets even when their kind is no
      // longer in this scenario's pending list. Their promises are outstanding,
      // so leaving them out would strand whatever the window is waiting on and
      // make a held boot or open look like it can never finish.
      const targets = call
        ? [call]
        : [...new Set([...holds, ...startsPending, ...waiting.map((item) => item.call)])]
      let settled = 0
      for (const target of targets) {
        // Oldest first, which is the order the calls were started in. A release
        // has to be able to say which of several pending calls answers first:
        // `failNext` is consumed by the first of them to settle, so settling
        // newest-first would silently hand a one-shot failure to the read the
        // test just started instead of the one it abandoned.
        const due = waiting.filter((item) => item.call === target)
        const chosen =
          occurrence === 'newest' ? due.slice(-1) : occurrence === 'oldest' ? due.slice(0, 1) : due
        waiting.splice(0, waiting.length, ...waiting.filter((item) => !chosen.includes(item)))
        for (const entry of chosen) {
          entry.settle()
          settled += 1
        }
        if (occurrence === undefined || waiting.every((item) => item.call !== target)) {
          released.add(target)
          holds.delete(target)
        }
      }
      return settled
    },
    failNext(call, message) {
      oneShotFailures.set(call, message ?? `Git Stacks fixture: ${call} failed`)
    },
    answerNext(call, value) {
      oneShotAnswers.set(call, value)
    },
    connect() {
      if (!scenario.snapshot) return
      const openControl = [...document.querySelectorAll('button')].find((button) =>
        OPEN_REPOSITORY_LABELS.some((label) => button.textContent?.includes(label)),
      )
      openControl?.click()
    },
    reset() {
      actions.length = 0
      externalUrls.length = 0
      calls.length = 0
      holds.clear()
      oneShotFailures.clear()
      oneShotAnswers.clear()
      released.clear()
      waiting.length = 0
    },
    pushFreshness(value) {
      push('repository:remote-status', value)
    },
    pushSnapshot(value) {
      push('repository:background-snapshot', value)
    },
    dropRepository(paths) {
      for (const listener of dropListeners) listener(paths)
    },
  }

  // The main process's live-sync surface: the App subscribes to the pushes its
  // watcher and refresh timers make, reports window activity, and can be asked
  // for the current freshness. The control drives all of it, so a test walks the
  // same path a real background refresh does.
  const subscribers = new Map<string, (value: never) => void>()
  let freshness: RemoteFreshness | null = scenario.snapshot?.remote ?? null
  const push = (channel: string, value: unknown): void => {
    if (channel === 'repository:remote-status') freshness = value as RemoteFreshness
    subscribers.get(channel)?.(value as never)
  }
  const live = desktop as DesktopAPI & {
    reportActivity: (activity: SyncActivity) => Promise<void>
    remoteStatus: () => Promise<RemoteFreshness>
    dismissPendingMutation: (id: string) => Promise<void>
  }
  live.reportActivity = async () => {}
  // The main process always has a state for the open repository; before one is
  // attached it reports the state the snapshot carried.
  live.remoteStatus = async () =>
    freshness ?? {
      state: 'stale',
      fetchedAt: null,
      checkedAt: null,
      detail: null,
      rateLimitReset: null,
      pendingMutations: [],
    }
  live.dismissPendingMutation = async (id: string) => {
    if (!freshness) return
    freshness = {
      ...freshness,
      pendingMutations: freshness.pendingMutations.filter((entry) => entry.id !== id),
    }
  }
  const channelToMethod: Record<string, string> = {
    'repository:background-snapshot': 'onBackgroundSnapshot',
    'repository:background-issues': 'onBackgroundIssues',
    'repository:remote-status': 'onRemoteStatus',
  }
  for (const [channel, method] of Object.entries(channelToMethod)) {
    void ((live as unknown as Record<string, unknown>)[method] = (
      listener: (value: never) => void,
    ): (() => void) => {
      subscribers.set(channel, listener)
      return () => {
        if (subscribers.get(channel) === listener) subscribers.delete(channel)
      }
    })
  }

  window.desktop = desktop
  window.fixture = control
  return control
}
