import type { GitHubRestRequest } from './github-transport'

export interface CachedGitHubResponse {
  etag: string | null
  lastModified: string | null
  body: unknown
  storedAt: Date
}

/**
 * Validators for GitHub responses, so a refresh can ask "has this changed?"
 * instead of re-downloading the same repository state every interval.
 */
export interface GitHubResponseCache {
  get(key: string): CachedGitHubResponse | null
  set(key: string, entry: CachedGitHubResponse): void
  delete(key: string): void
  clear(): void
  size(): number
}

const CONDITIONAL_HEADERS = new Set(['if-none-match', 'if-modified-since'])
const DEFAULT_MAX_ENTRIES = 256

/**
 * Two requests share a cache entry only when the path and every non-conditional
 * header match, so an authorization or API-version difference cannot be
 * answered with another variant's body. Only a GET body can be replayed
 * verbatim from a conditional response.
 */
export function conditionalCacheKey(request: GitHubRestRequest): string | null {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return null
  const headers = Object.entries(request.headers ?? {})
    .filter(([name]) => !CONDITIONAL_HEADERS.has(name.toLowerCase()))
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .join('\n')
  return `${request.path.replace(/^\/+/u, '')}\n${headers}`
}

/** The validator headers a stored response makes meaningful. */
export function conditionalHeaders(entry: CachedGitHubResponse | null): Record<string, string> {
  if (!entry) return {}
  const headers: Record<string, string> = {}
  if (entry.etag) headers['if-none-match'] = entry.etag
  if (!entry.etag && entry.lastModified) headers['if-modified-since'] = entry.lastModified
  return headers
}

/**
 * Bounded newest-first store: a long-running workbench must not keep every
 * pull-request body it ever saw resident.
 */
export class GitHubResponseCacheStore implements GitHubResponseCache {
  private readonly entries = new Map<string, CachedGitHubResponse>()
  private readonly maxEntries: number
  private hits = 0
  private misses = 0

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  get(key: string): CachedGitHubResponse | null {
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses += 1
      return null
    }
    this.hits += 1
    // Re-insert so the eviction order tracks real use, not insertion order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: CachedGitHubResponse): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  /** How many conditional hits this cache served; surfaced in diagnostics. */
  stats(): { hits: number; misses: number; entries: number } {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size }
  }
}
