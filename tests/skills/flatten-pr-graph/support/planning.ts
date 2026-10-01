/**
 * The planning side of the authoring fixtures: a real run of the skill's own helpers.
 *
 * `fixtures/planning.fixture.ts` declares scenarios; this module performs them by
 * invoking `.agents/skills/flatten-pr-graph/scripts/*.mjs` exactly as the core tells an
 * agent to invoke them, against the disposable world the fixture seeded. Nothing here
 * reimplements the helpers: the point is to exercise the shipped scripts.
 *
 * The provider double records every action it is asked to perform, so a planner that
 * consults check state, widens the selection, or writes anything is visible to the
 * oracle rather than to this module's own assertions.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plan, PrIdentity, Snapshot } from './contract-types'
import type { FixtureContext } from './fixture'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(HERE, '../../../..')
export const SKILL_SCRIPTS = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph/scripts')

/** A hard dependency edge as the discovery helper reports it. */
export interface DiscoveredEdge {
  before: number
  after: number
  source: 'ancestry' | 'pr-base' | 'verified-prerequisite'
  evidence: string
}

/** A structured refusal or contradiction, exactly as a helper reported it. */
export interface HelperError {
  code: string
  detail: string
  evidence: string
}

export interface DiscoveryResult {
  ok: boolean
  edges: DiscoveredEdge[]
  undecidable: Array<{ pair: [number, number]; why: string }>
  unverified: Array<{ before: number; after: number; state: 'unverified'; evidence: string }>
  unselectedDependents: Array<{
    number: number
    dependsOn: number
    basis: 'declared-base' | 'strict-ancestry'
    reportedOnly: true
  }>
  equalHeads: Array<{
    numbers: [number, number]
    headRef: string
    headOid: string | null
    state: 'unsupported-shared-branch'
  }>
  redundantHeads: Array<{
    numbers: [number, number]
    headRefs: [string, string]
    headOid: string
    state: 'redundant-contribution'
  }>
  errors: HelperError[]
}

export interface ProbeEstimate {
  pair: [number, number]
  kind: 'pairwise-probe' | 'measured-merge' | 'unknown'
  value: number | null
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  conflictingPaths?: string[]
  structuralConflict?: boolean
  reason?: string
}

/** The helper's objective, typed by the contract rather than restated here. */
export type PlanObjective = Plan['objective']

export interface PlannedOrder {
  order: number[]
  chain: Array<{
    position: number
    number: number
    fromBase: string
    toBase: string
    change: 'none' | 'base-change' | 'head-update'
  }>
  hardDependencies: DiscoveredEdge[]
  alreadyLinear: boolean
  objective: PlanObjective
}

export interface PlanResult {
  ok: boolean
  errors: HelperError[]
  plan?: PlannedOrder
}

export interface HelperRun<T> {
  result: T
  status: number
}

/** What a paginated page walk observed, including an enumeration it could not finish. */
export interface EnumerationResult {
  listed: number[]
  pagesRead: number
  complete: boolean
  limitation: { limitation: string; effect: string } | null
}

export interface PlanningInput {
  selection: number[]
  /** Task-owned storage for ancestry and probes; defaults to the world's bare remote. */
  repository?: string
  declaredPrerequisites?: Array<{ before: number; after: number; evidence: string }>
  verifiedPrerequisites?: Array<{ before: number; after: number; evidence: string }>
  /** Stops the page walk early so an incomplete enumeration can be observed. */
  maxPages?: number
  /** The verified root branch. Required: nothing here may assume a repository default. */
  rootRef: string
  /** Restricts the search budget, so a fixture can force a bounded, qualified search. */
  maxEnumeratedOrders?: number
  /** Supplies estimates directly instead of probing, for cases about the objective. */
  estimates?: ProbeEstimate[]
  /** Skips probing entirely, for cases where every estimate is unavailable. */
  probe?: boolean
  /** When true, the planner reads check state - the mutation fixtures' deliberate fault. */
  consultCheckState?: boolean
}

export interface PlanningRun {
  discovery: DiscoveryResult
  probes: ProbeEstimate[]
  plan: PlanResult
  enumeration: EnumerationResult
  identities: PrIdentity[]
}

/** Runs a skill helper as a child process and parses its structured result. */
export function runHelper<T>(script: string, document: unknown): HelperRun<T> {
  const child = spawnSync(process.execPath, [join(SKILL_SCRIPTS, script)], {
    input: `${JSON.stringify(document)}\n`,
    encoding: 'utf8',
    cwd: REPOSITORY_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  })
  return { result: JSON.parse(child.stdout) as T, status: child.status ?? 1 }
}

/**
 * The same call for a run that is expected to be refused. A refusal is not an exception
 * here: the helper writes its structured error to stdout and its exit status carries the
 * verdict, so both are read.
 */
export function runHelperExpectingRefusal<T>(script: string, document: unknown): HelperRun<T> {
  const child = spawnSync(process.execPath, [join(SKILL_SCRIPTS, script)], {
    input: `${JSON.stringify(document)}\n`,
    encoding: 'utf8',
    cwd: REPOSITORY_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  })
  return { result: JSON.parse(child.stdout) as T, status: child.status ?? 1 }
}

/** Reads the canonical identity set straight from the provider and the real remote. */
export function identitiesFrom(context: FixtureContext, numbers: number[]): PrIdentity[] {
  const refs = context.world.remoteRefs()
  return numbers.flatMap((number) => {
    const pr = context.provider.pullRequest(number)
    if (!pr) return []
    return [
      {
        number,
        url: `https://github.com/acme/widgets/pull/${number}`,
        state: pr.state.toLowerCase() as PrIdentity['state'],
        isDraft: pr.draft,
        headRef: `refs/heads/${pr.head}`,
        headOid: refs[`refs/heads/${pr.head}`] ?? '0'.repeat(40),
        headRepository: pr.headRepository,
        baseRef: `refs/heads/${pr.base}`,
        baseOid: refs[`refs/heads/${pr.base}`] ?? '0'.repeat(40),
      },
    ]
  })
}

/**
 * The full read-only page walk the core requires. It records one listing action per
 * page, so an incomplete enumeration is visible in the provider's action log and a
 * fixture that stops early leaves that record short.
 */
export function listAllPages(
  context: FixtureContext,
  options: { maxPages?: number } = {},
): EnumerationResult {
  const perPage = 2
  const listed: number[] = []
  let pagesRead = 0
  const total = context.provider.pageCount(perPage)
  while (pagesRead < total) {
    if (options.maxPages !== undefined && pagesRead >= options.maxPages) {
      return {
        listed,
        pagesRead,
        complete: false,
        limitation: {
          limitation: `the listing has ${total} pages of ${perPage} and only ${pagesRead} were read`,
          effect:
            'unselected dependents may be under-reported; the graph is not known to be complete',
        },
      }
    }
    const page = context.provider.listPullRequests(pagesRead + 1, perPage)
    pagesRead += 1
    for (const pr of page) listed.push(pr.number)
    if (page.length === 0) break
  }
  return { listed, pagesRead, complete: true, limitation: null }
}

/**
 * Discovery, then probes, then ordering - the sequence the core states, with the
 * helpers doing the brittle parts and this module only carrying evidence between them.
 * It performs no Git operation of its own and no provider write.
 */
export function planSelection(context: FixtureContext, input: PlanningInput): PlanningRun {
  const enumeration = listAllPages(context, { maxPages: input.maxPages })
  const identities = identitiesFrom(context, input.selection)
  const root = input.rootRef
  const repository = input.repository ?? context.world.remote

  if (input.consultCheckState === true) {
    // The deliberate fault a mutation fixture wants visible: the planner asks the
    // provider about checks, and the provider records the read whatever it answers.
    for (const identity of identities) context.provider.readCheckState(identity.number)
  }

  const unselectedDependents = enumeration.listed
    .filter((number) => !input.selection.includes(number))
    .flatMap((number) => {
      const pr = context.provider.pullRequest(number)
      const head = pr ? `refs/heads/${pr.base}` : ''
      const dependent = identities.find((identity) => identity.headRef === head)
      return dependent
        ? [{ number, dependsOn: dependent.number, basis: 'declared-base' as const }]
        : []
    })

  // The helper nests its findings under `graph` and keeps failures at the top level, so
  // a refusal is read as a refusal and never mistaken for an empty graph.
  const discovered = runHelper<
    { graph: Omit<DiscoveryResult, 'ok' | 'errors'> } & {
      ok: boolean
      errors: HelperError[]
    }
  >('discover-dependencies.mjs', {
    contractVersion: 'flatten-pr-graph/1',
    repository,
    root,
    selected: identities.map((identity) => ({
      number: identity.number,
      headRef: identity.headRef,
      baseRef: identity.baseRef,
    })),
    declaredPrerequisites: input.declaredPrerequisites ?? [],
    verifiedPrerequisites: input.verifiedPrerequisites ?? [],
    unselectedDependents,
  }).result
  const discovery: DiscoveryResult = discovered.graph
    ? { ...discovered.graph, ok: discovered.ok, errors: discovered.errors ?? [] }
    : {
        ok: false,
        edges: [],
        undecidable: [],
        unverified: [],
        unselectedDependents: [],
        equalHeads: [],
        redundantHeads: [],
        errors: discovered.errors ?? [],
      }

  const pairs: Array<{ before: number; after: number; beforeRef: string; afterRef: string }> = []
  for (const left of identities) {
    for (const right of identities) {
      if (left.number >= right.number) continue
      pairs.push({
        before: left.number,
        after: right.number,
        beforeRef: left.headRef,
        afterRef: right.headRef,
      })
    }
  }
  const measured =
    input.estimates ??
    (input.probe === false
      ? []
      : runHelper<{ estimates: ProbeEstimate[] }>('measure-conflict.mjs', {
          contractVersion: 'flatten-pr-graph/1',
          repository,
          pairs,
        }).result.estimates)

  const plan = runHelper<PlanResult>('plan-order.mjs', {
    contractVersion: 'flatten-pr-graph/1',
    root,
    selected: input.selection,
    declaredBases: Object.fromEntries(
      identities.map((identity) => [String(identity.number), identity.baseRef]),
    ),
    headRefs: Object.fromEntries(
      identities.map((identity) => [String(identity.number), identity.headRef]),
    ),
    hardDependencies: discovery.edges,
    estimates: measured.map((estimate) => ({
      pair: estimate.pair,
      kind: estimate.kind,
      value: estimate.value,
      confidence: estimate.confidence,
    })),
    // Every successor in the chain integrates its predecessor, so it needs one push.
    integrationPushes: Object.fromEntries(
      input.selection.slice(1).map((number) => [String(number), true]),
    ),
    budget: input.maxEnumeratedOrders
      ? { maxEnumeratedOrders: input.maxEnumeratedOrders }
      : undefined,
  }).result

  return { discovery, probes: measured, plan, enumeration, identities }
}

/**
 * Every order a small graph admits, in deterministic order. A fixture compares the
 * helper's answer against this set exhaustively, for the *same declared objective*.
 */
export function allValidOrders(
  selection: number[],
  edges: Array<{ before: number; after: number }>,
): number[][] {
  const results: number[][] = []
  const walk = (partial: number[], remaining: number[]): void => {
    if (remaining.length === 0) {
      results.push(partial)
      return
    }
    for (const [index, number] of remaining.entries()) {
      const placed = [...partial, number]
      const legal = edges.every((edge) =>
        edge.before === number
          ? placed.includes(edge.after)
          : edge.after !== number || placed.includes(edge.before),
      )
      if (!legal) continue
      walk(
        placed,
        remaining.filter((_, position) => position !== index),
      )
    }
  }
  walk([], [...selection])
  return results
}

export interface ObjectiveInputs {
  root: string
  bases: Record<string, string>
  heads: Record<string, string>
  pushes: Record<string, boolean>
  estimates: ProbeEstimate[]
}

export interface ObjectiveTotals {
  work: number
  unknown: number
  disruption: number
}

/**
 * `ordering.md` §2.1's objective, recomputed here independently of the helper so a
 * fixture can check the helper's totals rather than restate them.
 */
export function objectiveTotals(order: number[], inputs: ObjectiveInputs): ObjectiveTotals {
  let work = 0
  let unknown = 0
  let disruption = 0
  let previousBase = inputs.root
  let previousNumber: number | null = null
  for (const number of order) {
    const base = inputs.bases[String(number)]
    if (base !== undefined && base !== previousBase) disruption += 1
    if (inputs.pushes[String(number)] === true) disruption += 1
    if (previousNumber !== null) {
      const estimate = inputs.estimates.find((entry) => {
        const [left, right] = entry.pair
        return (
          (left === previousNumber && right === number) ||
          (left === number && right === previousNumber)
        )
      })
      if (!estimate || estimate.kind === 'unknown' || estimate.value === null) unknown += 1
      else work += estimate.value
    }
    previousBase = inputs.heads[String(number)] ?? base ?? previousBase
    previousNumber = number
  }
  return { work, unknown, disruption }
}

export interface SkillCore {
  frontMatter: string
  body: string
}

/** Reads the shipped SKILL.md, so activation checks read one source of truth. */
export function readSkillCore(): SkillCore {
  const text = readFileSync(
    join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph/SKILL.md'),
    'utf8',
  )
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error('SKILL.md has no YAML front matter')
  return { frontMatter: match[1], body: match[2] }
}

/** Every permitted, forbidden, and check-state action the run actually performed. */
export function actionSummary(context: FixtureContext): Record<string, number> {
  const summary: Record<string, number> = {}
  for (const action of context.provider.actions) {
    summary[action.kind] = (summary[action.kind] ?? 0) + 1
  }
  return summary
}

/** The per-ref reconciliation a planning result records between provider and storage. */
export function reconcileHeads(
  identities: PrIdentity[],
  storage: Record<string, string>,
): Snapshot['history']['reconciliation'] {
  return identities.map((identity) => {
    const fetched = storage[identity.headRef] ?? null
    const state: Snapshot['history']['reconciliation'][number]['state'] =
      fetched === null ? 'unreachable' : fetched === identity.headOid ? 'agreed' : 'provider-ahead'
    return { ref: identity.headRef, observed: identity.headOid, fetched, state }
  })
}

/** The helper's own source, so a fixture can prove the shipped script is what ran. */
export function loadHelperSource(script: string): string {
  return readFileSync(join(SKILL_SCRIPTS, script), 'utf8')
}
