#!/usr/bin/env node
/**
 * The explicit authoring-time runner for the flatten-pr-graph fixtures.
 *
 * `npm test` runs `tests/*.test.ts`, which never reaches this nested directory, so the
 * nested evaluations need their own discovery step. This runner reads the directory,
 * hands the discovered files to Node's test runner, records the environment it ran in,
 * and writes a report naming every file it discovered — so a run that discovered
 * nothing is visibly different from a run that executed everything.
 *
 * It uses disposable local resources only: temporary Git repositories, a temporary
 * bare remote, and a fake provider double. It contacts no host and holds no token.
 *
 * Usage: node tests/skills/flatten-pr-graph/run-authoring-checks.mjs [--report <file>]
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../..')

async function discover(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

function commandText(command, args) {
  const run = spawnSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
  return run.status === 0 ? run.stdout.trim() : `unavailable (${command} exited ${run.status})`
}

function reportArgument() {
  const index = process.argv.indexOf('--report')
  return index === -1 ? null : process.argv[index + 1]
}

async function main() {
  const testFiles = await discover(HERE, '.test.ts')
  const fixtureModules = await discover(HERE, '.fixture.ts')
  const environment = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    npm: commandText('npm', ['--version']),
    git: commandText('git', ['--version']),
    repositoryHead: commandText('git', ['rev-parse', 'HEAD']),
    workingDirectory: REPOSITORY_ROOT,
    resources: 'disposable local repositories under os.tmpdir(); fake GitHub provider double',
    network: 'none; no host, account, or token is used',
  }

  if (testFiles.length === 0) {
    console.error(
      'flatten-pr-graph: no nested test files were discovered; refusing to report a pass.',
    )
    process.exit(1)
  }

  console.log(`flatten-pr-graph: running ${testFiles.length} discovered authoring test files`)
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit',
  })

  const report = {
    contract: 'flatten-pr-graph/1',
    discoveredTestFiles: testFiles.map((file) => relative(REPOSITORY_ROOT, file)),
    discoveredFixtureModules: fixtureModules.map((file) => relative(REPOSITORY_ROOT, file)),
    environment,
    exitCode: run.status,
  }
  const requested = reportArgument()
  const target = requested
    ? resolve(REPOSITORY_ROOT, requested)
    : join(await mkdtemp(join(tmpdir(), 'flatten-pr-graph-report-')), 'authoring-report.json')
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`flatten-pr-graph: report written to ${target}`)
  process.exit(run.status ?? 1)
}

await main()
