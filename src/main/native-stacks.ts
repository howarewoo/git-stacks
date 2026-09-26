import type {
  ActionResult,
  NativeStack,
  NativeStackValidationStatus,
  PullRequest,
  PullRequestStackMember,
  PullRequestStackMembership,
} from '../shared/types'
import { isRecord, parseRemote } from './git-core'
import {
  GITHUB_STACKS_API_VERSION,
  GitHubTransportError,
  githubTransport,
} from './github-transport'

export class NativeStackError extends Error {
  readonly status: NativeStackValidationStatus
  readonly httpStatus: number | null

  constructor(status: NativeStackValidationStatus, message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'NativeStackError'
    this.status = status
    this.httpStatus = httpStatus
  }
}

export function isNativeStackError(error: unknown): error is NativeStackError {
  return error instanceof NativeStackError
}

const STACK_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_STACKS_API_VERSION,
}

function normalizePrState(state: unknown, mergedAt: unknown): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (typeof mergedAt === 'string' && mergedAt) return 'MERGED'
  const upper = typeof state === 'string' ? state.toUpperCase() : 'OPEN'
  return upper === 'MERGED' || upper === 'CLOSED' ? upper : 'OPEN'
}

/** Parse a raw GitHub REST pull request stack object into a domain NativeStack model. */
export function parseRestStack(raw: unknown): NativeStack {
  if (!isRecord(raw)) throw new Error('Invalid stack payload from GitHub REST API')
  const id = typeof raw.id === 'number' ? raw.id : 0
  const number = typeof raw.number === 'number' ? raw.number : 0
  const url = typeof raw.url === 'string' ? raw.url : ''
  const open = raw.open === true
  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : ''
  const baseObj = isRecord(raw.base) ? raw.base : {}
  const base = typeof baseObj.ref === 'string' ? baseObj.ref : 'main'

  const rawPrs = Array.isArray(raw.pull_requests) ? raw.pull_requests : []
  const size = rawPrs.length
  const pullRequests: PullRequestStackMember[] = []

  for (let i = 0; i < rawPrs.length; i++) {
    const item = rawPrs[i]
    if (!isRecord(item)) continue
    const prNumber = typeof item.number === 'number' ? item.number : 0
    const headObj = isRecord(item.head) ? item.head : {}
    const head = typeof headObj.ref === 'string' ? headObj.ref : ''
    const headSha = typeof headObj.sha === 'string' ? headObj.sha : undefined
    const memberBase = i === 0 ? base : pullRequests[i - 1]?.head ?? base
    const state = normalizePrState(item.state, item.merged_at)
    const draft = item.draft === true

    pullRequests.push({
      number: prNumber,
      position: i + 1,
      total: size,
      head,
      ...(headSha ? { headSha } : {}),
      base: memberBase,
      state,
      draft,
    })
  }

  let status: NativeStackValidationStatus = 'valid'
  if (!open) {
    status = 'closed'
  } else if (size > 0 && pullRequests.every((pr) => pr.state === 'MERGED' || pr.state === 'CLOSED')) {
    status = 'completed'
  } else {
    // Check duplicates
    const seen = new Set<number>()
    let hasDuplicate = false
    for (const pr of pullRequests) {
      if (seen.has(pr.number)) {
        hasDuplicate = true
        break
      }
      seen.add(pr.number)
    }
    if (hasDuplicate) {
      status = 'duplicate-pr'
    } else {
      // Check chain continuity
      let validChain = true
      for (let i = 1; i < pullRequests.length; i++) {
        if (!pullRequests[i].head || !pullRequests[i - 1].head || pullRequests[i].base !== pullRequests[i - 1].head) {
          validChain = false
          break
        }
      }
      if (!validChain) {
        status = 'invalid-chain'
      }
    }
  }

  return {
    id,
    number,
    url,
    base,
    open,
    createdAt,
    size,
    pullRequests,
    status,
  }
}

/** Extract typed membership for one PR from a NativeStack. */
export function toPullRequestStackMembership(
  stack: NativeStack,
  prNumber: number,
): PullRequestStackMembership | null {
  const member = stack.pullRequests.find((item) => item.number === prNumber)
  if (!member) return null
  return {
    stackNumber: stack.number,
    position: member.position,
    size: stack.size,
    base: member.base,
    open: stack.open,
    url: stack.url,
  }
}

export interface NativeStackValidationResult {
  status: NativeStackValidationStatus
  valid: boolean
  message?: string
}

/** Validate a chain of pull requests intended to form a stack from bottom to top. */
export function validateNativeStackChain(
  pullRequests: readonly PullRequest[],
  optionsInput: { targetRepository?: string; defaultBranch?: string } | string = {},
): NativeStackValidationResult {
  const options =
    typeof optionsInput === 'string'
      ? { defaultBranch: optionsInput }
      : optionsInput

  if (pullRequests.length === 0) {
    return {
      status: 'invalid-chain',
      valid: false,
      message: 'A native stack requires at least one pull request',
    }
  }

  const seenNumbers = new Set<number>()
  const seenHeads = new Set<string>()
  for (const pr of pullRequests) {
    if (seenNumbers.has(pr.number) || seenHeads.has(pr.head)) {
      return {
        status: 'duplicate-pr',
        valid: false,
        message: `Duplicate pull request #${pr.number} (${pr.head}) in chain`,
      }
    }
    seenNumbers.add(pr.number)
    seenHeads.add(pr.head)
  }

  const targetRepo = options.targetRepository?.toLowerCase() ?? pullRequests[0]?.headRepository?.toLowerCase()
  if (targetRepo) {
    for (const pr of pullRequests) {
      if (pr.headRepository && pr.headRepository.toLowerCase() !== targetRepo) {
        return {
          status: 'cross-fork-head',
          valid: false,
          message: `Pull request #${pr.number} head belongs to a fork (${pr.headRepository}) rather than ${targetRepo}`,
        }
      }
    }
  }

  if (options.defaultBranch && pullRequests[0].base !== options.defaultBranch) {
    return {
      status: 'invalid-chain',
      valid: false,
      message: `Pull request #${pullRequests[0].number} base (${pullRequests[0].base}) does not match base branch (${options.defaultBranch})`,
    }
  }

  for (let i = 1; i < pullRequests.length; i++) {
    const prev = pullRequests[i - 1]
    const curr = pullRequests[i]
    if (curr.base !== prev.head) {
      return {
        status: 'invalid-chain',
        valid: false,
        message: `Pull request #${curr.number} base (${curr.base}) does not match preceding pull request #${prev.number} head (${prev.head})`,
      }
    }
  }

  return { status: 'valid', valid: true }
}

/** Validate pull requests being appended to the top of an existing native stack. */
export function validateTopAppend(
  stack: NativeStack,
  newPullRequests: readonly PullRequest[],
  options: { targetRepository?: string } = {},
): NativeStackValidationResult {
  if (!stack.open) {
    return {
      status: 'closed',
      valid: false,
      message: `Cannot add pull requests to closed stack #${stack.number}`,
    }
  }
  if (stack.status === 'completed') {
    return {
      status: 'completed',
      valid: false,
      message: `Cannot add pull requests to completed stack #${stack.number}`,
    }
  }
  if (newPullRequests.length === 0) {
    return {
      status: 'invalid-chain',
      valid: false,
      message: 'At least one pull request is required to extend the stack',
    }
  }

  const existingNumbers = new Set(stack.pullRequests.map((pr) => pr.number))
  const existingHeads = new Set(stack.pullRequests.map((pr) => pr.head))
  for (const pr of newPullRequests) {
    if (existingNumbers.has(pr.number) || existingHeads.has(pr.head)) {
      return {
        status: 'duplicate-pr',
        valid: false,
        message: `Pull request #${pr.number} is already in stack #${stack.number}`,
      }
    }
  }

  const chainResult = validateNativeStackChain(newPullRequests, options)
  if (!chainResult.valid) return chainResult

  const currentTop = stack.pullRequests[stack.pullRequests.length - 1]
  if (currentTop && newPullRequests[0].base !== currentTop.head) {
    return {
      status: 'invalid-chain',
      valid: false,
      message: `Appended pull request #${newPullRequests[0].number} base (${newPullRequests[0].base}) must match current stack top #${currentTop.number} head (${currentTop.head})`,
    }
  }

  return { status: 'valid', valid: true }
}

/** Capability-detect the native stacks REST preview API. */
export async function detectNativeStacksCapability(
  owner: string,
  repo: string,
): Promise<{ available: boolean; state: NativeStackValidationStatus; message: string }> {
  const transport = githubTransport()
  try {
    const response = await transport.rest<unknown>({
      method: 'GET',
      path: `repos/${owner}/${repo}/stacks?per_page=1`,
      headers: STACK_HEADERS,
    })
    if (response.status >= 200 && response.status < 300) {
      return { available: true, state: 'valid', message: 'Native stacked pull requests API preview is available' }
    }
    return {
      available: false,
      state: 'preview-unavailable',
      message: `Native stacked pull requests API returned status ${response.status}`,
    }
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.kind === 'not-found' || error.status === 404 || error.kind === 'unsupported') {
        return {
          available: false,
          state: 'preview-unavailable',
          message: 'GitHub native stacked pull requests preview API is not available on this repository',
        }
      }
    }
    return {
      available: false,
      state: 'preview-unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** List pull request stacks in a repository. */
export async function listPullRequestStacks(
  owner: string,
  repo: string,
  options: { pullRequest?: number; perPage?: number; page?: number; signal?: AbortSignal } = {},
): Promise<NativeStack[]> {
  const transport = githubTransport()
  const params = new URLSearchParams()
  if (typeof options.pullRequest === 'number') {
    params.set('pull_request', String(options.pullRequest))
  }
  if (typeof options.perPage === 'number') {
    params.set('per_page', String(options.perPage))
  }
  if (typeof options.page === 'number') {
    params.set('page', String(options.page))
  }

  const query = params.toString()
  const basePath = `repos/${owner}/${repo}/stacks${query ? `?${query}` : ''}`

  try {
    let rawItems: unknown[]
    if (typeof options.page === 'number' || typeof options.pullRequest === 'number') {
      const response = await transport.rest<unknown>({
        method: 'GET',
        path: basePath,
        headers: STACK_HEADERS,
        signal: options.signal,
      })
      rawItems = Array.isArray(response.data) ? response.data : []
    } else {
      rawItems = await transport.paginate<unknown>({
        method: 'GET',
        path: basePath,
        headers: STACK_HEADERS,
        signal: options.signal,
      })
    }
    return rawItems.map(parseRestStack)
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.status === 404 || error.kind === 'not-found') {
        throw new NativeStackError('preview-unavailable', 'Native stacks endpoint not found (404)', 404)
      }
      if (error.status === 422 || error.kind === 'unprocessable') {
        throw new NativeStackError('invalid-chain', `Validation failed for stacks query: ${error.detail}`, 422)
      }
    }
    throw error
  }
}

/** Get a single pull request stack by its stack number. */
export async function getPullRequestStack(
  owner: string,
  repo: string,
  stackNumber: number,
  options: { signal?: AbortSignal } = {},
): Promise<NativeStack> {
  if (!Number.isInteger(stackNumber) || stackNumber <= 0) {
    throw new Error('Stack number must be a positive integer')
  }
  const transport = githubTransport()
  try {
    const response = await transport.rest<unknown>({
      method: 'GET',
      path: `repos/${owner}/${repo}/stacks/${stackNumber}`,
      headers: STACK_HEADERS,
      signal: options.signal,
    })
    return parseRestStack(response.data)
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.status === 404 || error.kind === 'not-found') {
        throw new NativeStackError('preview-unavailable', `Stack #${stackNumber} was not found (404)`, 404)
      }
    }
    throw error
  }
}

/** Create a native stack from an ordered bottom-to-top list of pull requests. */
export async function createPullRequestStack(
  owner: string,
  repo: string,
  pullRequests: readonly number[],
  options: {
    knownPullRequests?: readonly PullRequest[]
    defaultBranch?: string
    signal?: AbortSignal
  } = {},
): Promise<NativeStack> {
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    throw new NativeStackError('invalid-chain', 'createPullRequestStack requires an ordered list of pull request numbers')
  }

  // Pre-validate if domain pull request models are available
  if (options.knownPullRequests && options.knownPullRequests.length > 0) {
    const byNumber = new Map(options.knownPullRequests.map((pr) => [pr.number, pr]))
    const chain: PullRequest[] = []
    for (const num of pullRequests) {
      const pr = byNumber.get(num)
      if (pr) chain.push(pr)
    }
    if (chain.length === pullRequests.length) {
      const validation = validateNativeStackChain(chain, {
        targetRepository: `${owner}/${repo}`,
        defaultBranch: options.defaultBranch,
      })
      if (!validation.valid) {
        throw new NativeStackError(validation.status, validation.message ?? 'Invalid chain')
      }
    }
  }

  const transport = githubTransport()
  try {
    const response = await transport.rest<unknown>({
      method: 'POST',
      path: `repos/${owner}/${repo}/stacks`,
      headers: STACK_HEADERS,
      body: { pull_requests: [...pullRequests] },
      signal: options.signal,
    })
    return parseRestStack(response.data)
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.status === 404 || error.kind === 'not-found') {
        throw new NativeStackError('preview-unavailable', 'Native stacks API preview not found (404)', 404)
      }
      if (error.status === 422 || error.kind === 'unprocessable') {
        throw new NativeStackError('invalid-chain', `Validation failed for stack creation: ${error.detail}`, 422)
      }
    }
    throw error
  }
}

/** Append pull requests to the top of an existing stack. */
export async function addPullRequestsToStack(
  owner: string,
  repo: string,
  stackNumber: number,
  pullRequests: readonly number[],
  options: {
    existingStack?: NativeStack
    knownPullRequests?: readonly PullRequest[]
    signal?: AbortSignal
  } = {},
): Promise<NativeStack> {
  if (!Number.isInteger(stackNumber) || stackNumber <= 0) {
    throw new Error('Stack number must be a positive integer')
  }
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) {
    throw new NativeStackError('invalid-chain', 'addPullRequestsToStack requires pull request numbers')
  }

  if (options.existingStack && options.knownPullRequests) {
    const byNumber = new Map(options.knownPullRequests.map((pr) => [pr.number, pr]))
    const chain: PullRequest[] = []
    for (const num of pullRequests) {
      const pr = byNumber.get(num)
      if (pr) chain.push(pr)
    }
    if (chain.length === pullRequests.length) {
      const validation = validateTopAppend(options.existingStack, chain, { targetRepository: `${owner}/${repo}` })
      if (!validation.valid) {
        throw new NativeStackError(validation.status, validation.message ?? 'Invalid chain')
      }
    }
  }

  const transport = githubTransport()
  try {
    const response = await transport.rest<unknown>({
      method: 'POST',
      path: `repos/${owner}/${repo}/stacks/${stackNumber}/add`,
      headers: STACK_HEADERS,
      body: { pull_requests: [...pullRequests] },
      signal: options.signal,
    })
    return parseRestStack(response.data)
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.status === 404 || error.kind === 'not-found') {
        throw new NativeStackError('preview-unavailable', `Stack #${stackNumber} not found (404)`, 404)
      }
      if (error.status === 409 || error.kind === 'conflict') {
        throw new Error(`Stack #${stackNumber} is being modified by another request (409)`)
      }
      if (error.status === 422 || error.kind === 'unprocessable') {
        throw new NativeStackError('invalid-chain', `Validation failed appending to stack #${stackNumber}: ${error.detail}`, 422)
      }
    }
    throw error
  }
}

/** Remove unmerged pull requests from a stack. Returns dissolved=true if no pull requests remain. */
export async function unstackPullRequestStack(
  owner: string,
  repo: string,
  stackNumber: number,
  options: { signal?: AbortSignal } = {},
): Promise<{ dissolved: boolean; stack: NativeStack | null }> {
  if (!Number.isInteger(stackNumber) || stackNumber <= 0) {
    throw new Error('Stack number must be a positive integer')
  }
  const transport = githubTransport()
  try {
    const response = await transport.rest<unknown>({
      method: 'POST',
      path: `repos/${owner}/${repo}/stacks/${stackNumber}/unstack`,
      headers: STACK_HEADERS,
      body: {},
      signal: options.signal,
    })
    if (response.status === 204 || response.data === null || response.data === undefined || Object.keys(response.data as object).length === 0) {
      return { dissolved: true, stack: null }
    }
    return { dissolved: false, stack: parseRestStack(response.data) }
  } catch (error) {
    if (error instanceof GitHubTransportError) {
      if (error.status === 404 || error.kind === 'not-found') {
        throw new NativeStackError('preview-unavailable', `Stack #${stackNumber} not found (404)`, 404)
      }
      if (error.status === 409 || error.kind === 'conflict') {
        throw new Error(`Stack #${stackNumber} is currently locked or in conflict (409)`)
      }
      if (error.status === 422 || error.kind === 'unprocessable') {
        throw new NativeStackError('invalid-chain', `Cannot unstack #${stackNumber}: ${error.detail}`, 422)
      }
    }
    throw error
  }
}

export { unstackPullRequestStack as unstackPullRequests }

/** Loads native stacks for the origin remote and attaches stack memberships to pullRequests. */
export async function loadRepositoryNativeStacks(
  originUrl: string | null,
  pullRequests: PullRequest[],
): Promise<{
  available: boolean
  nativeStacks: NativeStack[]
  state: NativeStackValidationStatus
  message: string
}> {
  const remote = parseRemote(originUrl)
  if (!originUrl || !remote || remote.host !== 'github.com') {
    return {
      available: false,
      nativeStacks: [],
      state: 'preview-unavailable',
      message: 'Native stacks require a github.com origin remote',
    }
  }

  const capability = await detectNativeStacksCapability(remote.owner, remote.name)
  if (!capability.available) {
    return {
      available: false,
      nativeStacks: [],
      state: capability.state,
      message: capability.message,
    }
  }

  try {
    const stacks = await listPullRequestStacks(remote.owner, remote.name)
    const byNumber = new Map(pullRequests.map((pr) => [pr.number, pr]))
    for (const stack of stacks) {
      for (const member of stack.pullRequests) {
        const pr = byNumber.get(member.number)
        if (pr) {
          pr.stack = toPullRequestStackMembership(stack, member.number)
        }
      }
    }
    return {
      available: true,
      nativeStacks: stacks,
      state: 'valid',
      message: `GitHub native stacks available; ${stacks.length} stack${stacks.length === 1 ? '' : 's'}`,
    }
  } catch (error) {
    return {
      available: false,
      nativeStacks: [],
      state: 'preview-unavailable',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function createNativeStackAction(
  repoPath: string,
  originFullName: string,
  pullRequests: number[],
  knownPullRequests: PullRequest[],
  defaultBranch?: string,
): Promise<ActionResult> {
  const [owner, name] = originFullName.split('/')
  const stack = await createPullRequestStack(owner, name, pullRequests, {
    knownPullRequests,
    defaultBranch,
  })
  return {
    message: `Created GitHub native stack #${stack.number} with ${stack.size} pull requests`,
    url: stack.url,
  }
}

export async function addPullRequestsToNativeStackAction(
  repoPath: string,
  originFullName: string,
  stackNumber: number,
  pullRequests: number[],
  knownPullRequests: PullRequest[],
): Promise<ActionResult> {
  const [owner, name] = originFullName.split('/')
  const existing = await getPullRequestStack(owner, name, stackNumber)
  const stack = await addPullRequestsToStack(owner, name, stackNumber, pullRequests, {
    existingStack: existing,
    knownPullRequests,
  })
  return {
    message: `Added ${pullRequests.length} pull request${pullRequests.length === 1 ? '' : 's'} to native stack #${stack.number}`,
    url: stack.url,
  }
}

export async function unstackNativeStackAction(
  repoPath: string,
  originFullName: string,
  stackNumber: number,
): Promise<ActionResult> {
  const [owner, name] = originFullName.split('/')
  const result = await unstackPullRequestStack(owner, name, stackNumber)
  if (result.dissolved) {
    return { message: `Dissolved native stack #${stackNumber}` }
  }
  return { message: `Unstacked pull requests from native stack #${stackNumber}` }
}
