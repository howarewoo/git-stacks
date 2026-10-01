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
  diff: ['command'],
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

