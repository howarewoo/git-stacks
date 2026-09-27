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
git('branch', 'child')
git('config', 'branch.child.parent', 'topic')
git('update-ref', 'refs/remotes/origin/fetched-parent', 'HEAD')
git('config', 'branch.topic.parent', 'fetched-parent')

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
    async function until(description, expression, attempts = 900) {
      // Generous budget: this host runs several suites at once, so a slow
      // renderer round-trip must not read as a failed assertion.
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await page(`Boolean(${expression})`)) return
        await delay(50)
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    // The highlighted option is set a tick after the results render, so a
    // baseline captured too early compares against "nothing is active".
    async function highlightedOption() {
      await until(
        'a highlighted palette option',
        `document.querySelector('[role="combobox"]')?.getAttribute('aria-activedescendant')`,
      )
      return page(
        `document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`,
      )
    }
    async function key(key, modifiers = 0) {
      const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : 'KeyK'
      const virtual = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 75
      const options = { key, code, windowsVirtualKeyCode: virtual, modifiers }
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyDown' })
      await send('Input.dispatchKeyEvent', { ...options, type: 'keyUp' })
    }
    // The palette highlights whichever result row the pointer enters, and a
    // real cursor on this host rests over the list, so the pointer is parked
    // in the corner before results render and the keyboard owns the highlight.
    async function parkPointer() {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    }
    // A refresh pressed while the renderer is still settling after an earlier
    // snapshot can be dropped, so the refresh is repeated until the app
    // reports the state the scenario just created.
    async function refresh(description, expression) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await page(`document.querySelector('[aria-label="Refresh repository"]').click()`)
        if (await page(`Boolean(${expression})`)) return
        await delay(500)
      }
      throw new Error(`Timed out waiting for ${description}`)
    }
    // A failed activation reports what the palette held, so a press that ran
    // the wrong option is distinguishable from one that never reached it.
    async function paletteState() {
      return page(
        `JSON.stringify({ open: Boolean(document.querySelector('[role="combobox"]')), active: document.querySelector('[role="combobox"]')?.getAttribute('aria-activedescendant') ?? null, selection: document.querySelector('button[aria-current="true"]')?.getAttribute('aria-label') ?? null, options: Array.from(document.querySelectorAll('[role="option"]')).slice(0, 4).map((option) => option.textContent) })`,
      )
    }
    // A single CDP key dispatch can be lost while the renderer replaces the
    // focused node, so a palette activation is pressed again while the palette
    // still holds it. A closed palette means the press already ran the
    // command, and only its effect is still pending.
    async function activate(description, expression) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await key('Enter')
        try {
          await until(description, expression, 60)
          return
        } catch (error) {
          if (attempt === 2) throw error
          if (!(await page(`Boolean(document.querySelector('[role="combobox"]'))`))) break
        }
      }
      try {
        await until(description, expression)
      } catch (error) {
        throw new Error(`${error.message}; palette=${await paletteState()}`)
      }
    }

    // The confirming press is repeated only while no dialog has appeared, so a
    // lost dispatch cannot execute the confirmed action a second time.
    async function confirmDestructive(description, expression) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await key('Enter')
        try {
          await until(description, expression, 60)
          return
        } catch (error) {
          if (attempt === 2) throw error
          if (await page(`Boolean(document.querySelector('[role="dialog"]'))`)) break
        }
      }
      await until(description, expression)
    }
    async function search(text) {
      await parkPointer()
      await page(
        `(() => { const input = document.querySelector('[role="combobox"]'); input.focus(); input.select() })()`,
      )
      if (text) await send('Input.insertText', { text })
      else
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        })
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
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    })
    await until('palette combobox', `document.querySelector('[role="combobox"]')`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: process.platform === 'darwin' ? 4 : 2,
      autoRepeat: true,
    })
    assert.ok(await page(`Boolean(document.querySelector('[role="combobox"]'))`))
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 75,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    })
    await search('Fetch')
    await until(
      'fetch result',
      `document.querySelector('[role="option"]')?.textContent?.includes('Fetch')`,
    )
    const activeBeforeComposition = await highlightedOption()
    for (const eventOptions of [
      { key: 'ArrowDown', isComposing: true },
      { key: 'ArrowUp', keyCode: 229 },
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229 },
    ]) {
      await page(`(() => {
        const options = ${JSON.stringify(eventOptions)};
        const event = new KeyboardEvent('keydown', { key: options.key, isComposing: Boolean(options.isComposing), bubbles: true, cancelable: true });
        if (options.keyCode) Object.defineProperty(event, 'keyCode', { value: options.keyCode });
        document.querySelector('[role="combobox"]').dispatchEvent(event);
      })()`)
      assert.ok(await page(`Boolean(document.querySelector('[role="combobox"]'))`))
      assert.equal(
        await page(
          `document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`,
        ),
        activeBeforeComposition,
      )
    }
    // A composing Escape belongs to the IME candidate, not to the dialog.
    for (const eventOptions of [{ isComposing: true }, { keyCode: 229 }]) {
      await page(`(() => {
        const options = ${JSON.stringify(eventOptions)};
        const event = new KeyboardEvent('keydown', { key: 'Escape', isComposing: Boolean(options.isComposing), bubbles: true, cancelable: true });
        if (options.keyCode) Object.defineProperty(event, 'keyCode', { value: options.keyCode });
        document.querySelector('[role="combobox"]').dispatchEvent(event);
      })()`)
      assert.ok(
        await page(`Boolean(document.querySelector('[role="combobox"]'))`),
        'a composing Escape dismissed the palette',
      )
      assert.equal(
        await page(`document.querySelector('[role="combobox"]').value`),
        'Fetch',
        'a composing Escape lost the palette query',
      )
    }
    await key('Escape')
    await until('a real Escape still dismisses', `!document.querySelector('[role="combobox"]')`)
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await until('palette reopened after dismissal', `document.querySelector('[role="combobox"]')`)
    await search('')
    const activeBeforeRepeat = await highlightedOption()
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      autoRepeat: true,
    })
    assert.notEqual(
      await page(
        `document.querySelector('[role="combobox"]').getAttribute('aria-activedescendant')`,
      ),
      activeBeforeRepeat,
    )
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    })
    await search('origin/fetched-parent')
    await until(
      'remote parent result',
      `document.querySelector('[role="option"]')?.textContent?.includes('origin/fetched-parent')`,
    )
    await activate(
      'selected remote parent',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'origin/fetched-parent')`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Select child branch')
    await until(
      'child command enabled',
      `document.querySelector('[role="option"]')?.getAttribute('aria-disabled') === 'false'`,
    )
    await activate(
      'selected remote child',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'topic')`,
    )
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Select parent branch')
    await activate(
      'reselected remote parent',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'origin/fetched-parent')`,
    )
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Select stack top')
    await until(
      'top command enabled',
      `document.querySelector('[role="option"]')?.getAttribute('aria-disabled') === 'false'`,
    )
    await activate(
      'selected remote stack top',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'child')`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('topic')
    await activate(
      'reselected topic',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'topic')`,
    )
    await key('k', process.platform === 'darwin' ? 4 : 2)
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
    await activate(
      'selected feature',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'feature')`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await page(`${button('Fetch')}.focus()`)
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Delete feature')
    await activate(
      'armed confirmation',
      `document.body.textContent.includes('Press Enter again to confirm')`,
    )
    const branchAfterFirstEnter = git('branch', '--list', 'feature')
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      autoRepeat: true,
    })
    assert.ok(await page(`document.body.textContent.includes('Press Enter again to confirm')`))
    assert.equal(
      await page(
        `Boolean(document.querySelector('[role="dialog"]')?.textContent.includes('Delete local branch?'))`,
      ),
      false,
    )
    assert.match(git('branch', '--list', 'feature'), /feature/)
    assert.match(branchAfterFirstEnter, /feature/)
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
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
    try {
      await until(
        'opener focused after dialog',
        `document.activeElement?.textContent?.trim() === 'Fetch'`,
      )
    } catch (error) {
      throw new Error(
        `${error.message}; active=${JSON.stringify(await page('({text:document.activeElement?.textContent, html:document.activeElement?.outerHTML.slice(-400), connected:document.activeElement?.isConnected})'))}`,
      )
    }
    const restoredFocus = await page('document.activeElement?.textContent?.trim()')
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Delete feature')
    await activate(
      'armed confirmation for the delete workflow',
      `document.body.textContent.includes('Press Enter again to confirm')`,
    )
    await confirmDestructive(
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
    writeFileSync(join(repository, 'shared.txt'), 'baseline\nuncommitted\n')
    assert.match(git('status', '--short', 'shared.txt'), /M shared\.txt/)
    await refresh(
      'dirty snapshot',
      `Array.from(document.querySelectorAll('.workspace-nav button')).find((element) => element.textContent.includes('Working changes'))?.querySelector('.nav-count')?.textContent === '1'`,
    )
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('child')
    await activate(
      'selected dirty checkout target',
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === 'child')`,
    )
    async function guardedCheckout() {
      await key('k', process.platform === 'darwin' ? 4 : 2)
      await search('Check out child')
      await until(
        'checkout command',
        `document.querySelector('[role="option"][aria-disabled="false"]')`,
      )
      await activate(
        'dirty checkout alternatives',
        `document.querySelector('[role="dialog"]')?.textContent?.includes('Uncommitted changes in working tree')`,
      )
      for (const label of [
        'Cancel',
        'Review changes',
        'Carry changes and check out',
        'Stash changes…',
      ]) {
        assert.ok(
          await page(`Boolean(${button(label)})`),
          `missing dirty checkout alternative: ${label}`,
        )
      }
    }
    await guardedCheckout()
    await page(`${button('Cancel')}.click()`)
    await until('dirty guard cancelled', `!document.querySelector('[role="dialog"]')`)
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    assert.match(git('status', '--short', 'shared.txt'), /M shared\.txt/)
    await guardedCheckout()
    await page(`${button('Stash changes…')}.click()`)
    await until(
      'stash workflow',
      `document.querySelector('[role="dialog"]')?.textContent?.includes('Stash')`,
    )
    await page(`${button('Cancel')}.click()`)
    await until('stash cancelled', `!document.querySelector('[role="dialog"]')`)
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    assert.equal(git('stash', 'list'), '')
    await guardedCheckout()
    await page(`${button('Review changes')}.click()`)
    await until(
      'review changes view',
      `document.querySelector('main h1')?.textContent === 'Working changes'`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'topic')
    await guardedCheckout()
    await page(`${button('Carry changes and check out')}.click()`)
    for (
      let attempt = 0;
      attempt < 100 && git('symbolic-ref', '--short', 'HEAD') !== 'child';
      attempt++
    ) {
      await delay(50)
    }
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'child')
    assert.match(git('status', '--short', 'shared.txt'), /M shared\.txt/)
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Go to Branches')
    await activate(
      'child current in branch view',
      `document.querySelector('[aria-label="child, current branch"]')`,
    )
    await key('k', process.platform === 'darwin' ? 4 : 2)
    await search('Keyboard shortcuts')
    await until(
      'shortcuts result',
      `document.querySelector('[role="option"]')?.textContent?.includes('Keyboard shortcuts')`,
    )
    await activate(
      'shortcut settings',
      `document.querySelector('[aria-label="Change shortcut for Open command palette"]')`,
    )
    await page(
      `document.querySelector('[aria-label="Change shortcut for Open command palette"]').click()`,
    )
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: '+',
      code: 'Equal',
      windowsVirtualKeyCode: 187,
      modifiers: 8,
    })
    await until(
      'printable remap saved',
      `document.body.textContent.includes('Updated shortcut for "Open command palette"')`,
    )
    await page(`${button('Done')}.click()`)
    await until('shortcut settings closed', `!document.querySelector('[role="dialog"]')`)
    // The accessible metadata is serialized separately from the drawn label, so
    // a remapped shortcut is still announced with standardized key names.
    const remappedOpenerAria = await page(
      `document.querySelector('[aria-label="Open command palette"]')?.getAttribute('aria-keyshortcuts') ?? null`,
    )
    // A printable remap records the bare character, and the ARIA token names it
    // the way the key value table spells it.
    assert.equal(remappedOpenerAria, 'Plus')
    const filter = '[aria-label="Filter current view branches, files, and pull requests"]'
    await page(`document.querySelector(${JSON.stringify(filter)}).focus()`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: '+',
      code: 'Equal',
      text: '+',
      windowsVirtualKeyCode: 187,
      modifiers: 8,
    })
    await until(
      'printable key typed into the filter',
      `document.querySelector(${JSON.stringify(filter)}).value === '+'`,
    )
    assert.equal(await page(`Boolean(document.querySelector('[role="combobox"]'))`), false)
    await page(`${button('Fetch')}.focus()`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: '+',
      code: 'Equal',
      text: '+',
      windowsVirtualKeyCode: 187,
      modifiers: 8,
    })
    await until('remapped opener', `document.querySelector('[role="combobox"]')`)
    // The opener press is still logically held, so it is released and the chord
    // is typed again the way a second keystroke arrives: the open palette takes
    // the printable key rather than toggling itself shut. A dropped dispatch
    // repeats, which is only safe while the palette still holds the chord.
    const chordHeld = { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, modifiers: 8 }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...chordHeld })
      await delay(250)
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...chordHeld,
        text: '+',
      })
      if (await page(`document.querySelector('[role="combobox"]')?.value === '+'`)) break
      if (!(await page(`Boolean(document.querySelector('[role="combobox"]'))`))) {
        await page(`${button('Fetch')}.focus()`)
        await send('Input.dispatchKeyEvent', { type: 'keyDown', ...chordHeld, text: '+' })
        await until('remapped opener', `document.querySelector('[role="combobox"]')`)
      }
    }
    await until(
      'the open palette took the chord',
      `document.querySelector('[role="combobox"]')?.value === '+'`,
    )
    assert.ok(await page(`Boolean(document.querySelector('[role="combobox"]'))`))
    if (process.env.PALETTE_EVIDENCE_DIR) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(process.env.PALETTE_EVIDENCE_DIR, 'palette-e2e.png'),
        Buffer.from(screenshot.data, 'base64'),
      )
    }
    let opener = { key: '+', code: 'Equal', text: '+', windowsVirtualKeyCode: 187 }
    let openerModifier = 8
    async function openPalette() {
      await parkPointer()
      // A single CDP key dispatch can be lost while the renderer replaces the
      // focused toolbar node, so retry the press before failing the scenario.
      for (let attempt = 0; attempt < 3; attempt++) {
        await page(`${button('Fetch')}.focus()`)
        await pressOpener()
        await delay(150)
        if (await page(`Boolean(document.querySelector('[role="combobox"]'))`)) return
      }
      throw new Error('the palette did not open after three opener presses')
    }
    async function pressOpener() {
      // Release first: a press that arrives as an auto-repeat is deliberately
      // inert, and an earlier scenario may still hold the key.
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: opener.key,
        code: opener.code,
        windowsVirtualKeyCode: opener.windowsVirtualKeyCode,
        modifiers: openerModifier,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...opener,
        modifiers: openerModifier,
      })
    }
    async function setFilter(text) {
      await page(
        `(() => { const input = document.querySelector(${JSON.stringify(filter)}); input.focus(); input.select() })()`,
      )
      if (text) await send('Input.insertText', { text })
      else
        await send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
        })
      await until(
        `filter ${JSON.stringify(text)}`,
        `document.querySelector(${JSON.stringify(filter)}).value === ${JSON.stringify(text)}`,
      )
      // The opener chord is a printable key, so a filter that still holds focus
      // would swallow the next palette open as typed text.
      await page(`document.querySelector(${JSON.stringify(filter)}).blur()`)
    }
    await key('Escape')
    await until('palette dismissed after evidence', `!document.querySelector('[role="combobox"]')`)
    await setFilter('')

    // A local branch that tracks its remote keeps a qualified parent name usable.
    execFileSync('git', ['init', '--bare', '-q', join(root, 'origin.git')], { stdio: 'pipe' })
    git('remote', 'add', 'origin', join(root, 'origin.git'))
    git('push', '-q', '-u', 'origin', 'main')
    git('config', 'branch.child.parent', 'origin/main')
    await refresh('tracked local branch', `document.querySelector('button[aria-label="main"]')`)
    await delay(500)
    await openPalette()
    await search('child')
    await activate(
      'child selected before parent navigation',
      `document.querySelector('button[aria-current="true"][aria-label="child, current branch"]')`,
    )
    await openPalette()
    await search('Select parent branch')
    await until(
      'qualified parent resolves to the tracked local branch',
      `document.querySelector('[role="option"]')?.getAttribute('aria-disabled') === 'false' && document.querySelector('[role="option"]')?.textContent?.includes('Target: main')`,
    )
    await activate(
      'local main selected through a qualified parent',
      `document.querySelector('button[aria-current="true"][aria-label="main"]')`,
    )
    await openPalette()
    await search('Select child branch')
    await activate(
      'child selected from the tracked local branch',
      `document.querySelector('button[aria-current="true"][aria-label="child, current branch"]')`,
    )
    await openPalette()
    await search('Select stack bottom')
    await activate(
      'stack bottom follows the qualified parent',
      `document.querySelector('button[aria-current="true"][aria-label="main"]')`,
    )
    const qualifiedParentSelection = await page(
      `document.querySelector('button[aria-current="true"]')?.getAttribute('aria-label')`,
    )
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'child')

    // Readiness is read from the branch count rather than from a row: the view
    // filter can legitimately hide every row while the snapshot holds them all.
    const branchCount = `Array.from(document.querySelectorAll('.workspace-nav button')).find((element) => element.textContent.includes('Branches'))?.querySelector('.nav-count')?.textContent ?? ''`
    const branchesBefore = await page(branchCount)
    // Two local branches can track the same upstream ref; only the recorded
    // parent decides which of them owns a child.
    for (const tracker of ['track-a', 'track-b']) {
      git('branch', '--force', tracker, 'main')
      execFileSync('git', ['-C', repository, 'branch', '--set-upstream-to=origin/main', tracker])
      git('config', `branch.${tracker}.parent`, 'fetched-parent')
    }
    git('branch', '--force', 'leaf', 'main')
    git('config', 'branch.leaf.parent', 'track-b')
    await refresh(
      'shared upstream trackers',
      `(${branchCount}) !== ${JSON.stringify(branchesBefore)}`,
    )
    const topOption = () => page(`document.querySelector('[role="option"]')?.textContent ?? ''`)
    // The selected branch is named by the view heading, which the app keeps
    // independent of the branch list's own filter and of which branch is
    // checked out.
    const selectionIs = (name) =>
      `Array.from(document.querySelectorAll('h2')).some((element) => element.textContent === ${JSON.stringify(name)})`

    // main tracks the same upstream ref and must not inherit track-b's child.
    await openPalette()
    await search('Select child branch')
    const mainChildTarget = await topOption()
    assert.match(mainChildTarget, /Target: child/)
    assert.doesNotMatch(mainChildTarget, /Target: leaf/)
    await activate('recorded child selected', selectionIs('child'))
    await openPalette()
    await search('Select parent branch')
    const childParentTarget = await topOption()
    assert.match(childParentTarget, /Target: main/)
    await activate('local parent reselected', selectionIs('main'))
    await openPalette()
    await search('Select stack top')
    const mainTopTarget = await topOption()
    assert.match(mainTopTarget, /Target: child/)
    assert.doesNotMatch(mainTopTarget, /Target: leaf/)
    await key('Escape')
    await until('top navigation left the palette', `!document.querySelector('[role="combobox"]')`)

    await openPalette()
    await search('track-b')
    await activate('tracker selected', selectionIs('track-b'))
    await openPalette()
    await search('Select child branch')
    const trackerChildTarget = await topOption()
    assert.match(trackerChildTarget, /Target: leaf/)
    await activate('tracker child selected', selectionIs('leaf'))
    await openPalette()
    await search('Select parent branch')
    const leafParentTarget = await topOption()
    assert.match(leafParentTarget, /Target: track-b/)
    await activate('tracker reselected from its child', selectionIs('track-b'))

    // The other tracker shares that upstream ref and owns nothing above it.
    await openPalette()
    await search('track-a')
    await activate('second tracker selected', selectionIs('track-a'))
    await openPalette()
    await search('Select child branch')
    const emptyTrackerTarget = await topOption()
    const emptyTrackerDisabled = await page(
      `document.querySelector('[role="option"]')?.getAttribute('aria-disabled')`,
    )
    assert.match(emptyTrackerTarget, /No child branch found for track-a/)
    assert.equal(emptyTrackerDisabled, 'true')
    await key('Escape')
    await openPalette()
    await search('Select stack top')
    const emptyTrackerTop = await topOption()
    assert.match(emptyTrackerTop, /No top branch found for track-a/)
    assert.equal(
      await page(`document.querySelector('[role="option"]')?.getAttribute('aria-disabled')`),
      'true',
    )
    await key('Enter')
    await key('Escape')
    await until(
      'disabled navigation left the palette',
      `!document.querySelector('[role="combobox"]')`,
    )
    assert.ok(await page(selectionIs('track-a')), 'a disabled navigation moved the selection')

    // The opener cannot own a key the open palette handles; a modified chord on
    // one still works because the palette yields the event it already handled.
    await openPalette()
    await search('Keyboard shortcuts')
    await activate(
      'shortcut settings reopened',
      `document.querySelector('[aria-label="Change shortcut for Open command palette"]')`,
    )
    const recordOpener = `document.querySelector('[aria-label="Change shortcut for Open command palette"]').click()`
    await page(recordOpener)
    await key('Enter')
    await until(
      'reserved opener rejected',
      `document.body.textContent.includes('is reserved by the command palette for selecting or confirming the highlighted item')`,
    )
    await key('Escape')
    await until(
      'reserved message cleared',
      `!document.body.textContent.includes('is reserved by the command palette')`,
    )
    await page(recordOpener)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      modifiers: 1,
    })
    await until(
      'modified opener recorded',
      `document.body.textContent.includes('Updated shortcut for "Open command palette"')`,
    )
    await page(`${button('Done')}.click()`)
    await until('shortcut settings closed again', `!document.querySelector('[role="dialog"]')`)
    opener = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    openerModifier = 1
    await openPalette()
    await search('Force push with lease')
    await until(
      'force push available',
      `document.querySelector('[role="option"]')?.getAttribute('aria-disabled') === 'false'`,
    )
    await pressOpener()
    assert.ok(
      await page(`document.body.textContent.includes('Press Enter again to confirm')`),
      'the modified opener did not arm the destructive confirmation',
    )
    assert.ok(
      await page(`Boolean(document.querySelector('[role="combobox"]'))`),
      'the modified opener closed the palette instead of arming the confirmation',
    )
    await pressOpener()
    await until('force push workflow', `document.querySelector('[role="dialog"]')`)
    await page(`${button('Cancel')}.click()`)
    await until('force push cancelled', `!document.querySelector('[role="dialog"]')`)
    const headAfterModifiedOpener = git('symbolic-ref', '--short', 'HEAD')
    await openPalette()
    await search('Force push with lease')
    await setFilter('+')
    // Read here, where the scenario left them: the reload below resets the view.
    const editableFilter = await page(`document.querySelector(${JSON.stringify(filter)}).value`)
    const editablePaletteSearch = await page(`document.querySelector('[role="combobox"]')?.value`)
    // A persisted opener on a key the open palette handles cannot be honored.
    // The chord it falls back to must not stay shared with the stored filter
    // shortcut, or the filter would silently open the palette instead.
    await key('Escape')
    await until(
      'palette dismissed before rehydration',
      `!document.querySelector('[role="combobox"]')`,
    )
    // The same Home keydown was stored under two spellings, so hydration has to
    // settle it to one owner the way it settles a shared chord.
    const storedChords = JSON.stringify({
      'palette.open': 'ArrowDown',
      'search.focus': 'Mod+K',
      'view.branches': 'Home',
      'view.stacks': 'home',
    })
    assert.equal(
      await page(
        `(() => { localStorage.setItem('git-stacks.shortcuts.v1', ${JSON.stringify(storedChords)}); return localStorage.getItem('git-stacks.shortcuts.v1') })()`,
      ),
      storedChords,
    )
    await send('Page.reload')
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        if (await page(`document.readyState === 'complete'`)) break
      } catch {
        /* the reload replaced the execution context */
      }
      await delay(50)
    }
    await until(
      'reloaded shell',
      `Boolean(${fixtureButton} || document.querySelector(${JSON.stringify(filter)}))`,
    )
    if (!(await page(`Boolean(document.querySelector(${JSON.stringify(filter)}))`))) {
      await page(`${fixtureButton}.click()`)
    }
    await until('snapshot after rehydration', `document.querySelector(${JSON.stringify(filter)})`)
    const chordExpression = (label) =>
      `(() => { const control = document.querySelector('[aria-label="Change shortcut for ${label}"]'); return control?.parentElement?.querySelector('kbd')?.textContent ?? null })()`
    opener = { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 }
    openerModifier = process.platform === 'darwin' ? 4 : 2
    await openPalette()
    await search('Keyboard shortcuts')
    await activate(
      'shortcut settings after rehydration',
      `document.querySelector('[aria-label="Change shortcut for Focus search filter"]')`,
    )
    const rehydratedFilterChord = await page(chordExpression('Focus search filter'))
    const rehydratedOpenerChord = await page(chordExpression('Open command palette'))
    const rehydratedBranchesChord = await page(chordExpression('Go to Branches'))
    const rehydratedStacksChord = await page(chordExpression('Go to Stacks'))
    assert.equal(rehydratedBranchesChord, 'Home')
    assert.equal(
      rehydratedStacksChord,
      process.platform === 'darwin' ? '⌘2' : 'Ctrl+2',
      'the second Home spelling did not fall back to its own default',
    )
    assert.equal(rehydratedFilterChord, '/')
    assert.equal(
      rehydratedOpenerChord,
      process.platform === 'darwin' ? '⌘K' : 'Ctrl+K',
      'the reserved opener was not restored to its default chord',
    )
    await page(`${button('Done')}.click()`)
    await until(
      'shortcut settings closed after rehydration',
      `!document.querySelector('[role="dialog"]')`,
    )
    // The shortcut can only land on a view that shows the field, and a single
    // CDP dispatch can be dropped, so the press repeats until the filter takes
    // focus.
    const filterFocused = `document.activeElement?.getAttribute('aria-label') === 'Filter current view branches, files, and pull requests'`
    await until('filter field on screen', `document.querySelector(${JSON.stringify(filter)})`)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page(`${button('Fetch')}.focus()`)
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: '/',
        code: 'Slash',
        text: '/',
        windowsVirtualKeyCode: 191,
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: '/',
        code: 'Slash',
        windowsVirtualKeyCode: 191,
      })
      if (await page(filterFocused)) break
      await delay(200)
    }
    const filterFocusedBySlash = await page(filterFocused)
    assert.ok(filterFocusedBySlash, 'the restored filter shortcut did not focus the filter')
    assert.equal(
      await page(`Boolean(document.querySelector('[role="combobox"]'))`),
      false,
      'the restored filter shortcut opened the palette',
    )
    // The focused field keeps its own shortcut, advertised with the same
    // standardized tokens as the drawn label beside it.
    const rehydratedFilterAria = await page(
      `document.querySelector(${JSON.stringify(filter)})?.getAttribute('aria-keyshortcuts') ?? null`,
    )
    assert.equal(rehydratedFilterAria, '/')
    await openPalette()
    const restoredOpenerOpenedPalette = await page(
      `Boolean(document.querySelector('[role="combobox"]'))`,
    )
    assert.equal(restoredOpenerOpenedPalette, true, 'the restored opener did not open the palette')
    const rehydratedOpenerAria = await page(
      `document.querySelector('[aria-label="Open command palette"]')?.getAttribute('aria-keyshortcuts') ?? null`,
    )
    assert.equal(
      rehydratedOpenerAria,
      process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
      'the restored opener advertised non-standardized shortcut metadata',
    )
    await until(
      'restored opener still opens the palette',
      `document.querySelector('[role="combobox"]')`,
    )
    await key('Escape')
    await until(
      'palette dismissed before the Home press',
      `!document.querySelector('[role="combobox"]')`,
    )
    // One Home keydown must reach exactly one view, and it must reach it from a
    // view that is not already showing it.
    await page(`${button('Fetch')}.focus()`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: '2',
      code: 'Digit2',
      windowsVirtualKeyCode: 50,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: '2',
      code: 'Digit2',
      windowsVirtualKeyCode: 50,
      modifiers: process.platform === 'darwin' ? 4 : 2,
    })
    await until('stacks view', `document.querySelector('main h1')?.textContent === 'Stacks'`)
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Home',
      code: 'Home',
      windowsVirtualKeyCode: 36,
    })
    await until(
      'the surviving Home owner switched to the branches view',
      `document.querySelector('main h1')?.textContent === 'Branches'`,
    )
    console.log(
      JSON.stringify({
        disabledPaletteValue,
        selectionHead: git('symbolic-ref', '--short', 'HEAD'),
        branchAfterFirstEnter,
        branchAfterCancel,
        restoredFocus,
        confirmedDeletion: git('branch', '--list', 'feature'),
        dirtyCarryStatus: git('status', '--short', 'shared.txt'),
        stashList: git('stash', 'list'),
        qualifiedParentSelection,
        headAfterModifiedOpener,
        editableFilter,
        editablePaletteSearch,
        mainChildTarget,
        childParentTarget,
        mainTopTarget,
        trackerChildTarget,
        leafParentTarget,
        emptyTrackerTarget,
        rehydratedFilterChord,
        rehydratedOpenerChord,
        filterFocusedBySlash,
        remappedOpenerAria,
        rehydratedOpenerAria,
        rehydratedFilterAria,
        rehydratedBranchesChord,
        rehydratedStacksChord,
        restoredOpenerOpenedPalette,
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
