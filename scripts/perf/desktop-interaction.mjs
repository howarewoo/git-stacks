import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'

const deadlineMs = 30_000
const requestTimeoutMs = 10_000

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function pageTarget(port, child, getError, pageOrigin) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited before startup: ${getError()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
      const pages = await response.json()
      const page = pages.find((entry) => entry.type === 'page' && entry.url.startsWith(pageOrigin))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // The DevTools listener is not yet accepting connections.
    }
    await delay(50)
  }
  throw new Error(`Electron did not expose its application page: ${getError()}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let serial = 0
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('DevTools connection timed out')),
      requestTimeoutMs,
    )
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      'error',
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
      { once: true },
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('DevTools disconnected'))
    pending.clear()
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`DevTools ${method} timed out`))
        }, requestTimeoutMs)
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer)
            resolve(value)
          },
          reject(error) {
            clearTimeout(timer)
            reject(error)
          },
        })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    close() {
      socket.close()
    },
  }
}

async function evaluate(client, expression, awaitPromise = false) {
  const reply = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  })
  if (reply.exceptionDetails) {
    throw new Error(reply.exceptionDetails.text || 'Renderer evaluation failed')
  }
  return reply.result.value
}

async function until(client, expression) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return
    await delay(25)
  }
  throw new Error(`Desktop did not reach the expected visible state: ${expression}`)
}

async function click(client, selector) {
  const point = await evaluate(
    client,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing control: ${selector}');
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  )
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  })
}

/** Launch-to-painted repository and real search input-to-painted filtered result. */
export async function measureDesktop(repoRoot, fixture) {
  const userData = mkdtempSync(join(tmpdir(), 'git-stacks-desktop-bench-'))
  const port = await freePort()
  const started = performance.now()
  const child = spawn(
    electron,
    [
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      join(repoRoot, 'out/main/index.js'),
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL ?? '',
        GIT_STACKS_REPO: fixture,
        GIT_STACKS_USER_DATA: userData,
      },
    },
  )
  let errors = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => {
    errors = (errors + text).slice(-8192)
  })
  let client
  try {
    client = await connect(
      await pageTarget(
        port,
        child,
        () => errors,
        process.env.ELECTRON_RENDERER_URL || 'app://git-stacks',
      ),
    )
    await until(client, "!!document.querySelector('button.onboarding-recent')")
    await click(client, 'button.onboarding-recent')
    await until(
      client,
      "document.querySelector('.list-subtitle')?.textContent?.trim() === '3001 shown' && document.querySelectorAll('.branch-row').length === 200",
    )
    await evaluate(
      client,
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      true,
    )
    const startupMs = performance.now() - started

    const search = 'input[aria-label="Search branches, files, and pull requests"]'
    await click(client, search)
    await evaluate(
      client,
      `globalThis.__perfInteraction = new Promise((resolve, reject) => {
        const control = document.querySelector(${JSON.stringify(search)});
        const timeout = setTimeout(() => reject(new Error('Filtered branch did not paint')), 10000);
        control.addEventListener('input', () => {
          const started = performance.now();
          const observer = new MutationObserver(() => {
            if (document.querySelector('.list-subtitle')?.textContent?.trim() !== '1 shown') return;
            const row = document.querySelector('.branch-row');
            if (!row?.textContent?.includes('feature/branch-2999')) return;
            observer.disconnect();
            requestAnimationFrame(() => requestAnimationFrame(() => {
              clearTimeout(timeout);
              resolve(performance.now() - started);
            }));
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        }, { capture: true, once: true });
      }); true`,
    )
    await client.send('Input.insertText', { text: 'feature/branch-2999' })
    const interactionMs = await evaluate(client, 'globalThis.__perfInteraction', true)
    if (typeof interactionMs !== 'number' || !Number.isFinite(interactionMs)) {
      throw new Error('Renderer did not return an interaction duration')
    }
    return { startupMs, interactionMs }
  } finally {
    client?.close()
    if (child.exitCode === null && child.pid) {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already exited.
      }
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)])
      if (child.exitCode === null) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already exited.
        }
      }
    }
    rmSync(userData, { recursive: true, force: true })
  }
}
