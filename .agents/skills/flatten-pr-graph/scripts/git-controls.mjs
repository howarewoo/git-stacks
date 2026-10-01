/**
 * The executable controls Git is configured to run, shared by every helper of this skill
 * that writes or measures content in task-owned storage.
 *
 * Two facts have to be read together, and neither one alone is enough:
 *
 *   * A *configured* driver - `merge.<name>.driver`, `filter.<name>.clean|smudge|process`,
 *     `diff.<name>.command` - is a program Git will run. Task-owned storage does not
 *     confine it. The configuration can come from the repository itself, from a file it
 *     `include`s, from the user's global config, from the system config, or from
 *     `GIT_CONFIG_*` variables in the caller's environment, and the program it names can
 *     live anywhere on the machine. A clone with no `.git/config` entry still inherits all
 *     of those.
 *   * An *attributed* driver is one a `.gitattributes` entry assigns to a path this run
 *     would write. The attributes are read with Git, against a named tree, so the
 *     tracked entries of that tree, `$GIT_DIR/info/attributes`, and the configured global
 *     `core.attributesFile` are all consulted exactly as Git itself would consult them.
 *
 * A control is reported only where the two meet. A driver nobody configured cannot run;
 * a configured driver nobody attributes to a path this run touches never sees one. That
 * intersection is also why the configuration is read once in full rather than probed one
 * key at a time: a key that exists only in an included file, only in the global config,
 * or only in the environment is still a key this module has to see.
 *
 * A read that fails is itself a control. "No driver would run" is a claim, and a failed
 * read cannot support it, so an unreadable configuration or an unreadable set of tracked
 * attributes blocks rather than passing.
 *
 * Nothing here disables, overrides, or neutralises configuration. A blocking control is a
 * fact for the caller to stop on; silently turning the driver off would report a merge
 * this helper never performed.
 *
 * The `git` function is injected rather than imported so that every caller runs its
 * probes through the same environment, the same sanitisation, and the same timeout it
 * uses for the command being gated. A preflight that read a different configuration from
 * the command it admits would prove nothing.
 */

/**
 * The configuration keys that make a named driver runnable. A driver name is whatever
 * sits between the kind and the field, so a `diff` driver whose name contains a dot is
 * named the way Git names it rather than parsed apart.
 */
const DRIVER_FIELDS = {
  filter: ['clean', 'smudge', 'process'],
  merge: ['driver'],
  // `textconv` is here because an ordinary `git diff` runs it. A fingerprint computed from
  // the user's own worktree is such a diff, so leaving `textconv` out would let the read
  // itself execute a program the run never admitted.
  diff: ['command', 'textconv'],
}

function driverKeys(kind, name) {
  return DRIVER_FIELDS[kind].map((field) => `${kind}.${name}.${field}`)
}

/** `git config --list -z` writes `key\nvalue` per entry, entries separated by NUL. */
function configuredDrivers(git, cwd) {
  const listed = git(cwd, ['config', '--list', '-z'])
  if (!listed.ok) {
    return {
      ok: false,
      keys: new Map(),
      reason:
        (listed.stderr || listed.stdout).trim().slice(0, 200) ||
        `git config --list exited ${listed.status}`,
    }
  }
  const keys = new Map()
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue
    const newline = entry.indexOf('\n')
    if (newline === -1) continue
    keys.set(entry.slice(0, newline), entry.slice(newline + 1))
  }
  return { ok: true, keys, reason: null }
}

/**
 * `git check-attr -z --all --source <tree-ish>` writes `path`, `attribute`, `value` as
 * NUL-separated triples. The value is `set`, `unset`, `unspecified`, or the string the
 * attribute was given; only a driver that is actually active for the path is one Git
 * will run, so `unset` and `unspecified` are not controls.
 */
function attributedDrivers(git, cwd, source, paths) {
  const read = git(cwd, ['check-attr', '-z', '--all', '--source', source, '--', ...paths])
  if (!read.ok) {
    return {
      ok: false,
      found: [],
      reason:
        (read.stderr || read.stdout).trim().slice(0, 200) ||
        `git check-attr exited ${read.status}`,
    }
  }
  const fields = read.stdout.split('\0').filter(Boolean)
  const found = []
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [path, attribute, value] = [fields[index], fields[index + 1], fields[index + 2]]
    if (!DRIVER_FIELDS[attribute]) continue
    if (value === 'unspecified' || value === 'unset' || value === 'false') continue
    found.push({ path, attribute, value })
  }
  return { ok: true, found, reason: null }
}

/**
 * Every path a tree holds, so a control is admitted for all of it rather than for a
 * sample. A read that fails yields no paths, which the caller cannot mistake for a tree
 * that holds nothing: `git ls-tree` of an empty tree legitimately succeeds with no
 * output, so an empty list is only ever reached for a tree that really is empty.
 */
export function treePaths(git, cwd, treeish) {
  const result = git(cwd, ['ls-tree', '-r', '-z', '--name-only', treeish])
  return result.ok ? result.stdout.split('\0').filter(Boolean) : []
}

/**
 * The controls that apply to writing or measuring `paths` as they are attributed across
 * `sources`. `sources` are the tree-ish names the attributes are read from - the commits
 * a merge could take its attributes from, not only the newest one.
 *
 * Each control is `{ control, value, inTaskStorage, blocking, effect }`.
 */
export function attributedDriverControls(git, cwd, sources, paths) {
  const targets = [...new Set(paths.filter(Boolean))]
  if (targets.length === 0) return []

  const config = configuredDrivers(git, cwd)
  if (!config.ok) {
    return [
      {
        control: 'config.read',
        value: config.reason,
        inTaskStorage: 'inherited',
        blocking: true,
        effect:
          'the configuration Git would use for this run could not be read, so it cannot be claimed that no configured driver would run',
      },
    ]
  }

  const controls = []
  const seen = new Set()
  // `check-attr` is asked in chunks because a path list is passed as arguments, and an
  // argument list is not unbounded. The result is the same either way.
  const CHUNK = 256
  for (const source of sources) {
    for (let start = 0; start < targets.length; start += CHUNK) {
      const chunk = targets.slice(start, start + CHUNK)
      const attributes = attributedDrivers(git, cwd, source, chunk)
      if (!attributes.ok) {
        return [
          ...controls,
          {
            control: 'attributes.read',
            value: attributes.reason,
            inTaskStorage: 'not-copied',
            blocking: true,
            effect:
              'the tracked attributes for the paths this run would write could not be read, so it cannot be claimed that no driver would run',
          },
        ]
      }
      for (const { path, attribute, value } of attributes.found) {
        for (const key of driverKeys(attribute, value)) {
          const command = config.keys.get(key)
          if (command === undefined) continue
          const id = `${source}:${path}:${key}`
          if (seen.has(id)) continue
          seen.add(id)
          controls.push({
            control: key,
            value: `${path} -> ${command}`,
            inTaskStorage: 'inherited',
            blocking: true,
            effect:
              'a tracked attribute assigns this executable driver to a path this run would write; it may combine, rewrite, or discard content, so the run stops before it executes',
          })
        }
      }
    }
  }
  return controls
}

/**
 * Configuration keys that name a program Git runs as a side of talking to a remote, or
 * of recording a commit. Each is matched by shape rather than by an exact list, because
 * the list is not the point: the point is that a *configured value which is a command*
 * is a control, and this helper has no way to prove what it does.
 */
const EXECUTABLE_CONFIG = [
  {
    match: /^core\.sshcommand$/i,
    why: 'every ssh connection runs this command instead of ssh',
    when: 'ssh',
  },
  { match: /^core\.askpass$/i, why: 'a credential prompt runs this program', when: 'network' },
  {
    match: /^(credential|core\.credential)\.helper$/i,
    why: 'every credential lookup runs this helper',
    when: 'network',
  },
  {
    match: /^core\.hookspath$/i,
    why: 'every Git operation in this repository runs hooks from this directory',
    when: 'always',
  },
  {
    match: /^commit\.gpgsign$/i,
    why: 'every commit this repository makes is signed, and the signing program is not inherited',
    when: 'always',
  },
  { match: /^gpg\.(format|program)$/i, why: 'signing or verification runs this program', when: 'always' },
  {
    match: /^core\.fsmonitor$/i,
    why: 'git status and git diff run the filesystem monitor this names, or spawn Git\'s own daemon for it',
    when: 'always',
  },
  {
    match: /^protocol\..+\.allow$/i,
    why: 'this permits a custom transport helper, which is a program Git will execute',
    when: 'always',
  },
]

/**
 * Environment variables that name a program Git runs for the same reasons. `GIT_CONFIG_*`
 * is not here: those are configuration, and they are read through `git config --list` in
 * the caller's own environment rather than pattern-matched out of a variable list.
 */
const EXECUTABLE_ENV = [
  ['GIT_SSH_COMMAND', 'every ssh connection runs this command instead of ssh', 'ssh'],
  ['GIT_SSH', 'every ssh connection runs this program instead of ssh', 'ssh'],
  ['GIT_ASKPASS', 'a credential prompt runs this program', 'network'],
  ['SSH_ASKPASS', 'a credential prompt runs this program', 'network'],
  ['GIT_PROXY_COMMAND', 'every connection to the remote runs this program', 'network'],
]

/**
 * Whether a control can be reached at all. A credential helper or an ssh wrapper is a
 * real control over `https://` and `ssh://` and is never consulted for a local path, so
 * reporting it against a local disposable remote would be a false alarm wearing the
 * costume of a safety property.
 */
function applies(rule, transports) {
  if (rule.when === 'always') return true
  if (rule.when === 'ssh') return transports.has('ssh')
  return (
    transports.has('ssh') ||
    transports.has('https') ||
    transports.has('http') ||
    transports.has('git')
  )
}

function isEnabled(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'off'
}

/**
 * Every configured program that Git would execute as a side of reaching a remote or
 * recording a commit, read from the configuration and the environment the *caller*
 * supplied rather than from one this helper has already narrowed.
 *
 * That distinction is the whole point. A helper that strips `GIT_CONFIG_*` and
 * `GIT_SSH_COMMAND` before reading the configuration produces a clean report of a
 * configuration its own children no longer see - it has bypassed the control it was
 * supposed to be reporting, and it says so by omission. So the caller passes its real
 * environment, this reads what Git would really use, and an incompatible control is a
 * blocker the caller has to see. Nothing is unset and nothing is overridden here; the
 * alternative would be a run that quietly did the thing the control exists to prevent.
 *
 * `git(cwd, args, env)` is called with the environment explicitly, so a caller that runs
 * its children through a narrowed environment still gets a read of the wide one.
 */
export function executableControls(git, cwd, env = {}, transports = new Set()) {
  const controls = []
  const listed = git(cwd, ['config', '--list', '-z'], env)
  if (!listed.ok) {
    controls.push({
      control: 'config.read',
      value: (listed.stderr || listed.stdout).trim().slice(0, 200) || `git config --list exited ${listed.status}`,
      inTaskStorage: 'inherited',
      blocking: true,
      effect:
        'the effective configuration could not be read, so it cannot be claimed that no configured program would run',
    })
  } else {
    for (const entry of listed.stdout.split('\0')) {
      if (entry === '') continue
      const newline = entry.indexOf('\n')
      if (newline === -1) continue
      const key = entry.slice(0, newline)
      const value = entry.slice(newline + 1)
      const rule = EXECUTABLE_CONFIG.find((candidate) => candidate.match.test(key))
      if (!rule || !applies(rule, transports)) continue
      // Naming a control is not imposing it. `commit.gpgsign=false`, `core.fsmonitor=false`,
      // and a protocol permission set to deny all are the configurations in which the
      // program does not run; reporting those as an unrunnable executable would make the
      // report wrong in the safe direction, and would stop every run launched from a
      // repository that had deliberately turned the control off.
      if (!isEnabled(value)) continue
      controls.push({
        control: key,
        value,
        inTaskStorage: 'inherited',
        blocking: true,
        effect: `${rule.why}; this helper will not run it and will not override it, so it stops instead`,
      })
    }
  }
  for (const [name, why, when] of EXECUTABLE_ENV) {
    const value = env[name]
    if (value === undefined || value === '') continue
    if (!applies({ when }, transports)) continue
    controls.push({
      control: name,
      value: String(value).slice(0, 200),
      inTaskStorage: 'inherited',
      blocking: true,
      effect: `${why}; this helper will not run it and will not unset it, so it stops instead`,
    })
  }
  return controls
}

