const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const net = require('node:net')
const electron = require('electron')

const root = mkdtempSync(join(tmpdir(), 'git-stacks-palette-e2e-'))
const repository = join(root, 'fixture')
mkdirSync(repository)
function git(...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}
git('init', '-b', 'main')
git('config', 'user.name', 'Palette Fixture')
git('config', 'user.email', 'palette@example.invalid')
writeFileSync(join(repository, 'shared.txt'), 'baseline\n')
git('add', 'shared.txt')
git('commit', '-m', 'baseline')
git('branch', 'feature')
git('checkout', '-b', 'topic')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function main() {
  const port = await availablePort()
  const env = {
    ...process.env,
    GIT_STACKS_USER_DATA: join(root, 'userdata'),
    GIT_STACKS_REPO: repository,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(
    electron,
    [join(__dirname, '..', 'out', 'main', 'index.js'), `--remote-debugging-port=${port}`],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let appOutput = ''
  app.stdout.on('data', (chunk) => {
    appOutput += chunk
  })
  app.stderr.on('data', (chunk) => {
    appOutput += chunk
  })
  let socket
  try {
    let target
    for (let attempt = 0; attempt < 150; attempt++) {
      if (app.exitCode !== null) throw new Error(`Electron exited: ${appOutput}`)
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
        target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) break
      } catch {
        /* main process has not started listening yet */
      }
      await delay(100)
    }
    assert.ok(target, `Electron renderer was unavailable: ${appOutput}`)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    let nextId = 0
    const requests = new Map()
    socket.addEventListener('message', ({ data }) => {
      const response = JSON.parse(data)
      const pending = requests.get(response.id)
      if (!pending) return
      requests.delete(response.id)
      response.error
        ? pending.reject(new Error(response.error.message))
        : pending.resolve(response.result)
    })
    function send(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
    async function page(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    async function until(description, expression) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await page(`Boolean(${expression})`)) return
        await delay(50)
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    async function key(key, modifiers = 0) {
      const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : 'KeyK'
      const virtual = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 75
      const options = { key, code, windowsVirtualKeyCode: virtual, modifiers }
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyDown' })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
    }
    async function search(text) {
      await page(`(() => { const input = document.querySelector('[role="combobox"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await until(
        `search ${text}`,
        `document.querySelector('[role="combobox"]')?.value === ${JSON.stringify(text)}`,
      )
    }
    const button = (name) =>
      `Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === ${JSON.stringify(name)})`
    const fixtureButton = `Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.includes('fixture') && element.textContent?.includes('git-stacks-palette-e2e-'))`
    await until('recent fixture', fixtureButton)
    await page(`${fixtureButton}.click()`)
    await until(
      'repository snapshot',
      `document.querySelector('[aria-label="Filter current view branches, files, and pull requests"]')`,
    )
    await page(`${button('Fetch')}.focus()`)
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await until('palette combobox', `document.querySelector('[role="combobox"]')`)
    await search('Publish topic stack')
    await until(
      'disabled publish action',
      `document.querySelector('[role="option"][aria-disabled="true"]')`,
    )
    await key('Enter')
    const disabledPaletteValue = await page(`document.querySelector('[role="combobox"]')?.value`)
    assert.equal(disabledPaletteValue, 'Publish topic stack')
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await search('feature')
    await key('Enter')
    await until(
      'selected feature',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'feature')`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Delete feature')
    await key('Enter')
    await until(
      'armed confirmation',
      `document.body.textContent.includes('Press Enter again to confirm')`,
    )
    const branchAfterFirstEnter = git('branch', '--list', 'feature')
    assert.match(branchAfterFirstEnter, /feature/)
    await key('Escape')
    await until('disarmed', `!document.body.textContent.includes('Press Enter again to confirm')`)
    await key('Enter')
    await key('Enter')
    await until(
      'delete workflow',
      `document.querySelector('[role="dialog"]')?.textContent.includes('Delete local branch?')`,
    )
    await page(`${button('Cancel')}.click()`)
    await until('dialog closed', `!document.querySelector('[role="dialog"]')`)
    const branchAfterCancel = git('branch', '--list', 'feature')
    assert.match(branchAfterCancel, /feature/)
    await until(
      'opener focused after dialog',
      `document.activeElement?.textContent?.trim() === 'Fetch'`,
    )
    const restoredFocus = await page('document.activeElement?.textContent?.trim()')
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Delete feature')
    await key('Enter')
    await key('Enter')
    await until(
      'delete confirmation',
      `document.querySelector('[role="dialog"]')?.textContent.includes('Delete local branch?')`,
    )
    await page(`${button('Delete branch')}.click()`)
    await until(
      'confirmed deletion',
      `document.body.textContent.includes('Deleted local branch feature')`,
    )
    assert.equal(git('branch', '--list', 'feature'), '')
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    if (process.env.PALETTE_EVIDENCE_DIR) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(process.env.PALETTE_EVIDENCE_DIR, 'palette-e2e.png'),
        Buffer.from(screenshot.data, 'base64'),
      )
    }
    console.log(
      JSON.stringify({
        disabledPaletteValue,
        selectionHead: git('symbolic-ref', '--short', 'HEAD'),
        branchAfterFirstEnter,
        branchAfterCancel,
        restoredFocus,
        confirmedDeletion: git('branch', '--list', 'feature'),
      }),
    )
  } finally {
    socket?.close()
    app.kill()
    if (app.exitCode === null) await new Promise((resolve) => app.once('exit', resolve))
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
