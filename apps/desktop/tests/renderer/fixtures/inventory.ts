import type { RepositorySnapshot } from '@git-stacks/shared/types'
import type { WorktreeInventory, InventoryRead } from '@git-stacks/shared/worktree-inventory'
import { openPullRequest } from '../../fixtures/workflow-scenarios'

const observedAt = '2026-09-25T12:00:00.000Z'
const complete: InventoryRead = { state: 'complete', observedAt, error: null }
export const inventoryLocalId = JSON.stringify(['local', 'fixture-dev:ino:birthtimeNs'])
export const inventoryWorktreeId = (index: number) =>
  JSON.stringify([
    inventoryLocalId,
    'worktree',
    index === 0 ? 'fixture-dev:ino:birthtimeNs' : `admin-${index}`,
  ])
const refId = (name: string) => JSON.stringify([inventoryLocalId, 'ref', name])
const remoteId = JSON.stringify(['remote', 'github.com', 'fixture/inventory'])
const prId = (number: number) => JSON.stringify([remoteId, 'pr', String(number)])

/** Deferred transport data, not simulated Git operations or native IPC evidence. */
export function inventoryFixture(
  generation = 1,
  mode: 'complete' | 'partial' | 'failed' | 'offline' | 'retired' = 'complete',
  size = 3,
): WorktreeInventory {
  const partial = mode === 'partial'
  const failed = mode === 'failed'
  const retired = mode === 'retired'
  const read: InventoryRead = failed
    ? { state: 'failed', observedAt: null, error: 'Discovery unavailable' }
    : partial
      ? { state: 'partial', observedAt, error: 'Bounded discovery' }
      : complete
  return {
    generation,
    state: read.state,
    failures: failed ? [{ path: '/fixture/inventory', error: 'Discovery unavailable' }] : [],
    repositories: failed
      ? []
      : [
          {
            identity: { id: inventoryLocalId, commonDirectory: '/fixture/inventory/.git' },
            registeredPaths: ['/fixture/inventory'],
            remote: { id: remoteId, host: 'github.com', fullName: 'fixture/inventory' },
            discovery: read,
            refsRead: complete,
            remoteFreshness: {
              state: retired ? 'unauthorized' : mode === 'offline' ? 'offline' : 'fresh',
              fetchedAt: retired ? null : observedAt,
              checkedAt: observedAt,
              detail: retired
                ? 'Credential generation retired; previous-account metadata removed'
                : mode === 'offline'
                  ? 'Host unreachable; local discovery remains available'
                  : null,
              rateLimitReset: null,
              pendingMutations: [],
            },
            worktrees: Array.from({ length: size }, (_, index) => ({
              id: inventoryWorktreeId(index),
              repositoryId: inventoryLocalId,
              path: index === 0 ? '/fixture/inventory' : `/fixture/worktrees/topic ${index} 雪`,
              gitDirectory:
                index === 0
                  ? '/fixture/inventory/.git'
                  : `/fixture/inventory/.git/worktrees/admin-${index}`,
              kind: index === 0 ? ('primary' as const) : ('linked' as const),
              headOid: 'a'.repeat(40),
              refId: refId('refs/heads/topic'),
              detached: false,
              missing: false,
              prunable: null,
              locked: index === 2 ? 'Administrative lock, not process liveness' : null,
              status:
                index === 2 || (index === 1 && partial)
                  ? ('unknown' as const)
                  : index === 1
                    ? ('dirty' as const)
                    : ('clean' as const),
              counts:
                index === 2
                  ? null
                  : { staged: index, unstaged: index, untracked: 0, renamed: 0, conflicted: 0 },
              operation: null,
              indexSignature: index === 2 ? null : `index-${index}`,
              read:
                index === 2
                  ? { state: 'failed' as const, observedAt: null, error: 'Index unreadable' }
                  : index === 1 && partial
                    ? { state: 'partial' as const, observedAt, error: 'Counts truncated' }
                    : complete,
            })),
            refs: [
              {
                id: refId('refs/heads/topic'),
                repositoryId: inventoryLocalId,
                name: 'refs/heads/topic',
                kind: 'local',
                oid: 'a'.repeat(40),
                upstream: refId('refs/remotes/origin/topic'),
                ahead: 2,
                behind: 1,
                worktreeIds: Array.from({ length: size }, (_, index) => inventoryWorktreeId(index)),
                pullRequestIds: retired ? [] : [prId(41)],
              },
              {
                id: refId('refs/heads/local-only'),
                repositoryId: inventoryLocalId,
                name: 'refs/heads/local-only',
                kind: 'local',
                oid: 'b'.repeat(40),
                upstream: null,
                ahead: null,
                behind: null,
                worktreeIds: [],
                pullRequestIds: [],
              },
              {
                id: refId('refs/remotes/origin/topic'),
                repositoryId: inventoryLocalId,
                name: 'refs/remotes/origin/topic',
                kind: 'remote',
                remoteName: 'origin',
                remoteId,
                oid: 'c'.repeat(40),
                upstream: null,
                ahead: null,
                behind: null,
                worktreeIds: [],
                pullRequestIds: retired ? [] : [prId(41)],
              },
            ],
            pullRequests: retired
              ? []
              : [41, 42].map((number) => ({
                  id: prId(number),
                  remoteId,
                  number,
                  headRef: number === 41 ? 'topic' : 'pr-only',
                  headOid: 'c'.repeat(40),
                  refIds:
                    number === 41
                      ? [refId('refs/heads/topic'), refId('refs/remotes/origin/topic')]
                      : [],
                  facts: {
                    ...openPullRequest,
                    number,
                    title:
                      number === 41 ? 'Previous account topic metadata' : 'PR without local branch',
                    head: number === 41 ? 'topic' : 'pr-only',
                    headOid: 'c'.repeat(40),
                    headRepository: 'fixture/inventory',
                  },
                })),
          },
        ],
  }
}

/** Scenario-to-inventory transport fixture: each local clone retains its own identity. */
export function snapshotInventory(snapshots: readonly RepositorySnapshot[]): WorktreeInventory {
  return {
    generation: 1,
    state: 'complete',
    failures: [],
    repositories: snapshots.map((snapshot) => {
      const id = JSON.stringify(['fixture-local', snapshot.path])
      const worktreeId = JSON.stringify([id, 'worktree', snapshot.path])
      const remoteId = JSON.stringify(['fixture-remote', snapshot.remoteUrl])
      const fullName =
        snapshot.remoteUrl?.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '') ??
        'fixture/local'
      const refId = (ref: string) => JSON.stringify([id, 'ref', ref])
      const prId = (number: number) => JSON.stringify([remoteId, 'pr', String(number)])
      return {
        identity: { id, commonDirectory: `${snapshot.path}/.git` },
        registeredPaths: [snapshot.path],
        remote: snapshot.remoteUrl ? { id: remoteId, host: 'github.com', fullName } : null,
        discovery: complete,
        refsRead: complete,
        remoteFreshness: snapshot.remote ?? null,
        refs: snapshot.branches.map((branch) => ({
          id: refId(branch.ref),
          repositoryId: id,
          name: branch.ref,
          kind: branch.remote ? ('remote' as const) : ('local' as const),
          oid: branch.oid ?? 'a'.repeat(40),
          upstream: branch.upstreamRef ? refId(branch.upstreamRef) : null,
          ahead: branch.ahead,
          behind: branch.behind,
          worktreeIds: branch.current || branch.name === snapshot.currentBranch ? [worktreeId] : [],
          pullRequestIds: branch.pr ? [prId(branch.pr.number)] : [],
        })),
        worktrees: [
          {
            id: worktreeId,
            repositoryId: id,
            path: snapshot.path,
            gitDirectory: `${snapshot.path}/.git`,
            kind: 'primary' as const,
            headOid: snapshot.headOid,
            refId: snapshot.currentBranch ? refId(`refs/heads/${snapshot.currentBranch}`) : null,
            detached: !snapshot.currentBranch,
            missing: false,
            prunable: null,
            locked: null,
            status: snapshot.files.some((file) => file.conflicted)
              ? ('conflicted' as const)
              : snapshot.files.length
                ? ('dirty' as const)
                : ('clean' as const),
            counts: {
              staged: snapshot.files.filter((file) => file.index !== ' ' && file.index !== '?')
                .length,
              unstaged: snapshot.files.filter(
                (file) => file.worktree !== ' ' && file.worktree !== '?',
              ).length,
              untracked: snapshot.files.filter((file) => file.index === '?').length,
              renamed: snapshot.files.filter((file) => file.originalPath).length,
              conflicted: snapshot.files.filter((file) => file.conflicted).length,
            },
            operation: snapshot.operation,
            indexSignature: JSON.stringify(snapshot.files),
            read: complete,
          },
        ],
        pullRequests: snapshot.pullRequests.map((pr) => ({
          id: prId(pr.number),
          remoteId,
          number: pr.number,
          headRef: pr.head,
          headOid: pr.headOid ?? null,
          refIds: snapshot.branches
            .filter((branch) => branch.pr?.number === pr.number)
            .map((branch) => refId(branch.ref)),
          facts: pr,
        })),
      }
    }),
  }
}
