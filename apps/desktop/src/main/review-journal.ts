import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import { runGit, stripTrailingNewline, CommandCancelled } from './git-core'
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
 * Callers retaining authored text or deriving confirmed-review baselines use
 * strict mode: an unreadable journal is unknown, not a replaceable empty set.
 */
export async function readJournal<T>(
  file: string,
  field: 'records' | 'writes',
  parse: (value: unknown) => T | null,
  options: { strict?: boolean } = {},
): Promise<T[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed[field])) {
      if (options.strict) throw new Error('The review journal format cannot be read safely.')
      return []
    }
    const result: T[] = []
    for (const entry of parsed[field]) {
      const value = parse(entry)
      if (value === null) {
        if (options.strict) throw new Error('The review journal contains an unreadable record.')
      } else result.push(value)
    }
    return result
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
/**
 * Review journals are read, changed, and written back by every process that has
 * this repository open: two windows of one app, two worktrees, or two copies of
 * Git Stacks. A read/modify/write over a shared file is therefore a claim on
 * something no process owns on its own, and the window between the read and the
 * rename is wide enough for a second process to read the same bytes and publish
 * its own change over them. The result is not a merge: the last rename wins and
 * the other's record — unsent words, or a guard against a duplicate review —
 * is silently gone.
 *
 * The claim is a lock file beside the journal, created with `link(2)`, which is
 * atomic: exactly one process can create the name, and the winner owns it until
 * it removes it. Creating it with content already written means a process that
 * finds the lock never reads a half-written owner, so "is the holder still
 * alive?" is answerable. A lock is released only by removing the exact inode it
 * created, so a lock another process has since taken over is never taken away
 * from it.
 *
 * No lock is ever taken from its holder, not even one whose owner has been
 * killed: reclaiming a lock is a rename, and a rename that frees the name lets a
 * contender in while a holder that turns out to be alive still believes it owns
 * the journal. A lock whose holder is gone therefore blocks, and the refusal
 * names the one file a person may remove once they know no window is open. A
 * lock this process cannot read, or a wait that runs out, refuses the same
 * way: the honest outcome for a journal that cannot be updated in order is
 * that nothing was written, which the caller already reports.
 */
const JOURNAL_LOCK_POLL_MS = 20
const JOURNAL_LOCK_WAIT_MS = 15_000

interface JournalLockIdentity {
  dev: number
  ino: number
}

function cancelIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CommandCancelled()
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A process owned by another user reports EPERM rather than ESRCH: it is
    // running, this process just may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function waitFor(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Whether the process that wrote a lock is still running, and null when the
 * lock cannot be read as one this build wrote. A lock with no readable owner
 * has no owner to ask, so it is treated as a holder that might be alive.
 */
function lockHolderIsRunning(raw: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const pid = parsed.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    return processIsRunning(pid)
  } catch {
    return null
  }
}

/**
 * The refusal a writer gets when it cannot take the lock. It names the file and
 * the condition under which removing it is safe, because the one thing no
 * process on disk can know is whether a person still has a window open.
 */
function journalLockRefusal(lockPath: string, running: boolean | null): Error {
  const holder =
    running === null
      ? 'a lock this build did not write, whose owner cannot be identified'
      : running
        ? 'a window of this app that is still running'
        : 'a window of this app that is no longer running'
  return new Error(
    `This repository's review journal is locked at ${lockPath} by ${holder}. Nothing was written. ` +
      'A lock is only ever released by the process that took it, so it is never taken from its holder: ' +
      'freeing the name would let another process enter the journal while its holder still believes it ' +
      'owns it, which is the lost record this lock exists to prevent. Close every Git Stacks window for ' +
      'this repository, confirm none is open, and then remove that one file — the next write takes the ' +
      'lock itself.',
  )
}

/**
 * The refusal a writer gets when the lock exists and cannot be read: a file
 * this process may not open, or not one it can read bytes from.
 *
 * Nothing about it can be answered by waiting. The holder's identity is the
 * one thing the lock carries, and there is none of it here, so this is the
 * same unknown as a lock written by something else — except that the person
 * reading it can do something about it: a lock that cannot be opened is almost
 * always a permission, and saying so is what makes the refusal actionable
 * rather than a wall.
 */
function journalLockUnreadable(lockPath: string, cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  const reason =
    code === 'EACCES' || code === 'EPERM'
      ? 'this app is not allowed to read it'
      : code === 'EISDIR'
        ? 'it is a directory rather than a lock file'
        : `it could not be read (${code ?? 'no reason reported'})`
  return new Error(
    `This repository's review journal is locked at ${lockPath} and ${reason}, so its owner cannot be identified. Nothing was written. ` +
      'A lock is never taken from its holder, so the write stops here rather than writing beside a window that may still hold the journal. ' +
      'Close every Git Stacks window for this repository, confirm none is open, and then remove that one file — or make it readable ' +
      'to this account — and the next write takes the lock itself.',
  )
}

/**
 * Takes the journal lock, or refuses.
 *
 * The lock is created with `link(2)`, which is atomic: exactly one process can
 * create the name, and the winner owns it until it removes it. That is the whole
 * protocol, and it is deliberately the whole protocol. A lock is never taken
 * from its holder, because no pathname protocol can take one safely: removing
 * or renaming the name frees it, a contender can take it and be inside the
 * journal in the meantime, and nothing that happens afterwards can un-enter it.
 * An open descriptor pins the inode a lock was made from, which is what tells
 * two locks apart — it does not hold the name, and it is not ownership.
 *
 * So a lock whose holder is gone is not reclaimed. It blocks, and says exactly
 * which file to remove and when it is safe to remove it, because a person
 * closing the last window for a repository knows something no process on disk
 * can know. A lock that cannot be read as one is refused the same way: it was
 * not written by this protocol, and guessing at its owner is how a live lock
 * gets deleted. So is a lock that cannot be read at all, which says nothing
 * even about who wrote it — that one is refused immediately rather than waited
 * on, because no amount of waiting opens a file this process may not read.
 */
async function acquireJournalLock(
  file: string,
  signal?: AbortSignal,
): Promise<JournalLockIdentity> {
  const lockPath = `${file}.lock`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const deadline = Date.now() + JOURNAL_LOCK_WAIT_MS
  for (;;) {
    cancelIfAborted(signal)
    const temporary = `${lockPath}.${randomUUID()}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    let identity: JournalLockIdentity
    try {
      const stat = await handle.stat()
      identity = { dev: stat.dev, ino: stat.ino }
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.link(temporary, lockPath)
      return identity
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }

    // Someone held it a moment ago. The lock is only read, to say who, and is
    // left exactly as it was found: it is never taken from its holder. A holder
    // that released between the failed link and this read has simply finished,
    // so the name is free now and the next attempt takes it — a lock that is
    // gone is the only read failure worth trying again. Any other failure
    // leaves a lock standing that this process cannot see into, and retrying
    // that spins on a file no waiting helps: the owner may well be alive, so the
    // write refuses instead of guessing.
    let held: string
    try {
      held = await fs.readFile(lockPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw journalLockUnreadable(lockPath, error)
    }
    const running = lockHolderIsRunning(held)
    // Only a holder known to be alive gets the wait: it is a window mid-write,
    // and it will let go. A holder that is gone, or one this build cannot read,
    // is refused at once — waiting cannot help either way, and only a person can
    // clear it.
    if (running === true && Date.now() < deadline) {
      cancelIfAborted(signal)
      await waitFor(JOURNAL_LOCK_POLL_MS)
      continue
    }
    throw journalLockRefusal(lockPath, running)
  }
}

/**
 * Releases a lock, and only the lock this process took.
 *
 * The name is compared against the inode recorded when it was taken, so a lock
 * that is somehow no longer the one acquired is left alone rather than removed
 * on its behalf. Nothing else can take the name while this process holds it:
 * every other writer only ever creates the name, and creates fail while it is
 * there.
 */
async function releaseJournalLock(file: string, identity: JournalLockIdentity): Promise<void> {
  const lockPath = `${file}.lock`
  try {
    const stat = await fs.lstat(lockPath)
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) return
    await fs.rm(lockPath, { force: true })
  } catch {
    // A lock already gone needs no release.
  }
}

/** Runs an update of one journal with no other process able to interleave. */
export async function withJournalLock<T>(
  file: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const identity = await acquireJournalLock(file, signal)
  try {
    return await run()
  } finally {
    await releaseJournalLock(file, identity)
  }
}
