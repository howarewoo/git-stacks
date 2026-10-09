import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHostName } from '../shared/host'
import {
  parseGraphPreferences,
  parseGraphPreferencesPublicScope,
  type GraphPreferences,
  type GraphPreferencesResult,
  type GraphPreferencesPublicScope,
} from '../shared/graph-preferences'

export interface GraphPreferencesScope {
  repositoryPath: string
  host: string
  repository: string
  account: string
  authority: string
}
const unavailable = (): GraphPreferencesResult => ({
  state: 'unavailable',
  preferences: null,
  scope: null,
  message: 'Saved graph preferences require a known current repository and authenticated account.',
})
function key(scope: GraphPreferencesScope): string {
  return JSON.stringify([
    scope.host.toLowerCase(),
    scope.repository.toLowerCase(),
    scope.account.toLowerCase(),
  ])
}

function publicScope(scope: GraphPreferencesScope): GraphPreferencesPublicScope {
  return {
    repositoryPath: scope.repositoryPath,
    host: scope.host,
    repository: scope.repository,
    account: scope.account,
  }
}

/** Main alone supplies scope. Public path is response provenance, not part of the persisted key. */
export class GraphPreferencesStore {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly directory: string,
    private readonly authority: () => Promise<GraphPreferencesScope | null>,
  ) {}

  private file(scope: GraphPreferencesScope): string {
    return join(this.directory, `${createHash('sha256').update(key(scope)).digest('hex')}.json`)
  }

  private async current(scope: GraphPreferencesScope): Promise<boolean> {
    const current = await this.authority()
    return current !== null && key(current) === key(scope) && current.authority === scope.authority
  }

  async read(): Promise<GraphPreferencesResult> {
    const pendingWrites = this.writes
    const scope = await this.authority()
    if (!scope) return unavailable()
    await pendingWrites
    const result = await this.load(scope)
    return (await this.current(scope)) ? result : unavailable()
  }

  private async load(scope: GraphPreferencesScope): Promise<GraphPreferencesResult> {
    let handle
    try {
      handle = await open(this.file(scope), 'r')
      if ((await handle.stat()).size > 4096) throw new Error('Oversized preferences')
      const value = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>
      const preferences = parseGraphPreferences(value.preferences)
      if (value.version !== 1 || value.scope !== key(scope) || !preferences)
        throw new Error('Invalid preferences')
      return { state: 'ready', preferences, scope: publicScope(scope) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { state: 'ready', preferences: null, scope: publicScope(scope) }
      return {
        state: 'recovered',
        preferences: null,
        scope: publicScope(scope),
        message:
          'Saved graph preferences could not be read. Defaults are active; save or reset to replace them.',
      }
    } finally {
      await handle?.close()
    }
  }

  async save(value: unknown, expectedScope: unknown): Promise<GraphPreferencesResult> {
    const preferences = parseGraphPreferences(value)
    if (!preferences) throw new Error('Invalid graph preferences.')
    return this.change(preferences, expectedScope)
  }

  async reset(expectedScope: unknown): Promise<GraphPreferencesResult> {
    return this.change(null, expectedScope)
  }

  private async change(
    preferences: GraphPreferences | null,
    expectedScope: unknown,
  ): Promise<GraphPreferencesResult> {
    const expected = parseGraphPreferencesPublicScope(expectedScope)
    if (!expected) return unavailable()
    const capture = this.authority()
    // Capture can reject while an earlier operation still owns the queue.
    void capture.catch(() => {})
    const operation = this.writes.then(async () => {
      const scope = await capture
      if (
        !scope ||
        scope.repositoryPath !== expected.repositoryPath ||
        canonicalHostName(scope.host) !== canonicalHostName(expected.host) ||
        scope.repository.toLowerCase() !== expected.repository.toLowerCase() ||
        scope.account.toLowerCase() !== expected.account.toLowerCase() ||
        !(await this.current(scope))
      )
        return unavailable()
      const file = this.file(scope)
      if (preferences === null) {
        await rm(file, { force: true })
      } else {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await writeFile(
            temporary,
            JSON.stringify({ version: 1, scope: key(scope), preferences }),
            { mode: 0o600, flag: 'wx' },
          )
          if (!(await this.current(scope))) return unavailable()
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true }).catch(() => {})
        }
      }
      return (await this.current(scope))
        ? {
            state: 'ready' as const,
            preferences: preferences && { ...preferences },
            scope: publicScope(scope),
          }
        : unavailable()
    })
    this.writes = operation.catch(() => {})
    return operation
  }
}
