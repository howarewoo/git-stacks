import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePlan } from './select-checks.mjs'

export function assertSelection(result, json) {
  if (result !== 'success') throw new Error(`Selection job did not succeed: ${result}`)
  return validatePlan(JSON.parse(json))
}

export function assertDiscovery(report, files) {
  const found = new Set()
  const visit = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.expectedStatus !== 'skipped') found.add(basename(spec.file))
        }
      }
      visit(suite.suites)
    }
  }
  if (report.errors?.length) throw new Error('Playwright discovery reported errors')
  visit(report.suites)
  if (!found.size) throw new Error('Selected zero Playwright tests')
  for (const file of files) {
    if (!found.has(basename(file))) throw new Error(`Selected file discovered no tests: ${file}`)
  }
}

export function fileExpression(file) {
  return `${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
}

function run(args, { capture = false } = {}) {
  const result = spawnSync('pnpm', args, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`pnpm ${args.join(' ')} failed (${result.status ?? result.signal})`)
  return result.stdout
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = assertSelection(process.env.SELECTION_RESULT, process.env.CHECK_PLAN)
  const task = process.argv[2]
  console.log(JSON.stringify({ task, plan }, null, 2))
  if (task === 'gate') {
    // Always executed before optional setup, including on selector failure/cancel.
    const enabled = {
      automated: plan.desktop !== 'skip' || plan.unit || plan.typecheck.length > 0,
      design: plan.catalog,
      budgets: plan.performance,
    }[process.argv[3]]
    if (enabled === undefined || process.env.CHECK_ENABLED !== String(enabled))
      throw new Error('Missing/inconsistent worker selection output')
  } else if (task === 'typecheck') {
    if (plan.typecheck.includes('all')) run(['run', 'typecheck'])
    else if (plan.typecheck.length)
      run([
        'exec',
        'turbo',
        'run',
        'typecheck',
        ...plan.typecheck.map((name) => `--filter=${name}`),
      ])
  } else if (task === 'unit') {
    if (plan.unit)
      run([
        '--filter',
        'git-stacks',
        'exec',
        'tsx',
        '--test',
        'tests/tree-navigation.test.ts',
        'tests/components.test.ts',
      ])
  } else if (task === 'desktop') {
    if (plan.desktop !== 'skip') {
      for (const file of plan.files)
        if (!existsSync(file)) throw new Error(`Selected spec does not exist: ${file}`)
      // Playwright's native file arguments are regular expressions, not shell
      // words. Escape metacharacters and anchor them to prevent over-selection.
      const args = plan.files.map(fileExpression)
      const report = JSON.parse(
        run(
          [
            '--filter',
            'git-stacks',
            'exec',
            'playwright',
            'test',
            '--grep-invert',
            '@visual',
            '--list',
            '--reporter=json',
            ...args,
          ],
          { capture: true },
        ),
      )
      assertDiscovery(report, plan.files)
      run([
        'run',
        'test:ui',
        '--reporter=line,html,../../scripts/ci/nonempty-reporter.mjs',
        ...args,
      ])
    }
  } else if (task === 'catalog') {
    if (plan.catalog) {
      run(['--filter', 'design', 'check:manifest'])
      run(['--filter', '@git-stacks/ui', 'tokens:check'])
      run(['exec', 'turbo', 'run', 'build', '--filter=design'])
      const report = JSON.parse(
        run(['--filter', 'design', 'exec', 'playwright', 'test', '--list', '--reporter=json'], {
          capture: true,
        }),
      )
      assertDiscovery(report, [])
      run([
        '--filter',
        'design',
        'test:catalog',
        '--reporter=line,html,../../scripts/ci/nonempty-reporter.mjs',
      ])
    }
  } else throw new Error(`Unknown check task: ${task}`)
}
