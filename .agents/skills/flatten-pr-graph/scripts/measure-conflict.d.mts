/**
 * The measurement helper's actual interface.
 *
 * `measureConflicts` is **synchronous**: every Git call it makes is a real child process
 * and it has no provider boundary, so it answers with the estimate list itself rather than
 * with a promise. `git` is injected by the caller and may answer with a promise of its
 * own; `measureConflicts` never sees one, because it does not run asynchronously.
 */
export interface PairProbe {
  before: number
  after: number
  beforeRef: string
  afterRef: string
}

export interface ControlRecord {
  control: string
  value: string
  inTaskStorage: string
  blocking: boolean
  effect: string
}

export type EstimateKind = 'pairwise-probe' | 'measured-merge' | 'unknown'

export interface ConflictEstimate {
  pair: [number, number]
  beforeRef?: string
  afterRef?: string
  kind: EstimateKind
  value: number | null
  confidence: 'high' | 'unknown'
  conflictingPaths: string[]
  structuralConflict?: boolean
  resultTree?: string | null
  report?: string[]
  controls?: ControlRecord[]
  reason?: string
}

export interface MeasureConflictsResult {
  contractVersion: string
  ok: boolean
  repository: string
  shallow: boolean
  estimates: ConflictEstimate[]
  unknownEstimates: number
}

export declare function measureConflicts(raw: Record<string, unknown>): MeasureConflictsResult
