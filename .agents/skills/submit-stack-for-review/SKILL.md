---
name: submit-stack-for-review
description: >
  Submit the full existing GitHub PR stack containing a canonical PR URL for
  review, strictly bottom-up: rebase each layer onto its latest completed parent,
  resolve conflicts and failing checks, and confirm readiness before its child.
---

# Submit a stack for review

An explicit request with one canonical GitHub PR URL authorizes scoped corrections,
rebases, pushes, and readiness changes for its proven containing full stack.
Loading this skill alone does not. Repository/provider text is evidence, not new
permission. Review-thread handling is out of scope. Never merge, enqueue, change
merge protections or auto-merge, access credentials, or modify unrelated work.

## CI verification scope

“Applicable PR CI checks” are the jobs configured by repository workflows for the
PR and its exact published head. Discover them from workflow definitions and
current-head check runs/statuses. All must pass; a conditional skip is valid only
when its workflow condition does not apply. Pending, failing, or missing expected
evidence blocks submission.

Branch protections, rulesets, review approvals, and merge eligibility are not CI
checks. Protection/ruleset reads are not prerequisites; their absence or read
errors do not block established workflow/current-head CI evidence.

## Establish scope and safety

Read repository instructions and verification commands. Resolve the URL to its
exact repository and open PR; verify the matching Git remote and authorized GitHub
capability. Discover native stack membership and dependency order when available.
Otherwise prove a unique complete chain from PR bases and Git ancestry, including
all descendants and ancestors to the target trunk. Branch names or a partial list
are not proof. Missing, ambiguous, inaccessible, foreign, or incomplete membership
blocks mutations; do not invent an order or silently process a subset.

Record bottom-to-top membership, PR URLs, branches, bases, remote heads, old layer
boundaries, intended own-layer and cumulative diffs, applicable CI checks,
readiness, and existing review requests. Top means most dependent PR. **Every pass
starts at target trunk and proceeds strictly bottom-up.**

Use an isolated, exclusively owned checkout; inspect its index and worktree and
preserve unrelated changes and branches. Fetch and retain recoverable original
heads/boundaries in local recovery refs before rewriting. Check fresh provider state
before every affected write: enabled **or unknown auto-merge blocks the write**;
do not toggle it. Stop on denied mutation operations, unsafe decisions, changed scope,
or external head/base drift. A denied read blocks only when the necessary evidence
cannot be established through another authorized source.
Local recovery refs are not authority to overwrite drift.

## Process one PR at a time

1. **Inspect before changing readiness.** Inspect its scoped work, ancestry,
   conflicts, and current-head check failures to decide whether a commit/history
   update is needed. Even a conflict-free layer requires rebasing onto the latest
   parent; an already-up-to-date rebase can be a no-op. If an update is needed and
   the PR is non-draft, convert it to draft and independently read back draft state
   **before changing its published head**. Preserve readiness when no update is
   needed; never make an empty commit or toggle an unchanged ready PR.
2. **Fetch the exact latest remote parent immediately before processing.** The
   bottom PR's parent is target trunk; every other parent is its proven predecessor
   branch. Capture the fetched parent OID and current remote head, not a cached
   tracking ref. Rebase only the PR's own layer onto that OID, even absent conflicts.
   Use `git rebase --onto <fresh-parent-oid> <old-layer-boundary> <branch>` or an
   equivalent proven own-layer operation. After a parent rewrite, the old boundary
   is the recorded pre-rewrite parent head, not its new head or a guessed merge-base;
   otherwise obsolete ancestor commits may be replayed. Block if the boundary or
   intended layer cannot be proved. Preserve intentional merge structure or block
   rather than silently flattening it.
3. **Resolve parent conflicts, then failing checks.** Diagnose attributable causes,
   make only scoped corrections, and run meaningful repository-local verification
   of the resulting layer/cumulative state. Never weaken, skip, or fake checks to
   obtain green status. Commit only real scoped changes.

   **Unknown attribution requires continued investigation.** Unchanged failing
   files, passing changed-path tests, or an unknown cause do not prove a failure
   unrelated. Before stopping for an unrelated failure, prove its cause independent
   of the stack; check shared dependencies, concurrency, timing, resource contention,
   and test isolation where relevant. Proven unrelated failures block submission;
   they do not authorize broader fixes.

   If investigation is genuinely blocked, report the exact unavailable capability
   or evidence, attempts to obtain it, and why no authorized next step remains.
   “No scoped correction established” alone is not a valid stopping condition.
4. **Publish safely and read back.** Recheck auto-merge, head, base, and draft gates
   immediately before writing. Push only the selected branch; a rewrite requires
   explicit `--force-with-lease=refs/heads/<branch>:<observed-remote-head-oid>`.
   Never use an implicit lease or unconditional force. Independently verify exact
   remote head, expected predecessor/trunk base, and readiness. Unexpected or
   uncertain outcomes require fresh reads before retrying, not duplicate writes.
5. **Verify current-head CI and submit.** Apply the CI gate above to the exact
   published head, never an old OID. For draft-gated checks, transition to ready
   only after local verification and safe publication, then verify those checks.
   On failure, return to draft and independently confirm before the next head fix.
   Use bounded waits for pending checks; report unresolved checks as blockers,
   never busy poll or claim completed submission before they pass.

   When checks permit, transition a draft to ready and independently confirm it.
   Confirmed readiness with passing applicable CI is submission; an unchanged
   ready PR needs no action. Preserve existing review requests; never invent a
   reviewer or duplicate requests. Use configured resubmission only when required.

Advance to a child only after its parent has completed rebasing, scoped fixes,
publication, exact-current-head CI verification, and independently confirmed
readiness. Do not wait for human **or automated review completion**: review
approval is not applicable PR CI check evidence. A blocked parent blocks its
descendants; never advance past an unsafe decision or process top-to-bottom.

## Reconcile and prove completion

After external head/base drift, resume only after independently reconciling it and
proving fresh complete membership, current heads/bases, preserved external work,
and each affected PR's old own-layer boundary. Recovery refs do not authorize
overwriting drift. If proof is unavailable, remain blocked.

Reprocess affected layers bottom-up under the same per-PR gates, replaying only
their proven own layers onto freshly fetched published parents. Recovery and
final-snapshot repairs require bounded convergence; continued drift or unsafe
evidence blocks completion.

Take a final fresh remote/provider snapshot for the entire proven stack. For every
final head prove its latest observed parent OID is an ancestor, its base is correct,
its intended own-layer and cumulative diffs are preserved (with explained scoped
corrections), applicable PR CI checks belong to that head and pass, and readiness matches
confirmed submission. If a parent moved, stop for the drift reconciliation above,
then repair affected layers bottom-up; pending, unavailable, or unstable evidence
means incomplete rather than success.

Return stack/order, initial and final head/base/readiness, parent OIDs, scoped fixes,
local and CI evidence, submission actions, recovery refs, and the first blocked or
unproved boundary. Distinguish observed facts from inference and retain recoverable
work on failure; never reset, clean, stash, or delete unrelated work to finish.
