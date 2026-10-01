# flatten-pr-graph local preparation (conditional)

**Scope:** what the agent does between an authorized order and a publication decision.
This file implements issue #87 and is the only place that states the preparation
procedure; it is a _conditional_ companion to `../SKILL.md`. Read it when the work
reaches local integration. It does not run by itself, it states nothing about what has
been executed, and it is not standing repository instruction.

The compact portable core is `../SKILL.md`; the immutable selection, root, and order come
from the plan; the pass/fail claims come from `oracle.md`. This reference adds the three
things the core cannot hold: how a conflict is decided, which structural cases are never
decided mechanically, and what a recoverable partial state looks like.

## 1. Before anything is integrated

1. Re-read the plan's selection, root id, and order. If the root branch moved, the run
   reports `rootAdvance` against the **pinned** id and stops; it never rebases the plan
   silently and never claims the newer root work is integrated.
2. Record the user's workspace fingerprint - branch, HEAD, status, staged diff, unstaged
   diff, untracked list, stash list, local config, identity - with read-only commands, and
   compare it again when preparation ends. Preparation runs in task-owned storage and
   task-owned clones; a difference in that fingerprint is a stop, not a cleanup.
3. If the run directory already holds a journal for the same selection, resume it. Never
   run a second preparation over one that is unfinished; never silently discard a partial
   state, and never stash, reset, clean, or checkout anything in the user's worktree.
4. Fetch nothing from a remote. The run copies the branches the plan pinned.

`scripts/prepare-stack.mjs` performs steps 1-4 as a deterministic helper: it owns
`<runDirectory>/storage.git`, `<runDirectory>/workspaces/<n>`, and
`<runDirectory>/journal.json`, and it never writes into the user's checkout, config, refs,
or stash list. Its `verification` array is read back from Git - ancestry, cumulative
containment, contributed-versus-prepared paths, `integrity.clean` - not from its own
claim fields.

## 2. Cumulative integration, position by position

For position 0 the base is the pinned root commit. For every later position the base is
the **prepared head of its predecessor**, not the predecessor's original head: the chain
must be re-executable, and a chain that restsacks onto the previous original head will not
restack again.

Each position ends in one of four real states, each recorded as itself:

| State        | What it means                                                                              | What the manifest says                                        |
| ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| integrated   | a merge commit carries the predecessor's prepared state and the pinned root into this head | `preparedHead` descends from the predecessor's `preparedHead` |
| fast-forward | this head already contains the base                                                        | `preparedHead` equals the original head                       |
| redundant    | the head is an object the predecessor already reaches                                      | equal commit ids recorded, branch identity kept               |
| blocked      | a conflict or an unsupported structure stops this position                                 | `continuation.resumeFrom`                                     |

No state is ever simulated with a placeholder commit, an empty merge, or a rewritten
author. If a position produces no new commit because Git found nothing to do, that is
recorded as `fast-forward` or `redundant`, never as a fabricated integration.

## 3. Deciding a conflict

The helper never chooses a side. It leaves the conflict in the workspace and reports, per
path: the merge base blob, our blob, their blob, both diffs, the conflict kind
(`content`, `add-add`, `delete/modify`, `rename/delete`, `file/directory`, `binary`,
`submodule`), and `needsDecision: true`.

Decide from evidence, in this order:

1. **State both sides.** Read our change and their change, and the merge base. "Ours" is
   the predecessor's prepared state, "theirs" is this pull request's contribution.
2. **Read the stated intent** of both: the pull request's own description, and what the
   commits claim to do. An intent the pull request never states is not reconstructed from
   the diff alone.
3. **Apply the rubric** in `contract.md` §10.2. S1-S6 are the questions a human reviewer
   answers; a resolution that cannot answer S5 (did an original commit survive intact?)
   and S6 (does the result claim more than the evidence supports?) is not a resolution.
4. **Record the decision** with the path, the resulting content, the intent it serves, and
   a reason. Then re-run preparation with the resolutions; the helper applies them to the
   conflict it reported and verifies the result from Git.

A resolution may only combine, choose, or omit content the evidence contains. Never take
"ours", never take "theirs", never let a merge driver decide, and never invent a third
version of a file that neither side wrote.

### Cases that block instead of resolving

These are reported as a blocker with the exact path and kind, never resolved by a rule:

- **Ambiguous content** - both sides changed the same region in ways the stated intent
  does not separate. Stop. Ask. The recoverable workspace stays where it is.
- **Rename / delete / file-directory conflicts** - the resolution changes what a path
  _means_ for every later pull request. It needs the stated intent plus an explicit
  justification recorded with the decision; a mechanical rename-follow or delete-wins is
  not acceptable.
- **Binary and submodule paths** - no textual evidence exists; a decision here is a guess.
- **Lockfiles and generated output** - a merge must not hand-edit them; they are reported
  for regeneration by the owning tool, and regeneration is never run by the helper.
- **Anything a mandatory control refuses** - a signing requirement, a hook, a policy
  check. The failure is reported; the control is not bypassed, weakened, or disabled.

## 4. What preparation guarantees and what it does not

`preparation.branches[n].retainedOriginalCommits` and the `lostOriginalCommits` array are
computed with `rev-list` against the real object graph. A result is `prepared` only when
every position is integrated or genuinely redundant, the original commits are reachable
from their prepared heads, the chain is contiguous, and `integrity.clean` reports no
unmerged entries, no operation in progress, and no conflict markers in the tree.

It is `partial` when some positions are prepared and a later one is blocked: the
continuation names what is prepared, what remains, and where to resume. Nothing in the
manifest says the stack is publishable when it is not, and a partial state is a
first-class result - not a failure to hide.

Not claimed by preparation, ever: that the code is correct, that checks pass, that the
pull request is reviewable, or that any human agreed to the conflict decisions. Those
remain outside this increment and outside these documents.

## 5. Publishing gate

Preparation never pushes and never writes pull-request metadata. It produces
`preparation`, `continuation`, and `journalPath`, and stops. Publication is a separate,
explicitly authorized step - see `publication.md`.
