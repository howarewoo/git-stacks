#!/usr/bin/env node
/**
 * Runs the shipped helpers against real Git repositories and real merges, with no fake
 * provider and no fake history.
 *
 * The authoring fixtures seed disposable local repositories and a fake GitHub boundary.
 * That cannot prove the two claims only real Git settles: that the helpers read real
 * refs, real ancestry and real merge bases, and that the ordering method's cost and
 * budget claims survive contact with actual conflict work. This script does that, prints
 * every observation, and exits non-zero when an observation contradicts the claim.
 *
 * Usage: node tests/skills/flatten-pr-graph/smoke/real-git-planner.mjs
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

/** Runs a shipped helper exactly as the skill tells an agent to: structured stdin in, JSON out. */
function helper(script, input) {
  const started = Date.now()
  const stdout = execFileSync('node', [join(SKILL_SCRIPTS, script)], {
    input: JSON.stringify({ contractVersion: CONTRACT, ...input }),
    encoding: 'utf8',
    cwd: REPOSITORY_ROOT,
  })
  const parsed = JSON.parse(stdout.trim())
  return { ...parsed, durationMs: Date.now() - started }
}

/**
 * A repository whose real history contains the shapes the method must handle: a chain,
 * an independent branch, a genuine textual conflict, and a shared ancestor.
 */
function seedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'flatten-smoke-'))
  git(root, 'init', '--quiet', '--initial-branch', 'main', '.')
  const commit = (path, content, message) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', message)
  }
  commit('README.md', '# widgets\n', 'add readme')
  git(root, 'checkout', '--quiet', '-b', 'feat-filter')
  commit(
    'src/filter.ts',
    'export const filter = (xs: string[]) => xs.filter(Boolean)\n',
    'add filter',
  )
  git(root, 'checkout', '--quiet', 'main')
  git(root, 'checkout', '--quiet', '-b', 'feat-guard')
  commit('src/guard.ts', 'export const guard = () => true\n', 'add guard')
  // A dependent head: feat-guard-child contains feat-filter's commit.
  git(root, 'checkout', '--quiet', 'feat-filter')
  git(root, 'checkout', '--quiet', '-b', 'feat-guard-child')
  commit('src/guard-child.ts', 'export const guarded = true\n', 'add guard child')
  // Two branches from main that edit the same line: a real conflict, not a simulated one.
  git(root, 'checkout', '--quiet', 'main')
  git(root, 'checkout', '--quiet', '-b', 'feat-conflict')
  commit(
    'src/filter.ts',
    'export const filter = (xs: string[]) => xs.filter((x) => x !== "" && x != null)\n',
    'widen filter',
  )
  git(root, 'checkout', '--quiet', 'main')
  // A pull request whose base names a selected head: a declared-base edge.
  git(root, 'checkout', '--quiet', '-b', 'base-branch')
  return { root, refs: git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads').split('\n') }
}

function main() {
  const { root } = seedWorkspace()
  const failures = []
  const observations = []
  try {
    const selected = [
      { number: 12, headRef: 'refs/heads/feat-filter', baseRef: 'refs/heads/main' },
      { number: 13, headRef: 'refs/heads/feat-guard-child', baseRef: 'refs/heads/feat-filter' },
      { number: 14, headRef: 'refs/heads/feat-conflict', baseRef: 'refs/heads/main' },
    ]

    // 1. Discovery over real ancestry, real bases, and an unverified declared claim.
    const discovered = helper('discover-dependencies.mjs', {
      repository: root,
      root: 'refs/heads/main',
      selected,
      declaredPrerequisites: [
        { before: 12, after: 14, evidence: 'PR #14 body says "depends on #12"' },
      ],
      verifiedPrerequisites: [],
      unselectedDependents: [{ number: 20, dependsOn: 13, basis: 'declared-base' }],
    })
    observations.push({
      step: 'discover-dependencies',
      ok: discovered.ok,
      graph: discovered.graph,
      durationMs: discovered.durationMs,
    })
    if (discovered.ok !== true)
      failures.push(`discovery refused a real repository: ${JSON.stringify(discovered.errors)}`)
    const edges = discovered.graph?.edges ?? []
    const unverified = discovered.graph?.unverified ?? []
    if (!edges.some((edge) => edge.before === 12 && edge.after === 13)) {
      failures.push(`real declared-base ancestry did not yield 12 -> 13: ${JSON.stringify(edges)}`)
    }
    if (!unverified.some((entry) => entry.before === 12 && entry.after === 14)) {
      failures.push(
        `a declared-only claim was silently dropped instead of reported: ${JSON.stringify(unverified)}`,
      )
    }
    if (edges.some((edge) => edge.before === 12 && edge.after === 14)) {
      failures.push('a body mention was accepted as a dependency')
    }

    // 2. Pairwise probes over real merges: one clean, one conflicted.
    const probes = helper('measure-conflict.mjs', {
      repository: root,
      pairs: [
        {
          before: 12,
          after: 13,
          beforeRef: 'refs/heads/feat-filter',
          afterRef: 'refs/heads/feat-guard-child',
        },
        {
          before: 12,
          after: 14,
          beforeRef: 'refs/heads/feat-filter',
          afterRef: 'refs/heads/feat-conflict',
        },
        {
          before: 13,
          after: 14,
          beforeRef: 'refs/heads/feat-guard-child',
          afterRef: 'refs/heads/feat-conflict',
        },
      ],
    })
    observations.push({
      step: 'measure-conflict',
      estimates: probes.estimates,
      durationMs: probes.durationMs,
    })
    const [chain, conflicting] = probes.estimates ?? []
    if (chain?.kind === 'unknown' || chain?.value === null) {
      failures.push(`a real merge was reported as unprobeable: ${JSON.stringify(chain)}`)
    }
    if (
      conflicting?.structuralConflict !== true ||
      (conflicting.conflictingPaths ?? []).length === 0
    ) {
      failures.push(
        `a real textual conflict was not detected with its paths: ${JSON.stringify(conflicting)}`,
      )
    }
    if ((conflicting.value ?? 0) <= (chain.value ?? 0)) {
      failures.push('the conflicted pair did not cost strictly more than the clean one')
    }

    // 3. Ordering from the measured evidence, under a declared budget.
    const plan = helper('plan-order.mjs', {
      root: 'refs/heads/main',
      repository: root,
      selected: [12, 13, 14],
      declaredBases: Object.fromEntries(
        selected.map((entry) => [String(entry.number), entry.baseRef]),
      ),
      headRefs: Object.fromEntries(selected.map((entry) => [String(entry.number), entry.headRef])),
      hardDependencies: edges,
      estimates: (probes.estimates ?? []).map((estimate) => ({
        pair: estimate.pair,
        kind: estimate.kind,
        value: estimate.value,
        confidence: estimate.confidence,
      })),
      integrationPushes: { 13: true, 14: true },
      budget: { maxEnumeratedOrders: 4 },
    })
    observations.push({ step: 'plan-order', plan: plan.plan, durationMs: plan.durationMs })
    const order = plan.plan?.order ?? []
    if (order.length !== 3 || new Set(order).size !== 3) {
      failures.push(
        `the plan did not place every selected identity exactly once: ${JSON.stringify(order)}`,
      )
    }
    if (order.indexOf(12) > order.indexOf(13)) {
      failures.push(`a hard dependency was not respected: ${JSON.stringify(order)}`)
    }
    if (
      plan.plan?.qualification === 'exact-for-declared-objective' &&
      plan.plan.budget?.exhausted
    ) {
      failures.push('a budget-exhausted plan claimed exactness for its objective')
    }
    if (!plan.plan?.objective)
      failures.push('the plan names no objective, so its total cannot be checked')

    // 4. Determinism: the same evidence produces byte-identical facts regardless of input
    //    order, which is what makes a cached plan safe to reuse.
    const permuted = helper('plan-order.mjs', {
      root: 'refs/heads/main',
      repository: root,
      selected: [14, 12, 13],
      declaredBases: Object.fromEntries(
        [...selected].reverse().map((entry) => [String(entry.number), entry.baseRef]),
      ),
      headRefs: Object.fromEntries(
        [...selected].reverse().map((entry) => [String(entry.number), entry.headRef]),
      ),
      hardDependencies: [...edges].reverse(),
      estimates: [...(probes.estimates ?? [])].reverse(),
      integrationPushes: { 14: true, 13: true },
      budget: { maxEnumeratedOrders: 4 },
    })
    const samePlan =
      JSON.stringify(permuted.plan?.order) === JSON.stringify(plan.plan?.order) &&
      JSON.stringify(permuted.plan?.total ?? null) === JSON.stringify(plan.plan?.total ?? null)
    observations.push({ step: 'permutation', identical: samePlan })
    if (!samePlan) {
      failures.push(
        'a permuted input changed the plan, so a cached plan could not be reused safely',
      )
    }
  } catch (error) {
    failures.push(`the smoke run threw: ${error.stack ?? error.message}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write(`${JSON.stringify({ observations, failures }, null, 2)}\n`)
  return failures.length === 0 ? 0 : 1
}

process.exit(main())
