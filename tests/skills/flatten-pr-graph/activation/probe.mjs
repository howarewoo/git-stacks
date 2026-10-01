#!/usr/bin/env node
/**
 * Runs the activation scenarios against a real agent and records what it did.
 *
 * This is an explicit authoring evaluation, not part of the deterministic regression gate.
 * It spends model calls, its results vary between runs, and every artefact it writes lives
 * outside the repository.
 *
 * What the recording is, and what it is not:
 *
 *   - Each scenario runs in a disposable repository holding one copy of the skill under
 *     test plus a fixture describing the selected pull requests. That directory is
 *     disposable; it is **not** a sandbox. The agent runs with the full tool set and this
 *     shell's environment, so the only thing separating a run from the machine is the
 *     harness's own approval mode - a configuration, not an enforcement boundary, and no
 *     claim here rests on it.
 *   - Verdicts come from structured tool-call traces: which skill URI was read, which
 *     commands ran. Never from prose, except for the one case the contract itself declares,
 *     where asking for a missing selection is only observable in what the agent said.
 *   - A scenario only passes when the run actually completed: the child exited zero, the
 *     event stream ends with the harness's own terminal event, and the assistant messages
 *     name a provider and model. A timeout, a refused endpoint, a truncated stream, or a
 *     model that never answered is `unverified` with the reason, however promising the
 *     partial trace looked. An early skill read followed by a dead endpoint is not
 *     evidence of anything.
 *   - The classifier is a denylist over tool names and command text, not a complete oracle
 *     over what a process can do: an unfamiliar tool, a wrapper command, or an evaluation
 *     step can change state without matching a pattern. It bounds what these records
 *     *show*, and the enforced write boundary belongs to #89/#90. A clean trace shows that
 *     nothing recognisable was attempted; it is not proof that nothing happened.
 *   - For a `consult-then-decline` case the observable is the retrieval and the absence of
 *     recorded forbidden activity. Whether the agent's prose actually declines is not
 *     judged here. Only the one case whose contract declares asking for a missing
 *     selection is judged on text, and its record says so.
 *
 * Usage: node probe.mjs [--out <file>] [--only <scenarioId>]
 * Raw event streams land beside the evidence document as <out>.traces/<id>.turnN.jsonl,
 * and every record names them, so a verdict can be re-read against the raw stream.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyToolCall, FIXTURE_METADATA, judgeTrace, SCENARIOS } from './scenarios.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(HERE, '../../../..')
const CANONICAL_SKILL = join(REPOSITORY_ROOT, '.agents/skills/flatten-pr-graph')
const SESSION_MS = 180_000

/** The exact skill bytes a run was given, so merged evidence shows what changed. */
const SKILL_DIGEST = createHash('sha256')
  .update(readFileSync(join(CANONICAL_SKILL, 'SKILL.md')))
  .digest('hex')

/**
 * One process run. Everything needed to decide whether it completed is kept, because a
 * partial trace that reads like success is the failure mode this harness must not have.
 */
function runTurn(root, sessionDir, message, continueSession) {
  const started = Date.now()
  const child = spawnSync(
    'omp',
    [
      '--print',
      '--mode',
      'json',
      '--max-time',
      String(Math.floor(SESSION_MS / 1000) - 10),
      // Kept inside the disposable repository so the conversation it retains is retained
      // there and nowhere else.
      '--session-dir',
      sessionDir,
      ...(continueSession ? ['--continue'] : []),
      '--approval-mode',
      'always-ask',
      message,
    ],
    { cwd: root, encoding: 'utf8', timeout: SESSION_MS, maxBuffer: 64 * 1024 * 1024 },
  )
  const rawLines = (child.stdout ?? '').split('\n').filter((line) => line.trim().startsWith('{'))
  const events = []
  for (const line of rawLines) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // A non-JSON line is harness noise, not evidence, and is ignored on purpose.
    }
  }
  const assistants = events.filter(
    (event) => event?.type === 'message_end' && event.message?.role === 'assistant',
  )
  const session = events.find((event) => event?.type === 'session')
  const problems = []
  if (child.error) problems.push(`the harness could not start: ${child.error.message}`)
  if (child.status !== 0)
    problems.push(`the harness exited ${child.status ?? 'signal ' + child.signal}`)
  if (!events.some((event) => event?.type === 'agent_end')) {
    problems.push('the event stream never reached its terminal event')
  }
  if (assistants.length === 0) {
    problems.push('the assistant never answered')
  } else {
    const unidentified = assistants.filter(
      (event) => !event.message?.provider || !event.message?.model,
    )
    if (unidentified.length > 0) {
      problems.push(`${unidentified.length} assistant messages name no provider and model`)
    }
  }
  return {
    message,
    exitCode: child.status ?? null,
    signal: child.signal ?? null,
    durationMs: Date.now() - started,
    sessionId: session?.id ?? null,
    cwd: session?.cwd ?? null,
    models: [
      ...new Set(assistants.map((event) => `${event.message.provider}/${event.message.model}`)),
    ],
    events,
    raw: rawLines.join('\n'),
    stderr: (child.stderr ?? '').trim(),
    completion: problems.length === 0 ? 'complete' : 'incomplete',
    completionProblems: problems,
  }
}

/** The tool calls of one turn, reduced to what the contract judges. */
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

/** The assistant text of one turn, which only the declared case judges. */
function answerText(events) {
  return events
    .filter((event) => event?.type === 'message_end' && event.message?.role === 'assistant')
    .flatMap((event) => event.message.content ?? [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')
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

function runScenario(scenario, traceDir) {
  // Raw event streams are written before any judging, so a verdict can always be re-read
  // against what the harness actually emitted.
  const rawPath = (turnIndex) => join(traceDir, `${scenario.id}.turn${turnIndex + 1}.jsonl`)
  let root
  try {
    root = makeDisposableRepo(scenario.id)
  } catch (error) {
    return {
      id: scenario.id,
      skillDigest: SKILL_DIGEST,
      covers: scenario.covers,
      request: scenario.request ?? scenario.turns,
      expected: scenario.expect,
      verdict: 'unverified',
      reason: `a disposable repository could not be created: ${error.message}`,
    }
  }
  const sessionDir = join(root, '.omp-session')
  try {
    const messages = scenario.turns ?? [scenario.request]
    const turns = messages.map((message, index) => {
      const turn = runTurn(root, sessionDir, message, index > 0)
      writeFileSync(rawPath(index), `${turn.raw}\n`)
      return { ...turn, rawTrace: rawPath(index) }
    })
    const process = turns.map((turn) => ({
      exitCode: turn.exitCode,
      signal: turn.signal,
      durationMs: turn.durationMs,
      sessionId: turn.sessionId,
      models: turn.models,
      events: turn.events.length,
      rawTrace: turn.rawTrace,
      stderr: turn.stderr.slice(0, 400),
      toolCalls: toolCalls(turn.events).length,
    }))
    const incomplete = turns.filter((turn) => turn.completion !== 'complete')
    // A two-turn scenario is only a mid-conversation change if both turns are demonstrably
    // the same conversation.
    const sessions = new Set(turns.map((turn) => turn.sessionId))
    if (sessions.size !== 1 || turns.some((turn) => !turn.sessionId)) {
      incomplete.push({
        completion: 'incomplete',
        completionProblems: [
          `the turns did not share one session: ${[...sessions].join(', ') || 'none'}`,
        ],
      })
    }
    if (incomplete.length > 0) {
      return {
        id: scenario.id,
        skillDigest: SKILL_DIGEST,
        covers: scenario.covers,
        request: scenario.request ?? scenario.turns,
        expected: scenario.expect,
        verdict: 'unverified',
        reason: incomplete.flatMap((turn) => turn.completionProblems).join('; '),
        process,
      }
    }

    // Only the last turn carries the promise: the earlier turn asked for execution, so its
    // authorised work cannot be counted against a change that came after it.
    const judgedTurn = turns[turns.length - 1]
    const judged = judgeTrace(toolCalls(judgedTurn.events), scenario)
    const problems = [...judged.problems]
    const answer = answerText(judgedTurn.events)
    if (scenario.mustAskFor && !scenario.mustAskFor.test(answer)) {
      problems.push(`it never said what it needed: ${scenario.mustAskWhy}`)
    }
    return {
      id: scenario.id,
      skillDigest: SKILL_DIGEST,
      covers: scenario.covers,
      request: scenario.request ?? scenario.turns,
      expected: scenario.expect,
      observed: judged,
      process,
      verdict: problems.length === 0 ? 'pass' : 'fail',
      detail: problems.join('; ') || 'behaviour matches the activation contract',
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
  if (only) {
    const known = SCENARIOS.filter((scenario) => scenario.id === only)
    if (known.length === 0) {
      process.stderr.write(
        `unknown scenario ${JSON.stringify(only)}; known scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(', ')}\n`,
      )
      return 2
    }
  }
  const version = spawnSync('omp', ['--version'], { encoding: 'utf8' })
  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.id === only) : SCENARIOS
  const traceDir = `${out}.traces`
  mkdirSync(traceDir, { recursive: true })
  const results = scenarios.map((scenario) => {
    const result = runScenario(scenario, traceDir)
    writeFileSync(join(traceDir, `${scenario.id}.jsonl`), `${JSON.stringify(result, null, 2)}\n`)
    return result
  })
  const evidence = {
    harness: 'omp',
    version: (version.stdout ?? '').trim(),
    canonicalSkill: CANONICAL_SKILL,
    skillDigest: SKILL_DIGEST,
    approvalMode: 'always-ask',
    sandboxed: false,
    sandboxNote:
      'The disposable directory is not a sandbox: the run keeps the full tool set and this environment. Approval mode is harness configuration, not an enforcement boundary, and no verdict depends on it.',
    note: 'Agent decisions observed from structured tool-call traces of runs that completed. Flattening correctness is covered by the fixtures and the oracle.',
    traces: traceDir,
    results,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        written: out,
        traces: traceDir,
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
