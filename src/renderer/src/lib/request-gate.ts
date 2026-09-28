/**
 * Guards asynchronous renderer work against stale application. A claim becomes
 * stale as soon as the selection it was made for changes, or a later claim for
 * the same generation supersedes it, so an obsolete repository switch, refresh,
 * history page, or diff can never be applied to the view the reader now sees.
 */
export interface RequestClaim {
  readonly generation: number
  readonly sequence: number
}

export interface RequestGate {
  /** Invalidates every outstanding claim; call when the selection changes. */
  reset(): number
  /** Registers new work and supersedes earlier work in the same generation. */
  claim(): RequestClaim
  current(claim: RequestClaim): boolean
}

export function createRequestGate(): RequestGate {
  let generation = 0
  let sequence = 0
  return {
    reset() {
      generation += 1
      sequence = 0
      return generation
    },
    claim() {
      sequence += 1
      return { generation, sequence }
    },
    current(claim) {
      return claim.generation === generation && claim.sequence === sequence
    },
  }
}
