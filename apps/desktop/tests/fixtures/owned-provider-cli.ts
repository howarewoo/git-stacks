import { createRequire } from 'node:module'

/**
 * The boundary that decides which `gh` this run may start.
 *
 * The root suite reaches GitHub the way the app does — through `gh` — so without
 * a boundary it would resolve whatever `gh` is on the machine, reading that
 * person's configuration and credential store against whatever host a test
 * names. Fixtures install a CLI of their own and admit the directory it lives
 * in by name; the boundary then validates the exact file a request would start
 * against the roots this run registered, and refuses everything else. Nothing
 * else is admitted — not a temporary directory by construction, not a home
 * directory, not a name — so the machine's own CLI stays out of reach.
 *
 * It is asked for rather than reached into: the registry itself is not exported,
 * so a fixture cannot widen what this run may execute.
 */
interface OwnedCliBoundary {
  admitOwnedProviderCliRoot(directory: string): string
}

const require = createRequire(import.meta.url)
const { admitOwnedProviderCliRoot } = require('./isolated-desktop.cjs') as OwnedCliBoundary

export { admitOwnedProviderCliRoot }
