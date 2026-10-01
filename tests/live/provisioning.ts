import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LiveCleanupReport, LiveResource, LiveResourceKind, LiveResources } from './contract'

/**
 * The record of everything a run created, and the rule that decides what it may
 * delete.
 *
 * Two things make cleanup safe enough to run unattended. First, a resource is
 * only ever removed after the host has confirmed it still carries this run's
 * marker: a name collision, a hand-made repository, or a previous run's leftover
 * is refused rather than removed. Second, the record is written before the
 * resource is created and updated after every change, so a run that dies between
 * creating something and deleting it still leaves behind the list of what to
 * clean up by hand.
 */
export class ResourceLedger implements LiveResources {
  private readonly runId: string
  private readonly marker: string
  private readonly receiptLocation: string
  /**
   * What a recovery run has to re-establish before it may delete anything: which
   * host the resources are on, and which account created them. A receipt holding
   * only names is a list of guesses, and a guess is how somebody else's
   * repository gets deleted.
   */
  private readonly host: string
  private readonly owner: string
  private readonly entries: LiveResource[] = []
  /** The tail of the flush chain, so two receipts are never written at once. */
  private writing: Promise<void> = Promise.resolve()
  /** Distinguishes one receipt's temporary file from another's. */
  private sequence = 0
  /** Set once the run is over, so a queued write cannot recreate a directory. */
  private closed = false

  constructor(input: {
    runId: string
    marker: string
    receiptPath: string
    host: string
    owner: string
  }) {
    this.runId = input.runId
    this.marker = input.marker
    this.receiptLocation = input.receiptPath
    this.host = input.host
    this.owner = input.owner
  }

  /**
   * Where this receipt is written, so a failure report can name the file an operator
   * has to open rather than only listing handles they have no way to act on.
   */
  get receiptPath(): string {
    return this.receiptLocation
  }

  list(): readonly LiveResource[] {
    return this.entries
  }

  record(resource: LiveResource): void {
    if (resource.marker !== this.marker) {
      throw new Error(
        `Refusing to record ${resource.handle}: it does not carry this run's ownership marker`,
      )
    }
    this.entries.push(resource)
    this.scheduleFlush()
  }

  /**
   * Journals a resource this run is about to create, and waits for the receipt to
   * reach the disk before the caller sends the request that creates it.
   *
   * This is the whole difference between a lost response and a leaked repository.
   * `record` after a successful call covers the ordinary case; nothing covers the
   * case where the host applied the write and the answer never came back, which is
   * the only case that leaves a resource nobody knows about. Writing the intent
   * first means the receipt names the exact owner, name and marker to go and look
   * for, and the reconciliation that follows reads the host rather than re-sending
   * a creation whose outcome is unknown.
   */
  async intent(resource: LiveResource): Promise<void> {
    this.entries.push({ ...resource, pending: true })
    await this.flush()
  }

  /**
   * Records the id the host returned for a pending creation.
   *
   * A name can be spelled for something that already existed; an id cannot. Once
   * the host has named the object it created, cleanup and recovery act on that id
   * and stop depending on the name still resolving to the same repository.
   */
  confirm(handle: string, remoteId?: number): void {
    const entry = this.entries.find((candidate) => candidate.handle === handle)
    if (!entry) return
    const index = this.entries.indexOf(entry)
    this.entries[index] = {
      ...entry,
      pending: undefined,
      ...(remoteId === undefined ? {} : { remoteId }),
    }
    this.scheduleFlush()
  }

  release(handle: string, at: Date = new Date()): void {
    const entry = this.entries.find((candidate) => candidate.handle === handle)
    if (!entry) return
    entry.deletedAt = at.toISOString()
    delete entry.refused
    this.scheduleFlush()
  }

  refuse(handle: string, reason: string): void {
    const entry = this.entries.find((candidate) => candidate.handle === handle)
    if (!entry) return
    entry.refused = reason
    this.scheduleFlush()
  }

  /**
   * Flushes without making the caller wait for the disk.
   *
   * A receipt is an audit trail, not the result of the run, so a write that fails while
   * the directory is being removed on the way out must not take the run with it. The
   * awaited `flush` a caller can reach is where a failure is reported instead.
   */
  private scheduleFlush(): void {
    if (this.closed) return
    void this.flush().catch(() => undefined)
  }

  /**
   * Ends the receipt's life, once the last update has reached the disk.
   *
   * Ordering is the caller's responsibility, and the order that matters is this
   * one: a receipt may only be closed after the final deletion or refusal has been
   * flushed. Closing first makes every later update memory-only, so the published
   * artifact keeps listing a repository that has since been deleted — and a run
   * that reports `complete` while the only durable record says otherwise is worse
   * than a run that reports nothing at all.
   */
  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    this.writing = Promise.resolve()
  }

  /**
   * What is still there, including a creation whose outcome is unknown. A pending
   * entry is outstanding: nobody has proved it exists, and nobody has proved it
   * does not, so a run that treats it as settled is asserting something it does
   * not know.
   */
  outstanding(): LiveResource[] {
    return this.entries.filter((entry) => !entry.deletedAt)
  }

  /**
   * The creations this run sent but never saw answered, which are the only entries
   * a recovery run has to reconcile against the host before it deletes anything.
   */
  unresolved(): LiveResource[] {
    return this.entries.filter((entry) => entry.pending === true)
  }

  /**
   * Writes the receipt atomically. A reader must never see a half-written receipt,
   * because the one time somebody reads it is after a crash.
   *
   * `record` and `release` flush without being awaited, so two flushes really can be in
   * flight at once. They are chained rather than interleaved: sharing one temporary name
   * across concurrent writes would let the first rename consume the second's file, and a
   * run that lost its own receipt to that would look like one that never wrote one.
   */
  async flush(): Promise<void> {
    if (this.closed) return
    const previous = this.writing
    let release = (): void => {}
    this.writing = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => undefined)
    try {
      // The receipt carries no credential, ever: it is the file a workflow publishes,
      // and it names the host, the owner, and the run so a recovery run can re-establish
      // all three before it acts on a single handle in it.
      const receipt = {
        version: 2 as const,
        runId: this.runId,
        marker: this.marker,
        host: this.host,
        owner: this.owner,
        writtenAt: new Date().toISOString(),
        resources: this.entries,
      }
      await mkdir(dirname(this.receiptLocation), { recursive: true })
      const temporary = `${this.receiptLocation}.${process.pid}.${this.sequence++}.tmp`
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
      await rename(temporary, this.receiptLocation)
    } finally {
      release()
    }
  }

  /** The report a run ends on, and the only thing that decides it was clean. */
  report(): LiveCleanupReport {
    const remaining = this.outstanding().map((entry) => entry.handle)
    const refused = this.entries
      .filter((entry) => entry.refused !== undefined)
      .map((entry) => ({ handle: entry.handle, reason: entry.refused as string }))
    return {
      removed: this.entries.filter((entry) => entry.deletedAt).map((entry) => entry.handle),
      refused,
      remaining,
      complete: remaining.length === 0,
    }
  }
}

/**
 * Whether the host still shows this run's marker on the resource.
 *
 * A marker that cannot be read is not a match. Refusing to delete something whose
 * ownership cannot be proven is the whole point of the check, so an unreadable
 * marker and an absent one are answered the same way.
 */
export function ownsMarker(observed: string | null | undefined, marker: string): boolean {
  return typeof observed === 'string' && observed.includes(marker)
}

/** The description a repository is created with, carrying the marker and nothing else. */
export function markedDescription(summary: string, marker: string): string {
  return `${summary}\n\n${marker}\n`
}

/**
 * The subset a repository read has to expose for the ownership check to be
 * possible.
 *
 * `topics` is an array because that is what GitHub's repository response
 * actually contains. A double that answered with a `{names: [...]}` object made
 * the ownership check pass here and made it fail against a real host, which is
 * the whole class of bug this decoder exists to prevent: the marker is read from
 * the shape the wire uses, and the wire is the shape the documentation and the
 * host agree on.
 */
export interface OwnedResourceProbe {
  description: string | null
  topics?: string[]
}

/** Reads the marker off whatever the host reports about a resource it created. */
export function markerOnRepository(probe: OwnedResourceProbe): string | null {
  const fromDescription = probe.description ?? ''
  const fromTopics = (probe.topics ?? []).join('\n')
  return `${fromDescription}\n${fromTopics}`
}

/** A receipt as a recovery run reads it back, having nothing but the file. */
export interface LiveReceipt {
  readonly version: number
  readonly runId: string
  readonly marker: string
  readonly host: string
  readonly owner: string
  readonly writtenAt: string
  readonly resources: readonly LiveResource[]
}

/**
 * Reads a receipt from disk, refusing anything it cannot vouch for.
 *
 * A recovery run acts on this file with a credential the operator supplied
 * afterwards, so every field it needs to decide what may be deleted has to be
 * here and has to be the right shape. A file missing the version, the run, the
 * marker, the host, or the owner is refused rather than partially honoured: the
 * alternative is a deletion decided by a handle alone, which is the one thing
 * this whole mechanism exists to prevent.
 */
export async function readLiveReceipt(path: string): Promise<LiveReceipt> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `The cleanup receipt at ${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`The cleanup receipt at ${path} is not a receipt`)
  }
  const record = parsed as Record<string, unknown>
  const text = (key: string): string => {
    const value = record[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const version = typeof record.version === 'number' ? record.version : 0
  const runId = text('runId')
  const marker = text('marker')
  const host = text('host')
  const owner = text('owner')
  const missing: string[] = []
  if (version < 2) missing.push('a version this recovery understands')
  if (runId === '') missing.push('the run id')
  if (marker === '') missing.push('the ownership marker')
  if (host === '') missing.push('the host')
  if (owner === '') missing.push('the owner')
  if (!Array.isArray(record.resources)) missing.push('the resource list')
  if (missing.length > 0) {
    throw new Error(
      `The cleanup receipt at ${path} is missing ${missing.join(', ')}, so nothing in it can be acted on`,
    )
  }
  return {
    version,
    runId,
    marker,
    host,
    owner,
    writtenAt: text('writtenAt'),
    resources: (record.resources as unknown[]).filter(
      (entry): entry is LiveResource =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as LiveResource).handle === 'string',
    ),
  }
}

/** The handle a resource is known by in the receipt, one shape per kind. */
export function resourceHandle(
  kind: LiveResourceKind,
  input: { fullName: string; number?: number; id?: number },
): string {
  if (input.number !== undefined) return `${input.fullName}#${input.number}`
  if (input.id !== undefined) return `${input.fullName}/rulesets/${input.id}`
  return input.fullName
}

/**
 * What recovery needs from a host, stated as the smallest thing it actually uses.
 *
 * Recovery reads a repository and removes it. It has no business creating anything, and
 * the type says so: there is no method here that could, so a caller cannot accidentally
 * give it one by passing a richer object along.
 */
export interface RecoverySurface {
  /** The repository as the host reports it, or a refusal a caller has to recognise. */
  readRepository(
    fullName: string,
  ): Promise<{ id?: number; description: string | null; topics?: string[] }>
  /** Removes the repository. */
  deleteRepository(fullName: string): Promise<boolean>
  /** Removes a rule set inside it. */
  deleteRuleSet(fullName: string, id: number): Promise<boolean>
}

/** What one recovery run did, and what it could not. */
export interface RecoveryOutcome {
  readonly runId: string
  /** Handles the host confirmed removed. */
  readonly removed: string[]
  /** Handles the host confirmed were never there. */
  readonly absent: string[]
  /**
   * Handles this run declined to touch, each with the reason. A refusal is a
   * deliberate answer, not an error: the run could not prove the handle was still the
   * thing this receipt is about, so it left it alone and said so.
   */
  readonly refused: Array<{ handle: string; reason: string }>
  /**
   * Handles whose state could not be determined at all — a read that failed for a
   * reason other than "it is not there". They are neither removed nor absent, and
   * reporting them as either would be the one thing a person cannot act on.
   */
  readonly unknown: string[]
  /** True only when nothing was refused and nothing is unknown. */
  readonly complete: boolean
}

/** One not-there answer, matched the way a 404 is matched everywhere else here. */
function isAbsent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    (error as { kind?: string }).kind === 'not-found'
  )
}

/**
 * Removes what a receipt says a killed run left behind, and nothing else.
 *
 * This is the command an operator runs when a run died before its own cleanup could
 * finish, and it runs against a credential supplied at that moment rather than one the
 * dead run left in its environment. Three rules make it safe, and each of them is a
 * case where the obvious implementation deletes the wrong thing:
 *
 * - It never creates. A recovery run that could create would turn a lost response into
 *   a second repository, which is the failure recovery exists to end.
 * - It never guesses. It does not list an account's repositories and match on a
 *   prefix, because a prefix is not evidence: it would remove whatever somebody else
 *   had named similarly. It acts only on handles the receipt already names.
 * - It re-establishes identity before every deletion. The name in the receipt is checked
 *   against the id the host returned when that name was created, and against the marker
 *   the run stamped on it. A name that has since been reused resolves to a different
 *   repository, and that repository is somebody else's.
 *
 * Branches and pull requests are deliberately not removed one at a time. They only ever
 * existed inside a repository this run created, they die with it, and deleting them
 * individually would mean extra deletions aimed at names whose repositories may not be
 * this run's. They are reported as gone when the repository is gone, and as unknown
 * when it could not be established.
 */
export async function recoverLiveResources(input: {
  readonly receipt: LiveReceipt
  /**
   * The surface for each account the receipt names, keyed by login. An entry whose actor
   * is absent here is refused, because the run cannot act as an account it holds no
   * credential for.
   */
  readonly surfaces: ReadonlyMap<string, RecoverySurface>
  /** The login the primary credential authenticates as, for entries with no actor. */
  readonly primaryLogin: string
}): Promise<RecoveryOutcome> {
  const removed: string[] = []
  const absent: string[] = []
  const refused: Array<{ handle: string; reason: string }> = []
  const unknown: string[] = []
  const surfaceFor = (entry: LiveResource): RecoverySurface | undefined =>
    input.surfaces.get(entry.actor ?? input.primaryLogin)

  for (const entry of input.receipt.resources) {
    if (entry.deletedAt !== undefined) {
      absent.push(entry.handle)
      continue
    }
    const fullName = repositoryOf(entry)
    if (fullName === null) {
      refused.push({
        handle: entry.handle,
        reason: 'the receipt does not say which repository this is',
      })
      continue
    }
    const surface = surfaceFor(entry)
    if (surface === undefined) {
      refused.push({
        handle: entry.handle,
        reason: `no credential in this recovery acts as ${entry.actor ?? input.primaryLogin}`,
      })
      continue
    }

    // A repository, or any resource inside one, may only be touched once the repository
    // itself has been proved to be the one the receipt is about. A rule set id is
    // unique per repository, so an id read back against the wrong repository is either a
    // different resource or nothing at all.
    const repository = await readOrAbsent(surface, fullName)
    if (repository === 'unknown') {
      unknown.push(entry.handle)
      continue
    }
    if (repository === 'absent') {
      absent.push(entry.handle)
      continue
    }
    if (
      entry.kind === 'repository' &&
      typeof entry.remoteId === 'number' &&
      repository.id !== entry.remoteId
    ) {
      refused.push({
        handle: entry.handle,
        reason: `the host has id ${String(repository.id)} there; this run created id ${entry.remoteId}`,
      })
      continue
    }
    if (!ownsMarker(markerOnRepository(repository), input.receipt.marker)) {
      refused.push({
        handle: entry.handle,
        reason: 'it no longer carries the ownership marker this receipt records',
      })
      continue
    }

    try {
      const removedNow =
        entry.kind === 'rule-set'
          ? await surface.deleteRuleSet(fullName, Number(entry.handle.split('/').pop() ?? ''))
          : entry.kind === 'repository'
            ? await surface.deleteRepository(fullName)
            : true
      if (removedNow) removed.push(entry.handle)
      else refused.push({ handle: entry.handle, reason: 'the host still has it' })
    } catch (error) {
      unknown.push(entry.handle)
    }
  }
  return {
    runId: input.receipt.runId,
    removed,
    absent,
    refused,
    unknown,
    complete: refused.length === 0 && unknown.length === 0,
  }
}

/** The repository a handle belongs to, which every handle in a receipt is prefixed by. */
function repositoryOf(entry: LiveResource): string | null {
  if (entry.kind === 'repository') {
    const at = entry.handle.indexOf('/')
    return at > 0 ? entry.handle : null
  }
  const prefix = entry.handle.split('#')[0] ?? entry.handle.split('/rulesets/')[0] ?? ''
  return prefix.includes('/') ? prefix : null
}

/**
 * A repository read, answered as present, absent, or undecidable.
 *
 * The third answer is the one that matters. A dropped connection and a deleted
 * repository are not the same event, and a recovery run that cannot tell them apart
 * would either delete nothing while reporting success, or delete again on the next
 * attempt against a name it has not re-established.
 */
async function readOrAbsent(
  surface: RecoverySurface,
  fullName: string,
): Promise<{ id?: number; description: string | null; topics?: string[] } | 'absent' | 'unknown'> {
  try {
    return await surface.readRepository(fullName)
  } catch (error) {
    return isAbsent(error) ? 'absent' : 'unknown'
  }
}
