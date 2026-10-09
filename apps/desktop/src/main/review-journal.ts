import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { runGit, stripTrailingNewline } from './git-core'
import { isRecord } from '@git-stacks/shared/guards'

/**
 * The journals main keeps beside a repository: the files a person read, the
 * heads they observed, the drafts they have not sent, and the writes whose
 * outcome is unknown.
 *
 * All of them live beside the repository's own Git directory rather than in
 * application data, and all of them live in the common directory every linked
 * worktree shares: each describes this repository rather than one workspace, so
 * it follows the repository across workspaces, and it must never be mistakable
 * for repository content or for something GitHub holds.
 */
export async function repositoryJournalPath(
  repoPath: string,
  fileName: string,
  signal?: AbortSignal,
): Promise<string> {
  const common = stripTrailingNewline(
    await runGit(repoPath, ['rev-parse', '--git-common-dir'], undefined, signal),
  )
  return path.resolve(repoPath, common, fileName)
}

/**
 * Reads a journal's entries, or none at all.
 *
 * Anything unreadable, unparsable, or written by another version of this format
 * reads as no entries rather than as an error: a journal holds what this build
 * can reconstruct, and a corrupt or foreign file must not stop a person
 * reviewing. Entries that do not parse are dropped one by one, so one record in
 * an unexpected shape cannot hide the rest.
 */
export async function readJournal<T>(
  file: string,
  field: 'records' | 'writes',
  parse: (value: unknown) => T | null,
): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed[field])) return []
    return parsed[field].map((entry) => parse(entry)).filter((entry): entry is T => entry !== null)
  } catch {
    return []
  }
}

/**
 * Publishes a whole journal at once, so a reader sees either every entry or
 * none of them and never a half-written one.
 *
 * The new file is written under a name of its own, synced to disk, and only
 * then renamed over the journal — a rename within one filesystem is a directory
 * entry update, not a copy, so no reader can observe a partial file. It is
 * created owner-only: these journals hold unsent review words and signed-in
 * identities.
 */
export async function writeJournal(
  file: string,
  field: 'records' | 'writes',
  entries: readonly unknown[],
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, [field]: entries }, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
}
