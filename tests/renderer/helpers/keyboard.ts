import { expect, type Locator, type Page } from '@playwright/test'

export interface FocusedElementInfo {
  tagName: string
  id: string
  className: string
  role: string | null
  ariaLabel: string | null
  text: string
}

/**
 * Returns serializable metadata describing the currently active element.
 */
export async function getFocusedElementInfo(page: Page): Promise<FocusedElementInfo> {
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) {
      return {
        tagName: 'body',
        id: '',
        className: '',
        role: null,
        ariaLabel: null,
        text: '',
      }
    }
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className || '',
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      text: (el.textContent || '').trim().slice(0, 30),
    }
  })
}

/**
 * Verifies that focus is restored to a designated trigger element after an overlay (dialog or menu) closes.
 */
export async function assertFocusRestored(
  page: Page,
  expectedTrigger: Locator,
  actionDescription: string,
): Promise<void> {
  await expect(
    expectedTrigger,
    `Expected focus to return to trigger after ${actionDescription}`,
  ).toBeFocused({ timeout: 5_000 })
}

/**
 * Verifies APG modal dialog keyboard navigation:
 * 1. Focus starts inside the dialog.
 * 2. Tabbing forward cycles through focusable elements inside the dialog and wraps back to the top.
 * 3. Focus never escapes to the underlying background window (no keyboard trap to outside, modal containment).
 */
export async function assertModalDialogFocusTrap(
  page: Page,
  dialogLocator: Locator,
  dialogName: string,
): Promise<void> {
  await expect(dialogLocator).toBeVisible()

  // Verify currently focused element is inside the dialog
  const initialFocusInside = await dialogLocator.evaluate((dialogEl) => {
    return dialogEl.contains(document.activeElement)
  })
  expect(
    initialFocusInside,
    `Initial focus after opening "${dialogName}" must be inside the dialog`,
  ).toBe(true)

  // Tab forward 15 times; all visited activeElements must remain descendants of dialog
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    const isInside = await dialogLocator.evaluate((dialogEl) => {
      return dialogEl.contains(document.activeElement)
    })
    expect(
      isInside,
      `Tab step ${i + 1} escaped "${dialogName}" dialog containment to background`,
    ).toBe(true)
  }

  // Shift+Tab backward 10 times; must also remain inside dialog
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab')
    const isInside = await dialogLocator.evaluate((dialogEl) => {
      return dialogEl.contains(document.activeElement)
    })
    expect(isInside, `Shift+Tab step ${i + 1} escaped "${dialogName}" dialog containment`).toBe(
      true,
    )
  }
}
