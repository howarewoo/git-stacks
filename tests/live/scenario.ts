import type { GitHubTransport } from '../../src/main/github-transport'
import type { GitHubHostContext } from '../../src/main/github-host'
import type { ReviewFile, ReviewFileSet } from '../../src/shared/review'
import type { ReviewDraft } from '../../src/shared/review-threads'
import type { FaultInjectingHandle } from './contract'
import type {
  LiveAdmin,
  LiveCapabilities,
  LiveCapability,
  LiveTarget,
  LiveWorkspace,
} from './contract'

/** Everything a scenario is given. Nothing here is constructed by the scenario itself. */
export interface LiveScenarioContext {
  readonly runId: string
  /**
   * The ownership marker every recorded resource has to carry.
   *
   * A scenario that could name its own marker could record a resource the ledger could
   * not later prove this run created, which is the one thing the ledger exists to refuse.
   * Reading it from the target keeps a scenario from inventing ownership.
   */
  readonly marker: string
  readonly target: LiveTarget
  /** The host the disposable repository is served by. */
  readonly host: GitHubHostContext
  /** `owner/name` of the disposable repository this run owns. */
  readonly repository: string
  /** The production transport, wrapped so faults can be injected at the boundary. */
  readonly transport: GitHubTransport
  readonly faults: FaultInjectingHandle
  readonly workspace: LiveWorkspace
  readonly admin: LiveAdmin
  readonly capabilities: LiveCapabilities
  log(message: string): void
}

export interface LiveScenario {
  readonly id: string
  readonly title: string
  /**
   * Capabilities this scenario cannot be honest about without. A missing one is
   * a failure with the reason attached, never a skip: a suite that quietly stops
   * covering a merge queue is worse than one that reports it cannot.
   */
  readonly requires: readonly LiveCapability[]
  run(ctx: LiveScenarioContext): Promise<void>
}

/** One layer of a stack: a branch, a commit, a push, and a pull request. */
export interface Layer {
  readonly branch: string
  readonly number: number
  readonly headSha: string
}

/**
 * Scenario assertions carry their own message, because a suite this size reports
 * failures to people who did not write the scenario and will not have it open.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Why a scenario could not run, when the target told us. */
export function missingCapability(
  capabilities: LiveCapabilities,
  required: readonly LiveCapability[],
): string | null {
  const absent = required.filter((capability) => !capabilities[capability])
  if (absent.length === 0) return null
  return `${absent.join(', ')} unavailable on this target. Observed: ${capabilities.notes.join('; ')}`
}

/**
 * The changed lines a review can be anchored to, read from GitHub rather than
 * invented. A scenario that hand-wrote a line number would be testing its own
 * arithmetic; these come from the same file read the reviewer sees.
 */
export function anchorsFrom(files: ReviewFileSet, path: string): ReviewDraft[] {
  const file: ReviewFile | undefined = files.files.find((entry) => entry.path === path)
  assert(file, `the diff has no entry for ${path}`)
  assert(file.diff.kind === 'text', `the diff for ${path} is ${file.diff.kind}, not text`)
  const drafts: ReviewDraft[] = []
  for (const hunk of file.diff.hunks) {
    const added = hunk.lines.filter(
      (line) => line.side === 'head' && line.newLine !== null && !line.whitespaceOnly,
    )
    for (const [index, line] of added.entries()) {
      drafts.push({
        id: `${hunk.id}:${index}`,
        ref: {
          path: file.path,
          side: 'head',
          line: line.newLine as number,
          hunkId: hunk.id,
          anchor: line.anchor,
          context: line.context,
        },
        startRef: null,
        body: `live e2e comment on ${file.path}:${line.newLine}`,
        createdAt: new Date(0).toISOString(),
      })
    }
  }
  assert(drafts.length > 0, `the diff for ${path} has no added line to comment on`)
  return drafts
}

/** The first two added lines of one hunk, for the multi-line range scenario. */
export function rangeAnchorFrom(
  files: ReviewFileSet,
  path: string,
  hunkIndex = 0,
): { start: ReviewDraft; end: ReviewDraft } {
  const drafts = anchorsFrom(files, path)
  const file = files.files.find((entry) => entry.path === path)
  assert(file && file.diff.kind === 'text', `the diff for ${path} is not text`)
  const hunk = file.diff.hunks[hunkIndex]
  assert(hunk, `${path} has no hunk at index ${hunkIndex}`)
  const inHunk = drafts.filter((draft) => draft.ref.hunkId === hunk.id)
  assert(inHunk.length >= 2, `${path} hunk ${hunk.id} has fewer than two added lines`)
  return { start: inHunk[0], end: inHunk[1] }
}
