'use strict'

const fs = require('node:fs')

const transportCommands = new Set(['push', 'fetch', 'ls-remote'])
const valueOptions = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--exec-path',
  '-c',
  '--config-env',
])

function transportCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (valueOptions.has(token)) {
      index += 1
      continue
    }
    if (transportCommands.has(token)) return index
  }
  return -1
}

function positionalRemoteIndex(args, commandIndex) {
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

function logCall({ logPath, argv, redirectedArgv, cwd }) {
  if (!logPath) return
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ argv, redirectedArgv, cwd })}\n`, 'utf8')
  } catch {
    // Transport logging is diagnostic only and must never affect Git behavior.
  }
}

/**
 * Plans the Git command line the GitHub harness runs for one Git Stacks command.
 * `remote.origin.url` and `remote.origin.pushurl` keep naming the GitHub
 * repository for every ordinary inspection command while transport itself is
 * redirected to the harness's own bare repository, and each transport call is
 * appended to the log the publication tests read.
 *
 * The plan is returned instead of executed because the harness runs it in the
 * test process: `child_process` cannot launch an extensionless shebang script or
 * a `.cmd` file on Windows without a shell, and a copy of the Node binary named
 * `git.exe` cannot carry Git's own argument forms, because Node rejects
 * `--literal-pathspecs` and friends before any preload runs.
 *
 * Returns `{ ok: true, args }` to run, or `{ ok: false, refused }` naming the
 * transport target this fixture will not touch.
 */
function planGitTransport({ args, barePath, logPath, cwd }) {
  if (typeof barePath !== 'string' || !barePath) {
    return { ok: false, refused: 'GIT_STACKS_FIXTURE_BARE is required' }
  }
  const commandIndex = transportCommandIndex(args)
  if (commandIndex < 0) return { ok: true, args: [...args] }

  const command = args[commandIndex]
  const remoteIndex = positionalRemoteIndex(args, commandIndex)
  const remote = remoteIndex >= 0 ? args[remoteIndex] : null
  const apparentUrl =
    typeof remote === 'string' &&
    /^https:\/\/github\.com\/acme\/widgets(?:\.git)?\/?$/iu.test(remote)
  const isOrigin = remote === 'origin'
  const redirected = [...args]
  if (isOrigin || (command === 'fetch' && remoteIndex < 0)) {
    redirected.unshift('-c', `url.${barePath}.insteadOf=https://github.com/acme/widgets.git`)
  } else if (apparentUrl && remoteIndex >= 0) {
    redirected[remoteIndex] = barePath
  } else if (remoteIndex >= 0) {
    return {
      ok: false,
      refused: `fixture refuses unowned ${command} transport target ${String(remote)}`,
    }
  }
  logCall({ logPath, argv: args, redirectedArgv: redirected, cwd })
  return { ok: true, args: redirected }
}

module.exports = { planGitTransport }
