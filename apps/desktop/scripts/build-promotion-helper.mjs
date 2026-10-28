#!/usr/bin/env node
// Build-time only: compile the atomic no-replace promotion helper for this host.
// Nothing is compiled at runtime, and a failed build removes the previous
// binary rather than leaving a stale one behind.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = join(root, 'native', 'promote-repository.c')
const outputDirectory = join(root, 'resources', 'promote')
if (process.platform !== 'darwin') throw new Error('The desktop helper supports macOS only.')
const output = join(outputDirectory, 'promote-repository')
/** Compilers tried in order, each with the flags its dialect needs. */
function candidates() {
  const posix = { prefix: ['-O2', '-std=gnu11', '-Wall', '-Wextra'], suffix: [] }
  const chosen = process.env.CC ? [{ command: process.env.CC, ...posix }] : []
  return [
    ...chosen,
    { command: 'cc', ...posix },
    { command: 'gcc', ...posix },
    { command: 'clang', ...posix },
  ]
}

function argumentsFor(candidate) {
  const outputs = ['-o', output]
  return [...candidate.prefix, source, ...outputs, ...candidate.suffix]
}

mkdirSync(outputDirectory, { recursive: true })
rmSync(output, { force: true })
const failures = []
for (const candidate of candidates()) {
  const result = spawnSync(candidate.command, argumentsFor(candidate), { stdio: 'pipe' })
  if (result.error) {
    failures.push(`${candidate.command}: ${result.error.message}`)
    continue
  }
  if (result.status !== 0) {
    failures.push(
      `${candidate.command}: ${(result.stderr ?? '').toString().trim() || `exit ${result.status}`}`,
    )
    continue
  }
  if (!existsSync(output)) {
    failures.push(`${candidate.command}: reported success but produced no binary`)
    continue
  }
  chmodSync(output, 0o755)
  console.log(`Built ${output.slice(root.length + 1)} with ${candidate.command}`)
  process.exit(0)
}
rmSync(output, { force: true })
throw new Error(
  `No usable C compiler for the promotion helper. Install one, or set CC. Tried:\n${failures.join('\n')}`,
)
