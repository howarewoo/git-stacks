import * as React from 'react'
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileQuestion,
  GitCommitHorizontal,
  Layers,
  LoaderCircle,
  MessageSquareDiff,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import type {
  ReviewCommitSet,
  ReviewComparison,
  ReviewDiffMode,
  ReviewFile,
  ReviewFileSet,
  ReviewHeadline,
  ReviewStackRail,
  ReviewViewedRecord,
} from '../../../shared/review'
import {
  adjacentReviewFileIndex,
  REVIEW_STATUS_LABELS,
  reviewFileRows,
  reviewStatusLetter,
  summarizeReviewFiles,
  viewedPaths,
  visibleReviewFileRows,
  withViewedFile,
} from '../../../shared/review'
import type {
  DesktopAPI,
  PullRequest,
  PullRequestStackMember,
  RepositorySnapshot,
} from '../../../shared/types'
import { LIST_PAGE_SIZE } from '../../../shared/performance'
import { Badge } from './ui/badge'
import { Select } from './ui/select'
import { Input } from './ui/input'
import { Button, IconButton } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { SegmentedControl } from './ui/segmented-control'
import { EmptyState, InlineAlert } from './ui/surface'
import { checkLabel, checksVariant, reviewLabel, reviewVariant } from '../lib/pull-request-state'
import { WORKSPACE_VIEW_HEADING_ID } from './workspace-navigation'
import { createRequestGate } from '../lib/request-gate'
import { cn } from '../lib/utils'
import { claimsRovingKey, rovingAction, rovingTabIndex, rovingTarget } from '../lib/tree-navigation'
import { ReviewConversation, type ReviewSelection } from './review-conversation'
import { sameReviewComparison } from '../../../shared/review'
import { withReviewDraft } from '../../../shared/review-threads'
import type {
  ReviewDraft,
  ReviewDraftRecord,
  ReviewDraftResolution,
  ReviewThreadRead,
} from '../../../shared/review-threads'
import { ReviewDiff } from './review-diff'
import type {
  ReviewHistory,
  ReviewHistoryDiff,
  ReviewSnapshot,
} from '../../../shared/review-snapshots'
import { reviewHistoryUnchangedPaths, reviewSnapshotLabel } from '../../../shared/review-snapshots'
import { PullRequestChecksPanel } from './check-details'
import type { PullRequestChecksReport } from '../../../shared/pull-request-checks'

/**
 * The four review commands the shell's global shortcuts dispatch. They are
 * published through a ref so the shell owns every remappable key while this view
 * owns what those keys mean; a view that registered its own listener would compete
 * with the shell for the same keystrokes.
 */
export interface ReviewCommands {
  nextFile: () => void
  previousFile: () => void
  nextLayer: () => void
  previousLayer: () => void
}

type Stage = 'idle' | 'loading' | 'ready' | 'failed'

function readableError(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  return 'GitHub did not return review data.'
}

export function ReviewView({
  authority,
  desktop,
  pullRequests,
  stackContext,
  number,
  onSelectNumber,
  onManageNumber,
  commands,
}: {
  /**
   * The CLI authority the review data on screen was read under: the host, the
   * state, the account, and the opaque credential generation behind it.
   *
   * Everything this view shows — the pull request's own files and comments,
   * the threads, and the pending words the reviewer typed — was read as that
   * authority, so a replacement retires all of it by itself rather than
   * waiting for the selected pull request number to change. A number can
   * survive an account switch and describe somebody else's pull request.
   */
  authority: string
  desktop: DesktopAPI | undefined
  pullRequests: readonly PullRequest[]
  stackContext: Pick<RepositorySnapshot, 'branches' | 'reconciliation'>
  number: number | null
  onSelectNumber: (number: number) => void
  onManageNumber: (number: number) => void
  commands: React.MutableRefObject<ReviewCommands | null>
}) {
  const [headline, setHeadline] = React.useState<ReviewHeadline | null>(null)
  const [files, setFiles] = React.useState<ReviewFileSet | null>(null)
  const [commits, setCommits] = React.useState<ReviewCommitSet | null>(null)
  const [viewed, setViewed] = React.useState<ReviewViewedRecord | null>(null)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [mode, setMode] = React.useState<ReviewDiffMode>('unified')
  const [threadRead, setThreadRead] = React.useState<ReviewThreadRead | null>(null)
  const [threadState, setThreadState] = React.useState<Stage>('idle')
  const [threadError, setThreadError] = React.useState<string | null>(null)
  const [draftRecord, setDraftRecord] = React.useState<ReviewDraftRecord | null>(null)
  const [resolutions, setResolutions] = React.useState<ReviewDraftResolution[]>([])
  const [selection, setSelection] = React.useState<ReviewSelection | null>(null)
  const [hideWhitespace, setHideWhitespace] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set())
  const [headlineState, setHeadlineState] = React.useState<Stage>('idle')
  const [filesState, setFilesState] = React.useState<Stage>('idle')
  const [commitsState, setCommitsState] = React.useState<Stage>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [history, setHistory] = React.useState<ReviewHistory | null>(null)
  const [historyState, setHistoryState] = React.useState<Stage>('idle')
  const [activeSnapshotOid, setActiveSnapshotOid] = React.useState<string | null>(null)
  const [historyDiff, setHistoryDiff] = React.useState<ReviewHistoryDiff | null>(null)
  const [historyDiffState, setHistoryDiffState] = React.useState<Stage>('idle')
  const [hideUnchanged, setHideUnchanged] = React.useState(true)
  const [clearingHistory, setClearingHistory] = React.useState(false)
  const [pane, setPane] = React.useState<'code' | 'about' | 'checks' | 'commits' | 'conversation'>(
    'code',
  )
  const [checks, setChecks] = React.useState<PullRequestChecksReport | null>(null)
  const [checksLoading, setChecksLoading] = React.useState(false)
  const [checksError, setChecksError] = React.useState<string | null>(null)
  const [checksReload, setChecksReload] = React.useState(0)
  const [checksWatching, setChecksWatching] = React.useState(false)
  const [rerunningRunId, setRerunningRunId] = React.useState<number | null>(null)
  const checksGate = React.useRef(createRequestGate())
  const rerunGate = React.useRef(createRequestGate())

  const headlineGate = React.useRef(createRequestGate())
  const filesGate = React.useRef(createRequestGate())
  const commitsGate = React.useRef(createRequestGate())
  const threadsGate = React.useRef(createRequestGate())
  /**
   * How many times a draft has been edited in this view. The journal read is
   * asynchronous and this is not, so a read that began before an edit is
   * answering for an older state of the drafts; the counter is how that read
   * learns it is no longer the newest thing to have happened to them.
   */
  const draftEdits = React.useRef(0)
  const historyGate = React.useRef(createRequestGate())
  const historyDiffGate = React.useRef(createRequestGate())

  React.useEffect(() => {
    setChecks(null)
    setChecksError(null)
    const claim = checksGate.current
    claim.reset()
    if (!headline || !desktop?.pullRequestChecks) return
    const ticket = claim.claim()
    setChecksLoading(true)
    void desktop
      .pullRequestChecks(headline.pullRequest.number, {
        headSha: headline.pullRequest.headOid ?? null,
        base: headline.pullRequest.base,
        force: checksReload > 0,
      })
      .then((report) => {
        if (claim.current(ticket)) setChecks(report)
      })
      .catch((cause) => {
        if (claim.current(ticket)) setChecksError(readableError(cause))
      })
      .finally(() => {
        if (claim.current(ticket)) setChecksLoading(false)
      })
    return () => {
      claim.reset()
    }
  }, [authority, desktop, headline, checksReload])
  React.useEffect(() => {
    if (!checksWatching || pane !== 'checks') return
    const timer = setInterval(() => setChecksReload((value) => value + 1), 10_000)
    return () => clearInterval(timer)
  }, [checksWatching, pane])

  React.useEffect(() => {
    const claim = rerunGate.current
    claim.reset()
    setRerunningRunId(null)
    return () => {
      claim.reset()
    }
  }, [authority, headline])

  const rerunCheck = async (runId: number | null) => {
    if (!headline || !desktop?.rerunPullRequestCheck || runId === null) return
    const claim = rerunGate.current
    const ticket = claim.claim()
    setRerunningRunId(runId)
    try {
      const report = await desktop.rerunPullRequestCheck(headline.pullRequest.number, runId)
      if (claim.current(ticket)) setChecks(report)
    } catch (cause) {
      if (claim.current(ticket)) setChecksError(readableError(cause))
    } finally {
      if (claim.current(ticket)) setRerunningRunId(null)
    }
  }
  // Progressive loading: the headline answers first, and only then are the files
  // and commits requested. Each stage carries its own request id so leaving for
  // another pull request cancels the read that is now obsolete. The CLI
  // authority is a dependency for the same reason: one authority's pull request
  // number can be another account's pull request, so the number on its own
  // cannot say the read on screen is still this view's.
  React.useEffect(() => {
    const claim = headlineGate.current
    claim.reset()
    setHeadline(null)
    setError(null)
    setThreadRead(null)
    setThreadError(null)
    setThreadState('idle')
    setDraftRecord(null)
    setSelection(null)
    setViewed(null)
    setResolutions([])
    setFilesState('idle')
    setCommitsState('idle')
    setChecksWatching(false)
    setRerunningRunId(null)
    setFiles(null)
    setCommits(null)
    setSelectedPath(null)
    setHistory(null)
    setActiveSnapshotOid(null)
    setHistoryDiff(null)
    setClearingHistory(false)
    if (desktop?.reviewHeadline === undefined || number === null) {
      setHeadlineState('idle')
      return
    }
    setHeadlineState('loading')
    const ticket = claim.claim()
    void desktop
      .reviewHeadline(number, 'review-headline')
      .then((value) => {
        if (!claim.current(ticket)) return
        setHeadline(value)
        setHeadlineState('ready')
      })
      .catch((cause) => {
        if (!claim.current(ticket)) return
        setError(readableError(cause))
        setHeadlineState('failed')
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-headline')
    }
  }, [authority, desktop, number, reloadToken])

  // The comment authorities retire with the credential that read them, on the
  // authority's own change rather than when a number happens to move: the
  // threads, the viewed paths, and the drafts journalled beside them were all
  // read as this authority, and pending words belong to the conversation they
  // were written into. Nothing is deleted — the journal read brings them back
  // under whichever authority owns them next — so a reviewer's own unsent
  // words survive the switch on disk even though they leave this screen.
  const authorityRef = React.useRef(authority)
  React.useEffect(() => {
    if (authorityRef.current === authority) return
    authorityRef.current = authority
    threadsGate.current.reset()
    setThreadRead(null)
    setThreadState('idle')
    setViewed(null)
    setDraftRecord(null)
    setResolutions([])
    setSelection(null)
    // A draft composed against the retired pull request must not silence the
    // journal read that would restore it.
    draftEdits.current += 1
    return () => {
      void desktop?.cancel?.('review-threads')
    }
  }, [authority, desktop])

  React.useEffect(() => {
    if (!headline || desktop?.reviewFiles === undefined) return
    const claim = filesGate.current
    claim.reset()
    setFilesState('loading')
    const ticket = claim.claim()
    void desktop
      .reviewFiles?.(headline.pullRequest.number, 'review-files')
      .then((value) => {
        if (!claim.current(ticket)) return
        setFiles(value)
        setFilesState('ready')
        setSelectedPath(value.files[0]?.path ?? null)
      })
      .catch((cause) => {
        if (!claim.current(ticket)) return
        setError(readableError(cause))
        setFilesState('failed')
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-files')
    }
  }, [desktop, headline, reloadToken])

  React.useEffect(() => {
    if (!headline || desktop?.reviewHistory === undefined) return
    const claim = historyGate.current
    claim.reset()
    setHistoryState('loading')
    const ticket = claim.claim()
    void desktop
      .reviewHistory?.(headline.pullRequest.number, 'review-history')
      .then((value) => {
        if (!claim.current(ticket)) return
        setHistory(value)
        setHistoryState('ready')
      })
      .catch(() => {
        if (!claim.current(ticket)) return
        setHistory(null)
        setHistoryState('failed')
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-history')
    }
  }, [desktop, headline, reloadToken])

  React.useEffect(() => {
    const claim = historyDiffGate.current
    claim.reset()
    setHistoryDiff(null)
    if (!headline || !activeSnapshotOid || desktop?.reviewHistoryDiff === undefined) {
      setHistoryDiffState('idle')
      return
    }
    setHistoryDiffState('loading')
    const ticket = claim.claim()
    void desktop
      .reviewHistoryDiff?.(headline.pullRequest.number, activeSnapshotOid, 'review-history-diff')
      .then((value) => {
        if (!claim.current(ticket)) return
        setHistoryDiff(value)
        setHistoryDiffState('ready')
      })
      .catch((cause) => {
        if (!claim.current(ticket)) return
        setHistoryDiff(null)
        setHistoryDiffState('failed')
        setError(readableError(cause))
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-history-diff')
    }
  }, [activeSnapshotOid, desktop, headline, reloadToken])

  const handleClearHistory = React.useCallback(async () => {
    if (!headline || !desktop?.reviewClearHistory) return
    const claim = historyGate.current
    claim.reset()
    const ticket = claim.claim()
    setClearingHistory(true)
    try {
      const reset = await desktop.reviewClearHistory(headline.pullRequest.number)
      if (!claim.current(ticket)) return
      setHistory(reset)
      setActiveSnapshotOid(null)
      setHistoryDiff(null)
    } catch (cause) {
      if (claim.current(ticket)) setError(readableError(cause))
    } finally {
      if (claim.current(ticket)) setClearingHistory(false)
    }
  }, [desktop, headline])

  // The conversation is a fifth independent read with its own request id, so
  // moving to another pull request cancels the thread read that is now obsolete
  // instead of letting it answer for a pull request nobody is looking at.
  React.useEffect(() => {
    if (!headline || desktop?.reviewThreads === undefined) return
    const claim = threadsGate.current
    claim.reset()
    setThreadState('loading')
    setThreadError(null)
    const ticket = claim.claim()
    void desktop
      .reviewThreads?.(headline.pullRequest.number, 'review-threads')
      .then((value) => {
        if (!claim.current(ticket)) return
        setThreadRead(value)
        setThreadState('ready')
      })
      .catch((cause) => {
        if (!claim.current(ticket)) return
        setThreadRead(null)
        setThreadError(readableError(cause))
        setThreadState('failed')
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-threads')
    }
  }, [desktop, headline, reloadToken])

  // Pending comments are the reviewer's unsent words. They are read from the
  // repository's own journal, so leaving for another workspace and coming back
  // finds them exactly as they were left.
  //
  // The read is asynchronous and the diff it waits for is not: lines can be
  // selected and commented on as soon as the files are on screen, which can be
  // before the journal has answered. That answer describes the drafts as they
  // were when the read began, so applying it afterwards would replace words
  // the reviewer has just typed with the older snapshot, and put that snapshot
  // back on disk at the next edit. An edit therefore outranks any read already
  // in flight: a read that began before an edit is dropped rather than allowed
  // to overwrite it.
  React.useEffect(() => {
    if (!headline || desktop?.reviewDrafts === undefined) return
    let live = true
    const editsAtReadStart = draftEdits.current
    setDraftRecord(null)
    setResolutions([])
    void desktop
      .reviewDrafts?.(headline.pullRequest.number)
      .then((record) => {
        if (!live || draftEdits.current !== editsAtReadStart) return
        setDraftRecord(record)
      })
      .catch(() => {
        if (!live || draftEdits.current !== editsAtReadStart) return
        setDraftRecord(null)
      })
    return () => {
      live = false
    }
  }, [desktop, headline, reloadToken])

  // Every draft is re-resolved against the head currently on screen, so a
  // force-push marks the comments it invalidated before anybody submits. The
  // words are never discarded for being stale.
  React.useEffect(() => {
    if (!headline || !files || desktop?.reviewResolveDrafts === undefined) return
    const drafts =
      draftRecord && draftRecord.number === headline.pullRequest.number ? draftRecord.drafts : []
    if (drafts.length === 0) {
      setResolutions([])
      return
    }
    let live = true
    void desktop
      .reviewResolveDrafts?.(headline.pullRequest.number, drafts)
      .then((value) => {
        if (live) setResolutions(value)
      })
      .catch(() => {
        // An unreadable revalidation leaves the drafts unclassified rather than
        // claiming they are fine; submit revalidates again and refuses.
        if (live) setResolutions([])
      })
    return () => {
      live = false
    }
  }, [desktop, draftRecord, files, headline, reloadToken])

  /**
   * A draft edit is journalled immediately and bound to the head its lines were
   * read at. A write that fails is surfaced rather than swallowed: unsent words
   * a reviewer believes are saved would be lost silently.
   */
  const saveDrafts = React.useCallback(
    (drafts: ReviewDraft[]) => {
      // A draft's line numbers are an address in one comparison. With the files
      // not yet read there is no comparison to bind them to, so nothing is
      // journalled rather than journalled against an identity nobody can check.
      if (!headline || !files) return
      // The repository and the account are left empty on purpose: the main
      // process stamps both from Git and GitHub, which are the only sources that
      // can be trusted to name them. A renderer-supplied owner would let a
      // record be filed under somebody else's account.
      const record: ReviewDraftRecord = {
        number: headline.pullRequest.number,
        repo: '',
        viewer: '',
        comparison: files.comparison,
        drafts,
        updatedAt: new Date().toISOString(),
      }
      // The record is installed optimistically, so what the reviewer sees is
      // what they just typed rather than the last thing read back from disk.
      // That makes this the newest fact about the drafts, which is what an
      // in-flight journal read is measured against.
      draftEdits.current += 1
      setDraftRecord(record)
      void desktop?.reviewSetDrafts?.(record)?.catch(() => {
        setError(
          'The pending comments could not be saved for this repository, so they will not survive leaving this workspace.',
        )
      })
    },
    [desktop, files, headline],
  )

  /**
   * Whether the threads on screen were read at the same revision as the diff.
   *
   * Files and threads are two independent reads, each pinned to its own
   * comparison, and a force-push between them lets both succeed while
   * describing different revisions. A thread's `line` is an address in the diff
   * it was read at, so "show in diff" and "comment here" would navigate to a
   * line of a revision that is no longer the one on screen. Rather than compose
   * a comment onto whatever happens to sit at that number, the two are compared
   * and the mismatch is shown with a way back to a single truth.
   */
  const threadsDisagree =
    files !== null &&
    threadRead !== null &&
    !sameReviewComparison(files.comparison, threadRead.threads.comparison)
  const headlineCurrent =
    files !== null &&
    Boolean(headline?.pullRequest.headOid) &&
    headline?.pullRequest.headOid === files.comparison.headOid

  // Composition follows the diff the reviewer is reading, and a thread from a
  // different revision is not allowed to steer it.
  const selectLines = React.useCallback((next: ReviewSelection) => {
    setSelection(next)
    setSelectedPath(next.path)
  }, [])

  const selectThreadLine = React.useCallback(
    (next: ReviewSelection) => {
      if (threadsDisagree) return
      selectLines(next)
      setPane('code')
    },
    [selectLines, threadsDisagree],
  )

  React.useEffect(() => {
    if (!headline || desktop?.reviewCommits === undefined) return
    const claim = commitsGate.current
    claim.reset()
    setCommitsState('loading')
    const ticket = claim.claim()
    void desktop
      .reviewCommits?.(headline.pullRequest.number, 'review-commits')
      .then((value) => {
        if (!claim.current(ticket)) return
        setCommits(value)
        setCommitsState('ready')
      })
      .catch(() => {
        if (!claim.current(ticket)) return
        setCommitsState('failed')
      })
    return () => {
      claim.reset()
      void desktop.cancel?.('review-commits')
    }
  }, [desktop, headline, reloadToken])

  React.useEffect(() => {
    if (!headline || desktop?.reviewViewed === undefined) return
    let live = true
    void desktop
      .reviewViewed?.(headline.pullRequest.number)
      .then((record) => {
        if (live) setViewed(record)
      })
      .catch(() => {
        if (live) setViewed(null)
      })
    return () => {
      live = false
    }
  }, [desktop, headline, reloadToken])

  const isComparing = activeSnapshotOid !== null
  const activeSnapshot = history?.snapshots.find((s) => s.headOid === activeSnapshotOid) ?? null

  const unchangedPaths = React.useMemo(
    () => (isComparing ? reviewHistoryUnchangedPaths(files, historyDiff) : []),
    [files, historyDiff, isComparing],
  )
  const unchangedPathSet = React.useMemo(() => new Set(unchangedPaths), [unchangedPaths])

  const eligibleFiles = React.useMemo(() => {
    if (!isComparing) return files?.files ?? []
    if (historyDiff?.state !== 'files') {
      return []
    }
    const diffFiles = historyDiff.files
    if (hideUnchanged) {
      return diffFiles
    }
    const seenPaths = new Set(diffFiles.map((f) => f.path))
    const unchangedFromCurrent: ReviewFile[] = (files?.files ?? [])
      .filter((f) => !seenPaths.has(f.path))
      .map((f) => ({
        ...f,
        status: 'unchanged' as const,
        additions: 0,
        deletions: 0,
        changes: 0,
        diff: { kind: 'text', hunks: [] },
      }))
    return [...diffFiles, ...unchangedFromCurrent]
  }, [files, hideUnchanged, historyDiff, isComparing])

  const filePaths = React.useMemo(
    () => reviewFileRows(eligibleFiles).flatMap((row) => (row.kind === 'file' ? [row.path] : [])),
    [eligibleFiles],
  )

  React.useEffect(() => {
    if (filePaths.length > 0 && (!selectedPath || !filePaths.includes(selectedPath))) {
      setSelectedPath(filePaths[0])
    }
  }, [filePaths, selectedPath])

  const markViewed = React.useCallback(
    (path: string) => {
      if (!headline || !files) return
      // Bound to the comparison the displayed files were read at, not to the
      // head alone: a base retarget changes what every file means, and a mark
      // carried across it would claim a review of changes nobody looked at.
      const next = withViewedFile(
        viewed,
        headline.pullRequest.number,
        files.comparison,
        path,
        new Date().toISOString(),
      )
      setViewed(next)
      void desktop?.reviewSetViewed?.(next)?.catch(() => {
        // The mark is a local reading aid. Losing it must not interrupt review,
        // and the failure stays visible in the header rather than being hidden.
        setError('The viewed-file record could not be saved for this repository.')
      })
    },
    [desktop, files, headline, viewed],
  )

  const step = React.useCallback(
    (direction: 1 | -1) => {
      if (!selectedPath) return
      const target = adjacentReviewFileIndex(filePaths, selectedPath, direction)
      if (target) {
        setSelectedPath(target)
        markViewed(target)
      }
    },
    [filePaths, markViewed, selectedPath],
  )

  const stepLayer = React.useCallback(
    (direction: 1 | -1) => {
      const rail = headline?.rail
      if (!rail || rail.state !== 'member') return
      const target: PullRequestStackMember | null = direction === 1 ? rail.next : rail.previous
      if (target) onSelectNumber(target.number)
    },
    [headline, onSelectNumber],
  )

  React.useEffect(() => {
    commands.current = {
      nextFile: () => step(1),
      previousFile: () => step(-1),
      nextLayer: () => stepLayer(1),
      previousLayer: () => stepLayer(-1),
    }
    return () => {
      commands.current = null
    }
  }, [commands, step, stepLayer])

  const searched = React.useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return eligibleFiles
    return eligibleFiles.filter(
      (file) =>
        file.path.toLowerCase().includes(needle) ||
        (file.previousPath ?? '').toLowerCase().includes(needle),
    )
  }, [eligibleFiles, search])

  const rows = React.useMemo(
    () =>
      visibleReviewFileRows(
        reviewFileRows(searched),
        search.trim() === '' ? collapsed : new Set<string>(),
        new Set(viewedPaths(viewed, headline?.pullRequest.number ?? 0, files?.comparison ?? null)),
      ),
    [collapsed, eligibleFiles, files, headline, searched, viewed],
  )

  const selected = eligibleFiles.find((file) => file.path === selectedPath) ?? null
  const summary = React.useMemo(() => summarizeReviewFiles(eligibleFiles), [eligibleFiles])

  const historicalFile = React.useMemo(() => {
    if (!isComparing || historyDiff?.state !== 'files') return null
    return historyDiff.files.find((file) => file.path === selectedPath) ?? null
  }, [historyDiff, isComparing, selectedPath])

  const frozenReason = isComparing
    ? `Viewing changes since ${activeSnapshot?.headOid.slice(0, 7) ?? 'a previous head'}. Comments and reviews are disabled in historical comparison mode; return to the current diff to comment.`
    : null

  const select = (path: string) => {
    setSelectedPath(path)
    markViewed(path)
  }

  // Arrow keys move between file rows the way they move between branches, and
  // nothing is opened by moving: a row is opened by Enter or Space, which is
  // what a focused button already does.
  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const container = event.currentTarget
    const items = [...container.querySelectorAll<HTMLButtonElement>('button[data-review-row]')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (index === -1) return
    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div className="review-view">
      <div className="list-toolbar review-toolbar">
        <div className="list-title-group">
          <h1
            className={headline ? 'sr-only' : undefined}
            id={WORKSPACE_VIEW_HEADING_ID}
            tabIndex={-1}
          >
            Review
          </h1>
          {!headline ? <span className="list-subtitle">No pull request selected</span> : null}
        </div>
        {headline ? (
          <>
            <SegmentedControl
              label="Diff layout"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'unified', label: 'Unified' },
                { value: 'split', label: 'Split' },
              ]}
            />
            <Checkbox
              checked={hideWhitespace}
              label="Hide whitespace"
              onCheckedChange={setHideWhitespace}
              title="Hide lines whose only difference from the line they replaced is spaces or tabs. GitHub's API has no whitespace option for a pull request diff, so this filters the text it already sent."
            />
            <IconButton
              label="Reload review data from GitHub"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              <RefreshCw className="size-4" />
            </IconButton>
            <details className="review-actions">
              <summary>PR actions</summary>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void desktop?.openExternal(headline.pullRequest.url)}
              >
                <ExternalLink className="size-3.5" />
                Open on GitHub
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onManageNumber(headline.pullRequest.number)}
              >
                Manage pull request
              </Button>
            </details>
          </>
        ) : null}
      </div>

      {headlineState === 'loading' ? (
        <p className="review-loading" role="status">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading pull request from GitHub…
        </p>
      ) : null}

      {error ? (
        <InlineAlert
          className="gh-banner"
          tone="warning"
          title="Review data unavailable"
          role="status"
        >
          {error} Local Git actions are unaffected; nothing was checked out to read this.
        </InlineAlert>
      ) : null}

      {!headline && headlineState !== 'loading' ? (
        <EmptyState className="compact-empty">
          <MessageSquareDiff className="empty-icon" />
          <h2>
            {pullRequests.length === 0 ? 'No pull request to review' : 'Choose a pull request'}
          </h2>
          <p>
            {pullRequests.length === 0
              ? 'This repository has no open pull requests on GitHub.'
              : 'Open a pull request from the list to read its files, commits, and stack position without checking out its branch.'}
          </p>
          {pullRequests.length > 0 ? (
            <ul className="review-chooser">
              {pullRequests.slice(0, LIST_PAGE_SIZE).map((pr) => (
                <li key={pr.number}>
                  <Button size="sm" variant="secondary" onClick={() => onSelectNumber(pr.number)}>
                    #{pr.number} {pr.title}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </EmptyState>
      ) : null}

      {headline ? (
        <>
          <ReviewHeadlineBlock headline={headline} filesComparison={files?.comparison ?? null} />

          <ReviewRail
            rail={headline.rail}
            number={headline.pullRequest.number}
            onSelect={onSelectNumber}
            context={stackContext}
          />

          <div className="review-pane-switch" role="group" aria-label="Review contextual panes">
            {(['code', 'about', 'checks', 'commits', 'conversation'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={pane === value ? 'secondary' : 'ghost'}
                aria-pressed={pane === value}
                onClick={() => setPane(value)}
              >
                {value === 'code'
                  ? 'Code'
                  : value === 'about'
                    ? 'Description & reviewers'
                    : value === 'checks'
                      ? 'Checks'
                      : value === 'commits'
                        ? 'Commits'
                        : 'Conversation'}
              </Button>
            ))}
          </div>
          <details className="review-history-disclosure">
            <summary>
              Comparison ·{' '}
              {isComparing
                ? `Historical ${shortOid(activeSnapshotOid)}`
                : `Current head ${shortOid(files?.comparison.headOid ?? headline.pullRequest.headOid ?? null)}`}
            </summary>
            <ReviewHistoryBar
              history={history}
              state={historyState}
              currentHeadOid={files?.comparison.headOid ?? headline.pullRequest.headOid ?? null}
              activeSnapshotOid={activeSnapshotOid}
              hideUnchanged={hideUnchanged}
              unchangedCount={unchangedPaths.length}
              truncated={historyDiff?.truncated ?? false}
              clearing={clearingHistory}
              onSelectSnapshot={(oid) => setActiveSnapshotOid(oid)}
              onToggleHideUnchanged={(checked) => setHideUnchanged(checked)}
              onClearHistory={handleClearHistory}
            />
          </details>
          {isComparing ? (
            <p className="review-history-warning" role="status">
              {frozenReason}
            </p>
          ) : null}

          <div
            className={cn('review-body', pane !== 'code' && 'review-body-context')}
            data-pane={pane}
          >
            <section className="review-tree" aria-label="Changed files">
              <div className="review-tree-header">
                <strong>Files</strong>
                {isComparing && historyDiff?.state === 'files' ? (
                  <span className="code-region-meta">
                    {summary.changed} changed · +{historyDiff.additions} −{historyDiff.deletions}
                  </span>
                ) : !isComparing && files ? (
                  <span className="code-region-meta">
                    {summary.changed} changed · +{files.additions} −{files.deletions}
                  </span>
                ) : null}
              </div>
              <Input
                unstyled
                aria-label="Filter changed files"
                className="review-tree-search"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter files"
                type="search"
                value={search}
              />
              {isComparing && historyDiffState === 'loading' ? (
                <p className="section-empty" role="status">
                  Loading historical files…
                </p>
              ) : filesState === 'loading' ? (
                <p className="section-empty" role="status">
                  Loading changed files from GitHub…
                </p>
              ) : filesState === 'failed' ? (
                <p className="section-empty">The changed-file list could not be loaded.</p>
              ) : rows.length === 0 ? (
                <p className="section-empty">
                  {files?.files.length === 0
                    ? 'This pull request changes no files.'
                    : isComparing && hideUnchanged && unchangedPaths.length > 0
                      ? 'All files are unchanged since the selected snapshot.'
                      : 'No file matches this filter.'}
                </p>
              ) : (
                <div
                  className="review-tree-rows"
                  role="group"
                  aria-label="Changed file rows"
                  onKeyDown={onTreeKeyDown}
                >
                  {rows.map((row) =>
                    row.kind === 'directory' ? (
                      <Button
                        aria-expanded={!collapsed.has(row.path)}
                        className="review-tree-row review-tree-directory"
                        variant="unstyled"
                        data-review-row
                        key={row.id}
                        onClick={() =>
                          setCollapsed((current) => {
                            const next = new Set(current)
                            if (next.has(row.path)) next.delete(row.path)
                            else next.add(row.path)
                            return next
                          })
                        }
                        style={{ paddingInlineStart: `${8 + row.depth * 12}px` }}
                        type="button"
                      >
                        {collapsed.has(row.path) ? (
                          <ChevronRight aria-hidden="true" className="size-3.5" />
                        ) : (
                          <ChevronDown aria-hidden="true" className="size-3.5" />
                        )}
                        <span className="review-tree-name">{row.name}</span>
                        <span className="review-tree-count">
                          {row.fileCount} file{row.fileCount === 1 ? '' : 's'}
                        </span>
                      </Button>
                    ) : (
                      <Button
                        aria-current={row.path === selectedPath ? 'true' : undefined}
                        aria-label={`${row.path}, ${REVIEW_STATUS_LABELS[row.file.status]}, +${row.file.additions} minus ${row.file.deletions}${row.viewed ? ', viewed' : ''}`}
                        className={cn(
                          'review-tree-row',
                          row.path === selectedPath && 'review-tree-row-selected',
                        )}
                        variant="unstyled"
                        data-review-row
                        key={row.id}
                        onClick={() => select(row.path)}
                        style={{ paddingInlineStart: `${8 + row.depth * 12}px` }}
                        type="button"
                      >
                        <span aria-hidden="true" className="review-status">
                          {reviewStatusLetter(row.file.status)}
                        </span>
                        <span className="review-tree-name">{row.name}</span>
                        {row.viewed ? <span className="review-viewed-mark">viewed</span> : null}
                        {row.file.generated ? (
                          <span className="review-tree-flag">generated</span>
                        ) : null}
                        {row.file.diff.kind !== 'text' ? (
                          <span className="review-tree-flag">
                            {row.file.diff.kind === 'binary' ? 'binary' : 'no patch'}
                          </span>
                        ) : null}
                        <span className="review-tree-count">
                          +{row.file.additions} −{row.file.deletions}
                        </span>
                      </Button>
                    ),
                  )}
                </div>
              )}
              {files?.truncated ? (
                <p className="code-region-note">
                  GitHub stopped listing files for this pull request. The counts above are a lower
                  bound, not the whole change.
                </p>
              ) : null}
            </section>

            <section className="review-diff" aria-label="Selected file diff">
              <div className="review-diff-toolbar">
                <Button
                  disabled={filePaths.length === 0}
                  size="sm"
                  variant="ghost"
                  onClick={() => step(-1)}
                >
                  Previous file
                </Button>
                <span className="review-diff-position">
                  {selected
                    ? `${filePaths.indexOf(selected.path) + 1} of ${filePaths.length}`
                    : `No file open`}
                </span>
                <Button
                  disabled={filePaths.length === 0}
                  size="sm"
                  variant="ghost"
                  onClick={() => step(1)}
                >
                  Next file
                </Button>
              </div>
              {filesState === 'loading' || (isComparing && historyDiffState === 'loading') ? (
                <p className="section-empty" role="status">
                  {isComparing ? 'Loading historical comparison…' : 'Loading diff…'}
                </p>
              ) : isComparing && historyDiff?.state === 'unavailable' ? (
                <div style={{ padding: '16px' }}>
                  <InlineAlert tone="warning" role="status">
                    <div>
                      <strong>Historical comparison unavailable</strong>
                      <p style={{ marginTop: '4px', marginBottom: '8px' }}>{historyDiff.reason}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setActiveSnapshotOid(null)}
                      >
                        Return to current diff
                      </Button>
                    </div>
                  </InlineAlert>
                </div>
              ) : selected ? (
                isComparing ? (
                  historicalFile ? (
                    <ReviewDiff
                      file={historicalFile}
                      mode={mode}
                      hideWhitespace={hideWhitespace}
                      selection={null}
                      onSelect={() => {}}
                    />
                  ) : historyDiff?.truncated ? (
                    <EmptyState className="compact-empty">
                      <FileQuestion className="empty-icon" />
                      <h2>Comparison truncated</h2>
                      <p>
                        <code>{selected.path}</code> was omitted from the 300-file comparison limit.
                      </p>
                    </EmptyState>
                  ) : historyDiff?.state === 'files' ? (
                    <EmptyState className="compact-empty">
                      <FileQuestion className="empty-icon" />
                      <h2>File unchanged since snapshot</h2>
                      <p>
                        <code>{selected.path}</code> was not modified between{' '}
                        <code>{shortOid(activeSnapshot?.headOid ?? null)}</code> and the current
                        head.
                      </p>
                    </EmptyState>
                  ) : (
                    <EmptyState className="compact-empty">
                      <FileQuestion className="empty-icon" />
                      <h2>Historical comparison unavailable</h2>
                      <p>Changes for this file could not be determined.</p>
                    </EmptyState>
                  )
                ) : (
                  <ReviewDiff
                    file={selected}
                    mode={mode}
                    hideWhitespace={hideWhitespace}
                    selection={selection}
                    onSelect={selectLines}
                  />
                )
              ) : (
                <EmptyState className="compact-empty">
                  <FileQuestion className="empty-icon" />
                  <h2>No file open</h2>
                  <p>Choose a file from the list to read its diff.</p>
                </EmptyState>
              )}
            </section>

            <aside
              className="review-context"
              aria-label="Pull request context"
              hidden={pane === 'code'}
            >
              <section hidden={pane !== 'about'} className="review-about">
                <h2>Description</h2>
                <p className="review-description">
                  {headline.pullRequest.body || 'No description was provided.'}
                </p>
                <h2>Readiness</h2>
                {!headlineCurrent ? (
                  <InlineAlert tone="warning">
                    Readiness and reviewer context describe headline head{' '}
                    {shortOid(headline.pullRequest.headOid ?? null)}, not the displayed diff.
                    Current-head readiness and reviewer absence are unknown; reload to reconcile the
                    reads.
                  </InlineAlert>
                ) : null}
                <p>
                  GitHub merge state:{' '}
                  {headline.pullRequest.mergeState?.toLowerCase().replaceAll('_', ' ') || 'unknown'}
                  . Review decision:{' '}
                  {headline.pullRequest.reviewDecision?.toLowerCase().replaceAll('_', ' ') ||
                    'unknown'}
                  .
                </p>
                <h2>Reviewers</h2>
                <p>
                  {headline.reviewers.message ||
                    (headline.reviewers.requested.length === 0 &&
                    headline.reviewers.reviews.length === 0
                      ? headlineCurrent
                        ? 'GitHub reported no requested reviewers or latest reviews at the displayed head.'
                        : 'GitHub reported no requested reviewers or latest reviews at the headline head; reviewer absence at the displayed head is unknown.'
                      : 'Reviewer context as of the headline read.')}
                </p>
                {headline.reviewers.requested.length > 0 ? (
                  <ul>
                    {headline.reviewers.requested.map((reviewer) => (
                      <li key={`${reviewer.kind}:${reviewer.name}`}>
                        {reviewer.name} · {reviewer.kind} · requested
                      </li>
                    ))}
                  </ul>
                ) : null}
                {headline.reviewers.reviews.length > 0 ? (
                  <ul>
                    {headline.reviewers.reviews.map((review, index) => (
                      <li key={`${review.login}:${index}`}>
                        {review.login} · {review.state.toLowerCase().replaceAll('_', ' ')}
                        {review.headOid && review.headOid === files?.comparison.headOid
                          ? ' · current head'
                          : ' · earlier or unknown head'}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
              <section hidden={pane !== 'checks'}>
                {checksError ? <InlineAlert tone="warning">{checksError}</InlineAlert> : null}
                <PullRequestChecksPanel
                  report={
                    checks &&
                    files &&
                    (checks.headSha !== files.comparison.headOid ||
                      checks.base !== files.comparison.baseRef)
                      ? {
                          ...checks,
                          freshness: 'stale',
                          staleReason:
                            'Checks describe a different head or base from the displayed diff. Reload to read the current comparison.',
                          permissions: {
                            ...checks.permissions,
                            canRerun: false,
                            reason: 'Reload checks at the displayed head before rerunning.',
                          },
                        }
                      : checks
                  }
                  loading={checksLoading}
                  watching={checksWatching}
                  onToggleWatch={() => setChecksWatching((value) => !value)}
                  onRefresh={() => setChecksReload((value) => value + 1)}
                  onRerun={(check) => void rerunCheck(check.workflowRunId)}
                  onOpenDetails={(url) => void desktop?.openExternal(url)}
                  rerunningRunId={rerunningRunId}
                />
              </section>
              <div hidden={pane !== 'commits'}>
                <ReviewCommits
                  commits={commits}
                  state={commitsState}
                  number={headline.pullRequest.number}
                />
              </div>
              <div hidden={pane !== 'conversation'}>
                {threadsDisagree ? (
                  <InlineAlert className="review-comparison-alert" role="status" tone="warning">
                    The conversation was read at{' '}
                    {shortOid(threadRead?.threads.comparison.headOid ?? null)}, but the diff on
                    screen is {shortOid(files?.comparison.headOid ?? null)}. Reload to read both at
                    the same revision; until then a thread's line cannot be shown or commented on.
                    <Button
                      className="review-comparison-reload"
                      size="sm"
                      variant="secondary"
                      onClick={() => setReloadToken((value) => value + 1)}
                    >
                      Reload
                    </Button>
                  </InlineAlert>
                ) : null}

                {isComparing &&
                historyDiff?.state === 'files' &&
                files?.comparison.headOid &&
                historyDiff.to.headOid !== files.comparison.headOid ? (
                  <InlineAlert className="review-comparison-alert" role="status" tone="warning">
                    The pull request moved to {shortOid(files.comparison.headOid)} after this
                    comparison was taken against {shortOid(historyDiff.to.headOid)}. Reload to
                    compare against the latest head.
                    <Button
                      className="review-comparison-reload"
                      size="sm"
                      variant="secondary"
                      onClick={() => setReloadToken((value) => value + 1)}
                    >
                      Reload
                    </Button>
                  </InlineAlert>
                ) : null}

                <ReviewConversation
                  desktop={desktop}
                  number={headline.pullRequest.number}
                  files={files}
                  read={threadRead}
                  readError={threadError}
                  readState={
                    threadState === 'ready'
                      ? 'ready'
                      : threadState === 'failed'
                        ? 'failed'
                        : 'loading'
                  }
                  drafts={draftRecord}
                  resolutions={resolutions}
                  selection={selection}
                  onClearSelection={() => setSelection(null)}
                  onDraftChange={saveDrafts}
                  onReload={() => setReloadToken((value) => value + 1)}
                  onSelect={selectThreadLine}
                  frozenReason={frozenReason}
                />
              </div>
            </aside>
          </div>
        </>
      ) : null}
    </div>
  )
}

function ReviewHeadlineBlock({
  headline,
  filesComparison,
}: {
  headline: ReviewHeadline
  /**
   * The comparison the displayed files were actually read at. The headline is
   * read first, so a force-push or a base retarget between the two reads leaves
   * the two claims disagreeing. The file set is pinned to its own comparison, so
   * the headline is the out-of-date one and is labelled as such rather than shown
   * as the revision on screen.
   */
  filesComparison: ReviewComparison | null
}) {
  const pr = headline.pullRequest
  return (
    <header className="review-headline">
      <div className="review-headline-title">
        <details className="review-headline-title-disclosure">
          <summary>
            <strong>
              #{pr.number} {pr.title}
            </strong>
          </summary>
          <p>
            #{pr.number} {pr.title}
          </p>
        </details>
        <div className="pr-detail-meta">
          <Badge variant={pr.state === 'OPEN' ? 'success' : 'secondary'}>
            {pr.state.toLowerCase()}
          </Badge>
          {pr.draft ? <Badge variant="outline">draft</Badge> : null}
          <Badge variant={checksVariant(pr.checks)}>
            <ShieldCheck aria-hidden="true" className="size-3" />
            {checkLabel(pr.checks)}
          </Badge>
          <Badge variant={reviewVariant(pr)}>{reviewLabel(pr)}</Badge>
        </div>
      </div>
      <p className="review-headline-refs">
        <code>{pr.head}</code>
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
        <code>{pr.base}</code>
        {pr.headOid ? (
          <span className="review-headline-oid">
            head {pr.headOid.slice(0, 7)}
            {filesComparison && filesComparison.headOid !== pr.headOid
              ? ' as of the headline'
              : null}
          </span>
        ) : null}
      </p>
    </header>
  )
}

/**
 * Read-only native membership navigation. The full ordered rail is disclosed
 * locally so a long submitted stack never takes the default code viewport.
 */
function ReviewRail({
  rail,
  number,
  onSelect,
  context,
}: {
  rail: ReviewStackRail
  number: number
  onSelect: (number: number) => void
  context: Pick<RepositorySnapshot, 'branches' | 'reconciliation'>
}) {
  const members = React.useMemo(
    () => [...(rail.stack?.pullRequests ?? [])].sort((a, b) => a.position - b.position),
    [rail.stack],
  )
  const navigable = React.useMemo(
    () => members.filter((member) => Number.isSafeInteger(member.number) && member.number > 0),
    [members],
  )
  const memberListRef = React.useRef<HTMLOListElement>(null)
  const [activeMemberIndex, setActiveMemberIndex] = React.useState(0)
  React.useEffect(() => {
    setActiveMemberIndex(
      Math.max(
        0,
        navigable.findIndex((member) => member.number === number),
      ),
    )
  }, [navigable, number])
  if (rail.state === 'unavailable') {
    return (
      <div className="review-rail" role="group" aria-label="Native stack layers">
        <InlineAlert tone="warning" role="status">
          {rail.message}
        </InlineAlert>
      </div>
    )
  }
  if (rail.state === 'not-stacked' || !rail.stack) {
    const local = context.branches.find((branch) => !branch.remote && branch.pr?.number === number)
    return (
      <div className="review-rail" role="group" aria-label="Native stack layers">
        <p className="review-rail-note">
          <Layers aria-hidden="true" className="size-3.5" />
          {rail.message}
        </p>
        {local?.parent ? (
          <details className="review-stack-disclosure">
            <summary>Local-only relationship · not submitted native membership</summary>
            <p className="review-rail-note">
              {local.name} → {local.parent}. Source:{' '}
              {local.parentSource === 'recorded'
                ? 'recorded local parent'
                : local.parentSource === 'pullRequest'
                  ? 'PR base'
                  : local.parentSource === 'stack'
                    ? 'previous native stack observation'
                    : 'inferred ancestry — not confirmed'}
              .
            </p>
          </details>
        ) : null}
      </div>
    )
  }
  const selected = members.find((member) => member.number === number)
  const partial = members.length < rail.stack.size
  const reconciliation = context.reconciliation?.stacks.find(
    (entry) => entry.stackNumber === rail.stack?.number,
  )
  const localEvidence = members.flatMap((member) => {
    const branch = context.branches.find(
      (entry) =>
        !entry.remote && entry.pr?.number === member.number && entry.pr.head === member.head,
    )
    if (!branch) return []
    if (member.headSha && branch.pr?.headOid && member.headSha !== branch.pr.headOid) {
      return [
        `#${member.number}: local metadata for ${branch.name} names a different head than submitted native membership; local blocker attribution is stale.`,
      ]
    }
    if (branch.needsRestack || (branch.parentBehind ?? 0) > 0) {
      return [
        `#${member.number}: local branch ${branch.name} requires restack (local parent comparison${branch.parentBehind ? `: ${branch.parentBehind} parent commits behind` : ''}).`,
      ]
    }
    if (branch.parent && branch.parentBehind === null) {
      return [
        `#${member.number}: local parent comparison for ${branch.name} is unavailable; this is not evidence of a restack requirement.`,
      ]
    }
    return []
  })
  return (
    <nav className="review-rail" aria-label="Native stack layers">
      <details
        className="review-stack-disclosure"
        onToggle={(event) => {
          if (!event.currentTarget.open) return
          const list = event.currentTarget.querySelector<HTMLOListElement>('.review-stack-members')
          const current = list?.querySelector<HTMLElement>('[aria-current="page"]')
          if (list && current)
            list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top
        }}
      >
        <summary>
          Layer {selected?.position ?? '?'} of {rail.stack.size} · Stack #{rail.stack.number}
          {partial ? ` · Partial membership (${members.length} loaded)` : ' · All layers'}
        </summary>
        <ol
          ref={memberListRef}
          className="review-stack-members"
          aria-label="Submitted native order"
        >
          {members.map((member) => {
            const facts = rail.facts?.find((entry) => entry.number === member.number)
            const fresh = facts?.state === 'available' || facts?.state === 'partial'
            const lifecycle = (fresh ? facts.lifecycle : null) ?? member.state
            const draft = (fresh ? facts.draft : null) ?? member.draft
            const memberIndex = navigable.indexOf(member)
            return (
              <li key={`${member.position}-${member.number}`}>
                <Button
                  disabled={!Number.isSafeInteger(member.number) || member.number <= 0}
                  variant="unstyled"
                  className="review-stack-member"
                  aria-current={member.number === number ? 'page' : undefined}
                  onClick={() => onSelect(member.number)}
                  tabIndex={memberIndex < 0 ? -1 : rovingTabIndex(memberIndex, activeMemberIndex)}
                  onFocus={(event) => {
                    setActiveMemberIndex(memberIndex)
                    event.currentTarget.scrollIntoView({ block: 'nearest' })
                  }}
                  onKeyDown={(event) => {
                    if (!claimsRovingKey(event)) return
                    const action = rovingAction(event.key)
                    if (!action) return
                    const target = rovingTarget(action, memberIndex, navigable.length)
                    if (target === null) return
                    event.preventDefault()
                    memberListRef.current
                      ?.querySelectorAll<HTMLButtonElement>('.review-stack-member:not(:disabled)')
                      [target]?.focus()
                  }}
                >
                  <span className="review-stack-identity">
                    <strong>
                      {member.position}. #{member.number}
                    </strong>
                    <span>{facts?.title ?? `Title unavailable · ${member.head}`}</span>
                  </span>
                  <span className="review-stack-facts">
                    <Badge
                      variant={
                        lifecycle === 'MERGED'
                          ? 'merged'
                          : lifecycle === 'CLOSED'
                            ? 'danger'
                            : 'secondary'
                      }
                    >
                      {lifecycle?.toLowerCase() ?? 'Lifecycle unknown'}
                    </Badge>
                    {draft === null ? (
                      <span>Draft unknown</span>
                    ) : draft ? (
                      <Badge variant="secondary">Draft</Badge>
                    ) : null}
                    <span>
                      {facts?.checks === 'none'
                        ? 'No checks'
                        : `Checks ${facts?.checks ?? 'unknown'}`}
                    </span>
                    <span>
                      {facts?.review === 'none'
                        ? 'No review decision'
                        : `Review ${(facts?.review ?? 'unknown').replaceAll('-', ' ')}`}
                    </span>
                    {facts?.state !== 'available' ? (
                      <span>{facts?.state ?? 'Metadata not loaded'}</span>
                    ) : null}
                    {facts?.message ? (
                      <span className="review-stack-fact-note">{facts.message}</span>
                    ) : null}
                    {member.number === number ? <Badge variant="accent">Viewing</Badge> : null}
                  </span>
                </Button>
              </li>
            )
          })}
        </ol>
        {rail.message ? <p className="review-rail-note">{rail.message}</p> : null}
        <details className="review-stack-evidence">
          <summary>Blockers & relationship sources</summary>
          <p className="review-rail-note">
            Submitted order comes from GitHub native membership. Inspection does not prepare or
            repair the stack.
          </p>
          {localEvidence.length ? (
            <ul>
              {localEvidence.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : (
            <p className="review-rail-note">
              No local restack requirement reported for these matched branches.
            </p>
          )}
          {reconciliation ? (
            <>
              <p className="review-rail-note">
                Reconciliation source: {reconciliation.state} · {reconciliation.summary}
              </p>
              <p className="review-rail-note">
                Submitted order: {reconciliation.submittedOrder.join(' → ') || 'Unavailable'}
              </p>
              {reconciliation.blockers.length ? (
                <ul>
                  {reconciliation.blockers.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
              {reconciliation.members
                .filter((entry) => entry.detail)
                .map((entry) => (
                  <p className="review-rail-note" key={entry.branch}>
                    {entry.branch}: {entry.detail}
                  </p>
                ))}
            </>
          ) : (
            <p className="review-rail-note">
              No matching reconciliation report is available; no reconciliation blocker is inferred.
            </p>
          )}
        </details>
      </details>
      <LayerButton
        direction="previous"
        member={rail.previous}
        onSelect={onSelect}
        boundary={
          partial
            ? 'The preceding member was not returned.'
            : 'This is the bottom layer of the stack.'
        }
      />
      <LayerButton
        direction="next"
        member={rail.next}
        onSelect={onSelect}
        boundary={
          partial ? 'The following member was not returned.' : 'This is the top layer of the stack.'
        }
      />
    </nav>
  )
}

function LayerButton({
  direction,
  member,
  onSelect,
  boundary,
}: {
  direction: 'previous' | 'next'
  member: PullRequestStackMember | null
  onSelect: (number: number) => void
  boundary: string
}) {
  const label = direction === 'previous' ? 'Layer below' : 'Layer above'
  return (
    <Button
      disabled={!member}
      size="sm"
      tooltip={member ? `Review #${member.number} ${member.head} → ${member.base}` : boundary}
      variant="secondary"
      onClick={() => member && onSelect(member.number)}
    >
      {direction === 'previous' ? (
        <ChevronRight aria-hidden="true" className="size-3.5 rotate-180" />
      ) : (
        <ChevronRight aria-hidden="true" className="size-3.5" />
      )}
      {member ? `${label}: #${member.number}` : `${label}: none`}
    </Button>
  )
}

function ReviewCommits({
  commits,
  state,
  number,
}: {
  commits: ReviewCommitSet | null
  state: Stage
  number: number
}) {
  if (state === 'loading') {
    return (
      <p className="section-empty" role="status">
        Loading the {number ? `#${number} ` : ''}commit list…
      </p>
    )
  }
  if (state === 'failed') {
    return <p className="section-empty">The commit list could not be loaded from GitHub.</p>
  }
  if (!commits || (commits.commits.length === 0 && !commits.truncated)) {
    return <p className="section-empty">GitHub reported no commits for this pull request.</p>
  }
  return (
    <section className="review-commits" aria-label="Pull request commits">
      <div className="review-tree-header">
        <strong>Commits</strong>
        <span className="code-region-meta">
          {commits.truncated
            ? `${commits.commits.length} shown${commits.total === null ? '' : ` of ${commits.total}`}`
            : `${commits.commits.length} commit${commits.commits.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {commits.truncated ? (
        <p className="code-region-note" role="status">
          {commits.total === null ? 'This list may be incomplete.' : 'This list is incomplete.'}{' '}
          GitHub returns at most 250 commits here. Open the pull request on GitHub for its full
          history.
        </p>
      ) : null}
      <ul className="review-commit-list">
        {commits.commits.map((commit) => (
          <li key={commit.oid}>
            <GitCommitHorizontal aria-hidden="true" className="size-4" />
            <span className="review-commit-copy">
              <strong>{commit.message}</strong>
              <small>
                {commit.author} · <code>{commit.shortOid}</code>
                {commit.authoredAt ? ` · ${commit.authoredAt.slice(0, 10)}` : ''}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReviewHistoryBar({
  history,
  state: _state,
  currentHeadOid,
  activeSnapshotOid,
  hideUnchanged,
  unchangedCount,
  truncated,
  clearing,
  onSelectSnapshot,
  onToggleHideUnchanged,
  onClearHistory,
}: {
  history: ReviewHistory | null
  state: Stage
  currentHeadOid: string | null
  activeSnapshotOid: string | null
  hideUnchanged: boolean
  unchangedCount: number
  truncated: boolean
  clearing: boolean
  onSelectSnapshot: (oid: string | null) => void
  onToggleHideUnchanged: (checked: boolean) => void
  onClearHistory: () => void
}) {
  const snapshots = history?.snapshots ?? []
  const reviewed = history?.reviewed ?? null
  const currentShort = shortOid(currentHeadOid)
  const isComparing = activeSnapshotOid !== null
  const activeSnapshot = snapshots.find((s) => s.headOid === activeSnapshotOid) ?? null
  const activeShort = shortOid(activeSnapshot?.headOid ?? null)

  const canCompareReviewed =
    reviewed !== null && currentHeadOid !== null && reviewed.headOid !== currentHeadOid

  const reviewedTooltip =
    reviewed === null
      ? 'No review of an earlier head was submitted from this app.'
      : reviewed.headOid === currentHeadOid
        ? `The current head (${currentShort}) is already the reviewed head.`
        : `Compare ${shortOid(reviewed.headOid)} (reviewed) → ${currentShort}`

  return (
    <div className="review-history" role="toolbar" aria-label="Review update history">
      <div className="review-history-controls">
        <label className="review-history-select-label">
          <span className="sr-only">Choose snapshot</span>
          <Select
            aria-label="Choose snapshot to compare against current head"
            controlSize="compact"
            className="review-history-select"
            value={activeSnapshotOid ?? ''}
            onValueChange={(value) => onSelectSnapshot(value === '' ? null : value)}
            options={[
              { value: '', label: `Current diff (head ${currentShort})` },
              ...snapshots
                .slice()
                .reverse()
                .map((snapshot) => ({
                  value: snapshot.headOid,
                  label: reviewSnapshotLabel(snapshot),
                })),
            ]}
          />
        </label>

        <Button
          size="sm"
          variant={isComparing && activeSnapshotOid === reviewed?.headOid ? 'default' : 'secondary'}
          disabled={!canCompareReviewed}
          tooltip={reviewedTooltip}
          onClick={() => {
            if (reviewed) onSelectSnapshot(reviewed.headOid)
          }}
        >
          Changes since reviewed
        </Button>

        {isComparing ? (
          <div className="review-history-comparing">
            <Badge variant="outline">
              Comparing {activeShort} → {currentShort}
            </Badge>
            <Checkbox
              checked={hideUnchanged}
              label="Hide unchanged files"
              onCheckedChange={onToggleHideUnchanged}
              title="Hide files whose contents did not change between the chosen snapshot and the current head."
            />
            {hideUnchanged && unchangedCount > 0 ? (
              <span className="review-history-unchanged-note">
                {unchangedCount} unchanged file{unchangedCount === 1 ? '' : 's'} hidden
              </span>
            ) : null}
            {truncated ? <Badge variant="warning">Truncated at 300 files</Badge> : null}
            <Button size="sm" variant="ghost" onClick={() => onSelectSnapshot(null)}>
              Return to current diff
            </Button>
          </div>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          disabled={clearing || snapshots.length === 0}
          tooltip="Clear locally observed snapshots for this pull request under the current account"
          onClick={onClearHistory}
        >
          {clearing ? 'Clearing…' : 'Clear snapshot history'}
        </Button>
      </div>

      {history?.gap ? (
        <InlineAlert className="review-history-gap" tone="info" role="status">
          {history.gap.message}
        </InlineAlert>
      ) : null}
    </div>
  )
}
/** A commit named the way a reviewer would say it aloud, or "an unknown commit". */
function shortOid(oid: string | null): string {
  return oid === null || oid === '' ? 'an unknown commit' : oid.slice(0, 7)
}
