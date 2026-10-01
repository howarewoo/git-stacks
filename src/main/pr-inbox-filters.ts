import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
 * Saved filters are named questions, not configuration: a group, a search, and
 * optionally one repository. The file is written atomically at owner-only
 * permissions, and a file that cannot be read or parsed is treated as no saved
 * filters rather than as an error, so a damaged file never blocks the queue it
 * does not describe.
 */
export class PullRequestInboxFilters {
  private filters: PullRequestInboxSavedFilter[] = []

  constructor(private readonly file: string) {}

  /** The saved filters as they were last read or written. */
  list(): PullRequestInboxSavedFilter[] {
    return this.filters.map((filter) => ({ ...filter }))
  }

  async load(): Promise<PullRequestInboxSavedFilter[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      const payload = parsed as { filters?: unknown }
      // The file is written as `{ filters: [...] }`; a bare array is also
      // accepted so a hand-edited file is read rather than discarded.
      this.filters = parsePullRequestInboxSavedFilters(
        Array.isArray(parsed) ? parsed : payload.filters,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not read saved pull request inbox filters:', error)
      }
      this.filters = []
    }
    return this.list()
  }

  /**
   * Replaces the whole list with what the window sent.
   *
   * Every draft is validated first and an invalid one refuses the whole write:
   * a half-saved list would silently lose a filter the person believes is
   * there. Identifiers are preserved for drafts that carry one and minted for
   * the rest, so editing a saved filter keeps the selection the window holds.
   */
  async save(drafts: readonly PullRequestInboxFilterDraft[]): Promise<PullRequestInboxSavedFilter[]> {
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
        repository: parsed.repository,
      })
    }
    const stored = parsePullRequestInboxSavedFilters(next)
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(`${this.file}.tmp`, JSON.stringify({ filters: stored }), { mode: 0o600 })
    await rename(`${this.file}.tmp`, this.file)
    this.filters = stored
    return this.list()
  }
}
