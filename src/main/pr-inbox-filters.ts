import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  parsePullRequestInboxFilterDraft,
  parsePullRequestInboxSavedFilters,
  type PullRequestInboxFilterDraft,
  type PullRequestInboxSavedFilter,
} from '../shared/pr-inbox'

/**
 * The person's saved Inbox filters, in one file beside the settings this app
 * already owns.
 *
 * Saved views keep the group's bounded criteria and chosen sort. The file is
 * written atomically at owner-only
 * permissions, and a file that cannot be read or parsed is treated as no saved
 * filters rather than as an error, so a damaged file never blocks the queue it
 * does not describe.
 */
export class PullRequestInboxFilters {
  private filters: PullRequestInboxSavedFilter[] = []
  /**
   * Writes run one at a time. The save controls stay live while a save is in
   * flight, so two saves can overlap; letting them share one temporary path
   * would let the second payload replace the first before its rename, and the
   * file would then hold one list while the window was told another was stored.
   */
  private writes: Promise<PullRequestInboxSavedFilter[]> = Promise.resolve([])
  /**
   * The one initialization read, however many callers ask for it. A list
   * answered before it finished is an empty list that reads as "you have no
   * saved filters", and a whole-list save taken against it replaces the file
   * with whatever the window believed; both entry points therefore wait for
   * this rather than for a read of their own.
   */
  private ready: Promise<PullRequestInboxSavedFilter[]> | null = null
  /**
   * Advanced by every accepted write. A load that was already in flight when a
   * write landed describes the list as it was before that write, so adopting it
   * afterwards would undo a save the window has already been told about.
   */
  private generation = 0

  constructor(private readonly file: string) {}

  /** The stored list with the initialization read joined to it. */
  async settled(): Promise<PullRequestInboxSavedFilter[]> {
    this.ready ??= this.load()
    await this.ready
    return this.list()
  }

  /** The saved filters as they were last read or written. */
  list(): PullRequestInboxSavedFilter[] {
    return structuredClone(this.filters)
  }

  async load(): Promise<PullRequestInboxSavedFilter[]> {
    const generation = this.generation
    let stored: PullRequestInboxSavedFilter[]
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      const payload = parsed as { filters?: unknown }
      // The file is written as `{ filters: [...] }`; a bare array is also
      // accepted so a hand-edited file is read rather than discarded.
      stored = parsePullRequestInboxSavedFilters(Array.isArray(parsed) ? parsed : payload.filters)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not read saved pull request inbox filters:', error)
      }
      stored = []
    }
    if (this.generation === generation) this.filters = stored
    return this.list()
  }

  /** Replaces the whole list, one write at a time. */
  async save(
    drafts: readonly PullRequestInboxFilterDraft[],
  ): Promise<PullRequestInboxSavedFilter[]> {
    const write = this.writes.then(
      () => this.write(drafts),
      () => this.write(drafts),
    )
    // The queue keeps moving after a refused write, so one failed save does not
    // leave every later save waiting on it.
    this.writes = write.catch(() => [])
    return write
  }

  /**
   * Replaces the whole list with what the window sent.
   *
   * Every draft is validated first and an invalid one refuses the whole write:
   * a half-saved list would silently lose a filter the person believes is
   * there. Identifiers are preserved for drafts that carry one and minted for
   * the rest, so editing a saved filter keeps the selection the window holds.
   */
  private async write(
    drafts: readonly PullRequestInboxFilterDraft[],
  ): Promise<PullRequestInboxSavedFilter[]> {
    await this.settled()
    const known = new Set(this.filters.map((filter) => filter.id))
    const next: PullRequestInboxSavedFilter[] = []
    const used = new Set<string>()
    for (const draft of drafts) {
      const parsed = parsePullRequestInboxFilterDraft(draft)
      if (!parsed) throw new Error('A saved filter needs a name, a group, and a valid search.')
      const id =
        parsed.id && known.has(parsed.id) && !used.has(parsed.id) ? parsed.id : randomUUID()
      if (used.has(id)) continue
      used.add(id)
      next.push({
        id,
        name: parsed.name,
        group: parsed.group,
        search: parsed.search,
        criteria: parsed.criteria,
        sort: parsed.sort,
      })
    }
    const stored = parsePullRequestInboxSavedFilters(next)
    await mkdir(dirname(this.file), { recursive: true })
    // Each write owns its temporary file, so an overlapping save cannot rename
    // away the payload another save is still writing.
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ filters: stored }), { mode: 0o600 })
      await rename(temporary, this.file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    this.filters = stored
    this.generation += 1
    return this.list()
  }
}
