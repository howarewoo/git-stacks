import { isRecord } from '../../src/shared/guards'
import { createPullRequestStack } from '../../src/main/native-stacks'
import { originRemote, readReviewFilesFrom } from '../../src/main/review'
import { submitReview } from '../../src/main/review-threads'
import type { GitHubRestRequest, GitHubTransport } from '../../src/main/github-transport'
import type { LiveTarget, LiveWorkspace } from './contract'
import { LiveRedactor } from './diagnostics'
import { pushCommit } from './layers'
import { anchorsFrom } from './scenario'

/**
 * One request whose response shape the application's parsers depend on.
 *
 * These are the reads the product actually makes, not a survey of GitHub. A field
 * that no parser reads cannot break a merge, and pinning it would only make the
 * fixture churn on every unrelated addition upstream.
 */
export interface SchemaProbe {
  readonly id: string
  readonly request: GitHubRestRequest
  /**
   * The fields a parser reads, as dotted paths from the response root. Everything
   * else in the response is recorded as present but not depended on, so an
   * addition upstream is not a failure and a removal that a parser needs is.
   */
  readonly dependsOn: readonly string[]
}

export const SCHEMA_PROBES: readonly SchemaProbe[] = [
  {
    id: 'repository',
    request: { method: 'GET', path: 'repos/{owner}/{repository}' },
    dependsOn: [
      'full_name',
      'default_branch',
      'description',
      'permissions.admin',
      'permissions.push',
      'topics.names',
    ],
  },
  {
    id: 'pull-request',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}' },
    dependsOn: [
      'number',
      'state',
      'title',
      'draft',
      'base.ref',
      'base.sha',
      'head.ref',
      'head.sha',
      'head.repo.full_name',
      'mergeable_state',
      'merged',
    ],
  },
  {
    id: 'pull-request-comments',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/comments' },
    dependsOn: ['[].id', '[].body', '[].path', '[].commit_id', '[].user.login', '[].created_at'],
  },
  {
    id: 'pull-request-reviews',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/reviews' },
    dependsOn: ['[].id', '[].state', '[].body', '[].commit_id', '[].user.login', '[].submitted_at'],
  },
  {
    id: 'check-runs',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/commits/{sha}/check-runs' },
    dependsOn: [
      'total_count',
      'check_runs[].id',
      'check_runs[].name',
      'check_runs[].status',
      'check_runs[].conclusion',
      'check_runs[].app.id',
    ],
  },
  {
    id: 'combined-status',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/commits/{sha}/status' },
    dependsOn: [
      'state',
      'total_count',
      'statuses[].context',
      'statuses[].state',
      'statuses[].target_url',
    ],
  },
  {
    id: 'pull-request-files',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/files' },
    dependsOn: ['[].filename', '[].status', '[].additions', '[].deletions', '[].patch', '[].sha'],
  },
  {
    id: 'native-stacks',
    request: {
      method: 'GET',
      path: 'repos/{owner}/{repository}/stacks',
      headers: {
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    },
    dependsOn: ['[].number', '[].node_id', '[].base.ref', '[].open', '[].pull_requests[].number'],
  },
]

/** One observed path and the JSON type found there. */
export interface ObservedField {
  readonly path: string
  readonly type: string
}

export interface ObservedSchema {
  readonly version: 1
  /** Where the shape was read from: a live host, or the controlled runtime. */
  readonly source: string
  readonly observedAt: string
  /** Probe id to the fields its response carried. */
  readonly probes: Record<string, readonly ObservedField[]>
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * The shape of one response, flattened to paths and types. Values are never kept:
 * a repository description, a token, or a diff line must not end up in a
 * committed fixture, and a type carries everything a parser can be broken by.
 */
export function shapeOf(value: unknown, prefix = '', depth = 0): ObservedField[] {
  if (depth > 6) return []
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: prefix, type: 'array' }]
    return [{ path: prefix, type: 'array' }, ...shapeOf(value[0], `${prefix}[]`, depth + 1)]
  }
  if (isRecord(value)) {
    const fields: ObservedField[] = [{ path: prefix, type: 'object' }]
    for (const key of Object.keys(value).sort()) {
      fields.push(...shapeOf(value[key], prefix ? `${prefix}.${key}` : key, depth + 1))
    }
    return fields
  }
  return [{ path: prefix, type: typeOf(value) }]
}

export interface SchemaDrift {
  readonly probe: string
  readonly kind: 'missing' | 'added' | 'type-changed'
  readonly path: string
  readonly detail: string
}

/** What a live host answered for each probe, in a form that can be committed. */
export async function observeSchema(
  transport: GitHubTransport,
  substitutions: { owner: string; repository: string; number: number; sha: string },
  source: string,
): Promise<ObservedSchema> {
  const probes: Record<string, ObservedField[]> = {}
  for (const probe of SCHEMA_PROBES) {
    const path = probe.request.path
      .replace('{owner}', substitutions.owner)
      .replace('{repository}', substitutions.repository)
      .replace('{number}', String(substitutions.number))
      .replace('{sha}', substitutions.sha)
    const response = await transport.rest<unknown>({ ...probe.request, path })
    probes[probe.id] = shapeOf(response.data).filter((field) => field.path !== '')
  }
  return { version: 1, source, observedAt: new Date().toISOString(), probes }
}

/** The file the schema probe changes, and the branch it changes it on. */
const PROBE_BRANCH = 'git-stacks-live-e2e-schema-probe'
const PROBE_LAYER_BRANCH = 'git-stacks-live-e2e-schema-probe-layer'
const PROBE_FILE = 'schema-probe.txt'

/** One pull request the probes can be asked about, with everything they read on it. */
export interface SchemaProbeSubject {
  readonly owner: string
  readonly repository: string
  readonly number: number
  readonly sha: string
}

/** The context and check name the probe publishes on its own commit. */
const PROBE_CONTEXT = 'git-stacks/live-e2e-probe'

/**
 * The state the schema probes need before they can observe anything.
 *
 * Most of these probes read a collection — a pull request's comments, its reviews, its
 * files, the repository's native stacks, a commit's check runs and statuses — and a
 * collection with nothing in it observes nothing: an empty array carries no fields. A
 * fixture built from one would accept any shape the host ever answered with, and the
 * drift this suite exists to catch would pass silently. The state is made through the
 * same admin surface and the same product calls the scenarios use, so what is observed
 * is the product's world and not a purpose-built one.
 */
export async function prepareSchemaSubject(input: {
  target: LiveTarget
  workspace: LiveWorkspace
  defaultBranch: string
}): Promise<SchemaProbeSubject> {
  const { target, workspace, defaultBranch } = input
  const fullName = target.repository()
  const [owner, repository] = fullName.split('/')
  const sha = await pushCommit(workspace, {
    branch: PROBE_BRANCH,
    parent: `origin/${defaultBranch}`,
    file: PROBE_FILE,
    contents: `${PROBE_FILE} written by the observed-schema probe\n`,
    message: 'live e2e: a change to observe',
  })
  // A check run and a commit status on the probe's own head, so the two probes that
  // read what a CI system published observe a record rather than an empty list.
  await target.admin.createCheckRun({
    fullName,
    headSha: sha,
    name: PROBE_CONTEXT,
    status: 'completed',
    conclusion: 'success',
  })
  await target.transport().rest({
    method: 'POST',
    path: `repos/${fullName}/statuses/${sha}`,
    body: {
      state: 'success',
      context: PROBE_CONTEXT,
      description: 'The live e2e suite observing the combined status it reads.',
      target_url: `https://github.com/${fullName}/commit/${sha}`,
    },
  })
  const pull = await target.admin.createPullRequest({
    fullName,
    head: PROBE_BRANCH,
    base: defaultBranch,
    title: 'live e2e schema probe',
    body: `Opened by the live GitHub suite for run ${target.runId}.`,
  })

  // A review with one comment, so the reviews and review-comments probes read records
  // rather than empty lists. It goes through the product's own submission, because the
  // shape being pinned is the shape the product's writers produce.
  const files = await readReviewFilesFrom(await originRemote(workspace.path), pull.number)
  await submitReview(workspace.path, pull.number, {
    event: 'COMMENT',
    body: 'A review written so the schema probes have a record to read.',
    drafts: anchorsFrom(files, PROBE_FILE).slice(0, 1),
    comparison: files.comparison,
  })

  // A second layer and the stack over both, so the native-stack probe reads a stack
  // rather than a list with nothing in it.
  await pushCommit(workspace, {
    branch: PROBE_LAYER_BRANCH,
    parent: PROBE_BRANCH,
    file: `${PROBE_LAYER_BRANCH}.txt`,
    contents: 'the second layer of the stack the probes observe\n',
    message: 'live e2e: a layer to stack',
  })
  const upper = await target.admin.createPullRequest({
    fullName,
    head: PROBE_LAYER_BRANCH,
    base: PROBE_BRANCH,
    title: 'live e2e schema probe, second layer',
    body: `Opened by the live GitHub suite for run ${target.runId}.`,
  })
  await createPullRequestStack(owner, repository, [pull.number, upper.number], {
    host: target.host,
    transport: target.transport(),
    defaultBranch,
  })
  return { owner, repository, number: pull.number, sha }
}

/**
 * What drifted between an observed host and the committed schema.
 *
 * An addition is reported, not failed: GitHub ships fields continuously, and a
 * suite that fails on every one of them trains people to ignore it. A field a
 * parser reads disappearing, or changing type, is a failure — that is the drift
 * that silently turns a merge button into a no-op.
 */
export function compareSchemas(expected: ObservedSchema, observed: ObservedSchema): SchemaDrift[] {
  const drift: SchemaDrift[] = []
  for (const probe of SCHEMA_PROBES) {
    const before = new Map(
      (expected.probes[probe.id] ?? []).map((field) => [field.path, field.type] as const),
    )
    const after = new Map(
      (observed.probes[probe.id] ?? []).map((field) => [field.path, field.type] as const),
    )
    for (const path of probe.dependsOn) {
      const wanted = before.get(path)
      const found = after.get(path)
      if (found === undefined) {
        drift.push({ probe: probe.id, kind: 'missing', path, detail: 'the host did not answer it' })
        continue
      }
      if (wanted === undefined) {
        drift.push({
          probe: probe.id,
          kind: 'added',
          path,
          detail: 'a depended-on field is not in the committed schema; regenerate it',
        })
        continue
      }
      if (wanted !== found) {
        drift.push({
          probe: probe.id,
          kind: 'type-changed',
          path,
          detail: `committed ${wanted}, host answered ${found}`,
        })
      }
    }
    for (const [path, type] of after) {
      if (!before.has(path)) {
        drift.push({ probe: probe.id, kind: 'added', path, detail: `host added a ${type} field` })
      }
    }
  }
  return drift
}

/** Only the drift that means the committed fixtures are no longer trustworthy. */
export function breakingDrift(drift: readonly SchemaDrift[]): SchemaDrift[] {
  return drift.filter((entry) => entry.kind !== 'added')
}

/** Renders the committed document, stable so a regeneration produces a reviewable diff. */
export function renderSchema(schema: ObservedSchema): string {
  const body = {
    version: 1,
    source: schema.source,
    probes: Object.fromEntries(
      Object.entries(schema.probes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, fields]) => [
          id,
          fields
            .map((field) => ({ path: field.path, type: field.type }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        ]),
    ),
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/** A one-line, sanitized description of what drifted, safe to publish. */
export function renderDrift(drift: readonly SchemaDrift[], redactor: LiveRedactor): string {
  if (drift.length === 0) return 'no schema drift'
  return redactor.text(
    drift
      .map((entry) => `${entry.probe}: ${entry.kind} ${entry.path} — ${entry.detail}`)
      .join('\n'),
  )
}
