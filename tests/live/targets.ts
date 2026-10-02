import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DirectGitHubTransport,
  GitHubTransportError,
  installedGitHubTransport,
  setGitHubTransport,
  type GitHubTransport,
} from '../../src/main/github-transport'
import { githubHostContext, type GitHubHostContext } from '../../src/main/github-host'
import { detectNativeStacksCapability } from '../../src/main/native-stacks'
import { startAsyncMerge } from '../../src/main/merge-async'
import {
  claimLiveGit,
  createGitHubHarness,
  WRITING_ROLES,
  type GitHubFixtureState,
  type GitHubHarness,
} from '../fixtures/github-harness'
import { startControlledGitHubHost, type ControlledGitHubHost } from '../fixtures/live-github-tls'
import { disposableRepositoryName, ownershipMarker, type LiveRunConfig } from './config'
import { describeThrown, LiveRedactor } from './diagnostics'
import { GitHubAdmin } from './github-admin'
import { installIsolatedGitEnvironment, type IsolatedGitEnvironment } from './git-environment'
import { ownsCreatedResource, repositoryOf, ResourceLedger } from './provisioning'
import type {
  LiveActor,
  LiveAdmin,
  LiveCapabilities,
  LiveCleanupReport,
  LiveForeignKind,
  LiveForeignPullRequest,
  LiveRepositoryIdentity,
  LiveResource,
  LiveReviewer,
  LiveTarget,
  LiveWorkspace,
} from './contract'
import { FaultInjectingTransport, LiveRequestPacing } from './transport'
import { GIT_TIMEOUT_MS, LocalGitWorkspace } from './workspace'

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

/** The identity every commit and clone of this run is made with. */
const AUTHOR = { name: 'Git Stacks live e2e', email: 'live-e2e@git-stacks.invalid' } as const

/**
 * A run that failed while it was still provisioning, and what it left behind.
 *
 * The distinction matters because the two exits mean opposite things. A run that
 * never created anything is refused, and nothing should be retried without changing
 * the environment. A run that created a repository and then failed on a receipt
 * write, a temporary directory, a Git command or a push has a leftover that only this
 * report can name — and reporting it as a plain refusal would tell an operator there
 * is nothing to clean up while their account is holding a private repository with
 * this run's marker in its description.
 */
export class LiveProvisioningFailure extends Error {
  readonly report: LiveCleanupReport
  readonly receipt: string

  constructor(reason: string, report: LiveCleanupReport, receipt: string) {
    super(reason)
    this.name = 'LiveProvisioningFailure'
    this.report = report
    this.receipt = receipt
  }
}

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
  /** The account this run spends its own credential as, resolved before any mutation. */
  readonly primary: LiveActor
  readonly ledger: ResourceLedger
  readonly transport: GitHubTransport
  readonly faults: FaultInjectingTransport
  readonly reviewer: LiveReviewer | null
  readonly workspace: LocalGitWorkspace
  /** The isolated Git environment, which is also what the process was given. */
  readonly git: IsolatedGitEnvironment
  /** Where this run's local files live, and which are removed with it. */
  readonly root: string
  /**
   * Whatever transport this process held before this run installed its own, which is
   * what teardown puts back. `setGitHubTransport` replaces rather than stacks, so
   * reading the installed one afterwards would answer with a transport resolved from the
   * environment — a different object, which is how a run ends up restoring somebody
   * else's transport and calling the process clean.
   */
  readonly previousTransport: GitHubTransport | null
  /**
   * The transport this run installed, kept so teardown can tell whether it is still the
   * one in place. A restore that does not check would overwrite a transport another owner
   * put there after this run started.
   */
  readonly installedTransport: GitHubTransport
  /** The admin surface bound to the reviewer credential, for reviewer-owned work. */
  readonly reviewerAdmin: LiveAdmin | null
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
  abstract foreignPullRequest(kind: LiveForeignKind): Promise<LiveForeignPullRequest>
  readonly runId: string
  /** Resources this run owns, and the marker cleanup matches before deleting anything. */
  get resources(): ResourceLedger {
    return this.ledger
  }
  readonly marker: string
  readonly host: GitHubHostContext
  /** The branch the host provisioned, which is the trunk every scenario builds on. */
  readonly defaultBranch: string
  /** The account this run's own credential belongs to, resolved before anything exists. */
  readonly primary: LiveActor
  protected readonly fullName: string
  protected readonly ledger: ResourceLedger
  protected readonly root: string
  protected git: IsolatedGitEnvironment
  protected readonly reviewerAdmin: LiveAdmin | null
  private readonly previousTransport: GitHubTransport | null
  private readonly installedTransport: GitHubTransport
  private readonly injected: FaultInjectingTransport

  constructor(setup: DisposableTargetSetup) {
    this.runId = setup.runId
    this.marker = setup.marker
    this.receipt = setup.receiptPath
    this.fullName = setup.fullName
    this.defaultBranch = setup.defaultBranch
    this.host = setup.host
    this.primary = setup.primary
    this.ledger = setup.ledger
    this.root = setup.root
    this.git = setup.git
    this.reviewerAdmin = setup.reviewerAdmin
    this.previousTransport = setup.previousTransport
    this.installedTransport = setup.installedTransport
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
   *
   * The branch is pushed rather than created empty. A pull request whose head is the
   * base branch's own commit has no comparison to propose, and a real host refuses to
   * create it at all — so a probe built that way does not prove the surface exists, it
   * proves the suite is stopped before its first scenario. The change is committed in
   * a clone of this run's own remote and pushed as an ordinary branch, which is the
   * same path a scenario's layers take.
   */
  private async openProbePullRequest(): Promise<{ branch: string; number: number }> {
    const branch = 'git-stacks-live-e2e-probe'
    await this.ledger.intent({
      kind: 'branch',
      handle: `${this.fullName}#${branch}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: this.primary.login,
    })
    const workspace = await this.workspace()
    workspace.git(['checkout', '-B', branch, await this.headSha(this.defaultBranch)])
    await workspace.commit(
      'git-stacks-live-e2e-probe.txt',
      `Capability probe for run ${this.runId}.\n`,
      'live e2e: capability probe change',
    )
    await workspace.push(branch)
    this.ledger.confirm(`${this.fullName}#${branch}`)
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
      actor: this.primary.login,
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
        this.admin.canManageRuleSets(this.fullName, this.defaultBranch),
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
        // A reviewer exists here only if the host confirmed it can reach this
        // repository, so this reports access rather than the presence of a token.
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
   *
   * The rule names the branch it queues rather than every branch on the repository:
   * an unnamed ref condition is not a stricter queue, it is a different resource, and
   * one the host may reject outright for an account perfectly allowed to configure
   * queues.
   */
  private async observeMergeQueue(): Promise<boolean> {
    const created = await this.admin.createRuleSet({
      name: `git-stacks live e2e merge queue probe (${this.runId})`,
      enforcement: 'disabled',
      baseRefs: [`refs/heads/${this.defaultBranch}`],
      mergeQueue: true,
    })
    const rulesetHandle = `${this.fullName}/rulesets/${created.id}`
    this.ledger.record({
      kind: 'rule-set',
      handle: rulesetHandle,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      remoteId: created.id,
      actor: this.primary.login,
    })
    try {
      return (await this.admin.mergeQueues(this.fullName)).includes(this.defaultBranch)
    } finally {
      if (await this.admin.deleteRuleSet(this.fullName, created.id))
        this.ledger.release(rulesetHandle)
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
   *
   * A child that cannot be removed is recorded and stepped over rather than thrown from.
   * Everything a rule set or a branch contains dies with the repository this run has
   * already proved it owns, so one refused child deletion must not be the reason a whole
   * disposable repository survives the run that created it — and the refusal is still in
   * the receipt, so nothing about it is hidden.
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
    // The host side and the local side are settled independently, and both are awaited
    // before the report is taken. A run that answers while its socket is still listening
    // or while it still holds this process's real `git` reports a cleanup that has not
    // happened, so the local side is released here rather than in a `finally` a throw
    // could step over — and neither side is allowed to depend on the other having
    // worked. A side that fails is reported: what is left behind is exactly the thing a
    // person has to come back for.
    const failures: string[] = []
    try {
      await this.settleCleanup()
    } catch (error) {
      failures.push(`the host side could not be settled: ${describeThrown(error)}`)
    }
    for (const failure of await this.releaseEverything()) failures.push(failure)
    for (const failure of failures) this.ledger.noteLocalFailure(failure)
    // The last update reaches the disk before the receipt stops accepting them, on every
    // path. Closing first makes every later update memory-only, so the published
    // artifact keeps listing a repository this run has already deleted.
    await this.ledger.flush()
    await this.ledger.close()
    return this.ledger.report()
  }

  /**
   * What cleanup managed against the host, decided before any local state is let go.
   *
   * A failure in here is a failure of one step. The receipt is flushed, a resource is
   * released or refused, and the next step still runs: a run that could not remove a
   * rule set should still remove the repository holding it, and should still get its
   * own process back. Every path out of here leaves the receipt flushed and open, so
   * the caller closes it once the local side has been settled too.
   */
  private async settleCleanup(): Promise<void> {
    await this.ledger.flush()
    if (this.ledger.list().every((entry) => entry.kind !== 'repository')) {
      for (const entry of this.ledger.outstanding()) {
        this.ledger.refuse(entry.handle, 'the run recorded no repository to prove it owns this')
      }
      await this.ledger.flush()
      return
    }
    // A repository whose creation was never confirmed is reconciled rather than assumed
    // either way: the receipt already says what was asked for, so a fresh read decides
    // whether the host holds it. Re-sending the creation would be the one response that
    // can turn an unknown outcome into two repositories. The three answers stay three:
    // a name the host does not have, a name it holds under somebody else's marker, and a
    // read that failed are different events, and a repository that is still standing
    // under a conflicting marker is not this run's to release.
    for (const entry of this.ledger.unresolved()) {
      if (entry.kind !== 'repository') continue
      const admin = this.adminFor(entry.actor)
      if (admin === null) {
        this.ledger.refuse(
          entry.handle,
          `no credential in this run acts as ${entry.actor ?? 'the account that was asked to create it'}`,
        )
        continue
      }
      // A host that does not have it is an answer, and so is one that does — but only
      // when what it has is provably the thing that was asked for. A name that has since
      // been taken by somebody else's repository is not this run's lost response, and
      // confirming it would hand a repository nobody created to this run's own cleanup.
      // The read is made with the credential that owns the name, because another one may
      // not be able to see it and would report an absent repository that is very much
      // present.
      // Awaited into a local, never held as a promise across the branches below: the
      // loop refines this same receipt's journal, and a half-read identity compared
      // against a promise decides nothing.
      const outcome = await readRepositoryIdentity(
        admin,
        entry.handle,
        entry.marker ?? this.marker,
        typeof entry.remoteId === 'number' ? entry.remoteId : undefined,
      )
      if (outcome.outcome === 'present') this.ledger.confirm(entry.handle, outcome.identity.id)
      else if (outcome.outcome === 'absent') this.ledger.release(entry.handle)
      else if (outcome.outcome === 'conflict') {
        this.ledger.refuse(
          entry.handle,
          `a repository of that name exists and does not carry this run's marker, so it is not this run's to remove`,
        )
      } else {
        this.ledger.refuse(
          entry.handle,
          `the host could not be asked whether it still holds it: ${outcome.reason}`,
        )
      }
    }
    let owned = false
    try {
      owned = ownsCreatedResource(
        await this.admin.readRepository(this.fullName),
        this.marker,
        this.recordedId(this.fullName),
      )
    } catch (error) {
      this.ledger.refuse(
        this.fullName,
        `the repository could not be read back to prove ownership: ${describeThrown(error)}`,
      )
    }
    if (!owned) {
      const reason = `${this.fullName} no longer carries this run's ownership marker`
      for (const entry of this.ledger.outstanding()) this.ledger.refuse(entry.handle, reason)
      await this.ledger.flush()
      return
    }

    // The contents of the primary repository, and only those. `repositoryOf` reads a
    // handle as its own kind, so a branch recorded against a foreign repository is not
    // mistaken for one of this repository's and deleted here against a name whose owner
    // has not been checked — which is how a run ends up deleting a branch in a
    // repository somebody else now owns.
    for (const entry of this.ledger.outstanding()) {
      if (repositoryOf(entry) !== this.fullName) continue
      if (entry.kind === 'rule-set') {
        const id = Number(entry.handle.split('/').pop() ?? '')
        if (
          Number.isFinite(id) &&
          (await this.attempt(() => this.admin.deleteRuleSet(this.fullName, id)))
        ) {
          this.ledger.release(entry.handle)
        } else {
          this.ledger.refuse(entry.handle, 'the host still has this rule set')
        }
      }
      if (entry.kind === 'branch') {
        const branch = entry.handle.split('#')[1] ?? ''
        const admin = this.adminFor(entry.actor) ?? this.admin
        if (
          branch !== '' &&
          (await this.attempt(() => admin.deleteBranch(this.fullName, branch)))
        ) {
          this.ledger.release(entry.handle)
        } else {
          this.ledger.refuse(entry.handle, 'the host still has this branch')
        }
      }
    }
    // A repository this run created under another account — the reviewer's fork, or a
    // second disposable repository of its own — is removed with that account's own
    // credential, and only after its own marker has been read back. Removing it through
    // the primary would either fail or, worse, succeed against something else. Its
    // contents are settled from that repository's own answer: released when it is gone,
    // and reported as still standing when it is not, because a repository this run
    // refused to remove has left every ref inside it exactly where it was.
    const settled = new Set<string>()
    for (const entry of this.ledger.outstanding()) {
      if (entry.kind !== 'repository' || entry.handle === this.fullName) continue
      if (await this.removeForeignRepository(entry)) {
        settled.add(entry.handle)
        this.ledger.release(entry.handle)
        for (const child of this.ledger.outstanding()) {
          if (repositoryOf(child) === entry.handle) this.ledger.release(child.handle)
        }
      } else {
        if (this.adminFor(entry.actor) === null) {
          this.ledger.refuse(
            entry.handle,
            `no credential in this run acts as ${entry.actor ?? 'the owning account'}`,
          )
        } else if (entry.refused === undefined) {
          this.ledger.refuse(entry.handle, "the host still has it, or it is no longer this run's")
        }
        for (const child of this.ledger.outstanding()) {
          if (child.kind === 'repository' || repositoryOf(child) !== entry.handle) continue
          this.ledger.refuse(
            child.handle,
            `the repository that holds it, ${entry.handle}, is still standing`,
          )
        }
      }
    }
    // The receipt stays writable until the repository itself has been removed or refused.
    // Closing it first is what produced a published artifact listing a deleted repository
    // as outstanding while the run reported a complete cleanup; the close itself now
    // belongs to the caller, which takes it once the local side has been settled too.
    const removed = await this.attempt(() => this.removeRepository(this.fullName))
    if (removed) {
      // Only what the deleted repository contained. A separate repository this run also
      // created, and refused or failed to remove a moment ago, is a different resource
      // with its own marker and its own account: settling it because the primary went
      // away marks a repository that is still standing as deleted, and a recovery run
      // reads `deletedAt` as "already gone" and skips it for ever.
      for (const entry of this.ledger.outstanding()) {
        // A handle the receipt cannot place inside a repository names none at all, and
        // this loop has just established that the repository it might have belonged to is
        // gone. Refusing it is the only answer that does not invent an owner.
        const repository = repositoryOf(entry)
        if (repository === null) {
          this.ledger.refuse(
            entry.handle,
            'the receipt does not say which repository this belongs to, so it could not be settled',
          )
        } else if (repository === this.fullName) {
          this.ledger.release(entry.handle)
        } else if (entry.kind !== 'repository' && !settled.has(repository)) {
          this.ledger.refuse(
            entry.handle,
            'the receipt does not say which repository this belongs to, so it could not be settled',
          )
        }
      }
    } else {
      this.ledger.refuse(this.fullName, 'the host still has this repository')
    }
    await this.ledger.flush()
  }

  /**
   * One cleanup step, reported rather than thrown.
   *
   * The reason a failure is not raised here is that everything this step would have
   * removed is inside a repository whose own marker has already been verified. Letting
   * a refused child deletion end the run would leave the whole disposable repository
   * standing, which is a worse outcome than a rule set that needed removing twice — and
   * the failure is still written to the receipt either way.
   */
  private async attempt(step: () => Promise<boolean>): Promise<boolean> {
    try {
      return await step()
    } catch {
      return false
    }
  }

  /**
   * The credential that acts as an account, or null when this run holds none.
   *
   * A repository is named by the account it belongs to, not by the run that made it.
   * Reading or deleting one with the wrong credential answers 404 for a private
   * repository the run itself created, which is a refusal that says nothing true — so
   * the actor recorded with the resource decides whose credential is used, and an
   * account this run has no credential for is a refusal rather than a guess.
   *
   * The comparison is on the folded login rather than the string. A receipt records
   * whatever the host spelled, and a host is free to answer `Alice` where an earlier
   * read said `alice`; treating those as two accounts would make this run refuse its
   * own resources for want of a credential it is holding, and would hide the reverse
   * mistake — one account's resources reached with another's credential.
   */
  private adminFor(actor: string | undefined): LiveAdmin | null {
    if (actor === undefined || actor === '') return this.admin
    const login = actor.toLowerCase()
    if (login === this.primary.login.toLowerCase()) return this.admin
    if (this.reviewer !== null && login === this.reviewer.login.toLowerCase()) {
      return this.reviewerAdmin
    }
    return null
  }

  /**
   * Removes a repository another account of this run created, with that account's own
   * credential, after reading its marker back.
   *
   * Both halves matter. The credential is the actor's, because a fork belongs to the
   * account that made it and no other credential may delete it. And the marker is
   * checked first, because the receipt's record of what this run created is not itself
   * proof that the repository standing at that name is still the one.
   */
  private async removeForeignRepository(entry: LiveResource): Promise<boolean> {
    const admin = this.adminFor(entry.actor)
    if (admin === null) return false
    try {
      // The same two things the primary is held to: this run's marker, matched whole,
      // and the id the host named for this resource when it was created. A marker alone
      // is a line of text that survives a deletion and a reuse of the same name.
      if (
        !ownsCreatedResource(await admin.readRepository(entry.handle), this.marker, entry.remoteId)
      ) {
        this.ledger.refuse(entry.handle, "it no longer carries this run's ownership marker")
        return false
      }
      return await admin.deleteRepository(entry.handle)
    } catch {
      return false
    }
  }

  /**
   * The id the host named for a repository this run confirmed creating, if it did.
   *
   * The receipt holds it, so the cleanup path can require it rather than re-deriving
   * one from a name that may since have been reused.
   */
  private recordedId(handle: string): number | undefined {
    return this.ledger.list().find((entry) => entry.handle === handle)?.remoteId
  }

  /** What the one cleanup this run did, so a second caller is told the same thing. */
  private cleaned: LiveCleanupReport | null = null

  /**
   * Puts this run's own state back, whatever the host did, and reports what could not be.
   *
   * Three separate things are given back here, and none of them may depend on the
   * others. The global transport goes first, because it is the one holding a credential
   * in a place any later command in this process can reach. The process environment goes
   * next, because it holds the run's Git credential headers. The local resources go last
   * and unconditionally, because a repository whose deletion was refused or whose read
   * threw still leaves a clone, a directory and — in a controlled run — a listening
   * socket behind, and a socket nobody closes holds the event loop open so the process
   * does not exit at all.
   *
   * The transport is restored only while it is still this run's. `setGitHubTransport`
   * replaced rather than stacked, so putting the previous value back is only correct if
   * the slot still holds what this run put there; if something else installed a
   * transport in the meantime, that other owner would silently lose its own — so the
   * restore is skipped and reported instead. A blind overwrite would report a clean
   * process while having removed somebody else's credential from it.
   *
   * Nothing here is thrown over: a restore that cannot rewrite the process, or a
   * directory that will not delete, is returned as a failure for the report so the
   * receipt still says what a person has to come back for.
   */
  private async releaseEverything(): Promise<string[]> {
    const failures: string[] = []
    for (const give of [
      () => releaseOwnedTransport(this.installedTransport, this.previousTransport),
      () => this.git.restore(),
      () => this.releaseLocal(),
    ]) {
      try {
        await give()
      } catch (error) {
        failures.push(describeThrown(error))
      }
    }
    return failures
  }

  /** The files, listeners and helpers this run opened, and only those. */
  protected abstract releaseLocal(): Promise<void>

  protected abstract removeRepository(fullName: string): Promise<boolean>

  /**
   * Teaches the process one more URL-scoped credential, for a repository this run
   * created later.
   *
   * A run acts as more than one account, and each account's token belongs to exactly
   * one remote. Git matches `http.<url>.extraheader` by URL prefix, so a header scoped
   * to the primary's repository is simply not offered to the reviewer's fork — which
   * is the whole reason the credential is a header and not a URL. Adding one is an
   * extension of the environment already installed rather than a second install over
   * it, so one restore still puts the process back exactly as it was found.
   */
  protected async extendGitCredentials(url: string, token: string): Promise<void> {
    this.git = await installIsolatedGitEnvironment({
      home: this.root,
      author: AUTHOR,
      extend: this.git,
      credentials: [{ url, header: `AUTHORIZATION: basic ${basicAuth(token)}` }],
    })
    this.git.install()
  }

  /** The receipt this run writes, so a failed run is auditable after the fact. */
  readonly receipt: string
}

/** The target this repository runs in CI: a real TLS host over the API double. */
export class ControlledLiveTarget extends DisposableTarget {
  readonly kind = 'controlled' as const
  readonly admin: LiveAdmin
  readonly reviewer: LiveReviewer
  private readonly harnessInstance: GitHubHarness
  private readonly server: ControlledGitHubHost
  private readonly workspaceInstance: LocalGitWorkspace
  private readonly productionTransport: GitHubTransport
  private readonly foreign = new Map<LiveForeignKind, LiveForeignPullRequest>()

  private constructor(
    setup: DisposableTargetSetup & {
      harness: GitHubHarness
      server: ControlledGitHubHost
      productionTransport: GitHubTransport
    },
  ) {
    super(setup)
    this.harnessInstance = setup.harness
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
  static async start(
    options: { receiptPath?: string; defaultBranch?: string } = {},
  ): Promise<ControlledLiveTarget> {
    // From the very first statement this run owns something, and the guard below is
    // open before it owns anything. That ordering is the whole point: the harness runs
    // real Git to create and seed the repository this host serves, so a caller that
    // installed its Git isolation afterwards would already have run Git against the
    // ambient environment — an inherited `GIT_DIR`, a `credential.helper`, a
    // `core.hooksPath`, a global signing key — before the boundary that exists to stop
    // exactly that. So the directory is made first, the isolation is installed on it,
    // and only then does anything else get created.
    //
    // A listener nobody closes holds the event loop open for the rest of the process,
    // so a run that fails anywhere below does not fail: it hangs until whatever is
    // waiting on it gives up. Each resource is recorded the moment it exists, because
    // a throw means there is no end to collect at.
    const opened: {
      git?: IsolatedGitEnvironment
      harness?: GitHubHarness
      server?: ControlledGitHubHost
      workspace?: LocalGitWorkspace
      root?: string
      previousTransport?: GitHubTransport | null
      installedTransport?: GitHubTransport
    } = {}
    try {
      opened.root = await mkdtemp(join(tmpdir(), 'git-stacks-live-controlled-'))
      const git = await installIsolatedGitEnvironment({
        home: opened.root,
        author: AUTHOR,
      })
      opened.git = git
      // `install`, not `Object.assign`: merging adds and overwrites but never removes,
      // so the retired variables would still be in the process while every Git the
      // application's own services start inherits them.
      git.install()
      // The bare repository is created where a host serving `/<owner>/<name>.git` can
      // reach it, so the clone and the API double are looking at one repository rather
      // than at two that agree with each other.
      const harness = await createGitHubHarness({
        barePath: 'projects/acme/widgets.git',
        root: opened.root,
        confineGitToRoot: true,
        // The host's own default, not this run's assumption about it. A controlled host
        // configured for another name has to be able to say so, or a suite that reads
        // the branch back from the host would still never meet one that is not `main`.
        defaultBranch: options.defaultBranch,
        preserveRoot: true,
      })
      opened.harness = harness
      const server = await startControlledGitHubHost({
        projectsRoot: harness.projectsRoot,
        git: harness.env.GIT_STACKS_REAL_GIT as string,
        authorizeGit: (fullName, authorization) =>
          authorizeGitFor(harness, fullName, authorization),
      })
      opened.server = server
      // The host's clone URLs are registered as this run's own, and only now that the
      // authority is known. Without this the transport rule has no way to tell this run's
      // own `127.0.0.1` URL from an unowned one and refuses the scenarios' `ls-remote` —
      // which is what keeps the rule safe rather than wrong: an address is answerable
      // because the run registered that exact URL, never because of its shape. Every
      // repository created from here on is registered as it is created, so a fork or a
      // foreign subject made mid-scenario is answerable on the same host too.
      harness.serveClonesFor(server.cloneUrl)
      return await ControlledLiveTarget.build({ harness, server, options, opened })
    } catch (error) {
      // Each of these was opened independently and none can be released twice, so each
      // is given back on its own. A socket whose close threw must not be the reason the
      // harness that answers for it and the temporary directory holding this run's
      // isolated Git home are both kept: the first would keep every later request in
      // this process hanging, the second would keep a directory with a credential header
      // in it on disk.
      // The process is put back first and on its own, because restoring the environment
      // is synchronous: it is not a promise and it must not be skipped because an earlier
      // release threw. Leaving a credential header's `HOME` installed would affect every
      // Git this process starts after the run.
      try {
        opened.git?.restore()
      } catch {
        // Nothing here can be given back a second time, and the original failure is the
        // one the caller needs.
      }
      // Each is awaited under its own guard rather than chained with `.catch`, because
      // they are not all the same kind of thing: putting a transport back is
      // synchronous, while closing a socket and deleting a directory are not. A chain
      // that assumes a promise skips the synchronous one, which is the one that has to
      // happen before anything else starts reading the process.
      for (const release of [
        () => releaseOwnedTransport(opened.installedTransport, opened.previousTransport ?? null),
        () => opened.server?.close(),
        () => opened.harness?.close(),
        opened.root === undefined
          ? null
          : () => rm(opened.root as string, { recursive: true, force: true }),
      ]) {
        if (release === null) continue
        try {
          await release()
        } catch {
          // Nothing here can be given back a second time, and the failure that sent us
          // down this path is the one the caller needs to see.
        }
      }
      throw error
    }
  }

  private static async build(input: {
    harness: GitHubHarness
    server: ControlledGitHubHost
    options: { receiptPath?: string }
    /**
     * What this run has opened so far, so the caller's guard can close it. It is
     * written as each thing is created rather than collected at the end, because a
     * throw means there is no end to collect at.
     */
    opened: {
      git?: IsolatedGitEnvironment
      harness?: GitHubHarness
      server?: ControlledGitHubHost
      workspace?: LocalGitWorkspace
      root?: string
      previousTransport?: GitHubTransport | null
      installedTransport?: GitHubTransport
    }
  }): Promise<ControlledLiveTarget> {
    const { harness, server, opened } = input
    const options = input.options
    const runId = `controlled-${newRunSuffix()}`
    const marker = ownershipMarker(runId)
    const state = await harness.readState()
    const fullName = `${state.repository.owner}/${state.repository.name}`
    state.repository.description = `Live suite target\n\n${marker}\n`
    state.repository.topics = ['git-stacks-live-e2e', `run-${runId}`]
    // Private, so that "the reviewer can reach it" means a grant was enforced rather
    // than that a public repository answered for everybody. Without this the second
    // account's distinctness is proved by a host that was never asked the question.
    state.repository.private = true
    state.repository.permissions = {
      [state.currentUser.toLowerCase()]: 'admin',
    }
    // The account that owns a disposable repository administers it. Saying so through
    // the field the repository read exposes is what lets a merge capability be observed
    // rather than assumed, and it is the same answer a real owner gets.
    state.checks = {
      ...state.checks,
      viewerPermissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    }
    await harness.writeState(state)

    // The socket's certificate is the one thing that could not be known before the host
    // existed, so this extends the environment already installed rather than replacing
    // it: a second install would capture the first one's isolation as "the process as it
    // was found", and restoring it would leave every retired variable retired for good.
    // Each credential is scoped to the exact URL of the repository it is for, so the
    // reviewer's token is never offered to the primary's remote and the primary's is
    // never offered to the reviewer's fork.
    const git = await installIsolatedGitEnvironment({
      home: harness.root,
      author: AUTHOR,
      extend: opened.git,
      gitTlsCaInfo: server.certificatePath,
      credentials: [
        {
          url: server.cloneUrl(fullName),
          header: `AUTHORIZATION: basic ${basicAuth(harness.primaryToken)}`,
        },
      ],
    })
    opened.git = git
    git.install()
    // The keys this host owns, not `harness.env`. That object is the whole process as
    // it was before isolation, so merging it here would put every variable the install
    // above just retired back into the process for the rest of the run — including, on
    // this very path, a certificate check the run had already turned off for Git.
    Object.assign(process.env, harness.ownedEnvironment, {
      GIT_STACKS_GITHUB_API_URL: server.url,
      GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    })
    // Installing replaces rather than stacks, so whatever was here is taken and kept for
    // teardown to put back. Reading the installed transport afterwards would not do it:
    // `githubTransport()` answers with one resolved from the environment when nothing is
    // installed, which is a different object, and restoring that would leave the process
    // holding a transport this run never owned.
    opened.previousTransport = setGitHubTransport(null)

    const receiptPath = options.receiptPath ?? join(harness.root, 'live-github-e2e-receipt.json')
    const redact = new LiveRedactor([harness.primaryToken, harness.reviewer.token]).text
    const ledger = new ResourceLedger({
      runId,
      marker,
      receiptPath,
      host: server.host,
      owner: state.currentUser,
      redact,
    })
    const credential = (token: string): DirectGitHubTransport =>
      new DirectGitHubTransport({
        env: { ...process.env },
        fetch: server.fetch,
        apiUrl: server.url,
        graphqlUrl: `${server.url}/graphql`,
        host: server.host,
        token,
      })
    const productionTransport = credential(harness.primaryToken)
    const faults = new FaultInjectingTransport(productionTransport)
    setGitHubTransport(faults)
    opened.installedTransport = faults

    const workspace = new LocalGitWorkspace({
      path: harness.repo,
      git: harness.env.GIT_STACKS_REAL_GIT as string,
      // The clone's origin is the URL this run's host serves the repository from, so
      // the host the application resolves and the host it pushes to are one host.
      origin: server.cloneUrl(fullName),
      cloneSource: server.cloneUrl(fullName),
      certificatePath: server.certificatePath,
      author: AUTHOR,
      root: harness.root,
      env: git.env,
    })
    opened.workspace = workspace
    const admin = new GitHubAdmin(faults, fullName, marker)
    // Both identities are settled before anything is recorded or any Git runs: a
    // reviewer credential that turns out to be the primary account is a misconfigured
    // run, and finding that out after the repository exists means cleanup depends on
    // credentials this run has just proved it cannot trust.
    const primary = await admin.resolveOwner(state.currentUser)
    const reviewerFaults = new FaultInjectingTransport(credential(harness.reviewer.token))
    const reviewerAdmin = new GitHubAdmin(reviewerFaults, fullName, marker)
    const reviewerLogin = await resolveReviewerIdentity(reviewerAdmin, primary.login)
    ledger.record({
      kind: 'repository',
      handle: fullName,
      marker,
      createdAt: new Date().toISOString(),
      actor: primary.login,
    })
    await ledger.flush()
    // The grant, the acceptance and the read-back all need the repository to exist, so
    // they are the part that has to wait. The identity they are granted to does not.
    const reviewer = await grantReviewerAccess({
      admin,
      reviewerAdmin,
      reviewerTransport: reviewerFaults,
      fullName,
      reviewerLogin,
    })

    return new ControlledLiveTarget({
      runId,
      marker,
      receiptPath,
      fullName,
      defaultBranch: state.repository.defaultBranch,
      host: githubHostContext(server.host),
      primary,
      ledger,
      transport: productionTransport,
      faults,
      reviewer,
      workspace,
      git,
      root: harness.root,
      previousTransport: opened.previousTransport ?? null,
      installedTransport: faults,
      reviewerAdmin,
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

  /**
   * A foreign subject, real in every part that matters.
   *
   * Both kinds end at a pull request the host actually holds: a second repository of
   * its own, or a fork owned by the second account, each with a genuine commit pushed
   * over Git and a genuine pull request opened against it. The metadata the scenarios
   * use — the number and the URL — is what the host returned for those objects, because
   * a foreign negative built on an invented name or an unused number proves nothing
   * about how the production reader scopes a real foreign pull request.
   */
  async foreignPullRequest(kind: LiveForeignKind): Promise<LiveForeignPullRequest> {
    const existing = this.foreign.get(kind)
    if (existing !== undefined) return existing
    const subject = await this.provisionForeignSubject(kind)
    this.foreign.set(kind, subject)
    return subject
  }

  private async provisionForeignSubject(kind: LiveForeignKind): Promise<LiveForeignPullRequest> {
    const actor = kind === 'fork' ? this.reviewer : null
    if (kind === 'fork' && actor === null) {
      throw new Error(
        'A fork subject needs a second account, and this run was not given one to fork with',
      )
    }
    const subject = await this.harnessInstance.provisionForeignSubject({
      kind,
      owner: actor?.login ?? this.primary.login,
      name: `${this.fullName.split('/')[1]}-${kind}`,
      marker: this.marker,
    })
    await this.ledger.record({
      kind: 'repository',
      handle: subject.fullName,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      remoteId: subject.id,
      actor: subject.owner,
    })
    const branch = 'git-stacks-live-e2e-foreign'
    await this.ledger.intent({
      kind: 'branch',
      handle: `${subject.fullName}#${branch}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: subject.owner,
    })
    const foreignPath = join(this.root, `foreign-${kind}`)
    // The fork belongs to the reviewer's account, and this host now decides who may
    // reach it, so the push has to carry that account's credential scoped to exactly
    // this repository's URL. The primary's header does not match this remote and was
    // never going to; installing the reviewer's is what turns "the reviewer can push to
    // its own fork" from an assumption into something this host checked.
    await this.extendGitCredentials(
      this.server.cloneUrl(subject.fullName),
      kind === 'fork' ? this.harnessInstance.reviewer.token : this.harnessInstance.primaryToken,
    )
    // The extended environment was built from the one installed before this host's own
    // keys existed, so installing it puts those keys back where they were rather than
    // where the host needs them. The API double reads its state from the environment,
    // and the fork's pull request is opened over that same double.
    Object.assign(process.env, this.harnessInstance.ownedEnvironment, {
      GIT_STACKS_GITHUB_API_URL: this.server.url,
      GIT_STACKS_GITHUB_TRANSPORT: 'direct',
    })
    await createForeignRepository({
      path: foreignPath,
      remote: this.server.cloneUrl(subject.fullName),
      branch,
      env: this.git.env,
    })
    const clone = new LocalGitWorkspace({
      path: foreignPath,
      git: this.harnessInstance.env.GIT_STACKS_REAL_GIT as string,
      origin: this.server.cloneUrl(subject.fullName),
      cloneSource: this.server.cloneUrl(subject.fullName),
      certificatePath: this.server.certificatePath,
      author: AUTHOR,
      root: this.root,
      env: this.git.env,
    })
    await seedAndPush(
      clone,
      this.server.cloneUrl(subject.fullName),
      branch,
      this.marker,
      subject.defaultBranch,
    )
    this.ledger.confirm(`${subject.fullName}#${branch}`)
    const openOn = kind === 'fork' ? this.fullName : subject.fullName
    const head = kind === 'fork' ? `${subject.owner}:${branch}` : branch
    const pull = await this.admin.createPullRequest({
      fullName: openOn,
      head,
      base: subject.defaultBranch,
      title: `git-stacks live e2e foreign subject (${kind})`,
      body: `Opened by the live GitHub suite for run ${this.runId}.`,
    })
    this.ledger.record({
      kind: 'pull-request',
      handle: `${openOn}#${pull.number}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      actor: subject.owner,
    })
    return { fullName: openOn, number: pull.number, url: pull.url }
  }

  /** The requests the controlled host actually served, which is how a run is proved real. */
  servedRequests(): readonly { method: string; path: string; status: number }[] {
    return this.server.served
  }

  /**
   * The credentials this host knows, so a run can ask the authorizer about each of them
   * rather than only about the one its own remote happens to use.
   *
   * A boundary that has only ever been crossed by the right key has not been shown to
   * refuse the wrong one. This is how the refusal is exercised at all: the host's own
   * decision, on this host's own accounts, with the answer the host would give a Git.
   */
  get harnessState(): () => Promise<GitHubFixtureState> {
    return this.harnessInstance.readState
  }

  get harness(): GitHubHarness {
    return this.harnessInstance
  }

  /** The clone URL of this run's own repository, so a request can be made against it. */
  cloneUrlForTest(): string {
    return this.server.cloneUrl(this.fullName)
  }

  /**
   * One real request to this host's own Git endpoint, over its own socket.
   *
   * The host's fetch is used rather than a new client so the certificate this run
   * generated is the one that is verified: a probe that disabled checking to reach the
   * host would prove nothing about a boundary whose whole point is that checking.
   * Nothing here calls the authorizer — the answer comes from the request handler.
   */
  async wireGitRequestForTest(repository: string, credential: string | undefined): Promise<number> {
    const url = new URL(`${this.server.url}/${repository}.git/info/refs`)
    url.searchParams.set('service', 'git-upload-pack')
    const answer = await this.server.fetch(url, {
      headers:
        credential === undefined
          ? {}
          : {
              authorization: `basic ${Buffer.from(`x-access-token:${credential}`).toString('base64')}`,
            },
    })
    await answer.arrayBuffer()
    return answer.status
  }

  /**
   * There is no remote to clean up here: this run's host is this process.
   *
   * The bare repository under the projects root is this host's own directory for the
   * repository, so removing it is the deletion rather than a stand-in for one — and a
   * removal that fails is a deletion that did not happen. Swallowing the error and
   * answering `true` is what let a run report a complete cleanup with the directory
   * still on disk and nothing left to notice it except a person reading a temporary
   * directory. It is raised instead, so the refusal path reports what is still standing.
   *
   * Everything else the run opened is released by `releaseLocal`, which runs whatever
   * this decided. Tying the socket to the repository step meant a refusal before that
   * step left a listener holding the event loop open and a run that hung instead of
   * reporting.
   */
  protected async removeRepository(fullName: string): Promise<boolean> {
    await rm(join(this.root, 'projects', `${fullName}.git`), { recursive: true, force: true })
    return true
  }

  /**
   * The socket, the harness and everything this run wrote under its own root.
   *
   * Each is released on its own. They were opened independently and none of them can be
   * released twice, so a socket whose close threw must not be the reason the harness's
   * own state and this run's directory are kept: a harness left answering requests, or a
   * temporary directory holding an isolated Git home with a credential header in it, is
   * worse than any one of them being reported.
   *
   * The root itself goes, and only the receipt stays. The receipt is the file a workflow
   * publishes and the file a later recovery run is pointed at; everything else under
   * this root is this run's and nobody else's.
   */
  protected async releaseLocal(): Promise<void> {
    this.workspaceInstance.close()
    const failures: string[] = []
    for (const release of [
      () => this.server.close(),
      () => this.harnessInstance.close(),
      () => removeOwnedRoot(this.root, this.receipt),
    ]) {
      try {
        await release()
      } catch (error) {
        failures.push(describeThrown(error))
      }
    }
    if (failures.length > 0) {
      throw new Error(`the controlled host was not fully released: ${failures.join('; ')}`)
    }
  }
}

/** The target an operator authorizes: a disposable repository on a real GitHub host. */
export class GitHubLiveTarget extends DisposableTarget {
  readonly kind = 'github' as const
  readonly admin: LiveAdmin
  readonly reviewer: LiveReviewer | null
  private readonly workspaceInstance: LocalGitWorkspace
  private readonly foreign = new Map<LiveForeignKind, LiveForeignPullRequest>()
  private readonly reviewerToken: string | null
  private readonly primaryToken: string
  /** The claim on the real `git` and `gh`, held from startup until this run is done. */
  private readonly liveTools: { release: () => void }

  private constructor(
    setup: DisposableTargetSetup & {
      reviewerToken: string | null
      primaryToken: string
      liveTools: { release: () => void }
    },
  ) {
    super(setup)
    this.workspaceInstance = setup.workspace as LocalGitWorkspace
    this.reviewer = setup.reviewer
    this.reviewerToken = setup.reviewerToken
    this.primaryToken = setup.primaryToken
    this.liveTools = setup.liveTools
    this.admin = new GitHubAdmin(setup.faults, setup.fullName, setup.marker)
  }

  /**
   * Builds the authorized target.
   *
   * Nothing here has a default. The host, the owner and the token are required,
   * because a run pointed at a repository somebody else owns is not a test that
   * failed — it is a test that deleted something.
   *
   * Every step is inside one guard, from the first temporary directory onward, and each
   * resource is written down the moment it exists. A receipt write that fails, a Git seed
   * that throws, a push that is refused, a claim on the real `git` that is refused
   * because another run already holds one: each of those can happen, and before the guard
   * existed the command's startup handler reported the last of them with no target and
   * no cleanup at all — a temporary directory, an installed environment carrying a
   * URL-scoped live credential, and a token-bearing transport left in the process.
   */
  static async start(config: LiveRunConfig): Promise<GitHubLiveTarget> {
    const marker = ownershipMarker(config.runId)
    const name = disposableRepositoryName(config.repositoryPrefix, config.runId)
    const fullName = `${config.owner}/${name}`
    const receiptPath = config.receiptPath
    const redact = new LiveRedactor(
      [config.token, config.reviewerToken].filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      ),
    ).text
    // The ledger allocates nothing and installs nothing, so it is built before the guard
    // opens: a failure report needs one to say what is still standing.
    const ledger = new ResourceLedger({
      runId: config.runId,
      marker,
      receiptPath,
      host: config.host,
      owner: config.owner,
      redact,
    })
    // What this run took, and what it found. `previousTransport` is absent until the
    // transport is actually installed: an absent entry means this startup never got that
    // far, and teardown must not put back something it never took.
    const opened: {
      root?: string
      git?: IsolatedGitEnvironment
      liveTools?: { release: () => void }
      previousTransport?: GitHubTransport | null
      installedTransport?: FaultInjectingTransport
    } = {}
    // Whether the request that can create something was actually sent. A refusal that
    // happened before it — a reviewer credential that turned out to be the primary's own,
    // an owner this token cannot create in — has nothing on the host to undo, and a
    // rollback that reached for one would be asking a host about a repository nobody
    // asked it to make.
    let createAttempted = false
    try {
      opened.root = await mkdtemp(join(tmpdir(), `git-stacks-live-${name}-`))
      // Both credentials are pinned to this host's own endpoints and handed an
      // environment that cannot widen where they may be sent. The application's transport
      // reads its API base from the environment when it is not told one, and deliberately
      // permits an environment-configured base to be the origin a supplied token goes to
      // — which on a machine where that variable is set for development would send a real
      // disposable-account credential to whatever host it names, on the first request.
      const pinnedEnv = { ...process.env }
      delete pinnedEnv.GIT_STACKS_GITHUB_API_URL
      delete pinnedEnv.GH_TOKEN
      delete pinnedEnv.GITHUB_TOKEN
      delete pinnedEnv.GIT_STACKS_GITHUB_TOKEN
      const pin = (token: string): DirectGitHubTransport =>
        new DirectGitHubTransport({
          token,
          host: config.host,
          apiUrl: config.apiUrl,
          graphqlUrl: config.graphqlUrl,
          env: pinnedEnv,
        })
      const productionTransport = pin(config.token)
      const pacing = new LiveRequestPacing()
      const faults = new FaultInjectingTransport(productionTransport, pacing)
      const remote = `https://${config.host}/${fullName}.git`
      const git = await installIsolatedGitEnvironment({
        home: opened.root,
        author: AUTHOR,
        // The credential rides in a header supplied to every Git this process starts, and
        // never in the remote URL. A URL is read back by `git remote -v`, written into
        // `.git/config`, copied into a diagnostic, and quoted by a person; a header
        // scoped to this repository's URL is in none of them.
        credentials: [{ url: remote, header: `AUTHORIZATION: basic ${basicAuth(config.token)}` }],
      })
      opened.git = git
      git.install()
      // Whatever this process was already using is taken rather than discarded: the
      // run's own transport replaces it, and teardown puts the previous one back instead
      // of clearing a slot this run never owned.
      opened.previousTransport = setGitHubTransport(faults)
      opened.installedTransport = faults
      // This run is the one that owns a real host, so it is the one that may use a real
      // `git` — and only over the directory it just created. The fixture's interception
      // refuses anything it has no harness to answer, which is what keeps a controlled run
      // from ever leaving for github.com, and which would otherwise refuse this run's own
      // first push. The claim is scoped rather than process-wide on purpose: the run needs
      // its own workspace and its own foreign clone, and a claim over every git on the
      // machine would be more than it asked for. It can be refused — by a harness, or by
      // another live run — and it is taken inside the guard for that reason: a refusal
      // used to exit startup with the isolated environment and a live credential already
      // installed and nothing left to put them back.
      opened.liveTools = claimLiveGit(opened.root)

      const admin = new GitHubAdmin(faults, fullName, marker)
      // The owner is resolved against the credential before the first mutation, so an
      // owner the token cannot create in is refused rather than silently redirected to
      // the personal route, where it would create a repository under a different
      // account than the receipt would name.
      const primary = await admin.resolveOwner(config.owner)
      // Both supplied credentials are identified, and proved to be two different
      // accounts, before anything is recorded or any remote is changed. A reviewer
      // credential that is blank, that answers no identity, or that is the primary's own
      // is a misconfigured run — and finding that out after the receipt already names a
      // repository means the cleanup that has to undo it is running through the very
      // credentials the run has just refused to trust.
      const reviewerFaults =
        config.reviewerToken === null
          ? null
          : new FaultInjectingTransport(pin(config.reviewerToken), pacing)
      const reviewerAdmin =
        reviewerFaults === null ? null : new GitHubAdmin(reviewerFaults, fullName, marker)
      const reviewerLogin = await resolveReviewerIdentity(reviewerAdmin, primary.login)
      // The creation is journalled, durably, before the request that creates it. A
      // repository whose response is lost is then a receipt entry the recovery command
      // can reconcile against the host, instead of a resource that exists on somebody's
      // account and is described nowhere.
      await ledger.intent({
        kind: 'repository',
        handle: fullName,
        marker,
        createdAt: new Date().toISOString(),
        pending: true,
        actor: primary.login,
      })
      // The branch this repository treats as its default is the host's own setting, read
      // out of the answer the host gave. The create endpoint takes no such parameter, so
      // there is nothing to ask for: every merge, ruleset and base-ref question below is
      // asked about the branch that answer names. A host that names none is refused
      // rather than guessed for, because a guess here means seeding a branch the
      // repository has no evidence of having and then asking questions about it.
      let identity: LiveRepositoryIdentity
      let defaultBranch: string
      createAttempted = true
      try {
        identity = await admin.createRepository({
          owner: config.owner,
          name,
          description: `Disposable target for the Git Stacks live suite, run ${config.runId}.`,
          marker,
        })
      } catch (error) {
        // The answer was lost, or the host refused. Either way the repository may or
        // may not exist, so the host is asked rather than the creation repeated: a
        // second POST is how one lost response becomes two repositories. What comes back
        // has to be this run's own before anything is written to it — the read proves
        // the exact name and the exact marker, because an unrelated repository that
        // happens to occupy the name would otherwise receive this run's first commit.
        if (!(
          error instanceof GitHubTransportError &&
          (error.kind === 'network' || error.kind === 'timeout')
        )) {
          throw error
        }
        const existing = await readRepositoryIdentity(admin, fullName, marker)
        if (existing.outcome !== 'present') throw error
        identity = existing.identity
      }
      if (identity.defaultBranch === null) {
        throw new Error(
          `GitHub created ${identity.fullName} without naming a default branch, so this run ` +
            'cannot tell which branch the repository treats as its trunk. Nothing was seeded.',
        )
      }
      defaultBranch = identity.defaultBranch
      // One entry for this handle. `confirm` completes the journal that was already
      // written before the request and records the id the host named for it; recording
      // the same repository again would leave a second entry that every later update
      // misses, and that stays outstanding for ever while the repository it names is
      // deleted. The id is the strongest thing the receipt holds about this repository,
      // so it is written down here — before the seed, the push and the grant that can
      // each fail afterwards — rather than left for a cleanup that may never arrive.
      ledger.confirm(fullName, identity.id)
      await ledger.flush()

      const workspace = await seedRemoteClone({
        fullName,
        root: opened.root,
        remote,
        defaultBranch,
        git: git.env,
      })
      // The reviewer is let in before the run is handed on, and its access is read back
      // as itself. Both credentials are pinned to this run's own host and handed the
      // sanitized environment, so a reviewer credential cannot be redirected by
      // whatever the machine's environment happens to name.
      const reviewer = await grantReviewerAccess({
        admin,
        reviewerAdmin,
        reviewerTransport: reviewerFaults,
        fullName,
        reviewerLogin,
      })

      return new GitHubLiveTarget({
        runId: config.runId,
        marker,
        receiptPath,
        fullName,
        defaultBranch,
        host: githubHostContext(config.host),
        primary,
        ledger,
        transport: productionTransport,
        faults,
        reviewer,
        workspace,
        git,
        root: opened.root,
        reviewerAdmin,
        reviewerToken: config.reviewerToken,
        primaryToken: config.token,
        liveTools: opened.liveTools,
        previousTransport: opened.previousTransport ?? null,
        installedTransport: faults,
      })
    } catch (error) {
      throw await reportSetupFailure(error, ledger, opened, async () => {
        // The remote side is only touched if this run actually sent the request that
        // could have created something, and only if it can still prove the repository is
        // its own. The local side and the process are restored either way.
        if (!createAttempted) {
          ledger.release(fullName)
          await ledger.close()
          return
        }
        // The credential this rollback would use is the one this run actually installed,
        // read from the slot that records it rather than from a local that only exists on
        // the path that got this far. A setup that failed before installing one has
        // nothing to ask a host with, and says so rather than reaching for whatever
        // happens to be in the process.
        const installed = opened.installedTransport
        if (installed === undefined) {
          ledger.refuse(
            fullName,
            'this run installed no credential it could have asked about the repository with, so it is left standing',
          )
          await ledger.close()
          return
        }
        const admin = new GitHubAdmin(installed, fullName, marker)
        try {
          // The repository is deleted only if a fresh read proves it is this run's: the
          // exact name this run asked for, the exact marker, and the id the host named
          // for it when the creation was confirmed. The id is required rather than
          // optional, because a name that has since been reused can carry a copied marker
          // and a different id — and ordinary cleanup already refuses that repository,
          // so a setup rollback that accepted it would delete exactly what cleanup
          // exists to protect. A repository that cannot be proven is left standing and
          // named in the receipt, which is recoverable; one that was somebody else's is
          // gone for ever.
          const recorded = ledger.list().find((entry) => entry.handle === fullName)?.remoteId
          const outcome = await readRepositoryIdentity(
            admin,
            fullName,
            marker,
            typeof recorded === 'number' ? recorded : undefined,
          )
          if (outcome.outcome === 'present') {
            await admin.deleteRepository(fullName)
            ledger.release(fullName)
          } else if (outcome.outcome === 'absent') {
            ledger.release(fullName)
          } else if (outcome.outcome === 'conflict') {
            ledger.refuse(fullName, "the repository could not be proven to be this run's")
          } else {
            ledger.refuse(
              fullName,
              `the host could not be asked whether it still holds it: ${outcome.reason}`,
            )
          }
        } catch (cause) {
          ledger.refuse(
            fullName,
            `the repository could not be removed: ${redact(describeThrown(cause))}`,
          )
        }
        await ledger.close()
      })
    }
  }

  repository(): string {
    return this.fullName
  }

  async workspace(): Promise<LiveWorkspace> {
    return this.workspaceInstance
  }

  /**
   * A pull request that really lives somewhere else, journaled before it is created.
   *
   * A fork is made by the reviewer's own credential, so it belongs to a different
   * account than the repository it was forked from and its head is foreign in fact.
   * A second repository is made by the primary's. Either way the creation is journalled
   * first, the actor that owns it is recorded, and the commit is pushed over Git for
   * real — so what the scenario reads back is a foreign pull request a host genuinely
   * holds, not a name that resembles one.
   */
  async foreignPullRequest(kind: LiveForeignKind): Promise<LiveForeignPullRequest> {
    const existing = this.foreign.get(kind)
    if (existing !== undefined) return existing
    const subject = await this.provisionForeignSubject(kind)
    this.foreign.set(kind, subject)
    return subject
  }

  private async provisionForeignSubject(kind: LiveForeignKind): Promise<LiveForeignPullRequest> {
    const owner =
      kind === 'fork'
        ? this.requireReviewer(
            'A fork subject needs a second account, and this run was not given one',
          ).login
        : this.primary.login
    const admin = kind === 'fork' ? this.requireReviewerAdmin() : this.admin
    const suffix = kind === 'fork' ? '' : `-foreign-${this.runId}`
    const name = `${this.fullName.split('/')[1]}${suffix}`.slice(0, 100)
    // One spelling for this subject in the receipt, and it is the one this run asked
    // for rather than the one the host happened to answer with. A host may return a
    // differently-cased name for the same repository, and a receipt that held both
    // spellings would settle neither of them: `confirm` looks its handle up exactly, so
    // confirming the returned spelling silently finds nothing and throws away the id the
    // host just named, and the child handles prefixed with it would never match the
    // repository they live in. Case-insensitivity belongs in the repository portion of a
    // handle, never in a ref, which Git treats as case-sensitive.
    const journalled = `${owner}/${name}`
    await this.ledger.intent({
      kind: 'repository',
      handle: journalled,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: owner,
    })
    const identity =
      kind === 'fork'
        ? await admin.createFork({ parent: this.fullName, marker: this.marker })
        : await admin.createRepository({
            owner,
            name,
            description: `Disposable foreign subject for the Git Stacks live suite, run ${this.runId}.`,
            marker: this.marker,
            // The foreign subject takes whatever default the host gives it, reported
            // back by the host; nothing here chooses one.
          })
    // One entry for this handle. `confirm` completes the journal written before the
    // request, records the id the host named, and takes the pending flag off — on the
    // handle the journal already holds, not on the spelling the response came back in.
    this.ledger.confirm(journalled, identity.id)
    const branch = 'git-stacks-live-e2e-foreign'
    // The remote address is the host's own spelling, because that is the name Git and
    // the host both resolve; the receipt keeps the one this run asked for.
    const remote = `https://${this.host.host}/${identity.fullName}.git`
    await this.ledger.intent({
      kind: 'branch',
      handle: `${journalled}#${branch}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      pending: true,
      actor: owner,
    })
    const foreignPath = join(this.root, `foreign-${kind}`)
    // The fork belongs to the reviewer's account, so the push has to carry that
    // account's credential scoped to exactly this repository's URL. The primary's
    // header does not match this remote and is never offered to it.
    await this.extendGitCredentials(
      remote,
      kind === 'fork'
        ? this.requireReviewerToken(
            'A fork subject needs a second account, and this run was not given one',
          )
        : this.primaryToken,
    )
    await createForeignRepository({ path: foreignPath, remote, branch, env: this.git.env })
    const clone = new LocalGitWorkspace({
      path: foreignPath,
      git: resolveRealGit(),
      origin: remote,
      cloneSource: remote,
      author: AUTHOR,
      root: this.root,
      env: this.git.env,
    })
    const defaultBranch = identity.defaultBranch ?? this.defaultBranch
    if (kind === 'repository') {
      // Unlike a fork, a repository created with auto_init disabled has no trunk yet.
      await clone.commit('README.md', '# live e2e target\n', 'live e2e baseline')
      await clone.gitNetwork(['push', 'origin', `HEAD:refs/heads/${defaultBranch}`])
    }
    await seedAndPush(clone, remote, branch, this.marker, defaultBranch)
    this.ledger.confirm(`${journalled}#${branch}`)
    const openOn = kind === 'fork' ? this.fullName : identity.fullName
    // Which repository the pull request lives in, as the receipt spells it. For a fork
    // that is the repository it was forked from — this run's own — and for a second
    // repository it is that subject, under the handle this run journalled.
    const pullRequestRepository = kind === 'fork' ? this.fullName : journalled
    const head = kind === 'fork' ? `${identity.owner}:${branch}` : branch
    const pull = await this.admin.createPullRequest({
      fullName: openOn,
      head,
      // The base belongs to the repository the pull request is opened against, which
      // for a fork is the repository it was forked from rather than the fork. So this
      // reads the default branch of whichever repository the pull request lives in, and
      // each from the host that reported it, rather than one branch reused for both.
      base:
        openOn === this.fullName
          ? this.defaultBranch
          : (identity.defaultBranch ?? this.defaultBranch),
      title: `git-stacks live e2e foreign subject (${kind})`,
      body: `Opened by the live GitHub suite for run ${this.runId}.`,
    })
    this.ledger.record({
      kind: 'pull-request',
      handle: `${pullRequestRepository}#${pull.number}`,
      marker: this.marker,
      createdAt: new Date().toISOString(),
      actor: owner,
    })
    // The repository named here is the one the pull request lives in, which for a fork
    // is the repository it was forked from rather than the fork itself — and the address
    // is the host's own, because a URL composed here could not fail.
    return { fullName: openOn, number: pull.number, url: pull.url }
  }

  private requireReviewer(problem: string): LiveReviewer {
    if (this.reviewer === null) throw new Error(problem)
    return this.reviewer
  }

  private requireReviewerAdmin(): LiveAdmin {
    const admin = this.reviewerAdmin
    if (admin === null) {
      throw new Error('This run has no credential for the account that owns the fork')
    }
    return admin
  }

  private requireReviewerToken(problem: string): string {
    if (this.reviewerToken === null) throw new Error(problem)
    return this.reviewerToken
  }

  /** The remote repository, which is deleted only by the run that can still prove it. */
  protected async removeRepository(fullName: string): Promise<boolean> {
    return this.admin.deleteRepository(fullName)
  }

  /**
   * The clone, everything this run wrote under its own root, and the claim on the real
   * `git` and `gh`.
   *
   * Released whatever the host did, rather than after a successful deletion. Tying the
   * local teardown to the remote answer meant a run whose deletion was refused kept a
   * clone, a token-bearing Git configuration, and the run's claim on the real tools for
   * as long as the process lived.
   *
   * Each is released on its own. A directory that will not delete is reported, and the
   * claim is still given back: a claim this run holds after it has finished refuses
   * every later run in this process, and keeps the real `git` authorised over a
   * directory that belongs to no run at all.
   */
  protected async releaseLocal(): Promise<void> {
    this.workspaceInstance.close()
    const failures: string[] = []
    for (const release of [
      () => removeOwnedRoot(this.root, this.receipt),
      () => this.liveTools.release(),
    ]) {
      try {
        await release()
      } catch (error) {
        failures.push(describeThrown(error))
      }
    }
    if (failures.length > 0) {
      throw new Error(`this run's local state was not fully released: ${failures.join('; ')}`)
    }
  }
}

/**
 * Who the second credential actually is, proved before anything is created.
 *
 * The identity is read, never defaulted. A login that comes back empty has swallowed a
 * failure, and treating that as a usable actor would hand a private repository to an
 * unidentifiable credential. Neither is that login the primary's own: a run given one
 * credential twice has two names for one account, and every later "the second account
 * is not the first" claim in the suite would be true only because the run asserted it.
 *
 * This runs before the first mutation on purpose. After the repository exists and the
 * clone has been seeded, a refusal here has to be cleaned up with the very credentials
 * that were just found to be untrustworthy, and the rollback runs through a transport
 * whose errors are part of what has to be read.
 */
async function resolveReviewerIdentity(
  reviewerAdmin: LiveAdmin | null,
  primaryLogin: string,
): Promise<string | null> {
  if (reviewerAdmin === null) return null
  const login = await reviewerAdmin.viewer()
  if (login === '' || login.toLowerCase() === 'undefined' || login.toLowerCase() === 'null') {
    throw new Error(
      'The reviewer credential did not identify an account; this run cannot use it as a reviewer',
    )
  }
  if (login.toLowerCase() === primaryLogin.toLowerCase()) {
    throw new Error(
      `The reviewer credential authenticates as ${login}, the same account as the run's own; ` +
        'a second reviewer has to be a different account',
    )
  }
  return login
}

/**
 * The second account, let into the disposable repository and shown to hold it.
 *
 * A token is not access. The repository was created moments ago and has exactly one
 * member, so a valid reviewer credential still cannot read a private pull request until
 * it has been let in. That is what happens here: the account is granted access,
 * invited through if the host requires an acceptance, and then read back. Access that
 * cannot be read back is not access, and reporting a second reviewer from it would send
 * every review scenario down a path that answers 404.
 */
async function grantReviewerAccess(input: {
  admin: LiveAdmin
  /**
   * The reviewer's admin surface and transport, built by the target that knows the
   * endpoints. They are passed in rather than built here so the second credential is
   * pinned to the same host as the first, under the same environment rules, instead of
   * inheriting whatever the process happens to carry.
   */
  readonly reviewerAdmin: LiveAdmin | null
  readonly reviewerTransport: GitHubTransport | null
  readonly fullName: string
  /** The identity settled before this run created anything. */
  readonly reviewerLogin: string | null
}): Promise<LiveReviewer | null> {
  const reviewerAdmin = input.reviewerAdmin
  const reviewerTransport = input.reviewerTransport
  const login = input.reviewerLogin
  if (reviewerAdmin === null || reviewerTransport === null || login === null) return null
  const invitationId = await input.admin.inviteCollaborator(input.fullName, login, 'push')
  if (invitationId !== null) {
    // A 201 means the account has to accept before it holds anything, and only that
    // account can accept it. If it cannot see its own invitation there, this run cannot
    // prove the reviewer is ever going to be let in, and continuing would report a
    // second reviewer the host has not granted — sending every review scenario down a
    // path that answers 404.
    const pending = await reviewerAdmin.pendingInvitations()
    if (!pending.some((entry) => entry.id === invitationId)) {
      throw new Error(
        `The invitation to ${login} is not waiting for it, so this run cannot prove the reviewer has access`,
      )
    }
    await reviewerAdmin.acceptInvitation(invitationId)
  }
  // Access is read back through the reviewer, as the reviewer. A grant the primary
  // believes it made and the reviewer cannot see is not access, and reporting a second
  // reviewer from it would send every review scenario down a path that answers 404.
  const permission = await reviewerAdmin.collaboratorPermission(input.fullName, login)
  if (permission === null) {
    throw new Error(
      `${login} holds no permission on ${input.fullName} after being invited, so this run cannot ` +
        'use it as a reviewer',
    )
  }
  return { login, permission, transport: () => reviewerTransport }
}

/**
 * Reports a provisioning failure with what it left behind.
 *
 * The receipt is closed only after the local side is gone, and the returned error
 * carries the cleanup report so the command can say "these are still standing" rather
 * than "nothing was created". Swallowing the report — which is what reporting the
 * failure as a plain refusal does — is the difference between an operator who knows
 * what to delete and an operator who does not.
 */
async function reportSetupFailure(
  error: unknown,
  ledger: ResourceLedger,
  opened: {
    readonly root?: string
    readonly git?: IsolatedGitEnvironment
    readonly liveTools?: { release: () => void }
    readonly previousTransport?: GitHubTransport | null
    readonly installedTransport?: GitHubTransport
  },
  removeRemote: () => Promise<void>,
): Promise<LiveProvisioningFailure> {
  // Every local claim this run made is given back, and none of them depends on another
  // having worked. The process keeps the real `git`, the real API base and this run's
  // credentials — and holds the only claim on the real tools — unless all of these run,
  // which is exactly the case a failure part-way through startup is in. A restore that
  // throws would skip the ones after it, so each is given back under its own guard and
  // the first failure is carried on.
  //
  // Each step is taken only if this startup actually acquired it. A refusal before the
  // claim was taken must not release a claim that belongs to the run that holds it, and
  // a refusal before the transport was installed must not clear a transport this run
  // never installed and could never put back.
  const teardown: unknown[] = []
  for (const give of [
    () => releaseOwnedTransport(opened.installedTransport, opened.previousTransport ?? null),
    opened.root === undefined
      ? null
      : () => rm(opened.root as string, { recursive: true, force: true }),
    opened.liveTools === undefined ? null : () => opened.liveTools?.release(),
    opened.git === undefined ? null : () => opened.git?.restore(),
  ]) {
    if (give === null) continue
    try {
      await give()
    } catch (cause) {
      teardown.push(cause)
    }
  }
  // The remote side goes last, because it is the part somebody else can see and the
  // local releases above cannot take the record of it with it. What it could not remove
  // is already written into the receipt.
  try {
    await removeRemote()
  } catch (cause) {
    teardown.push(cause)
  }
  for (const cause of teardown) {
    ledger.noteLocalFailure(describeThrown(cause))
  }
  const report = ledger.report()
  const standing = report.remaining
  const reasons = [error, ...teardown]
    .map(describeThrown)
    // The refusal is written down and read by whoever has to clean up after this, so
    // it goes through the same redactor as everything else in the receipt: a lost
    // response is reported by the host as the body it sent back, and a token in a URL
    // is a token in a stack trace.
    .map((text) => ledger.redact(text))
  return new LiveProvisioningFailure(
    [
      ...reasons,
      ...(standing.length === 0
        ? []
        : [
            `${standing.length} resource(s) are still on the host and are named in the receipt: ${standing.join(', ')}`,
          ]),
      ...(report.localFailures ?? []).map(
        (failure) => `this run left local state behind: ${failure}`,
      ),
    ].join('; '),
    report,
    ledger.receiptPath,
  )
}

/**
 * Puts the process-wide transport back, but only while this run is still the one holding it.
 *
 * The slot replaces rather than stacks, so there is exactly one value in it at a time and
 * only its current holder may decide what it becomes next. Restoring unconditionally
 * would mean a run that finished — or failed — after somebody else installed a transport
 * of their own silently removed that transport, taking its credential with it and
 * reporting a clean process while it did. So the restore is conditional on the slot still
 * holding what this run installed, and a slot that has moved on is reported rather than
 * overwritten.
 *
 * `installed` is absent when this run never installed one — it failed before reaching
 * that step — and there is then nothing to restore and nothing to report.
 */
function releaseOwnedTransport(
  installed: GitHubTransport | undefined,
  previous: GitHubTransport | null,
): void {
  if (installed === undefined) return
  if (installedGitHubTransport() !== installed) {
    throw new Error(
      'the installed transport was replaced by something else while this run held it, so it ' +
        'was left alone rather than removed',
    )
  }
  setGitHubTransport(previous)
}

/**
 * What a read back from the host can establish about a repository this run asked for.
 *
 * The four answers are four different events and nothing about one of them implies
 * another. `absent` is the host saying the name holds nothing. `conflict` is a
 * repository standing at the name that does not carry this run's marker, or carries a
 * different id than the one the host named when it was created — somebody else's, and
 * still there. `unknown` is a read that could not be completed at all. Only `present`
 * is this run's own.
 *
 * Collapsing the middle three into one "not found" is what let a pending creation whose
 * answer was lost be released while a repository with a copied marker still stood: the
 * receipt then said it was gone, the run reported a complete cleanup, and a later
 * recovery skipped it for ever because `deletedAt` reads as "already removed".
 */
type RepositoryRead =
  | { readonly outcome: 'present'; readonly identity: LiveRepositoryIdentity }
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'unknown'; readonly reason: string }

/**
 * A repository identity read back from the host, answered as one of four events.
 *
 * This is the reconciliation for a creation whose answer was lost, so it reads and
 * never re-sends the request that created it: "I did not hear back" is not evidence
 * that nothing happened, and creating a second repository is the one outcome that
 * deleting either of them cannot undo.
 *
 * `recordedId` is what a confirmed creation is held to, and it is what turns a
 * repository carrying a copied marker into a conflict rather than into this run's own.
 * A creation that was never confirmed has no id, and is judged on its marker alone,
 * which is the strongest thing the receipt can say about it.
 */
async function readRepositoryIdentity(
  admin: LiveAdmin,
  fullName: string,
  marker: string,
  recordedId?: number,
): Promise<RepositoryRead> {
  try {
    const repository = await admin.readRepository(fullName)
    // A name is not a proof. This read is the answer to "did my lost POST create
    // something", and the only thing that makes the answer yes is that what came back
    // is this run's own: the host resolved this exact path, so the name is exact, and
    // the marker is matched whole rather than as a substring — a description that
    // mentions this run's marker while belonging to somebody else is still somebody
    // else's repository, and seeding it is the one thing a run must never do.
    if (!ownsCreatedResource(repository, marker, recordedId)) return { outcome: 'conflict' }
    return {
      outcome: 'present',
      identity: {
        id: typeof repository.id === 'number' ? repository.id : 0,
        fullName,
        defaultBranch: repository.default_branch ?? null,
        owner: repository.owner?.login ?? fullName.split('/')[0] ?? '',
        ownerKind: repository.owner?.type === 'Organization' ? 'organization' : 'user',
      },
    }
  } catch (error) {
    if (
      error instanceof GitHubTransportError &&
      (error.status === 404 || error.kind === 'not-found')
    ) {
      return { outcome: 'absent' }
    }
    return { outcome: 'unknown', reason: describeThrown(error) }
  }
}

/**
 * The repository a foreign branch is pushed from, created before anything points a
 * remote at it.
 *
 * A workspace publishes its origin and the authority it trusts the moment it is
 * constructed, so the clone has to exist first: there is no repository for it to
 * name, and a command run against a directory that is not yet a repository fails on
 * the very step that is supposed to make it one.
 */
async function createForeignRepository(input: {
  path: string
  remote: string
  branch: string
  env: NodeJS.ProcessEnv
}): Promise<void> {
  await mkdir(input.path, { recursive: true })
  execFileSync(resolveRealGit(), ['init', '-b', input.branch, input.path], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.env,
  })
  execFileSync(resolveRealGit(), ['-C', input.path, 'remote', 'add', 'origin', input.remote], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.env,
  })
}

/**
 * A clone of a real repository with one real commit pushed to a branch, the way a person
 * makes one: with Git, over the repository's own HTTPS remote.
 */
async function seedAndPush(
  workspace: LocalGitWorkspace,
  remote: string,
  branch: string,
  marker: string,
  defaultBranch: string,
): Promise<void> {
  await workspace.gitNetwork(['fetch', 'origin', `refs/heads/${defaultBranch}`])
  workspace.git(['checkout', '-B', branch, 'FETCH_HEAD'])
  await writeFile(
    join(workspace.path, 'git-stacks-live-e2e-foreign.txt'),
    `Foreign subject for ${marker}\n`,
    'utf8',
  )
  workspace.git(['add', '--', 'git-stacks-live-e2e-foreign.txt'])
  workspace.git(['commit', '-m', 'foreign subject for the live suite'])
  workspace.git(['remote', 'set-url', 'origin', remote])
  workspace.git(['remote', 'set-url', '--push', 'origin', remote])
  await workspace.push(branch)
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
  git: NodeJS.ProcessEnv
}): Promise<LocalGitWorkspace> {
  const git = resolveRealGit()
  const clone = join(input.root, 'clone')
  execFileSync(git, ['init', '-b', input.defaultBranch, clone], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  execFileSync(git, ['-C', clone, 'config', 'user.name', AUTHOR.name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  execFileSync(git, ['-C', clone, 'config', 'user.email', AUTHOR.email], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  await writeFile(join(clone, 'README.md'), '# live e2e target\n', 'utf8')
  execFileSync(git, ['-C', clone, 'add', '--', 'README.md'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  execFileSync(git, ['-C', clone, 'commit', '-m', 'live e2e baseline'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  execFileSync(git, ['-C', clone, 'remote', 'add', 'origin', input.remote], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
  })
  // No credential is in the URL and none is in this repository's configuration: the
  // header the run installed is inherited by every Git started from here, the
  // application included, so a push the product makes is authorized the same way.
  // Bounded, because this is the first request this run makes to a host over a network it
  // does not control, and it happens immediately after the repository was created. A
  // bound turns a host that never answers into a failure the guard already knows how to
  // report and clean up, rather than a run that waits for that socket for ever.
  execFileSync(git, ['-C', clone, 'push', 'origin', `HEAD:refs/heads/${input.defaultBranch}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.git,
    timeout: GIT_TIMEOUT_MS,
  })
  return new LocalGitWorkspace({
    path: clone,
    git,
    cloneSource: input.remote,
    author: AUTHOR,
    root: input.root,
    env: input.git,
  })
}

/**
 * Removes everything this run put under its own root, except the receipt.
 *
 * The receipt is the one file that has to survive. It is what the workflow publishes as
 * an artifact and what an operator is told to point a recovery run at, so removing the
 * root wholesale would delete the record of what a failed run left behind at the exact
 * moment it was needed.
 *
 * Everything else under it goes: the clone, the bare repository, both foreign bares, the
 * isolated Git home and template, and the configuration those hold with an
 * `AUTHORIZATION` header for a live account in it. A temporary directory left behind is
 * readable by whatever runs on this machine next, so "the root is still there" is not a
 * state a run that reports a complete cleanup may be in. Removal is per entry rather
 * than one recursive delete so the receipt is never caught by it, and so the paths are
 * compared as resolved paths rather than as strings.
 */
async function removeOwnedRoot(root: string, receipt: string): Promise<void> {
  const keep = resolve(receipt)
  for (const name of await readdir(root)) {
    const candidate = join(root, name)
    if (resolve(candidate) === keep) continue
    await rm(candidate, { recursive: true, force: true })
  }
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
export function newRunSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Whether the credential in a Git request is allowed to write to the repository named.
 *
 * A host that serves everybody's pushes answers for a public repository whether or not
 * anybody was let in, so a controlled run that proved "the reviewer can push to its own
 * fork" against such a host proved that the host is permissive. This asks the same
 * question GitHub asks — who is this credential, and what role does that account hold on
 * this repository — using the same permission map the API surface enforces, so a push
 * that succeeds is a grant the run made and the host checked.
 *
 * An unrecognised credential is refused rather than treated as the owner, because the
 * whole point of the boundary is that a request with no identity behind it is a request
 * that should not have been served.
 */
async function authorizeControlledGit(
  harness: GitHubHarness,
  fullName: string,
  credential: string,
): Promise<{ readonly login: string } | { readonly status: number; readonly message: string }> {
  // The host has already taken the `Basic` header apart and handed back the secret, so
  // decoding it a second time would match nothing and every request would be refused.
  const token = credential
  const state = await harness.readState()
  const actor = (state.actors ?? []).find((entry) => entry.token === token)
  if (!actor) return { status: 401, message: 'this credential is not an account here\n' }
  // The primary repository is the one entry the registry never holds: it was created
  // before this harness existed and is served from its own bare, so its name is read
  // off that bare — the way the host itself resolves the path — rather than off the
  // state, whose owner is whatever the API double answers with. The name has already
  // had the `.git` a remote URL ends in taken off it by the boundary, so this is a
  // plain comparison and not a guess about suffixes.
  const primary = relative(harness.projectsRoot, harness.bare).replace(/\.git$/u, '')
  if (fullName.toLowerCase() === primary.toLowerCase()) {
    // The account that created it administers it, and that account is not the
    // repository's `owner` field: a disposable repository under an organization is
    // owned by the organization and created by a user credential that administers it.
    // So the grant that matters is the one this run actually made — the credential the
    // run created the repository with, plus whatever this run has since granted an
    // account on it.
    if (token === harness.primaryToken) return { login: actor.login }
    // Everything below is the same grant the API surface enforces for a repository the
    // registry does hold, and it is asked the same way: who is this credential, and
    // what role does that account hold here. Equating permission with having created
    // the repository would answer 403 to the reviewer's own valid credential on a
    // repository this run invited it into and verified a push role on — the run's own
    // grant, enforced by a rule that had forgotten it made one.
    const held = state.repository?.permissions?.[actor.login.toLowerCase()]
    if (held === undefined) {
      return { status: 403, message: `${actor.login} has not been given access here\n` }
    }
    if (!WRITING_ROLES[held]) {
      return { status: 403, message: `${actor.login} holds ${held} here, which cannot write\n` }
    }
    return { login: actor.login }
  }
  const registry = (state.repositories ?? []).find(
    (entry) => entry.fullName.toLowerCase() === fullName.toLowerCase(),
  )
  if (!registry) return { status: 404, message: 'this host has no such repository\n' }
  if (registry.private === false) return { login: actor.login }
  // The same map, looked up the same way, for a repository in the registry: keys are
  // matched case-insensitively because an account's login is spelled the way its owner
  // spelled it and a permission map is keyed the way the grant was recorded. Refusing a
  // reviewer over the capitalisation of a login would make the answer a fact about the
  // spelling rather than about the role.
  const held = Object.entries(registry.permissions ?? {}).find(
    ([login]) => login.toLowerCase() === actor.login.toLowerCase(),
  )?.[1]
  if (held === undefined) {
    return { status: 403, message: `${actor.login} has not been given access here\n` }
  }
  if (!WRITING_ROLES[held]) {
    return { status: 403, message: `${actor.login} holds ${held} here, which cannot write\n` }
  }
  return { login: actor.login }
}

/**
 * The authorization decision, for a request that arrived without a credential at all.
 *
 * A missing `Authorization` header is the ordinary case for a clone before the client
 * has been asked for a credential, so it is answered as "no identity" rather than as a
 * failure of this run's own configuration — the host is expected to say 401 and let
 * Git answer with one.
 */
export async function authorizeGitFor(
  harness: GitHubHarness,
  fullName: string,
  authorization: string | undefined,
): Promise<{ readonly login: string } | { readonly status: number; readonly message: string }> {
  if (authorization === undefined || authorization.trim() === '') {
    return { status: 401, message: 'this repository needs a credential\n' }
  }
  return authorizeControlledGit(harness, fullName, authorization)
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
