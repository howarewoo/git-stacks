import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A Git environment this run owns, and the process variables that make every Git
 * in it behave the way the run means it to.
 *
 * The problem this exists for is not tidiness. A Git command reads more than its
 * arguments: it reads the home directory, the system and global configuration, the
 * template directory it copies hooks out of, whatever `GIT_DIR` and
 * `GIT_WORK_TREE` happen to say, any `credential.helper` a developer configured,
 * and any tracing that is switched on. A live run is the one place in this
 * repository where a real personal credential is in the environment, and a run
 * that lets an inherited `core.hooksPath` execute during its own setup has handed
 * that credential to a program nobody in the run chose. So the boundary is drawn
 * here, before the first Git command, and it is drawn for every Git: the ones this
 * suite starts, the ones an external clone starts, and the ones the application's
 * own services start — which is why the isolation is installed into the process
 * environment rather than passed as an argument nobody else passes.
 *
 * Nothing here is weakened to make a run work. Hooks are pointed at a directory
 * this run created and left empty, templates likewise, signing is off, helpers are
 * cleared, and tracing is off. The one credential that is added is the run's own,
 * scoped by URL to the disposable repository it is for.
 */
export interface IsolatedGitEnvironment {
  /** The environment every Git command in this run is executed with. */
  readonly env: NodeJS.ProcessEnv
  /**
   * Puts this environment into the process, exactly.
   *
   * `Object.assign(process.env, ...)` cannot do this on its own: it adds and
   * overwrites but never removes, so every variable this environment retires —
   * an inherited `GIT_DIR`, a `credential.helper`, a `GIT_TRACE_CURL`, the
   * `GIT_STACKS_GITHUB_TOKEN` somebody else configured — would stay in the process
   * for the whole run and still be read by every Git the application's own services
   * start. That is the difference between an environment object and an installed one,
   * so it is spelled out rather than left to the caller to get right.
   */
  install(): void
  /**
   * Puts the process back the way the run found it. Every variable this installed is
   * removed and every variable it replaced is restored, whether the run succeeded,
   * failed, or was killed mid-command.
   */
  restore(): void
  /**
   * More than one credential, when the run acts as more than one account.
   *
   * Each is scoped to the URL of the repository it is for, and Git presents only the
   * header whose URL prefix matches the remote in hand. That is what lets one run
   * clone the primary's repository and the reviewer's fork in the same clone
   * directory without either account's token ever being offered to the other's
   * remote.
   */
  readonly credentials?: ReadonlyArray<{ readonly url: string; readonly header: string }>
}

/**
 * Variables that redirect Git away from the clone it was pointed at, or that carry
 * a credential into a command the run did not authorise. Each is removed rather
 * than overridden, because an empty value is not the same as an absent one: Git
 * reads an empty `GIT_DIR` as an empty directory name.
 */
const AMBIENT_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  // `GIT_SSL_NO_VERIFY` turns off certificate verification for every command in the
  // process, and it outranks the `http.sslVerify` this run sets — Git's own
  // documentation of that setting is "Defaults to true. Can be overridden by the
  // GIT_SSL_NO_VERIFY environment variable"
  // (https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpsslVerify) —
  // so a host with a certificate nothing vouches for would be accepted, which is the
  // one thing the certificate this run pins exists to prevent. Git's answer is a
  // certificate authority file and `http.sslVerify`, both of which the run sets below.
  'GIT_SSL_NO_VERIFY',
  'GIT_TEMPLATE_DIR',
  'GIT_ATTR_NOSYSTEM',
  'GIT_CREDENTIAL_HELPER',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_LFS_SKIP_SMUDGE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const

/**
 * Every way Git can be asked to narrate itself, including the setting that decides
 * whether what it narrates is redacted. A trace is the single most likely way a
 * credential reaches a log: the authorization header this run installs is exactly
 * the value a `GIT_TRACE_CURL` prints.
 */
const TRACING_VARIABLES = [
  'GIT_TRACE',
  'GIT_TRACE_SETUP',
  'GIT_TRACE_SHALLOW',
  'GIT_TRACE_CURL',
  // Git's libcurl-level verbose tracing, under its own name: "GIT_CURL_VERBOSE tells
  // Git to emit all the messages generated by that library"
  // (https://git-scm.com/book/be/v2/Git-Internals-Environment-Variables). It turns on
  // the same narration `GIT_TRACE_CURL` does, so a purge naming only that one leaves a
  // run that inherits this one printing the authorization header this run installs into
  // whatever captures a Git command's stderr.
  'GIT_CURL_VERBOSE',
  'GIT_TRACE_CURL_NO_DATA',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_REDACT',
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE2_BRIEF',
] as const

/**
 * Node's own answer to the same question, which Git's list cannot reach.
 *
 * The API transport is `fetch` in this process, and Node reads these two variables when
 * it opens the TLS connection rather than when a transport is built: `fetch` reached a
 * host whose certificate nothing vouches for while `NODE_TLS_REJECT_UNAUTHORIZED` was
 * `0`, carrying the authorization header a live run installs. Retiring `GIT_SSL_NO_VERIFY`
 * secures the Git children and leaves that request exactly as unverified as it was, so
 * these are removed in the same install, which runs before the first authenticated
 * request rather than after it. `NODE_EXTRA_CA_CERTS` is the opposite switch and is
 * retired with them: a run that has to reach a host has to name the authority itself.
 */
const NODE_TRANSPORT_VARIABLES = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS'] as const

export interface GitEnvironmentInput {
  /** A directory this run owns and may write into. */
  readonly home: string
  /**
   * The credentials this run authorizes, each scoped to the URL prefix of the
   * repository it is for, exactly as Git will see that URL.
   *
   * Scoping is what keeps two accounts apart in one clone: Git presents only the
   * header whose URL matches the remote in hand, so the reviewer's token is never
   * offered to the primary's remote, and no token is ever written into a URL where
   * `git remote -v`, `.git/config` and every diagnostic would show it.
   */
  readonly credentials?: ReadonlyArray<{ readonly url: string; readonly header: string }>
  /** Extra `-c` configuration this run needs on every command. */
  readonly config?: ReadonlyArray<readonly [string, string]>
  /** The identity commits and clones are made with, so a diff has an author. */
  readonly author: { readonly name: string; readonly email: string }
  /** Git's own host key checking, left to Git, for any transport that uses it. */
  readonly gitTlsCaInfo?: string
}

export async function installIsolatedGitEnvironment(
  input: GitEnvironmentInput,
): Promise<IsolatedGitEnvironment> {
  // A home and a template directory of this run's own, both empty. Home is what
  // Git reads global configuration and credential helpers out of; the template
  // directory is what Git copies hooks out of when it creates a repository. Empty
  // means there is nothing in either to inherit.
  const home = join(input.home, 'git-home')
  const template = join(input.home, 'git-template')
  await mkdir(home, { recursive: true })
  await mkdir(template, { recursive: true })
  await writeFile(join(home, '.gitconfig'), '', 'utf8')

  // The process exactly as this run found it. Isolation is only honest if it can be
  // undone, and it cannot be undone without knowing what was there: a variable this
  // run retires is one the ambient configuration may legitimately have set, and
  // restoring "the sanitized set" instead of this would both keep the run's own
  // credential headers installed and lose the ambient values for good.
  const original: NodeJS.ProcessEnv = { ...process.env }

  /**
   * Makes the process environment match `wanted` in both directions.
   *
   * Cleared and rewritten rather than merged in one pass, because merging cannot be
   * exact: a variable this run retired and then `Object.assign`ed back lands at the
   * end of the environment instead of where it was, so "the process is as it was"
   * would be true of the values and false of the object.
   */
  const replaceEnvironment = (wanted: NodeJS.ProcessEnv): void => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, wanted)
  }
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [...AMBIENT_GIT_VARIABLES, ...TRACING_VARIABLES, ...NODE_TRANSPORT_VARIABLES])
    delete env[name]
  // A run cannot reach github.com through an API base somebody else configured, and
  // cannot inherit a token this suite was not given. The live target pins its own
  // endpoints explicitly; the controlled target sets the base it is standing up.
  delete env.GIT_STACKS_GITHUB_API_URL
  delete env.GIT_STACKS_GITHUB_TOKEN
  delete env.GIT_STACKS_GITHUB_CREDENTIAL
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_STACKS_GITHUB_TOKEN_')) delete env[key]
  }

  // Every counted pair this process inherited goes, whatever its index. Git only reads
  // the first `GIT_CONFIG_COUNT` pairs, so a pair beyond the count this run sets is
  // ignored — but it is still a credential or a configuration value sitting in the
  // environment every Git child inherits, in every log that prints the environment, and
  // in this process for the rest of the run. The count is the run's own; the pairs are
  // the run's own too.
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key]
  }

  // Every `GIT_CONFIG_*` knob is now set by this run, not inherited, and the count
  // form is how several of them are supplied at once. `credential.helper` is set to
  // the empty string rather than removed, because an empty value is how Git is told
  // to have no helper at all; removing it would let the system configuration supply
  // one.
  const config: Array<[string, string]> = [
    // Hooks, if any run at all, run out of a directory this run created and left
    // empty. `core.hooksPath` is absolute, so a repository-local setting cannot
    // override it and a relative one cannot escape it.
    ['core.hooksPath', template],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
    ['credential.helper', ''],
    ['core.askPass', ''],
    ['gpg.format', 'openpgp'],
  ]
  if (input.gitTlsCaInfo !== undefined) {
    config.push(['http.sslCAInfo', input.gitTlsCaInfo], ['http.sslVerify', 'true'])
  }
  for (const credential of input.credentials ?? []) {
    config.push([`http.${credential.url}.extraheader`, credential.header])
  }
  for (const [key, value] of input.config ?? []) config.push([key, value])

  env.HOME = home
  env.XDG_CONFIG_HOME = home
  env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TEMPLATE_DIR = template
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_AUTHOR_NAME = input.author.name
  env.GIT_AUTHOR_EMAIL = input.author.email
  env.GIT_COMMITTER_NAME = input.author.name
  env.GIT_COMMITTER_EMAIL = input.author.email
  env.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })

  return {
    env,
    install: () => replaceEnvironment(env),
    // An exact inverse of `install`: the run's credential headers and its counted
    // GIT_CONFIG pairs go, and the ambient values the run overwrote come back.
    restore: () => replaceEnvironment(original),
  }
}
