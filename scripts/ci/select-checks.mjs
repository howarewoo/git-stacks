import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const renderer = 'apps/desktop/src/renderer/'
const specs = 'apps/desktop/tests/renderer/'
const crosscut = ['accessibility', 'keyboard', 'safety', 'motion-and-zoom']
// These boundaries are deliberately small. App owns integration; shared modules,
// shell changes, and anything not audited here expand to the full renderer.
const features = new Map([
  [
    `${renderer}src/components/notification-center-view.tsx`,
    ['notifications', 'settings-parity', 'github-cli', 'tanstack-forms'],
  ],
  [`${renderer}src/lib/worktree-inventory.ts`, ['worktree-inventory']],
  [
    `${renderer}src/components/review-conversation.tsx`,
    [
      'review-conversation',
      'review-workspace',
      'review-navigation',
      'review-snapshots',
      'review-diff',
      'tanstack-forms',
      'github-cli',
    ],
  ],
  [
    `${renderer}src/components/review-diff.tsx`,
    [
      'review-diff',
      'review-workspace',
      'review-conversation',
      'review-navigation',
      'review-snapshots',
    ],
  ],
  [
    `${renderer}src/components/pr-inbox-view.tsx`,
    ['pr-inbox', 'review-workspace', 'review-navigation'],
  ],
])

export function full(reason) {
  return {
    desktop: 'full',
    files: [],
    catalog: true,
    performance: true,
    typecheck: ['all'],
    unit: true,
    reasons: [reason],
  }
}

export function parseNameStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0')
  if (fields.pop() !== '') throw new Error('Unterminated Git name-status output')
  const paths = []
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]
    if (!/^(?:[AMDUT]|[RC]\d{1,3})$/.test(status)) throw new Error(`Invalid Git status: ${status}`)
    const count = /^[RC]/.test(status) ? 2 : 1
    for (let j = 0; j < count; j++) {
      const path = fields[i++]
      if (!path || path.startsWith('/') || path.split('/').includes('..'))
        throw new Error('Invalid Git path')
      paths.push(path)
    }
  }
  return paths
}

export function selectChecks(paths, event = 'pull_request') {
  if (event !== 'pull_request') return full(`Full event: ${event}`)
  const plan = {
    desktop: 'skip',
    files: [],
    catalog: false,
    performance: false,
    typecheck: [],
    unit: false,
    reasons: [],
  }
  const types = new Set()
  const files = new Set()
  const desktopFull = () => {
    plan.desktop = 'full'
    files.clear()
  }
  const addSpecs = (names) => {
    if (plan.desktop === 'full') return
    plan.desktop = 'files'
    for (const name of names) files.add(`${specs}${name}.spec.ts`)
  }
  for (const path of paths) {
    if (
      /^(?:README|AGENTS|DESIGN|PRODUCT)\.md$/.test(path) ||
      path === 'LICENSE' ||
      path.startsWith('.agents/skills/') ||
      path.startsWith('.impeccable/')
    ) {
      plan.reasons.push(`Documentation/standalone skill: ${path}`)
      continue
    }
    if (path.startsWith('apps/design/')) {
      plan.catalog = true
      types.add('design')
    } else if (path.startsWith('packages/ui/')) {
      plan.catalog = plan.performance = plan.unit = true
      types.add('all')
      desktopFull()
    } else if (path.startsWith('packages/shared/')) {
      // Contracts are consumed by main, preload, renderer and catalog. In
      // particular types.ts and performance.ts must never narrow by basename.
      plan.catalog = plan.performance = plan.unit = true
      types.add('all')
      desktopFull()
    } else if (path.startsWith('apps/desktop/')) {
      types.add('git-stacks')
      if (path.startsWith(renderer)) {
        plan.performance = plan.unit = true
        const mapped = features.get(path)
        if (mapped) addSpecs([...mapped, ...crosscut])
        else desktopFull()
      } else if (path.startsWith(specs)) {
        if (
          /^apps\/desktop\/tests\/renderer\/[^/]+\.spec\.ts$/.test(path) &&
          !path.endsWith('.visual.spec.ts')
        ) {
          addSpecs([path.slice(specs.length, -8)])
        } else desktopFull()
      } else if (path.startsWith('apps/desktop/tests/')) {
        // Unit fixture infrastructure can feed renderer scenarios as well.
        plan.unit = true
        desktopFull()
      } else {
        plan.performance = true
        desktopFull()
        plan.unit = true
      }
    } else {
      return full(`Unmapped or common tooling path: ${path}`)
    }
    plan.reasons.push(`Affected consumers: ${path}`)
  }
  plan.files = [...files].sort()
  plan.typecheck = types.has('all') ? ['all'] : [...types].sort()
  if (!paths.length) plan.reasons.push('Empty merge-base diff')
  return plan
}

export function gitSelection({ event, base, head, cwd = process.cwd() }) {
  if (event !== 'pull_request') return full(`Full event: ${event}`)
  try {
    if (!/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? ''))
      throw new Error('Missing/invalid event commits')
    const git = (args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
    const baseline = git(['merge-base', base, head]).toString().trim()
    const plan = selectChecks(
      parseNameStatus(git(['diff', '--name-status', '-z', '--find-renames', baseline, head, '--'])),
    )
    if (plan.files.some((file) => !existsSync(resolve(cwd, file)))) {
      plan.desktop = 'full'
      plan.files = []
      plan.reasons.push('Selected spec missing from tested checkout; running full renderer')
    }
    return plan
  } catch (error) {
    return full(`Baseline fallback: ${error.message}`)
  }
}

export function validatePlan(plan) {
  if (
    !plan ||
    !['skip', 'files', 'full'].includes(plan.desktop) ||
    !Array.isArray(plan.files) ||
    !Array.isArray(plan.typecheck) ||
    !Array.isArray(plan.reasons) ||
    !plan.reasons.length ||
    !plan.reasons.every((reason) => typeof reason === 'string')
  )
    throw new Error('Malformed selection')
  for (const key of ['catalog', 'performance', 'unit'])
    if (typeof plan[key] !== 'boolean') throw new Error(`Malformed ${key}`)
  if (
    !plan.typecheck.every((name) => ['all', 'git-stacks', 'design'].includes(name)) ||
    new Set(plan.typecheck).size !== plan.typecheck.length ||
    (plan.typecheck.includes('all') && plan.typecheck.length !== 1)
  )
    throw new Error('Malformed typecheck selection')
  if (plan.desktop === 'files' ? !plan.files.length : plan.files.length !== 0)
    throw new Error('Invalid desktop file selection')
  if (
    !plan.files.every(
      (path) =>
        typeof path === 'string' &&
        /^apps\/desktop\/tests\/renderer\/[^/]+\.spec\.ts$/.test(path) &&
        !path.endsWith('.visual.spec.ts'),
    ) ||
    new Set(plan.files).size !== plan.files.length
  )
    throw new Error('Invalid spec path')
  return plan
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.GITHUB_EVENT_NAME ?? process.argv[2] ?? 'pull_request'
  const payload = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : null
  const plan = validatePlan(
    gitSelection({
      event,
      base: payload?.pull_request?.base?.sha ?? process.env.CI_BASE_SHA,
      head: payload?.pull_request?.head?.sha ?? process.env.CI_HEAD_SHA,
    }),
  )
  const json = JSON.stringify(plan)
  console.log(json)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `plan=${json}\nautomated=${plan.desktop !== 'skip' || plan.unit || plan.typecheck.length > 0}\ncatalog=${plan.catalog}\nperformance=${plan.performance}\n`,
    )
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Check selection\n\nTested checkout: ${execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()}\n\nDiff head: ${payload?.pull_request?.head?.sha ?? process.env.CI_HEAD_SHA ?? 'full event'}\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
    )
}
