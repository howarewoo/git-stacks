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
import {
  getConfigValue,
  isCancelled,
  isRecord,
  parseRemote,
  runGit,
} from './git-core'
import { getPullRequest, githubErrorMessage } from './github'
import { githubTransport } from './github-transport'
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

const CLOSING_KEYWORD_REGEX =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi

/**
 * Extract all GitHub-recognized closing issue references from a PR body.
 * Supports:
 * - Closes #123, Fixes GH-123
 * - Multiple issues: Closes #1, #2 and fixes #3
 * - Fully qualified or URL forms matching the target origin:
 *   closes https://github.com/owner/repo/issues/123 or fixes owner/repo#123
 */
export function extractClosingReferences(
  body: string,
  originFullName?: string,
): ExtractedClosingReference[] {
  if (!body) return []
  const results: ExtractedClosingReference[] = []
  const normalizedOrigin = originFullName?.toLowerCase()

  // Match each closing keyword
  let keywordMatch: RegExpExecArray | null
  CLOSING_KEYWORD_REGEX.lastIndex = 0

  while ((keywordMatch = CLOSING_KEYWORD_REGEX.exec(body)) !== null) {
    const keyword = keywordMatch[1]
    let cursor = keywordMatch.index + keywordMatch[0].length

    // Scan following tokens for issue references (e.g. #12, GH-12, owner/repo#12, or URLs)
    // Separators like ',', 'and', '&', and whitespace continue the chain for the same keyword
    while (cursor < body.length) {
      // Skip whitespace
      const wsMatch = /^\s+/u.exec(body.slice(cursor))
      if (wsMatch) {
        cursor += wsMatch[0].length
      }

      const rest = body.slice(cursor)
      if (!rest) break

      // Check for chain connectors like "and", ",", "&"
      const connectorMatch = /^(?:,|and|&)\s*/iu.exec(rest)
      if (connectorMatch) {
        cursor += connectorMatch[0].length
        continue
      }

      // Check for issue reference patterns
      // 1. URL pattern: https://github.com/owner/repo/issues/123
      const urlMatch =
        /^(?:https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+))\b/u.exec(
          rest,
        )
      if (urlMatch) {
        const repo = `${urlMatch[1]}/${urlMatch[2]}`.toLowerCase()
        const issueNum = Number(urlMatch[3])
        if (!normalizedOrigin || repo === normalizedOrigin) {
          results.push({
            issueNumber: issueNum,
            keyword,
            rawMatch: urlMatch[0],
            startIndex: cursor,
            endIndex: cursor + urlMatch[0].length,
          })
        }
        cursor += urlMatch[0].length
        continue
      }

      // 2. Qualified pattern: owner/repo#123
      const qualifiedMatch =
        /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)#(\d+)\b/u.exec(rest)
      if (qualifiedMatch) {
        const repo = `${qualifiedMatch[1]}/${qualifiedMatch[2]}`.toLowerCase()
        const issueNum = Number(qualifiedMatch[3])
        if (!normalizedOrigin || repo === normalizedOrigin) {
          results.push({
            issueNumber: issueNum,
            keyword,
            rawMatch: qualifiedMatch[0],
            startIndex: cursor,
            endIndex: cursor + qualifiedMatch[0].length,
          })
        }
        cursor += qualifiedMatch[0].length
        continue
      }

      // 3. Short pattern: #123 or GH-123
      const shortMatch = /^(?:#|GH-)(\d+)\b/iu.exec(rest)
      if (shortMatch) {
        const issueNum = Number(shortMatch[1])
        results.push({
          issueNumber: issueNum,
          keyword,
          rawMatch: shortMatch[0],
          startIndex: cursor,
          endIndex: cursor + shortMatch[0].length,
        })
        cursor += shortMatch[0].length
        continue
      }

      // If token is neither a connector nor an issue reference, this closing clause ends
      break
    }
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

/**
 * Removes the exact closing reference for the specified issue from the PR body,
 * preserving all user-authored text and surrounding content.
 */
export function removeClosingReference(
  body: string,
  issueNumber: number,
  originFullName?: string,
): string {
  if (!isIssueClosedInBody(body, issueNumber, originFullName)) {
    return body
  }

  const lines = body.split('\n')
  const remainingLines: string[] = []

  for (const line of lines) {
    const refs = extractClosingReferences(line, originFullName)
    const matchesTarget = refs.some((r) => r.issueNumber === issueNumber)

    if (!matchesTarget) {
      remainingLines.push(line)
      continue
    }

    // If the line only contains the closing reference for this issue (e.g. "Closes #12" or "- Closes #12"), drop the line
    const cleanedLine = line
      .replace(new RegExp(`\\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:#|GH-)${issueNumber}\\b`, 'iu'), '')
      .replace(/^[\s*-]+/u, '')
      .trim()

    if (!cleanedLine || cleanedLine === ',' || cleanedLine === 'and') {
      // Entire line was this closing reference
      continue
    }

    // Line has other content or other issues, e.g. "Closes #10, #12" -> replace just this issue
    let modified = line
    // Try removing ", #<num>" or "#<num>, " or just "#<num>"
    modified = modified.replace(new RegExp(`,\\s*(?:#|GH-)${issueNumber}\\b`, 'iu'), '')
    modified = modified.replace(new RegExp(`(?:#|GH-)${issueNumber}\\s*,?`, 'iu'), '')
    // Also clean up any lingering keyword if left empty
    modified = modified.replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*(?:and)?\s*$/iu, '')
    if (modified.trim()) {
      remainingLines.push(modified)
    }
  }

  let result = remainingLines.join('\n')
  // Ensure cleanly formatted trailing newline
  if (result.trim()) {
    result = `${result.trimEnd()}\n`
  } else {
    result = ''
  }
  return result
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
  if (!remote || remote.host !== 'github.com') {
    return {
      issues: [],
      message: 'Issues unavailable: a github.com origin is required',
    }
  }

  const terms = query.trim().replace(/^#+/u, '')
  const isNumberQuery = /^\d+$/u.test(terms)
  const issueNumber = isNumberQuery ? Number(terms) : null

  try {
    const transport = githubTransport()
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
          if (typeof iss.number === 'number' && typeof iss.title === 'string' && typeof iss.url === 'string') {
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
            }
          }
        }
      }`,
      { searchQuery },
      { signal },
    )

    if (isRecord(searchResult) && isRecord(searchResult.search) && Array.isArray(searchResult.search.nodes)) {
      for (const node of searchResult.search.nodes) {
        if (
          isRecord(node) &&
          typeof node.number === 'number' &&
          typeof node.title === 'string' &&
          typeof node.url === 'string'
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
  if (livePr) {
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
  if (remote && remote.host === 'github.com') {
    try {
      const transport = githubTransport()
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
      url: resolved?.url ?? (remote ? `https://${remote.host}/${remote.fullName}/issues/${num}` : ''),
      state: resolved?.state ?? 'OPEN',
      relation: isClosing ? 'closing' : 'contextual',
    }
  })

  return { prNumber, links, message }
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

  if (relation === 'closing') {
    const livePr = await getPullRequest(repoPath, prNumber, signal)
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
  if (!remote || remote.host !== 'github.com') {
    throw new Error('Pull request integration requires a github.com origin remote.')
  }

  // Revalidate body immediately before writing!
  const livePr = await getPullRequest(repoPath, action.prNumber)
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

  await patchPullRequest(remote.fullName, action.prNumber, { body: updatedBody })

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
    const removed = await removeLocalContextualIssueLink(repoPath, action.prNumber, action.issueNumber)
    return {
      message: removed
        ? `Removed local link to issue #${action.issueNumber}`
        : `Issue #${action.issueNumber} was not linked as related`,
    }
  }

  // Closing relation: mutates PR body
  const originUrl = await getConfigValue(repoPath, 'remote.origin.url')
  const remote = parseRemote(originUrl)
  if (!remote || remote.host !== 'github.com') {
    throw new Error('Pull request integration requires a github.com origin remote.')
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

  await patchPullRequest(remote.fullName, action.prNumber, { body: updatedBody })

  const readBack = await getPullRequest(repoPath, action.prNumber)
  if (readBack.body !== updatedBody) {
    throw new Error(`Pull request #${action.prNumber} body did not update as expected`)
  }

  return {
    message: `Removed closing reference for issue #${action.issueNumber}`,
  }
}
