import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { FileHandle } from 'node:fs/promises'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GitHubCliStatusService,
  forgetGitHubCliServices,
  parseGhVersion,
  probeGitHubCliVersion,
  readGitHubCli,
  type GitHubCliProvingTransport,
} from '../src/main/github-cli'
import { retirePrimaryGitHubRecord } from '../src/main/github-primary-record'
import { claimOwnedFile, CredentialVault, type SecretProtector } from '../src/main/credentials'
import { githubHostContext } from '../src/main/github-host'
import { GitHubResponseCacheStore } from '../src/main/github-response-cache'
import type { GitHubRestRequest, GitHubRestResponse } from '../src/main/github-transport'
import { GitHubTransportError } from '../src/main/github-transport'
import type { GitHubCliStatus } from '../src/shared/types'
import { admitOwnedProviderCliRoot } from './fixtures/owned-provider-cli'

const ENTERPRISE = 'ghe.example.com'
const CONCURRENT = 'ghe.concurrent.example.com'

async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'git-stacks-cli-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function deferred<T = void>(): {
  settled: Promise<T>
  release: (value: T) => void
} {
  let release!: (value: T) => void
  const settled = new Promise<T>((resolve) => {
    release = resolve
  })
  return { settled, release }
}

/**
 * A `gh` this run owns on a PATH that holds nothing else. It is a real child
 * process answering with the JSON the CLI itself writes, so what is under test
 * is the classification of an actual answer — including one printed alongside a
 * nonzero exit, which is how the CLI reports an authentication problem. The
 * directory it lands in is admitted by name, so the boundary answers for this
 * file and refuses everything else.
 */
async function installControlledGh(
  body: string,
  dir: string,
  name = 'gh',
): Promise<{ path: string; invoked: string }> {
  await mkdir(dir, { recursive: true })
  const marker = join(dir, 'invoked.txt')
  const binary = join(dir, name)
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + '\\n')
${body}
`,
  )
  await chmod(binary, 0o755)
  // The directory this CLI was written into is admitted by name, so the boundary
  // answers for this file and refuses every other `gh` — including the one on
  // this machine, which is exactly what a fixture must never be able to reach.
  admitOwnedProviderCliRoot(dir)
  return { path: dir, invoked: marker }
}

/** The answer the CLI writes for one host, with its active account. */
function authJson(
  host: string,
  entries: Array<{ state?: string; active?: boolean; login?: string }>,
): string {
  return JSON.stringify({
    hosts: {
      [host]: entries.map((entry) => ({
        state: entry.state ?? 'success',
        active: entry.active ?? false,
        host,
        login: entry.login ?? '',
        ...(entry.state === 'success' ? {} : { type: 'oauth' }),
      })),
    },
  })
}

/**
 * The transport a read proves its credential with, stubbed at the boundary the
 * production code uses. It is the same `Pick` production takes, so a change to
 * what the read may call is a compile error rather than a silent stub.
 *
 * The proof is the GraphQL `viewer { login }` the CLI itself resolves a login
 * through, so the answer here is the account the host names, and nothing else.
 * `requestAuthority` is what that request reports carrying, which is the leg the
 * pins either side of it cannot speak for: a credential replaced and put back
 * mid-request leaves both pins agreeing with each other.
 */
function provingTransport(
  answer: (query: string) => { login?: unknown } | Promise<{ login?: unknown }>,
  authority: () => string = () => 'proven-authority',
  requestAuthority: (() => string) | null = null,
  // Where this read's requests go, which is the host the read asks the CLI
  // about. It is this file's host unless the test is about a read pointed
  // somewhere else.
  destinationHost: string = ENTERPRISE,
): GitHubCliProvingTransport {
  let carried: string | null = null
  return {
    // Where this read's requests actually go. A read asks the CLI about the host
    // that answers them, so a caller supplying its own transport has to say where
    // that is rather than leaving the question to the selected host's name.
    destinationHost,
    // The response body is whatever the host answered with; the read projects it
    // through the same guards it uses for any host's answer. The credential this
    // request carried is settled at the moment the request is made — the moment
    // a replacement would slip between the two pins — and reported with it.
    graphqlWithAuthority: async <T = unknown>(query: string) => {
      carried = requestAuthority === null ? authority() : requestAuthority()
      return { data: { viewer: await answer(query) } as T, authority: carried }
    },
    // The credential boundary a request made now would be pinned to. It is
    // resolved from the same answer the proof request was, so a credential
    // replaced between the two is exactly what this reports.
    credentialAuthority: async () => authority(),
  }
}

/** One answer this read cannot get past a real transport. */
function refusingTransport(): GitHubCliProvingTransport {
  return provingTransport(() => {
    throw new GitHubTransportError({ kind: 'unauthorized', detail: 'refused' })
  })
}

test('a machine without the CLI, and one whose CLI will not answer, are different facts', async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, 'empty')
    await installControlledGh(`process.exit(0)`, dir)
    await rm(join(dir, 'gh'), { force: true })
    const absent = await probeGitHubCliVersion({ PATH: empty })
    assert.equal(absent.install, 'missing')
    assert.equal(absent.version, null)

    // Installed, but answering with something this build does not read.
    const malformed = join(dir, 'malformed')
    const cli = await installControlledGh(
      `process.stdout.write('gh version nightly at /Users/someone/tools/gh\\n')`,
      malformed,
    )
    const unreadable = await probeGitHubCliVersion({ PATH: cli.path })
    assert.equal(unreadable.install, 'present')
    assert.equal(unreadable.version, null)
  })
})

test('the version the CLI prints is projected, and nothing else it printed is', async () => {
  assert.deepEqual(parseGhVersion('gh version 2.62.0 (2024-11-14)'), {
    value: 'gh version 2.62.0',
    status: 'confirmed',
  })
  assert.deepEqual(parseGhVersion('gh version nightly /Users/someone/tools/gh'), {
    value: 'unrecognized GitHub CLI version output',
    status: 'unavailable',
  })
})

test('an account the CLI names is only authenticated once a real request succeeds', async () => {
  await withTempDir(async (dir) => {
    const host = githubHostContext(ENTERPRISE)
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(1)`,
      dir,
    )
    const env = { PATH: cli.path }
    const proven = await readGitHubCli(host, {
      env,
      transport: provingTransport((request) => {
        assert.match(request, /viewer/u)
        return { login: 'octocat' }
      }),
    })
    assert.equal(proven.state, 'authenticated')
    assert.equal(proven.login, 'octocat')
    assert.ok(proven.authority, 'a proven credential has an identity to fence on')

    // The same answer, with a credential the host refuses, is a rejection rather
    // than an authentication: a claim the CLI made is not a proof.
    const refused = await readGitHubCli(host, {
      env,
      transport: refusingTransport(),
    })
    assert.equal(refused.state, 'rejected')
    assert.equal(refused.login, null)
    assert.equal(refused.authority, null)
  })
})

test('the proof is the request that carried the credential, not only the pins around it', async () => {
  await withTempDir(async (dir) => {
    const host = githubHostContext(ENTERPRISE)
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(1)`,
      dir,
    )
    const env = { PATH: cli.path }

    // The credential the request itself carried is the one that proved the
    // account. A request made as somebody else, even while the host resolves the
    // pinned credential either side of it, is another account's answer.
    const anotherCredential = await readGitHubCli(host, {
      env,
      transport: provingTransport(
        () => ({ login: 'octocat' }),
        () => 'authority-a',
        // The credential replaced and put back between the two pins: the pins
        // agree with each other, and the request in between was not this one.
        () => 'authority-b',
      ),
    })
    assert.equal(
      anotherCredential.state,
      'unavailable',
      'a proof request authenticated as another credential is not this credential proven',
    )
    assert.equal(anotherCredential.login, null)
    assert.equal(anotherCredential.authority, null)

    // The same read with a request that carried the credential the pins name is
    // a proof, so the refusal above is about the credential and not about this
    // build refusing every proof.
    const agreed = await readGitHubCli(host, {
      env,
      transport: provingTransport(
        () => ({ login: 'octocat' }),
        () => 'authority-a',
      ),
    })
    assert.equal(agreed.state, 'authenticated')
    assert.equal(agreed.login, 'octocat')
    assert.equal(agreed.authority, 'authority-a')
  })
})

test('the account field is the login the CLI writes, and nothing else reads as one', async () => {
  await withTempDir(async (dir) => {
    const host = githubHostContext(ENTERPRISE)
    // Each record names the host that was asked about and is otherwise whatever
    // the case is about, so what varies is only the field the account sits in.
    const withAccountIn = async (field: string, name: string) => {
      const path = join(dir, name)
      const record = { state: 'success', active: true, host: host.host, type: 'oauth' }
      const cli = await installControlledGh(
        `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(
          JSON.stringify({ hosts: { [host.host]: [{ ...record, [field]: 'octocat' }] } }),
        )} + '\\n')
process.exit(1)`,
        path,
      )
      return readGitHubCli(host, {
        env: { PATH: cli.path },
        transport: provingTransport(() => ({ login: 'octocat' })),
      })
    }

    // The schema the CLI actually writes: `gh auth status --json hosts` names the
    // account `login`, the same field the REST user endpoint names it. A shape
    // this app invented alongside it would read the real CLI's answer as naming
    // no account at all, so the name is asserted rather than assumed.
    const named = await withAccountIn('login', 'login')
    assert.equal(named.state, 'authenticated')
    assert.equal(named.login, 'octocat')

    // A record carrying the account under any other name is not an account this
    // build may read: it names no login, so it cannot be authenticated. A shape
    // that both this build and its own CLI fixtures agree on but the real CLI
    // never writes is a self-consistent fiction, and this is what catches it.
    for (const field of ['user', 'account', 'name'] as const) {
      const other = await withAccountIn(field, field)
      assert.notEqual(
        other.state,
        'authenticated',
        `an account named ${field} authenticated, which no CLI writes`,
      )
      assert.equal(other.login, null)
    }
  })
})

test('an account refused by the CLI, one that timed out, and an empty map are three states', async () => {
  await withTempDir(async (dir) => {
    const host = githubHostContext(ENTERPRISE)
    const withAnswer = async (answer: string, exit: number, name: string) => {
      const path = join(dir, name)
      const cli = await installControlledGh(
        `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(answer)} + '\\n')
process.exit(${exit})`,
        path,
      )
      return readGitHubCli(host, { env: { PATH: cli.path } })
    }
    // An authentication problem the CLI prints and then exits nonzero for.
    const refused = await withAnswer(
      authJson(ENTERPRISE, [{ state: 'error', active: true, login: 'octocat' }]),
      1,
      'refused',
    )
    assert.equal(refused.state, 'rejected')

    // A host that did not answer while the CLI checked it.
    const timedOut = await withAnswer(
      authJson(ENTERPRISE, [{ state: 'timeout', active: true, login: 'octocat' }]),
      1,
      'timeout',
    )
    assert.equal(timedOut.state, 'offline')

    // Nobody signed in, printed with a zero exit code.
    const empty = await withAnswer(JSON.stringify({ hosts: {} }), 0, 'empty')
    assert.equal(empty.state, 'signed-out')

    // An account the CLI holds but is not using is not the one requests carry.
    const inactive = await withAnswer(
      authJson(ENTERPRISE, [{ active: false, login: 'octocat' }]),
      0,
      'inactive',
    )
    assert.equal(inactive.state, 'signed-out')

    // An answer this build does not read is unavailable rather than a guess.
    const unknown = await withAnswer(JSON.stringify({ hosts: { [ENTERPRISE]: {} } }), 0, 'unknown')
    assert.equal(unknown.state, 'unavailable')
    const notJson = await withAnswer('gh: not json', 0, 'notjson')
    assert.equal(notJson.state, 'unavailable')
  })
})

test('an account is not established by a credential this process was handed for the host', async () => {
  await withTempDir(async (dir) => {
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(JSON.stringify({ hosts: {} }) + '\\n')
process.exit(0)`,
      dir,
    )
    // A headless credential for this host authenticates the CLI's requests, and
    // the CLI answers with no stored session for it. It is still a credential,
    // and it is still proved by the same request as any other.
    let asked = 0
    const result = await readGitHubCli(githubHostContext(ENTERPRISE), {
      env: { PATH: cli.path, GH_ENTERPRISE_TOKEN: 'headless-secret' },
      transport: provingTransport(() => {
        asked += 1
        return { login: 'headless-bot' }
      }),
    })
    assert.equal(asked, 0, 'a credential with no account behind it is not read as one')
    assert.equal(result.state, 'signed-out')
  })
})

test('no CLI output, credential, or path to one reaches the status', async () => {
  await withTempDir(async (dir) => {
    const secret = 'ghp_thisoutputcredential0000000000000'
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(JSON.stringify({ hosts: { '${ENTERPRISE}': [{ state: 'error', active: true, host: '${ENTERPRISE}', login: '${secret}', token: '${secret}' }] } }) + '\\n')
process.stderr.write('gh: ${secret} at /Users/someone/.config/gh\\n')
process.exit(1)`,
      dir,
    )
    const status = await readGitHubCli(githubHostContext(ENTERPRISE), {
      env: { PATH: cli.path },
    })
    const published = JSON.stringify(status)
    assert.equal(published.includes(secret), false)
    assert.equal(published.includes('/Users/someone'), false)
    assert.equal(status.login, null)
  })
})

test('an equivalent refresh keeps the identity, and a replaced credential makes a new one', async () => {
  await withTempDir(async (dir) => {
    const host = githubHostContext(ENTERPRISE)
    const account = 'account-a'
    let authority = 'authority-a'
    let reads = 0
    const transport = provingTransport(
      () => {
        reads += 1
        return { login: account }
      },
      () => authority,
    )
    // The CLI is read once per status read, and each read proves the credential
    // itself: nothing is answered for a credential from an earlier read.
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'account-a' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    const published: GitHubCliStatus[] = []
    const service = new GitHubCliStatusService(ENTERPRISE, {
      env: { PATH: cli.path },
      transport,
      onChange: (status) => published.push(status),
    })
    const first = await service.read()
    assert.equal(first.state, 'authenticated')
    assert.equal(reads, 1)
    assert.equal(first.identity, 'ghcli-1')

    // The same account, the same credential, read again: one more proof, the same
    // identity, and nothing published because nothing changed.
    const again = await service.read()
    assert.equal(again.identity, first.identity)
    assert.equal(reads, 2, 'a refresh does not answer from the previous proof')
    assert.equal(published.length, 1)

    // The credential behind the same account is replaced in the CLI. Rows read
    // under the old one belong to somebody else, so this is a new identity.
    authority = 'authority-b'
    const replaced = await service.read()
    assert.notEqual(replaced.identity, first.identity)
    assert.equal(replaced.identity, 'ghcli-2')

    // Switching back is a further replacement, not a return to the old rows.
    authority = 'authority-a'
    const switchedBack = await service.read()
    assert.notEqual(switchedBack.identity, replaced.identity)
    assert.equal(switchedBack.identity, 'ghcli-3')

    // Concurrent callers share one read, so two callers cannot be answered by two
    // proofs taken at different moments.
    let concurrent = 0
    const gate = Promise.withResolvers<void>()
    const concurrentCli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(CONCURRENT, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      join(dir, 'concurrent'),
    )
    const slow = new GitHubCliStatusService(CONCURRENT, {
      env: { PATH: concurrentCli.path },
      transport: provingTransport(
        async () => {
          concurrent += 1
          await gate.promise
          return { login: 'octocat' }
        },
        undefined,
        undefined,
        CONCURRENT,
      ),
    })
    const reads3 = Promise.all([slow.read(), slow.read(), slow.read()])
    gate.resolve()
    await reads3
    assert.equal(concurrent, 1)
  })
})

test('a service retired with a read still running publishes nothing when it lands', async () => {
  await withTempDir(async (dir) => {
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    const published: GitHubCliStatus[] = []
    const gate = Promise.withResolvers<void>()
    const service = new GitHubCliStatusService(ENTERPRISE, {
      env: { PATH: cli.path },
      transport: provingTransport(async () => {
        await gate.promise
        return { login: 'octocat' }
      }),
      onChange: (status) => published.push(status),
    })
    const reading = service.read()
    forgetGitHubCliServices()
    service.retire()
    gate.resolve()
    const settled = await reading
    // The abandoned read answers with the last status this host established,
    // which for a service that never established one is the state it was in.
    assert.equal(settled.state, 'checking')
    assert.deepEqual(published, [], 'a retired host publishes its late answer')
    assert.equal(
      service.current().state,
      'checking',
      'an answer for a retired host is not recorded as its current status',
    )
  })
})

test('a read whose credential was replaced while it proved is discarded, and replaces nothing', async () => {
  await withTempDir(async (dir) => {
    // The credential the proof is pinned to, and the one the CLI holds when the
    // proof lands: they differ, because it was replaced in between.
    let proven = 'credential-a'
    let current = 'credential-a'
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    const published: GitHubCliStatus[] = []
    const service = new GitHubCliStatusService(ENTERPRISE, {
      env: { PATH: cli.path },
      // The proof answers for credential A, and by the time it lands the CLI holds
      // B: a read that can no longer speak for what is current is not published.
      transport: provingTransport(
        () => {
          const authority = proven
          current = 'credential-b'
          return { login: 'octocat' }
        },
        () => current,
      ),
      onChange: (status) => published.push(status),
    })
    const status = await service.read()
    assert.equal(
      status.state,
      'unavailable',
      'an answer about a replaced credential is not the current status',
    )
    assert.equal(status.identity, null, 'a credential that was replaced mid-proof names no account')
    assert.deepEqual(
      published.filter((entry) => entry.identity !== null),
      [],
      'a replaced credential publishes no account',
    )
    // The replacement this read could not speak for is left exactly as it stands,
    // and the next read speaks for it.
    proven = 'credential-b'
    const next = await service.read()
    assert.equal(next.state, 'authenticated')
    assert.equal(
      next.identity,
      'ghcli-1',
      'the surviving credential is the identity, not the discarded one',
    )
  })
})

test('a credential replaced under a status this service already published is retired, not kept', async () => {
  await withTempDir(async (dir) => {
    // The credential a proof is pinned to, and the one the host resolves when
    // that proof is revalidated. They differ, because the CLI was rewritten in
    // between: the proof speaks for a credential that no longer exists.
    let proven = 'credential-a'
    let current = 'credential-a'
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    const published: GitHubCliStatus[] = []
    const service = new GitHubCliStatusService(ENTERPRISE, {
      env: { PATH: cli.path },
      transport: provingTransport(
        () => {
          const authority = proven
          // Rewritten only once this service has published the credential it was
          // first given: from then on the credential is never the one a proof
          // was pinned to, so no attempt can establish this host.
          if (published.length > 0) current = `credential-rotating-${current}`
          return { login: 'octocat' }
        },
        () => current,
      ),
      onChange: (status) => published.push(status),
    })

    const first = await service.read()
    assert.equal(first.state, 'authenticated')
    assert.equal(first.identity, 'ghcli-1')

    proven = 'credential-rotating'
    const stale = await service.read()
    // Returning the authenticated status this service already published would
    // describe A as the current account after private revalidation disproved it.
    assert.notEqual(
      stale.identity,
      first.identity,
      'a disproved identity is still being published as the current account',
    )
    assert.equal(stale.login, null, 'a status for no proven credential names no account')
    assert.equal(
      published.at(-1)?.identity,
      null,
      'the window is not told the retired identity is still current',
    )
    // And the retirement is observable: the identity this service described is
    // gone, so rows read under it stop being fenced by it.
    assert.notEqual(service.current().identity, first.identity)
  })
})

test('a read that cannot establish the host stops asking instead of waiting on itself', async () => {
  await withTempDir(async (dir) => {
    // Every proof is overtaken, so the read has to give up on its own terms. It
    // used to answer by asking for a read again while the first one was still the
    // read in flight, which is a promise waiting on itself and never settles.
    // How many proofs it spent is what proves it gave up: a read that never
    // settles spends them forever, and does so without any clock to notice.
    let answer = 'credential-a'
    let proofs = 0
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    const service = new GitHubCliStatusService(ENTERPRISE, {
      env: { PATH: cli.path },
      transport: provingTransport(
        async () => {
          proofs += 1
          const authority = answer
          answer = 'credential-rotating'
          return { login: 'octocat' }
        },
        () => answer,
      ),
    })
    const settled = await service.read()
    assert.equal(settled.host, ENTERPRISE, 'the read answered for the host it was asked about')
    assert.ok(proofs > 0, 'the credential was never proved, so the read proves nothing')
    assert.ok(
      proofs <= 8,
      `a read that cannot establish the host asked ${proofs} times and is not stopping`,
    )
  })
})

test('an answer that is not an identity is no identity at all', async () => {
  await withTempDir(async (dir) => {
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(authJson(ENTERPRISE, [{ active: true, login: 'octocat' }]))} + '\\n')
process.exit(0)`,
      dir,
    )
    // A 200 that names no account, and one that names something that cannot be one.
    for (const answeredLogin of [
      { notLogin: 'octocat' },
      // A real token's shape and length: 40 characters, so this is refused for
      // being longer than any account name can be, not for looking like one.
      { login: 'ghp_C7dT9mQ2vXk4Lp6Rb8Nf3Zs5Yw1Jq0Hu' },
      // A shortcode suffix on its own is not an account name either.
      { login: '_ab12' },
      { login: 'x'.repeat(40) },
    ]) {
      const read = await readGitHubCli(githubHostContext(ENTERPRISE), {
        env: { PATH: cli.path },
        transport: provingTransport(
          () => ({ login: answeredLogin }),
          () => 'authority',
        ),
      })
      assert.equal(
        read.state,
        'unavailable',
        `a 200 naming ${JSON.stringify(answeredLogin)} is not an account`,
      )
      assert.equal(read.login, null)
      assert.equal(read.authority, null)
    }
    // The CLI's own claim is not read over an unanswered one either.
    const cliOnly = await readGitHubCli(githubHostContext(ENTERPRISE), {
      env: { PATH: cli.path },
      transport: provingTransport(
        () => ({}),
        () => 'authority',
      ),
    })
    assert.equal(cliOnly.state, 'unavailable')
    assert.equal(cliOnly.login, null)
  })
})

test('an Enterprise Managed User is an account, and a credential is not', async () => {
  await withTempDir(async (dir) => {
    const emuHost = 'ghe.managed.example.com'
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(
        authJson(emuHost, [{ state: 'success', active: true, login: 'mona-cat_ab12' }]),
      )} + '\\n')
process.exit(0)`,
      dir,
    )
    // The documented Enterprise Managed User form is a real account name on an
    // enterprise host, and the CLI naming it is not a malformed answer: the read
    // proves it with a real request against this host, which answers.
    const read = await readGitHubCli(githubHostContext(emuHost), {
      env: { PATH: cli.path },
      transport: provingTransport(
        () => ({ login: 'mona-cat_ab12' }),
        () => 'emu-authority',
        null,
        emuHost,
      ),
    })
    assert.equal(read.state, 'authenticated')
    assert.equal(read.login, 'mona-cat_ab12')
    assert.equal(read.authority, 'emu-authority')
  })
})

test('a CLI record about another host, or with no state of its own, is not this host', async () => {
  await withTempDir(async (dir) => {
    const claim = (entry: Record<string, unknown>): string =>
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stdout.write(${JSON.stringify(JSON.stringify({ hosts: { [ENTERPRISE]: [entry] } }))} + '\\n')
process.exit(0)`
    for (const entry of [
      { state: 'success', active: true, host: 'ghe.other.example.com', login: 'octocat' },
      { active: true, host: ENTERPRISE, login: 'octocat' },
      { state: 'unknown-future-state', active: true, host: ENTERPRISE, login: 'octocat' },
    ]) {
      const cli = await installControlledGh(claim(entry), dir)
      const read = await readGitHubCli(githubHostContext(ENTERPRISE), {
        env: { PATH: cli.path },
        transport: provingTransport(() => ({ login: 'octocat' })),
      })
      assert.equal(
        read.state,
        'unavailable',
        `a CLI record that is not about this host, or says nothing about itself, is unread: ${JSON.stringify(entry)}`,
      )
    }
  })
})

test('a CLI that fails loudly about a credential publishes nothing of what it printed', async () => {
  await withTempDir(async (dir) => {
    // A failing CLI that writes what it knows where an operator would see it.
    const cli = await installControlledGh(
      `const args = process.argv.slice(2)
if (args[0] === '--version') { process.stdout.write('gh version 2.62.0\\n'); process.exit(0) }
process.stderr.write('error: could not authenticate\\nghp_leaked0000000000000000000000000000\\nhosts.yml: /Users/someone/.config/gh/hosts.yml\\n')
process.exit(1)`,
      dir,
    )
    const read = await readGitHubCli(githubHostContext(ENTERPRISE), {
      env: { PATH: cli.path },
      transport: refusingTransport(),
    })
    const published = JSON.stringify(read)
    assert.equal(
      read.state,
      'unavailable',
      'a CLI that failed to produce a record has produced no account',
    )
    for (const leaked of ['ghp_leaked', '/Users/someone', 'hosts.yml', 'could not authenticate']) {
      assert.equal(published.includes(leaked), false, `the status carried ${leaked}: ${published}`)
    }
  })
})

test("a store that is not this app's own file, or cannot be read, is never rewritten", async () => {
  await withTempDir(async (dir) => {
    const protector: SecretProtector = {
      store: () => ({ kind: 'system', name: 'test store', reason: null }),
      seal: (plain: string) => Buffer.from(plain, 'utf8').reverse(),
      open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    const owned = join(dir, 'owned.vault.json')
    const owner = new CredentialVault(owned, protector)
    const reference = await owner.stage(ENTERPRISE, 'ghp_appownedsecret000000000000', Date.now())
    const stateFile = join(dir, 'github-account.json')
    await writeFile(
      stateFile,
      JSON.stringify({
        reference,
        host: ENTERPRISE,
        login: 'octocat',
        createdAt: 1,
        expiresAt: null,
        refreshExpiresAt: null,
        session: 'session-1',
      }),
    )
    const before = await readFile(owned, 'utf8')

    // A vault whose file is a link is something a person pointed at: the entries
    // behind it are never read and the link's target is never rewritten.
    const linked = join(dir, 'linked.vault.json')
    const target = join(dir, 'somebody-elses.vault.json')
    await writeFile(target, before)
    await symlink(target, linked)
    assert.equal(
      (
        await retirePrimaryGitHubRecord({
          stateFile,
          vault: new CredentialVault(linked, protector),
          vaultFile: linked,
        })
      ).retired,
      false,
      'a record was retired through a linked store',
    )
    assert.equal(await readFile(target, 'utf8'), before, 'the file behind the link was rewritten')

    // A store whose own file says nothing readable is left exactly as it is.
    const malformed = join(dir, 'malformed.vault.json')
    await writeFile(malformed, '{"version":1,"entries":')
    assert.equal(
      (
        await retirePrimaryGitHubRecord({
          stateFile,
          vault: new CredentialVault(malformed, protector),
          vaultFile: malformed,
        })
      ).retired,
      false,
      'a record was retired through a store that could not be read',
    )
    assert.equal(await readFile(malformed, 'utf8'), '{"version":1,"entries":')
    assert.equal(await readFile(stateFile, 'utf8').then((text) => text.includes(reference)), true)
  })
})

test('the app-owned primary record is retired only when every part of it verifies', async () => {
  await withTempDir(async (dir) => {
    // A store this run owns. The record is retired without ever opening a sealed
    // value, so the protector here only has to seal what a credential needs.
    const protector: SecretProtector = {
      store: () => ({ kind: 'system', name: 'test store', reason: null }),
      seal: (plain: string) => Buffer.from(plain, 'utf8').reverse(),
      open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    const vaultFile = join(dir, 'credentials.vault.json')
    const vault = new CredentialVault(vaultFile, protector)
    const reference = await vault.stage(ENTERPRISE, 'ghp_appownedsecret000000000000', Date.now())
    const other = await vault.stage(ENTERPRISE, 'ghp_notificationsecret000000000', Date.now())
    const stateFile = join(dir, 'github-account.json')
    const record = (over: Record<string, unknown> = {}) => ({
      reference,
      host: ENTERPRISE,
      login: 'octocat',
      createdAt: 1,
      expiresAt: null,
      refreshExpiresAt: null,
      session: 'session-1',
      ...over,
    })

    // A record that is this build's own is retired, and only its own entry goes.
    await writeFile(stateFile, JSON.stringify(record()))
    const retired = await retirePrimaryGitHubRecord({ stateFile, vault, vaultFile })
    assert.deepEqual(retired, { retired: true, host: ENTERPRISE })
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [other],
      'a credential this build did not own was removed with its own',
    )
    assert.equal(await readFile(stateFile, 'utf8').catch(() => ''), '')

    // A record naming a credential the vault does not hold is left alone.
    await writeFile(stateFile, JSON.stringify(record({ reference: 'unknown-reference' })))
    assert.deepEqual(await retirePrimaryGitHubRecord({ stateFile, vault, vaultFile }), {
      retired: false,
      host: null,
    })
    assert.ok(await readFile(stateFile, 'utf8'))

    // A record whose credential was sealed for another host is not this build's
    // to remove, whatever it names.
    const foreign = await vault.stage(
      'other.example.com',
      'ghp_othersecret0000000000000',
      Date.now(),
    )
    await writeFile(stateFile, JSON.stringify(record({ reference: foreign, host: ENTERPRISE })))
    assert.equal((await retirePrimaryGitHubRecord({ stateFile, vault, vaultFile })).retired, false)
    assert.ok(await readFile(stateFile, 'utf8'))

    // A shape this build does not recognise is somebody else's file, and is left
    // exactly as it is rather than guessed at.
    for (const unknown of [
      { host: ENTERPRISE },
      { reference },
      record({ createdAt: 'yesterday' }),
      record({ session: 42 }),
      record({ unexpected: 'field' }),
    ]) {
      await writeFile(stateFile, JSON.stringify(unknown))
      assert.equal(
        (await retirePrimaryGitHubRecord({ stateFile, vault, vaultFile })).retired,
        false,
        `an unknown record was retired: ${JSON.stringify(unknown)}`,
      )
    }

    // Every one of those decisions was made without opening a sealed value, and
    // the one credential this build never owned is still exactly where it was.
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference).sort(),
      [foreign, other].sort(),
    )
    // The CLI's own credential storage is not this file at all: nothing here was
    // read from, or written to, anywhere but this vault.
    assert.equal(
      await readFile(join(dir, 'credentials.vault.json'), 'utf8').then((text) =>
        text.includes('ghp_appowned'),
      ),
      false,
    )
  })
})

test('a record naming a credential another module holds cannot delete it', async () => {
  await withTempDir(async (dir) => {
    const protector: SecretProtector = {
      store: () => ({ kind: 'system', name: 'test store', reason: null }),
      seal: (plain: string) => Buffer.from(plain, 'utf8').reverse(),
      open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    const vaultFile = join(dir, 'credentials.vault.json')
    const vault = new CredentialVault(vaultFile, protector)
    // A Notifications credential is a vault entry of exactly the shape this
    // build writes, for exactly the same host. Nothing inside the vault tells it
    // apart from this build's own primary credential, so what the Notifications
    // center currently holds is the only thing that can.
    const notifications = await vault.stage(ENTERPRISE, 'ghp_notificationsecret000000000000', 1)
    const stateFile = join(dir, 'github-account.json')
    const record = {
      reference: notifications,
      host: ENTERPRISE,
      login: 'octocat',
      createdAt: 1,
      expiresAt: null,
      refreshExpiresAt: null,
      session: 'session-1',
    }

    // A record that is otherwise entirely valid, and names a live Notifications
    // reference: it is refused, and the credential it named is still stored.
    await writeFile(stateFile, JSON.stringify(record))
    assert.deepEqual(
      await retirePrimaryGitHubRecord({
        stateFile,
        vault,
        vaultFile,
        protectedReferences: [notifications],
      }),
      { retired: false, host: null },
      'a live Notifications credential was retired by a state file naming it',
    )
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [notifications],
      'the Notifications credential was deleted',
    )
    assert.ok(await readFile(stateFile, 'utf8'), 'the record was removed without removing anything')

    // The same record, when that reference is one this build does hold and no
    // other module claims, is retired as before: the protection is the live
    // holder, not the shape of the record.
    const own = await vault.stage(ENTERPRISE, 'ghp_appownedsecret000000000000', 1)
    await writeFile(stateFile, JSON.stringify({ ...record, reference: own }))
    assert.deepEqual(
      (await retirePrimaryGitHubRecord({ stateFile, vault, vaultFile })).retired,
      true,
    )
    assert.deepEqual(
      (await vault.references()).map((entry) => entry.reference),
      [notifications],
      'the Notifications credential went with the record that did not name it',
    )
  })
})

test('a store this build set aside is never put back over another writer', async () => {
  await withTempDir(async (dir) => {
    const protector: SecretProtector = {
      store: () => ({ kind: 'system', name: 'test store', reason: null }),
      seal: (plain: string) => Buffer.from(plain, 'utf8').reverse(),
      open: (sealed: Buffer) => Buffer.from(sealed).reverse().toString('utf8'),
    }
    const vaultFile = join(dir, 'credentials.vault.json')
    const vault = new CredentialVault(vaultFile, protector)
    await vault.stage(ENTERPRISE, 'ghp_keptsecret00000000000000', 1)

    // A store this build took aside, and could not install over a path another
    // writer had already taken while it held the claim. Putting the set-aside
    // file back must not replace that writer's store: it holds entries this one
    // never saw, and they are destroyed by a plain rename.
    const claimed = await claimOwnedFile(vaultFile)
    assert.ok(claimed, 'the store could not be taken aside')
    const replacement = JSON.stringify({ version: 1, entries: [], extras: {}, other: 'writer' })
    await writeFile(vaultFile, replacement)
    await claimed.restore()
    assert.equal(
      await readFile(vaultFile, 'utf8'),
      replacement,
      "a writer's new store was overwritten by a file that had only been moved aside",
    )

    // And the vault still works afterwards: the file this build owns is the one
    // it can read back, so a claim that could not be restored did not break it.
    assert.deepEqual(
      (await new CredentialVault(vaultFile, protector).references()).length,
      0,
      'the store this build owns is no longer the one it can read',
    )
  })
})
