import { isRecord } from '@git-stacks/shared/guards'
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
 *
 * Every probe here is a REST request, and the pull request list the window opens on
 * is not one of them: the product reads pull requests through GraphQL, and no
 * authorized read of that response has been recorded, so the contract below does not
 * cover it. The REST pull request probes are not a substitute for it — they are the
 * reads the native-stack reader and the checks reader make — and nothing here should
 * be read as evidence about a GraphQL field. Recording that gap is the honest state
 * of it: an unobserved shape is named, not pinned as though it had been seen.
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
  /**
   * A field a parser reads that the committed contract does not pin, and why.
   *
   * A path is unpinned when no authorized read ever saw the host answer it: an
   * empty collection shows no rows, and a pull request with no rename shows no
   * `previous_filename`. Reporting those as depended-on would make the fixture fail
   * on every run for a shape nobody has observed, which is the same as pinning
   * nothing at all. An authorized read that does see them moves them into
   * `dependsOn`, and from then on a host that stops answering one is real drift.
   */
  readonly unpinned?: readonly { readonly path: string; readonly reason: string }[]
  /**
   * The forms a consumer of this response can read, for every path in `dependsOn`.
   *
   * A list of types is not a set of answers the product can choose from; it is a set
   * it has to survive. A form outside this list is one no reader in the product has,
   * so a host answering it beside a form the product does read is breaking drift even
   * though every type the committed contract pinned is still present. That is as true
   * of a field that is never null as of one that is, which is why the whole contract
   * declares this rather than only the fields that may be absent: a stack member whose
   * number or head cannot be read is a member the reader rebuilds with the wrong
   * identity, not one it leaves out.
   *
   * `null` is one of the forms wherever GitHub documents an absence a parser already
   * handles — rows that are all outdated, a run still in progress, a patch the host
   * declined to return. A field that then answers only `null` has narrowed rather than
   * stopped answering, and only there is losing its other forms a narrow answer
   * instead of drift.
   *
   * A path no parser in the product reads is listed with the forms GitHub documents for
   * it, so an answer nobody can consume is reported there rather than accepted because
   * nothing happens to look at it.
   */
  readonly readable: Readonly<Record<string, readonly string[]>>
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
      // GitHub answers `topics` as an array of names. The ownership marker a run
      // stamps and cleanup reads back is one entry in it, so an object here would
      // be a contract no repository on the host can satisfy.
      'topics',
    ],
    readable: {
      full_name: ['string'],
      // A repository with no commits has no default branch at all, and the reader
      // treats that as empty rather than as a branch called `main`.
      default_branch: ['string', 'null'],
      description: ['string', 'null'],
      'permissions.admin': ['boolean'],
      'permissions.push': ['boolean'],
      topics: ['array'],
    },
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
    readable: {
      number: ['number'],
      state: ['string'],
      title: ['string'],
      draft: ['boolean'],
      'base.ref': ['string'],
      'base.sha': ['string'],
      'head.ref': ['string'],
      'head.sha': ['string'],
      'head.repo.full_name': ['string'],
      // GitHub answers `null` while it is still working out whether the pull request
      // can merge, and no product parser reads either form of it.
      mergeable_state: ['string', 'null'],
      merged: ['boolean'],
    },
  },
  {
    id: 'pull-request-comments',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/comments' },
    // `pull_request_review_id` is what a review comment is matched to after a lost
    // response, and `line`/`side`/`start_line`/`start_side` are what the posted
    // anchor is reconciled against. A comment whose identity or anchor the read
    // cannot resolve is a write the product believes is still unconfirmed.
    dependsOn: [
      '[].id',
      '[].body',
      '[].path',
      '[].commit_id',
      '[].user.login',
      '[].created_at',
      '[].pull_request_review_id',
      '[].line',
      '[].side',
      '[].start_line',
      '[].start_side',
    ],
    unpinned: [
      {
        path: '[].start_line',
        reason: 'the observed comments all sit on one line, so only the null form was ever seen',
      },
      {
        path: '[].start_side',
        reason: 'the observed comments all sit on one line, so only the null form was ever seen',
      },
    ],
    // A comment the host no longer shows in the diff answers `null` for `line` and the
    // reader drops that row, which is what a commit outside the diff's history means. A
    // comment attached to no review answers `null` for the review it belongs to, and the
    // reconciliation skips it. `start_line` and `start_side` are null for a comment on a
    // single line and carry a number and a side for a range. All four are documented
    // absences the parsers already read, so a collection that holds only the null form of
    // one of them is a valid answer rather than a lost field. The identity and the anchor
    // fields beside them are read the same way on every comment, so a form no reader has
    // is drift on those too.
    readable: {
      '[].id': ['number'],
      '[].body': ['string'],
      '[].path': ['string'],
      '[].commit_id': ['string'],
      '[].user.login': ['string'],
      '[].created_at': ['string'],
      '[].pull_request_review_id': ['number', 'null'],
      '[].line': ['number', 'null'],
      '[].side': ['string'],
      '[].start_line': ['number', 'null'],
      '[].start_side': ['string', 'null'],
    },
  },
  {
    id: 'pull-request-reviews',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/reviews' },
    dependsOn: ['[].id', '[].state', '[].body', '[].commit_id', '[].user.login', '[].submitted_at'],
    readable: {
      '[].id': ['number'],
      '[].state': ['string'],
      '[].body': ['string'],
      '[].commit_id': ['string'],
      '[].user.login': ['string'],
      '[].submitted_at': ['string'],
    },
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
    unpinned: [
      {
        path: 'check_runs[].conclusion',
        reason: 'only completed runs were observed; an in-progress run answers null there',
      },
    ],
    // GitHub fills `conclusion` in only once a run is completed, so an in-progress run
    // answers `null` there and the rollup reads the run as still running.
    readable: {
      total_count: ['number'],
      'check_runs[].id': ['number'],
      'check_runs[].name': ['string'],
      'check_runs[].status': ['string'],
      'check_runs[].conclusion': ['string', 'null'],
      'check_runs[].app.id': ['number'],
    },
  },
  {
    id: 'combined-status',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/commits/{sha}/status' },
    dependsOn: ['state', 'total_count'],
    readable: { state: ['string'], total_count: ['number'] },
    unpinned: [
      {
        path: 'statuses[]',
        reason: 'every authorized read of a commit status found an empty array, so no row was seen',
      },
      {
        path: 'statuses[].context',
        reason: 'every authorized read of a commit status found an empty array, so no row was seen',
      },
      {
        path: 'statuses[].state',
        reason: 'every authorized read of a commit status found an empty array, so no row was seen',
      },
      {
        path: 'statuses[].target_url',
        reason: 'every authorized read of a commit status found an empty array, so no row was seen',
      },
    ],
  },
  {
    id: 'pull-request-files',
    request: { method: 'GET', path: 'repos/{owner}/{repository}/pulls/{number}/files' },
    dependsOn: [
      '[].filename',
      '[].status',
      '[].additions',
      '[].deletions',
      '[].changes',
      '[].patch',
      '[].sha',
    ],
    readable: {
      '[].filename': ['string'],
      '[].status': ['string'],
      '[].additions': ['number'],
      '[].deletions': ['number'],
      '[].changes': ['number'],
      // A binary or too-large change is answered without a patch, and the reader
      // reports that as unreadable rather than as an empty diff.
      '[].patch': ['string', 'null'],
      '[].sha': ['string'],
    },
    unpinned: [
      {
        path: '[].previous_filename',
        reason: 'the observed pull request only adds files, so no rename or removal was seen',
      },
    ],
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
    // A stack's chain is rebuilt from each member's head ref and head commit, and
    // a member that lost its state or draft flag is neither validated nor
    // displayed correctly. `merged_at` is deliberately absent: only closed stacks
    // were observed, so its presence on an open stack has never been established.
    dependsOn: [
      '[].number',
      '[].node_id',
      '[].base.ref',
      '[].open',
      '[].pull_requests[].number',
      '[].pull_requests[].head.ref',
      '[].pull_requests[].head.sha',
      '[].pull_requests[].state',
      '[].pull_requests[].draft',
    ],
    readable: {
      '[].number': ['number'],
      '[].node_id': ['string'],
      '[].base.ref': ['string'],
      '[].open': ['boolean'],
      // A member's number is that pull request's own identity, and a member whose head
      // cannot be read is a chain the reader cannot rebuild: both are values the parser
      // substitutes rather than drops, so no other form of them is readable.
      '[].pull_requests[].number': ['number'],
      '[].pull_requests[].head.ref': ['string'],
      '[].pull_requests[].head.sha': ['string'],
      '[].pull_requests[].state': ['string'],
      '[].pull_requests[].draft': ['boolean'],
    },
    unpinned: [
      {
        path: '[].pull_requests[].merged_at',
        reason:
          'only closed stacks were observed, so an open member carrying the field is unproven',
      },
    ],
  },
]

/** One observed path and one JSON type found there. A path may carry several. */
export interface ObservedField {
  readonly path: string
  readonly type: string
}

/**
 * Where one probe's recorded shape came from, kept per probe.
 *
 * A blanket "observed on github.com" would be a lie for the probes whose inner rows
 * no authorized read ever saw: those are recorded as unobserved rather than as
 * proven, so a later reader can tell a pinned contract from an empty one.
 */
export interface ObservedProvenance {
  /** The endpoint and host the shape was read from. */
  readonly source: string
  readonly observedAt: string
  /** Paths inside this response the read could not show, and why. */
  readonly unobserved?: readonly string[]
}

export interface ObservedSchema {
  readonly version: 1
  /** Where the whole document was written, kept for the reader of the file. */
  readonly source: string
  /** Probe id to the fields its response carried. */
  readonly probes: Record<string, readonly ObservedField[]>
  readonly provenance?: Record<string, ObservedProvenance>
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** How many rows of one collection are read before the shape is considered complete. */
const MAX_OBSERVED_ROWS = 25

/**
 * The shape of one response, flattened to paths and types. Values are never kept:
 * a repository description, a token, or a diff line must not end up in a
 * committed fixture, and a type carries everything a parser can be broken by.
 *
 * Every row of a collection is read, not just the first: a host answers the same
 * path with different types across rows (`line` is null for a comment that is no
 * longer in the diff and a number for one that is), and a contract built from the
 * first row alone would pin the wrong one of the two.
 */
function shapeOf(value: unknown, prefix = '', depth = 0): ObservedField[] {
  return mergeObservedFields(collectShape(value, prefix, depth))
}

function collectShape(value: unknown, prefix: string, depth: number): ObservedField[] {
  if (depth > 6) return []
  if (Array.isArray(value)) {
    const fields: ObservedField[] = [{ path: prefix, type: 'array' }]
    for (const item of value.slice(0, MAX_OBSERVED_ROWS)) {
      fields.push(...collectShape(item, `${prefix}[]`, depth + 1))
    }
    return fields
  }
  if (isRecord(value)) {
    const fields: ObservedField[] = [{ path: prefix, type: 'object' }]
    for (const key of Object.keys(value).sort()) {
      fields.push(...collectShape(value[key], prefix ? `${prefix}.${key}` : key, depth + 1))
    }
    return fields
  }
  return [{ path: prefix, type: typeOf(value) }]
}

/**
 * One entry per path and type, sorted, with the empty root path dropped.
 *
 * A read that arrives from outside this module is merged through the same
 * function, so a captured contract and a freshly observed one are the same
 * document rather than two formats that have to be reconciled by hand.
 */
export function mergeObservedFields(fields: readonly ObservedField[]): ObservedField[] {
  const byPath = new Map<string, Set<string>>()
  for (const field of fields) {
    if (field.path === '') continue
    const types = byPath.get(field.path) ?? new Set<string>()
    types.add(field.type)
    byPath.set(field.path, types)
  }
  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, types]) => [...types].sort().map((type): ObservedField => ({ path, type })))
}

export interface SchemaDrift {
  readonly probe: string
  readonly kind: 'missing' | 'added' | 'type-changed'
  readonly path: string
  readonly detail: string
}

/**
 * What a live host answered for each probe, in a form that can be committed.
 *
 * The unpinned paths are reported rather than recorded: a host that answers them
 * is carrying information nobody has decided how to read, and hiding that would
 * make the document look like it had been compared field by field.
 */
export async function observeSchema(
  transport: GitHubTransport,
  substitutions: { owner: string; repository: string; number: number; sha: string },
  source: string,
): Promise<ObservedSchema> {
  const observedAt = new Date().toISOString()
  const probes: Record<string, readonly ObservedField[]> = {}
  const provenance: Record<string, ObservedProvenance> = {}
  for (const probe of SCHEMA_PROBES) {
    const path = probe.request.path
      .replace('{owner}', substitutions.owner)
      .replace('{repository}', substitutions.repository)
      .replace('{number}', String(substitutions.number))
      .replace('{sha}', substitutions.sha)
    const response = await transport.rest<unknown>({ ...probe.request, path })
    probes[probe.id] = shapeOf(response.data)
    provenance[probe.id] = { source, observedAt }
  }
  return { version: 1, source, probes, provenance }
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

/** The drift kinds a consumer can actually be broken by; the rest are reported only. */
const BREAKING_KINDS: Record<SchemaDrift['kind'], boolean> = {
  missing: true,
  'type-changed': true,
  added: false,
}

/**
 * What drifted between an observed host and the committed schema.
 *
 * An addition is reported, not failed: GitHub ships fields continuously, and a
 * suite that fails on every one of them trains people to ignore it. A field a
 * parser reads disappearing, or answering a form no parser can read, is a
 * failure — that is the drift that silently turns a merge button into a no-op.
 *
 * Direction matters, and it is decided by what the consumer declared rather than
 * by what the host happened to send. A host that narrows a declared nullable
 * field to its documented null form is not drift: a collection whose rows are all
 * outdated, or a check run still in progress, both answer null where a completed
 * record answered a value, and the parsers read both. What is drift is the other
 * direction, and the third thing a type list alone cannot show: a host that
 * answers a form the parser has no reader for is drift even when the same field
 * also answered a form it does, so a union that still holds the old type does not
 * excuse an added one. That question is asked of every field a parser depends on,
 * and not only of the ones that may be null: a pull request number or a stack
 * member's head answered as something the reader cannot use is substituted with a
 * default rather than dropped, so a union that still holds the number keeps the
 * identity wrong without reporting anything at all.
 */
export function compareSchemas(expected: ObservedSchema, observed: ObservedSchema): SchemaDrift[] {
  const drift: SchemaDrift[] = []
  for (const probe of SCHEMA_PROBES) {
    const before = typesByPath(expected.probes[probe.id] ?? [])
    const after = typesByPath(observed.probes[probe.id] ?? [])
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
          detail: 'the committed schema does not record it; regenerate the fixture to pin it',
        })
        continue
      }
      // Every form this field answered has to be one a reader can use. Asking only of
      // nullable fields would leave the fields that carry an identity unchecked, and
      // those are exactly the ones whose unreadable form is absorbed by a default.
      const readable = probe.readable[path]
      if (readable !== undefined) {
        const unreadable = [...found].filter((type) => !readable.includes(type))
        if (unreadable.length > 0) {
          drift.push({
            probe: probe.id,
            kind: 'type-changed',
            path,
            detail: `the host answered ${unreadable.sort().join('|')} and no parser reads that form of a field whose readable forms are ${[...readable].sort().join('|')}`,
          })
        }
      }
      // A field that answered only its documented null form narrowed; it did not stop
      // answering. Anything else that disappeared is a form the parser can no longer use.
      const narrowedToNull =
        readable?.includes('null') === true && found.size === 1 && found.has('null')
      const lost = [...wanted].filter((type) => type !== 'null' && !found.has(type))
      if (lost.length > 0 && !narrowedToNull) {
        drift.push({
          probe: probe.id,
          kind: 'type-changed',
          path,
          detail: `committed ${[...wanted].sort().join('|')}, host answered ${[...found].sort().join('|')}`,
        })
      }
      for (const type of found) {
        if (!wanted.has(type)) {
          drift.push({
            probe: probe.id,
            kind: 'added',
            path,
            detail: `host added the ${type} form of a field the committed schema pins as ${[...wanted].sort().join('|')}`,
          })
        }
      }
    }
    for (const [path, types] of after) {
      if (before.has(path)) continue
      for (const type of types) {
        drift.push({ probe: probe.id, kind: 'added', path, detail: `host added a ${type} field` })
      }
    }
  }
  return drift
}

function typesByPath(fields: readonly ObservedField[]): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>()
  for (const field of fields) {
    const types = byPath.get(field.path) ?? new Set<string>()
    types.add(field.type)
    byPath.set(field.path, types)
  }
  return byPath
}

/** Only the drift that means the committed fixtures are no longer trustworthy. */
export function breakingDrift(drift: readonly SchemaDrift[]): SchemaDrift[] {
  return drift.filter((entry) => BREAKING_KINDS[entry.kind])
}

/** Renders the committed document, stable so a regeneration produces a reviewable diff. */
export function renderSchema(schema: ObservedSchema): string {
  const body = {
    version: 1,
    source: schema.source,
    provenance: schema.provenance ?? {},
    probes: Object.fromEntries(
      Object.entries(schema.probes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, fields]) => [id, mergeObservedFields(fields)]),
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
