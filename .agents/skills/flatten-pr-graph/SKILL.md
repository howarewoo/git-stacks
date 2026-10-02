---
name: flatten-pr-graph
description: >
  Put GitHub PRs into a single stack in dependency-respecting merge
  order, resolve merge conflicts, and ignore other checks.
---

# Flatten PR graph

Put the requested PRs into a single stack in optimal merge order.
Resolve merge conflicts. Ignore other checks.

Use the supplied PR list, or discover all open PRs in the current
repository when the user asks for all current PRs.

1. Inspect the PRs and Git history to understand their dependencies.
2. Choose an order that respects dependencies and minimizes expected
   conflict-resolution work.
3. Update the branches and PR bases to form that stack, resolving
   conflicts while preserving the intended changes.
4. Verify the resulting chain and report the order, conflicts resolved,
   and anything that remains blocked or incomplete.

Do not run, wait for, or fix CI, tests, lint, builds, or review checks.
Preserve unrelated work and respect repository protections.
Before each publication write, verify auto-merge is disabled for every
selected PR; stop and report a blocker if enabled or unverifiable.
Do not disable auto-merge yourself.
Do not merge the PRs into the root branch or close them.
Honor preview-only requests without publishing changes.
Stop rather than guess when a conflict requires an unclear product decision.
