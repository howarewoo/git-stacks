import { mkdir, rename, writeFile } from 'node:fs/promises'
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
  private readonly receiptPath: string
  private readonly entries: LiveResource[] = []
  /** The tail of the flush chain, so two receipts are never written at once. */
  private writing: Promise<void> = Promise.resolve()
  /** Distinguishes one receipt's temporary file from another's. */
  private sequence = 0
  /** Set once the run is over, so a queued write cannot recreate a directory. */
  private closed = false

  constructor(input: { runId: string; marker: string; receiptPath: string }) {
    this.runId = input.runId
    this.marker = input.marker
    this.receiptPath = input.receiptPath
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
   * Ends the receipt's life.
   *
   * Called once nothing is left to record, so a flush that was queued before the run
   * finished cannot write a file back into a directory cleanup is in the middle of
   * removing.
   */
  close(): void {
    this.closed = true
    this.writing = Promise.resolve()
  }

  /** What is still there, and what cleanup refused to touch. */
  outstanding(): LiveResource[] {
    return this.entries.filter((entry) => !entry.deletedAt)
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
      const receipt = {
        version: 1 as const,
        runId: this.runId,
        marker: this.marker,
        writtenAt: new Date().toISOString(),
        resources: this.entries,
      }
      await mkdir(dirname(this.receiptPath), { recursive: true })
      const temporary = `${this.receiptPath}.${process.pid}.${this.sequence++}.tmp`
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
      await rename(temporary, this.receiptPath)
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

/** The subset a repository read has to expose for the ownership check to be possible. */
export interface OwnedResourceProbe {
  description: string | null
  topics?: { names?: string[] }
}

/** Reads the marker off whatever the host reports about a resource it created. */
export function markerOnRepository(probe: OwnedResourceProbe): string | null {
  const fromDescription = probe.description ?? ''
  const fromTopics = (probe.topics?.names ?? []).join('\n')
  return `${fromDescription}\n${fromTopics}`
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
