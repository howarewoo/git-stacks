# Git Stacks

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers managing many branches and pull requests across many existing worktrees
and repositories, while developing in Orca, an editor, a terminal, or another
external tool.

## Product Purpose

Git Stacks is an open-source, local-first desktop workbench to organize, inspect,
review, synchronize, publish, and land branches and pull requests. Dependent
changes remain ordinary Git branches and GitHub pull requests; no new
stack-management CLI or Graphite dependency is required.

One Branches surface combines qualified branches with attached worktree context
and bottom-up dependency lanes. Selecting a branch, repository, or pull request
changes inspection, never a checkout. Existing-worktree discovery is primary;
creating a directory is a secondary, explicitly previewed workflow.

Development stays in external tools. Agent execution, launching or pausing agents,
agent approvals, model selection, terminals, and assumed Orca integration are
intentionally outside the product. Ordinary staging, commit, amend, discard,
development cherry-pick/revert, and stash-editing destinations are intentionally
removed from the unreleased UI; historical parity tickets do not reinstate them.
Local changes, history, and conflicts remain available as read-only inspection
with validated external-tool/path handoff. Operational recovery, including
supported continue/abort decisions, remains part of Git Stacks.

## Operating Context

The product is a local-first Electron desktop application with a React web-rendered
interface, not a browser or mobile client. The platform value describes its UI
technology, not its distribution or supported operating systems.

This document describes approved product scope, not verified platform or host
capabilities. [README.md](README.md#current-runtime) documents the runtime that
reads GitHub through the required GitHub CLI.

## Capabilities and Constraints

### Core workflows

- **Open a repository:** add an existing local repository, drop a folder, or search
  accessible GitHub repositories and clone one. Adding a repository is read-only;
  cloning previews the terminal commands and refuses destination collisions.
- **Inspect many worktrees:** discover and adopt existing directories read-only,
  inspect branch/worktree/ref identities, local changes and conflicts, unpublished
  commits, and committed history without switching checkouts. Detached, bare,
  missing, locked, partial, and unknown facts are explicit. Local inspection stays
  available when GitHub cannot answer.
- **Manage dependent changes:** create branch layers, preview restacks and stack
  synchronization, insert/move/remove layers, and recover interrupted operations.
- **Publish and reconcile stacks:** publish chained pull requests and use GitHub
  native stacks when the host supports them. Distinguish local parent hints from
  GitHub's submitted membership and order; offer explicit, previewed repairs when
  they disagree.
- **Review and land changes:** inspect pull-request checks and linked issues,
  review diffs and conversations, keep unsent review drafts, submit reviews, and
  merge the reviewed downstack scope. Report confirmed outcomes separately from
  pending or unconfirmed remote state.
- **Find work across repositories:** use sidebar-only pinned repositories and
  global search; retain each repository's selection, view, filters, folds and
  scroll context. Needs attention and Activity aggregate source-backed Git/PR
  facts across repositories, not agent liveness or permission requests.
- **Review separately from branches:** Pull requests is a list/review surface,
  never a second lane graph. A PR without a local branch or worktree remains
  reviewable, with durable authored drafts and operational recovery preserved.
- **Configure the desktop:** choose Git runtime and GitHub host, inspect the
  host's `gh` authentication as a read-only report, adjust appearance and
  shortcuts, inspect diagnostics, preview support bundles, and use signed updates
  where supported.

Detailed behavior and limitations remain in the [README](README.md), including
[onboarding](README.md#onboarding), [stack synchronization](README.md#stack-synchronization-and-recovery),
[stack surgery](README.md#stack-surgery), and the [review workspace](README.md#review-workspace).

### Product constraints and boundaries

- Repositories remain ordinary Git repositories, interoperable with terminals,
  editors, and other Git clients. Opening one is not a conversion step, and the
  app does not configure the user's Git identity or credential helper.
- GitHub collaboration requires an installed `gh` that can report
  `gh auth status --json hosts`, authenticated for the repository's host. It owns
  sign-in, credential storage, refresh, account switching, and logout; there is
  no app-owned GitHub App registration, device flow, primary credential vault,
  transport preference, or app-resolved token. The app reports the CLI's
  sanitized status for that host and shows the fixed host-scoped commands a
  person runs in their own terminal; it never runs a session-changing command
  — not `gh auth login`, `gh auth switch`, `gh auth logout`, or a credential
  helper write — because the CLI owns that session. It does run bounded
  read-only probes of the installed CLI: its version, its status for the host,
  and the API reads its own GitHub work needs, each under the same timeout and
  cancellation rules as any other read. Where a host is served by a provider the
  app was pointed at, that status is the provider's account rather than the
  selected host's public session, because that is the account its requests carry. Missing or rejected CLI authentication
  leaves local Git available. The desktop owns stack workflows without an
  additional stack-management CLI or Graphite dependency.
- GitHub features address the repository's host with host-specific credentials
  and observed capabilities. Unavailable remote features must not imply that
  local Git is unavailable. See [GitHub hosts](README.md#github-hosts).
- Mutation scope and recovery matter more than implicit automation. Refresh and
  reconciliation reporting do not silently repair refs or pull-request bases;
  uncertain remote outcomes are not permission to replay a mutation.
- Worktrees sharing a common Git directory share repository authority; independent
  clones of one remote do not. Remote metadata may be deduplicated without
  conflating local indexes, HEADs, directories, or mutation locks.
- Local cleanliness, conflicts, unpublished commits, PR lifecycle, checks,
  review, dependency/restack state, freshness, and capabilities are separate
  facts. Failed or truncated reads are not clean, passing, safe, or zero.
- A clean tree, filesystem activity, timestamps, and Git's administrative
  worktree lock do not establish external-tool inactivity or mutation safety.
  Scoped operations name exact directories/refs, revalidate captured state,
  preserve confirmation gates, leases and journals, and never implicitly stash
  or check out another worktree.
- Large repositories use bounded reads and incremental presentation. A partial
  preview must not be presented as complete or authorize a bulk action over
  omitted data. Existing numerical budgets are owned by
  [`packages/shared/src/performance.ts`](packages/shared/src/performance.ts); see
  [Performance budgets](README.md#performance-budgets) for their measurement.
  Lane/inspector/continuation/cache envelopes retain their original numerical
  limits under current surface names; complete inventories are not truncated to
  a mounted page. The shipped application does not include fixture/prototype
  routes or standalone staging/commit/stash/development controls.
- The product is a desktop Git/GitHub workbench, not a mobile/web client or a CRM.
  The visual reference does not expand the runtime product scope.
- Packaging for a platform is not proof of update or verification parity. See
  [Platform support](README.md#platform-support) for the update matrix and
  [Packaged desktop smoke](README.md#packaged-desktop-smoke) for verification limits.

### Future provider direction

GitLab may use the same authentication model through `glab`, but is not supported
or part of the GitHub cutover. Reuse the typed main-process boundary without a
speculative provider framework; GitHub-native stacks remain GitHub-specific.

[DESIGN.md](DESIGN.md) owns interaction, visual, accessibility, and operation-safety
rules. [AGENTS.md](AGENTS.md) owns repository working instructions. Future scope
and new success criteria require explicit product decisions; this document does
not introduce them.
