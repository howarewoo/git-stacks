/**
 * The fake GitHub boundary for the flatten-pr-graph authoring fixtures.
 *
 * It is a data double, not a client: it holds pull-request metadata, serves
 * paginated listings, applies head/base changes, refuses writes the fixture denied,
 * and records every action it was asked to perform. The oracle reads that record and
 * the real bare repository behind it; nothing here reports success on its own.
 *
 * There is no account, token, host, or network in this file.
 */

import type { PrActionKind } from './actions'

const WRITE_KINDS = new Set<PrActionKind>(['update-pr-base', 'push-selected-head'])

export interface FakePullRequest {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  base: string
  head: string
  headRepository: string
  author: string
}

export interface ProviderState {
  owner: string
  name: string
  defaultBranch: string
  /** Listing page size, so pagination is a controllable property of a fixture. */
  perPage: number
  pullRequests: FakePullRequest[]
  /** `<kind>:<target>` entries the provider refuses, e.g. `update-pr-base:14`. */
  deniedWrites: string[]
  /** Pull requests carrying an enabled auto-merge arrangement. */
  autoMergeEnabledOn: number[]
}

export type ProviderOutcome = 'observed' | 'acknowledged' | 'denied'

export interface ProviderAction {
  sequence: number
  kind: PrActionKind
  target: string
  outcome: ProviderOutcome
  at: string
}

/** A fixed clock keeps recorded evidence byte-identical between runs. */
const EPOCH_MS = Date.UTC(2026, 9, 1, 9, 0, 0, 0)

export class FakeGitHub {
  readonly actions: ProviderAction[] = []
  private state: ProviderState

  constructor(state: ProviderState) {
    this.state = state
  }

  /** Installs the fixture's provider state before the run starts. */
  configure(state: ProviderState): void {
    this.state.pullRequests = state.pullRequests.map((pr) => ({ ...pr }))
    this.state.perPage = state.perPage
    this.state.deniedWrites = [...state.deniedWrites]
    this.state.autoMergeEnabledOn = [...state.autoMergeEnabledOn]
  }

  get repository(): { owner: string; name: string; defaultBranch: string } {
    return {
      owner: this.state.owner,
      name: this.state.name,
      defaultBranch: this.state.defaultBranch,
    }
  }

  private record(kind: PrActionKind, target: string, outcome: ProviderOutcome): ProviderAction {
    const action: ProviderAction = {
      sequence: this.actions.length + 1,
      kind,
      target,
      outcome,
      at: new Date(EPOCH_MS + this.actions.length * 1000).toISOString(),
    }
    this.actions.push(action)
    return action
  }

  /** Reads are recorded, because a read of a prohibited endpoint is itself a finding. */
  readPrMetadata(number: number): FakePullRequest | null {
    const found = this.state.pullRequests.find((pr) => pr.number === number) ?? null
    this.record('read-pr-metadata', String(number), found ? 'observed' : 'denied')
    return found
  }

  listPullRequests(page: number, perPage = this.state.perPage): FakePullRequest[] {
    this.record('list-pull-requests', `page=${page}`, 'observed')
    const start = (page - 1) * perPage
    return this.state.pullRequests.slice(start, start + perPage)
  }

  readLandingArrangement(): {
    autoMergeEnabledOn: number[]
  } {
    this.record('read-landing-arrangement', this.state.defaultBranch, 'observed')
    return { autoMergeEnabledOn: [...this.state.autoMergeEnabledOn] }
  }

  writeTaskOwnedScratch(label: string): void {
    this.record('write-task-owned-scratch', label, 'acknowledged')
  }

  /**
   * Applies a base change, or records the refusal. A refusal is an `acknowledged:
   * false` fact about the provider, never a silently swallowed error.
   */
  updatePullRequestBase(number: number, base: string): boolean {
    const pr = this.state.pullRequests.find((candidate) => candidate.number === number)
    if (!pr) {
      this.record('update-pr-base', String(number), 'denied')
      return false
    }
    if (this.state.deniedWrites.includes(`update-pr-base:${number}`)) {
      this.record('update-pr-base', String(number), 'denied')
      return false
    }
    pr.base = base
    this.record('update-pr-base', String(number), 'acknowledged')
    return true
  }

  /** Records a refused or attempted action the fixture wants the oracle to notice. */
  /**
   * Record one provider action. A write that does not state an outcome is an accepted
   * write, because the caller already moved the state it reports; a fixture that models a
   * refusal passes 'denied' explicitly.
   */
  recordAction(kind: PrActionKind, target: string, outcome?: ProviderOutcome): void {
    this.record(kind, target, outcome ?? (WRITE_KINDS.has(kind) ? 'acknowledged' : 'observed'))
  }

  /** The provider action kinds that change remote state. */
  get writeKinds(): ReadonlySet<PrActionKind> {
    return WRITE_KINDS
  }

  baseOf(number: number): string | null {
    return this.state.pullRequests.find((pr) => pr.number === number)?.base ?? null
  }

  headOf(number: number): string | null {
    return this.state.pullRequests.find((pr) => pr.number === number)?.head ?? null
  }

  pullRequest(number: number): FakePullRequest | null {
    return this.state.pullRequests.find((pr) => pr.number === number) ?? null
  }

  allPullRequests(): FakePullRequest[] {
    return this.state.pullRequests.map((pr) => ({ ...pr }))
  }

  hasAutoMerge(number: number): boolean {
    return this.state.autoMergeEnabledOn.includes(number)
  }
}
