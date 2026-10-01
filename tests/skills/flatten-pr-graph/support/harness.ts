/**
 * The authoring-time fixture harness.
 *
 * One fixture run is: build a disposable world, install the provider script, let the
 * fixture seed what the run finds, capture the baseline the oracle needs, run the
 * claim, and judge. The harness records nothing from the claim and passes the claim to
 * the oracle as untrusted input.
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSelection } from './documents'
import { FakeGitHub, type ProviderState } from './fake-github'
import type { FixtureContext, FixtureModule, ObservedBaseline } from './fixture'
import { loadSchema, type LoadedSchema } from './json-schema'
import { judge, type OracleVerdict } from './oracle'
import { createWorld, type ScratchWorkspace, type World } from './real-git'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(HERE, '../../../..')
export const REFERENCES = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph/references')
export const FIXTURE_DIRECTORY = resolve(HERE, '../fixtures')

export const CONTRACT_SCHEMA_PATH = join(REFERENCES, 'schemas/contract.schema.json')
export const FIXTURE_SCHEMA_PATH = join(REFERENCES, 'schemas/fixture.schema.json')
export const EXAMPLES_DIRECTORY = join(REFERENCES, 'examples')
export const REJECTED_EXAMPLES_DIRECTORY = join(EXAMPLES_DIRECTORY, 'rejected')

export async function loadContractSchema(): Promise<LoadedSchema> {
  return loadSchema(JSON.parse(await readFile(CONTRACT_SCHEMA_PATH, 'utf8')))
}

export async function loadFixtureSchema(): Promise<LoadedSchema> {
  return loadSchema(JSON.parse(await readFile(FIXTURE_SCHEMA_PATH, 'utf8')))
}

export async function readExample(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(join(EXAMPLES_DIRECTORY, relativePath), 'utf8'))
}

export async function listRejectedExamples(): Promise<string[]> {
  const entries = await readdir(REJECTED_EXAMPLES_DIRECTORY)
  return entries.filter((name) => name.endsWith('.json')).sort()
}

export interface FixtureExecution {
  verdict: OracleVerdict
  claim: unknown
  context: FixtureContext
  provider: FakeGitHub
  world: World
  baseline: ObservedBaseline
}

const EMPTY_PROVIDER_STATE: ProviderState = {
  owner: 'acme',
  name: 'widgets',
  defaultBranch: 'main',
  perPage: 2,
  pullRequests: [],
  deniedWrites: [],
  autoMergeEnabledOn: [],
  queueBoundBases: [],
  unreadableProtectionBases: [],
}

/**
 * Runs one fixture against a fresh disposable world. The caller owns that world and
 * must call `execution.world.cleanup()`; the verdict is already computed from live
 * state, so cleanup afterwards changes nothing that was judged.
 */
export async function executeFixture(module: FixtureModule): Promise<FixtureExecution> {
  const world = await createWorld(module.spec.id)
  const provider = new FakeGitHub({ ...EMPTY_PROVIDER_STATE })
  const claimedCommands: string[] = []
  const scratches: ScratchWorkspace[] = []
  const context: FixtureContext = {
    world,
    provider,
    claimedCommands,
    recordCommand(command: string) {
      claimedCommands.push(command)
    },
    async scratch(name: string) {
      const created = await world.createScratch(name)
      scratches.push(created)
      return created
    },
  }
  await module.setup(context)
  const baseline: ObservedBaseline = {
    refsBefore: world.remoteRefs(),
    userBefore: world.userFingerprint(),
  }
  const claim = await module.run(context)
  const { numbers } = resolveSelection(module.spec.selection)
  const verdict = judge({
    context,
    baseline,
    claim,
    expected: module.spec.expect,
    selected: numbers,
    intent: module.spec.expect.intent ?? 'execute',
    scratches,
    schema: await loadContractSchema(),
  })
  return { verdict, claim, context, provider, world, baseline }
}
