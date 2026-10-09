import { expect, type Locator, type Page } from '@playwright/test'
import { measureElementContrast } from './contrast'

export interface ControlBorderReading {
  label: string
  borderColor: string
  adjacentBackground: string
  ratio: number
  requiredRatio: number
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

interface SharedContrastApi {
  parseRgba: (colorStr: string) => Rgba
  composite: (fg: Rgba, bg: Rgba) => Rgba
  contrastRatio: (a: Rgba, b: Rgba) => number
  getEffectiveBackground: (el: Element) => Rgba
}

/**
 * Measures each control's real rendered border against the real adjacent
 * background that `contrast.ts` resolves. Borders are read from computed
 * styles, so a control without a visible border fails instead of passing on an
 * invented colour.
 */
export async function measureControlBorders(
  page: Page,
  controls: readonly { label: string; locator: Locator }[],
): Promise<ControlBorderReading[]> {
  // Installs the shared contrast evaluator on the page.
  await measureElementContrast(page, 'body')

  return Promise.all(
    controls.map(async ({ label, locator }) => {
      const reading = await locator.evaluate((el) => {
        const api = (window as unknown as { __gitStacksContrast?: SharedContrastApi })
          .__gitStacksContrast
        if (!api) throw new Error('Contrast evaluator was not installed')

        const style = window.getComputedStyle(el)
        const sides = [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ].map(parseFloat)
        const colors = [
          style.borderTopColor,
          style.borderRightColor,
          style.borderBottomColor,
          style.borderLeftColor,
        ]

        let border: Rgba | null = null
        for (let index = 0; index < sides.length; index += 1) {
          if (sides[index] > 0) {
            border = api.parseRgba(colors[index])
            break
          }
        }
        if (!border || border.a === 0) {
          throw new Error('Control has no visible border to measure')
        }

        const background = api.getEffectiveBackground(el.parentElement ?? el)
        const effectiveBorder = api.composite(border, background)

        return {
          borderColor: `rgba(${effectiveBorder.r}, ${effectiveBorder.g}, ${effectiveBorder.b}, ${effectiveBorder.a})`,
          adjacentBackground: `rgba(${background.r}, ${background.g}, ${background.b}, ${background.a})`,
          ratio: Math.round(api.contrastRatio(effectiveBorder, background) * 100) / 100,
        }
      })

      return { label, ...reading, requiredRatio: 3 }
    }),
  )
}

export function assertControlBorderContrast(readings: readonly ControlBorderReading[]): void {
  const failures = readings
    .filter((reading) => reading.ratio < reading.requiredRatio)
    .map(
      (reading) =>
        `${reading.label}: ${reading.ratio}:1 (border ${reading.borderColor} on ${reading.adjacentBackground})`,
    )

  expect(
    failures,
    `Expected control border contrast >= 3:1, but ${failures.length} control(s) failed:\n${failures.join('\n')}`,
  ).toEqual([])
}
