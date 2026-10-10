import { test, expect, type Locator } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

// Fixtures must stay local even if a future specimen accidentally adds transport.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ||
      ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort('blockedbyclient')
  })
})

async function contrast(locator: Locator, property: 'borderTopColor' | 'outlineColor') {
  return locator.evaluate((node, property) => {
    const style = getComputedStyle(node)
    function channels(color: string) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return Array.from(context.getImageData(0, 0, 1, 1).data)
    }
    function luminance(rgb: number[]) {
      return rgb.slice(0, 3).reduce((sum, value, index) => {
        const channel = value / 255
        return (
          sum +
          (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
            [0.2126, 0.7152, 0.0722][index]
        )
      }, 0)
    }
    function surface(element: Element | null): number[] {
      if (!element) return [255, 255, 255, 255]
      const color = channels(getComputedStyle(element).backgroundColor)
      const alpha = color[3] / 255
      const parent = alpha === 1 ? color : surface(element.parentElement)
      return color
        .slice(0, 3)
        .map((channel, index) => channel * alpha + parent[index] * (1 - alpha))
        .concat(255)
    }
    const ink = channels(style[property])
    const background = surface(property === 'outlineColor' ? node.parentElement : node)
    const alpha = ink[3] / 255
    const foreground = ink
      .slice(0, 3)
      .map((channel, index) => channel * alpha + background[index] * (1 - alpha))
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
    return {
      ratio: (values[0] + 0.05) / (values[1] + 0.05),
      width: parseFloat(style[property === 'outlineColor' ? 'outlineWidth' : 'borderTopWidth']),
      style: property === 'outlineColor' ? style.outlineStyle : style.borderTopStyle,
    }
  }, property)
}

async function expectFocusContrast(locator: Locator) {
  await locator.focus()
  const result = await contrast(locator, 'outlineColor')
  expect(result.style).toBe('solid')
  expect(result.width).toBeGreaterThanOrEqual(2)
  expect(result.ratio).toBeGreaterThanOrEqual(3)
}

test('all specimens render independently without desktop bridge', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('[data-specimen]')).toHaveCount(64)
  await expect(page.locator('[data-component]')).toHaveCount(64)
  await expect(page.locator('#foundations dl').first()).toContainText('4px')
  await expect(page.locator('#foundations')).not.toContainText('{primitive.')
  expect(await page.evaluate(() => 'desktop' in window)).toBe(false)
  const ids = await page.locator('[id]').evaluateAll((nodes) => nodes.map((node) => node.id))
  expect(new Set(ids).size).toBe(ids.length)
  for (const specimen of await page.locator('[data-specimen]').all())
    expect(await specimen.locator(':scope > *').count()).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('search anchors and keyboard command navigation', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Search components' }).fill('one-time password')
  await expect(page.locator('[data-component]')).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Search components' }).fill('')
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Find a component').fill('Checkbox')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#checkbox$/)
  await expect(page.locator('#checkbox')).toBeFocused()
})

test('forms preserve validation mixed and empty-select states', async ({ page }) => {
  await page.goto('/')
  const field = page.locator('#branch-field')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await field.fill('valid-branch')
  await expect(field).not.toHaveAttribute('aria-invalid', 'true')
  const checkbox = page.locator('#checkbox').getByRole('checkbox').first()
  await checkbox.focus()
  await page.keyboard.press('Space')
  await expect(checkbox).toBeChecked()
  await expect(page.locator('#checkbox').getByRole('checkbox').nth(1)).toHaveAttribute(
    'aria-checked',
    'mixed',
  )
  await page.getByRole('combobox', { name: 'Branch filter' }).click()
  await page.getByRole('option', { name: 'Local branches', exact: true }).click()
  await expect(page.locator('#select')).toContainText('Selected filter: local')
  await page.getByRole('combobox', { name: 'Branch filter' }).click()
  await page.getByRole('option', { name: 'All branches (empty value)' }).click()
  await expect(page.locator('#select')).toContainText('Selected filter: all')
})

test('menu keyboard interaction and dialog focus return', async ({ page }) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'Branch actions', exact: true })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('#dropdown-menu')).toContainText('Branch inspection selected')
  const dialog = page.getByRole('button', { name: 'Open inspection dialog' })
  await dialog.click()
  await expect(page.getByRole('dialog', { name: 'Branch inspection' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeFocused()
})

test('calendar arrow navigation moves DOM focus and selects the next day', async ({ page }) => {
  await page.goto('/')
  const calendar = page.locator('#calendar')
  const selected = calendar.locator('button[data-selected-single="true"]')
  await selected.focus()
  await page.keyboard.press('ArrowRight')
  const focusedDay = await page.locator(':focus').getAttribute('data-day')
  expect(focusedDay).toBe('10/11/2026')
  await page.keyboard.press('Enter')
  await expect(calendar).toContainText('10/11/2026')
  await page.locator('#date-picker').getByRole('button').click()
  const popup = page.locator('[data-slot="popover-content"]')
  await popup.locator('button[data-selected-single="true"]').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page.locator('#date-picker')).toContainText('October 11th, 2026')
})

test('data table sorts real rows and exposes an explicit empty state', async ({ page }) => {
  await page.goto('/')
  const table = page.locator('#data-table')
  await table.getByRole('button', { name: 'Branch', exact: true }).click()
  await expect(table.locator('tbody tr').first()).toContainText('feature/quiet-graph')
  await table.getByRole('button', { name: /Branch/ }).click()
  await expect(table.locator('tbody tr').first()).toContainText('fix/focus-return')
  await table.getByRole('button', { name: 'Toggle empty results' }).click()
  await expect(table).toContainText('No results.')
})

test('independent Git states and scoped guarded local simulation', async ({ page }) => {
  await page.goto('/')
  const composition = page.locator('#git-compositions')
  await composition.getByRole('button', { name: 'Inspect #42', exact: true }).click()
  await expect(composition).toContainText('Checked out: main')
  await composition.getByRole('button', { name: 'Simulate checkout #43' }).click()
  await expect(composition).toContainText('inspected: PR #42')
  await expect(composition).toContainText('Checks: Unavailable')
  await composition
    .getByRole('textbox', { name: 'Local review reply' })
    .fill('Preserve independent states.')
  await composition.getByRole('button', { name: 'Add local reply' }).click()
  await expect(composition).toContainText('Preserve independent states.')
  await composition.getByRole('button', { name: 'Capture local deletion preview' }).click()
  await composition.getByRole('button', { name: 'Review destructive simulation' }).click()
  await expect(page.getByRole('button', { name: 'Simulate deletion', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: 'Confirmation', exact: true }).fill('DELETE')
  await page.getByRole('button', { name: 'Simulate deletion', exact: true }).click()
  await expect(composition).toContainText(
    'Deletion simulated for #42 and #44 only. No Git operation performed.',
  )
})

test('theme overrides both system schemes and density changes rendered control dimensions', async ({
  page,
}) => {
  await page.goto('/')
  for (const system of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: system })
    for (const theme of ['Dark', 'Light', 'System']) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).click()
      await page.getByRole('option', { name: theme, exact: true }).click()
      const expected = theme === 'System' ? system : theme.toLowerCase()
      await expect(page.locator('html')).toHaveAttribute('data-gs-theme', expected)
      const native = await page
        .locator('#native-select select')
        .evaluate((node) => getComputedStyle(node).backgroundColor)
      expect(native === 'rgba(0, 0, 0, 0)').toBe(expected === 'light')
      await expect(page.locator('#chart .recharts-bar-rectangle path').first()).toHaveCSS(
        'fill',
        expected === 'dark' ? 'rgb(127, 164, 240)' : 'rgb(49, 85, 166)',
      )
    }
    // Shared consumers may preserve the raw System state rather than resolve it in React.
    await page.evaluate(() => {
      document.documentElement.dataset.gsTheme = 'system'
    })
    await expect(page.locator('#chart .recharts-bar-rectangle path').first()).toHaveCSS(
      'fill',
      system === 'dark' ? 'rgb(127, 164, 240)' : 'rgb(49, 85, 166)',
    )
  }
  const input = page.getByRole('textbox', { name: 'Search branches', exact: true })
  const standard = (await input.boundingBox())!.height
  await page.getByRole('combobox', { name: 'Density', exact: true }).click()
  await page.getByRole('option', { name: 'Compact', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-gs-density', 'compact')
  expect((await input.boundingBox())!.height).toBeLessThan(standard)
})

test('narrow long content and 200-percent CSS-viewport reflow retain reachable actions', async ({
  page,
}) => {
  await page.goto('/')
  // A 1280x900 browser window at 200% zoom has a 640x450 CSS viewport.
  // This proves zoom-equivalent reflow, not native browser chrome zoom.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 640, height: 450 },
  ]) {
    await page.setViewportSize(viewport)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const checkout = page.getByRole('button', { name: 'Simulate checkout #44' })
    await checkout.scrollIntoViewIfNeeded()
    const box = (await checkout.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await checkout.click()
    await expect(page.locator('#git-compositions')).toContainText('Checked out: fix/long-ref-name')
    await page.getByRole('button', { name: 'Open inspection dialog' }).click()
    const close = page.getByRole('button', { name: 'Close inspection', exact: true })
    await expect(close).toBeInViewport()
    await close.click()
  }
  expect(
    await page
      .locator('[data-slot="spinner"]')
      .first()
      .evaluate((node) => parseFloat(getComputedStyle(node).animationDuration)),
  ).toBeLessThanOrEqual(0.001)
})

test('automated accessibility and measured essential boundaries and focus contrast in both themes', async ({
  page,
}) => {
  await page.goto('/')
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.gsTheme = theme
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }, theme)
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([])
    for (const locator of [
      page.getByRole('textbox', { name: 'Search branches', exact: true }),
      page.locator('#checkbox').getByRole('checkbox').first(),
      page.getByRole('combobox', { name: 'Branch filter' }),
    ]) {
      const boundary = await contrast(locator, 'borderTopColor')
      expect(boundary.width).toBeGreaterThanOrEqual(1)
      expect(boundary.ratio).toBeGreaterThanOrEqual(3)
      await expectFocusContrast(locator)
    }
    await expectFocusContrast(page.getByRole('button', { name: 'Tab here to inspect focus' }))
    await page.getByRole('button', { name: 'Branch actions', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    const menu = page.locator('[data-slot="dropdown-menu-content"]')
    expect((await contrast(menu, 'borderTopColor')).ratio).toBeGreaterThanOrEqual(3)
    await expectFocusContrast(page.getByRole('menuitem', { name: 'Inspect branch', exact: true }))
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open inspection dialog' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Branch inspection' })
    expect((await contrast(dialog, 'borderTopColor')).ratio).toBeGreaterThanOrEqual(3)
    await expectFocusContrast(dialog.getByRole('textbox', { name: 'Ref', exact: true }))
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([])
    await page.keyboard.press('Escape')
  }
})

for (const theme of ['light', 'dark'])
  test(`representative ${theme} visual baseline @visual`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate((theme) => {
      document.documentElement.dataset.gsTheme = theme
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }, theme)
    await page.locator('#git-compositions').scrollIntoViewIfNeeded()
    await expect(page.locator('#git-compositions')).toHaveScreenshot(
      `git-compositions-${theme}.png`,
      { animations: 'disabled' },
    )
    await page.getByRole('textbox', { name: 'Search components' }).fill('Button')
    await expect(page.locator('#button')).toHaveScreenshot(`button-${theme}.png`, {
      animations: 'disabled',
    })
  })

test('attachment supported states retry removal and bubble variants are live', async ({ page }) => {
  await page.goto('/')
  const attachment = page.locator('#attachment')
  for (const state of ['idle', 'uploading', 'processing', 'error', 'done']) {
    await attachment.getByRole('combobox', { name: 'Attachment state' }).click()
    await page.getByRole('option', { name: state, exact: true }).click()
    await expect(attachment.locator('[data-slot="attachment"]')).toHaveAttribute(
      'data-state',
      state,
    )
    await expect(attachment.locator('[data-slot="attachment"]')).toHaveAttribute(
      'aria-busy',
      String(['uploading', 'processing'].includes(state)),
    )
  }
  await attachment.getByRole('combobox', { name: 'Attachment state' }).click()
  await page.getByRole('option', { name: 'error', exact: true }).click()
  await attachment.getByRole('button', { name: 'Retry locally' }).click()
  await expect(attachment.locator('[data-slot="attachment"]')).toHaveAttribute(
    'data-state',
    'uploading',
  )
  await attachment.getByRole('button', { name: 'Remove local attachment' }).click()
  await expect(attachment).toContainText('Example attachment removed locally.')
  await attachment.getByRole('button', { name: 'Restore attachment' }).click()
  await expect(attachment.locator('[data-slot="attachment"]')).toBeVisible()
  const bubbles = page.locator('#bubble [data-slot="bubble"]')
  expect(
    await bubbles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-variant'))),
  ).toEqual(['default', 'secondary', 'muted', 'tinted', 'outline', 'ghost', 'destructive'])
  await page.locator('#bubble').getByRole('button', { name: 'Align bubbles to end' }).click()
  for (const bubble of await bubbles.all())
    await expect(bubble).toHaveAttribute('data-align', 'end')
})

test('sidebar collapse and spinner active and reduced-motion states are real', async ({ page }) => {
  await page.goto('/')
  const sidebar = page.locator('#sidebar [data-slot="sidebar"]').first()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await page
    .locator('#sidebar')
    .getByRole('button', { name: 'Toggle Sidebar', exact: true })
    .click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await page.keyboard.press('Control+b')
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const spinner = page.locator('#spinner [data-slot="spinner"]')
  expect(await spinner.evaluate((node) => getComputedStyle(node).animationName)).toBe('spin')
  expect(
    await spinner.evaluate((node) => parseFloat(getComputedStyle(node).animationDuration)),
  ).toBeGreaterThan(0.1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await spinner.evaluate((node) => parseFloat(getComputedStyle(node).animationDuration)),
  ).toBeLessThanOrEqual(0.001)
  await expect(page.locator('#spinner')).toContainText('Loading local example facts')
})
