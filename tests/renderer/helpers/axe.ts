import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export const STANDARD_AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export interface AxeCheckResult {
  violations: Array<{
    id: string
    impact: string | null
    description: string
    nodes: Array<{ html: string; target: string[]; failureSummary?: string }>
  }>
  incomplete: Array<{
    id: string
    impact: string | null
    description: string
    nodes: Array<{ html: string; target: string[]; reasons: string[] }>
  }>
}

/**
 * Runs an axe accessibility audit on the page or a scoped selector.
 */
export async function runAxeAudit(
  page: Page,
  options: {
    includeSelector?: string
    excludeSelector?: string
    tags?: string[]
    allRules?: boolean
  } = {},
): Promise<AxeCheckResult> {
  const { includeSelector, excludeSelector, tags = STANDARD_AXE_TAGS, allRules = false } = options

  let builder = new AxeBuilder({ page })
  if (!allRules) {
    builder = builder.withTags(tags)
  }
  if (includeSelector) {
    builder = builder.include(includeSelector)
  }
  if (excludeSelector) {
    builder = builder.exclude(excludeSelector)
  }

  const results = await builder.analyze()
  return {
    violations: results.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      description: v.description,
      nodes: v.nodes.map((n) => ({
        html: n.html,
        target: n.target.map(String),
        failureSummary: n.failureSummary,
      })),
    })),
    incomplete: results.incomplete.map((i) => ({
      id: i.id,
      impact: i.impact ?? null,
      description: i.description,
      nodes: i.nodes.map((n) => ({
        html: n.html,
        target: n.target.map(String),
        reasons: [...n.any, ...n.all, ...n.none].map((check) => check.message),
      })),
    })),
  }
}

/**
 * Asserts that the page or scoped element contains zero axe accessibility violations.
 * Formats failure summaries cleanly and records incomplete findings for documentation.
 */
export async function assertNoAxeViolations(
  page: Page,
  contextLabel: string,
  options: {
    includeSelector?: string
    excludeSelector?: string
    tags?: string[]
    allRules?: boolean
  } = {},
): Promise<{ incompleteCount: number }> {
  const results = await runAxeAudit(page, options)
  await test.info().attach(`axe-${contextLabel}`, {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  })
  expect(
    results.incomplete.filter((finding) => finding.id === 'aria-prohibited-attr'),
    `Named elements must expose a role that permits naming in "${contextLabel}"`,
  ).toEqual([])

  if (results.violations.length > 0) {
    const formatted = results.violations
      .map((v) => {
        const nodeSummaries = v.nodes
          .slice(0, 3)
          .map(
            (n) =>
              `  - target: ${n.target.join(' ')}\n    html: ${n.html}\n    summary: ${n.failureSummary ?? 'n/a'}`,
          )
          .join('\n')
        return `[${v.impact ?? 'unknown'}] ${v.id}: ${v.description}\n${nodeSummaries}`
      })
      .join('\n\n')

    expect(
      results.violations,
      `Expected zero accessibility violations in "${contextLabel}", but found ${results.violations.length}:\n${formatted}`,
    ).toEqual([])
  }

  return { incompleteCount: results.incomplete.length }
}
