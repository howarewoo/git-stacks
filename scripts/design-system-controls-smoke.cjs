const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')

const rendererPath = join(__dirname, '..', 'out', 'renderer', 'index.html')
const pageHelpers = `
  function buttonNamed(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.replace(/\\s+/g, ' ').trim() === label,
    )
  }
`

let window
let debuggerAttached = false

function press(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  if (keyCode === 'Return') {
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  }
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
}

function pageAction(body) {
  return `(async () => {${pageHelpers}${body}})()`
}

async function runInPage(body) {
  return window.webContents.executeJavaScript(pageAction(body), true)
}

async function evaluateInPage(expression) {
  return window.webContents.executeJavaScript(
    `(async () => {${pageHelpers}return (${expression})})()`,
    true,
  )
}

async function waitFor(description, expression, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`, true)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function main() {
  if (!existsSync(rendererPath)) {
    throw new Error(`Missing production renderer at ${rendererPath}; run the build first.`)
  }

  await app.whenReady()
  window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  })

  await window.loadURL(`${pathToFileURL(rendererPath).href}#/design-system-controls`)
  window.focus()
  await waitFor(
    'the controls gallery',
    `document.body.textContent.includes('Fields and selection')`,
  )
  await waitFor(
    'the mixed checkbox state',
    `document.querySelector('#specimen-mixed')?.indeterminate === true`,
  )

  await runInPage(`
    const trigger = buttonNamed('Open actions')
    if (!trigger) throw new Error('The menu trigger is missing.')
    trigger.focus()
  `)
  press('Return')
  await waitFor('the menu to open', `document.querySelector('[role="menu"]')`)
  press('Escape')
  await waitFor('the menu to close', `!document.querySelector('[role="menu"]')`)
  await waitFor(
    'menu focus restoration',
    `document.activeElement?.textContent?.trim() === 'Open actions'`,
  )
  assert.equal(
    await evaluateInPage(`document.activeElement === buttonNamed('Open actions')`),
    true,
    'menu focus should return to its trigger',
  )

  await runInPage(`
    const trigger = buttonNamed('Focusable tooltip')
    if (!trigger) throw new Error('The tooltip trigger is missing.')
    trigger.focus()
  `)
  await waitFor('the tooltip to open', `document.querySelector('[role="tooltip"]')`, 2000)
  press('Escape')
  await waitFor('the tooltip to close', `!document.querySelector('[role="tooltip"]')`)
  assert.equal(
    await evaluateInPage(`document.activeElement === buttonNamed('Focusable tooltip')`),
    true,
    'tooltip focus should remain on its trigger',
  )

  await runInPage(`
    const trigger = buttonNamed('Open dialog')
    if (!trigger) throw new Error('The dialog trigger is missing.')
    trigger.focus()
  `)
  press('Return')
  await waitFor('the dialog to open', `document.querySelector('[role="dialog"]')`)
  assert.equal(
    await evaluateInPage(`document.activeElement?.id === 'specimen-dialog-name'`),
    true,
    'dialog should focus its first field',
  )
  press('Escape')
  await waitFor('the dialog to close', `!document.querySelector('[role="dialog"]')`)
  await waitFor(
    'dialog focus restoration',
    `document.activeElement?.textContent?.trim() === 'Open dialog'`,
  )
  assert.equal(
    await evaluateInPage(`document.activeElement === buttonNamed('Open dialog')`),
    true,
    'dialog focus should return to its trigger',
  )

  // Specimen routes are selected at startup, not by a hash-change router.
  await window.loadURL('about:blank')
  await window.loadURL(`${pathToFileURL(rendererPath).href}#/design-system-shell-specimen`)
  await waitFor('the shell specimen', `document.querySelector('.shell-fixture-content')`)

  window.webContents.debugger.attach('1.3')
  debuggerAttached = true
  for (const width of [1000, 810, 761]) {
    await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await runInPage(
      `await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    )
    const toolbar = await evaluateInPage(`(() => {
      const element = document.querySelector('.toolbar')
      const bounds = element.getBoundingClientRect()
      const clipped = Array.from(element.querySelectorAll('button')).filter((button) => {
        const rect = button.getBoundingClientRect()
        return rect.left < bounds.left || rect.right > bounds.right
      })
      return {
        width: document.documentElement.clientWidth,
        mobile: window.matchMedia('(max-width: 760px)').matches,
        overflows: element.scrollWidth > element.clientWidth,
        clipped: clipped.map((button) => button.getAttribute('aria-label') || button.textContent.trim()),
      }
    })()`)
    assert.equal(toolbar.width, width, `the ${width}px CSS viewport should be active`)
    assert.equal(
      toolbar.mobile,
      false,
      `the ${width}px viewport should remain above the mobile breakpoint`,
    )
    assert.equal(toolbar.overflows, false, `the toolbar should fit at ${width}px`)
    assert.deepEqual(toolbar.clipped, [], `all toolbar actions should be reachable at ${width}px`)
  }

  await window.loadURL('about:blank')
  await window.loadURL(`${pathToFileURL(rendererPath).href}#/design-system-controls`)
  await waitFor('the controls gallery', `document.querySelector('#specimen-mixed')`)

  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  assert.equal(
    await evaluateInPage(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`),
    true,
    'reduced-motion media emulation should be active',
  )
  await runInPage(`buttonNamed('Open dialog')?.click()`)
  await waitFor('the reduced-motion dialog', `document.querySelector('[role="dialog"]')`)
  assert.equal(
    await evaluateInPage(
      `parseFloat(getComputedStyle(document.querySelector('[role="dialog"]')).animationDuration) <= 0.00001`,
    ),
    true,
    'reduced motion should shorten dialog animation',
  )

  // The guarded publish card claims to be wired to the real guard and the real builder. A
  // ready button that dispatches nothing is a false confirmation, so the smoke types the
  // exact branch name and asserts the payload the real builder produces.
  await window.loadURL('about:blank')
  await window.loadURL(`${pathToFileURL(rendererPath).href}#/design-system-dialog-specimen`)
  const publishCard = `document.querySelector('[data-operation="publish"]')`
  await waitFor('the guarded publish card', publishCard)
  assert.equal(
    await evaluateInPage(
      `${publishCard}.querySelector('[data-role="blocker"]').textContent.trim()`,
    ),
    'confirmation-incomplete',
    'the guarded publish card should refuse before the exact branch name is typed',
  )
  await runInPage(`
    const input = document.querySelector('[data-operation="publish"] input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'feature/checkout')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  `)
  await waitFor(
    'the publish card to become ready',
    `${publishCard}.querySelector('[data-role="blocker"]').textContent.trim() === 'ready'`,
  )
  const dispatched = await runInPage(`
    const card = document.querySelector('[data-operation="publish"]')
    card.querySelector('button').click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return document.querySelector('[data-operation="dispatched"] [data-role="dispatched"]').textContent.trim()
  `)
  const payload = /^(\{.*\})$/su.exec(dispatched)
  assert.ok(payload, 'pressing the ready publish card should show the dispatched action')
  const action = JSON.parse(payload[1])
  assert.equal(action.type, 'submitStack', 'the ready card should dispatch a real submission')
  assert.equal(action.allowForce, true, 'the consent the card shows is the consent it dispatches')
  assert.equal(
    action.layers['feature/checkout'].title,
    'Checkout validation',
    'the dispatched submission should carry the reviewed layer choice',
  )

  // A recovered submission is resumed from its journal, so what the dialog says about each
  // layer has to come from the journal too. A fresh preview that describes a different base
  // must not relabel what Resume will run.
  await window.loadURL('about:blank')
  await window.loadURL(
    `${pathToFileURL(rendererPath).href}#/design-system-recovery-specimen?mode=mismatch`,
  )
  await waitFor('the recovered submit dialog', `document.querySelector('.workflow-dialog')`)
  await waitFor(
    'the saved consent to render',
    `document.querySelector('.workflow-dialog').textContent.includes('Saved approval for rewritten branches')`,
  )
  const mismatched = await evaluateInPage(
    `document.querySelector('.workflow-dialog').textContent.replace(/\\s+/g, ' ')`,
  )
  assert.match(
    mismatched,
    /feature\/checkout-orders → feature\/checkoutPull request #102 keeps its title/,
    'a recovered layer should be described by the journalled base and pull request',
  )
  assert.equal(
    await evaluateInPage(
      `Array.from(document.querySelectorAll('label')).some((label) => label.textContent.startsWith('Change the base of pull request'))`,
    ),
    false,
    'a recovered base change must be shown as saved, not offered as an unchecked control',
  )
  assert.equal(
    await evaluateInPage(
      `document.querySelector('[role="dialog"] input[type="checkbox"]:not(:disabled)') === null`,
    ),
    true,
    'a recovered submission should offer no editable consent checkbox',
  )
  assert.equal(
    await evaluateInPage(`buttonNamed('Resume submission')?.disabled === false`),
    true,
    'the recovered submission should still be resumable',
  )
  assert.doesNotMatch(mismatched, /feature\/moved-parent|#902|Planned stack operations/)
  assert.equal(
    await evaluateInPage(`document.getElementById('title-feature%2Fcheckout')?.value`),
    'Checkout validation',
  )
  assert.equal(await evaluateInPage(`buttonNamed('Dismiss submission')?.disabled === false`), true)

  // A fresh read that fails must not take the saved operation with it: Resume stays enabled,
  // so the steps and the consent it will run under have to stay on screen.
  await window.loadURL('about:blank')
  await window.loadURL(
    `${pathToFileURL(rendererPath).href}#/design-system-recovery-specimen?mode=preview-failure`,
  )
  await waitFor(
    'the recovered submit dialog without a fresh preview',
    `document.querySelector('.workflow-dialog')`,
  )
  await waitFor(
    'the saved consent to survive a failed fresh read',
    `document.querySelector('.workflow-dialog').textContent.includes('Saved approval for rewritten branches')`,
  )
  const withoutPreview = await evaluateInPage(
    `document.querySelector('.workflow-dialog').textContent.replace(/\\s+/g, ' ')`,
  )
  assert.match(
    withoutPreview,
    /Push feature\/checkout-orders/,
    'the saved steps should remain visible when the fresh preview fails',
  )
  assert.match(
    withoutPreview,
    /feature\/checkout-orders → feature\/checkoutPull request #102 keeps its title/,
    'the saved layer should remain visible when the fresh preview fails',
  )
  assert.match(
    withoutPreview,
    /Recorded: branches with a rewritten history are pushed with exact leases\./,
    'the recorded force consent must remain visible when the fresh preview fails',
  )
  assert.match(withoutPreview, /Remote refused the update/)
  assert.match(withoutPreview, /Fetch the remote, confirm nobody pushed/)
  assert.equal(await evaluateInPage(`buttonNamed('Resume submission')?.disabled === false`), true)
  assert.equal(await evaluateInPage(`buttonNamed('Dismiss submission')?.disabled === false`), true)
  console.log(
    'Electron controls: guarded submitStack dispatch; journal identity, saved approvals, failed steps, recovery guidance and enabled Resume/Dismiss with mismatched or unavailable preview.',
  )
}

main()
  .then(async () => {
    if (debuggerAttached) window.webContents.debugger.detach()
    if (window && !window.isDestroyed()) window.destroy()
    app.quit()
  })
  .catch(async (error) => {
    console.error(error)
    if (debuggerAttached && window && !window.isDestroyed()) window.webContents.debugger.detach()
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(1)
  })
