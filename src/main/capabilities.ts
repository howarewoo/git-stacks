import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type {
  RefStorageFormat,
  RepositoryCapabilities,
  RepositoryShapeFacts,
} from '../shared/capabilities'
import { MAX_STATUS_BYTES } from '../shared/performance'
import type { LfsPointer } from '../shared/types'
import {
  getConfigValue,
  getOperationState,
  runGit,
  runGitCapped,
  stripTrailingNewline,
  tryGit,
  tryGitCapped,
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
    const previous = entries.get(filePath)
    entries.set(filePath, {
      submodule: mode === '160000' || previous?.submodule === true,
      sparseExcluded: tag === 'S' || tag === 's' || previous?.sparseExcluded === true,
      fingerprint: createHash('sha256').update(record).digest('hex'),
    })
  }
  return entries
}

function* pathBatches(paths: readonly string[]): Generator<string[]> {
  let batch: string[] = []
  let bytes = 0
  for (const filePath of paths) {
    const size = Buffer.byteLength(filePath) + 1
    if (batch.length && (batch.length >= 1024 || bytes + size > 32_000)) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(filePath)
    bytes += size
  }
  if (batch.length) yield batch
}

/**
 * Whether the requested paths would need more than one pathspec process. One
 * batch is answered directly, so a caller that asks about a single path never
 * pays for a whole-repository read on a large repository.
 */
function needsWholeRepositoryRead(paths: readonly string[]): boolean {
  let batches = 0
  for (const _batch of pathBatches(paths)) {
    batches += 1
    if (batches > 1) return true
  }
  return false
}

/**
 * Reads the index classification for the given paths. Reading the whole index
 * once and filtering in memory costs a single process regardless of how many
 * paths are asked about, where one process per pathspec batch made a working
 * tree with a hundred thousand changed files fork ~100 processes to classify
 * paths that were mostly untracked. The batched pathspec read is still used
 * when it answers in one process, so a single-path caller on a large
 * repository does not read the whole index. `-v` keeps the sparse `S`/`s` tag
 * and `--stage` keeps every unmerged stage, so an unmerged gitlink is still
 * classified as a submodule.
 */
export async function getIndexEntries(
  repoPath: string,
  paths: readonly string[],
): Promise<Map<string, IndexPathEntry>> {
  const entries = new Map<string, IndexPathEntry>()
  if (paths.length === 0) return entries
  if (needsWholeRepositoryRead(paths)) {
    const { text, truncated } = await runGitCapped(repoPath, ['ls-files', '-v', '--stage', '-z'], {
      maxBytes: MAX_STATUS_BYTES,
      boundary: '\0',
    })
    const wanted = new Set(paths)
    for (const [filePath, entry] of parseIndexEntries(text)) {
      if (wanted.has(filePath)) entries.set(filePath, entry)
    }
    // A cap cut the index short. An unmerged path occupies one record per
    // stage, so a cut on a NUL boundary can leave the path that straddles it
    // half-read: `parseIndexEntries` then reports that path from the stages it
    // did see. Re-reading only the paths still missing would keep that partial
    // entry — a gitlink whose later stage says `160000` would be classified as
    // an ordinary file. So the fallback asks about every requested path again.
    // It is rare (it needs an index whose listing exceeds the cap) and it costs
    // the same batched reads this path used before.
    if (truncated) {
      for (const batch of pathBatches(paths)) {
        const output = await runGit(repoPath, [
          '--literal-pathspecs',
          'ls-files',
          '-v',
          '--stage',
          '-z',
          '--',
          ...batch,
        ])
        for (const [filePath, entry] of parseIndexEntries(output)) entries.set(filePath, entry)
      }
    }
    return entries
  }
  for (const batch of pathBatches(paths)) {
    const output = await runGit(repoPath, [
      '--literal-pathspecs',
      'ls-files',
      '-v',
      '--stage',
      '-z',
      '--',
      ...batch,
    ])
    for (const [filePath, entry] of parseIndexEntries(output)) entries.set(filePath, entry)
  }
  return entries
}

/**
 * Reads the HEAD gitlinks for the given paths. `ls-tree -d` recurses only into
 * directories, so the answer costs one process listing the tree's directories
 * and the gitlinks among them rather than every blob. A path that is still a
 * gitlink in `HEAD` but no longer in the index is the only one that needs this,
 * and it is reported as a `160000` commit entry beside its containing
 * directories.
 */
export async function getHeadGitlinks(
  repoPath: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const gitlinks = new Map<string, string>()
  if (paths.length === 0) return gitlinks
  if (needsWholeRepositoryRead(paths)) {
    // An unborn HEAD has no tree to read, and `tryGit` answers null for it.
    const head = await tryGitCapped(repoPath, ['ls-tree', '-r', '-d', '-z', 'HEAD'], {
      maxBytes: MAX_STATUS_BYTES,
      boundary: '\0',
    })
    if (head) {
      const wanted = new Set(paths)
      for (const record of head.text.split('\0')) {
        const tab = record.indexOf('\t')
        if (tab < 0 || !record.startsWith('160000 ')) continue
        const filePath = record.slice(tab + 1)
        if (wanted.has(filePath)) {
          gitlinks.set(filePath, createHash('sha256').update(record).digest('hex'))
        }
      }
    }
    // A cap cut the tree short, so the records that were never read can still
    // hold a gitlink. Resolve the rest by pathspec rather than reporting an
    // unread submodule as an ordinary file. An unborn HEAD is not a truncated
    // read: Git answered that the tree holds no gitlink at all.
    if (head?.truncated) {
      for (const batch of pathBatches(paths.filter((p) => !gitlinks.has(p)))) {
        const output = await tryGit(repoPath, [
          '--literal-pathspecs',
          'ls-tree',
          '-r',
          '-z',
          'HEAD',
          '--',
          ...batch,
        ])
        for (const record of (output ?? '').split('\0')) {
          const tab = record.indexOf('\t')
          if (tab < 0 || !record.startsWith('160000 ')) continue
          gitlinks.set(record.slice(tab + 1), createHash('sha256').update(record).digest('hex'))
        }
      }
    }
    return gitlinks
  }
  for (const batch of pathBatches(paths)) {
    const output = await tryGit(repoPath, [
      '--literal-pathspecs',
      'ls-tree',
      '-r',
      '-z',
      'HEAD',
      '--',
      ...batch,
    ])
    for (const record of (output ?? '').split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0 || !record.startsWith('160000 ')) continue
      gitlinks.set(record.slice(tab + 1), createHash('sha256').update(record).digest('hex'))
    }
  }
  return gitlinks
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
    runGit(repoPath, ['--version']),
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
