import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isRecord } from '../../src/shared/guards'
import type { ObservedField, ObservedSchema } from './observed-schema'

/**
 * The committed contract the mock fixtures are held to.
 *
 * It records the shape GitHub was observed to answer, not the shape a developer
 * wished it answered, and it holds paths and types only: no values, no
 * repository names, no identifiers. A response body is never committed here,
 * because the file is published as a reviewable artifact and a token-shaped value
 * in it would outlive the run that wrote it.
 */
export const SCHEMA_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'live-github-observed-schema.json',
)

function parseFields(value: unknown): ObservedField[] {
  if (!Array.isArray(value)) return []
  const fields: ObservedField[] = []
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.path === 'string' && typeof entry.type === 'string') {
      fields.push({ path: entry.path, type: entry.type })
    }
  }
  return fields
}

/**
 * The committed schema, read once per process. A missing or malformed fixture is
 * an error rather than an empty schema, because an empty one would make every
 * depended-on field look like drift and train people to regenerate it blindly.
 */
let cached: ObservedSchema | null = null

export function readCommittedSchema(path: string = SCHEMA_FIXTURE_PATH): ObservedSchema {
  if (cached !== null) return cached
  const raw = readFileSync(path, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.probes)) {
    throw new Error(`${path} is not a version 1 observed-schema document`)
  }
  const probes: Record<string, ObservedField[]> = {}
  for (const [id, fields] of Object.entries(parsed.probes)) {
    probes[id] = parseFields(fields)
  }
  cached = {
    version: 1,
    source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
    observedAt: '',
    probes,
  }
  if (Object.keys(probes).length === 0) {
    throw new Error(`${path} records no probes; regenerate it against an observed host`)
  }
  return cached
}
