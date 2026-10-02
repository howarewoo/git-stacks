import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { LiveWorkspace } from './contract'

/**
 * A local clone, driven by the real `git` the application resolves.
 *
 * The point of using Git at all is that a disposable repository has to be a real one:
 * a review anchored to a line that only exists in a fixture, or a race staged against a
 * ref that was never written, proves nothing about the product. Every commit and push in
 * this suite goes through Git's own plumbing against the same remote the API reads, so a
 * branch the host reports and a branch the clone has are the same branch.
 *
 * `child_process` is read through `createRequire` rather than through a named ESM
 * import, and the asynchronous entry point is read when it is used rather than when this
 * module evaluates. The transport the application installs lives on the
 * `child_process` module object, and an ESM named import of a builtin keeps the export
 * it saw when that builtin was first linked — which is before the target installs
 * anything. Reading the object at call time is what makes a Git command issued here
 * reach the same remote a command issued by the application does.
 *
 * Nothing that speaks to the remote may run synchronously. A controlled run serves its
 * Git and its API from one event loop in this process, so a blocking `git push` waits
 * for a server that cannot answer until the push returns, and the run never finishes.
 * `git()` refuses the subcommands that would do that, and `gitNetwork()` is the boundary
 * every fetch, push, and clone goes through.
 */
const nodeRequire = createRequire(import.meta.url)

/** One Git invocation, answered asynchronously by whichever boundary answers Git here. */
/**
 * The `execFile` this process answers Git on.
 *
 * The options are stated rather than inferred because `promisify` takes its type from
 * whichever callback overload it finds first, and that overload has no `timeout` and no
 * `signal` — the two things that let a Git command this process is serving stop at all.
 * A command with no deadline, against a host this process itself serves, is the one that
 * hangs the run.
 */
type GitCommand = (
  file: string,
  args: readonly string[],
  options: {
    encoding: 'utf8'
    env?: NodeJS.ProcessEnv
    maxBuffer?: number
    timeout?: number
    signal?: AbortSignal
  },
) => Promise<{ stdout: string; stderr: string }>

const childProcess = nodeRequire('node:child_process') as {
  execFile: GitCommand & { [promisify.custom]: GitCommand }
  execFileSync: (
    file: string,
    args: readonly string[],
    options: {
      encoding: 'utf8'
      cwd?: string
      env?: NodeJS.ProcessEnv
      stdio: 'ignore' | 'pipe'
      timeout?: number
    },
  ) => string
}

/**
 * The subcommands that talk to a remote, and so may not be run synchronously.
 *
 * The list is here rather than in a comment because the failure it prevents is a
 * deadlock with no output: the process simply stops, and the run is killed by a
 * workflow timeout with nothing in the log to explain it.
 */
const REMOTE_SUBCOMMANDS: Record<string, true> = {
  clone: true,
  fetch: true,
  'ls-remote': true,
  pull: true,
  push: true,
  submodule: true,
}

/**
 * How long any one Git command may take before the run gives up on it.
 *
 * Unbounded is how a run that has already created a repository gets killed by a
 * job timeout with the receipt half-written and no cleanup ever entered: a remote
 * that accepts the connection and then says nothing holds the process for as long
 * as the platform allows. A bound turns that into an ordinary failure the run's own
 * cleanup path handles.
 */
export const GIT_TIMEOUT_MS = 120_000

/**
 * One Git command that may reach the remote, with the outcome raised rather than printed.
 *
 * `cwd` is where the child starts, and it is part of what this run is allowed to do:
 * the boundary a live run installs measures the claim on the real `git` against the
 * directory a command acts on, and for a command with no `-C` that is the working
 * directory rather than this process's.
 */
function runGitRemote(
  git: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string,
): Promise<string> {
  // `promisify` is applied where the command runs rather than once at module load,
  // because what it wraps is `child_process.execFile` as it stands by then: the boundary
  // the rest of this process answers Git on. A Git command that reached the real tools
  // directly would be running against a different world than the application's own
  // commands, which is the one thing this suite cannot do.
  const run = promisify(childProcess.execFile)
  return run(git, args, {
    encoding: 'utf8',
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    ...(cwd === undefined ? {} : { cwd }),
    ...(signal ? { signal } : {}),
  }).then(
    (result) => result.stdout.trim(),
    (error: unknown) => {
      const written =
        error !== null &&
        typeof error === 'object' &&
        'stderr' in error &&
        typeof error.stderr === 'string'
          ? error.stderr.trim()
          : ''
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(written === '' ? message : `${message}\n${written}`)
    },
  )
}

export interface LocalWorkspaceOptions {
  /** Absolute path of the clone. */
  readonly path: string
  /** The one real `git` every command below is run with. */
  readonly git: string
  /**
   * What `externalClone` clones from, and what `origin` is set to when the target names
   * one. In both cases the actor lands in the same remote the application pushes to,
   * which is the whole point of an actor the application cannot see.
   */
  readonly cloneSource: string
  /** Extra arguments every clone needs, such as the credential header of a real host. */
  readonly cloneArgs?: readonly string[]
  /**
   * The URL the application reads as `origin`, when that is not the URL Git clones from.
   *
   * The application learns which host and which repository a clone belongs to from
   * `remote.origin.url`, and `git remote get-url` expands any `insteadOf` rewrite it
   * finds — so a rewrite here would teach the application where the remote physically
   * is instead of the repository it is pointed at, and every read that resolves a host
   * from the remote would quietly find no host at all. A controlled target therefore
   * serves Git from the same URL it serves the API from, and this is only for a target
   * whose clone and application disagree about a URL that both of them can still parse.
   */
  readonly origin?: string
  /**
   * A certificate to trust for this clone, by path. Git verifies its handshake against
   * it as it would against any other authority; nothing here turns verification off.
   */
  readonly certificatePath?: string
  /** Identity every commit and clone is made with, so a diff has an author. */
  readonly author: { name: string; email: string }
  /** A temporary directory this workspace owns and removes when it closes. */
  readonly root: string
  /**
   * The environment every Git command is run with, and the same one installed into
   * the process for the application's own services.
   *
   * Passing it explicitly is not a second boundary; it is the same one, held where
   * it can be checked. A workspace that fell back to `process.env` would be correct
   * only as long as nothing else changed the process, which is exactly the assumption
   * that leaks a credential through an inherited hook or helper.
   */
  readonly env?: NodeJS.ProcessEnv
}

export class LocalGitWorkspace implements LiveWorkspace {
  readonly path: string
  private readonly gitBinary: string
  private readonly cloneSource: string
  private readonly cloneArgs: readonly string[]
  private readonly origin: string | undefined
  private readonly certificatePath: string | undefined
  private readonly author: { name: string; email: string }
  private readonly root: string
  /**
   * The environment every Git command below runs with: the run's isolated one.
   *
   * It is the same environment the application's own services have installed into the
   * process, so a command issued here and a command issued by the product see the
   * same Git configuration. Anything else would mean this suite proved something
   * about a configuration the product never runs under.
   */
  readonly env: NodeJS.ProcessEnv
  private closed = false
  private cancelled = false
  /** Aborts the Git commands that are still running when a run is cancelled. */
  private readonly abort = new AbortController()

  constructor(options: LocalWorkspaceOptions) {
    this.path = options.path
    this.gitBinary = options.git
    this.cloneSource = options.cloneSource
    this.cloneArgs = options.cloneArgs ?? []
    this.origin = options.origin
    this.certificatePath = options.certificatePath
    this.author = options.author
    this.root = options.root
    this.env = options.env ?? process.env
    this.pointOriginAt(options.origin)
    this.trustCertificate(options.certificatePath)
  }

  cancel(): void {
    this.cancelled = true
    this.abort.abort()
  }

  /**
   * Publishes `origin` as the clone's remote.
   *
   * Both halves are repointed. Git resolves a push through `remote.origin.pushurl` in
   * preference to `remote.origin.url`, so a clone whose push destination was set
   * separately would still push somewhere the application did not mean — which is the
   * one thing a run against a controlled host must never let happen.
   */
  private pointOriginAt(origin: string | undefined): void {
    if (origin === undefined) return
    this.git(['remote', 'set-url', 'origin', origin])
    this.git(['remote', 'set-url', '--push', 'origin', origin])
  }

  /**
   * Tells Git which authority to trust for this clone.
   *
   * A controlled host's certificate is generated for the run and is trusted by file.
   * Verification stays on, so a request that reached the wrong host, or a host that
   * presented somebody else's certificate, fails here instead of being waved through.
   */
  private trustCertificate(certificatePath: string | undefined): void {
    if (certificatePath === undefined) return
    this.git(['config', 'http.sslCAInfo', certificatePath])
    this.git(['config', 'http.sslVerify', 'true'])
  }

  /**
   * One local Git command, with the outcome raised rather than printed.
   *
   * Only commands that stay inside this clone belong here. A command that reaches the
   * remote would block this process while the controlled host waits for it to come
   * back, so `REMOTE_SUBCOMMANDS` is refused here rather than deadlocking silently.
   */
  git(args: readonly string[]): string {
    if (this.closed) throw new Error('this live workspace has already been closed')
    if (this.cancelled) throw new Error('this live run was cancelled')
    const remote = args.find(
      (argument) => !argument.startsWith('-') && argument in REMOTE_SUBCOMMANDS,
    )
    if (remote !== undefined) {
      throw new Error(
        `git ${args.join(' ')} reaches the remote; a controlled run serves that remote from this ` +
          'process, so a blocking call would wait for a server that cannot answer. ' +
          'Use gitNetwork(), which yields the event loop while Git waits.',
      )
    }
    return childProcess
      .execFileSync(this.gitBinary, ['-C', this.path, ...args], {
        encoding: 'utf8',
        env: this.env,
        stdio: 'pipe',
        timeout: GIT_TIMEOUT_MS,
      })
      .trim()
  }

  /**
   * One Git command that may reach the remote, yielding the event loop while it runs.
   *
   * Everything that has to be true of a push — that the remote received it, that the
   * ref it now holds is the head a check run attaches to — depends on the answer coming
   * back from a real host. That host is in this process during a controlled run, so the
   * command is asynchronous for the same reason the transport is.
   */
  async gitNetwork(args: readonly string[]): Promise<string> {
    if (this.closed) throw new Error('this live workspace has already been closed')
    if (this.cancelled) throw new Error('this live run was cancelled')
    return runGitRemote(this.gitBinary, ['-C', this.path, ...args], this.env, this.abort.signal)
  }

  async commit(path: string, contents: string, message: string): Promise<string> {
    const absolute = join(this.path, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
    this.git(['add', '--', path])
    this.git(['commit', '-m', message])
    return this.git(['rev-parse', 'HEAD'])
  }

  /**
   * Pushes a branch and answers with the head the remote now holds, read back from the
   * remote rather than from the local ref. A push that was rejected has no remote head,
   * and reporting the local one would hide exactly the disagreement the races need.
   */
  async push(branch: string): Promise<string> {
    await this.gitNetwork(['push', 'origin', `${branch}:${branch}`])
    const [remote, local] = (await this.gitNetwork(['ls-remote', 'origin', `refs/heads/${branch}`]))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(/\s+/u)[0])
    if (remote === undefined || remote === '') {
      const known = this.git(['rev-parse', `refs/remotes/origin/${branch}`])
      throw new Error(
        `the push of ${branch} did not leave a remote head; local is ${local ?? known}`,
      )
    }
    return remote
  }

  /**
   * A second clone of the same remote, outside anything the application runs.
   *
   * The race scenarios need an actor that can move a ref between a preview and its
   * execution without going through a single line of the product. A separate clone on
   * the same machine, with its own identity and its own Git invocation, is that actor,
   * and it is the only honest way to stage a race against a real host without asking the
   * host to misbehave on purpose.
   */
  async externalClone(): Promise<LiveWorkspace> {
    const directory = join(
      this.root,
      `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    // The clone has to trust the same authority the remote really is, or the actor
    // would be the one part of this run that could not reach it.
    const trust =
      this.certificatePath === undefined
        ? []
        : ['-c', `http.sslCAInfo=${this.certificatePath}`, '-c', 'http.sslVerify=true']
    await runGitRemote(
      this.gitBinary,
      [...trust, 'clone', ...this.cloneArgs, this.cloneSource, directory],
      this.env,
      this.abort.signal,
      // The working directory this clone is made from is inside the run's own root, not
      // this process's. A live run claims the real `git` for the directory it created,
      // and the claim is measured against the directory the command acts on — which for
      // a `clone` with no selector is where the child starts. Inheriting the checkout
      // running the command is outside that root by definition, so the clone was
      // refused for acting in a directory the run does not own.
      this.root,
    )
    // The actor runs the same Git the run does — same isolation, same credential
    // scope, same identity. An external clone that reached the remote by some other
    // route would be testing a configuration the races are supposed to be staged
    // against, and would be the one part of the run holding an unisolated credential.
    const workspace = new LocalGitWorkspace({
      path: directory,
      git: this.gitBinary,
      cloneSource: this.cloneSource,
      cloneArgs: this.cloneArgs,
      origin: this.origin,
      certificatePath: this.certificatePath,
      author: this.author,
      root: this.root,
      env: this.env,
    })
    workspace.git(['config', 'user.name', this.author.name])
    workspace.git(['config', 'user.email', this.author.email])
    // A clone of a branch the other actor moved on must not be refused by the remote's
    // own configuration, so the fetch is allowed to be told the truth about divergence.
    workspace.git(['config', 'advice.detachedHead', 'false'])
    return workspace
  }

  close(): void {
    this.closed = true
  }
}
