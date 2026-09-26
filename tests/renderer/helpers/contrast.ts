import { expect, type Locator, type Page } from '@playwright/test'
import { settle } from './gallery'

export interface ContrastMeasurement {
  selector: string
  textSample: string
  foregroundColor: string
  backgroundColor: string
  fontSizePx: number
  fontWeight: number
  isLargeText: boolean
  ratio: number
  requiredRatio: number
  passes: boolean
}

export interface FocusContrastMeasurement {
  selector: string
  ringColor: string
  adjacentBackground: string
  ratio: number
  requiredRatio: number
  passes: boolean
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

interface ContrastInternal {
  parseRgba: (colorStr: string) => { r: number; g: number; b: number; a: number }
  composite: (
    fg: { r: number; g: number; b: number; a: number },
    bg: { r: number; g: number; b: number; a: number },
  ) => { r: number; g: number; b: number; a: number }
  contrastRatio: (
    colorA: { r: number; g: number; b: number; a: number },
    colorB: { r: number; g: number; b: number; a: number },
  ) => number
  getEffectiveBackground: (el: Element) => { r: number; g: number; b: number; a: number }
}

interface ContrastWindow extends Window {
  __gitStacksContrast?: ContrastInternal
}

/**
 * Injected script that computes real adjacent rendered background colors
 * by walking ancestors and compositing alpha layers up to the canvas.
 */
const EVALUATE_CONTRAST_SCRIPT = `
(() => {
  function parseRgba(colorStr) {
    if (!colorStr || colorStr === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const match = colorStr.match(/rgba?\\((\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*[,/]\\s*([\\d.]+))?\\)/);
    if (match) {
      return {
        r: parseInt(match[1], 10),
        g: parseInt(match[2], 10),
        b: parseInt(match[3], 10),
        a: match[4] !== undefined ? parseFloat(match[4]) : 1,
      };
    }
    throw new Error('Unsupported computed color: ' + colorStr);
  }

  function composite(fg, bg) {
    const alpha = fg.a + bg.a * (1 - fg.a);
    if (alpha === 0) return { r: 255, g: 255, b: 255, a: 1 };
    return {
      r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / alpha),
      g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / alpha),
      b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / alpha),
      a: alpha,
    };
  }

  function sRgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(rgb) {
    return 0.2126 * sRgbToLinear(rgb.r) + 0.7152 * sRgbToLinear(rgb.g) + 0.0722 * sRgbToLinear(rgb.b);
  }

  function contrastRatio(colorA, colorB) {
    const l1 = relativeLuminance(colorA);
    const l2 = relativeLuminance(colorB);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBackground(el) {
    let current = el;
    let bg = { r: 255, g: 255, b: 255, a: 0 };
    while (current) {
      const style = window.getComputedStyle(current);
      const parsed = parseRgba(style.backgroundColor);
      if (parsed.a > 0) {
        bg = composite(bg, parsed);
        if (bg.a >= 0.99) break;
      }
      current = current.parentElement;
    }
    return composite(bg, { r: 255, g: 255, b: 255, a: 1 });
  }

  window.__gitStacksContrast = {
    parseRgba,
    composite,
    contrastRatio,
    getEffectiveBackground,
  };
})()
`

/**
 * Measures text contrast against the real adjacent rendered background for a given selector.
 */
export async function measureElementContrast(
  page: Page,
  selector: string,
): Promise<ContrastMeasurement | null> {
  await page.evaluate(EVALUATE_CONTRAST_SCRIPT)

  return page.evaluate((sel) => {
    const win = window as ContrastWindow
    const contrast = win.__gitStacksContrast
    if (!contrast) throw new Error('Contrast evaluator was not installed')

    const el = document.querySelector(sel)
    if (!el || !el.getClientRects().length)
      throw new Error(`Missing visible contrast target: ${sel}`)

    const style = window.getComputedStyle(el)
    const fgParsed = contrast.parseRgba(style.color)
    const effectiveBg = contrast.getEffectiveBackground(el)
    const effectiveFg = contrast.composite(fgParsed, effectiveBg)

    const ratio = contrast.contrastRatio(effectiveFg, effectiveBg)
    const fontSizePx = parseFloat(style.fontSize) || 14
    const fontWeight = parseInt(style.fontWeight, 10) || 400
    const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)
    const requiredRatio = isLargeText ? 3.0 : 4.5

    return {
      selector: sel,
      textSample: (el.textContent || '').trim().slice(0, 40),
      foregroundColor: `rgb(${effectiveFg.r}, ${effectiveFg.g}, ${effectiveFg.b})`,
      backgroundColor: `rgb(${effectiveBg.r}, ${effectiveBg.g}, ${effectiveBg.b})`,
      fontSizePx,
      fontWeight,
      isLargeText,
      ratio: Math.round(ratio * 100) / 100,
      requiredRatio,
      passes: ratio >= requiredRatio,
    }
  }, selector)
}

/**
 * Scans a list of selectors on the page and returns all contrast measurements.
 */
export async function scanElementsContrast(
  page: Page,
  selectors: readonly string[],
): Promise<ContrastMeasurement[]> {
  await page.evaluate(EVALUATE_CONTRAST_SCRIPT)

  const results: ContrastMeasurement[] = []
  for (const selector of selectors) {
    const measurement = await measureElementContrast(page, selector)
    if (measurement) {
      results.push(measurement)
    }
  }
  return results
}

/**
 * Measures the focus ring / focus indicator contrast of an element against its adjacent background.
 */
export async function measureFocusIndicatorContrast(
  page: Page,
  locator: Locator,
): Promise<FocusContrastMeasurement | null> {
  await page.evaluate(EVALUATE_CONTRAST_SCRIPT)
  await page.keyboard.press('Tab')
  await locator.focus()
  await settle(page)

  return locator.evaluate((el) => {
    const win = window as ContrastWindow
    const contrast = win.__gitStacksContrast
    if (!contrast) throw new Error('Contrast evaluator was not installed')

    const style = window.getComputedStyle(el)
    if (!el.matches(':focus-visible')) throw new Error('Target has no visible keyboard focus')
    const effectiveBg = contrast.getEffectiveBackground(el.parentElement ?? el)
    let ringParsed: Rgba | undefined

    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
      ringParsed = contrast.parseRgba(style.outlineColor)
    } else {
      // Ignore transparent placeholder shadows and the inner white ring offset.
      // The outermost zero-blur spread is the actual focus ring in shared controls.
      const shadows = style.boxShadow.split(/,(?![^()]*\))/)
      let outerSpread = 0
      for (const shadow of shadows) {
        if (shadow.includes('inset')) continue
        const color = shadow.match(/rgba?\([^)]+\)/)?.[0]
        if (!color) continue
        const parsed = contrast.parseRgba(color)
        const lengths =
          shadow
            .replace(color, '')
            .match(/-?[\d.]+px/g)
            ?.map(parseFloat) ?? []
        const [x, y, blur, spread = 0] = lengths
        if (parsed.a > 0 && x === 0 && y === 0 && blur === 0 && spread > outerSpread) {
          ringParsed = parsed
          outerSpread = spread
        }
      }
    }
    if (!ringParsed || ringParsed.a === 0) throw new Error('No measurable visible focus indicator')

    const effectiveRing = contrast.composite(ringParsed, effectiveBg)
    const ratio = contrast.contrastRatio(effectiveRing, effectiveBg)

    return {
      selector: el.tagName.toLowerCase() + (el.className ? `.${el.className.split(' ')[0]}` : ''),
      ringColor: `rgb(${effectiveRing.r}, ${effectiveRing.g}, ${effectiveRing.b})`,
      adjacentBackground: `rgb(${effectiveBg.r}, ${effectiveBg.g}, ${effectiveBg.b})`,
      ratio: Math.round(ratio * 100) / 100,
      requiredRatio: 3.0,
      passes: ratio >= 3.0,
    }
  })
}

/**
 * Asserts all given measurements satisfy their required contrast ratios.
 */
export function assertContrast(
  measurements: readonly ContrastMeasurement[],
  contextName: string,
): void {
  expect(measurements.length, `No rendered contrast targets in ${contextName}`).toBeGreaterThan(0)
  const failures = measurements.filter((m) => !m.passes)
  if (failures.length > 0) {
    const details = failures
      .map(
        (f) =>
          `  - "${f.selector}" (${f.textSample || 'no text'}): ratio ${f.ratio}:1 < required ${f.requiredRatio}:1 (fg: ${f.foregroundColor}, bg: ${f.backgroundColor})`,
      )
      .join('\n')
    expect(
      failures,
      `Expected text contrast >= required in ${contextName}, but ${failures.length} element(s) failed:\n${details}`,
    ).toEqual([])
  }
}
