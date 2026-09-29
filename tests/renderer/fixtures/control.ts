import type {
  ActionResult,
  ConflictFile,
  DesktopAPI,
  GitAction,
  GitRuntimeInfo,
  GitRuntimeStatus,
  HistoryPage,
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
import {
  fileViewFixtures,
  historyCommits,
  longDiffText,
} from '../../../src/renderer/src/design-system/data-fixtures'
import {
  insertSurgeryPreview,
  leasePreview,
  mergePreview,
  publishPreview,
  restackPreview,
  syncPreview,
} from '../../fixtures/workflow-scenarios'
import { scenarios } from './scenarios'
import { DEFAULT_SCENARIO, type ScenarioName } from './manifest'
import type { FixtureCall, FixtureCallRecord, FixtureControl, FixtureScenario } from './types'

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
  const calls: FixtureCallRecord[] = []
  const holds = new Set<FixtureCall>()
  const oneShotFailures = new Map<FixtureCall, string>()
  const released = new Set<FixtureCall>()
  const waiting: WaitingCall[] = []
  let startsPending = new Set<FixtureCall>()

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
