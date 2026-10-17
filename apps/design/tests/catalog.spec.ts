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

test('grouped foundations and brand home link preserve search, focus and history', async ({
  page,
}) => {
  await page.goto('/#typeset')
  await expect(page.locator('#typeset')).toBeInViewport()
  await expect(page.locator('.catalog-toolbar').getByRole('button', { name: 'Home' })).toHaveCount(
    0,
  )
  await page.getByRole('textbox', { name: 'Search components' }).fill('no such entry')
  await page.getByRole('link', { name: 'Git Stacks home', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Search components' })).toHaveValue('')
  await expect(page.locator('#home')).toBeFocused()
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
  await page.goBack()
  await expect(page.locator('#typeset')).toBeFocused()
  await page.goForward()
  await expect(page.locator('#home')).toBeFocused()
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
  await page.getByRole('textbox', { name: 'Search components' }).fill('no such entry')
  await page.getByRole('link', { name: 'Git Stacks home', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Search components' })).toHaveValue('')
  await expect(page.locator('#home')).toBeFocused()
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Browse components', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Component catalog', exact: true })
    .getByRole('link', { name: 'Typeset', exact: true })
    .click()
  await expect(page.locator('#typeset')).toBeFocused()
  await expect(
    page.getByRole('navigation', { name: 'Component catalog', exact: true }),
  ).toBeHidden()
  await page.getByRole('button', { name: 'Browse components', exact: true }).click()
  await page.locator('[data-mobile="true"]').getByRole('link', { name: 'Git Stacks home' }).click()
  await expect(
    page.getByRole('navigation', { name: 'Component catalog', exact: true }),
  ).toBeHidden()
  await expect(page.locator('#home')).toBeFocused()
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
  await expect(page.locator('.catalog-toolbar').getByRole('button', { name: 'Home' })).toHaveCount(
    0,
  )
  await page.goto('/#home')
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
})

test('Typeset themes, utilities, opt-out, wrapping and appends retain their contracts', async ({
  page,
}) => {
  await page.goto('/#typeset')
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.gsTheme = theme
    }, theme)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const result = await page.locator('[data-typeset-specimen]').evaluate((article) => {
        const prose = article.querySelector('p')!
        const utility = article.querySelector('[data-typeset-utility]')!
        const opted = article.querySelector('[data-typeset-optout] .typeset p')!
        const scroll = article.querySelector('.typeset-scroll')!
        article.style.setProperty('--typeset-font-mono', 'serif')
        for (const escape of ['class="not-typeset"', 'data-not-typeset']) {
          article.insertAdjacentHTML(
            'beforeend',
            `<div ${escape} data-optout-probe><div class="typeset"><h2>Untouched heading</h2><p>First</p><p>Second</p><code>plain code</code></div></div>`,
          )
        }
        const probeStyles = Array.from(article.querySelectorAll('[data-optout-probe]')).map(
          (probe) => ({
            heading: getComputedStyle(probe.querySelector('h2')!).fontSize,
            body: getComputedStyle(probe.querySelector('p')!).fontSize,
            paragraph: getComputedStyle(probe.querySelector('p + p')!).marginTop,
            code: getComputedStyle(probe.querySelector('code')!).backgroundColor,
          }),
        )
        const before = [prose, ...article.querySelectorAll('tr')].map((node) => ({
          top: node.getBoundingClientRect().top,
          margin: getComputedStyle(node).marginTop,
          border: getComputedStyle(node).borderBottomWidth,
        }))
        article.insertAdjacentHTML('beforeend', '<p>Appended block.</p>')
        article
          .querySelector('tbody')!
          .insertAdjacentHTML(
            'beforeend',
            '<tr><td>new branch</td><td>main</td><td>appended row</td></tr>',
          )
        const after = [prose, ...Array.from(article.querySelectorAll('tr')).slice(0, -1)].map(
          (node) => ({
            top: node.getBoundingClientRect().top,
            margin: getComputedStyle(node).marginTop,
            border: getComputedStyle(node).borderBottomWidth,
          }),
        )
        return {
          before,
          after,
          probeStyles,
          mono: getComputedStyle(article.querySelector('pre')!).fontFamily,
          utility: getComputedStyle(utility).fontSize,
          opted: getComputedStyle(opted).marginTop,
          proseSize: getComputedStyle(prose).fontSize,
          scroll: scroll.scrollWidth > scroll.clientWidth,
          fits: document.documentElement.scrollWidth <= innerWidth,
          color: getComputedStyle(prose).color,
        }
      })
      expect(result.after).toEqual(result.before)
      expect(result.utility).toBe('18px')
      expect(result.opted).toBe('0px')
      for (const probe of result.probeStyles) {
        expect(probe.paragraph).toBe('0px')
        expect(probe.code).toBe('rgba(0, 0, 0, 0)')
        expect(probe.heading).toBe(result.proseSize)
        expect(probe.body).toBe(result.proseSize)
      }
      expect(result.mono).toBe('serif')
      expect(result.fits).toBe(true)
      if (width === 390) expect(result.scroll).toBe(true)
      expect(result.color).not.toBe('rgba(0, 0, 0, 0)')
    }
  }
})

test('all specimens render independently without desktop bridge', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('#foundations dl').first()).toContainText('4px')
  await expect(page.locator('#foundations')).not.toContainText('{primitive.')
  expect(await page.evaluate(() => 'desktop' in window)).toBe(false)
  const ids = await page.locator('[id]').evaluateAll((nodes) => nodes.map((node) => node.id))
  expect(new Set(ids).size).toBe(ids.length)
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

test('Iconography navigation and labelled local controls support keyboard activation', async ({
  page,
}) => {
  await page.goto('/#iconography')
  const section = page.locator('#iconography')
  await expect(section).toBeInViewport()
  const navigation = page.getByRole('navigation', { name: 'Component catalog', exact: true })
  await expect(navigation.getByRole('link', { name: 'Iconography', exact: true })).toHaveAttribute(
    'href',
    '#iconography',
  )
  await page.getByRole('link', { name: 'Git Stacks home', exact: true }).click()
  await navigation.getByRole('link', { name: 'Iconography', exact: true }).click()
  await expect(section).toBeFocused()
  await page.goBack()
  await expect(page.locator('#home')).toBeFocused()
  await page.goForward()
  await expect(section).toBeFocused()
  await page.getByRole('textbox', { name: 'Search components' }).fill('Lucide')
  await expect(section).toBeVisible()
  await page.getByRole('textbox', { name: 'Search components' }).fill('')
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Find a component').fill('Iconography')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(section).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(section.getByRole('button', { name: 'Browse branches', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(section.getByRole('status')).toContainText('Branch example opened locally.')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const refresh = section.getByRole('button', { name: 'Refresh icon example', exact: true })
  await expect(refresh).toBeFocused()
  await page.keyboard.press('Space')
  await expect(section.getByRole('status')).toContainText('Refresh example completed locally.')
  for (const label of ['Refresh icon example', 'Close icon example']) {
    const target = await section.getByRole('button', { name: label, exact: true }).boundingBox()
    expect(target!.width).toBeGreaterThanOrEqual(44)
    expect(target!.height).toBeGreaterThanOrEqual(44)
  }
  await expect(section.locator('svg:not([aria-hidden=\"true\"])')).toHaveCount(0)
  for (const text of ['Success:', 'Warning:', 'Unavailable:', 'Unknown:']) {
    await expect(section).toContainText(text)
  }
  await expect(
    section.getByRole('link', { name: 'Browse the Lucide icon catalog (opens in a new tab)' }),
  ).toHaveAttribute('href', 'https://lucide.dev/icons/')
})

test('search presents results without stealing focus and restores the reading section on clear', async ({
  page,
}) => {
  await page.goto('/#field')
  const navigation = page.getByRole('navigation', { name: 'Component catalog', exact: true })
  await expect(navigation.locator('a[aria-current="location"]')).toHaveAttribute('href', '#field')
  const search = page.getByRole('textbox', { name: 'Search components' })
  const originalTop = await page
    .locator('#field')
    .evaluate((section) => section.getBoundingClientRect().top)
  for (const query of ['button', 'button group', 'no-such-component']) {
    await search.fill(query)
    await expect(search).toBeFocused()
    await expect(page.locator('#catalog-results')).toBeInViewport()
    await expect
      .poll(() =>
        page.locator('#catalog-results').evaluate((node) => {
          const top = node.getBoundingClientRect().top
          const toolbarBottom = document
            .querySelector('.catalog-toolbar')!
            .getBoundingClientRect().bottom
          return (
            top >= toolbarBottom &&
            Math.abs(top - parseFloat(getComputedStyle(node).scrollMarginTop)) < 2
          )
        }),
      )
      .toBe(true)
  }
  await search.fill('')
  await expect(search).toBeFocused()
  await expect
    .poll(async () =>
      Math.abs(
        (await page.locator('#field').evaluate((section) => section.getBoundingClientRect().top)) -
          originalTop,
      ),
    )
    .toBeLessThan(2)

  await search.fill('one-time password')
  await navigation.getByRole('link', { name: 'Input OTP', exact: true }).click()
  await expect(page.locator('#input-otp')).toBeFocused()
  await expect(page.locator('#input-otp')).toBeInViewport()
  await expect(page).toHaveURL(/#input-otp$/)
})

test('current section follows scrolling and filtered mounts without changing navigation history', async ({
  page,
}) => {
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: 'Component catalog', exact: true })
  const current = navigation.locator('a[aria-current="location"]')
  await navigation.getByRole('link', { name: 'Button', exact: true }).click()
  await navigation.getByRole('link', { name: 'Button Group', exact: true }).click()
  await expect(current).toHaveAttribute('href', '#button-group')
  await expect(page.locator('#button-group')).toBeFocused()
  const historyLength = await page.evaluate(() => history.length)
  await page.locator('#checkbox').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await expect(current).toHaveAttribute('href', '#checkbox')
  await expect(page).toHaveURL(/#button-group$/)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
  await page.goBack()
  await expect(page).toHaveURL(/#button$/)
  await expect(current).toHaveAttribute('href', '#button')
  await page.getByRole('textbox', { name: 'Search components' }).fill('one-time password')
  await page.locator('#input-otp').evaluate((section) => section.scrollIntoView({ block: 'start' }))
  await expect(current).toHaveAttribute('href', '#input-otp')
  await page.getByRole('textbox', { name: 'Search components' }).fill('no-such-component')
  await expect(current).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await navigation.getByRole('link', { name: 'Git compositions', exact: true }).click()
  await expect(current).toHaveAttribute('href', '#git-compositions')
  await expect(page.locator('#git-compositions')).toBeFocused()
})

test('inline command selection does not displace catalog arrival', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-specimen="command"]')).toBeAttached()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  const command = page.locator('#command')
  await command.getByPlaceholder('Search local commands').focus()
  await page.keyboard.press('Enter')
  await expect(command.locator('output')).toHaveText('Inspect branch')
})

test('narrow catalog navigation discloses links and transfers focus to the destination', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: 'Component catalog', exact: true })
  const browse = page.getByRole('button', { name: 'Browse components', exact: true })
  await expect(navigation).toBeHidden()
  await expect(browse).toBeInViewport()
  await browse.click()
  await expect(navigation).toBeVisible()
  await navigation.getByRole('link', { name: 'Button', exact: true }).click()
  await expect(page).toHaveURL(/#button$/)
  await expect(page.locator('#button')).toBeFocused()
  await expect(navigation).toBeHidden()
  await browse.click()
  await expect(navigation.getByRole('link', { name: 'Button', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  )
  await navigation.getByRole('link', { name: 'Tokens', exact: true }).click()
  await expect(page.locator('#foundations')).toBeFocused()
  await page.goBack()
  await browse.click()
  await expect(navigation.getByRole('link', { name: 'Button', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  )
})

test('vertical tabs use vertical arrows to navigate available views', async ({ page }) => {
  await page.goto('/')
  const tabs = page.getByRole('tablist', { name: 'vertical default repository views' })
  await tabs.getByRole('tab', { name: 'Changes', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(tabs.getByRole('tab', { name: 'Checks', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tabs.getByRole('tab', { name: 'Checks', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('ArrowUp')
  await expect(tabs.getByRole('tab', { name: 'Changes', exact: true })).toBeFocused()
})

test('vertical toggle groups use vertical arrows and activate the focused item', async ({
  page,
}) => {
  await page.goto('/')
  const group = page.getByRole('group', { name: 'vertical text formatting' })
  await group.getByRole('button', { name: 'Bold', exact: true }).focus()
  await page.keyboard.press('ArrowDown')
  const italic = group.getByRole('button', { name: 'Italic', exact: true })
  await expect(italic).toBeFocused()
  await page.keyboard.press('Space')
  await expect(italic).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(group.getByRole('button', { name: 'Bold', exact: true })).toBeFocused()
})

test('nested dialog popups receive pointer interaction above the modal', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open inspection dialog' }).click()
  const dialog = page.getByRole('dialog', { name: 'Branch inspection' })
  await dialog.getByRole('button', { name: 'Inspect nested scope' }).click()
  await page.getByRole('button', { name: 'Inspect scope locally', exact: true }).click()
  await expect(dialog.locator('output')).toHaveText('Nested scope inspected')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Nested branch', exact: true }).fill('main')
  await page.getByRole('option', { name: 'main', exact: true }).click()
  await expect(dialog.locator('output')).toHaveText('Nested branch: main')
  await dialog.getByText('Nested branch actions', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy nested ref', exact: true }).click()
  await expect(dialog.locator('output')).toHaveText('Nested ref copied locally')
  await expect(dialog).toBeVisible()
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
      await expect
        .poll(async () => {
          const native = await page
            .locator('#native-select select')
            .evaluate((node) => getComputedStyle(node).backgroundColor)
          return native === 'rgba(0, 0, 0, 0)'
        })
        .toBe(expected === 'light')
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
    // Reduced-motion color transitions still need a rendered frame before Axe reads surfaces.
    await page.waitForFunction(() => {
      const probe = document.createElement('div')
      const tokens = getComputedStyle(document.documentElement)
      probe.style.backgroundColor = tokens.getPropertyValue('--gs-semantic-surface-content').trim()
      probe.style.color = tokens.getPropertyValue('--gs-semantic-text-primary').trim()
      return (
        getComputedStyle(document.body).color === probe.style.color &&
        Array.from(document.querySelectorAll('.design-specimen:not([data-specimen="card"])')).every(
          (surface) =>
            !surface.checkVisibility() ||
            getComputedStyle(surface).backgroundColor === probe.style.backgroundColor,
        )
      )
    })
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
    await expectFocusContrast(page.getByRole('menuitem', { name: 'Inspect branch', exact: true }))
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open inspection dialog' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Branch inspection' })
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
    // Keep the tall specimen inside the viewport. Chromium's beyond-viewport
    // capture transiently resizes to 1×1, triggering responsive reflow.
    await page.setViewportSize({ width: 1280, height: 1600 })
    await page.goto('/')
    await page.evaluate((theme) => {
      document.documentElement.dataset.gsTheme = theme
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }, theme)
    // Isolated specimens must not capture unrelated sticky chrome over their own status text.
    await page.locator('.catalog-toolbar').evaluate((toolbar) => {
      toolbar.style.visibility = 'hidden'
    })
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
