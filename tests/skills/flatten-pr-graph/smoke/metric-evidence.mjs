#!/usr/bin/env node
/**
 * Produces the metric and performance evidence the ordering method claims, from real Git.
 *
 * Two claims need evidence rather than assertion:
 *
 *  1. The pairwise objective is not a prediction of cumulative work. This builds a real
 *     repository where the pairwise-cheapest order is *not* the cumulatively cheapest,
 *     measures both, and prints the divergence. The helper already refuses to state a
 *     cumulative total; this shows why that refusal is correct rather than cautious.
 *
 *  2. The search is bounded and its cost is known. This times discovery, probing, and
 *     planning for growing selections and records how many orders were enumerated against
 *     the declared budget, including the point where the budget binds and the claim drops
 *     to `best-found`.
 *
 * Usage: node tests/skills/flatten-pr-graph/smoke/metric-evidence.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../../..')
const SKILL_SCRIPTS = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph/scripts')
const CONTRACT = 'flatten-pr-graph/1'

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.email=probe@example.com', '-c', 'user.name=Probe', ...args],
    { cwd, encoding: 'utf8' },
  ).trim()
}

function helper(script, input) {
  const started = Date.now()
  const stdout = execFileSync('node', [join(SKILL_SCRIPTS, script)], {
    input: JSON.stringify({ contractVersion: CONTRACT, ...input }),
    encoding: 'utf8',
    cwd: REPOSITORY_ROOT,
  })
  return { result: JSON.parse(stdout.trim()), durationMs: Date.now() - started }
}

/** A repository with `branches` commits, one per selected pull request, all off `main`. */
function seedIndependent(root, branches) {
  git(root, 'init', '--quiet', '--initial-branch', 'main', '.')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/main.ts'), 'export const main = true\n')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'seed')
  const heads = []
  for (let index = 0; index < branches; index += 1) {
    const name = `feat-${index}`
    git(root, 'checkout', '--quiet', '-b', name, 'main')
    writeFileSync(
      join(root, `src/feature-${index}.ts`),
      `export const feature${index} = ${index}\n`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', `feature ${index}`)
    git(root, 'checkout', '--quiet', 'main')
    heads.push({ number: 100 + index, headRef: `refs/heads/${name}`, baseRef: 'refs/heads/main' })
  }
  return heads
}

/**
 * The limitation case, built so the pairwise sums and the real cumulative work disagree.
 *
 * `touches-one` edits file A, `touches-both` edits A and B, and `touches-two` edits B.
 * Pairwise, `touches-one` and `touches-two` are free of each other, so an order that
 * separates the two heavy edits looks cheap. Integrated cumulatively, whichever of the two
 * heavy branches goes second meets *both* earlier edits and pays twice. The point is not
 * that one order wins; it is that no pairwise number predicts the real integration cost,
 * which is why the plan refuses to state a cumulative total.
 */
function seedLimitationCase(root) {
  git(root, 'init', '--quiet', '--initial-branch', 'main', '.')
  writeFileSync(join(root, 'a.txt'), 'a base\n')
  writeFileSync(join(root, 'b.txt'), 'b base\n')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'seed')
  const edits = [
    { name: 'touches-one', content: { 'a.txt': 'a edited\n' } },
    { name: 'touches-both', content: { 'a.txt': 'a edited again\n', 'b.txt': 'b edited\n' } },
    { name: 'touches-two', content: { 'b.txt': 'b edited again\n' } },
  ]
  return edits.map((edit, index) => {
    git(root, 'checkout', '--quiet', '-b', edit.name, 'main')
    for (const [path, content] of Object.entries(edit.content))
      writeFileSync(join(root, path), content)
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', edit.name)
    git(root, 'checkout', '--quiet', 'main')
    return { number: 200 + index, headRef: `refs/heads/${edit.name}`, baseRef: 'refs/heads/main' }
  })
}

/** Counts real conflict hunks for one cumulative integration, then restores the branch. */
function cumulativeCost(root, order) {
  git(root, 'checkout', '--quiet', '--detach', 'main')
  let hunks = 0
  const merged = []
  for (const entry of order) {
    const branch = entry.headRef.replace('refs/heads/', '')
    try {
      execFileSync(
        'git',
        ['-c', 'user.email=p@e.com', '-c', 'user.name=P', 'merge', '--quiet', '--no-edit', branch],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      )
      merged.push({ branch, hunks: 0 })
    } catch {
      const report = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: root,
        encoding: 'utf8',
      })
      const paths = report.trim().split('\n').filter(Boolean)
      hunks += paths.length
      merged.push({ branch, hunks: paths.length, unresolved: paths })
      // Resolve the way a human resolver would - take the incoming side - so the stack can
      // continue and the next merge is measured against a real prepared state rather than
      // a reset repository.
      for (const path of paths) {
        execFileSync('git', ['checkout', '--theirs', '--', path], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        })
      }
      execFileSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
      execFileSync(
        'git',
        ['-c', 'user.email=p@e.com', '-c', 'user.name=P', 'commit', '--quiet', '--no-edit'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        },
      )
    }
  }
  git(root, 'checkout', '--quiet', 'main')
  return { totalHunks: hunks, merges: merged }
}

function permutations(items) {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  )
}

function limitationEvidence() {
  const root = mkdtempSync(join(tmpdir(), 'flatten-metric-limitation-'))
  try {
    const selected = seedLimitationCase(root)
    const pairs = []
    for (let index = 0; index < selected.length; index += 1) {
      for (let other = index + 1; other < selected.length; other += 1) {
        pairs.push({
          before: selected[index].number,
          after: selected[other].number,
          beforeRef: selected[index].headRef,
          afterRef: selected[other].headRef,
        })
      }
    }
    const { result, durationMs } = helper('measure-conflict.mjs', { repository: root, pairs })
    const cost = new Map(
      result.estimates.map((estimate) => [estimate.pair.join('-'), estimate.value]),
    )
    const rows = permutations(selected).map((order) => {
      let pairwise = 0
      for (let index = 1; index < order.length; index += 1) {
        const key = [order[index - 1].number, order[index].number].sort((a, b) => a - b).join('-')
        pairwise += cost.get(key) ?? 0
      }
      return {
        order: order.map((entry) => entry.number),
        pairwiseTotal: pairwise,
        ...cumulativeCost(root, order),
      }
    })
    const chosen = helper('plan-order.mjs', {
      root: 'refs/heads/main',
      repository: root,
      selected: selected.map((entry) => entry.number),
      declaredBases: Object.fromEntries(
        selected.map((entry) => [String(entry.number), entry.baseRef]),
      ),
      headRefs: Object.fromEntries(selected.map((entry) => [String(entry.number), entry.headRef])),
      hardDependencies: [],
      estimates: result.estimates.map((estimate) => ({
        pair: estimate.pair,
        kind: estimate.kind,
        value: estimate.value,
        confidence: estimate.confidence,
      })),
      budget: { maxEnumeratedOrders: 1000 },
    }).result.plan
    const chosenOrder = chosen.order
    const chosenRow = rows.find((row) => row.order.join() === chosenOrder.join())
    return {
      durationMs,
      chosenOrder,
      chosenObjectiveTotal: chosen.objective.componentTotals.estimatedConflictResolutionWork,
      chosenPairwiseTotal: chosenRow?.pairwiseTotal ?? null,
      chosenCumulativeHunks: chosenRow?.totalHunks ?? null,
      declaredCumulativeTotal: chosen.objective.cumulative,
      rows,
      cheapestPairwise: Math.min(...rows.map((row) => row.pairwiseTotal)),
      cheapestCumulative: Math.min(...rows.map((row) => row.totalHunks)),
      // The declared objective's number is not a prediction of the work the run performs:
      // the same order that scores lowest on the objective pays more when it is integrated.
      objectiveUnderstatesRealWork: (chosenRow?.pairwiseTotal ?? 0) < (chosenRow?.totalHunks ?? 0),
      objectiveIsNotABound: rows.some((row) => row.pairwiseTotal < row.totalHunks),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function timingEvidence() {
  const rows = []
  for (const size of [4, 6, 8]) {
    // One disposable repository per size: a fresh history keeps each measurement free of
    // the previous size's objects, so the timings describe the work done, not the cache.
    const root = mkdtempSync(join(tmpdir(), `flatten-metric-timing-${size}-`))
    try {
      const selected = seedIndependent(root, size)
      const discovered = helper('discover-dependencies.mjs', {
        repository: root,
        root: 'refs/heads/main',
        selected,
        declaredPrerequisites: [],
        verifiedPrerequisites: [],
        unselectedDependents: [],
      })
      const pairs = []
      for (let index = 0; index < selected.length; index += 1) {
        for (let other = index + 1; other < selected.length; other += 1) {
          pairs.push({
            before: selected[index].number,
            after: selected[other].number,
            beforeRef: selected[index].headRef,
            afterRef: selected[other].headRef,
          })
        }
      }
      const measured = helper('measure-conflict.mjs', { repository: root, pairs })
      // Two budgets: one the search cannot exceed, and one small enough to bind.
      const generous = helper('plan-order.mjs', {
        root: 'refs/heads/main',
        repository: root,
        selected: selected.map((entry) => entry.number),
        declaredBases: Object.fromEntries(
          selected.map((entry) => [String(entry.number), entry.baseRef]),
        ),
        headRefs: Object.fromEntries(
          selected.map((entry) => [String(entry.number), entry.headRef]),
        ),
        hardDependencies: discovered.result.graph.edges,
        estimates: measured.result.estimates.map((estimate) => ({
          pair: estimate.pair,
          kind: estimate.kind,
          value: estimate.value,
          confidence: estimate.confidence,
        })),
        budget: { maxEnumeratedOrders: 100000 },
      })
      const bounded = helper('plan-order.mjs', {
        root: 'refs/heads/main',
        repository: root,
        selected: selected.map((entry) => entry.number),
        declaredBases: Object.fromEntries(
          selected.map((entry) => [String(entry.number), entry.baseRef]),
        ),
        headRefs: Object.fromEntries(
          selected.map((entry) => [String(entry.number), entry.headRef]),
        ),
        hardDependencies: discovered.result.graph.edges,
        estimates: measured.result.estimates.map((estimate) => ({
          pair: estimate.pair,
          kind: estimate.kind,
          value: estimate.value,
          confidence: estimate.confidence,
        })),
        budget: { maxEnumeratedOrders: 3 },
      })
      rows.push({
        selected: size,
        pairsProbed: pairs.length,
        discoveryMs: discovered.durationMs,
        probingMs: measured.durationMs,
        planningMs: generous.durationMs,
        ordersEnumerated: generous.result.plan.objective.budget.ordersEnumerated,
        qualification: generous.result.plan.objective.qualification,
        boundedBudgetOrders: bounded.result.plan.objective.budget.ordersEnumerated,
        boundedBudgetQualification: bounded.result.plan.objective.qualification,
        boundedBudgetExhausted: bounded.result.plan.objective.budget.exhausted,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  return rows
}

function main() {
  const limitation = limitationEvidence()
  const timings = timingEvidence()
  const failures = []
  if (!limitation.objectiveUnderstatesRealWork) {
    failures.push(
      'the seeded case did not show the declared objective understating the work a real integration performs',
    )
  }
  if (!limitation.objectiveIsNotABound) {
    failures.push(
      'the pairwise total was never below the real cumulative work, so it is not a bound',
    )
  }
  if (limitation.declaredCumulativeTotal?.value !== null) {
    failures.push('the plan stated a cumulative total it cannot measure')
  }
  for (const row of timings) {
    if (row.qualification !== 'exact-for-declared-objective') {
      failures.push(
        `a fully enumerated search did not claim exactness at ${row.selected} selections`,
      )
    }
    if (
      row.boundedBudgetExhausted &&
      row.boundedBudgetQualification === 'exact-for-declared-objective'
    ) {
      failures.push(`an exhausted budget still claimed exactness at ${row.selected} selections`)
    }
  }
  process.stdout.write(`${JSON.stringify({ limitation, timings, failures }, null, 2)}\n`)
  return failures.length === 0 ? 0 : 1
}

process.exit(main())
