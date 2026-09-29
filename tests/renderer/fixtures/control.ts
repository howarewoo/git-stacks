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
  conflictLabels,
  conflictRegions,
  parseConflictSegments,
} from '../../../src/shared/conflict'
import type { ReviewHistoryDiff } from '../../../src/shared/review-snapshots'
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
import { reviewCommits, reviewFileSet, reviewPermissions, reviewRail, reviewThreadSet, stackMember, textFile } from './review'
import type { ReviewFile, ReviewLine, ReviewSide } from '../../../src/shared/review'
import type {
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewEvent,
} from '../../../src/shared/review-threads'
import { scenarios } from './scenarios'
import { DEFAULT_SCENARIO, type ScenarioName } from './manifest'
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
  const released = new Set<FixtureCall>()
  const waiting: WaitingCall[] = []
  let startsPending = new Set<FixtureCall>()
  let mergeStatusReads = 0
  const mergeListeners = new Set<(progress: MergeProgress | null) => void>()
  const publishMergeProgress = (progress: MergeProgress | null): void => {
    for (const listener of mergeListeners) listener(progress)
  }

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

  const desktop: DesktopAPI = {
    recentRepositories: () => {
      record('recentRepositories', [])
      return answer('recentRepositories', () => [...scenario.recentRepositories])
    },
    openRepository: (path) => {
      record('openRepository', path === undefined ? [] : [path])
      return answer('openRepository', () => scenario.snapshot)
    },
    refresh: () => {
      record('refresh', [])
      return answer('refresh', () => {
        if (!scenario.snapshot) throw new Error('No repository is open in this fixture.')
        return scenario.snapshot
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
          !scenario.snapshot?.files.some((file) => file.path === path && file.conflicted)
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
            operation: scenario.snapshot.operation,
            currentBranch: scenario.snapshot.currentBranch,
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
        if (!found) throw new Error(`Pull request #${number} is not in this fixture snapshot.`)
        // A pull request carries only its own position; the layer list comes
        // from every pull request in the snapshot that names the same stack.
        const membership = found.stack
          ? (scenario.snapshot?.pullRequests
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === number)
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
            return unresolved(draft.id, 'The two ends of this comment are not one range on the same side of the diff.')
          }
          if (!line) {
            return unresolved(draft.id, `${draft.ref.path} no longer holds line ${draft.ref.line} on the ${draft.ref.side}.`)
          }
          if (start && !startLine) {
            return unresolved(draft.id, `${start.path} no longer holds the first line of this comment.`)
          }
          return {
            id: draft.id,
            match: 'exact' as const,
            side: draft.ref.side,
            line: draft.ref.side === 'base' ? line.oldLine : line.newLine,
            startLine:
              startLine && draft.startRef?.side === 'base' ? startLine.oldLine : (startLine?.newLine ?? null),
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
        const issues = (scenario.snapshot?.issues ?? []).filter((iss) => {
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
        const found = scenario.snapshot?.pullRequests.find((pr) => pr.number === prNumber)
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
      return [...kinds]
    },
    setScenario(name) {
      scenario = scenarioFor(name)
      startsPending = new Set(scenario.pending ?? [])
      released.clear()
      waiting.length = 0
      options.onScenarioChange(scenario.name)
    },
    hold(call) {
      holds.add(call)
    },
    release(call) {
      const targets = call ? [call] : [...new Set([...holds, ...startsPending])]
      let settled = 0
      for (const target of targets) {
        released.add(target)
        holds.delete(target)
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          if (waiting[index].call !== target) continue
          const [entry] = waiting.splice(index, 1)
          entry.settle()
          settled += 1
        }
      }
      return settled
    },
    failNext(call, message) {
      oneShotFailures.set(call, message ?? `Git Stacks fixture: ${call} failed`)
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
      released.clear()
      waiting.length = 0
    },
    pushFreshness(value) {
      push('repository:remote-status', value)
    },
    pushSnapshot(value) {
      push('repository:background-snapshot', value)
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
