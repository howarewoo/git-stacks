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
  function press(key) {
    const target = document.activeElement || document.body
    const init = { bubbles: true, cancelable: true, key, code: key }
    target.dispatchEvent(new KeyboardEvent('keydown', init))
    target.dispatchEvent(new KeyboardEvent('keyup', init))
  }
`

let window
let debuggerAttached = false

function pageAction(body) {
  return `(async () => {${pageHelpers}${body}})()`
}

async function runInPage(body) {
  return window.webContents.executeJavaScript(pageAction(body), true)
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
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  })

  await window.loadURL(`${pathToFileURL(rendererPath).href}#/design-system-controls`)
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
    press('Enter')
  `)
  await waitFor('the menu to open', `document.querySelector('[role="menu"]')`)
  await runInPage(`press('Escape')`)
  await waitFor('the menu to close', `!document.querySelector('[role="menu"]')`)
  assert.equal(
    await runInPage(`document.activeElement === buttonNamed('Open actions')`),
    true,
    'menu focus should return to its trigger',
  )

  await runInPage(`
    const trigger = buttonNamed('Focusable tooltip')
    if (!trigger) throw new Error('The tooltip trigger is missing.')
    trigger.focus()
  `)
  await waitFor('the tooltip to open', `document.querySelector('[role="tooltip"]')`, 2000)
  await runInPage(`press('Escape')`)
  await waitFor('the tooltip to close', `!document.querySelector('[role="tooltip"]')`)
  assert.equal(
    await runInPage(`document.activeElement === buttonNamed('Focusable tooltip')`),
    true,
    'tooltip focus should remain on its trigger',
  )

  await runInPage(`
    const trigger = buttonNamed('Open dialog')
    if (!trigger) throw new Error('The dialog trigger is missing.')
    trigger.focus()
    press('Enter')
  `)
  await waitFor('the dialog to open', `document.querySelector('[role="dialog"]')`)
  assert.equal(
    await runInPage(`document.activeElement?.id === 'specimen-dialog-name'`),
    true,
    'dialog should focus its first field',
  )
  await runInPage(`press('Escape')`)
  await waitFor('the dialog to close', `!document.querySelector('[role="dialog"]')`)
  assert.equal(
    await runInPage(`document.activeElement === buttonNamed('Open dialog')`),
    true,
    'dialog focus should return to its trigger',
  )

  window.webContents.debugger.attach('1.3')
  debuggerAttached = true
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  assert.equal(
    await runInPage(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`),
    true,
    'reduced-motion media emulation should be active',
  )
  await runInPage(`buttonNamed('Open dialog')?.click()`)
  await waitFor('the reduced-motion dialog', `document.querySelector('.animate-dialog-in')`)
  assert.equal(
    await runInPage(
      `getComputedStyle(document.querySelector('.animate-dialog-in')).animationDuration.includes('0.01')`,
    ),
    true,
    'reduced motion should shorten dialog animation',
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
