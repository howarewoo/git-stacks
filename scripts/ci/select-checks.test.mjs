import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import NonemptyReporter from './nonempty-reporter.mjs'
import { assertDiscovery, assertSelection, fileExpression } from './run-checks.mjs'
import {
  full,
  gitSelection,
  parseNameStatus,
  selectChecks,
  validatePlan,
} from './select-checks.mjs'

const renderer = 'apps/desktop/src/renderer/src/'
const spec = (name) => `apps/desktop/tests/renderer/${name}.spec.ts`
const pick = (...paths) => validatePlan(selectChecks(paths))

function fixtureEnv(source = process.env) {
  const env = { ...source }
  for (const key of [
    'GITHUB_EVENT_PATH',
    'GITHUB_EVENT_NAME',
    'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY',
    'CI_BASE_SHA',
    'CI_HEAD_SHA',
  ])
    delete env[key]
  return env
}

test('documentation and standalone skills omit expensive consumers', () => {
  const plan = pick('README.md', 'DESIGN.md', '.agents/skills/flatten-pr-graph/SKILL.md')
  assert.deepEqual(
    { ...plan, reasons: [] },
    {
      desktop: 'skip',
      files: [],
      catalog: false,
      performance: false,
      typecheck: [],
      unit: false,
      reasons: [],
    },
  )
})

test('catalog-only changes select catalog and its independent typecheck', () => {
  const plan = pick('apps/design/src/App.tsx', 'apps/design/playwright.config.ts')
  assert.equal(plan.catalog, true)
  assert.equal(plan.desktop, 'skip')
  assert.equal(plan.performance, false)
  assert.equal(plan.unit, false)
  assert.deepEqual(plan.typecheck, ['design'])
})

test('audited notification feature includes settings, CLI, forms and crosscuts', () => {
  const plan = pick(`${renderer}components/notification-center-view.tsx`)
  assert.equal(plan.desktop, 'files')
  assert.deepEqual(
    plan.files,
    [
      'accessibility',
      'github-cli',
      'keyboard',
      'motion-and-zoom',
      'notifications',
      'safety',
      'settings-parity',
      'tanstack-forms',
    ]
      .map(spec)
      .sort(),
  )
  assert.equal(plan.catalog, false)
  assert.equal(plan.performance, true)
  assert.equal(plan.unit, true)
  assert.deepEqual(plan.typecheck, ['git-stacks'])
})

test('review feature traces sibling workspace/navigation/snapshots consumers', () => {
  const plan = pick(`${renderer}components/review-conversation.tsx`)
  for (const name of [
    'review-conversation',
    'github-cli',
    'review-diff',
    'review-navigation',
    'review-snapshots',
    'review-workspace',
    'tanstack-forms',
    'safety',
  ])
    assert.ok(plan.files.includes(spec(name)))
})

test('inventory hook selects its real consumer and crosscuts', () => {
  const plan = pick(`${renderer}lib/worktree-inventory.ts`)
  assert.ok(plan.files.includes(spec('worktree-inventory')))
  assert.equal(plan.desktop, 'files')
})

test('mixed changes union files and catalog; shell overrides narrow selections', () => {
  const narrow = pick(
    `${renderer}components/notification-center-view.tsx`,
    spec('onboarding'),
    'apps/design/src/App.tsx',
  )
  assert.equal(narrow.catalog, true)
  assert.ok(narrow.files.includes(spec('notifications')))
  assert.ok(narrow.files.includes(spec('onboarding')))
  assert.deepEqual(narrow.typecheck, ['design', 'git-stacks'])
  for (const path of [
    `${renderer}App.tsx`,
    `${renderer}styles.css`,
    `${renderer}components/ui/button.tsx`,
    `${renderer}lib/query-client.ts`,
    'apps/desktop/tests/renderer/helpers/gallery.ts',
    'apps/desktop/tests/renderer/fixtures/control.ts',
  ]) {
    for (const paths of [
      [spec('onboarding'), path],
      [path, spec('onboarding')],
    ]) {
      const plan = pick(...paths)
      assert.equal(plan.desktop, 'full')
      assert.deepEqual(plan.files, [])
    }
  }
})

test('shared UI, contracts, budgets and unknown/tooling paths expand conservatively', () => {
  for (const path of [
    'packages/ui/src/tokens/tokens.json',
    'packages/shared/src/types.ts',
    'packages/shared/src/review.ts',
    'packages/shared/src/performance.ts',
    'pnpm-lock.yaml',
    'turbo.json',
    'scripts/ci/select-checks.mjs',
    '.github/workflows/accessibility.yml',
    'future/unknown.ts',
  ]) {
    const plan = pick(path)
    assert.equal(plan.desktop, 'full', path)
    assert.equal(plan.catalog, true, path)
    assert.equal(plan.performance, true, path)
    assert.equal(plan.unit, true, path)
    assert.deepEqual(plan.typecheck, ['all'], path)
  }
})

test('runtime/build/perf changes retain desktop production coverage', () => {
  for (const path of [
    'apps/desktop/src/main/index.ts',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/native/promote-repository.c',
    'apps/desktop/scripts/perf/run-benchmarks.ts',
    'apps/desktop/electron.vite.config.ts',
    `${renderer}lib/list-window.ts`,
  ]) {
    const plan = pick(path)
    assert.equal(plan.performance, true, path)
    assert.deepEqual(plan.typecheck, ['git-stacks'])
  }
})

test('component policy/action/composition and tree-navigation preserve units', () => {
  for (const path of [
    'components/workflow-action.ts',
    'components/workflow-policy.ts',
    'components/workflow-composition.tsx',
    'lib/tree-navigation.ts',
  ])
    assert.equal(pick(`${renderer}${path}`).unit, true)
  for (const path of [
    'apps/desktop/tests/components.test.ts',
    'apps/desktop/tests/tree-navigation.test.ts',
  ]) {
    assert.equal(pick(path).unit, true)
    assert.deepEqual(pick(path).typecheck, ['git-stacks'])
  }
})

test('changed/new spec selects itself without performance or catalog', () => {
  const plan = pick(spec('new [feature] with spaces'))
  assert.equal(plan.desktop, 'files')
  assert.deepEqual(plan.files, [spec('new [feature] with spaces')])
  assert.equal(plan.performance, false)
  assert.equal(plan.catalog, false)
  assert.deepEqual(plan.typecheck, ['git-stacks'])
})

test('main push/manual and unknown events are full regardless of diff', () => {
  for (const event of ['push', 'workflow_dispatch', 'unknown'])
    assert.deepEqual(selectChecks(['README.md'], event), full(`Full event: ${event}`))
})

test('NUL parser retains spaces/newlines/unicode and both rename/copy sides and deletions', () => {
  assert.deepEqual(
    parseNameStatus(
      Buffer.from(
        'M\0a space\n雪.ts\0R100\0old.ts\0new.ts\0D\0deleted.ts\0C75\0source.ts\0copy.ts\0',
      ),
    ),
    ['a space\n雪.ts', 'old.ts', 'new.ts', 'deleted.ts', 'source.ts', 'copy.ts'],
  )
  for (const text of ['M\0unterminated', 'R100\0one\0', 'X\0foo\0', 'M\0../escape\0'])
    assert.throws(() => parseNameStatus(Buffer.from(text)))
})

test('malformed or missing output and selector failures never pass the gate', () => {
  for (const result of ['failure', 'cancelled', 'skipped', undefined])
    assert.throws(() => assertSelection(result, JSON.stringify(full('test'))))
  for (const json of ['', '{}', 'null', '{']) assert.throws(() => assertSelection('success', json))
  for (const patch of [
    { desktop: 'files' },
    { files: ['../../evil.spec.ts'] },
    { performance: 'false' },
    { typecheck: ['all', 'design'] },
    { reasons: [] },
  ])
    assert.throws(() => validatePlan({ ...full('test'), ...patch }))
  assert.equal(assertSelection('success', JSON.stringify(pick('README.md'))).desktop, 'skip')
})

const report = (file, status = 'passed') => ({
  suites: [
    { suites: [{ specs: [{ file, title: 'real test', tests: [{ expectedStatus: status }] }] }] },
  ],
})
test('zero, missing, skipped and error discovery fail; nested runnable tests pass', () => {
  assert.throws(() => assertDiscovery({ suites: [] }, []))
  assert.throws(() => assertDiscovery(report('onboarding.spec.ts', 'skipped'), []))
  assert.throws(() => assertDiscovery(report('onboarding.spec.ts'), [spec('notifications')]))
  assert.throws(() =>
    assertDiscovery({ ...report('onboarding.spec.ts'), errors: [{ message: 'bad import' }] }, []),
  )
  assertDiscovery(report('onboarding.spec.ts'), [spec('onboarding')])
})

test('execution reporter rejects an unexpectedly all-skipped file and preserves failures', () => {
  const reporter = new NonemptyReporter()
  const make = (file, status) => ({
    expectedStatus: 'passed',
    location: { file },
    results: [{ status }],
  })
  reporter.onBegin({}, { allTests: () => [make('one', 'passed'), make('two', 'skipped')] })
  assert.equal(reporter.onEnd({ status: 'passed' }).status, 'failed')
  const runtimeSkipped = make('two', 'skipped')
  reporter.onBegin({}, { allTests: () => [make('one', 'passed'), runtimeSkipped] })
  runtimeSkipped.expectedStatus = 'skipped'
  assert.equal(reporter.onEnd({ status: 'passed' }).status, 'failed')
  const staticSkipped = { ...make('two', 'skipped'), expectedStatus: 'skipped' }
  reporter.onBegin({}, { allTests: () => [make('one', 'passed'), staticSkipped] })
  assert.equal(reporter.onEnd({ status: 'passed' }).status, 'passed')
  reporter.onBegin({}, { allTests: () => [staticSkipped] })
  assert.equal(reporter.onEnd({ status: 'passed' }).status, 'failed')
  reporter.onBegin({}, { allTests: () => [make('one', 'passed')] })
  assert.equal(reporter.onEnd({ status: 'failed' }).status, 'failed')
  assert.equal(reporter.onEnd({ status: 'passed' }).status, 'passed')
})

test('executable gates reject missing/inconsistent flags and allow explicit skips', () => {
  for (const surface of ['automated', 'design', 'budgets']) {
    const invoke = (enabled, plan = pick('README.md')) =>
      spawnSync(process.execPath, ['scripts/ci/run-checks.mjs', 'gate', surface], {
        env: {
          ...process.env,
          SELECTION_RESULT: 'success',
          CHECK_PLAN: JSON.stringify(plan),
          CHECK_ENABLED: enabled,
        },
        encoding: 'utf8',
      })
    assert.equal(invoke('false').status, 0)
    assert.notEqual(invoke('true').status, 0)
    assert.notEqual(invoke('').status, 0)
    assert.notEqual(invoke('false', full('test')).status, 0)
    assert.equal(invoke('true', full('test')).status, 0)
  }
})

test('native file expressions match literal names without selecting neighboring specs', () => {
  const file = spec('space [brackets] 雪')
  const expression = new RegExp(fileExpression(file))
  assert.ok(expression.test(`/checkout/${file}`))
  for (const other of [
    spec('space brackets 雪'),
    spec('space [brackets] 雪x'),
    `${file}.backup`,
    file.replace('.spec.ts', 'XspecYts'),
  ])
    assert.equal(expression.test(`/checkout/${other}`), false, other)
})

test('executable runner propagates worker and discovery failures', {
  // Direct exec of an extensionless shebang fixture is POSIX-only; Windows
  // retains the pure checks, executable gates and disposable Git CLI coverage.
  skip: process.platform === 'win32' ? 'Requires POSIX shebang executable lookup' : false,
}, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'git-stacks-ci-runner-'))
  const file = spec('space [brackets] 雪')
  mkdirSync(dirname(join(cwd, file)), { recursive: true })
  writeFileSync(join(cwd, file), 'test fixture')
  const bin = join(cwd, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'pnpm'),
    `#!${process.execPath}\nif(process.argv.includes('--list')) console.log(process.env.REPORT); else process.exit(Number(process.env.WORKER_EXIT));\n`,
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  const env = {
    ...fixtureEnv(),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    REPORT: JSON.stringify(report('space [brackets] 雪.spec.ts')),
    SELECTION_RESULT: 'success',
    CHECK_PLAN: JSON.stringify(pick(file)),
    WORKER_EXIT: '0',
  }
  const invoke = () =>
    spawnSync(process.execPath, [resolve('scripts/ci/run-checks.mjs'), 'desktop'], {
      cwd,
      env,
      encoding: 'utf8',
    })
  try {
    const success = invoke()
    assert.equal(success.status, 0, success.stderr)
    env.WORKER_EXIT = '7'
    assert.notEqual(invoke().status, 0)
    env.WORKER_EXIT = '0'
    env.REPORT = JSON.stringify({ suites: [] })
    assert.notEqual(invoke().status, 0)
    rmSync(join(cwd, file))
    assert.notEqual(invoke().status, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('disposable Git history proves merge-base, rename/delete, fallback and executable output', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'git-stacks-select-ci-'))
  const env = {
    ...fixtureEnv(),
    GIT_AUTHOR_NAME: 'CI test',
    GIT_AUTHOR_EMAIL: 'ci@example.invalid',
    GIT_COMMITTER_NAME: 'CI test',
    GIT_COMMITTER_EMAIL: 'ci@example.invalid',
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = (message) => {
    git('add', '-A')
    git('commit', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '--initial-branch=main')
    put('README.md', 'base docs\n')
    put(spec('onboarding'), 'initial spec\n')
    const ancestor = commit('base')
    git('checkout', '-b', 'feature')
    put('README.md', 'changed docs\n')
    const head = commit('docs')
    git('checkout', 'main')
    put('pnpm-lock.yaml', 'base advanced; must not pollute PR diff\n')
    const base = commit('advance base')
    git('checkout', 'feature')
    assert.equal(gitSelection({ event: 'pull_request', base, head, cwd }).desktop, 'skip')
    const output = join(cwd, 'outputs')
    const cli = spawnSync(process.execPath, [resolve('scripts/ci/select-checks.mjs')], {
      cwd,
      env: {
        ...env,
        GITHUB_EVENT_NAME: 'pull_request',
        CI_BASE_SHA: base,
        CI_HEAD_SHA: head,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    })
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(JSON.parse(cli.stdout).desktop, 'skip')
    assert.match(readFileSync(output, 'utf8'), /automated=false\ncatalog=false\nperformance=false/)
    rmSync(output)
    const eventPath = join(cwd, 'event.json')
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: 'synchronize',
        number: 123,
        pull_request: { base: { sha: ancestor }, head: { sha: base } },
      }),
    )
    const eventCli = spawnSync(process.execPath, [resolve('scripts/ci/select-checks.mjs')], {
      cwd,
      env: {
        ...env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        CI_BASE_SHA: base,
        CI_HEAD_SHA: head,
      },
      encoding: 'utf8',
    })
    assert.equal(eventCli.status, 0, eventCli.stderr)
    assert.equal(JSON.parse(eventCli.stdout).desktop, 'full')
    assert.equal(JSON.parse(eventCli.stdout).performance, true)
    const isolatedCli = spawnSync(process.execPath, [resolve('scripts/ci/select-checks.mjs')], {
      cwd,
      env: {
        ...fixtureEnv({
          ...env,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
        }),
        GITHUB_EVENT_NAME: 'pull_request',
        CI_BASE_SHA: base,
        CI_HEAD_SHA: head,
      },
      encoding: 'utf8',
    })
    assert.equal(isolatedCli.status, 0, isolatedCli.stderr)
    assert.equal(JSON.parse(isolatedCli.stdout).desktop, 'skip')
    rmSync(eventPath)
    git('mv', 'README.md', 'unknown space 雪.ts')
    const renamed = commit('rename out of docs')
    assert.equal(
      gitSelection({ event: 'pull_request', base: ancestor, head: renamed, cwd }).performance,
      true,
    )
    rmSync(join(cwd, spec('onboarding')))
    const deleted = commit('delete spec')
    assert.equal(
      gitSelection({ event: 'pull_request', base: renamed, head: deleted, cwd }).desktop,
      'full',
    )
    assert.equal(
      gitSelection({ event: 'pull_request', base: '0'.repeat(40), head: deleted, cwd }).desktop,
      'full',
    )
    assert.equal(gitSelection({ event: 'pull_request', cwd }).desktop, 'full')
    assert.equal(gitSelection({ event: 'push', cwd }).performance, true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
