import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type {
  RefStorageFormat,
  RepositoryCapabilities,
  RepositoryShapeFacts,
} from '../shared/capabilities'
import type { LfsPointer } from '../shared/types'
import {
  execute,
  getConfigValue,
  getOperationState,
  runGit,
  stripTrailingNewline,
  tryGit,
} from './git-core'

const LFS_POINTER_VERSION = 'version https://git-lfs.github.com/spec/v1'
const TRUTHY = /^(true|yes|on|1)$/iu

/** A pointer is only trusted when it carries the full oid and size triple. */
export function parseLfsPointer(content: string): LfsPointer | null {
  if (!content.startsWith(LFS_POINTER_VERSION)) return null
  const oid = /\noid sha256:([0-9a-f]{64})\n/u.exec(content)?.[1]
  const size = /\nsize (\d+)\n/u.exec(content)?.[1]
  return oid && size ? { oid, size: Number(size) } : null
}

export interface IndexPathEntry {
  submodule: boolean
  sparseExcluded: boolean
  /** Index-only identity; submodule and sparse paths have no readable worktree file. */
  fingerprint: string
}

export function parseIndexEntries(output: string): Map<string, IndexPathEntry> {
  const entries = new Map<string, IndexPathEntry>()
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const [tag, mode] = record.slice(0, tab).split(' ')
    const filePath = record.slice(tab + 1)
    if (!filePath || !mode) continue
    entries.set(filePath, {
      submodule: mode === '160000',
      sparseExcluded: tag === 'S' || tag === 's',
      fingerprint: createHash('sha256').update(record).digest('hex'),
    })
  }
  return entries
}

export async function getIndexEntries(
  repoPath: string,
  paths: readonly string[],
): Promise<Map<string, IndexPathEntry>> {
  if (paths.length === 0) return new Map()
  const output = await runGit(repoPath, [
    '--literal-pathspecs',
    'ls-files',
    '-v',
    '--stage',
    '-z',
    '--',
    ...paths,
  ])
  return parseIndexEntries(output)
}

function classifyRefStorage(value: string | null): RefStorageFormat {
  const normalized = value?.trim().toLowerCase() ?? ''
  if (!normalized || normalized === 'files' || normalized.startsWith('files:')) return 'files'
  return normalized === 'reftable' ? 'reftable' : 'other'
}

/**
 * Older Git may echo an unknown --show-ref-format option with exit status zero.
 * Only an actual format response overrides the configured backend.
 */
async function detectRefStorage(
  repoPath: string,
): Promise<{ format: RefStorageFormat; detail: string | null }> {
  const reported = (await tryGit(repoPath, ['rev-parse', '--show-ref-format']))?.trim()
  const configured = (await getConfigValue(repoPath, 'extensions.refstorage'))?.trim() ?? null
  const value = reported === '--show-ref-format' ? configured : reported || configured
  const format = classifyRefStorage(value)
  return { format, detail: format === 'files' ? null : value || null }
}

async function worktreeInventory(repoPath: string): Promise<{ linked: boolean; count: number }> {
  const [gitDir, commonDir, listing] = await Promise.all([
    runGit(repoPath, ['rev-parse', '--git-dir']).then(stripTrailingNewline),
    runGit(repoPath, ['rev-parse', '--git-common-dir']).then(stripTrailingNewline),
    runGit(repoPath, ['worktree', 'list', '--porcelain']),
  ])
  const from = (value: string) => (path.isAbsolute(value) ? value : path.resolve(repoPath, value))
  return {
    linked: from(gitDir) !== from(commonDir),
    count: listing.split(/\r?\n/u).filter((line) => line.startsWith('worktree ')).length,
  }
}

/**
 * Whether this repository routes content through Git LFS: a repository-local
 * filter driver, or a tracked `.gitattributes` that assigns the `lfs` filter.
 * A machine-wide driver alone says nothing about the open repository.
 */
export async function detectGitLfs(repoPath: string): Promise<boolean> {
  if (
    (await tryGit(repoPath, ['config', '--local', '--get-regexp', '^filter\\.lfs\\.'])) !== null
  ) {
    return true
  }
  return (
    (await tryGit(repoPath, [
      'grep',
      '--cached',
      '-l',
      '-z',
      '-e',
      'filter=lfs',
      '--',
      '*.gitattributes',
    ])) !== null
  )
}

/** Mutation gates must not read ref storage or configuration before action-specific preflight. */
export async function getRepositoryShapeFacts(repoPath: string): Promise<RepositoryShapeFacts> {
  const [isBare, head, operation] = await Promise.all([
    runGit(repoPath, ['rev-parse', '--is-bare-repository']).then(stripTrailingNewline),
    tryGit(repoPath, ['symbolic-ref', '--quiet', 'HEAD']),
    getOperationState(repoPath),
  ])
  return {
    bare: isBare.trim() === 'true',
    // Rebase, merge, and cherry-pick detach HEAD on purpose: recovery must remain available.
    detachedHead: head === null && !operation.busy,
  }
}

export async function getRepositoryCapabilities(repoPath: string): Promise<RepositoryCapabilities> {
  const [
    shape,
    storage,
    worktrees,
    sparse,
    cone,
    submoduleConfig,
    gitLfs,
    worktreeConfig,
    objectFormat,
    gitVersion,
  ] = await Promise.all([
    getRepositoryShapeFacts(repoPath),
    detectRefStorage(repoPath),
    worktreeInventory(repoPath),
    getConfigValue(repoPath, 'core.sparseCheckout'),
    getConfigValue(repoPath, 'core.sparseCheckoutCone'),
    tryGit(repoPath, ['ls-files', '-z', '--', ':(glob)**/.gitmodules']),
    detectGitLfs(repoPath),
    getConfigValue(repoPath, 'extensions.worktreeConfig'),
    tryGit(repoPath, ['rev-parse', '--show-object-format']),
    execute('git', ['--version'], repoPath),
  ])
  return {
    ...shape,
    linkedWorktree: worktrees.linked,
    worktreeCount: worktrees.count,
    refStorage: storage.format,
    refStorageDetail: storage.detail,
    sparseCheckout: sparse !== null && TRUTHY.test(sparse.trim()),
    sparseCheckoutCone: cone !== null && TRUTHY.test(cone.trim()),
    submodules: Boolean(submoduleConfig),
    gitLfs,
    worktreeConfig: worktreeConfig !== null,
    objectFormat: objectFormat?.trim() ?? null,
    gitVersion: stripTrailingNewline(gitVersion).trim(),
  }
}
