# Git Stacks

Git Stacks is an open-source, local-first desktop alternative to Graphite's
pull-request management for developers working with Git and GitHub. Its core
workflow is managing dependent changes as stacked pull requests: organizing
branches, publishing, reviewing, synchronizing, and landing changes without
requiring users to install or learn a new stack-management CLI.

The desktop app owns that workflow while repositories remain usable with ordinary
Git tools. Local changes, history, and stashes support the pull-request workflow.

This document describes the current product scope, not a new roadmap or a claim
that every platform or host capability has been verified.

## Core workflows

- **Open a repository:** add an existing local repository, drop a folder, or search
  accessible GitHub repositories and clone one. Adding a repository is read-only;
  cloning previews the terminal commands and refuses destination collisions.
- **Do local Git work:** navigate branches and ancestry, inspect and stage changes,
  commit, browse history, manage stashes, and resolve supported file conflicts.
  Local Git remains available when GitHub metadata cannot be read.
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
- **Configure the desktop:** choose Git runtime and GitHub host, sign in, adjust
  appearance and shortcuts, inspect diagnostics, preview support bundles, and use
  signed updates where supported.

Detailed behavior and limitations remain in the [README](README.md), including
[onboarding](README.md#onboarding), [stack synchronization](README.md#stack-synchronization-and-recovery),
[stack surgery](README.md#stack-surgery), and the [review workspace](README.md#review-workspace).

## Product constraints and boundaries

- Repositories remain ordinary Git repositories, interoperable with terminals,
  editors, and other Git clients. Opening one is not a conversion step, and the
  app does not configure the user's Git identity or credential helper.
- Core stack and pull-request management must be available in the desktop app
  without a new user-facing CLI dependency. Existing Git tools remain
  interoperable; terminal commands and optional `gh` integration are not the
  required path through the product.
- GitHub features address the repository's host with host-specific credentials
  and observed capabilities. Unavailable remote features must not imply that
  local Git is unavailable. See [GitHub hosts](README.md#github-hosts).
- Mutation scope and recovery matter more than implicit automation. Refresh and
  reconciliation reporting do not silently repair refs or pull-request bases;
  uncertain remote outcomes are not permission to replay a mutation.
- Large repositories use bounded reads and incremental presentation. A partial
  preview must not be presented as complete or authorize a bulk action over
  omitted data. Existing numerical budgets are owned by
  [`src/shared/performance.ts`](src/shared/performance.ts); see
  [Performance budgets](README.md#performance-budgets) for their measurement.
- The product is a desktop Git/GitHub workbench, not a mobile/web client or a CRM.
  The visual reference does not expand the runtime product scope.
- Packaging for a platform is not proof of update or verification parity. See
  [Platform support](README.md#platform-support) for the update matrix and
  [Packaged desktop smoke](README.md#packaged-desktop-smoke) for verification limits.

[DESIGN.md](DESIGN.md) owns interaction, visual, accessibility, and operation-safety
rules. [AGENTS.md](AGENTS.md) owns repository working instructions. Future scope
and new success criteria require explicit product decisions; this document does
not introduce them.
