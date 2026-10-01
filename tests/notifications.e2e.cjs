/**
 * The optional Notification Center, driven through the real application.
 *
 * Electron runs the built main process, which answers on its own TLS socket as
 * a GitHub host, and the window reaches it only through the preload bridge: the
 * token is pasted into the dialog, crosses one IPC channel, and is sealed in the
 * operating system's store. Nothing here mutates anything on github.com — the
 * host is this script's own server — and the token never appears in a rendered
 * surface, an accessibility read, or a screenshot.
 */
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const net = require('node:net')
const { createServer } = require('node:https')
const electron = require('electron')

const TOKEN = 'ghp_smoke_token_that_must_never_appear_again'
const LAST_MODIFIED = 'Tue, 22 Sep 2026 09:41:07 GMT'

const root = mkdtempSync(join(tmpdir(), 'git-stacks-notifications-e2e-'))
const userData = join(root, 'userdata')
mkdirSync(userData, { recursive: true })
const certificate = mkdtempSync(join(root, 'cert-'))
// Generated for this run, with the address it serves named as a subject
// alternative name, because that is the part a client verifies. The application
// is given this exact file as an extra certificate authority when it starts, so
// the handshake it completes is verified rather than waved through.
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(certificate, 'key.pem'),
    '-out',
    join(certificate, 'cert.pem'),
    '-days',
    '1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-subj',
    '/CN=127.0.0.1',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const repository = join(root, 'fixture')
mkdirSync(repository)
function git(...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}
git('init', '-b', 'main')
git('config', 'user.name', 'Notification Fixture')
git('config', 'user.email', 'notifications@example.invalid')
writeFileSync(join(repository, 'shared.txt'), 'baseline\n')
git('add', 'shared.txt')
git('commit', '-m', 'baseline')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startGitHubHost() {
  const asked = []
  // The threads the host holds, so a write the run performs is a write the host
  // really has: a mark-read that the host forgot would make the list disagree
  // with the requests, and the point of this run is that the two agree.
  let threads = [
    {
      id: '101',
      unread: true,
      reason: 'review_requested',
      subject: {
        title: 'Tidy the stack ordering rules',
        url: 'https://github.com/acme/widgets/pull/101',
        type: 'PullRequest',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:41:07Z',
    },
    {
      id: '102',
      unread: true,
      reason: 'mention',
      subject: {
        title: 'Mentioned in "Release checklist"',
        url: 'https://github.com/acme/widgets/issues/102',
        type: 'Issue',
      },
      repository: { name: 'widgets', owner: { login: 'acme' } },
      updated_at: '2026-09-22T09:39:00Z',
    },
  ]
  const server = createServer(
    {
      key: readFileSync(join(certificate, 'key.pem')),
      cert: readFileSync(join(certificate, 'cert.pem')),
    },
    (request, response) => {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        const url = new URL(request.url, 'https://127.0.0.1')
        asked.push({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          ifModifiedSince: request.headers['if-modified-since'] ?? null,
          authorization: request.headers.authorization ?? null,
        })
        const answer = (status, body, headers) => {
          response.writeHead(status, { 'content-type': 'application/json', ...headers })
          response.end(body === null ? '' : JSON.stringify(body))
        }
        if (url.pathname === '/api/v3/user') return answer(200, { login: 'octo' })
        if (request.method === 'DELETE' && url.pathname.endsWith('/subscription')) {
          threads = threads.filter(
            (thread) => url.pathname.indexOf(`/threads/${thread.id}/`) === -1,
          )
          return answer(204, null, {})
        }
        if (request.method === 'PATCH') {
          const marked = /\/threads\/([^/]+)$/.exec(url.pathname)?.[1] ?? 'all'
          threads = threads.map((thread) =>
            marked === 'all' || thread.id === marked ? { ...thread, unread: false } : thread,
          )
          return answer(205, null, {})
        }
        if (request.method !== 'GET') return answer(205, null, {})
        if (url.pathname.startsWith('/api/v3/notifications')) {
          // A conditional read is answered the way GitHub answers one: nothing
          // changed, so there is no body to send and only the validator.
          if (request.headers['if-modified-since'] === LAST_MODIFIED) {
            return answer(304, null, { 'x-poll-interval': '60' })
          }
          return answer(200, threads, {
            'last-modified': LAST_MODIFIED,
            'x-poll-interval': '60',
          })
        }
        answer(404, { message: 'Not Found' })
      })
    },
  )
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, asked }))
  })
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Writes the state this computer starts the smoke with.
 *
 * The repository is a recent one rather than a picked one, because the picker
 * is a native dialog this script cannot drive; the recents list the app itself
 * keeps and renders is the real path into the workspace, and using it means the
 * window that opens is the window a person opens.
 */
function writeStartState(host) {
  writeFileSync(
    join(userData, 'repositories.json'),
    `${JSON.stringify([{ path: repository, name: 'fixture' }], null, 2)}\n`,
  )
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify(
      {
        version: 1,
        github: { host },
        git: { useSystemGit: true },
        notifications: { enabled: false },
        privacy: { includeLocalPaths: false },
        updates: { channel: 'stable' },
        shortcuts: {},
        migrated: { legacyShortcutStorage: true },
      },
      null,
      2,
    )}\n`,
  )
}

/** Every file the app wrote, with its whole body, for the secrecy check. */
function storedFiles() {
  const bodies = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else bodies.push(readFileSync(path))
    }
  }
  walk(userData)
  return bodies.join('\n')
}

async function main() {
  const host = await startGitHubHost()
  const hostName = `127.0.0.1:${host.server.address().port}`
  writeStartState(hostName)
  const port = await availablePort()
  const env = {
    ...process.env,
    GIT_STACKS_USER_DATA: userData,
    // This run's certificate is added to the trust store the process starts
    // with. Verification is on and the chain is checked; nothing anywhere in
    // this run is told to stop checking.
    NODE_EXTRA_CA_CERTS: join(certificate, 'cert.pem'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(
    electron,
    [join(__dirname, '..', 'out', 'main', 'index.js'), `--remote-debugging-port=${port}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  app.stdout.on('data', (chunk) => {
    output += chunk
  })
  app.stderr.on('data', (chunk) => {
    output += chunk
  })
  let socket
  try {
    let target
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (app.exitCode !== null) throw new Error(`Electron exited: ${output}`)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) break
      } catch {
        /* the main process has not started listening yet */
      }
      await delay(100)
    }
    assert.ok(target, `the renderer was unavailable: ${output}`)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let nextId = 0
    const pending = new Map()
    // What the window itself complained about, so a failure names the render that
    // failed rather than only what stopped appearing on screen.
    const rendererErrors = []
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails
        rendererErrors.push(
          details?.exception?.description ?? details?.text ?? 'an exception with no description',
        )
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      message.error
        ? waiter.reject(new Error(message.error.message))
        : waiter.resolve(message.result)
    })
    const send = (method, params = {}) => {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
    await send('Runtime.enable')
    const page = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (result.exceptionDetails) {
        throw new Error(`${result.exceptionDetails.text}: ${JSON.stringify(expression)}`)
      }
      return result.result.value
    }
    const until = async (description, expression, attempts = 900) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await page(`Boolean(${expression})`)) return
        await delay(50)
      }
      throw new Error(
        `timed out waiting for ${description}; the window reads: ${await page('document.body.innerText')}\nthe window reported: ${rendererErrors.join('\n') || 'nothing'}`,
      )
    }
    // Evidence is written where the run is asked to keep it, so a reviewer can
    // look at what the window actually showed; without that it stays in the
    // disposable workspace and is cleaned up with everything else.
    const evidence = process.env.GIT_STACKS_NOTIFICATION_EVIDENCE
    if (evidence) mkdirSync(evidence, { recursive: true })
    const screenshot = async (name) => {
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      })
      const path = join(evidence ?? root, `${name}.png`)
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    }
    const resize = async (width, height, deviceScaleFactor) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      })
      await delay(400)
    }
    const key = async (keyName, code, virtual, modifiers = 0) => {
      const options = { key: keyName, code, windowsVirtualKeyCode: virtual, modifiers }
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyDown' })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
    }

    // The window starts in onboarding with this run's repository among its
    // recents, and opening it from there is the same path a person takes.
    await until(
      'the recent repository',
      `document.querySelector('button.onboarding-recent strong')?.textContent === 'fixture'`,
    )
    await page(`document.querySelector('button.onboarding-recent').click()`)
    await until(
      'the workspace navigation',
      `document.querySelector('nav') && !document.body.innerText.includes('Start with a repository')`,
      1800,
    )
    assert.ok(
      await page(
        `Boolean([...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')))`,
      ),
      'the destination is in the navigation a person can reach',
    )
    await page(
      `[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('Notifications')).click()`,
    )
    const heading = await page(`document.querySelector('h1')?.textContent ?? ''`)
    assert.equal(heading, 'GitHub Notifications', `the view the click reached reads: ${heading}`)
    assert.equal(
      await page(`document.body.innerText.includes('This module is off')`),
      true,
      'a module nobody has enabled says so, and does not ask for a token yet',
    )
    assert.equal(
      await page(
        `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Authorize notifications')`,
      ),
      false,
      'no authorization is offered before this computer has agreed to the module at all',
    )
    assert.equal(
      await page(`document.body.innerText.includes(${JSON.stringify(TOKEN)})`),
      false,
      'no token is on screen before one is entered',
    )
    const offScreenshot = await screenshot('notifications-off')

    // The module is enabled the way a person enables it: from Settings, which
    // states the credential boundary in full before the switch is touched.
    await key('k', 'KeyK', 75, 4)
    await until('the command palette', `document.querySelector('[aria-label^="Search actions"]')`)
    for (const character of 'Settings') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await until(
      'the settings command',
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].some((b) => b.textContent.includes('Settings'))`,
    )
    await page(
      `[...document.querySelectorAll('[aria-label="Command suggestions"] [role="option"]')].find((b) => b.textContent.includes('Settings')).click()`,
    )
    await until(
      'the settings dialog',
      `document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await page(
      `[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find((b) => b.textContent.trim() === 'Notifications').click()`,
    )
    await until('the notifications setting', `document.querySelector('#settings-notifications')`)
    const explanation = await page(
      `document.querySelector('nav[aria-label="Settings sections"]').nextElementSibling.textContent`,
    )
    assert.ok(
      explanation.includes('What authorizing one adds, in full'),
      `the setting states the boundary in full: ${explanation.slice(0, 200)}`,
    )
    for (const point of ['classic personal access token', 'notifications', 'key store']) {
      assert.ok(
        explanation.includes(point),
        `enabling says what it adds, and names ${point}: ${explanation.slice(0, 300)}`,
      )
    }
    const enabledScreenshot = await screenshot('notifications-setting')
    await page(`document.querySelector('#settings-notifications').click()`)
    await until(
      'the module to be enabled',
      `document.body.innerText.includes('GitHub Notifications enabled')`,
    )
    await key('Escape', 'Escape', 27)
    await until(
      'the settings dialog to close',
      `!document.querySelector('nav[aria-label="Settings sections"]')`,
    )
    await until(
      'the notification destination to be open again',
      `document.querySelector('h1')?.textContent === 'GitHub Notifications'`,
    )
    assert.equal(
      await page(`document.body.innerText.includes('This module is off')`),
      false,
      'the module is no longer off once this computer has turned it on',
    )
    assert.equal(
      await page(`document.body.innerText.includes('No credential stored')`),
      true,
      'enabling asks for no token by itself; only a stored one makes this a live inbox',
    )
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Authorize notifications').click()`,
    )
    await until(
      'the credential dialog',
      `document.querySelector('[aria-label="GitHub Notifications credential"]')`,
    )
    const boundaryText = await page(
      `document.querySelector('[aria-label="GitHub Notifications credential"]').innerText`,
    )
    for (const point of ['classic personal access token', 'notifications', hostName]) {
      assert.ok(boundaryText.includes(point), `the consent names ${point}: ${boundaryText}`)
    }
    const submitDisabledBeforeConsent = await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].filter((b) => b.textContent.includes('Authorize')).every((b) => b.disabled)`,
    )
    assert.equal(submitDisabledBeforeConsent, true, 'consent is required before a token is stored')

    // Type into the real input so the value travels the real event path.
    await page(
      `(() => { const input = document.querySelector('[aria-label="GitHub Notifications credential"] input'); input.focus(); return true })()`,
    )
    for (const character of TOKEN) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: character })
    }
    await page(
      `(() => { const box = [...document.querySelectorAll('[aria-label="GitHub Notifications credential"] input')].find((i) => i.type === 'checkbox' || i.getAttribute('role') === 'checkbox') || document.querySelector('[aria-label="GitHub Notifications credential"] [role="checkbox"]'); box.click(); return true })()`,
    )
    await page(
      `[...document.querySelectorAll('[aria-label="GitHub Notifications credential"] button')].find((b) => b.textContent.includes('Authorize')).click()`,
    )

    // The list GitHub served appears, marked as its own thing.
    await until(
      'the notification threads',
      `document.body.innerText.includes('Tidy the stack ordering rules')`,
      1200,
    )
    const ready = await page(`document.body.innerText`)
    assert.ok(
      ready.includes('Enabled'),
      `the module reports itself enabled: ${ready.slice(0, 400)}`,
    )
    assert.ok(
      ready.includes('at most one read every 60s'),
      'the interval GitHub asked for is on screen',
    )
    assert.equal(ready.includes(TOKEN), false, 'the token is not on screen once it is stored')
    assert.deepEqual(
      host.asked.map((entry) => `${entry.method} ${entry.path}`),
      ['GET /api/v3/user', 'GET /api/v3/notifications?per_page=50&all=true'],
      'the module identifies the token and reads the list once, over its own transport only',
    )
    assert.equal(
      host.asked.every((entry) => entry.authorization === `Bearer ${TOKEN}`),
      true,
      'every request carried this module’s own credential and nothing else',
    )

    // The stored token reached the sealed store, not a readable file.
    const stored = storedFiles()
    assert.equal(stored.includes(TOKEN), false, 'no file this app wrote holds the token')

    const standard = await screenshot('notifications-standard')

    // Marking one thread read writes to this host once and updates the row.
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Mark read').click()`,
    )
    await until(
      'the first thread to be marked read',
      `document.querySelector('[role="listitem"]')?.innerText.includes('Read')`,
      600,
    )
    const writes = host.asked.filter((entry) => entry.method === 'PATCH')
    assert.equal(writes.length, 1, `marking read is sent once: ${JSON.stringify(writes)}`)
    assert.equal(writes[0].path, '/api/v3/notifications/threads/101')

    // The interval GitHub asked for is a floor a person cannot outrun either:
    // asking again straight away sends nothing and changes nothing.
    const readsBefore = host.asked.length
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh').click()`,
    )
    await delay(1_000)
    assert.equal(
      host.asked.length,
      readsBefore,
      'a read asked for inside the interval GitHub named is not sent at all',
    )
    assert.equal(
      (await page(`document.body.innerText`)).includes('Tidy the stack ordering rules'),
      true,
      'and the list GitHub last confirmed is still the one on screen',
    )

    // Once the interval has passed, the read is conditional, and a host that
    // says nothing changed keeps the whole list rather than replacing it with
    // the page that answered.
    await delay(62_000)
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Refresh').click()`,
    )
    for (let attempt = 0; attempt < 200 && host.asked.length === readsBefore; attempt += 1) {
      await delay(50)
    }
    const conditional = host.asked.at(-1)
    assert.equal(
      conditional.ifModifiedSince,
      LAST_MODIFIED,
      'the validator sent back is the one GitHub issued, unchanged',
    )
    assert.equal(
      host.asked.length,
      readsBefore + 1,
      'a 304 ends the read rather than asking for another page',
    )
    assert.equal(
      (await page(`document.body.innerText`)).includes('Tidy the stack ordering rules'),
      true,
      'the list is replayed whole, not replaced by whatever page answered',
    )

    // Unsubscribing is per thread, so the named row's own control is the one
    // used: the row that leaves the list is the row that was acted on, and the
    // host is the one that decides it left.
    await page(
      `(() => {
        const row = [...document.querySelectorAll('[role="listitem"]')].find((r) => r.innerText.includes('Release checklist'))
        if (!row) throw new Error('no row names this thread: ' + document.body.innerText)
        const button = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Unsubscribe')
        if (!button) throw new Error('this row offers no unsubscribe: ' + row.innerText)
        button.click()
        return true
      })()`,
    )
    await until(
      'the unsubscribed thread to leave the list',
      `!document.body.innerText.includes('Release checklist') && document.body.innerText.includes('Tidy the stack ordering rules')`,
      600,
    )
    assert.deepEqual(
      host.asked.filter((entry) => entry.method === 'DELETE').map((entry) => entry.path),
      ['/api/v3/notifications/threads/102/subscription'],
      'exactly the subscription the row names was removed, and only that one',
    )

    // The keyboard route reaches the view and the dialog, without a pointer.
    await resize(1024, 768, 1)
    await page(`document.body.focus()`)
    await page(`document.querySelector('nav button').focus()`)
    for (let index = 0; index < 8; index += 1) {
      await key('ArrowDown', 'ArrowDown', 40)
    }
    const keyboardFocused = await page(`document.activeElement?.textContent ?? ''`)
    assert.ok(
      keyboardFocused.includes('GitHub Notifications'),
      `the notification destination is reachable by keyboard: ${keyboardFocused}`,
    )
    const minimum = await screenshot('notifications-minimum')

    // 200% text scaling has to stay usable rather than clipping the boundary.
    await resize(1024, 768, 2)
    const scaled = await screenshot('notifications-200')
    assert.ok(scaled.length > 0)
    await resize(1024, 768, 1)

    // Removing this module's credential disables this module and nothing else.
    await page(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove credential').click()`,
    )
    await until(
      'the module to be back to needing a credential',
      `document.body.innerText.includes('No credential stored')`,
      600,
    )
    const afterRemoval = await page(`document.body.innerText`)
    assert.equal(
      afterRemoval.includes('Tidy the stack ordering rules'),
      false,
      'the list read with that credential is gone',
    )
    assert.equal(
      existsSync(join(userData, 'github-account.json')),
      false,
      "the application's own GitHub sign-in was never involved and is still absent",
    )

    console.log(
      JSON.stringify(
        {
          off: offScreenshot,
          setting: enabledScreenshot,
          standard,
          minimum,
          scaled,
          hostRequests: host.asked.map((entry) => `${entry.method} ${entry.path}`),
          secretInFiles: stored.includes(TOKEN),
          rendererErrors,
        },
        null,
        2,
      ),
    )
    socket.close()
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close()
    app.kill()
    host.server.close()
    host.server.closeAllConnections()
    setTimeout(() => rmSync(root, { recursive: true, force: true }), 2000).unref()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
