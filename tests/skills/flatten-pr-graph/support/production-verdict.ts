import type { World } from './real-git'
import { FakeGitHub, type ProviderState } from './fake-github'
import { observedHardEdges, type Violation } from './oracle'
import { validateAgainstPointer, formatErrors, type LoadedSchema } from './json-schema'
import type { ProviderAction } from './production'

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

/**
 * Ancestry over the remote as it now is, asked of Git rather than reconstructed from a
 * log. The bare repository carries every published object, so the question is answerable
 * without a working tree and without trusting any document the helper produced.
 */
/**
 * Ancestry over the bare remote - the repository the run actually wrote to.
 *
 * It must be that repository and not the world's temporary directory: the objects the run
 * published live only there, and a `merge-base` run anywhere else finds no repository at
 * all, so every edge reads as violated and the verdict reports the run as broken for the
 * one thing it did correctly.
 */
function isAncestor(world: World, ancestor: string, descendant: string): boolean {
  return world.isRemoteAncestor(ancestor, descendant)
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
export function edgeViolations(world: World, baseline: EdgeBaseline): Violation[] {
  const provider = providerFor(baseline.pinned)
  const context = {
    world,
    provider,
    claimedCommands: [] as string[],
    recordCommand(command: string) {
      context.claimedCommands.push(command)
    },
    scratch: (name: string) => world.createScratch(name),
  }
  // Derived from the pre-run evidence the baseline froze, never from the remote as the run
  // left it. Deriving them afterwards would take the run's own published ancestry as the
  // baseline, so an edge the run destroyed would be compared against itself and pass.
  const edges = observedHardEdges(context, baseline.refs)
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
    if (isAncestor(world, sourceOid, targetOid)) continue
    violations.push({
      invariant: 'topology.dependencies',
      detail: `#${edge.to} no longer contains #${edge.from} after the run (${edge.basis} edge)`,
      observed: `${sourceOid} is not an ancestor of ${targetOid} at ${ref}`,
      expected: `${edge.basis} edge #${edge.from} -> #${edge.to} keeps ${sourceRef} contained`,
    })
  }
  return violations
}

/**
 * The action oracle: what the server and the remote actually recorded.
 *
 * A publication document says which writes were confirmed. The only evidence that can
 * back that is the provider's own action log and the remote as it now stands, so the
 * server-side record is replayed into the same `FakeGitHub` the rest of #84 uses and the
 * two are compared. This is the low-level form of the claim: it is not a result document
 * check, and it does not borrow `judge`'s result-document conformance, which the raw
 * helpers never produce.
 */
/** One entry of the contract's `publication.confirmed`, verbatim. */
export interface ConfirmedChange {
  kind: string
  target: string
  oid: string
}

/**
 * The refspecs a `git push` actually asked for, and whether it was a dry run.
 *
 * Anything beginning with `-` is an option, not a refspec, and that distinction is the
 * whole point: `--force-with-lease=refs/heads/feat-a:<sha>` names the ref and the value it
 * must still hold, and a substring search over all arguments finds the branch there and
 * credits a push that never mentioned it as a destination. A dry run is not an attempted
 * write either, so it is reported rather than quietly dropped.
 */
export function attemptedRefspecs(command: { args: string[] }): {
  refspecs: string[]
  dryRun: boolean
} {
  const positional = command.args.filter((arg) => !arg.startsWith('-'))
  const separator = positional.indexOf('--')
  const head = separator === -1 ? positional : positional.slice(0, separator)
  const rest = separator === -1 ? [] : positional.slice(separator + 1)
  return {
    // The first positional is the subcommand; the rest are the repository and the refspecs.
    refspecs: [...head.slice(2), ...rest],
    dryRun: command.args.includes('--dry-run') || command.args.includes('-n'),
  }
}

/** The `refs/...` name a refspec targets and the value it asked that ref to reach. */
function refspecTarget(refspec: string): { ref: string; oid: string } | null {
  const colon = refspec.lastIndexOf(':')
  if (colon <= 0) return null
  const value = refspec.slice(0, colon)
  const ref = refspec.slice(colon + 1)
  if (!ref.startsWith('refs/')) return null
  return { ref, oid: value }
}

export function actionViolations(
  confirmed: ConfirmedChange[],
  observed: {
    actions: ProviderAction[]
    refs: Record<string, string>
    /** Every native Git process the helper started, from the PATH shim. */
    trace: Array<{ cwd: string; args: string[]; exitCode: number | null }>
  },
): Violation[] {
  const provider = new FakeGitHub({
    owner: 'fixture',
    name: 'stacks',
    defaultBranch: 'main',
    perPage: 30,
    pullRequests: [],
    deniedWrites: [],
    autoMergeEnabledOn: [],
    checkStates: {},
  })
  for (const action of observed.actions) {
    provider.recordAction(action.kind, action.target, action.outcome)
  }
  const violations: Violation[] = []
  for (const claim of confirmed) {
    if (claim.kind === 'pr-base-update') {
      // A base write is a provider operation, not a Git one: what backs the claim is the
      // server's own record saying it acknowledged exactly this write. A Git trace could
      // not speak to it at all, and conflating the two would let a push stand in for a
      // metadata write that never happened.
      const target = claim.target.replace(/^#/, '')
      const base = provider.actions.find(
        (action) => action.kind === 'update-pr-base' && action.target === target,
      )
      if (base?.outcome === 'acknowledged') continue
      violations.push({
        invariant: 'remote.claims-match' as const,
        detail: `the document confirms a base update of #${target} that the server never acknowledged`,
        observed: base
          ? `the provider recorded it as ${base.outcome}`
          : 'the provider recorded no such write',
        expected: 'a confirmed base update is backed by an acknowledged provider action',
      })
      continue
    }

    const branch = claim.target.replace(/^refs\/heads\//, '')
    const ref = `refs/heads/${branch}`
    // Three independent facts, all required. The remote carrying the ref proves only that
    // somebody wrote it - the branch was there before the run. What backs a confirmed push
    // is that this run issued a *non-dry-run* push whose refspecs name this ref at exactly
    // the confirmed commit, that the push exited 0, and that the remote now carries exactly
    // that commit. An existing ref plus a dry-run lease satisfies none of those, which is
    // the combination that used to pass here.
    const pushes = observed.trace.filter((command) => command.args.includes('push'))
    const attempted = pushes.filter(
      (command) =>
        !attemptedRefspecs(command).dryRun &&
        attemptedRefspecs(command).refspecs.some((refspec) => {
          const target = refspecTarget(refspec)
          return target !== null && target.ref === ref && target.oid === claim.oid
        }),
    )
    const problems: string[] = []
    if (!/^[0-9a-f]{40}$/.test(claim.oid)) {
      problems.push(`the confirmed change carries no commit id: ${JSON.stringify(claim.oid)}`)
    }
    if (attempted.length === 0) {
      const named = pushes
        .flatMap((command) => attemptedRefspecs(command).refspecs)
        .map((refspec) => refspecTarget(refspec))
        .filter((target) => target?.ref === ref)
        .map((target) => `${target?.oid}:${target?.ref}`)
      problems.push(
        named.length > 0
          ? `no non-dry-run push carried ${claim.oid} to ${ref}; the run asked for ${named.join(', ')}`
          : `no non-dry-run push named ${ref} at ${claim.oid}`,
      )
    } else {
      const failed = attempted.filter((command) => command.exitCode !== 0)
      if (failed.length > 0) {
        problems.push(
          `the push of ${claim.oid} to ${ref} exited ${failed.map((c) => c.exitCode).join(', ')}`,
        )
      }
    }
    const landed = observed.refs[ref]
    if (landed === undefined) problems.push(`${ref} is absent from the remote`)
    else if (landed !== claim.oid)
      problems.push(`${ref} is at ${landed}, not the confirmed ${claim.oid}`)
    if (problems.length === 0) continue
    violations.push({
      invariant: 'remote.claims-match' as const,
      detail: `the document confirms a ref update of ${ref} that the run did not make`,
      observed: problems.join('; '),
      expected:
        'a confirmed ref update is a successful non-dry-run push of that exact commit to that exact ref, and the remote confirms it',
    })
  }
  return violations
}

/**
 * Checks are never read.
 *
 * The publication may not consult a check state, a merge queue, a ruleset, or a branch
 * protection, and `readCheckState` records the consultation as an action whether or not it
 * changes the decision. An observed read is therefore the finding, whatever the run then
 * did: the boundary is not "did it decide on the check state" but "did it look".
 */
export function checkStateViolations(provider: FakeGitHub): Violation[] {
  return provider.actions
    .filter((action) => action.kind === 'read-check-state')
    .map((action) => ({
      invariant: 'integrity.clean' as const,
      detail: `the run read a check state for #${action.target}`,
      observed: `read-check-state ${action.target} at ${action.at}`,
      expected: 'no check state, merge queue, ruleset, or branch protection is read',
    }))
}

/**
 * The status the observed state supports, derived without reading the document.
 *
 * A run that reports `published` while a selected head is not at its prepared commit has
 * claimed a completion the remote contradicts, and that is the check the status itself
 * exists for. Everything is read from the remote and the provider, never from the report.
 */
export function statusViolations(
  reported: { status: string },
  expected: { preparedHeads: Record<number, string>; branches: Record<number, string> },
  refs: Record<string, string>,
): Violation[] {
  if (reported.status !== 'published' && reported.status !== 'no-op') return []
  const violations: Violation[] = []
  for (const number of Object.keys(expected.preparedHeads).map(Number)) {
    const branch = expected.branches[number]
    const prepared = expected.preparedHeads[number]
    if (branch === undefined || prepared === undefined) continue
    const ref = `refs/heads/${branch}`
    const observed = refs[ref]
    if (observed === prepared) continue
    violations.push({
      invariant: 'status.legality' as const,
      detail: `the run reports ${reported.status} while ${ref} is not at the prepared commit`,
      observed:
        observed === undefined ? `${ref} is absent from the remote` : `${ref} is at ${observed}`,
      expected: 'a reported completion has every selected head at its prepared commit',
    })
  }
  return violations
}

/** The evidence a run has to keep, captured before the run touched anything. */
export interface EdgeBaseline {
  pinned: PinnedEdge[]
  /** Every ref on the remote as it stood before the first actor. */
  refs: Record<string, string>
}

export type Area = 'preparation' | 'publication' | 'probe'

/** Which contract schema document a case's actual output is, and what it was. */
/**
 * Every document the run actually emitted, not just the first one.
 *
 * A run that produces both a preparation and a publication has to satisfy the schema for
 * both; checking one and letting the other through unchecked would be a narrower verdict
 * than the name claims.
 */
export function documentUnderTest(
  _area: Area,
  observed: { preparation?: unknown; publication?: unknown },
): Array<[string, unknown]> {
  const documents: Array<[string, unknown]> = []
  if (observed.preparation) documents.push(['#/$defs/preparation', observed.preparation])
  if (observed.publication) documents.push(['#/$defs/publication', observed.publication])
  return documents
}

/**
 * A violation only when the schema actually rejected the document.
 *
 * Returning an entry for a conforming document would make a passing document a failure:
 * the caller reads every entry as a violation, so a report of "no schema error" would
 * assert that the schema did reject it.
 */
export function schemaViolations(
  schema: LoadedSchema,
  area: Area,
  observed: { preparation?: unknown; publication?: unknown },
): Violation[] {
  const failures: Violation[] = []
  for (const [pointer, document] of documentUnderTest(area, observed)) {
    if (document === null || document === undefined) continue
    const errors = validateAgainstPointer(schema, pointer, document)
    if (errors.length === 0) continue
    failures.push({
      invariant: 'integrity.clean' as const,
      detail: `the ${pointer} document the helper produced is rejected by the contract schema`,
      observed: formatErrors(errors),
      expected: 'the document validates against the contract schema',
    })
  }
  return failures
}
