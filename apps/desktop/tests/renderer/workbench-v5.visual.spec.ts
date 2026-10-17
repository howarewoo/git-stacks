import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const reference = resolve('tests/renderer/references/ui-243/git-stacks-workbench-v5.html')
const referenceHash = 'e46de09e3502ac917589b4fb1c2f3cb0419f2f9cadb899709bed5a5adc3e3db2'

for (const viewport of [
  { width: 1536, height: 1000 },
  { width: 1440, height: 940 },
]) {
  for (const theme of ['light', 'dark']) {
    test(`@visual v5 matched reference ${viewport.width}x${viewport.height} ${theme}`, async ({
      page,
      context,
    }, testInfo) => {
      expect(
        createHash('sha256')
          .update(await readFile(reference))
          .digest('hex'),
      ).toBe(referenceHash)
      await page.setViewportSize(viewport)
      await context.addInitScript((selectedTheme) => {
        localStorage.setItem('gs-workbench-v5:theme', JSON.stringify(selectedTheme))
        localStorage.setItem('gs-workbench-v5:density', JSON.stringify('compact'))
      }, theme)
      await page.goto(`/@fs${reference}`)
      await expect(page.locator('.lane-row.selected')).toContainText('feat/worktree-registry')
      await expect(page.locator('.ancestry-lines circle')).not.toHaveCount(0)
      const approved = await page.screenshot({
        path: testInfo.outputPath('v5.png'),
        animations: 'disabled',
      })
      await page.goto('/?scenario=shell-connected#/workbench-v5')
      await page.evaluate((selectedTheme) => {
        document.documentElement.dataset.gsTheme = selectedTheme
      }, theme)
      await expect(page.locator('html')).toHaveAttribute('data-gs-theme', theme)
      await expect(page.locator('.bw-main')).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(26, 31, 39)' : 'rgb(255, 255, 255)',
      )
      await expect(page.getByRole('heading', { name: 'Branches & worktrees' })).toBeVisible()
      await expect(page.locator('.bw-lane-row.bw-selected')).toContainText('feat/worktree-registry')
      await expect(page.locator('.bw-node')).toHaveCount(19)
      const geometry = await page.locator('.bw-shell').evaluate((shell) => {
        const panels = ['.bw-sidebar', '.bw-main', '.bw-inspector'].map((selector) => {
          const bounds = shell.querySelector(selector)!.getBoundingClientRect()
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        })
        return panels
      })
      expect(geometry.map((panel) => panel.width)).toEqual([224, viewport.width - 648, 376])
      expect(geometry.map((panel) => panel.y)).toEqual([64, 64, 64])
      const actual = await page.screenshot({
        path: testInfo.outputPath('react.png'),
        animations: 'disabled',
      })
      const evidence = await context.newPage()
      await evidence.setViewportSize({ width: viewport.width * 2, height: viewport.height })
      await evidence.setContent(
        `<style>html,body{margin:0}main{display:flex}img{display:block;width:${viewport.width}px;height:${viewport.height}px}</style><main><img alt="Immutable v5" src="data:image/png;base64,${approved.toString('base64')}"><img alt="Actual React consumer" src="data:image/png;base64,${actual.toString('base64')}"></main>`,
      )
      await evidence.screenshot({ path: testInfo.outputPath('side-by-side.png') })
      await evidence.setViewportSize(viewport)
      await evidence.setContent(
        `<style>html,body{margin:0}img{position:absolute;inset:0;width:${viewport.width}px;height:${viewport.height}px}img:last-child{opacity:.5}</style><img alt="Immutable v5" src="data:image/png;base64,${approved.toString('base64')}"><img alt="Actual React overlay" src="data:image/png;base64,${actual.toString('base64')}">`,
      )
      await evidence.screenshot({ path: testInfo.outputPath('overlay.png') })
      await evidence.close()
      for (const name of ['v5', 'react', 'side-by-side', 'overlay']) {
        await testInfo.attach(name, {
          path: testInfo.outputPath(`${name}.png`),
          contentType: 'image/png',
        })
      }
    })
  }
}
