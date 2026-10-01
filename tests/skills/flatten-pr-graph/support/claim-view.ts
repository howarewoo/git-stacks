/**
 * Reading an untrusted result document.
 *
 * The oracle never trusts a result's `status` flag, and it never casts one. Every
 * field it needs is narrowed here, so a document that lies — or is not a document at
 * all — becomes a missing value the oracle can report instead of a crash.
 */

export interface ClaimView {
  present: boolean
  status: string | null
  intent: string | null
  rootOid: string | null
  snapshotRefOids: Record<string, string>
  requestedInputs: string[]
  resolvedNumbers: number[]
  duplicatesCollapsed: number[]
  order: number[]
  dependencies: Array<[number, number]>
  proposedWriteChanges: string[]
  /** Each write the plan proposes, so an edge a retarget would create is recognisable. */
  proposedWrites: Array<{ kind: string; target: string; change: string }>
  remoteClaims: Array<{ kind: string; target: string; observed: unknown }>
  confirmed: Array<{ kind: string; target: string; oid: string }>
  blockedCodes: string[]
  preparationPresent: boolean
  /** Each declared dependency with the evidence source it names, or null when unnamed. */
  dependencySources: Array<[number, number, string | null]>
  publicationPresent: boolean
  recoveryPresent: boolean
  checksExecuted: string[]
  unautomatedReview: boolean
}

/**
 * The canonical guard for untrusted documents in this authoring harness. It proves an
 * object and nothing about its fields; callers narrow each field they read.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function refOids(value: unknown): Record<string, string> {
  const oids: Record<string, string> = {}
  for (const entry of array(value)) {
    const ref = text(record(entry).ref)
    const oid = text(record(entry).oid)
    if (ref && oid) oids[ref] = oid
  }
  return oids
}

function dependencies(value: unknown): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (const entry of array(value)) {
    const before = number(record(entry).before)
    const after = number(record(entry).after)
    if (before !== null && after !== null) pairs.push([before, after])
  }
  return pairs
}

function dependencySources(value: unknown): Array<[number, number, string | null]> {
  const entries: Array<[number, number, string | null]> = []
  for (const entry of array(value)) {
    const before = number(record(entry).before)
    const after = number(record(entry).after)
    if (before !== null && after !== null) entries.push([before, after, text(record(entry).source)])
  }
  return entries
}

export function viewClaim(claim: unknown): ClaimView {
  const root = record(claim)
  const snapshot = record(root.snapshot)
  const selection = record(snapshot.selection)
  const plan = record(root.plan)
  const preparation = root.preparation
  const publication = record(root.publication)
  const ignoredChecks = record(root.ignoredChecks)
  const semanticReview = record(root.semanticReview)
  return {
    present: isRecord(claim),
    status: text(root.status),
    intent: text(root.intent),
    rootOid: text(record(snapshot.root).oid),
    snapshotRefOids: refOids(snapshot.refs),
    requestedInputs: array(selection.requested).flatMap((input) => {
      const value = text(input)
      return value ? [value] : []
    }),
    resolvedNumbers: array(selection.resolved).flatMap((entry) => {
      const value = number(record(entry).number)
      return value === null ? [] : [value]
    }),
    duplicatesCollapsed: array(selection.duplicatesCollapsed).flatMap((entry) => {
      const value = number(record(entry).canonical)
      return value === null ? [] : [value]
    }),
    order: array(plan.order).flatMap((entry) => {
      const value = number(record(entry).number)
      return value === null ? [] : [value]
    }),
    dependencies: dependencies(plan.hardDependencies),
    dependencySources: dependencySources(plan.hardDependencies),
    proposedWriteChanges: array(plan.proposedWrites).flatMap((entry) => {
      const value = text(record(entry).change)
      return value ? [value] : []
    }),
    proposedWrites: array(plan.proposedWrites).flatMap((entry) => {
      const kind = text(record(entry).kind)
      const target = text(record(entry).target)
      const change = text(record(entry).change)
      return kind && target ? [{ kind, target, change: change ?? '' }] : []
    }),
    remoteClaims: array(publication.remoteClaims).flatMap((entry) => {
      const kind = text(record(entry).kind)
      const target = text(record(entry).target)
      return kind && target ? [{ kind, target, observed: record(entry).observed }] : []
    }),
    confirmed: array(publication.confirmed).flatMap((entry) => {
      const kind = text(record(entry).kind)
      const target = text(record(entry).target)
      const oid = text(record(entry).oid)
      return kind && target && oid ? [{ kind, target, oid }] : []
    }),
    blockedCodes: array(root.blockedReasons).flatMap((entry) => {
      const value = text(record(entry).code)
      return value ? [value] : []
    }),
    preparationPresent: isRecord(preparation),
    publicationPresent: isRecord(root.publication),
    recoveryPresent: isRecord(root.recovery),
    checksExecuted: array(ignoredChecks.executed).flatMap((entry) => {
      const value = text(entry)
      return value ? [value] : []
    }),
    unautomatedReview:
      semanticReview.automated === false && semanticReview.humanReviewRequired === true,
  }
}
