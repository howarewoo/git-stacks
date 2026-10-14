import { randomUUID, createHash } from 'node:crypto'
import { lstat, realpath, readFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import type {
  WorktreeLifecycleRequest,
  WorktreeLifecyclePreview,
  WorktreeLifecycleResult,
} from '@git-stacks/shared/worktree-lifecycle'
import { discoverWorktrees, inspectWorktree } from './worktree-inventory'
import { runGit, tryGit, validateBranchName, isExitCode } from './git-core'
import { recordOperationPreview, unresolvedOperationRecords } from './operation-authority'
import { validateOperationEffect, operationEffectGuard } from './inspection-context'
import { isRecord } from '@git-stacks/shared/guards'

interface Plan {
  root: string
  request: WorktreeLifecycleRequest
  preview: WorktreeLifecyclePreview
  signature: string
  identities: Map<string, string>
  expires: number
}
const plans = new Map<string, Plan>()

async function directoryIdentity(directory: string): Promise<string> {
  const value = await lstat(directory, { bigint: true })
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.ino === 0n ||
    value.birthtimeNs === 0n
  )
    throw new Error('Cannot qualify directory identity without following a symlink.')
  return `${value.dev}:${value.ino}:${value.birthtimeNs}`
}
async function destinationIdentity(directory: string): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes('\0'))
    throw new Error('Choose a normalized absolute destination.')
  await lstat(directory).then(
    () => {
      throw new Error('Destination already exists; no existing directory is changed.')
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  let parent = dirname(directory)
  const identities = []
  while (true) {
    identities.push([parent, await directoryIdentity(parent)])
    if (dirname(parent) === parent) break
    parent = dirname(parent)
  }
  return JSON.stringify(identities)
}
async function ancestor(root: string, first: string, second: string): Promise<boolean> {
  return runGit(root, ['merge-base', '--is-ancestor', first, second]).then(
    () => true,
    (error) => {
      if (isExitCode(error, 1)) return false
      throw error
    },
  )
}
async function activeJournal(tree: string): Promise<boolean> {
  for (const name of [
    'git-stacks-stack.json',
    'git-stacks-expected-operation-head.json',
    'git-stacks-publish.json',
  ]) {
    const value = await readFile(join(tree, name), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      value !== null &&
      (name !== 'git-stacks-publish.json' || JSON.parse(value).status !== 'completed')
    )
      return true
  }
  return false
}
async function inspectPlan(
  root: string,
  request: WorktreeLifecycleRequest,
): Promise<{
  preview: WorktreeLifecyclePreview
  signature: string
  identities: Map<string, string>
}> {
  const repository = await discoverWorktrees(root)
  if (
    repository.identity.id !== request.repositoryId ||
    repository.discovery.state !== 'complete' ||
    repository.refsRead.state !== 'complete'
  )
    throw new Error('Cannot prove the full local repository/worktree/ref domain.')
  const preview: WorktreeLifecyclePreview = {
    token: randomUUID(),
    repositoryId: request.repositoryId,
    kind: request.kind,
    targets: [],
    blockers: [],
    coordination:
      'Coordinate external tools before execution. Their activity is unknown; app locks and administrative worktree locks are not an external-agent mutex.',
  }
  const unresolved = await unresolvedOperationRecords(root)
  const commonIdentity = await directoryIdentity(repository.identity.commonDirectory)
  const facts: unknown[] = [
    repository.identity,
    repository.refs,
    repository.worktrees.map((tree) => ({
      id: tree.id,
      path: tree.path,
      head: tree.headOid,
      ref: tree.refId,
      locked: tree.locked,
      missing: tree.missing,
    })),
  ]
  const identities = new Map<string, string>()
  if (request.kind === 'create') {
    const ref = repository.refs.find((ref) => ref.id === request.sourceRefId)
    if (!ref) throw new Error('The qualified source ref is unavailable.')
    const blockers: string[] = []
    if (request.newBranch !== undefined) {
      await validateBranchName(root, request.newBranch)
      if (repository.refs.some((ref) => ref.name === `refs/heads/${request.newBranch}`))
        blockers.push('The new branch already exists.')
    } else {
      if (ref.kind !== 'local')
        blockers.push(
          'Existing worktree creation requires a local branch; name a new branch from this explicit base instead.',
        )
      if (repository.worktrees.some((tree) => tree.refId === ref.id))
        blockers.push('This branch is already checked out in a worktree.')
    }
    facts.push(await destinationIdentity(request.directory))
    preview.targets.push({
      worktreeId: null,
      path: request.directory,
      ref: request.newBranch ? `refs/heads/${request.newBranch}` : ref.name,
      oid: ref.oid,
      authority: {
        commonDirectory: repository.identity.commonDirectory,
        commonIdentity,
        directoryIdentity: null,
        gitDirectory: null,
        gitDirectoryIdentity: null,
      },
      blockers,
      effect: request.newBranch
        ? `Create a new directory and branch from ${ref.name} at ${ref.oid}; existing directories remain unchanged.`
        : 'Create a new directory for this existing branch; no existing checkout changes.',
    })
  } else {
    if (
      !request.worktreeIds.length ||
      new Set(request.worktreeIds).size !== request.worktreeIds.length
    )
      throw new Error('Choose the exact nonempty worktree subset without duplicates.')
    // origin/HEAD is recorded repository authority; display fallbacks and
    // init.defaultBranch are not proof that a tip landed in this repository.
    const landingRef = (await tryGit(root, ['symbolic-ref', 'refs/remotes/origin/HEAD']))?.trim()
    const base = landingRef?.startsWith('refs/remotes/origin/')
      ? repository.refs.find((ref) => ref.kind === 'remote' && ref.name === landingRef)
      : undefined
    facts.push({ landingRef: landingRef ?? null, landingOid: base?.oid ?? null })
    for (const id of request.worktreeIds) {
      const found = repository.worktrees.find((tree) => tree.id === id)
      if (!found) throw new Error('A selected worktree disappeared; the batch is not trimmed.')
      const blockers: string[] = []
      const tree = await inspectWorktree(found)
      const physicalIdentity = tree.missing ? null : await directoryIdentity(tree.path)
      const administrativeIdentity = tree.gitDirectory
        ? await directoryIdentity(tree.gitDirectory)
        : null
      if (tree.kind !== 'linked')
        blockers.push('Primary and bare repositories cannot be cleaned up.')
      if (tree.missing)
        blockers.push('The directory is missing; file deletion authority cannot be established.')
      if (tree.locked) blockers.push(`Administrative worktree lock: ${tree.locked}`)
      if (tree.detached || !tree.refId || !tree.headOid)
        blockers.push('Detached or unborn worktree has no qualified branch tip.')
      if (tree.read.state !== 'complete')
        blockers.push(tree.read.error ?? 'Worktree facts are incomplete.')
      if (tree.status !== 'clean')
        blockers.push('Dirty, untracked, conflicted or unknown local contents are excluded.')
      const protectedContents =
        !tree.missing && tree.read.state === 'complete'
          ? await runGit(tree.path, [
              '--no-optional-locks',
              'status',
              '--porcelain=v2',
              '-z',
              '--ignored=matching',
              '--untracked-files=all',
            ])
          : null
      if (protectedContents?.split('\0').some((entry) => entry.startsWith('! ')))
        blockers.push(
          'Ignored local contents are unpublished data; Git worktree remove would delete them even without force.',
        )
      facts.push(protectedContents)
      const indexFlags = tree.missing
        ? null
        : await runGit(tree.path, ['--no-optional-locks', 'ls-files', '-v', '-z'])
      facts.push(indexFlags)
      for (const entry of indexFlags?.split('\0') ?? []) {
        if (!entry) continue
        if (/^[a-z] /.test(entry)) {
          blockers.push(
            'Assume-unchanged index entries cannot prove tracked contents safe for deletion.',
          )
          break
        }
        if (entry.startsWith('S ')) {
          const materialized = await lstat(join(tree.path, entry.slice(2))).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false
              throw error
            },
          )
          if (materialized) {
            blockers.push('Materialized skip-worktree contents cannot be safely deleted.')
            break
          }
        }
      }
      if (tree.operation || (tree.gitDirectory && (await activeJournal(tree.gitDirectory))))
        blockers.push('Active or interrupted Git/app operation requires separate recovery.')
      for (const record of unresolved) {
        if (
          record.capture.commonIdentity !== commonIdentity ||
          record.capture.commonDirectory !== repository.identity.commonDirectory
        )
          continue
        if (
          record.context.worktreeId === tree.id &&
          record.worktreePath === tree.path &&
          record.capture.gitDirectory === tree.gitDirectory &&
          !tree.missing &&
          record.capture.directoryIdentity === physicalIdentity &&
          record.capture.gitDirectoryIdentity === administrativeIdentity
        )
          blockers.push(
            `Unresolved ${record.action.type} operation ${record.id} retains this owner for independent recovery.`,
          )
        if (record.action.type !== 'executeWorktreeLifecycle') continue
        const original = record.preview
        if (
          !isRecord(original) ||
          (original.kind !== 'create' && original.kind !== 'remove') ||
          original.repositoryId !== record.repositoryId ||
          !Array.isArray(original.targets)
        )
          throw new Error(`Original lifecycle target authority is unreadable for ${record.id}.`)
        for (const target of original.targets) {
          if (
            !isRecord(target) ||
            typeof target.path !== 'string' ||
            !target.path ||
            (original.kind === 'remove' &&
              (typeof target.worktreeId !== 'string' || !target.worktreeId))
          )
            throw new Error(`Original lifecycle target scope is unreadable for ${record.id}.`)
          if (target.path !== tree.path && target.worktreeId !== tree.id) continue
          const outcome = record.result?.worktreeLifecycle?.targets.find(
            (effect) => effect.path === target.path,
          )
          // Confirmed effects and proven no-dispatch peers are not replay
          // hazards merely because another target left this batch uncertain.
          if (outcome && ['completed', 'not-run', 'failed'].includes(outcome.state)) continue
          const authority = target.authority
          if (
            !isRecord(authority) ||
            typeof authority.commonDirectory !== 'string' ||
            !authority.commonDirectory ||
            authority.commonDirectory !== record.capture.commonDirectory ||
            typeof authority.commonIdentity !== 'string' ||
            !authority.commonIdentity ||
            authority.commonIdentity !== record.capture.commonIdentity ||
            typeof authority.directoryIdentity !== 'string' ||
            !authority.directoryIdentity ||
            typeof authority.gitDirectory !== 'string' ||
            !authority.gitDirectory ||
            typeof authority.gitDirectoryIdentity !== 'string' ||
            !authority.gitDirectoryIdentity
          ) {
            blockers.push(
              `Unconfirmed lifecycle target ${record.id} has unknown original physical authority; independent recovery is required.`,
            )
            continue
          }
          if (
            authority.commonDirectory === repository.identity.commonDirectory &&
            authority.commonIdentity === commonIdentity &&
            authority.directoryIdentity === physicalIdentity &&
            authority.gitDirectory === tree.gitDirectory &&
            authority.gitDirectoryIdentity === administrativeIdentity
          )
            blockers.push(
              `Unconfirmed lifecycle operation ${record.id} retains this exact target incarnation for independent recovery.`,
            )
        }
      }
      const ref = repository.refs.find((ref) => ref.id === tree.refId)
      if (!base || !tree.headOid || !(await ancestor(root, tree.headOid, base.oid)))
        blockers.push('This captured tip is not proven merged into the default branch.')
      if (!ref?.upstream)
        blockers.push(
          'Published tip is unknown; a clean worktree does not prove no unpublished work.',
        )
      else {
        const upstream = repository.refs.find((item) => item.id === ref.upstream)
        if (!upstream || !tree.headOid || !(await ancestor(root, tree.headOid, upstream.oid)))
          blockers.push('Unpublished work or unknown upstream tip is excluded.')
      }
      facts.push(
        {
          id: tree.id,
          path: tree.path,
          ref: tree.refId,
          oid: tree.headOid,
          status: tree.status,
          counts: tree.counts,
          operation: tree.operation,
          index: tree.indexSignature,
        },
        physicalIdentity,
        tree.gitDirectory ? await activeJournal(tree.gitDirectory) : null,
      )
      if (!tree.missing && tree.gitDirectory)
        identities.set(
          tree.id,
          JSON.stringify([physicalIdentity, administrativeIdentity, tree.indexSignature]),
        )
      preview.targets.push({
        worktreeId: tree.id,
        path: tree.path,
        ref: ref?.name ?? null,
        oid: tree.headOid,
        authority: {
          commonDirectory: repository.identity.commonDirectory,
          commonIdentity,
          directoryIdentity: physicalIdentity,
          gitDirectory: tree.gitDirectory,
          gitDirectoryIdentity: administrativeIdentity,
        },
        blockers,
        effect:
          'Remove only this linked directory with Git worktree remove, without force; retain its branch, pull request and other worktrees.',
      })
    }
  }
  preview.blockers = preview.targets.flatMap((target) =>
    target.blockers.map((reason) => `${target.path}: ${reason}`),
  )
  return {
    preview,
    signature: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
    identities,
  }
}

export async function previewWorktreeLifecycle(
  root: string,
  value: unknown,
): Promise<WorktreeLifecyclePreview> {
  for (const [token, plan] of plans) if (plan.expires < Date.now()) plans.delete(token)
  if (!value || typeof value !== 'object') throw new Error('A typed lifecycle request is required.')
  const request = value as WorktreeLifecycleRequest
  if (
    typeof request.repositoryId !== 'string' ||
    (request.kind !== 'create' && request.kind !== 'remove')
  )
    throw new Error('Invalid lifecycle scope.')
  if (
    request.kind === 'create' &&
    (typeof request.sourceRefId !== 'string' ||
      typeof request.directory !== 'string' ||
      (request.newBranch !== undefined && typeof request.newBranch !== 'string'))
  )
    throw new Error('Invalid worktree creation inputs.')
  if (
    request.kind === 'remove' &&
    (!Array.isArray(request.worktreeIds) ||
      request.worktreeIds.some((id) => typeof id !== 'string'))
  )
    throw new Error('Invalid selected worktree subset.')
  const { preview, signature, identities } = await inspectPlan(root, request)
  plans.set(preview.token, {
    root,
    request: structuredClone(request),
    preview,
    signature,
    identities,
    expires: Date.now() + 5 * 60_000,
  })
  return preview
}

/** Read-only validation of the immutable original directory plan. */
export async function validateWorktreeLifecyclePreview(root: string, token: string): Promise<void> {
  const plan = plans.get(token)
  if (!plan || plan.root !== root || plan.expires < Date.now())
    throw new Error('The original lifecycle preview expired or is unavailable.')
  const current = await inspectPlan(root, plan.request)
  if (current.signature !== plan.signature || current.preview.blockers.length)
    throw new Error(
      'Original directory contents, landing proof, refs, parent or recovery ownership changed.',
    )
}

export async function executeWorktreeLifecycle(
  root: string,
  token: string,
  coordinated: boolean,
  onProgress?: (result: WorktreeLifecycleResult) => Promise<void>,
): Promise<WorktreeLifecycleResult> {
  const plan = plans.get(token)
  if (!plan || plan.root !== root || plan.expires < Date.now())
    throw new Error('Lifecycle preview expired or belongs to another execution directory.')
  plans.delete(token)
  if (coordinated !== true)
    throw new Error(
      'Explicit external-tool coordination confirmation is required; it does not establish exclusive access.',
    )
  const fresh = await inspectPlan(root, plan.request)
  if (fresh.signature !== plan.signature || fresh.preview.blockers.length)
    throw new Error(
      'Lifecycle preview is stale or blocked; the entire selected batch was refused before any deletion.',
    )
  await recordOperationPreview(plan.preview)
  const result: WorktreeLifecycleResult = {
    kind: plan.request.kind,
    createdWorktreeId: null,
    targets: plan.preview.targets.map((target) => ({
      path: target.path,
      state: 'not-run',
      detail: 'Not dispatched.',
    })),
    message: 'Reviewed directory operation admitted; no rollback is promised.',
  }
  await onProgress?.(result)
  if (plan.request.kind === 'create') {
    const target = plan.preview.targets[0]
    const effect = result.targets[0]
    effect.state = 'unconfirmed'
    effect.detail =
      'Git creation is being dispatched; inspect actual directory and branch after interruption, never replay automatically.'
    await onProgress?.(result)
    let gitCompleted = false
    try {
      // Existing branch names are passed only after qualification. New branches use the captured base OID.
      // Git accepts an existing empty directory; claim an absent destination
      const beforeClaim = await inspectPlan(root, plan.request)
      if (beforeClaim.signature !== plan.signature || beforeClaim.preview.blockers.length)
        throw new Error('Creation target or parent authority changed; no directory was claimed.')
      // ourselves rather than treating a raced-in external directory as ours.
      await validateOperationEffect()
      await mkdir(target.path)
      const claimed = await directoryIdentity(target.path)
      await operationEffectGuard.run(
        async () => {
          if ((await directoryIdentity(target.path)) !== claimed)
            throw new Error('The claimed creation directory was replaced before Git dispatch.')
          if (plan.request.kind === 'create' && !plan.request.newBranch) {
            const live = await discoverWorktrees(root)
            const ref = live.refs.find((ref) => ref.name === target.ref)
            if (ref?.oid !== target.oid || live.worktrees.some((tree) => tree.refId === ref.id))
              throw new Error(
                'The existing branch tip or checkout ownership changed before creation.',
              )
          }
        },
        () =>
          runGit(
            root,
            plan.request.kind === 'create' && plan.request.newBranch
              ? ['worktree', 'add', '-b', plan.request.newBranch, '--', target.path, target.oid!]
              : ['worktree', 'add', '--', target.path, target.ref!.slice('refs/heads/'.length)],
          ),
      )
      gitCompleted = true
      const observed = await discoverWorktrees(root)
      if ((await directoryIdentity(target.path)) !== claimed)
        throw new Error(
          'The created directory was replaced before confirmation; no registration is authorized.',
        )
      const tree = observed.worktrees.find(
        (tree) => tree.path === target.path && !tree.missing && tree.headOid === target.oid,
      )
      if (!tree || (await realpath(target.path)) !== target.path)
        throw new Error(
          'Creation could not be confirmed; inspect actual directory and refs before recovery.',
        )
      result.createdWorktreeId = tree.id
      effect.state = 'completed'
      effect.detail = 'Git creation confirmed; directory can now be adopted separately.'
    } catch (error) {
      effect.state =
        gitCompleted || (error instanceof Error && 'gitDispatched' in error && error.gitDispatched)
          ? 'unconfirmed'
          : 'failed'
      effect.detail = `${error instanceof Error ? error.message : String(error)} Partial directory or branch creation may remain; no rollback or registration is claimed.`
    } finally {
      await onProgress?.(result)
    }
  } else {
    const removal = plan.request
    for (const [index, target] of plan.preview.targets.entries()) {
      const effect = result.targets[index]
      if (result.targets.some((item) => item.state === 'failed' || item.state === 'unconfirmed')) {
        effect.detail =
          'Stopped after the first failure or uncertain dispatch; inspect partial effects without replay.'
        continue
      }
      try {
        const live = await inspectPlan(root, { ...plan.request, worktreeIds: [target.worktreeId!] })
        if (live.preview.blockers.length) throw new Error(live.preview.blockers.join('\n'))
        if (live.identities.get(target.worktreeId!) !== plan.identities.get(target.worktreeId!))
          throw new Error(
            'The selected directory, administration or index incarnation changed; this directory was not removed.',
          )
        const current = live.preview.targets[0]
        if (
          current.path !== target.path ||
          current.ref !== target.ref ||
          current.oid !== target.oid
        )
          throw new Error('The exact selected directory or branch tip changed.')
        effect.state = 'unconfirmed'
        effect.detail =
          'Git removal is being dispatched; inspect the exact directory after interruption before any new request.'
        await onProgress?.(result)
        const final = await inspectPlan(root, {
          ...plan.request,
          worktreeIds: [target.worktreeId!],
        })
        if (
          final.preview.blockers.length ||
          final.identities.get(target.worktreeId!) !== plan.identities.get(target.worktreeId!) ||
          final.preview.targets[0].oid !== target.oid ||
          final.preview.targets[0].path !== target.path ||
          final.preview.targets[0].ref !== target.ref
        )
          throw new Error(
            'Removal authority changed after recording intent; no removal was dispatched.',
          )
        await operationEffectGuard.run(
          async () => {
            const dispatch = await inspectPlan(root, {
              ...removal,
              worktreeIds: [target.worktreeId!],
            })
            if (
              dispatch.preview.blockers.length ||
              dispatch.identities.get(target.worktreeId!) !==
                plan.identities.get(target.worktreeId!) ||
              dispatch.preview.targets[0].oid !== target.oid ||
              dispatch.preview.targets[0].ref !== target.ref ||
              dispatch.preview.targets[0].path !== target.path
            )
              throw new Error('The exact removal target changed at dispatch; nothing was removed.')
          },
          () => runGit(root, ['worktree', 'remove', '--', target.path]),
        )
        effect.state = 'completed'
        effect.detail = 'Directory removed by Git; branch and PR retained.'
      } catch (error) {
        effect.state =
          error instanceof Error && 'gitDispatched' in error && error.gitDispatched
            ? 'unconfirmed'
            : 'failed'
        effect.detail = error instanceof Error ? error.message : String(error)
      } finally {
        await onProgress?.(result)
      }
    }
  }
  result.message = `${result.targets.filter((target) => target.state === 'completed').length} completed; ${result.targets.filter((target) => target.state === 'unconfirmed').length} unconfirmed; ${result.targets.filter((target) => target.state === 'failed').length} failed; ${result.targets.filter((target) => target.state === 'not-run').length} not run. Branches and pull requests are retained.`
  return result
}
