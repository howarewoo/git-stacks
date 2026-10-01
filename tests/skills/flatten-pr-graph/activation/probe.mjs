#!/usr/bin/env node
/**
 * Runs the activation scenarios against a real agent and records what it did.
 *
 * This is an explicit authoring evaluation, not part of the deterministic regression gate.
 * It spends model calls, its results vary between runs, and its evidence document is written
 * outside the repository: `npm run test:skills` never starts it.
 *
 * What makes the recording evidence rather than a guess:
 *
 *   - each scenario runs in its own disposable repository holding exactly one copy of the
 *     skill under test plus a fixture describing the selected pull requests. Nothing in the
 *     production repository is reachable from it, and there is no provider behind its pull
 *     requests.
 *   - the harness runs with structured output, so verdicts come from tool *calls* the agent
 *     made - which skill it loaded, which commands it ran - and never from prose that merely
 *     mentions the skill. The one exception is declared in the contract itself: whether the
 *     agent asked for a missing selection is only observable in what it said, and the
 *     structural guarantee that nothing changed is asserted alongside it.
 *   - the tool set stays whole, because "it wrote nothing" should be a fact about the agent
 *     rather than a fact about a harness that removed the tools. Approvals stay on, so a
 *     refused write still appears in the trace as an attempt, and an attempt is what this
 *     skill must never make for a merge, a close, a deletion, a control, or a check.
 *
 * When the harness cannot run - no `omp`, no configured endpoint - every scenario is recorded
 * `unverified` with the reason and the command exits non-zero. That is a blocker to report,
 * never a pass.
 *
 * Usage: node probe.mjs [--out <file>] [--only <scenarioId>]
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyToolCall, FIXTURE_METADATA, judgeTrace, SCENARIOS } from './scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../../..')
const CANONICAL_SKILL = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph')
const SESSION_MS = 180_000

/** One assistant text part of the final answer. */
function answerText(events) {
  return events
    .filter((event) => event?.type === 'message_end' && event.message?.role === 'assistant')
    .flatMap((event) => event.message.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** The tool calls the agent actually made, reduced to what the contract judges. */
function toolCalls(events) {
  const calls = []
  for (const event of events) {
    if (event?.type !== 'message_end') continue
    for (const part of event.message?.content ?? []) {
      if (
        part?.type === 'toolCall' ||
        part?.type === 'tool_use' ||
        part?.type === 'toolInvocation'
      ) {
        calls.push(
          classifyToolCall({
            name: part.name ?? part.toolName,
            input: part.arguments ?? part.input ?? part.args ?? {},
          }),
        )
      }
    }
  }
  return calls
}

function makeDisposableRepo(label) {
  const root = mkdtempSync(join(tmpdir(), `flatten-activation-${label}-`))
  mkdirSync(join(root, '.agents/skills'), { recursive: true })
  // One canonical copy of the skill under test, copied rather than linked so the run cannot
  // reach back into the repository it came from.
  cpSync(CANONICAL_SKILL, join(root, '.agents/skills/flatten-pr-graph'), { recursive: true })
  writeFileSync(
    join(root, '.agents/flatten-pr-graph-fixture.json'),
    `${JSON.stringify(FIXTURE_METADATA, null, 2)}\n`,
  )
  writeFileSync(
    join(root, 'README.md'),
    '# acme/widgets\n\nA disposable repository holding fake pull-request metadata for an activation probe.\n',
  )
  spawnSync('git', ['init', '--quiet', '--initial-branch', 'main', '.'], { cwd: root })
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

function runScenario(scenario) {
  let root
  try {
    root = makeDisposableRepo(scenario.id)
  } catch (error) {
    return {
      id: scenario.id,
      request: scenario.request,
      expected: scenario.expect,
      verdict: 'unverified',
      reason: `a disposable repository could not be created: ${error.message}`,
    }
  }
  const started = Date.now()
  try {
    const child = spawnSync(
      'omp',
      [
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--max-time',
        String(Math.floor(SESSION_MS / 1000) - 10),
        '--approval-mode',
        'always-ask',
        scenario.request,
      ],
      { cwd: root, encoding: 'utf8', timeout: SESSION_MS, maxBuffer: 64 * 1024 * 1024 },
    )
    const events = []
    for (const line of (child.stdout ?? '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // A non-JSON line is harness noise, not evidence, and is ignored on purpose.
      }
    }
    if (events.length === 0) {
      return {
        id: scenario.id,
        request: scenario.request,
        expected: scenario.expect,
        verdict: 'unverified',
        durationMs: Date.now() - started,
        reason: `the harness produced no structured events (exit ${child.status ?? 'none'}): ${(child.stderr ?? '').trim().slice(0, 300)}`,
      }
    }
    const calls = toolCalls(events)
    const judged = judgeTrace(calls, scenario)
    const answer = answerText(events)
    const problems = [...judged.problems]
    if (scenario.mustAskFor && !scenario.mustAskFor.test(answer)) {
      problems.push(`it never said what it needed: ${scenario.mustAskWhy}`)
    }
    return {
      id: scenario.id,
      covers: scenario.covers,
      request: scenario.request,
      expected: scenario.expect,
      observed: judged,
      verdict: problems.length === 0 ? 'pass' : 'fail',
      detail: problems.join('; ') || 'behaviour matches the activation contract',
      durationMs: Date.now() - started,
      answer: answer.slice(0, 1200),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf('--out')
  const out =
    outIndex !== -1 && typeof argv[outIndex + 1] === 'string'
      ? argv[outIndex + 1]
      : join(tmpdir(), `flatten-pr-graph-activation-${Date.now()}.json`)
  const onlyIndex = argv.indexOf('--only')
  const only =
    onlyIndex !== -1 && typeof argv[onlyIndex + 1] === 'string' ? argv[onlyIndex + 1] : null
  const version = spawnSync('omp', ['--version'], { encoding: 'utf8' })
  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.id === only) : SCENARIOS
  const results = scenarios.map(runScenario)
  const evidence = {
    harness: 'omp',
    version: (version.stdout ?? '').trim(),
    canonicalSkill: CANONICAL_SKILL,
    approvalMode: 'always-ask',
    recordedAt: new Date().toISOString(),
    note: 'Agent decisions observed from structured tool-call traces. Flattening correctness is covered by the fixtures and the oracle.',
    results,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        written: out,
        results: results.map((entry) => ({
          id: entry.id,
          verdict: entry.verdict,
          skillRead: entry.observed?.skillRead ?? null,
          detail: entry.detail ?? entry.reason,
        })),
      },
      null,
      2,
    )}\n`,
  )
  return results.every((entry) => entry.verdict === 'pass') ? 0 : 1
}

process.exit(main())
