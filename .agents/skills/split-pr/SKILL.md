---
name: split-pr
description: >
  Split one large GitHub pull request into a dependency-ordered stack of smaller,
  reviewable PRs without changing its final code. Use when asked to split a PR,
  break up a large PR, or turn one PR into reviewable stacked PRs.
---

# Split a PR into a stack

Use the supplied PR URL or number, or the current branch's PR when unambiguous.
Honor a requested size or number of layers. Otherwise aim for roughly 300 changed
handwritten lines per layer (additions plus deletions against its parent), as a
soft review budget, not a quota. One coherent review concern matters more than
line count. Count generated files, lockfiles, binaries, and pure moves separately;
they still belong in the stack and must be preserved.

An explicit execution request authorizes scoped branch creation, rewrites,
pushes, and PR edits for this split; loading the skill alone does not. A preview
or plan-only request is read-only: return the proposed layers without commits,
branches, pushes, or PR changes. Use ordinary Git and an authorized GitHub
integration such as `gh`; no Graphite dependency or desktop build is required.

## Inspect and plan

1. Read repository instructions. Resolve the exact open source PR, head repository,
   head branch/OID, current base branch/OID, draft state, and existing dependencies.
   Fetch the complete diff and history, not just commit titles or a truncated PR
   patch. Record the source head as `H` and its unique merge-base with the current
   PR base as `M`. Use that PR base, not an assumed default branch.
2. Inspect changes and semantic dependencies. Propose bottom-up layers with titles,
   purpose, files/hunks, estimated own-layer size, and verification. Keep behavior
   with its tests and required schema, manifest, lockfile, and generated changes.
   Separate mechanical refactors only when independently coherent. Existing
   commits are hints, not boundaries: split mixed commits or same-file hunks when
   necessary. Prefer the fewest coherent layers that meet the review budget;
   explain inseparable oversized layers rather than creating broken tiny PRs.
3. Preserve the original PR as the top layer to retain its number and conversation;
   create new lower layers. Identify existing child PRs before rewriting its head.
   Do not silently restack other PRs. Stop before writes when affected descendants,
   fork permissions/topology, ambiguous ancestry, or an unclear product decision
   prevent a safe in-scope split. Report a concrete alternative or needed decision.
   If already reviewable or no meaningful split exists, report that without churn.

## Build and verify locally

4. For execution, use an isolated, exclusively owned checkout and fresh scratch
   refs. Preserve other worktrees, indexes, uncommitted work, and branches; never
   switch, reset, clean, stash, or move a branch checked out in another worktree.
   Retain `H`, `M`, and the captured base OID in collision-safe local recovery refs
   before rewriting. Record the source PR's original metadata and each new ref.
5. Build the first layer from `M`, then each layer from its predecessor. Do not
   rebase onto a newer base tip as part of splitting: that is a separate operation
   and would change the equivalence target. Reuse coherent commits or reconstruct
   scoped commits from the original diff, preserving attribution. Resolve only
   decomposition conflicts; do not add features, unrelated fixes, or formatting.
   Every layer must be understandable and usable with its ancestors, without code
   from later layers. Keep existing merge semantics or stop rather than guessing.
6. Inspect every parent-to-child diff for scope, size, omissions, duplication, and
   dependencies on future layers. Discover and run relevant repository checks at
   the source baseline and each layer unless explicitly told to skip them. Fix
   split-induced breakage by revising boundaries, not weakening tests or changing
   the requested result. Report baseline failures and unavailable/skipped checks;
   never describe unverified layers as passing. Do not wait for CI or reviews.
7. Before publishing, prove ancestry and exact content preservation. `M` must be
   an ancestor of the first layer, and every subsequent layer must descend from
   its predecessor. Require the final tip's tree OID to equal `H`'s tree OID using
   `git rev-parse '<oid>^{tree}'` for both. This includes all tracked contents,
   deletions, file modes, symlinks, binaries, and submodule pointers, not just text
   or line totals. A mismatch blocks publication; inspect and correct the split.

## Publish and report

8. Recheck captured remote heads and PR bases before every affected publication
   write. External drift, enabled or unverifiable auto-merge, denied writes, or
   unsafe shared-ref ownership blocks publication; do not toggle auto-merge or
   bypass protections. Convert the original PR to draft and read back that state
   before changing its published head/base. Leave all resulting PRs as drafts.
9. Publish bottom-up with collision-safe new branch names. Create each lower PR
   with an explicit head and base: the original target for the first, then the
   preceding layer's branch. Finally publish the top layer on the original PR's
   branch and retarget that PR to its predecessor. A rewrite requires explicit
   `--force-with-lease=refs/heads/<branch>:<observed-remote-oid>`, never plain force
   or an implicit lease. Require new remote refs to be absent; do not overwrite
   name collisions. Preserve the original description, add an ordered stack map,
   and give each PR its own scope, verification, and dependency links. Do not copy
   whole-feature issue-closing keywords into partial layers.
10. Read back every published head, base, and draft state. Recheck the entire
    ancestry chain, each PR's own-layer diff, and the final tree equality against
    recorded `H`. Record created PRs and confirmed writes as you go. After an
    uncertain result, reconcile fresh state before retrying to avoid duplicates
    or overwriting external work. On partial failure, retain recovery refs and
    report what happened; never merge, close PRs, delete original branches, or
    claim an incomplete stack is finished.

Return the bottom-up PR/branch map, own-layer sizes and oversized exceptions,
verification results (including exact tree OIDs), original-head recovery ref,
and any blockers or remaining manual work. Distinguish a published draft stack
from CI-verified submission for review. Submission is a separate request.
