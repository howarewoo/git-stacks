import type {
  ConflictChoice,
  ConflictKind,
  ConflictLabels,
  ConflictOperation,
  ConflictRegion,
  GitOperation,
} from './types'

/**
 * The conflict-marker grammar Git writes into a conflicted worktree file. The
 * resolver parses exactly this, so a region in the UI is the same region Git
 * asked the person to decide.
 */
const START = /^<{7}(?: .*)?$/u
const BASE = /^\|{7}(?: .*)?$/u
const MIDDLE = /^={7}$/u
const END = /^>{7}(?: .*)?$/u

export interface ConflictTextSegment {
  kind: 'text'
  text: string
}

export interface ConflictRegionSegment {
  kind: 'conflict'
  current: string
  incoming: string
  startLine: number
}

export type ConflictSegment = ConflictTextSegment | ConflictRegionSegment

/**
 * Split conflicted text into clean text and the conflict regions in it. Line
 * terminators are preserved so untouched text is reproduced byte for byte.
 * Diff3-style `|||||||` base sections are dropped: the base is read from index
 * stage 1, and a resolution keeps one side or both.
 */
export function parseConflictSegments(text: string): ConflictSegment[] {
  const lines = text.match(/[^\n]*\n|[^\n]+/gu) ?? []
  const segments: ConflictSegment[] = []
  const plain: string[] = []
  const current: string[] = []
  const incoming: string[] = []
  // The lines of the block currently open, kept verbatim so a block Git never
  // closed can be handed back untouched instead of losing its markers.
  const block: string[] = []
  let open = false
  let section: 'current' | 'incoming' | null = 'current'
  let startLine = 0
  for (const [index, line] of lines.entries()) {
    const body = line.replace(/\r?\n$/u, '')
    if (!open) {
      if (START.test(body)) {
        if (plain.length) segments.push({ kind: 'text', text: plain.join('') })
        plain.length = 0
        open = true
        section = 'current'
        startLine = index + 1
        block.push(line)
      } else {
        plain.push(line)
      }
      continue
    }
    block.push(line)
    if (BASE.test(body)) {
      section = null
    } else if (MIDDLE.test(body)) {
      section = 'incoming'
    } else if (END.test(body)) {
      segments.push({
        kind: 'conflict',
        current: current.join(''),
        incoming: incoming.join(''),
        startLine,
      })
      current.length = 0
      incoming.length = 0
      open = false
      section = 'current'
    } else if (section === 'current') {
      current.push(line)
    } else if (section === 'incoming') {
      incoming.push(line)
    }
  }
  if (open) {
    // An unterminated marker run is not a decision Git asked for, so the lines
    // it holds are preserved verbatim instead of being dropped as a resolution.
    plain.push(...block)
  }
  if (plain.length) segments.push({ kind: 'text', text: plain.join('') })
  return segments
}

/** The decision regions of a conflicted file, in the order Git wrote them. */
export function conflictRegions(segments: ConflictSegment[]): ConflictRegion[] {
  const regions: ConflictRegion[] = []
  for (const segment of segments) {
    if (segment.kind !== 'conflict') continue
    regions.push({
      index: regions.length,
      startLine: segment.startLine,
      current: segment.current,
      incoming: segment.incoming,
    })
  }
  return regions
}

/**
 * Build the resolved file from the parsed regions and the resolution chosen for
 * each region. A string choice is the person's own edit of that region;
 * `delete` drops the region without deleting the file.
 */
export function composeConflict(
  segments: ConflictSegment[],
  choices: Record<number, ConflictChoice | string>,
): string {
  let region = -1
  let result = ''
  for (const segment of segments) {
    if (segment.kind === 'text') {
      result += segment.text
      continue
    }
    region += 1
    const choice = choices[region] ?? 'current'
    if (choice === 'incoming') result += segment.incoming
    else if (choice === 'both') result += segment.current + segment.incoming
    else if (choice === 'delete') continue
    else if (choice === 'current') result += segment.current
    // Any other string is the person's own text for that region, so it is
    // written through instead of being read as a choice name.
    else result += choice
  }
  return result
}

/**
 * True while any conflict marker line remains, including a run Git never closed.
 * Staging such text would commit the markers themselves, so both the resolver
 * and the main process refuse it.
 */
export function hasConflictMarkers(text: string): boolean {
  return (text.match(/[^\n]*\n|[^\n]+/gu) ?? []).some((line) => {
    const body = line.replace(/\r?\n$/u, '')
    return START.test(body) || BASE.test(body) || MIDDLE.test(body) || END.test(body)
  })
}

/**
 * The structural kind, read from the index stages Git recorded: 1/2/3 is a
 * content conflict, 2/3 means no common ancestor version exists, and one
 * surviving stage means the other side deleted the path. A recorded move of the
 * path wins, because a rename has to be decided rather than text-edited.
 */
export function conflictKind(stages: number[], moved: boolean): ConflictKind {
  if (moved) return 'rename'
  if (stages.includes(1) && stages.includes(2) && stages.includes(3)) return 'content'
  if (stages.includes(1) && stages.includes(2)) return 'modifyDelete'
  if (stages.includes(1) && stages.includes(3)) return 'deleteModify'
  return 'addAdd'
}

export interface ConflictLabelInput {
  operation: GitOperation | null
  currentBranch: string | null
  /** The commit the operation is applying, when Git recorded one. */
  incomingSubject: string | null
  incomingRef: string | null
  /** Set only when the incoming side was proved to be a stash entry. */
  stash: { ref: string; message: string } | null
  stashAvailable: boolean
}

/**
 * Name both sides the way the active Git operation means them, and say why. A
 * rebase swaps the usual meaning of "ours" and "theirs", so the resolver never
 * shows those words without the explanation beside them.
 */
export function conflictLabels(input: ConflictLabelInput): ConflictLabels {
  const operation: ConflictOperation = !input.operation
    ? input.stash
      ? 'stashApply'
      : 'unknown'
    : input.operation === 'other'
      ? 'unknown'
      : input.operation
  const currentBranch = input.currentBranch ? ` (${input.currentBranch})` : ''
  const incomingCommit = input.incomingSubject ?? input.incomingRef
  const sides =
    'Index stage 2 — the side Git also calls “ours” — is the version already in your ' +
    'checkout, and stage 3 — “theirs” — is the version being applied.'
  if (operation === 'rebase') {
    return {
      operation,
      title: 'Rebase conflict',
      base: 'Common ancestor',
      current: 'Current rebased base',
      incoming: incomingCommit
        ? `Commit being applied — ${incomingCommit}`
        : 'Commit being applied',
      explanation:
        'Git is replaying your commits on top of the new base, so “ours” and “theirs” mean the ' +
        `reverse of a merge: stage 2 (“ours”) is the new base you are rebasing onto, and stage 3 ` +
        `(“theirs”) is the commit being replayed${incomingCommit ? ` (${incomingCommit})` : ''}. ${sides}`,
    }
  }
  if (operation === 'merge') {
    return {
      operation,
      title: 'Merge conflict',
      base: 'Common ancestor',
      current: `Current branch${currentBranch}`,
      incoming: incomingCommit ? `Incoming commit — ${incomingCommit}` : 'Incoming branch',
      explanation: `Git is merging another commit into the branch you have checked out. ${sides}`,
    }
  }
  if (operation === 'cherryPick') {
    return {
      operation,
      title: 'Cherry-pick conflict',
      base: 'Common ancestor',
      current: `Current branch${currentBranch}`,
      incoming: incomingCommit
        ? `Commit being applied — ${incomingCommit}`
        : 'Commit being applied',
      explanation: `Git applied a picked commit on top of the branch you have checked out. ${sides}`,
    }
  }
  if (operation === 'revert') {
    return {
      operation,
      title: 'Revert conflict',
      base: 'Common ancestor',
      current: `Current branch${currentBranch}`,
      incoming: incomingCommit ? `Reverted commit — ${incomingCommit}` : 'Reverted commit',
      explanation:
        'A revert applies the reverse of the reverted commit, so stage 3 (“theirs”) is the ' +
        'content that results from undoing that commit, not the content that commit originally ' +
        `had. ${sides}`,
    }
  }
  if (operation === 'stashApply' && input.stash) {
    return {
      operation,
      title: 'Stash apply conflict',
      base: 'Common ancestor',
      current: `Current checkout${currentBranch}`,
      incoming: input.stash.message
        ? `Stashed changes — ${input.stash.ref} (${input.stash.message})`
        : `Stashed changes — ${input.stash.ref}`,
      explanation:
        'A stash apply or pop leaves no merge state in Git, so this side was proved by matching ' +
        'index stage 3 against the stash entry. Stage 2 is the checked-out content and stage 3 is ' +
        'the stashed content being applied.',
    }
  }
  return {
    operation: 'unknown',
    title: 'Conflict with no recorded operation',
    base: 'Common ancestor',
    current: `Stage 2 — checked-out content${currentBranch}`,
    incoming: 'Stage 3 — content being applied',
    explanation:
      'Git recorded no rebase, merge, cherry-pick, revert, or sequencer state for this conflict' +
      (input.stashAvailable ? ', and no stash entry matches it either' : '') +
      ', so the sides are named by their index stages instead of branch names: stage 2 is the ' +
      'content in your checkout and stage 3 is the content being applied.',
  }
}
