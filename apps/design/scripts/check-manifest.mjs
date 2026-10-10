import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { COMPONENT_MANIFEST, MANIFEST_DATE, UPSTREAM_RECONCILIATION } from '../src/manifest.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const expected =
  'button button-group toggle toggle-group kbd breadcrumb sidebar navigation-menu menubar dropdown-menu context-menu command tabs pagination field label input input-group textarea checkbox radio-group switch select native-select combobox slider calendar date-picker input-otp card badge avatar table data-table item accordion collapsible chart aspect-ratio carousel resizable scroll-area separator direction alert empty progress spinner skeleton toast dialog alert-dialog sheet drawer popover hover-card tooltip attachment bubble message message-scroller marker questionnaire typography'.split(
    ' ',
  )
const ids = COMPONENT_MANIFEST.map((entry) => entry.id)
assert.equal(ids.length, 64, '63 components plus Typography required')
assert.equal(new Set(ids).size, ids.length, 'Duplicate component anchors')
assert.deepEqual([...ids].sort(), [...expected].sort(), 'Missing or unexpected catalog entry')
assert.equal(MANIFEST_DATE, '2026-10-10')
assert.equal(UPSTREAM_RECONCILIATION.date, MANIFEST_DATE)
const tokens = JSON.parse(
  readFileSync(resolve(root, '../../packages/ui/src/tokens/tokens.json'), 'utf8'),
)
for (const entry of COMPONENT_MANIFEST) {
  for (const field of [
    'summary',
    'usage',
    'anatomy',
    'keyboard',
    'importExample',
    'upstreamDoc',
    'reconciledWith',
  ])
    assert.ok(entry[field]?.trim(), `${entry.id}: missing ${field}`)
  assert.equal(new URL(entry.upstreamDoc).hostname, 'ui.shadcn.com')
  for (const path of entry.tokens)
    assert.notEqual(
      path.split('.').reduce((value, key) => value?.[key], tokens),
      undefined,
      `${entry.id}: unknown token ${path}`,
    )
}

// Typecheck displayed imports with the installed native TypeScript CLI.
// Temporary source stays inside this workspace for package resolution and is always removed.
const examples = COMPONENT_MANIFEST.map((entry, index) =>
  entry.importExample.replace(
    /\{([^}]+)\}/,
    (_, names) =>
      `{${names
        .split(',')
        .map((name) => `${name.trim()} as Import${index}_${name.trim()}`)
        .join(',')}}`,
  ),
).join('\n')
const temporary = mkdtempSync(resolve(root, '.catalog-imports-'))
try {
  const source = resolve(temporary, 'imports.ts')
  writeFileSync(source, examples)
  const compiler = resolve(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin/tsc',
  )
  execFileSync(
    process.execPath,
    [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--jsx',
      'react-jsx',
      '--module',
      'esnext',
      '--moduleResolution',
      'bundler',
      '--target',
      'es2022',
      '--esModuleInterop',
      source,
    ],
    { stdio: 'inherit' },
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
console.log(
  'Catalog manifest: 64 unique entries, valid canonical tokens and public import examples. Browser tests prove live specimens and state transitions.',
)
