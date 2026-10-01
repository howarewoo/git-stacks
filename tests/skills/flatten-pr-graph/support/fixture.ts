/**
 * The authoring fixture contract for `flatten-pr-graph/1`.
 *
 * A fixture is a declaration (`spec`), a `setup` that manufactures the state the run
 * finds, and a `run` that produces the result document under test. The fixture never
 * decides whether that document is honest: the oracle reads the repository, the fake
 * provider, and the recorded actions for itself.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureExpectation, ResultDocument } from './contract-types'
import type { ScratchWorkspace, UserFingerprint, World } from './real-git'
import type { FakeGitHub } from './fake-github'

export const RUBRIC_PATH =
  'references/contract.md#102-semantic-intent-rubric-human-review-not-automatable'

export interface FixtureSpec {
  contractVersion: string
  id: string
  title: string
  matrixEntry: string
  kind: 'matrix' | 'mutation'
  selection: string[]
  expect: FixtureExpectation
  humanReview?: { required: boolean; rubric: string }
}

export interface FixtureContext {
  world: World
  provider: FakeGitHub
  /**
   * Commands the run claims to have executed, recorded by the fixture. Real Git and
   * provider activity are recorded by those components themselves; this list holds
   * everything else the run claims to have done, so a forbidden check run cannot hide
   * by being invisible to the harness.
   */
  readonly claimedCommands: string[]
  recordCommand(command: string): void
  scratch(name: string): Promise<ScratchWorkspace>
}

// The module list is genuinely runtime-selected: discovery has to prove that the
// files on disk are the files that execute, so a static import list would defeat it.

export interface FixtureModule {
  spec: FixtureSpec
  setup(context: FixtureContext): Promise<void>
  run(context: FixtureContext): Promise<ResultDocument>
}

export interface DiscoveredFixtures {
  files: string[]
  fixtures: FixtureModule[]
}

/** What the harness observed before the run started; never taken from the claim. */
export interface ObservedBaseline {
  refsBefore: Record<string, string>
  userBefore: UserFingerprint
}

export interface FixtureRun {
  context: FixtureContext
  baseline: ObservedBaseline
  claim: ResultDocument
  scratches: ScratchWorkspace[]
}

export async function discoverFixtureModules(directory: string): Promise<DiscoveredFixtures> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.fixture.ts'))
    .map((entry) => join(directory, entry.name))
    .sort()
  const fixtures: FixtureModule[] = []
  for (const file of files) {
    // Runtime-selected on purpose: discovery has to prove that the files on disk are
    // the files that execute, which a static import list could not establish.
    const loaded = (await import(pathToFileURL(file).href)) as { fixtures?: FixtureModule[] }
    if (!Array.isArray(loaded.fixtures)) {
      throw new Error(`${file} does not export a fixtures array`)
    }
    fixtures.push(...loaded.fixtures)
  }
  return { files, fixtures }
}
