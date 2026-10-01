/**
 * TypeScript shapes for the `flatten-pr-graph/1` documents.
 *
 * These types make fixture code readable; they do not make a document legal. Every
 * document a fixture produces is validated against
 * `.agents/skills/flatten-pr-graph/references/schemas/contract.schema.json` before the
 * oracle judges it, so a type that drifts from the schema fails the authoring run
 * rather than passing silently.
 */

import type { Invariant } from './actions'

export const CONTRACT_VERSION = 'flatten-pr-graph/1'

export type Status = 'planned' | 'prepared' | 'published' | 'no-op' | 'blocked' | 'partial'
export type Intent = 'preview' | 'execute'
export type Qualification = 'exact-for-declared-objective' | 'best-found' | 'heuristic'

export type BlockedCode =
  | 'missing-selection'
  | 'unsupported-input'
  | 'missing-permission'
  | 'missing-external-prerequisite'
  | 'missing-history'
  | 'contradictory-graph'
  | 'ambiguous-ownership'
  | 'stale-snapshot'
  | 'active-landing-arrangement'
  | 'unresolved-conflict'
  | 'conflicting-environment-control'
  | 'lost-original-commit'

export interface PrIdentity {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  headRef: string
  headOid: string
  headRepository: string
  baseRef: string
  baseOid: string
}

export interface Snapshot {
  contractVersion: string
  capturedAt: string
  intent: Intent
  repository: { host: string; owner: string; name: string; defaultBranch: string; verified: true }
  root: {
    ref: string
    oid: string
    source: 'explicit' | 'repository-default' | 'declared-prerequisite'
  }
  selection: {
    requested: string[]
    resolved: PrIdentity[]
    duplicatesCollapsed: Array<{ canonical: number; inputs: string[] }>
  }
  refs: Array<{ ref: string; oid: string }>
  userWorkspace: {
    present: boolean
    headRef: string | null
    dirtyPaths: string[]
    stashCount: number
    configDigest: string
  }
  history: {
    complete: boolean
    shallow: boolean
    grafted: number
    /** Refs sharing no merge base with the root; ancestry there is undecidable, not negative. */
    unrelated: string[]
    /** Provider-observed SHAs reconciled against what task-owned storage actually holds. */
    reconciliation: Array<{
      ref: string
      observed: string
      fetched: string | null
      state: 'agreed' | 'provider-ahead' | 'storage-ahead' | 'unreachable'
    }>
  }
  externalPrerequisites: Array<{
    ref: string
    state: 'satisfied' | 'unsatisfied' | 'unknown'
    satisfiedBy: 'selected-root-ancestry' | 'recorded-landing' | 'none'
    evidence: string
  }>
  unselectedDependents: Array<{
    number: number
    dependsOn: number
    basis: 'declared-base' | 'strict-ancestry'
    reportedOnly: true
  }>
  capabilityLimitations: Array<{ limitation: string; effect: string }>
  landing: {
    /** Selected pull requests whose own auto-merge request is active, by number. */
    autoMergeEnabledOn: number[]
  }
}

export interface PlanWrite {
  kind: 'ref-update' | 'pr-base-update'
  target: string
  change: 'none' | 'base-change' | 'head-update'
  reason: string
}

export interface ProhibitedActivity {
  activity: string
  performed: boolean
  evidence: string
}

export interface Plan {
  contractVersion: string
  intent: Intent
  order: Array<{
    position: number
    number: number
    fromBase: string
    toBase: string
    change: 'none' | 'base-change' | 'head-update'
  }>
  hardDependencies: Array<{
    before: number
    after: number
    source: 'ancestry' | 'pr-base' | 'verified-prerequisite'
    evidence: string
  }>
  ambiguities: Array<{ item: string; why: string }>
  objective: {
    declared: string[]
    estimates: Array<{
      pair: [number, number]
      kind: 'pairwise-probe' | 'measured-merge' | 'unknown'
      value: number | null
      confidence: 'high' | 'medium' | 'low' | 'unknown'
    }>
    componentTotals: {
      /** Sum of measured pairwise conflict work over the chosen order. */
      estimatedConflictResolutionWork: number
      /** Base retargets plus integration pushes the chosen order requires. */
      historyDisruption: number
      /** Estimates that could not be produced. Never folded into a zero total. */
      unknownEstimates: number
    }
    /** What is known about the prepared cumulative stack, which pairwise probes cannot measure. */
    cumulative: {
      kind: 'pairwise-only' | 'measured-cumulative'
      value: number | null
      why: string
    }
    qualification: Qualification
    budget: {
      probes: number
      exhausted: boolean
      ordersEnumerated: number
      orderEvaluations: number
      orderEvaluationLimit: number
      search: 'stable-topological-baseline' | 'conflict-aware' | 'exhaustive'
    }
    unknownTreatedAsZero: false
  }
  proposedWrites: PlanWrite[]
  prohibitedActivitiesNotPerformed: ProhibitedActivity[]
  /** Something this plan could not observe or do; an incomplete graph is never silent. */
  capabilityLimitations: Array<{ limitation: string; effect: string }>
}

export interface Preparation {
  contractVersion: string
  workspaceKind: 'task-owned-isolated'
  branches: Array<{
    number: number
    originalHead: string
    preparedHead: string
    basedOn: string
    retainedOriginalCommits: string[]
    historyPolicy: 'preserve-original-commits'
  }>
  lostOriginalCommits: string[]
  cumulativeIntegration: Array<{
    number: number
    integratedPreparedStateOf: number
    evidence: string
  }>
  conflicts: Array<{
    number: number
    path: string
    resolution: 'both-sides-with-stated-intent' | 'clean-merge'
  }>
  unresolved: string[]
  indexState: {
    unmergedEntries: string[]
    operationsInProgress: string[]
    conflictMarkersInTree: string[]
  }
}

export interface Attempt {
  sequence: number
  kind: 'ref-update' | 'pr-base-update'
  target: string
  from: string
  to: string
  acknowledged: boolean
  lease?: { expectedRemote: string; usedForceWithLease: boolean } | null
  outcome: 'acknowledged' | 'denied' | 'rejected' | 'unknown'
}

export interface Publication {
  contractVersion: string
  attempts: Attempt[]
  confirmed: Array<{ kind: string; target: string; oid: string }>
  unconfirmed: Array<{ kind: string; target: string; why: string }>
  denials: Array<{ kind: string; target: string; reason: string; acknowledged: boolean }>
  remoteClaims: Array<{
    kind: 'pr-base' | 'ref-oid'
    target: string
    observed: string | boolean
    observedAt: string
  }>
  interrupted: boolean
  concurrency: { leaseHeld: boolean; conflictingRemoteMoveDetected: boolean }
}

export interface ResultDocument {
  contractVersion: string
  status: Status
  intent: Intent
  snapshot: Snapshot
  plan: Plan
  preparation?: Preparation
  publication?: Publication
  blockedReasons?: Array<{ code: BlockedCode; detail: string; evidence: string }>
  recovery?: {
    acknowledgedChanges: string[]
    unconfirmedAttempts: string[]
    recommended: string
  }
  ignoredChecks: {
    policy: 'never-run-poll-wait-rerun-repair-or-gate'
    executed: string[]
    suppressedOrWeakened: string[]
    remoteTriggeredLeftAlone: true
  }
  prohibitedActivities: ProhibitedActivity[]
  uncertainty: Array<{ item: string; why: string }>
  nextSafeAction: { action: string; requires: string[] }
  semanticReview: {
    automated: false
    rubric: string
    humanReviewRequired: true
    reviewerVerdict: 'unreviewed' | 'pass' | 'fail'
  }
  verification: Array<{
    invariant: string
    method: string
    observed: string
    result: 'pass' | 'fail' | 'unautomated'
  }>
}

export interface FixtureExpectation {
  status: Status
  intent?: Intent
  permittedActions: string[]
  forbiddenActions: string[]
  chain: number[]
  preserved: { root: boolean; unselectedRefs: string[]; userWorkspace: boolean }
  /** The invariant this fixture exists to prove the oracle detects when the state breaks. */
  mustDetectInvariant: Invariant
  honestResult: boolean
  retainedOriginalCommits?: string[]
  lostOriginalCommits?: string[]
  blockedCode?: BlockedCode
  notes?: string
}
