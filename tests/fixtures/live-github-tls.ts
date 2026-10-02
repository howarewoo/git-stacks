import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import {
  Agent as HttpsAgent,
  createServer as createTlsServer,
  request as httpsRequest,
  type Server,
} from 'node:https'
import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubApiDouble } from './github-api-double'

/**
 * The controlled GitHub host, on a real TLS socket.
 *
 * The existing API double already answers GitHub's REST and GraphQL surfaces from
 * the harness's real-Git fixture state, and the existing merge-runtime test already
 * serves it over a plain socket. This puts the same double behind a certificate
 * that is generated for the run and verified for real, so the production transport
 * completes an actual handshake, sends an actual `Authorization` header, and
 * refuses an actual untrusted certificate. A stubbed `fetch` cannot show any of
 * that, and "the request reached the wrong host" is exactly the class of bug this
 * suite exists to catch.
 *
 * The same socket also serves Git's smart HTTP protocol, because a run that reached
 * its repository over one transport and its API over another would be proving two
 * hosts agree rather than one host behaving. With Git served here, the clone's
 * `origin` is a real HTTPS URL for this run's host: the application resolves a host
 * and a repository from it, pushes through it, and reads the API through it, and
 * nothing in the run can reach github.com.
 */
export interface ControlledGitHubHost {
  /** The origin the transport is pointed at, for example `https://127.0.0.1:41234`. */
  readonly url: string
  /** The authority of this host, which is what a remote URL for it must name. */
  readonly host: string
  /** The clone URL of one repository served from this host. */
  cloneUrl(fullName: string): string
  /**
   * The certificate to trust, by path. Git is told this file rather than being told to
   * stop verifying, so the handshake it completes is the one a real client completes.
   */
  readonly certificatePath: string
  /** A `fetch` that trusts exactly this run's certificate and nothing else. */
  readonly fetch: typeof globalThis.fetch
  /** The requests the double actually served, in order. */
  readonly served: Array<{ method: string; path: string; status: number }>
  close(): Promise<void>
}

/** What a run has to say about a directory of repositories this host serves. */
export interface ControlledGitHubHostOptions {
  /**
   * The directory whose immediate subdirectories are `<owner>/<name>.git`. A request
   * for anything else is not Git and goes to the API double.
   */
  readonly projectsRoot: string
  /** The one real `git` this run resolved, whose `git-http-backend` serves the protocol. */
  readonly git: string
  /**
   * Whether one Git request may proceed, and as whom.
   *
   * A Git request carries the same credential an API request does, and it has to be
   * answered with the same care: `git-http-backend` will serve any repository the
   * process can read to anybody who asks, and it names its own `REMOTE_USER` without
   * consulting one. A controlled run that leaves that unanswered proves nothing about
   * credentials — a fork the reviewer cannot read answers a push exactly like one it
   * can, so the boundary is only worth having if something at it refuses.
   *
   * The answer is the login the credential belongs to, which becomes the `REMOTE_USER`
   * the backend runs as, or a refusal. `null` means this host serves the repository
   * without deciding, which is the pre-existing behaviour.
   */
  readonly authorizeGit?: (
    fullName: string,
    authorization: string | undefined,
  ) => Promise<{ readonly login: string } | { readonly status: number; readonly message: string }>
}

/**
 * The account a Git request's `Authorization` header belongs to, or null.
 *
 * GitHub's documented form for a token over HTTPS is the token as a password with
 * `x-access-token` as the user, which is what a run installs, and that pair is what
 * comes back base64-encoded in the header. A header in any other shape, or one this
 * cannot decode, is not an identity this host is willing to reason about: it is
 * answered as no credential at all rather than as somebody.
 */
function gitAuthorizationSecret(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  const match = /^basic\s+(\S+)$/iu.exec(authorization.trim())
  if (match === null) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 1) return null
  const user = decoded.slice(0, separator)
  return user === 'x-access-token' ? decoded.slice(separator + 1) : null
}

export interface GeneratedCertificate {
  key: Buffer
  cert: Buffer
  /** The certificate as a file, because Git is told which file to trust. */
  certPath: string
  directory: string
}

/**
 * A self-signed certificate for 127.0.0.1, generated per call.
 *
 * Exported because the boundary a test has to observe is a certificate *nothing* vouches
 * for: this run's own host is pinned to the certificate it generated, so a client that
 * reaches it can be reaching it by trust or by a switch that skipped the question.
 */
export function generateCertificate(): GeneratedCertificate {
  const directory = mkdtempSync(join(tmpdir(), 'git-stacks-live-e2e-'))
  const key = join(directory, 'key.pem')
  const cert = join(directory, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      // A subject alternative name is what a modern client checks; the common name
      // alone is ignored, so without this the handshake would fail for the wrong
      // reason and the suite would prove nothing.
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert, directory }
}

/**
 * A `fetch` over `node:https` pinned to one certificate.
 *
 * Verification stays on. A suite that reached its own runtime by disabling TLS
 * checks would be unable to observe the failure it most needs to see: a credential
 * or a request leaving for a host the certificate does not cover.
 */
function pinnedFetch(certificate: Buffer, agent: HttpsAgent): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const url = new URL(typeof input === 'string' ? input : String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value
    })
    const body = typeof init?.body === 'string' ? init.body : undefined

    const response = await new Promise<{
      status: number
      headers: Record<string, string>
      text: string
    }>((resolve, reject) => {
      const client = httpsRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
          ca: certificate,
          // This host's own pool, not the one every request in this process would
          // otherwise share. A socket it opened is a socket it has to be able to close.
          agent,
          // RFC 6066 forbids an address in the SNI extension, and Node warns when one
          // is sent. A certificate whose subject alternative name is the address is
          // verified against that name regardless, so nothing is lost by omitting it.
          ...(net.isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
        },
        (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('end', () => {
            const received: Record<string, string> = {}
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === 'string') received[name] = value
              else if (Array.isArray(value)) received[name] = value.join(', ')
            }
            resolve({
              status: incoming.statusCode ?? 0,
              headers: received,
              text: Buffer.concat(chunks).toString('utf8'),
            })
          })
        },
      )
      const onAbort = () =>
        client.destroy(new DOMException('The operation was aborted.', 'AbortError'))
      init?.signal?.addEventListener('abort', onAbort, { once: true })
      client.on('error', (error) => reject(error))
      client.on('close', () => init?.signal?.removeEventListener('abort', onAbort))
      if (body) client.write(body)
      client.end()
    })

    // What this host served is recorded by its own handler, once per request. A client
    // that recorded its own answer as well would count every request it made twice, and
    // that journal is what a run reads to know how many requests it actually made.
    //
    // The production transport refuses redirects, so a 3xx here is a fault in the
    // host rather than a hop to follow.
    if (response.status >= 300 && response.status < 400) {
      throw new TypeError(`the controlled host answered a ${response.status} redirect`)
    }
    return new Response(response.status === 204 || response.status === 304 ? null : response.text, {
      status: response.status,
      headers: response.headers,
    })
  }) as typeof globalThis.fetch
}

/**
 * Whether a request is Git asking this host for a repository it serves, rather than
 * for the API. Git asks for `/<owner>/<name>.git/info/refs` to start and for
 * `/<owner>/<name>.git/git-receive-pack` to push, and the API double never sees those.
 */
function isRepositoryRequest(pathname: string, projectsRoot: string): boolean {
  if (!/^\/[^\/]+\/[^\/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/u.test(pathname)) {
    return false
  }
  // The URL the application pushes to carries the `.git` suffix; the directory on this
  // side of it is the bare repository with that suffix. Resolving the wrong one of the
  // two answers "no" for a repository this host is serving, and Git is then handed an API
  // answer where it expected a ref advertisement.
  const served = decodeURIComponent(pathname.split('/').slice(1, 3).join('/'))
  return existsSync(join(projectsRoot, served)) || existsSync(join(projectsRoot, `${served}.git`))
}

/**
 * The path this host answers its API from, given where the caller asked.
 *
 * This host's authority is not `github.com`, so it is a GitHub Enterprise Server host
 * and a client that resolves its endpoints the way the production code does asks for
 * `/api/v3/user` and `/api/graphql`. That is a real host's shape, and a run that has to
 * be pointed at this host by host name — which is exactly what a recovery is, since it
 * derives every endpoint from the host its receipt names — would otherwise be refused
 * for asking the documented question of a host that answers it.
 *
 * So the enterprise prefixes are recognised here, at the socket, rather than inside the
 * API double: what the double models is which endpoint means what, not which path prefix
 * a host hangs them under. Only the exact prefix is removed, and only once — a
 * repository legitimately named `api` is served under `/<owner>/api`, which this never
 * rewrites, and a path that merely starts with the same letters is left alone.
 */
function apiPath(requestUrl: string): string {
  if (requestUrl === '/api/v3' || requestUrl.startsWith('/api/v3/')) {
    return requestUrl.slice('/api/v3'.length) || '/'
  }
  if (requestUrl === '/api/graphql' || requestUrl.startsWith('/api/graphql?')) {
    return requestUrl.replace('/api/graphql', '/graphql')
  }
  return requestUrl
}

/**
 * Whether this host serves one Git request, and as whom.
 *
 * The answers are the three a real host gives and no others: 401 when the request
 * named no credential this host recognises, 403 when it named one that has no access
 * to this repository, and the account's login when it may proceed. A host that has
 * been given no authorizer decides nothing, which is the behaviour every test that
 * never asked about credentials keeps.
 */
async function decideGitRequest(
  options: ControlledGitHubHostOptions,
  fullName: string,
  authorization: string | undefined,
): Promise<{ login: string } | { status: number; message: string }> {
  if (options.authorizeGit === undefined) return { login: 'git-stacks-live-e2e' }
  const credential = gitAuthorizationSecret(authorization)
  if (credential === null) {
    return { status: 401, message: 'this repository needs a credential\n' }
  }
  // The name out of a Git request still carries the `.git` a remote URL ends in, because
  // that is the directory this host serves. The repository it names is the name without
  // it, and that is the form every authorizer is handed: a name that matched here but
  // not against a permission map keyed by repository name would refuse the owner of the
  // very repository the request was for.
  return options.authorizeGit(fullName.replace(/\.git$/u, ''), credential)
}

/**
 * One Git request, handed to the same `git-http-backend` a real host runs.
 *
 * The protocol is Git's rather than a reimplementation of it: the backend resolves the
 * repository, negotiates the ref advertisement, and runs `receive-pack` for a push. A
 * suite that answered these itself would be proving its own agreement with the client.
 */
function serveGitRequest(
  options: ControlledGitHubHostOptions,
  backend: string,
  live: Set<ChildProcess>,
  request: IncomingMessage,
  body: Buffer,
  remoteUser: string,
  serve: (status: number, headers: Record<string, string>, payload: Buffer) => void,
): void {
  const url = new URL(request.url ?? '/', 'https://127.0.0.1')
  const child = spawn(backend, ['-c', 'http.receivepack=true'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: options.projectsRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/u, ''),
      REQUEST_METHOD: request.method ?? 'GET',
      GIT_TERMINAL_PROMPT: '0',
      CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
      CONTENT_LENGTH: String(body.length),
      // The account the request authenticated as, decided before the backend was
      // started rather than asserted for it. A constant here would have named one
      // account to every repository this host serves, which is a host with no notion
      // of who is asking.
      REMOTE_USER: remoteUser,
      REMOTE_ADDR: request.socket.remoteAddress ?? '127.0.0.1',
      SERVER_PROTOCOL: 'HTTP/1.1',
      GATEWAY_INTERFACE: 'CGI/1.1',
      HTTP_CONTENT_ENCODING: String(request.headers['content-encoding'] ?? ''),
    },
  })
  // Registered before anything else can fail, and released on the two ways this child
  // can end: its own exit, and the host shutting down under it. A child the host does
  // not know about is a child nobody can kill, and a killed pipe is a socket Git is
  // still waiting on — so a request abandoned mid-push must not leave a backend reading
  // a body that will never arrive.
  live.add(child)
  const chunks: Buffer[] = []
  let failure = ''
  // One request, one answer. A backend that fails, that has already answered, and whose
  // socket the client has since closed are three events that used to be able to reach
  // the same socket twice, and only the first of them is the answer.
  let settled = false
  let abandoned = false
  let pipeFailure = ''
  function detach(): void {
    request.off('aborted', abandon)
    request.socket.off('close', abandon)
  }
  function answer(status: number, headers: Record<string, string>, payload: Buffer): void {
    // A client that hung up while this host was still deciding, or that has already
    // been answered, gets nothing: there is no socket to answer and no second answer.
    if (settled || abandoned || request.socket.destroyed) return
    settled = true
    detach()
    serve(status, headers, payload)
  }
  function abandon(): void {
    // Git hanging up mid-request is the ordinary end of a failed push, and nothing this
    // host would have answered can reach it now. The backend is killed rather than left
    // holding its pipes open; it stays in the owned set until it is reaped, because a
    // child that was released while still running is a child nobody can kill.
    abandoned = true
    detach()
    child.kill('SIGKILL')
  }
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => {
    failure += String(chunk)
  })
  // The request body was read in full before this handler ran, so this is a write into a
  // child that may already have answered on the headers alone and gone: `git-http-backend`
  // refuses a POST whose content type is not one of Git's own before it reads a byte of
  // the body, and a body larger than a pipe buffer cannot fit while it is exiting. That
  // write fails with EPIPE on the child's stdin, which reaches this process as an
  // unhandled stream error and ends the run rather than the request. It is collected here
  // and used only when the backend produced no answer of its own, because a rejection the
  // backend really did write is still this host's answer to send.
  child.stdin.on('error', (cause: Error) => {
    pipeFailure = String(cause)
  })
  // A spawn failure is this host's own answer rather than a crash, and the child is
  // released on its close event like any other backend's.
  child.on('error', (cause) => {
    answer(500, { 'content-type': 'text/plain' }, Buffer.from(String(cause)))
  })
  child.on('close', () => {
    live.delete(child)
    const raw = Buffer.concat(chunks)
    const split = raw.indexOf('\r\n\r\n')
    if (split === -1) {
      answer(
        500,
        { 'content-type': 'text/plain' },
        Buffer.from(failure || pipeFailure || 'git-http-backend produced no response'),
      )
      return
    }
    // CGI status: a numeric status token and an optional reason phrase, and nothing at
    // all when the backend is satisfied — which is a 200, not a malformed answer. Git
    // writes `Status: 415 Unsupported Media Type` when it refuses, and reading that whole
    // value as a number is what produced a `NaN` this host then handed to its own
    // response writer. A status that is present and is not one fails the request.
    const headers: Record<string, string> = {}
    let status = 200
    let unusable = false
    for (const line of raw.subarray(0, split).toString('utf8').split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator === -1) continue
      const name = line.slice(0, separator)
      const value = line.slice(separator + 1).trim()
      if (name.toLowerCase() === 'status') {
        const code = /^(\d{3})(?:\s|$)/u.exec(value)
        if (code === null) unusable = true
        else status = Number(code[1])
      } else headers[name] = value
    }
    if (unusable || status < 100 || status > 599) {
      answer(
        500,
        { 'content-type': 'text/plain' },
        Buffer.from(failure || pipeFailure || 'git-http-backend produced an unusable status'),
      )
      return
    }
    answer(status, headers, raw.subarray(split + 4))
  })
  request.on('aborted', abandon)
  request.socket.on('close', abandon)
  child.stdin.end(body)
}

/**
 * Starts the controlled host, bound to a certificate generated for this run.
 *
 * Four things are opened here, and each has a lifetime this function is responsible
 * for: a temporary directory holding a private key, generated by shelling out to
 * `openssl`; a listening TLS socket; a client connection pool, because this host makes
 * requests to itself; and a child `git-http-backend` per Git request.
 *
 * They are owned together. Before the host is returned, `this` function is the only thing
 * that can reach any of them, so its guard releases all of them when startup throws.
 * After it is returned, the caller is, and `close` is the only thing that releases them.
 * The handoff is a single flag rather than a per-resource null-out, because a partial one
 * is worse than either: a guard that takes the certificate while the caller still names
 * it as the authority to trust fails the first handshake as an unreadable CA file, and
 * one that takes the pool leaves a host that answers the first request and not the next.
 */
export async function startControlledGitHubHost(
  options: ControlledGitHubHostOptions,
): Promise<ControlledGitHubHost> {
  let certificate: GeneratedCertificate | null = null
  let server: Server | null = null
  const api = createGitHubApiDouble()
  const served: ControlledGitHubHost['served'] = []
  // The client side of every request this host answers. These sockets are the host's own
  // from the first request until the run is over, and Node's shared agent pools them —
  // so a host that closes its listener but leaves its own client sockets pooled keeps
  // this process's event loop open. That is what a run which reported a complete cleanup
  // and then had to be killed looks like from the outside.
  const agent = new HttpsAgent({ keepAlive: true })
  // Backends started to answer Git. Each is a child process holding pipes, and a child
  // nobody reaped holds the loop open the same way a pooled socket does.
  const backends = new Set<ChildProcess>()
  // Whether the returned host has taken all four. They are released together or not at
  // all: a guard that took the certificate but left the pool, or took the pool while the
  // caller still had it, is a partial handoff, and each half of one fails as something
  // unrelated — an unreadable CA file, or a host that answers the first request and
  // never the second.
  let handedOff = false
  // Everything this function opened, released in the reverse of the order it was opened:
  // the backends first, because one blocked on a request that can no longer be answered
  // holds a pipe and a child for ever; then the client sockets, which are pooled and
  // would otherwise keep this process's event loop open past the listener; then the
  // listener, whose own connections are destroyed so nothing arrives afterwards; then
  // the key material, which is the last thing anything could still be reading.
  const releaseAll = async (listening: Server | null, directory: string | null): Promise<void> => {
    for (const child of backends) child.kill('SIGKILL')
    backends.clear()
    agent.destroy()
    if (listening !== null) {
      await new Promise<void>((done) => {
        listening.closeAllConnections()
        listening.close(() => done())
      })
    }
    if (directory !== null) rmSync(directory, { recursive: true, force: true })
  }
  try {
    certificate = generateCertificate()
    const backend = join(
      execFileSync(options.git, ['--exec-path'], { encoding: 'utf8' }).trim(),
      'git-http-backend',
    )
    const servedCert = certificate.cert
    server = createTlsServer({ key: certificate.key, cert: servedCert }, (request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        const url = new URL(request.url ?? '/', 'https://127.0.0.1')
        if (isRepositoryRequest(url.pathname, options.projectsRoot)) {
          // The decision is made before a backend process is started, and a refusal is
          // the host's own answer rather than an error: Git reads a 401 as "this
          // repository needs a credential" and a 403 as "not this account's", which
          // is what a real host says and what a run can therefore be expected to
          // prove something about.
          void (async () => {
            const record = (status: number, headers: Record<string, string>, payload: Buffer) => {
              served.push({
                method: request.method ?? 'GET',
                path: `${url.pathname}${url.search}`,
                status,
              })
              response.writeHead(status, headers)
              response.end(payload)
            }
            try {
              const repository = decodeURIComponent(url.pathname.split('/').slice(1, 3).join('/'))
              const answered = await decideGitRequest(
                options,
                repository,
                request.headers.authorization,
              )
              if ('status' in answered) {
                record(
                  answered.status,
                  { 'content-type': 'text/plain' },
                  Buffer.from(answered.message),
                )
                return
              }
              serveGitRequest(options, backend, backends, request, body, answered.login, record)
            } catch (error) {
              // The authorizer reads this host's own state, so it can fail the way any
              // other read can — an unreadable file, a half-written state. An exception
              // escaping here is an unhandled rejection inside a socket handler, which
              // ends the process rather than the request: the controlled CLI would die
              // before its own guard could close this socket, restore the environment it
              // installed, or settle the receipt. So a backend that cannot answer is a
              // 500 through the same path the API double uses, and the Git command fails
              // the way a failing host makes it fail.
              record(
                500,
                { 'content-type': 'application/json' },
                Buffer.from(
                  JSON.stringify({
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
              )
            }
          })()
          return
        }
        void (async () => {
          try {
            // The port this socket is actually on, not a guessed one. A collection that
            // has more to give names its next page by absolute URL, and a host naming a
            // different origin than the caller reached sends every client that follows
            // it somewhere else.
            const reached = `https://127.0.0.1:${request.socket.localPort ?? 443}${apiPath(request.url ?? '/')}`
            const answered = await api(reached, {
              method: request.method,
              headers: new Headers(
                Object.fromEntries(
                  Object.entries(request.headers).map(([name, value]) => [
                    name,
                    Array.isArray(value) ? value.join(', ') : String(value ?? ''),
                  ]),
                ),
              ),
              body: body.length > 0 ? body.toString('utf8') : undefined,
            })
            served.push({
              method: request.method ?? 'GET',
              path: `${url.pathname}${url.search}`,
              status: answered.status,
            })
            response.writeHead(answered.status, Object.fromEntries(answered.headers.entries()))
            response.end(await answered.text())
          } catch (error) {
            served.push({
              method: request.method ?? 'GET',
              path: `${url.pathname}${url.search}`,
              status: 500,
            })
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ message: String(error) }))
          }
        })()
      })
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const address = server?.address()
    if (address === null || address === undefined || typeof address === 'string')
      throw new Error('the controlled host has no port')
    const host = `127.0.0.1:${address.port}`
    // The listener, the key material and the client pool are the caller's from here, and
    // the flag is set before the return so the guard below does not also release them.
    // The bug this replaces cleared only the listener, which left the guard deleting a
    // certificate the returned host was still naming as the authority Git should trust:
    // the first handshake then failed as an unreadable CA file, which says nothing about
    // TLS and everything about a lifetime that ended too early.
    const owned = certificate
    const listening = server
    const stop = async (): Promise<void> => {
      await releaseAll(listening, owned.directory)
    }
    handedOff = true
    certificate = null
    server = null
    return {
      url: `https://${host}`,
      host,
      certificatePath: owned.certPath,
      cloneUrl: (fullName) => `https://${host}/${fullName}.git`,
      fetch: pinnedFetch(owned.cert, agent),
      served,
      close: stop,
    }
  } finally {
    // Nothing is released once the host has been handed over: `close` is the only thing
    // that may release it, and it does all of it. Before that, this host is the only
    // thing that can reach the pool or the backends, so a startup that threw takes them
    // with it rather than leaving a socket and a child holding the event loop open for a
    // caller whose guard will never run, because `start` never returned.
    if (!handedOff) {
      await releaseAll(server, certificate?.directory ?? null).catch(() => undefined)
    }
  }
}
