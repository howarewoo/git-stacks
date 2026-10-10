import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getCommitDiff, getHistory, getSnapshot } from '../../src/main/git'
import { listStatus } from '../../src/main/git-core'
import { DiffView } from '../../src/renderer/src/components/repository-views'
import { windowSlice } from '../../src/renderer/src/lib/list-window'
import {
  COMMIT_DIFF_BUDGET_MS,
  HISTORY_BUDGET_MS,
  INTERACTION_BUDGET_MS,
  SNAPSHOT_BRANCH_BUDGET,
  SNAPSHOT_BUDGET_MS,
  STARTUP_BUDGET_MS,
  type BenchmarkMeasurement,
} from '@git-stacks/shared/performance'
import { buildAll, FIXTURE_SIZES } from './fixtures.mjs'
import { measureDesktop } from './desktop-interaction.mjs'

/**
 * Measures the launch-to-painted desktop, actual input-to-painted UI, snapshot,
 * history, diff, and supplementary server rendering on locally generated
 * fixtures. CI fails when a budget is exceeded. Nothing clones a remote or
 * reads a private repository.
 *
 * The desktop measurements require `pnpm run build` first and a display server.
 *
 *   pnpm run bench:performance [--out <dir>] [--keep]
 */
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

function elapsed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.hrtime.bigint()
  return run().then((value) => ({
    value,
    ms: Number(process.hrtime.bigint() - started) / 1_000_000,
  }))
}

async function main() {
  const outIndex = process.argv.indexOf('--out')
  const out = outIndex >= 0 ? process.argv[outIndex + 1]! : join(repoRoot, 'benchmarks')
  const keep = process.argv.includes('--keep')
  const workspace = mkdtempSync(join(tmpdir(), 'git-stacks-bench-'))
  try {
    const fixtureStarted = Date.now()
    const repos = buildAll(workspace)
    process.stdout.write(
      `fixtures built in ${((Date.now() - fixtureStarted) / 1000).toFixed(1)}s ` +
        `(${FIXTURE_SIZES.files} files, ${FIXTURE_SIZES.refs} refs, ` +
        `${FIXTURE_SIZES.commits} commits, ${FIXTURE_SIZES.pullRequestFiles}-file pull request)\n`,
    )

    const measurements: BenchmarkMeasurement[] = []
    const record = (
      name: string,
      fixture: string,
      budgetMs: number,
      ms: number,
      detail?: Record<string, number>,
    ) => {
      measurements.push({
        name,
        fixture,
        budgetMs,
        elapsedMs: Math.round(ms),
        ...(detail ? { detail } : {}),
      })
      const verdict = ms <= budgetMs ? 'ok' : 'OVER BUDGET'
      process.stdout.write(
        `  ${verdict.padEnd(10)} ${name.padEnd(16)} ${ms.toFixed(0)}ms / ${budgetMs}ms\n`,
      )
    }

    const desktop = await measureDesktop(repoRoot, repos.manyRefs)
    record('startup', 'many-refs-desktop', STARTUP_BUDGET_MS, desktop.startupMs, {
      branches: FIXTURE_SIZES.refs + 1,
      differingTips: FIXTURE_SIZES.refs,
      visibleRows: 200,
    })
    record('interaction', 'many-refs-desktop', INTERACTION_BUDGET_MS, desktop.interactionMs, {
      branches: FIXTURE_SIZES.refs + 1,
      visibleRows: 1,
    })

    const snapshot = await elapsed(() => getSnapshot(repos.manyRefs))
    record('snapshot', 'many-refs', SNAPSHOT_BUDGET_MS, snapshot.ms, {
      branches: snapshot.value.branches.length,
      differingTips: FIXTURE_SIZES.refs,
      branchesAnalyzed: snapshot.value.limits.branchesAnalyzed,
      branchesSkipped: snapshot.value.limits.branchesSkipped,
    })

    const status = await elapsed(() => listStatus(repos.workingTree))
    record('status', 'working-tree', SNAPSHOT_BUDGET_MS, status.ms, {
      filesListed: status.value.files.length,
      filesTruncated: status.value.truncated ? 1 : 0,
    })
    const workingSnapshot = await elapsed(() => getSnapshot(repos.workingTree))
    record('snapshot', 'working-tree', SNAPSHOT_BUDGET_MS, workingSnapshot.ms, {
      filesListed: workingSnapshot.value.limits.filesListed,
      filesTruncated: workingSnapshot.value.limits.filesTruncated ? 1 : 0,
    })

    const history = await elapsed(() => getHistory(repos.longHistory, 'refs/heads/main', 0))
    record('history', 'long-history', HISTORY_BUDGET_MS, history.ms, {
      commits: history.value.commits.length,
      hasMore: history.value.hasMore ? 1 : 0,
    })

    const oid = execFileSync('git', ['-C', repos.largePullRequest, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
    const diff = await elapsed(() => getCommitDiff(repos.largePullRequest, oid))
    record('commit-diff', 'large-pull-request', COMMIT_DIFF_BUDGET_MS, diff.ms, {
      bytesRetained: Buffer.byteLength(diff.value.text, 'utf8'),
      truncated: diff.value.truncated ? 1 : 0,
    })

    const listItems = Array.from({ length: 50_000 }, (_, index) => index)
    const list = await elapsed(async () => {
      for (let index = 0; index < 50; index += 1) windowSlice(listItems, 200)
      renderToStaticMarkup(
        React.createElement(DiffView, { text: diff.value.text, truncated: diff.value.truncated }),
      )
    })
    record('diff-render-ssr', 'renderer', INTERACTION_BUDGET_MS, list.ms, {
      rows: listItems.length,
    })

    mkdirSync(out, { recursive: true })
    const report = {
      version: 2 as const,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      generatedAt: new Date().toISOString(),
      measurements,
    }
    writeFileSync(join(out, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
    const trend = existsSync(join(out, 'trend.jsonl'))
      ? readFileSync(join(out, 'trend.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => {
            if (!line) return false
            try {
              return JSON.parse(line).version === report.version
            } catch {
              return false
            }
          })
      : []
    trend.push(
      JSON.stringify({
        version: report.version,
        generatedAt: report.generatedAt,
        platform: report.platform,
        measurements,
      }),
    )
    writeFileSync(join(out, 'trend.jsonl'), `${trend.slice(-200).join('\n')}\n`)
    process.stdout.write(`trend data written to ${join(out, 'trend.jsonl')}\n`)

    const over = measurements.filter((entry) => entry.elapsedMs > entry.budgetMs)
    if (over.length > 0) {
      process.stderr.write(
        `budgets exceeded: ${over.map((entry) => `${entry.name} ${entry.elapsedMs}ms > ${entry.budgetMs}ms`).join(', ')}\n`,
      )
      process.exitCode = 1
    }
    process.stdout.write(`branch analysis budget: ${SNAPSHOT_BRANCH_BUDGET} per snapshot\n`)
  } finally {
    if (!keep) rmSync(workspace, { recursive: true, force: true })
  }
}

await main()
