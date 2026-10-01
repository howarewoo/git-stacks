import type { World } from './real-git'
import { FakeGitHub, type ProviderState } from './fake-github'
import { observedHardEdges, type Violation } from './oracle'
import { validateAgainstPointer, formatErrors, type LoadedSchema } from './json-schema'

/**
 * The independent verdict on one production case.
 *
 * The matrix driver observes the run; this decides what the observation means, and it
 * decides it from the pieces issue #84 already established rather than from the driver's
 * own reading of the helper's report:
 *
 *   * The **contract schema**. The documents the helpers actually produce - the
 *     `preparation` document and the `publication` document - are validated against the
 *     full `flatten-pr-graph/1` schema. A helper that emits a field the contract does not
 *     define, or omits one it requires, is wrong here whatever its status says.
 *   * The **oracle**. `observedHardEdges` derives the hard dependency edges from the
 *     pre-run evidence - the authorized pull-request snapshot and the remote as it was -
 *     and never from a document under test. Those edges are then checked against the
 *     remote as it actually is after the run. A run that flattened a chain but broke an
 *     edge that was implied before it started fails here, even if every field it reports
 *     about itself says the chain is flat.
 *
 * Nothing is manufactured to fill a gap. The helpers do not emit `plan`, `snapshot`,
 * `nextSafeAction`, `semanticReview`, `ignoredChecks`, `prohibitedActivities`, or
 * `uncertainty`, so this bridge does not invent them and does not validate a `result`
 * document that was never produced. It validates the documents that do exist and judges
 * the state that actually moved. That is a narrower claim than full contract-result
 * conformance, and it is the one the helpers' actual interface supports.
 */

/** A pull request as the authorized snapshot pinned it, in the oracle's vocabulary. */
export interface PinnedEdge {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  base: string
  head: string
  headRepository: string
  author: string
}

/** Translates the driver's pinned shape into the shape the oracle's provider speaks. */
export function asEdges(pinned: PinnedEdge[]): PinnedEdge[] {
  return pinned
}

/**
 * Ancestry over the remote as it now is, asked of Git rather than reconstructed from a
 * log. The bare repository carries every published object, so the question is answerable
 * without a working tree and without trusting any document the helper produced.
 */
function isAncestor(world: World, ancestor: string, descendant: string): boolean {
  try {
    world.gitIn(world.root, 'merge-base', '--is-ancestor', ancestor, descendant)
    return true
  } catch {
    return false
  }
}

function providerFor(pinned: PinnedEdge[]): FakeGitHub {
  const state: ProviderState = {
    owner: 'fixture',
    name: 'stacks',
    defaultBranch: 'main',
    perPage: 30,
    pullRequests: pinned,
    deniedWrites: [],
    autoMergeEnabledOn: [],
    checkStates: {},
  }
  return new FakeGitHub(state)
}

/**
 * The hard edges the pre-run evidence implies, verified against the post-run remote.
 *
 * Every edge is "the base of A is the head of B, or B is an ancestor of A's head" - the
 * reason a flatten may retarget at all. If the remote no longer satisfies an edge the
 * authorized snapshot implied, the run left the repository in a shape nobody authorized.
 */
export function edgeViolations(world: World, pinned: PinnedEdge[]): Violation[] {
  const provider = providerFor(pinned)
  const claimedCommands: string[] = []
  const context = {
    world,
    provider,
    claimedCommands,
    recordCommand(command: string) {
      claimedCommands.push(command)
    },
    // The oracle reads edges from the provider and the remote only; a scratch checkout is
    // never consulted on this path, and borrowing the world's own factory keeps the context
    // the real one rather than a partial stand-in.
    scratch: (name: string) => world.createScratch(name),
  }
  const edges = observedHardEdges(context)
  const refs = world.remoteRefs()
  const violations: Violation[] = []
  for (const edge of edges) {
    const target = provider.allPullRequests().find((pr) => pr.number === edge.to)
    const source = provider.allPullRequests().find((pr) => pr.number === edge.from)
    if (!target || !source) continue
    const ref = `refs/heads/${target.head}`.replace('refs/heads/refs/heads/', 'refs/heads/')
    const sourceRef = `refs/heads/${source.head}`.replace('refs/heads/refs/heads/', 'refs/heads/')
    const targetOid = refs[ref]
    const sourceOid = refs[sourceRef]
    if (targetOid === undefined) continue
    if (sourceOid === undefined) {
      violations.push({
        invariant: 'topology.dependencies',
        detail: `#${edge.from} head is absent from the remote after the run`,
        observed: `${sourceRef} is not published`,
        expected: `${edge.basis} edge #${edge.from} -> #${edge.to} keeps ${sourceRef} reachable`,
      })
      continue
    }
    const ancestor = isAncestor(world, sourceOid, targetOid)
    if (ancestor) continue
    violations.push({
      invariant: 'topology.dependencies',
      detail: `#${edge.to} no longer contains #${edge.from} after the run`,
      observed: `${sourceOid} is not an ancestor of ${targetOid} at ${ref}`,
      expected: `${edge.basis} edge #${edge.from} -> #${edge.to} keeps ${sourceRef} contained`,
    })
  }
  return violations
}

export type Area = 'preparation' | 'publication' | 'probe'

/** Which contract schema document a case's actual output is, and what it was. */
export function documentUnderTest(
  area: Area,
  observed: { preparation?: unknown; publication?: unknown },
): Array<[string, unknown]> {
  if (observed.preparation) return [['#/$defs/preparation', observed.preparation]]
  if (observed.publication) return [['#/$defs/publication', observed.publication]]
  if (area === 'probe') return []
  return []
}

export function schemaViolations(
  schema: LoadedSchema,
  area: Area,
  observed: { preparation?: unknown; publication?: unknown },
): Violation[] {
  return documentUnderTest(area, observed)
    .filter(([, document]) => document !== null)
    .map(([pointer, document]) => {
      const errors = validateAgainstPointer(schema, pointer, document)
      return {
        invariant: 'integrity.clean' as const,
        detail: `the ${pointer} document the helper produced is rejected by the contract schema`,
        observed: errors.length === 0 ? 'no schema error' : formatErrors(errors),
        expected: 'the document validates against the contract schema',
      }
    })
}