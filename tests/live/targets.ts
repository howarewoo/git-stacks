import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  setGitHubTransport,
  type GitHubTransport,
} from '../../src/main/github-transport'
import { githubHostContext, type GitHubHostContext } from '../../src/main/github-host'
import { detectNativeStacksCapability } from '../../src/main/native-stacks'
import { startAsyncMerge } from '../../src/main/merge-async'
import { createGitHubHarness, type GitHubHarness } from '../fixtures/github-harness'
import { startControlledGitHubHost, type ControlledGitHubHost } from '../fixtures/live-github-tls'
import { disposableRepositoryName, ownershipMarker, type LiveRunConfig } from './config'
import { GitHubAdmin } from './github-admin'
import { markerOnRepository, ownsMarker, ResourceLedger } from './provisioning'
import { FaultInjectingTransport } from './transport'
import { LocalGitWorkspace } from './workspace'
import type {
  LiveAdmin,
  LiveCapabilities,
  LiveCleanupReport,
  LiveReviewer,
  LiveTarget,
  LiveWorkspace,
} from './contract'

/**
 * The two disposable targets, written once.
 *
 * Both are the same thing seen from two places: a repository this run created and can
 * prove it owns, a real clone of it, the production transport pointed at the host that
 * serves it, and an admin surface for the resources the product never creates. The
 * scenarios are written against that shape, so the controlled runtime this repository
 * runs in CI and an authorized disposable repository on github.com exercise exactly the
 * same code paths — including the ones that are supposed to fail.
 */

/** The permissions that let an account merge, which the approval rules depend on. */
const MERGING_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

/** What every target must be built with, whatever serves it. */
export interface DisposableTargetSetup {
  readonly runId: string
  readonly marker: string
  readonly receiptPath: string
  readonly fullName: string
  readonly defaultBranch: string
  /**
   * The host this run's repository is on. It is passed in rather than derived from a
   * name because a controlled run's host is the address its own server was given, and
   * the clone's remote and this value have to be the same host or the run would be
   * reading one repository and writing to another.
   */
  readonly host: GitHubHostContext
  readonly ledger: ResourceLedger
  readonly transport: GitHubTransport
  readonly faults: FaultInjectingTransport
  readonly reviewer: LiveReviewer | null
  readonly workspace: LocalGitWorkspace
  readonly environment: NodeJS.ProcessEnv
}

/**
 * What every target does the same way: it stamps its marker on the repository, it proves
 * what the host can actually be asked to do, and it removes what it created.
 *
 * The two properties that make this safe enough to run unattended are both here. A
 * capability is proved by a real call rather than assumed, so a run reports a missing
 * merge queue instead of quietly passing. And cleanup re-reads the repository's own
 * marker before it deletes anything, so a name collision or a previous run's leftover is
 * reported as refused rather than removed.
 */
abstract class DisposableTarget implements LiveTarget {
  abstract readonly kind: 'controlled' | 'github'
  abstract readonly admin: LiveAdmin
  abstract readonly reviewer: LiveReviewer | null
  abstract repository(): string
  abstract workspace(): Promise<LiveWorkspace>
  readonly runId: string
  /** Resources this run owns, and the marker cleanup matches before deleting anything. */
  get resources(): ResourceLedger {
    return this.ledger
  }
  readonly marker: string
  readonly host: GitHubHostContext
  protected readonly fullName: string
  protected readonly defaultBranch: string
  protected readonly ledger: ResourceLedger
  private readonly environment: NodeJS.ProcessEnv
  private readonly injected: FaultInjectingTransport

  constructor(setup: DisposableTargetSetup) {
    this.runId = setup.runId
    this.marker = setup.marker
    this.receipt = setup.receiptPath
    this.fullName = setup.fullName
    this.defaultBranch = setup.defaultBranch
    this.host = setup.host
    this.ledger = setup.ledger
    this.environment = setup.environment
    this.injected = setup.faults
  }

  /**
   * The transport every scenario is handed, which is the run's own.
   *
   * A scenario may pass this transport explicitly, and a production module may resolve
   * the installed one instead. Both have to be the same object, or a fault a scenario
   * asked for would be injected into a call the scenario never made — and a run would
   * report a scenario green while the fault it staged never happened.
   */
  transport(): GitHubTransport {
    return this.injected
  }

  faults(): FaultInjectingTransport {
    return this.injected
  }

  private ownerAndRepo(): { owner: string; repo: string } {
    const separator = this.fullName.indexOf('/')
    return {
      owner: this.fullName.slice(0, separator),
      repo: this.fullName.slice(separator + 1),
    }
  }

  /** The commit a ref points at, which every probe and check attaches to. */
  private async headSha(ref: string): Promise<string> {
    return this.admin.headSha(this.fullName, ref)
  }

  /**
   * A disposable branch and pull request on the trunk, used only to ask the host
   * questions. It is opened through the same admin surface every scenario uses, so a
   * probe cannot succeed against a surface a scenario would fail against, and it is
   * recorded so a run that dies leaves it in the receipt.
   */
  private async openProbePullRequest(): Promise<{ branch: string; number: number }> {
    const branch = 'git-stacks-live-e2e-probe'
    const sha = await this.admin.createBranch(
      this.fullName,
      branch,
      await this.headSha(this.defaultBranch),
    )
    if (sha === '') throw new Error(`the host did not create the probe branch ${branch}`)
    this.ledger.record({
      kind: 'branch',
      handle: `${this.fullName}#${branch}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
    })
    const pull = await this.admin.createPullRequest({
      fullName: this.fullName,
      head: branch,
      base: this.defaultBranch,
      title: 'git-stacks live e2e capability probe',
      body: `Opened by the live GitHub suite for run ${this.runId}.`,
      draft: true,
    })
    this.ledger.record({
      kind: 'pull-request',
      handle: `${this.fullName}#${pull.number}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
    })
    return { branch, number: pull.number }
  }

  /**
   * Everything this run can actually be asked to do, observed rather than configured.
   *
   * A capability is never set from an assumption. The native stack surface is probed with
   * the product's own detector, the review-thread surface is asked about a real pull
   * request, a merge queue is configured and then read back off the rule set that
   * declares it, and a credential is answered by sending a write and seeing whether the
   * host takes it. Whatever could not be observed is recorded as a note, so a scenario
   * blocked later can say why instead of guessing.
   */
  async probeCapabilities(): Promise<LiveCapabilities> {
    const { owner, repo } = this.ownerAndRepo()
    const notes: string[] = []
    const observe = async (name: string, answer: () => Promise<boolean>): Promise<boolean> => {
      try {
        const yes = await answer()
        if (!yes) notes.push(`${name} is not available on this target`)
        return yes
      } catch (error) {
        notes.push(
          `${name} could not be probed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return false
      }
    }
    const probe = await this.openProbePullRequest()
    try {
      const nativeStacks = await observe('the native stacks surface', async () => {
        const detected = await detectNativeStacksCapability(owner, repo, {
          host: this.host,
          transport: this.transport(),
        })
        return detected.available
      })
      const asyncMerge = await observe('the asynchronous merge endpoint', () =>
        this.observeAsyncMerge(probe.number),
      )
      const checks = await observe('writing check runs', () =>
        this.admin.canWriteChecks(this.fullName),
      )
      const reviewThreads = await observe('review threads', () =>
        this.admin.supportsReviewThreads(this.fullName, probe.number),
      )
      const ruleSets = await observe('configuring rulesets', () =>
        this.admin.canManageRuleSets(this.fullName),
      )
      const mergeQueue = await observe('a merge queue', () => this.observeMergeQueue())
      const permission = await this.admin
        .viewerPermission(this.fullName, probe.number)
        .catch(() => 'UNKNOWN')
      if (!MERGING_PERMISSIONS.has(permission)) {
        notes.push(
          `this account holds ${permission} here, so it cannot merge its own pull requests`,
        )
      }
      return {
        nativeStacks,
        asyncMerge,
        checks,
        reviewThreads,
        ruleSets,
        mergeQueue,
        secondReviewer: this.reviewer !== null,
        canMerge: MERGING_PERMISSIONS.has(permission),
        notes,
      }
    } finally {
      await this.admin.closePullRequest(this.fullName, probe.number).catch(() => undefined)
      await this.admin.deleteBranch(this.fullName, probe.branch).catch(() => undefined)
    }
  }

  /**
   * The asynchronous merge endpoint, proved by a request the host must refuse on its own
   * rules: a merge whose head is the base it would move cannot land. A 404 is the only
   * answer that says the surface is not there, so any other refusal proves it is.
   */
  private async observeAsyncMerge(number: number): Promise<boolean> {
    try {
      await startAsyncMerge({
        fullName: this.fullName,
        number,
        sha: await this.headSha(this.defaultBranch),
        mergeMethod: null,
        mergeAction: 'direct_merge',
        host: this.host,
      })
      return true
    } catch (error) {
      if (
        error instanceof GitHubTransportError &&
        (error.status === 404 || error.kind === 'not-found')
      ) {
        return false
      }
      return true
    }
  }

  /**
   * A merge queue, proved by configuring one and reading it back off the rule set that
   * declares it. The rule set is removed again whether or not the read found it, so a
   * probe never leaves a standing rule behind on somebody's repository.
   */
  private async observeMergeQueue(): Promise<boolean> {
    const handle = `${this.fullName}/rulesets/queue-probe`
    const created = await this.admin.createRuleSet({
      name: `git-stacks live e2e merge queue probe (${this.runId})`,
      enforcement: 'disabled',
      mergeQueueBaseRefs: [this.defaultBranch],
    })
    const rulesetHandle = `${this.fullName}/rulesets/${created.id}`
    this.ledger.record({
      kind: 'rule-set',
      handle: rulesetHandle,
      marker: this.marker,
      createdAt: new Date().toISOString(),
    })
    try {
      return (await this.admin.mergeQueues(this.fullName)).includes(this.defaultBranch)
    } finally {
      if (await this.admin.deleteRuleSet(this.fullName, created.id))
        this.ledger.release(rulesetHandle)
      this.ledger.release(handle)
    }
  }

  /**
   * Remove everything this run created, and report what it refused to touch.
   *
   * The repository is the boundary. A resource inside a repository this run owns needs no
   * marker of its own, because the repository's own description is what proves the whole
   * thing is disposable; so the marker is checked first, and everything is refused when it
   * is missing. Rule sets and branches are removed explicitly before the repository, so a
   * run that fails partway leaves a receipt that names exactly what is still standing.
   */
  async cleanup(): Promise<LiveCleanupReport> {
    // Cleanup is reached from more than one place — the runner, a schema write, and the
    // command's own guard — and each has to be able to insist on it without knowing
    // whether another already did. The second call answers with what the first found
    // rather than re-proving ownership of a repository that is already deleted and
    // reporting the absence as a refusal.
    if (this.cleaned !== null) return this.cleaned
    this.cleaned = await this.runCleanup()
    return this.cleaned
  }

  private async runCleanup(): Promise<LiveCleanupReport> {
    await this.ledger.flush()
    if (this.ledger.list().every((entry) => entry.kind !== 'repository')) {
      for (const entry of this.ledger.outstanding()) {
        this.ledger.refuse(entry.handle, 'the run recorded no repository to prove it owns this')
      }
      return this.ledger.report()
    }
    let owned = false
    try {
      owned = ownsMarker(
        markerOnRepository(await this.admin.readRepository(this.fullName)),
        this.marker,
      )
    } catch (error) {
      this.ledger.refuse(
        this.fullName,
        `the repository could not be read back to prove ownership: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (!owned) {
      const reason = `${this.fullName} no longer carries this run's ownership marker`
      for (const entry of this.ledger.outstanding()) this.ledger.refuse(entry.handle, reason)
      await this.shutdown()
      return this.ledger.report()
    }

    for (const entry of this.ledger.outstanding()) {
      if (entry.kind !== 'rule-set') continue
      const id = Number(entry.handle.split('/').pop() ?? '')
      if (Number.isFinite(id) && (await this.admin.deleteRuleSet(this.fullName, id))) {
        this.ledger.release(entry.handle)
      } else {
        this.ledger.refuse(entry.handle, 'the host still has this rule set')
      }
    }
    for (const entry of this.ledger.outstanding()) {
      if (entry.kind !== 'branch') continue
      const branch = entry.handle.split('#')[1] ?? ''
      if (branch !== '' && (await this.admin.deleteBranch(this.fullName, branch))) {
        this.ledger.release(entry.handle)
      } else {
        this.ledger.refuse(entry.handle, 'the host still has this branch')
      }
    }
    // Nothing is left to record, so the receipt stops writing before the directories it
    // lives in are removed. A flush queued from an earlier release would otherwise race
    // the removal and leave a run reporting a failure it caused itself.
    this.ledger.close()
    if (await this.removeRepository(this.fullName)) {
      for (const entry of this.ledger.outstanding()) this.ledger.release(entry.handle)
    } else {
      this.ledger.refuse(this.fullName, 'the host still has this repository')
    }
    await this.shutdown()
    return this.ledger.report()
  }

  /** What the one cleanup this run did, so a second caller is told the same thing. */
  private cleaned: LiveCleanupReport | null = null

  /** Puts the process back the way the run found it, whatever cleanup managed. */
  protected async shutdown(): Promise<void> {
    setGitHubTransport(null)
    for (const [key, value] of Object.entries(this.environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in this.environment)) delete process.env[key]
    }
  }

  protected abstract removeRepository(fullName: string): Promise<boolean>

  /** The receipt this run writes, so a failed run is auditable after the fact. */
  readonly receipt: string
}

/** The target this repository runs in CI: a real TLS host over the API double. */
export class ControlledLiveTarget extends DisposableTarget {
  readonly kind = 'controlled' as const
  readonly admin: LiveAdmin
  readonly reviewer: LiveReviewer
  private readonly harness: GitHubHarness
  private readonly server: ControlledGitHubHost
  private readonly workspaceInstance: LocalGitWorkspace
  private readonly productionTransport: GitHubTransport

  private constructor(
    setup: DisposableTargetSetup & {
      harness: GitHubHarness
      server: ControlledGitHubHost
      productionTransport: GitHubTransport
    },
  ) {
    super(setup)
    this.harness = setup.harness
    this.server = setup.server
    this.workspaceInstance = setup.workspace as LocalGitWorkspace
    this.productionTransport = setup.productionTransport
    this.reviewer = setup.reviewer as LiveReviewer
    this.admin = new GitHubAdmin(setup.faults, setup.fullName, setup.marker)
  }

  /**
   * Builds the controlled target.
   *
   * The host serves the API double and Git's smart HTTP protocol from one socket, on a
   * certificate generated for this run, so the clone's `origin` is a real HTTPS URL that
   * the application resolves a host and a repository from and that its own fetches,
   * pushes, and API reads all reach. The certificate is verified rather than trusted
   * blindly: Git is told which authority to trust and the transport is pinned to the
   * same one, so a request that went anywhere else would fail rather than be believed.
   * Nothing in the run can reach github.com, because nothing in the run names it.
   */
  static async start(options: { receiptPath?: string } = {}): Promise<ControlledLiveTarget> {
    const environment = { ...process.env }
    // The bare repository is created where a host serving `/<owner>/<name>.git` can
    // reach it, so the clone and the API double are looking at one repository rather
    // than at two that agree with each other.
    const harness = await createGitHubHarness({ barePath: 'projects/acme/widgets.git' })
    const server = await startControlledGitHubHost({
      projectsRoot: join(harness.root, 'projects'),
      git: harness.env.GIT_STACKS_REAL_GIT as string,
    })
    const runId = `controlled-${newRunSuffix()}`
    const marker = ownershipMarker(runId)
    const state = await harness.readState()
    const fullName = `${state.repository.owner}/${state.repository.name}`
    state.repository.description = `Live suite target\n\n${marker}\n`
    state.repository.topics = ['git-stacks-live-e2e', `run-${runId}`]
    // The account that owns a disposable repository administers it. Saying so through
    // the field the repository read exposes is what lets a merge capability be observed
    // rather than assumed, and it is the same answer a real owner gets.
    state.checks = {
      ...state.checks,
      viewerPermissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    }
    await harness.writeState(state)

    Object.assign(process.env, {
      ...harness.env,
      GIT_STACKS_GITHUB_API_URL: server.url,
      GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    })
    setGitHubTransport(null)

    const ledger = new ResourceLedger({
      runId,
      marker,
      receiptPath: options.receiptPath ?? join(harness.root, 'live-github-e2e-receipt.json'),
    })
    ledger.record({
      kind: 'repository',
      handle: fullName,
      marker,
      createdAt: new Date().toISOString(),
    })
    await ledger.flush()

    const credential = (token: string): DirectGitHubTransport =>
      new DirectGitHubTransport({
        env: { ...process.env, GIT_STACKS_GITHUB_API_URL: server.url },
        fetch: server.fetch,
        apiUrl: server.url,
        graphqlUrl: `${server.url}/graphql`,
        host: server.host,
        token,
      })
    const productionTransport = credential((harness.env.GH_TOKEN as string) ?? 'fixture-token')
    const faults = new FaultInjectingTransport(productionTransport)
    setGitHubTransport(faults)

    return new ControlledLiveTarget({
      runId,
      marker,
      receiptPath: options.receiptPath ?? join(harness.root, 'live-github-e2e-receipt.json'),
      fullName,
      defaultBranch: state.repository.defaultBranch,
      host: githubHostContext(server.host),
      ledger,
      transport: productionTransport,
      faults,
      reviewer: {
        login: 'reviewer',
        transport: () => credential('fixture-reviewer-token'),
      },
      workspace: new LocalGitWorkspace({
        path: harness.repo,
        git: harness.env.GIT_STACKS_REAL_GIT as string,
        // The clone's origin is the URL this run's host serves the repository from, so
        // the host the application resolves and the host it pushes to are one host.
        origin: server.cloneUrl(fullName),
        cloneSource: server.cloneUrl(fullName),
        certificatePath: server.certificatePath,
        author: { name: 'Git Stacks live e2e', email: 'live-e2e@git-stacks.invalid' },
        root: harness.root,
      }),
      environment,
      harness,
      server,
      productionTransport,
    })
  }

  repository(): string {
    return this.fullName
  }

  async workspace(): Promise<LiveWorkspace> {
    return this.workspaceInstance
  }

  /** The requests the controlled host actually served, which is how a run is proved real. */
  servedRequests(): readonly { method: string; path: string; status: number }[] {
    return this.server.served
  }

  /** The local clone and the bare repository, which are this run's alone to remove. */
  protected async removeRepository(): Promise<boolean> {
    this.workspaceInstance.close()
    await this.server.close()
    await this.harness.close()
    return true
  }
}

/** The target an operator authorizes: a disposable repository on a real GitHub host. */
export class GitHubLiveTarget extends DisposableTarget {
  readonly kind = 'github' as const
  readonly admin: LiveAdmin
  readonly reviewer: LiveReviewer | null
  private readonly workspaceInstance: LocalGitWorkspace
  private readonly root: string

  private constructor(setup: DisposableTargetSetup & { root: string }) {
    super(setup)
    this.workspaceInstance = setup.workspace as LocalGitWorkspace
    this.root = setup.root
    this.reviewer = setup.reviewer
    this.admin = new GitHubAdmin(setup.faults, setup.fullName, setup.marker)
  }

  /**
   * Builds the authorized target.
   *
   * Nothing here has a default. The owner and the token are required, because a run
   * pointed at a repository somebody else owns is not a test that failed — it is a test
   * that deleted something. The repository is created with this run's marker in its own
   * description, that description is read straight back, and a repository without the
   * marker is a refusal rather than something to clean up afterwards.
   */
  static async start(config: LiveRunConfig): Promise<GitHubLiveTarget> {
    const environment = { ...process.env }
    const marker = ownershipMarker(config.runId)
    const name = disposableRepositoryName(config.repositoryPrefix, config.runId)
    const fullName = `${config.owner}/${name}`
    const ledger = new ResourceLedger({
      runId: config.runId,
      marker,
      receiptPath: config.receiptPath,
    })
    const productionTransport = new DirectGitHubTransport({
      token: config.token,
      host: 'github.com',
    })
    const faults = new FaultInjectingTransport(productionTransport)
    setGitHubTransport(null)
    setGitHubTransport(faults)
    const admin = new GitHubAdmin(faults, fullName, marker)

    await admin.createRepository({
      name,
      description: `Disposable target for the Git Stacks live suite, run ${config.runId}.`,
      marker,
    })
    ledger.record({
      kind: 'repository',
      handle: fullName,
      marker,
      createdAt: new Date().toISOString(),
    })
    await ledger.flush()

    const probe = await admin.readRepository(fullName)
    if (!ownsMarker(markerOnRepository(probe), marker)) {
      throw new Error(
        `${fullName} does not carry this run's ownership marker, so this run will not delete it`,
      )
    }
    const defaultBranch = probe.default_branch ?? 'main'
    const root = await mkdtemp(join(tmpdir(), `git-stacks-live-${name}-`))
    // The credential rides in a header supplied to every Git this process starts, and
    // never in the remote URL. A URL is read back by `git remote -v`, written into
    // `.git/config`, copied into a diagnostic, and quoted by a person; a header is in
    // none of them. The remote is therefore exactly the URL somebody would type.
    const remote = `https://github.com/${fullName}.git`
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    process.env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basicAuth(config.token)}`
    process.env.GIT_TERMINAL_PROMPT = '0'
    const workspace = await seedRemoteClone({ fullName, root, remote, defaultBranch })

    const reviewer = await buildReviewer(config, defaultBranch)
    return new GitHubLiveTarget({
      runId: config.runId,
      marker,
      receiptPath: config.receiptPath,
      fullName,
      defaultBranch,
      host: githubHostContext('github.com'),
      ledger,
      transport: productionTransport,
      faults,
      reviewer,
      workspace,
      environment,
      root,
    })
  }

  repository(): string {
    return this.fullName
  }

  async workspace(): Promise<LiveWorkspace> {
    return this.workspaceInstance
  }

  protected async removeRepository(fullName: string): Promise<boolean> {
    const removed = await this.admin.deleteRepository(fullName)
    this.workspaceInstance.close()
    await rm(this.root, { recursive: true, force: true })
    return removed
  }
}

/** The second account, or null when the run was not given one. */
async function buildReviewer(
  config: LiveRunConfig,
  _defaultBranch: string,
): Promise<LiveReviewer | null> {
  if (!config.reviewerToken) return null
  const transport = new DirectGitHubTransport({ token: config.reviewerToken, host: 'github.com' })
  const login = await transport
    .rest<{ login?: string }>({ path: 'user' })
    .then((response) => (typeof response.data?.login === 'string' ? response.data.login : ''))
    .catch(() => '')
  return { login, transport: () => transport }
}

/**
 * A clone of a real disposable repository, with an initial commit on its default branch.
 *
 * A repository created through the API with `auto_init` disabled has no branches, and a
 * run that needs one has to make it the way a person would: with Git, over the
 * repository's own HTTPS remote, using a credential that never reaches a log.
 */
async function seedRemoteClone(input: {
  fullName: string
  root: string
  remote: string
  defaultBranch: string
}): Promise<LocalGitWorkspace> {
  const git = resolveRealGit()
  const clone = join(input.root, 'clone')
  execFileSync(git, ['init', '-b', input.defaultBranch, clone], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  execFileSync(git, ['-C', clone, 'config', 'user.name', 'Git Stacks live e2e'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  execFileSync(git, ['-C', clone, 'config', 'user.email', 'live-e2e@git-stacks.invalid'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await writeFile(join(clone, 'README.md'), '# live e2e target\n', 'utf8')
  execFileSync(git, ['-C', clone, 'add', '--', 'README.md'], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync(git, ['-C', clone, 'commit', '-m', 'live e2e baseline'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  execFileSync(git, ['-C', clone, 'remote', 'add', 'origin', input.remote], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // No credential is in the URL and none is in this repository's configuration: the
  // header the run installed is inherited by every Git started from here, the
  // application included, so a push the product makes is authorized the same way.
  execFileSync(git, ['-C', clone, 'push', 'origin', `HEAD:refs/heads/${input.defaultBranch}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return new LocalGitWorkspace({
    path: clone,
    git,
    cloneSource: input.remote,
    author: { name: 'Git Stacks live e2e', email: 'live-e2e@git-stacks.invalid' },
    root: input.root,
  })
}

/**
 * The header value that authorizes Git against the repository, as base64.
 *
 * GitHub's documented form for a personal access token over HTTPS is the token as a
 * password with `x-access-token` as the user, which is what the run sends. The token is
 * encoded, never concatenated into a URL.
 */
function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

/** A short suffix, so two runs on one machine never name a repository the same. */
function newRunSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * The one real `git`, resolved the way the platform does rather than assumed: `which` is a
 * POSIX program Windows does not have, and a fixed path names nothing on the others.
 */
export function resolveRealGit(): string {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `git${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        continue
      }
    }
  }
  throw new Error('The live suite needs a real git executable on PATH')
}
