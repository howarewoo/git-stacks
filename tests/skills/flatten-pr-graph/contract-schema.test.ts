import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { validateAgainstPointer, formatErrors } from './support/json-schema'
import {
  FIXTURE_DIRECTORY,
  REFERENCES,
  REJECTED_EXAMPLES_DIRECTORY,
  listRejectedExamples,
  loadContractSchema,
  loadFixtureSchema,
  readExample,
} from './support/harness'
import { discoverFixtureModules } from './support/fixture'
import { readFile } from 'node:fs/promises'

/**
 * The contract's machine-readable half: the schemas, the worked examples, and the
 * structural rejection of incomplete success claims.
 */

test('both contract schemas use only keywords the authoring validator implements', async () => {
  for (const schema of [await loadContractSchema(), await loadFixtureSchema()]) {
    assert.deepEqual(schema.shapeErrors, [], formatErrors(schema.shapeErrors))
  }
})

test('every stage document example satisfies its schema', async () => {
  const schema = await loadContractSchema()
  const cases: Array<[string, string]> = [
    ['snapshot.json', '#/$defs/snapshot'],
    ['plan.json', '#/$defs/plan'],
    ['preparation.json', '#/$defs/preparation'],
    ['publication.json', '#/$defs/publication'],
  ]
  for (const [file, pointer] of cases) {
    const errors = validateAgainstPointer(schema, pointer, await readExample(file))
    assert.deepEqual(errors, [], `${file} against ${pointer}:\n${formatErrors(errors)}`)
  }
})

test('each legal result status has a worked example that validates', async () => {
  const schema = await loadContractSchema()
  for (const file of [
    'result-published.json',
    'result-no-op.json',
    'result-blocked.json',
    'result-partial.json',
  ]) {
    const errors = validateAgainstPointer(schema, '#', await readExample(file))
    assert.deepEqual(errors, [], `${file}:\n${formatErrors(errors)}`)
  }
})

test('malformed and incomplete success claims are rejected structurally', async () => {
  const schema = await loadContractSchema()
  const rejected = await listRejectedExamples()
  assert.ok(rejected.length >= 3, 'the rejected examples directory must exist and be populated')
  for (const file of rejected) {
    const document = await readFile(join(REJECTED_EXAMPLES_DIRECTORY, file), 'utf8')
    const parsed = JSON.parse(document) as unknown
    const pointer = file.startsWith('fixture-') ? undefined : '#'
    const errors =
      pointer === undefined
        ? validateAgainstPointer(await loadFixtureSchema(), '#', parsed)
        : validateAgainstPointer(schema, '#', parsed)
    assert.ok(errors.length > 0, `${file} must be rejected, but it validated`)
  }
})

test('an objective that scores unknown estimates as zero is rejected', async () => {
  const schema = await loadContractSchema()
  const document = (await readExample('result-published.json')) as Record<string, unknown>
  const plan = document.plan as Record<string, unknown>
  const objective = plan.objective as Record<string, unknown>
  objective.estimates = [{ pair: [12, 13], kind: 'unknown', value: 0, confidence: 'unknown' }]
  objective.unknownTreatedAsZero = true
  const errors = validateAgainstPointer(schema, '#', document)
  assert.ok(
    errors.some((error) => error.message.includes('false')),
    `an unknown treated as zero must fail: ${formatErrors(errors)}`,
  )
})

test('the fixture example validates against the fixture schema', async () => {
  const errors = validateAgainstPointer(
    await loadFixtureSchema(),
    '#',
    await readExample('fixture-matrix.json'),
  )
  assert.deepEqual(errors, [], formatErrors(errors))
})

test('every discovered fixture declaration validates against the fixture schema', async () => {
  const schema = await loadFixtureSchema()
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  assert.ok(fixtures.length > 0)
  for (const fixture of fixtures) {
    const errors = validateAgainstPointer(schema, '#', fixture.spec)
    assert.deepEqual(errors, [], `${fixture.spec.id}:\n${formatErrors(errors)}`)
  }
})

test('the reference contract names every invariant the fixtures can detect', async () => {
  const { fixtures } = await discoverFixtureModules(FIXTURE_DIRECTORY)
  const contract = await readFile(join(REFERENCES, 'contract.md'), 'utf8')
  for (const fixture of fixtures) {
    assert.ok(
      contract.includes(fixture.spec.expect.mustDetectInvariant),
      `contract.md does not document ${fixture.spec.expect.mustDetectInvariant}`,
    )
  }
})
