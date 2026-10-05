/**
 * The owned-CLI boundary for the whole test suite, installed before any
 * production module is loaded.
 *
 * The root suite reaches GitHub the way the app does — through `gh` — so without
 * this it resolves whatever `gh` is on the machine. That runs the developer's own
 * CLI, which reads their configuration and their keychain, against whatever host
 * a test names. This makes that impossible rather than merely unlikely: a request
 * for any `gh` this run did not install is answered exactly as an absent CLI
 * would be, and recorded.
 *
 * Ownership is declared, never assumed. One shared directory is created here and
 * admitted; a test that installs a CLI of its own admits the directory it wrote
 * that CLI into, through the same exported call, before the child runs. No
 * temporary directory, no home directory and no directory some other tool made
 * is admitted by being somewhere convenient, so a refusal is a refusal rather
 * than a coincidence of where a file landed. The guard is armed here rather than
 * left to a fixture, because a suite that silently ran the developer's own CLI
 * would be a worse failure than one that refused it.
 */
const { mkdtempSync, realpathSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const owned = mkdtempSync(join(tmpdir(), 'git-stacks-owned-gh-'))

// The CLI's own configuration is this run's, and empty: a keychain or a
// hosts.yml belonging to the person running the suite is never what these tests
// read, and no credential of theirs is passed on to a child.
process.env.GIT_STACKS_OWNED_GH_DIR = owned
process.env.GH_CONFIG_DIR = join(owned, 'config')
process.env.GITHUB_TOKEN = ''
process.env.GH_TOKEN = ''
process.env.GITHUB_ENTERPRISE_TOKEN = ''
process.env.GH_ENTERPRISE_TOKEN = ''

const fixture = require('../fixtures/isolated-desktop.cjs')

// The shared directory, admitted the same way any other is. `realpathSync` is
// called here as well as inside the admission so a directory that does not exist
// is a loud failure at the point that created the expectation, not a silently
// empty registry.
fixture.admitOwnedProviderCliRoot(realpathSync(owned))
fixture.installOwnedProviderCliBoundary(owned)

// The built-in ESM exports are re-synced from the patched CommonJS object, which
// is the only way to reach a binding that was handed out before the boundary was
// installed. The function lives on the `node:module` builtin; `process` has no
// such export, so a call through it would throw on every run and the re-sync
// these tests depend on would never happen.
const moduleBuiltin = require('node:module')
if (typeof moduleBuiltin.syncBuiltinESMExports === 'function') moduleBuiltin.syncBuiltinESMExports()
