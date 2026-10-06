import type {
  ActionResult,
  IssueLinkPreview,
  IssueLinkRelation,
  LinkedIssue,
  PullRequest,
  PullRequestIssueLinks,
  RepositoryIssue,
  StackAction,
} from '../shared/types'
import { getConfigValue, isCancelled, parseRemote, runGit } from './git-core'
import { isRecord } from '../shared/guards'
import { getPullRequest, githubErrorMessage } from './github'
import { hostTransport, remoteHostContext, type GitHubHostContext } from './github-host'
import { patchPullRequest } from './stacks'

/**
 * Concurrency Note (Read-Compare-Write API Race):
 * The GitHub REST API (PATCH /repos/{owner}/{repo}/pulls/{number}) does not provide an ETag or
 * conditional If-Match mechanism for pull request body updates.
 * Git Stacks mitigates overwrite hazards by revalidating the canonical pull request body
 * immediately prior to dispatching the PATCH request (comparing live body with expectedBody).
 * However, an inherent time-of-check to time-of-use (TOCTOU) race window exists between the
 * revalidation read and the write call. This constraint is an unavoidable characteristic of the
 * GitHub API and is handled honestly by re-reading and verifying immediately before writing.
 */

export interface ExtractedClosingReference {
  issueNumber: number
  keyword: string
  rawMatch: string
  startIndex: number
  endIndex: number
}

/**
 * One closing clause exactly as GitHub documents it: a closing keyword, an
 * optional colon, and a single issue reference. GitHub requires the full
 * keyword syntax for every issue, so `Closes #10, #12` closes only #10.
 * See https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
 */
const CLOSING_CLAUSE_REGEX =
  /\b(clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:es|ed|e))\b:?[ \t]*(?:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+))?#(?<number>\d+)\b/giu

function closingReference(
  match: RegExpExecArray,
  originFullName?: string,
): ExtractedClosingReference | null {
  const groups = match.groups ?? {}
  const issueNumber = Number(groups.number)
  const repository = groups.owner && groups.repo ? `${groups.owner}/${groups.repo}` : null
  const normalized = originFullName?.toLowerCase()
  if (repository && normalized && repository.toLowerCase() !== normalized) {
    // A foreign repository's reference never closes an issue in this repository.
    return null
  }
  return {
    issueNumber,
    keyword: match[1],
    rawMatch: match[0],
    startIndex: match.index,
    endIndex: match.index + match[0].length,
  }
}

/**
 * Extract every GitHub-recognised closing clause from a PR body, with the exact
 * source span of each clause so removal can delete precisely what was detected.
 */
export function extractClosingReferences(
  body: string,
  originFullName?: string,
): ExtractedClosingReference[] {
  if (!body) return []
  const results: ExtractedClosingReference[] = []
  CLOSING_CLAUSE_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CLOSING_CLAUSE_REGEX.exec(body)) !== null) {
    const reference = closingReference(match, originFullName)
    if (reference) results.push(reference)
  }
  return results
}

/** Check if the PR body already contains a recognized closing reference for the specified issue. */
export function isIssueClosedInBody(
  body: string,
  issueNumber: number,
  originFullName?: string,
): boolean {
  return extractClosingReferences(body, originFullName).some(
    (ref) => ref.issueNumber === issueNumber,
  )
}

/**
 * Idempotently appends a GitHub-recognized closing keyword line to the PR body.
 * Preserves all user-authored body text intact.
 */
export function insertClosingReference(
  body: string,
  issueNumber: number,
  originFullName?: string,
): string {
  if (isIssueClosedInBody(body, issueNumber, originFullName)) {
    return body
  }

  const closingLine = `Closes #${issueNumber}`
  if (!body || !body.trim()) {
    return `${closingLine}\n`
  }

  const trimmed = body.trimEnd()
  return `${trimmed}\n\n${closingLine}\n`
}

/** Widen a deleted clause over an adjacent list separator so no dangling `,` or `;` survives. */
function deletionSpan(
  body: string,
  startIndex: number,
  endIndex: number,
): { start: number; end: number } {
  let start = startIndex
  let end = endIndex
  let lead = start
  while (lead > 0 && (body[lead - 1] === ' ' || body[lead - 1] === '\t')) lead--
  let trail = end
  while (trail < body.length && (body[trail] === ' ' || body[trail] === '\t')) trail++
  const before = lead > 0 ? body[lead - 1] : null
  const after = trail < body.length ? body[trail] : null
  const isSeparator = (value: string | null): boolean => value === ',' || value === ';'
  if (isSeparator(before) && (!after || isSeparator(after) || after === '\n')) start = lead - 1
  if (isSeparator(after) && (!before || isSeparator(before) || before === '\n')) end = trail + 1
  return { start, end }
}

/**
 * Removes the exact closing clauses that close the given issue, using the spans
 * the parser detected. Foreign references, unrelated numbers such as #123, and
 * every other word of the author's description are left untouched.
 */
export function removeClosingReference(
  body: string,
  issueNumber: number,
  originFullName?: string,
): string {
  if (!isIssueClosedInBody(body, issueNumber, originFullName)) {
    return body
  }

  // Edits are grouped per line and applied to that line's own text, so several
  // clauses for the same issue on one line are all removed and no untouched
  // bytes are reconstructed. Every other line — including deliberate runs of
  // blank lines — is preserved exactly.
  const lines = body.split('\n')
  const lineStarts: number[] = []
  for (let offset = 0; offset < body.length; ) {
    lineStarts.push(offset)
    const next = body.indexOf('\n', offset)
    if (next === -1) break
    offset = next + 1
  }
  const byLine = new Map<number, { start: number; end: number }[]>()
  for (const ref of extractClosingReferences(body, originFullName)) {
    if (ref.issueNumber !== issueNumber) continue
    const span = deletionSpan(body, ref.startIndex, ref.endIndex)
    let lineIndex = 0
    while (lineIndex + 1 < lineStarts.length && lineStarts[lineIndex + 1] <= span.start) {
      lineIndex++
    }
    const lineStart = lineStarts[lineIndex]
    const group = byLine.get(lineIndex) ?? []
    group.push({ start: span.start - lineStart, end: span.end - lineStart })
    byLine.set(lineIndex, group)
  }

  const dropped = new Set<number>()
  for (const [lineIndex, group] of byLine) {
    const line = lines[lineIndex]
    const ordered = group.sort((a, b) => a.start - b.start)
    let kept = ''
    let cursor = 0
    for (const span of ordered) {
      kept += line.slice(cursor, span.start)
      cursor = span.end
    }
    kept += line.slice(cursor)
    // A clause removed from the start or end of the line takes the blank space
    // it leaves with it; interior spacing is untouched.
    if (ordered[0].start === 0) kept = kept.replace(/^[ \t]+/u, '')
    if (ordered[ordered.length - 1].end === line.length) kept = kept.replace(/[ \t]+$/u, '')
    if (kept.trim()) {
      lines[lineIndex] = kept
    } else {
      dropped.add(lineIndex)
    }
  }

  const keptLines: string[] = []
  let skippingLeadingBlank = false
  for (const [index, line] of lines.entries()) {
    if (dropped.has(index)) {
      if (keptLines.length === 0) skippingLeadingBlank = true
      // Close a gap the removed clause opened, without touching any other run.
      while (
        keptLines.length > 0 &&
        keptLines[keptLines.length - 1].trim() === '' &&
        (lines[index + 1]?.trim() ?? '') === ''
      ) {
        keptLines.pop()
      }
      continue
    }
    if (skippingLeadingBlank && keptLines.length === 0 && line.trim() === '') continue
    skippingLeadingBlank = false
    keptLines.push(line)
  }

  const result = keptLines.join('\n').trimEnd()
  return result ? `${result}\n` : ''
}

const CONFIG_PREFIX = 'gitstacks.pr.'

/** Read local contextual (non-closing) issue links stored in local Git config. */
export async function readLocalContextualIssueLinks(
  repoPath: string,
  prNumber: number,
): Promise<number[]> {
  const key = `${CONFIG_PREFIX}${prNumber}.relatedissue`
  try {
    const raw = await runGit(repoPath, ['config', '--local', '--get-all', key])
    const numbers = raw
      .split('\n')
      .map((v: string) => Number(v.trim()))
      .filter((n: number) => Number.isInteger(n) && n > 0)
    return [...new Set(numbers)]
  } catch {
    return []
  }
}
/** Store a local contextual issue link in local Git config idempotently. */
export async function addLocalContextualIssueLink(
  repoPath: string,
  prNumber: number,
  issueNumber: number,
): Promise<boolean> {
  const current = await readLocalContextualIssueLinks(repoPath, prNumber)
  if (current.includes(issueNumber)) {
    return false
  }
  const key = `${CONFIG_PREFIX}${prNumber}.relatedissue`
  await runGit(repoPath, ['config', '--local', '--add', key, String(issueNumber)])
  return true
}

/** Remove a local contextual issue link from local Git config idempotently. */
export async function removeLocalContextualIssueLink(
  repoPath: string,
  prNumber: number,
  issueNumber: number,
): Promise<boolean> {
  const current = await readLocalContextualIssueLinks(repoPath, prNumber)
  if (!current.includes(issueNumber)) {
    return false
  }
  const remaining = current.filter((n) => n !== issueNumber)
  const key = `${CONFIG_PREFIX}${prNumber}.relatedissue`
  try {
    await runGit(repoPath, ['config', '--local', '--unset-all', key])
  } catch {
    // Already unset
  }
  for (const num of remaining) {
    await runGit(repoPath, ['config', '--local', '--add', key, String(num)])
  }
  return true
}

/**
 * Search accessible repository issues (both OPEN and CLOSED) by number or title.
 * Degrades cleanly to an error message when offline.
 */
export async function searchGitHubIssues(
  repoPath: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ issues: RepositoryIssue[]; message: string }> {
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  if (!originUrl) {
    return { issues: [], message: 'Issues unavailable: no origin remote is configured' }
  }
  const host = remoteHostContext(remote)
  if (!remote || !host) {
    return {
      issues: [],
      message: `Issues unavailable: a GitHub origin is required; this origin is on ${remote ? remote.host : 'no host'}`,
    }
  }

  // The query is a literal title/number search inside origin. Qualifier tokens
  // (`repo:`, `org:`, `is:`, …) are stripped so user input cannot widen the
  // search past this repository and close an unrelated issue with a shared number.
  const terms = query
    .trim()
    .replace(/^#+/u, '')
    .replace(/"[^"]*"/gu, (quoted) => quoted.slice(1, -1))
    .split(/\s+/u)
    .filter((token) => token.length > 0 && !token.includes(':'))
    .join(' ')
  const isNumberQuery = /^\d+$/u.test(terms)
  const issueNumber = isNumberQuery ? Number(terms) : null

  try {
    const transport = hostTransport(host)
    const issuesMap = new Map<number, RepositoryIssue>()

    // If query is an exact issue number, try direct issue lookup first
    if (issueNumber !== null) {
      try {
        const directLookup = await transport.graphql<unknown>(
          `query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              issue(number: $number) {
                number
                title
                url
                state
              }
            }
          }`,
          { owner: remote.owner, name: remote.name, number: issueNumber },
          { signal },
        )
        if (
          isRecord(directLookup) &&
          isRecord(directLookup.repository) &&
          isRecord(directLookup.repository.issue)
        ) {
          const iss = directLookup.repository.issue
          if (
            typeof iss.number === 'number' &&
            typeof iss.title === 'string' &&
            typeof iss.url === 'string'
          ) {
            issuesMap.set(iss.number, {
              number: iss.number,
              title: iss.title,
              url: iss.url,
              state: iss.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
            })
          }
        }
      } catch {
        // Fall back to general search
      }
    }

    // Search issues in repository (returns both OPEN and CLOSED)
    const searchQuery = terms
      ? `repo:${remote.owner}/${remote.name} is:issue ${terms}`
      : `repo:${remote.owner}/${remote.name} is:issue`

    const searchResult = await transport.graphql<unknown>(
      `query($searchQuery: String!) {
        search(query: $searchQuery, type: ISSUE, first: 50) {
          issueCount
          nodes {
            __typename
            ... on Issue {
              number
              title
              url
              state
              repository { nameWithOwner }
            }
          }
        }
      }`,
      { searchQuery },
      { signal },
    )

    if (
      isRecord(searchResult) &&
      isRecord(searchResult.search) &&
      Array.isArray(searchResult.search.nodes)
    ) {
      const originFullName = remote.fullName.toLowerCase()
      for (const node of searchResult.search.nodes) {
        if (
          isRecord(node) &&
          typeof node.number === 'number' &&
          typeof node.title === 'string' &&
          typeof node.url === 'string' &&
          isRecord(node.repository) &&
          typeof node.repository.nameWithOwner === 'string' &&
          // Defence in depth: a foreign result is never offered as a link target.
          node.repository.nameWithOwner.toLowerCase() === originFullName
        ) {
          issuesMap.set(node.number, {
            number: node.number,
            title: node.title,
            url: node.url,
            state: node.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
          })
        }
      }
    }

    const issues = Array.from(issuesMap.values()).sort((a, b) => b.number - a.number)
    return { issues, message: '' }
  } catch (error) {
    if (isCancelled(error)) throw error
    return { issues: [], message: githubErrorMessage(error) }
  }
}

/**
 * Retrieve all issue links for a pull request, resolving both:
 * 1. Local contextual links stored in local git config (app-owned metadata).
 * 2. Closing references parsed from the pull request body.
 * Issue titles and states are fetched from GitHub, degrading gracefully offline.
 */
export async function getPullRequestIssueLinks(
  repoPath: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<PullRequestIssueLinks> {
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)

  const localNumbers = await readLocalContextualIssueLinks(repoPath, prNumber)
  let livePr: (PullRequest & { body: string }) | null = null
  let message: string | undefined = undefined

  try {
    livePr = await getPullRequest(repoPath, prNumber, signal)
  } catch (error) {
    if (isCancelled(error)) throw error
    message = githubErrorMessage(error)
  }

  const closingNumbers: number[] = []
  if (livePr && remote && host) {
    try {
      if (livePr.base !== (await repositoryDefaultBranch(remote.fullName, host, signal)))
        livePr = null
    } catch (error) {
      if (isCancelled(error)) throw error
      message = githubErrorMessage(error)
      livePr = null
    }
  }
  if (livePr && remote && host) {
    const refs = extractClosingReferences(livePr.body, remote?.fullName)
    for (const ref of refs) {
      if (!closingNumbers.includes(ref.issueNumber)) {
        closingNumbers.push(ref.issueNumber)
      }
    }
  }

  // Combine issue numbers. Closing link takes precedence over local link if present in both
  const allNumbers = [...new Set([...closingNumbers, ...localNumbers])]
  if (allNumbers.length === 0) {
    return { prNumber, links: [], message }
  }

  // Attempt to resolve issue metadata from GitHub
  const issueDetails = new Map<number, RepositoryIssue>()
  if (remote && host) {
    try {
      const transport = hostTransport(host)
      await Promise.all(
        allNumbers.map(async (num) => {
          try {
            const directLookup = await transport.graphql<unknown>(
              `query($owner: String!, $name: String!, $number: Int!) {
                repository(owner: $owner, name: $name) {
                  issue(number: $number) {
                    number
                    title
                    url
                    state
                  }
                }
              }`,
              { owner: remote.owner, name: remote.name, number: num },
              { signal },
            )
            if (
              isRecord(directLookup) &&
              isRecord(directLookup.repository) &&
              isRecord(directLookup.repository.issue)
            ) {
              const iss = directLookup.repository.issue
              if (
                typeof iss.number === 'number' &&
                typeof iss.title === 'string' &&
                typeof iss.url === 'string'
              ) {
                issueDetails.set(iss.number, {
                  number: iss.number,
                  title: iss.title,
                  url: iss.url,
                  state: iss.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
                })
              }
            }
          } catch {
            // Ignore individual issue lookup errors; fallback gracefully below
          }
        }),
      )
    } catch {
      // Offline fallback below
    }
  }

  const links: LinkedIssue[] = allNumbers.map((num) => {
    const isClosing = closingNumbers.includes(num)
    const resolved = issueDetails.get(num)
    return {
      number: num,
      title: resolved?.title ?? `Issue #${num}`,
      url:
        resolved?.url ?? (remote ? `https://${remote.host}/${remote.fullName}/issues/${num}` : ''),
      state: resolved?.state ?? 'OPEN',
      relation: isClosing ? 'closing' : 'contextual',
    }
  })

  return { prNumber, links, message }
}

async function repositoryDefaultBranch(
  fullName: string,
  host: GitHubHostContext,
  signal?: AbortSignal,
): Promise<string> {
  const { data } = await hostTransport(host).rest<{ default_branch?: unknown }>({
    path: `repos/${fullName}`,
    signal,
  })
  if (typeof data.default_branch !== 'string' || !data.default_branch) {
    throw new Error('Could not determine the GitHub repository default branch.')
  }
  return data.default_branch
}

/**
 * Preview the changes that will be applied to the pull request description or local metadata.
 */
export async function previewIssueLink(
  repoPath: string,
  prNumber: number,
  issueNumber: number,
  relation: IssueLinkRelation,
  action: 'link' | 'unlink',
  signal?: AbortSignal,
): Promise<IssueLinkPreview> {
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)

  if (relation === 'closing') {
    const livePr = await getPullRequest(repoPath, prNumber, signal)
    if (action === 'link') {
      if (
        !remote ||
        !host ||
        livePr.base !== (await repositoryDefaultBranch(remote.fullName, host, signal))
      ) {
        throw new Error(
          'Closing keywords only close issues when the pull request targets the repository default branch.',
        )
      }
    }
    const newBody =
      action === 'link'
        ? insertClosingReference(livePr.body, issueNumber, remote?.fullName)
        : removeClosingReference(livePr.body, issueNumber, remote?.fullName)

    return {
      prNumber,
      issueNumber,
      relation,
      action,
      currentBody: livePr.body,
      newBody,
      changed: newBody !== livePr.body,
      closingSyntax: `Closes #${issueNumber}`,
    }
  }

  // Contextual relation (local metadata only)
  const current = await readLocalContextualIssueLinks(repoPath, prNumber)
  const alreadyLinked = current.includes(issueNumber)
  const changed = action === 'link' ? !alreadyLinked : alreadyLinked

  return {
    prNumber,
    issueNumber,
    relation,
    action,
    currentBody: '',
    newBody: '',
    changed,
  }
}

/**
 * Execute linking an issue to a pull request.
 * For closing relations, revalidates external PR body edits immediately before writing.
 */
export async function runLinkIssueAction(
  repoPath: string,
  action: {
    prNumber: number
    issueNumber: number
    relation: IssueLinkRelation
    expectedBody?: string
  },
): Promise<ActionResult> {
  if (action.relation === 'contextual') {
    const added = await addLocalContextualIssueLink(repoPath, action.prNumber, action.issueNumber)
    return {
      message: added
        ? `Linked issue #${action.issueNumber} as related (local)`
        : `Issue #${action.issueNumber} is already linked as related`,
    }
  }

  // Closing relation: mutates PR body
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)
  if (!remote || !host) {
    throw new Error(
      `Pull request integration requires a GitHub origin remote; this repository's origin is on ${remote ? remote.host : 'no host'}.`,
    )
  }

  // Revalidate body immediately before writing!
  const livePr = await getPullRequest(repoPath, action.prNumber)
  if (livePr.base !== (await repositoryDefaultBranch(remote.fullName, host))) {
    throw new Error(
      'Closing keywords only close issues when the pull request targets the repository default branch.',
    )
  }
  if (action.expectedBody !== undefined && livePr.body !== action.expectedBody) {
    throw new Error(
      `External body modification detected: the pull request description on GitHub was modified after this action was previewed. Reload the pull request before modifying issue links.`,
    )
  }

  const updatedBody = insertClosingReference(livePr.body, action.issueNumber, remote.fullName)
  if (updatedBody === livePr.body) {
    return {
      message: `Pull request #${action.prNumber} already contains a closing reference for #${action.issueNumber}`,
    }
  }

  await patchPullRequest(remote.fullName, action.prNumber, { body: updatedBody }, host)

  const readBack = await getPullRequest(repoPath, action.prNumber)
  if (readBack.body !== updatedBody) {
    throw new Error(`Pull request #${action.prNumber} body did not update as expected`)
  }

  return {
    message: `Linked issue #${action.issueNumber} to close when pull request #${action.prNumber} is merged`,
  }
}

/**
 * Execute unlinking an issue from a pull request.
 * For closing relations, revalidates external PR body edits immediately before writing.
 */
export async function runUnlinkIssueAction(
  repoPath: string,
  action: {
    prNumber: number
    issueNumber: number
    relation: IssueLinkRelation
    expectedBody?: string
  },
): Promise<ActionResult> {
  if (action.relation === 'contextual') {
    const removed = await removeLocalContextualIssueLink(
      repoPath,
      action.prNumber,
      action.issueNumber,
    )
    return {
      message: removed
        ? `Removed local link to issue #${action.issueNumber}`
        : `Issue #${action.issueNumber} was not linked as related`,
    }
  }

  // Closing relation: mutates PR body
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  const host = remoteHostContext(remote)
  if (!remote || !host) {
    throw new Error(
      `Pull request integration requires a GitHub origin remote; this repository's origin is on ${remote ? remote.host : 'no host'}.`,
    )
  }

  // Revalidate body immediately before writing!
  const livePr = await getPullRequest(repoPath, action.prNumber)
  if (action.expectedBody !== undefined && livePr.body !== action.expectedBody) {
    throw new Error(
      `External body modification detected: the pull request description on GitHub was modified after this action was previewed. Reload the pull request before modifying issue links.`,
    )
  }

  const updatedBody = removeClosingReference(livePr.body, action.issueNumber, remote.fullName)
  if (updatedBody === livePr.body) {
    return {
      message: `Pull request #${action.prNumber} does not contain a closing reference for #${action.issueNumber}`,
    }
  }

  await patchPullRequest(remote.fullName, action.prNumber, { body: updatedBody }, host)

  const readBack = await getPullRequest(repoPath, action.prNumber)
  if (readBack.body !== updatedBody) {
    throw new Error(`Pull request #${action.prNumber} body did not update as expected`)
  }

  return {
    message: `Removed closing reference for issue #${action.issueNumber}`,
  }
}
