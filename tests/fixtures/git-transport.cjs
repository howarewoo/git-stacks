#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')

const args = process.argv.slice(2)
const realGit = process.env.GIT_STACKS_REAL_GIT || '/usr/bin/git'
const barePath = process.env.GIT_STACKS_FIXTURE_BARE
if (!barePath) {
  process.stderr.write('GIT_STACKS_FIXTURE_BARE is required\n')
  process.exit(2)
}

const transportCommands = new Set(['push', 'fetch', 'ls-remote'])
const valueOptions = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '-c',
  '--config-env',
])
let commandIndex = -1
for (let index = 0; index < args.length; index += 1) {
  const token = args[index]
  if (valueOptions.has(token)) {
    index += 1
    continue
  }
  if (transportCommands.has(token)) {
    commandIndex = index
    break
  }
}

function logCall(finalArgs) {
  const logPath = process.env.GIT_STACKS_TRANSPORT_LOG
  if (!logPath) return
  try {
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ argv: args, redirectedArgv: finalArgs, cwd: process.cwd() })}\n`,
      'utf8',
    )
  } catch {
    // Transport logging is diagnostic only and must never affect Git behavior.
  }
}

function positionalRemoteIndex() {
  if (commandIndex < 0) return -1
  let afterEnd = false
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    const token = args[index]
    if (!afterEnd && token === '--') {
      afterEnd = true
      continue
    }
    if (!afterEnd && token.startsWith('-')) {
      if (token === '--force-with-lease' || token === '--force-with-lease=') index += 1
      continue
    }
    return index
  }
  return -1
}

const redirected = [...args]
if (commandIndex >= 0) {
  const command = args[commandIndex]
  const remoteIndex = positionalRemoteIndex()
  const remote = remoteIndex >= 0 ? args[remoteIndex] : null
  const apparentUrl =
    typeof remote === 'string' &&
    /^https:\/\/github\.com\/acme\/widgets(?:\.git)?\/?$/iu.test(remote)
  const isOrigin = remote === 'origin'
  if (isOrigin || (command === 'fetch' && remoteIndex < 0)) {
    // Preserve remote.origin.url and remote.origin.pushurl for all ordinary
    // inspection commands while making transport use the owned bare repository.
    redirected.unshift('-c', `url.${barePath}.insteadOf=https://github.com/acme/widgets.git`)
  } else if (apparentUrl && remoteIndex >= 0) {
    redirected[remoteIndex] = barePath
  } else if (remoteIndex >= 0) {
    process.stderr.write(`fixture refuses unowned ${command} transport target ${String(remote)}\n`)
    process.exit(2)
  }
  logCall(redirected)
}

const result = spawnSync(realGit, redirected, {
  stdio: 'inherit',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})
if (result.error) {
  process.stderr.write(`${result.error.message}\n`)
  process.exit(1)
}
process.exit(typeof result.status === 'number' ? result.status : 1)
