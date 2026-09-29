/**
 * Measurable budgets shared by the main process, the renderer, and the
 * benchmark harness in `scripts/perf`. Every limit here is enforced in code and
 * documented in `README.md`; the benchmark fixtures are generated locally so
 * a trend run never depends on a private repository.
 */

/** Electron launch through the first painted repository branch page. */
export const STARTUP_BUDGET_MS = 10_000
/** Wall-clock budget for one full `getSnapshot` on the reference fixture. */
export const SNAPSHOT_BUDGET_MS = 4_000
/** Wall-clock budget for one page of history and for one commit diff. */
export const HISTORY_BUDGET_MS = 2_000
export const COMMIT_DIFF_BUDGET_MS = 3_000
/** Input event to the painted, settled branch-search result in Electron. */
export const INTERACTION_BUDGET_MS = 250

/** Rows a list renders before it asks the reader to reveal more. */
export const LIST_PAGE_SIZE = 200
/** Rows a code region renders before it asks the reader to reveal more. */
export const DIFF_PAGE_SIZE = 1_000
/** Longest diff preview retained from any single read. */
export const MAX_DIFF_BYTES = 4 * 1024 * 1024
/** Longest working-tree file preview retained. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Longest status listing retained, cut on NUL record boundaries. */
export const MAX_STATUS_BYTES = 8 * 1024 * 1024
/** Longest history page retained, cut on NUL record boundaries. */
export const MAX_HISTORY_BYTES = 1024 * 1024
/** Hard ceiling for any single Git invocation. */
export const MAX_COMMAND_BYTES = 32 * 1024 * 1024
/** Concurrent child Git processes; a repository never forks by branch count. */
export const GIT_CONCURRENCY = 8
/** Branches that receive per-branch merge-base / rev-list analysis per snapshot. */
export const SNAPSHOT_BRANCH_BUDGET = 1_500

/**
 * What a snapshot deliberately left out. The renderer states these instead of
 * pretending an extreme repository was fully analysed.
 */
export interface SnapshotLimits {
  branchesAnalyzed: number
  branchesSkipped: number
  filesListed: number
  filesTruncated: boolean
}

export const EMPTY_SNAPSHOT_LIMITS: SnapshotLimits = {
  branchesAnalyzed: 0,
  branchesSkipped: 0,
  filesListed: 0,
  filesTruncated: false,
}

/** One measured benchmark, compared against its budget in CI. */
export interface BenchmarkMeasurement {
  name: string
  fixture: string
  budgetMs: number
  elapsedMs: number
  /** Extra facts worth trending: row counts, bytes retained, branch counts. */
  detail?: Record<string, number>
}

export interface BenchmarkReport {
  version: 1
  node: string
  platform: string
  generatedAt: string
  measurements: BenchmarkMeasurement[]
}
