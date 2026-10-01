/**
 * Types for `prepare-stack.mjs`.
 *
 * `prepareStack` is **synchronous**. Every Git call it makes is `execFileSync`, and the
 * provider boundary it has no part in; the declared return type says so. A caller that
 * awaits it still works - `await` on a plain value resolves to that value - but a caller
 * that plans around a pending promise, or that types the result as a promise, is reading
 * an interface this module does not have.
 */

export type PreparedStatus = 'prepared' | 'partial' | 'blocked'

export interface PreparationError {
  code: string
  detail: string
  evidence: string
}

export interface PreparedBranch {
  number: number
  originalHead: string
  preparedHead: string
  basedOn: string
  retainedOriginalCommits: string[]
  historyPolicy: 'preserve-original-commits'
}

export interface PreparationIntegrity {
  unmergedEntries: string[]
  operationsInProgress: string[]
  conflictMarkersInTree: string[]
}

export interface PreparationDocument {
  contractVersion: 'flatten-pr-graph/1'
  workspaceKind: 'task-owned-isolated'
  branches: PreparedBranch[]
  lostOriginalCommits: string[]
  cumulativeIntegration: Array<{
    number: number
    integratedPreparedStateOf: number
    evidence: string
  }>
  conflicts: Array<{ number: number; path: string; resolution: string }>
  unresolved: string[]
  indexState: PreparationIntegrity
}

export interface UserWorkspaceFingerprint {
  present: true
  path: string
  headRef: string
  headOid: string | null
  status: string
  dirtyPaths: string[]
  stagedPaths: string[]
  untrackedPaths: string[]
  indexDigest: string
  worktreeDigest: string
  stashOids: string
  stashCount: number
  configDigest: string
  identity: string
  operationsInProgress: string[]
  shallow: boolean
}

export interface EnvironmentControl {
  control: string
  value: string
  inTaskStorage: string
  blocking: boolean
  effect: string
}

export interface PreparationRun {
  runId: string
  runDirectory: string
  storage?: string
  journalPath: string
  workspaces: string[]
  backupRefs: string[]
  note?: string
}

export interface ConflictEvidence extends Record<string, unknown> {
  number: number
  path: string
  kind: string
  needsDecision: boolean
  decision: null | { kind: string; intent: string; reason: string; resolvedAbsent: boolean }
}

export interface PreparedRunDocument {
  contractVersion: 'flatten-pr-graph/1'
  ok: boolean
  status: PreparedStatus
  errors: PreparationError[]
  run: PreparationRun | null
  preparation: PreparationDocument | null
  verification: Array<{ invariant: string; observed: string; result: string }>
  continuation: { prepared: number[]; remaining: number[]; resumeFrom: number | null }
  conflicts: ConflictEvidence[]
  decisions: Array<{ number: number; path: string; kind: string; intent: string; reason: string }>
  controls: EnvironmentControl[]
  userWorkspace: UserWorkspaceFingerprint | null
  /** Present when the run answered from a recorded journal instead of doing the work. */
  repeated?: boolean
}

/**
 * Reads the user's checkout without writing to it: branch, HEAD, porcelain status, staged
 * and worktree digests, stash object ids, local configuration, identity, and any Git
 * operation already in progress. `null` when no workspace was named.
 */

export declare function prepareStack(input: Record<string, unknown>): PreparedRunDocument
