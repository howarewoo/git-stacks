import { randomUUID } from 'node:crypto'
import type {
  NativeOperationRequest,
  NativeOperationPreview,
} from '@git-stacks/shared/native-operation'
import type { ActionResult } from '@git-stacks/shared/types'
import { isRecord } from '@git-stacks/shared/guards'
import { getOriginUrl, parseRemote } from './git-core'
import { getPullRequest } from './github'
import { hostTransport, remoteHostContext } from './github-host'
import {
  detectNativeStacksCapability,
  getPullRequestStack,
  validateNativeStackChain,
  validateTopAppend,
  createNativeStackAction,
  addPullRequestsToNativeStackAction,
  unstackNativeStackAction,
} from './native-stacks'
import { recordOperationPreview, readOperationRecords } from './operation-authority'

const plans = new Map<
  string,
  {
    root: string
    origin: string
    preview: NativeOperationPreview
    signature: string
    expires: number
  }
>()
async function inspect(root: string, request: NativeOperationRequest) {
  const origin = await getOriginUrl(root)
  const remote = parseRemote(origin)
  const host = remoteHostContext(remote)
  if (!origin || !remote || !host)
    throw new Error('An exact configured GitHub provider repository is required.')
  const capability = await detectNativeStacksCapability(remote.owner, remote.name, { host })
  const blockers: string[] = []
  if (!capability.available) blockers.push(capability.message)
  const { data: repository } = await hostTransport(host).rest<Record<string, unknown>>({
    path: `repos/${remote.fullName}`,
  })
  if (
    !isRecord(repository.permissions) ||
    !['push', 'maintain', 'admin'].some(
      (key) => isRecord(repository.permissions) && repository.permissions[key] === true,
    )
  )
    blockers.push('Current provider mutation permission is not established.')
  const stack =
    request.kind === 'create'
      ? null
      : await getPullRequestStack(remote.owner, remote.name, request.stackNumber, { host })
  const numbers =
    request.kind === 'create'
      ? request.pullRequests
      : request.kind === 'unstack'
        ? stack!.pullRequests.map((member) => member.number)
        : [
            ...new Set([
              ...stack!.pullRequests.map((member) => member.number),
              ...request.pullRequests,
            ]),
          ]
  const pullRequests = await Promise.all(numbers.map((number) => getPullRequest(root, number)))
  if (
    pullRequests.some(
      (pr) =>
        !pr.headOid ||
        !pr.baseOid ||
        pr.metadata !== 'full' ||
        pr.headRepository?.toLowerCase() !== remote.fullName.toLowerCase(),
    )
  )
    blockers.push(
      'Every selected provider head/base and same-repository identity must be established.',
    )
  if (stack) {
    const canonical = new Map(pullRequests.map((pr) => [pr.number, pr]))
    for (const member of stack.pullRequests) {
      const actual = canonical.get(member.number)
      if (
        !actual ||
        !member.headSha ||
        actual.headOid !== member.headSha ||
        actual.head !== member.head ||
        actual.base !== member.base ||
        actual.state !== member.state
      )
        blockers.push(
          `Registered member #${member.number} no longer matches its actual canonical head/base/state.`,
        )
    }
  }
  const prior = (await readOperationRecords(root)).find(
    (record) =>
      record.action.type === 'executeNativeOperation' &&
      record.remoteDispatch === 'intent' &&
      ['active', 'unconfirmed'].includes(record.state) &&
      record.preview &&
      'fullName' in record.preview &&
      record.preview.fullName === `${host.host}/${remote.fullName}` &&
      'request' in record.preview &&
      record.preview.request.kind === request.kind &&
      (request.kind === 'create'
        ? record.preview.request.kind === 'create' &&
          record.preview.request.pullRequests.some((number) =>
            request.pullRequests.includes(number),
          )
        : record.preview.request.kind !== 'create' &&
          record.preview.request.stackNumber === request.stackNumber),
  )
  if (prior)
    blockers.push(
      'A prior app write to this native resource is unconfirmed. Inspect its original durable status and actual provider effects; the uncertain request cannot be replayed.',
    )
  if (request.kind === 'create') {
    const validation = validateNativeStackChain(pullRequests, {
      targetRepository: remote.fullName,
      defaultBranch:
        typeof repository.default_branch === 'string' ? repository.default_branch : undefined,
    })
    if (!validation.valid)
      blockers.push(validation.message ?? 'The selected bottom-to-top chain is invalid.')
  } else if (request.kind === 'extend') {
    const selected = pullRequests.filter((pr) => request.pullRequests.includes(pr.number))
    const validation = validateTopAppend(stack!, selected, { targetRepository: remote.fullName })
    if (!validation.valid)
      blockers.push(validation.message ?? 'The selected top append is invalid.')
  } else if (!stack?.open) blockers.push('Only an observed open native stack can be unstacked.')
  const preview: NativeOperationPreview = {
    token: randomUUID(),
    request: structuredClone(request),
    fullName: `${host.host}/${remote.fullName}`,
    pullRequests,
    stack,
    blockers,
    effects: [
      request.kind === 'create'
        ? 'Register these exact PRs bottom-to-top as one native stack.'
        : request.kind === 'extend'
          ? 'Append only these exact PRs to the observed top, preserving existing membership and order.'
          : 'Unstack the observed unmerged members; the provider may dissolve an empty stack.',
      'Local branches, worktree directories, PR heads/bases and PR lifecycle are not changed by native registration alone.',
      'Legacy navigation owned by this account may be retired after confirmed registration. App locks do not exclude nonparticipating external tools; coordinate provider changes.',
    ],
  }
  const signature = JSON.stringify({
    origin,
    kind: request.kind,
    permission: repository.permissions,
    stack,
    pullRequests: pullRequests.map((pr) => ({
      number: pr.number,
      head: pr.head,
      headOid: pr.headOid,
      base: pr.base,
      baseOid: pr.baseOid,
      state: pr.state,
      draft: pr.draft,
      stack: pr.stack,
    })),
  })
  return { preview, origin, signature }
}
export async function previewNativeOperation(
  root: string,
  value: unknown,
): Promise<NativeOperationPreview> {
  for (const [token, plan] of plans) if (plan.expires < Date.now()) plans.delete(token)
  if (!isRecord(value) || !['create', 'extend', 'unstack'].includes(String(value.kind)))
    throw new Error('Choose a supported native operation.')
  if (
    value.kind !== 'create' &&
    (!Number.isInteger(value.stackNumber) || Number(value.stackNumber) <= 0)
  )
    throw new Error('Choose an observed native stack number.')
  if (
    value.kind !== 'unstack' &&
    (!Array.isArray(value.pullRequests) ||
      !value.pullRequests.length ||
      value.pullRequests.some((number) => !Number.isInteger(number) || number <= 0) ||
      new Set(value.pullRequests).size !== value.pullRequests.length)
  )
    throw new Error('Choose exact distinct PR numbers in bottom-to-top order.')
  const request = value as unknown as NativeOperationRequest
  const { preview, origin, signature } = await inspect(root, request)
  plans.set(preview.token, { root, origin, preview, signature, expires: Date.now() + 5 * 60_000 })
  return preview
}
export async function executeNativeOperation(
  root: string,
  token: string,
  confirmed: boolean,
): Promise<ActionResult> {
  const plan = plans.get(token)
  if (!plan || plan.root !== root || plan.expires < Date.now())
    throw new Error('Native preview expired or belongs to another authority.')
  plans.delete(token)
  if (confirmed !== true)
    throw new Error('Explicit native membership change confirmation is required.')
  const current = await inspect(root, plan.preview.request)
  if (current.signature !== plan.signature || current.preview.blockers.length)
    throw new Error(
      'Native heads, bases, membership, capability or permissions changed; no mutation was sent.',
    )
  await recordOperationPreview(plan.preview)
  const remote = parseRemote(plan.origin)!
  const request = plan.preview.request
  if (request.kind === 'create')
    return createNativeStackAction(
      root,
      remote.fullName,
      request.pullRequests,
      plan.preview.pullRequests,
      plan.preview.pullRequests[0].repositoryDefaultBranch ?? undefined,
    )
  if (request.kind === 'extend')
    return addPullRequestsToNativeStackAction(
      root,
      remote.fullName,
      request.stackNumber,
      request.pullRequests,
      plan.preview.pullRequests,
      plan.preview.stack!,
    )
  return unstackNativeStackAction(root, remote.fullName, request.stackNumber, plan.preview.stack!)
}
