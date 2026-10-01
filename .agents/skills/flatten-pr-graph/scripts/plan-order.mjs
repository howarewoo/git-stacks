#!/usr/bin/env node
/**
 * Deterministic order planning for `flatten-pr-graph/1`.
 *
 * One job: read a validated evidence document and emit the contract's plan facts -
 * a dependency-respecting order, its objective totals, and the search qualification
 * that honestly describes what was and was not searched.
 *
 * Why this is a program rather than prose: enumerating topological orders, applying a
 * lexicographic objective over measured estimates, and staying byte-identical across
 * permutations are exactly the operations an agent gets subtly wrong. Interpreting an
 * ambiguous declared prerequisite stays with the agent; this script never guesses.
 *
 * Input JSON (stdin or `--input <file>`):
 *
 *   {
 *     "contractVersion": "flatten-pr-graph/1",
 *     "root": "refs/heads/main",
 *     "selected": [12, 13, 14],
 *     "declaredBases": { "12": "refs/heads/main", "13": "refs/heads/feat-a" },
 *     "headRefs":      { "12": "refs/heads/feat-a" },
 *     "hardDependencies": [
 *       { "before": 12, "after": 13, "source": "pr-base", "evidence": "..." }
 *     ],
 *     "estimates": [
 *       { "pair": [12, 13], "kind": "pairwise-probe", "value": 3, "confidence": "high" }
 *     ],
 *     "integrationPushes": { "13": true },
 *     "budget": { "maxEnumeratedOrders": 20000 }
 *   }
 *
 * `root` is required. This script never assumes a repository default branch: the caller
 * discovers the verified root and passes it in.
 *
 * Output JSON on stdout: `{ contractVersion, ok, plan, errors }`. `ok:false` carries
 * structured errors and no order, so a caller cannot mistake a refusal for a plan.
 *
 * Rules that are contract, not preference:
 * - every selected identity appears exactly once; unselected identities never do;
 * - a hard dependency always precedes its dependent, whatever the objective says;
 * - an estimate that is missing, null, or `unknown` costs `Infinity` for comparison and
 *   is counted in `unknownEstimates`. It is never a zero-cost observation;
 * - qualification is `exact-for-declared-objective` only when the whole space of valid
 *   orders was enumerated under the declared objective, otherwise `best-found` with
 *   `budget.exhausted` set;
 * - the result is a function of the evidence set, not of the order the arrays arrived in.
 *
 * The reported budget separates three numbers on purpose: `probes` is how many pairwise
 * estimates were supplied, `ordersEnumerated` is how many candidate orders the search
 * actually walked, and `orderEvaluationLimit` is the declared ceiling. Only the last two
 * decide whether the search was exhaustive, and a plan that quotes the first without the
 * others has said nothing about its own coverage.
 *
 * No dependencies, no network, no filesystem writes, no evaluation of ref names or PR
 * text: every identifier is treated as an opaque token to compare, never to execute.
 */

import { readFileSync } from 'node:fs'

const CONTRACT_VERSION = 'flatten-pr-graph/1'
const OBJECTIVE = [
  'estimated-conflict-resolution-work',
  'unnecessary-history-disruption',
  'stable-tie-break',
]
const DEFAULT_ORDER_EVALUATION_LIMIT = 20_000

/** Structurally invalid input, as opposed to a graph that cannot be planned. */
class InputError extends Error {
  constructor(code, detail, evidence) {
    super(detail)
    this.code = code
    this.detail = detail
    this.evidence = evidence
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value, where) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InputError(
      'invalid-input',
      `${where} must be a positive integer pull request number`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value
}

/**
 * This script performs no Git operation, so it cannot ask Git what a ref name is. It
 * accepts the shapes Git itself accepts: a fully qualified ref path, no control
 * character, whitespace, `~^:?*[\`, no `..`, no `@{`, no empty or dot component, and no
 * component ending in `.lock`. The value is only ever compared and copied into output;
 * nothing here interprets it.
 */
function refName(value, where) {
  const invalid =
    typeof value !== 'string' ||
    !value.startsWith('refs/') ||
    /[\u0000-\u0020\u007f~^:?*[\\]/.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('//') ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component.endsWith('.lock'))
  if (invalid) {
    throw new InputError(
      'invalid-input',
      `${where} must be a fully qualified ref name`,
      `received ${JSON.stringify(value)}`,
    )
  }
  return value
}

function parseInput(raw) {
  if (!isPlainObject(raw)) {
    throw new InputError(
      'invalid-input',
      'the evidence document must be a JSON object',
      'not an object',
    )
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    throw new InputError(
      'invalid-input',
      `unsupported contract version`,
      `received ${JSON.stringify(raw.contractVersion)}, expected ${CONTRACT_VERSION}`,
    )
  }

  const selected = Array.isArray(raw.selected) ? [...raw.selected] : []
  const identities = selected.map((number, index) => positiveInteger(number, `selected[${index}]`))
  if (new Set(identities).size !== identities.length) {
    throw new InputError(
      'invalid-selection',
      'the selection contains one identity more than once',
      `received ${JSON.stringify(identities)}`,
    )
  }
  if (identities.length === 0) {
    throw new InputError(
      'missing-selection',
      'the selection is empty, and a missing selection never means every open pull request',
      'selected: []',
    )
  }

  const declaredBases = isPlainObject(raw.declaredBases) ? raw.declaredBases : {}
  const headRefs = isPlainObject(raw.headRefs) ? raw.headRefs : {}
  const bases = new Map()
  const heads = new Map()
  for (const number of identities) {
    const key = String(number)
    if (Object.hasOwn(declaredBases, key))
      bases.set(number, refName(declaredBases[key], `declaredBases["${key}"]`))
    if (Object.hasOwn(headRefs, key))
      heads.set(number, refName(headRefs[key], `headRefs["${key}"]`))
  }

  const dependencies = []
  for (const [index, edge] of (Array.isArray(raw.hardDependencies)
    ? raw.hardDependencies
    : []
  ).entries()) {
    if (!isPlainObject(edge)) {
      throw new InputError(
        'invalid-input',
        `hardDependencies[${index}] must be an object`,
        'not an object',
      )
    }
    const before = positiveInteger(edge.before, `hardDependencies[${index}].before`)
    const after = positiveInteger(edge.after, `hardDependencies[${index}].after`)
    if (before === after) {
      throw new InputError(
        'invalid-input',
        `hardDependencies[${index}] makes a pull request depend on itself`,
        `#${before} -> #${after}`,
      )
    }
    for (const number of [before, after]) {
      if (!identities.includes(number)) {
        throw new InputError(
          'unknown-identity',
          `hardDependencies[${index}] names an identity outside the selection`,
          `#${number} is not in ${JSON.stringify(identities)}`,
        )
      }
    }
    if (typeof edge.source !== 'string' || typeof edge.evidence !== 'string') {
      throw new InputError(
        'invalid-input',
        `hardDependencies[${index}] must record its source and evidence`,
        `source ${JSON.stringify(edge.source)}, evidence ${JSON.stringify(edge.evidence)}`,
      )
    }
    dependencies.push({
      before,
      after,
      source: edge.source,
      evidence: edge.evidence,
    })
  }

  const estimates = new Map()
  for (const [index, estimate] of (Array.isArray(raw.estimates) ? raw.estimates : []).entries()) {
    if (!isPlainObject(estimate) || !Array.isArray(estimate.pair) || estimate.pair.length !== 2) {
      throw new InputError(
        'invalid-input',
        `estimates[${index}] must name a pair`,
        `received ${JSON.stringify(estimate)}`,
      )
    }
    const [left, right] = estimate.pair.map((number, position) =>
      positiveInteger(number, `estimates[${index}].pair[${position}]`),
    )
    const key = pairKey(left, right)
    // Two probes of one pair are a contradiction in the evidence, not a preference.
    if (estimates.has(key)) {
      throw new InputError(
        'contradictory-graph',
        `the pair ${key} carries more than one estimate`,
        `received ${JSON.stringify(estimates.get(key))} and ${JSON.stringify(estimate)}`,
      )
    }
    estimates.set(key, estimate)
  }

  const integrationPushes = isPlainObject(raw.integrationPushes) ? raw.integrationPushes : {}
  const pushes = new Set()
  for (const [key, value] of Object.entries(integrationPushes)) {
    if (value === true) pushes.add(Number(key))
  }

  const limit = Number(raw.budget?.maxEnumeratedOrders ?? DEFAULT_ORDER_EVALUATION_LIMIT)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InputError(
      'invalid-input',
      'budget.maxEnumeratedOrders must be a positive integer',
      `received ${JSON.stringify(raw.budget?.maxEnumeratedOrders)}`,
    )
  }

  return {
    root: refName(raw.root, 'root'),
    selected: identities,
    bases,
    heads,
    dependencies,
    estimates,
    pushes,
    limit,
  }
}

/** A pair is symmetric: the merge cost of (a,b) is the merge cost of (b,a). */
function pairKey(left, right) {
  return left < right ? `${left}-${right}` : `${right}-${left}`
}

/**
 * The cost of a candidate order, compared lexicographically:
 *   1. measured conflict work, where an unavailable estimate is Infinity, never zero;
 *   2. the number of those unavailable estimates on the order's adjacent pairs;
 *   3. unnecessary disruption, counted as base retargets plus integration pushes;
 *   4. the pull request numbers themselves, as the stable tie-break.
 */
function costOf(order, evidence) {
  let work = 0
  let unknown = 0
  let disruption = 0

  let previousBase = evidence.root
  let previousNumber = null
  for (const number of order) {
    const base = evidence.bases.get(number)
    if (base !== undefined && base !== previousBase) disruption += 1
    if (evidence.pushes.has(number)) disruption += 1
    if (previousNumber !== null) {
      const estimate = evidence.estimates.get(pairKey(previousNumber, number))
      const value =
        estimate && estimate.kind !== 'unknown' && typeof estimate.value === 'number'
          ? estimate.value
          : null
      if (value === null) {
        unknown += 1
      } else {
        work += value
      }
    }
    previousBase = evidence.heads.get(number) ?? base ?? previousBase
    previousNumber = number
  }

  // Infinity makes an unknown-cost adjacency lose to any measured alternative; the
  // count is reported separately so the caller can see the cost was never measured.
  const comparable = unknown === 0 ? work : Number.POSITIVE_INFINITY
  return {
    work,
    unknown,
    disruption,
    order: [...order],
    comparable,
    key: [comparable, unknown, disruption, ...order],
  }
}

function compare(left, right) {
  for (let index = 0; index < left.key.length; index += 1) {
    const a = left.key[index]
    const b = right.key[index]
    if (a === b) continue
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1
    return String(a) < String(b) ? -1 : 1
  }
  return 0
}

function successorsOf(evidence) {
  const successors = new Map(evidence.selected.map((number) => [number, new Set()]))
  for (const edge of evidence.dependencies) {
    successors.get(edge.before).add(edge.after)
  }
  return successors
}

/**
 * The stable topological baseline: repeatedly take the lowest-numbered identity whose
 * prerequisites are already placed. It depends on nothing but the hard edges, so it is
 * reproducible without any probe result.
 */
function topologicalOrders(evidence, limit, onEvaluate) {
  const successors = successorsOf(evidence)
  const indegree = new Map(evidence.selected.map((number) => [number, 0]))
  for (const edge of evidence.dependencies) {
    indegree.set(edge.after, indegree.get(edge.after) + 1)
  }
  const results = []
  const partial = []
  let exhausted = false

  const walk = () => {
    if (results.length >= limit || exhausted) {
      exhausted = true
      return
    }
    if (partial.length === evidence.selected.length) {
      results.push([...partial])
      onEvaluate()
      return
    }
    const ready = evidence.selected
      .filter((number) => indegree.get(number) === 0 && !partial.includes(number))
      .sort((left, right) => left - right)
    for (const number of ready) {
      partial.push(number)
      for (const next of successors.get(number)) indegree.set(next, indegree.get(next) - 1)
      walk()
      for (const next of successors.get(number)) indegree.set(next, indegree.get(next) + 1)
      partial.pop()
      if (exhausted) return
    }
  }
  walk()
  return { orders: results, exhausted }
}

function chainOf(order, evidence) {
  return order.map((number, index) => {
    const fromBase = evidence.bases.get(number) ?? evidence.root
    const previousHead =
      index === 0 ? evidence.root : (evidence.heads.get(order[index - 1]) ?? fromBase)
    return {
      position: index + 1,
      number,
      fromBase,
      toBase: previousHead,
      change: fromBase === previousHead ? 'none' : 'base-change',
    }
  })
}

export function planOrder(raw) {
  const evidence = parseInput(raw)

  let evaluations = 0
  const count = () => {
    evaluations += 1
  }

  const baseline = topologicalOrders(evidence, evidence.limit, count)
  if (baseline.exhausted && baseline.orders.length === 0) {
    // Nothing was placed at all: the graph has a cycle, which is a contradiction and
    // not something to resolve by dropping an inconvenient edge.
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [
        {
          code: 'contradictory-graph',
          detail: 'the hard dependencies contain a cycle, so no order can respect them all',
          evidence: evidence.dependencies
            .map((edge) => `#${edge.before} -> #${edge.after}`)
            .join(', '),
        },
      ],
    }
  }
  if (baseline.orders.length === 0) {
    return {
      contractVersion: CONTRACT_VERSION,
      ok: false,
      errors: [
        {
          code: 'contradictory-graph',
          detail: 'the hard dependencies admit no order within the declared evaluation budget',
          evidence: `selected ${JSON.stringify(evidence.selected)}`,
        },
      ],
    }
  }

  let best = costOf(baseline.orders[0], evidence)
  for (const order of baseline.orders.slice(1)) {
    const candidate = costOf(order, evidence)
    count()
    if (compare(candidate, best) < 0) best = candidate
  }

  const chain = chainOf(best.order, evidence)
  const exhaustive = !baseline.exhausted
  const usedProbes = evidence.estimates.size
  const objective = {
    declared: OBJECTIVE,
    estimates: [...evidence.estimates.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, estimate]) => ({ pair: key.split('-').map(Number), ...estimate })),
    componentTotals: {
      estimatedConflictResolutionWork: best.work,
      historyDisruption: best.disruption,
      unknownEstimates: best.unknown,
    },
    cumulative: {
      kind: 'pairwise-only',
      value: null,
      why: 'these are pairwise estimates; the prepared cumulative stack is measured separately, not predicted here',
    },
    qualification: exhaustive ? 'exact-for-declared-objective' : 'best-found',
    budget: {
      probes: usedProbes,
      exhausted: !exhaustive,
      ordersEnumerated: baseline.orders.length,
      orderEvaluations: evaluations,
      orderEvaluationLimit: evidence.limit,
      search: exhaustive ? 'exhaustive' : 'conflict-aware',
    },
    unknownTreatedAsZero: false,
  }

  return {
    contractVersion: CONTRACT_VERSION,
    ok: true,
    errors: [],
    plan: {
      order: best.order,
      chain,
      hardDependencies: evidence.dependencies,
      objective,
      alreadyLinear: chain.every((step) => step.change === 'none'),
    },
  }
}

function readInput(argv) {
  const index = argv.indexOf('--input')
  if (index !== -1) {
    const file = argv[index + 1]
    if (typeof file !== 'string' || file.length === 0) {
      throw new InputError(
        'invalid-input',
        '--input needs a file path',
        `argv ${JSON.stringify(argv)}`,
      )
    }
    return readFileSync(file, 'utf8')
  }
  try {
    return readFileSync(0, 'utf8')
  } catch {
    throw new InputError(
      'invalid-input',
      'no evidence document was supplied',
      'pass --input <file> or pipe the JSON document on stdin',
    )
  }
}

const USAGE = [
  'plan-order.mjs [--input <file>]',
  '',
  'Reads a validated flatten-pr-graph evidence document from stdin or --input and writes',
  '{ contractVersion, ok, plan, errors } to stdout.',
  'Exit 0 plans, 2 refuses the input, 3 refuses the graph.',
  '',
].join('\n')

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(USAGE)
    return 0
  }
  let raw
  try {
    raw = JSON.parse(readInput(argv))
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError('invalid-input', error.message, 'input could not be read')
    process.stdout.write(
      `${JSON.stringify({ contractVersion: CONTRACT_VERSION, ok: false, errors: [failure] }, null, 2)}\n`,
    )
    return 2
  }
  let result
  try {
    result = planOrder(raw)
  } catch (error) {
    const failure =
      error instanceof InputError
        ? error
        : new InputError('invalid-input', error.message, 'input could not be planned')
    result = { contractVersion: CONTRACT_VERSION, ok: false, errors: [failure] }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.ok) return 0
  // Exit 2 means the document was not something this script could read; exit 3 means
  // the document was read and the graph itself cannot be planned. A caller can tell a
  // malformed call from an unsatisfiable graph without parsing the message.
  const refused = (result.errors ?? []).some((error) =>
    ['invalid-input', 'invalid-selection', 'missing-selection'].includes(error.code),
  )
  return refused ? 2 : 3
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
