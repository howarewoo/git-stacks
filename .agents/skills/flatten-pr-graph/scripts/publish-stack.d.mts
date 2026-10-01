/**
 * Types for `publish-stack.mjs`.
 *
 * `publishStack` is **asynchronous** because the provider module it imports may answer
 * with a promise or with a plain value; the helper awaits all three of its operations, so
 * a promise is the general case and a synchronous provider is already resolved rather than
 * a different interface.
 *
 * `conversations` overrides the three Git conversations the helper has with a remote. It
 * exists so an authoring-time fixture can inject a fault at an exact point - a remote that
 * refuses atomic transactions, a push whose acknowledgement is lost, a ref that moves
 * between the check and the write - while the default path stays real Git. Every key is
 * optional; an omitted key uses real Git.
 */

export type PublicationStatus = 'published' | 'no-op' | 'partial' | 'blocked'

export interface PublicationError {
  code: string
  detail: string
  evidence: string
}

export interface PublicationAttempt {
  sequence: number
  kind: 'ref-update' | 'pr-base-update'
  target: string
  /** A commit id in every attempt: a branch name is never recorded in a SHA field. */
  from: string
  to: string
  acknowledged: boolean
  lease?: { expectedRemote: string; usedForceWithLease: boolean } | null
  outcome: 'acknowledged' | 'denied' | 'rejected' | 'unknown'
}

export interface PublicationDocument {
  contractVersion: 'flatten-pr-graph/1'
  attempts: PublicationAttempt[]
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

export interface PinnedPullRequest {
  number: number
  state: string | null
  draft: boolean | null
  headRef: string
  headRepository: string
  baseRef: string
  headRefOid: string | null
  baseRefOid: string | null
  title: string | null
  body: string | null
  labels: string[] | null
  reviewers: string[] | null
  autoMergeRequest: { enabled: boolean; method: string | null } | null
}

export interface GitConversationOverrides {
  detectAtomicRefTransaction?: (
    repository: string,
    endpoint: string,
    refspecs: string[],
    leases: string[],
  ) => { supported: boolean | null; evidence: string }
  push?: (
    repository: string,
    endpoint: string,
    refspecs: string[],
    leases: string[],
  ) => { ok: boolean; status?: number | null; stdout?: string; stderr?: string }
  readRemoteRefs?: (repository: string, endpoint: string) => Record<string, string>
}

export interface PublicationResult {
  contractVersion: 'flatten-pr-graph/1'
  ok: boolean
  status: PublicationStatus
  errors: PublicationError[]
  publication: PublicationDocument
  capability: {
    atomicRefTransaction: 'supported' | 'unsupported' | 'unknown' | 'not-required'
    providerCompareAndSwap: boolean | null
    /** `read-before-write` is not compare-and-swap, and is never reported as one. */
    baseWritesGuardedBy: 'compare-and-swap' | 'read-before-write' | null
    residualMetadataRace: boolean | null
    blockedControls: string[]
  }
  controls: Array<{
    control: string
    value: string
    inTaskStorage: string
    blocking: boolean
    effect: string
  }>
  authority: {
    source: 'host-pinned-module-and-caller-declared-grant' | 'caller-declared'
    hostVerified: boolean
    granted: string[]
    selection: number[]
  }
  provider: null | { name: string; compareAndSwap?: boolean; trust: string }
  rootAdvance: null | { pinned: string; observed: string; integrated: boolean; note?: string }
  unselectedDependents: unknown[]
  verification: Array<{ invariant: string; method?: string; observed: string; result: string }>
  recovery: null | {
    acknowledgedChanges: string[]
    unconfirmedAttempts: string[]
    recommended: string
  }
  nextSafeAction: null | { action: string; requires: string[] }
  journalPath: string | null
}

export declare function publishStack(
  input: Record<string, unknown>,
  conversations?: GitConversationOverrides,
): Promise<PublicationResult>