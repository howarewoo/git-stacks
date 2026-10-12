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

“Applicable PR CI checks” means the CI jobs configured by the repository’s
workflows for that PR and its exact published head. It does not mean GitHub
branch-protection requirements, rulesets, review approvals, or merge eligibility.
Discover these checks from workflow definitions and current-head check
runs/statuses. All applicable CI checks must pass; an intentional conditional
skip is acceptable only when its workflow condition does not apply. Pending,
failing, or missing expected CI evidence blocks submission.

## Policy endpoints

Reading branch protections or rulesets is not a prerequisite. Their absence or a
read error does not block this workflow when repository workflows and current-head
CI evidence establish the applicable checks. Never change merge protections or
auto-merge.

## Establish scope and safety

Read repository instructions and verification commands. Resolve the URL to its
exact repository and open PR; verify the matching Git remote and authorized GitHub
capability. Discover native stack membership and dependency order when available.
Otherwise prove a unique complete chain from PR bases and Git ancestry, including
all descendants and ancestors to the target trunk. Branch names or a partial list
are not proof. Missing, ambiguous, inaccessible, foreign, or incomplete membership
blocks mutations; do not invent an order or silently process a subset.

Record bottom-to-top membership, PR URLs, branches, bases, remote heads, each old
layer boundary, intended own-layer and cumulative diffs, applicable PR CI checks, readiness,
and existing review requests. Top means most dependent PR. **Every processing pass
must be strictly bottom-up**, starting with the PR based on target trunk.

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
   obtain green status. Proven unrelated failures or actual investigation blockers
   are blockers, not permission to broaden scope. Commit only real scoped changes.

   **Do not classify a failure as unrelated merely because the failing files are
   unchanged, the changed-path tests pass, or the cause is not yet known. Unknown
   attribution requires continued investigation, not a blocker declaration.**

   Before stopping for an unrelated failure, establish evidence that its cause is
   independent of the stack’s changes. Check shared dependencies, concurrency,
   timing, resource contention, and test isolation where relevant.

   If investigation is genuinely blocked, identify the exact unavailable capability
   or evidence, the attempts made to obtain it, and why no authorized next step
   remains. “No scoped correction established” alone is not a valid stopping
   condition.
4. **Publish safely and read back.** Recheck auto-merge, head, base, and draft gates
   immediately before writing. Push only the selected branch; a rewrite requires
   explicit `--force-with-lease=refs/heads/<branch>:<observed-remote-head-oid>`.
   Never use an implicit lease or unconditional force. Independently verify exact
   remote head, expected predecessor/trunk base, and readiness. Unexpected or
   uncertain outcomes require fresh reads before retrying, not duplicate writes.
5. **Verify current-head CI and submit.** Require check evidence tied to the exact
   published head and applicable PR CI checks, not green results on an old OID.
   For checks gated on draft status, transition to ready only after local evidence
   and safe publication, then verify those checks on that head. On failure return
   to draft and independently confirm before the next head fix. Pending applicable
   PR CI checks are not ready: use bounded waits and report the pending blocker;
   never busy poll or call a draft-gated transition completed submission before checks pass.
   When checks permit, transition a draft to ready and independently confirm it.
   This readiness transition is submission. Preserve existing review requests;
   never invent a reviewer or duplicate requests. Use configured resubmission only
   when genuinely required. An unchanged ready PR needs no submission action.

Advance to a child only after its parent has completed rebasing, scoped fixes,
publication, exact-current-head CI verification, and independently confirmed
readiness. Do not wait for human **or automated review completion**: review
approval is not applicable PR CI check evidence. A blocked parent blocks its
descendants; never advance past an unsafe decision or process top-to-bottom.

## Reconcile and prove completion

External head/base drift stops processing; recovery refs do not authorize a retry.
Resume only after independently reconciling that drift and proving fresh complete
membership, current heads/bases, preserved external work, and each affected PR's
old own-layer boundary. If those facts cannot be proved, remain blocked.
Restart affected processing bottom-up, completing each parent before its child
under the same draft, lease, CI, and readiness gates. Replay only the proven own
layer onto the freshly fetched published parent; never overwrite external work.
Recovery and final-snapshot repairs must stay within a bounded convergence window;
continued drift or unsafe evidence blocks completion. No top-to-bottom pass is allowed.

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
