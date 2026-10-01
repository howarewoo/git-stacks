# flatten-pr-graph publication and recovery (conditional)

**Scope:** what the agent does after preparation is complete and the user has authorized
publication. This file implements issue #88 and is the only place that states the
publication procedure; it is a _conditional_ companion to `../SKILL.md`. Read it when the
work reaches a remote write. It states nothing about what has been executed.

Publication is not "push and set base". It is two different kinds of write with two
different guarantees, and no document may describe them as one transaction.

## 1. Authority, before anything else

A write needs all three, and each one is checked against the prepared set rather than
against a claim in a request body:

- **Intent**: an execute request for this work. "What would you do?", "prepare it", a
  prepared manifest, this skill's own name in a prompt, or a preview are not authority.
- **Selection**: exactly the prepared set - the same numbers, no more, no fewer. A
  request that names a different selection is a new plan, not a broader permission.
- **Mutation kinds**: an explicit grant naming `ref-update` and/or `pr-base-update`.

If any is missing, the run stops with `missing-permission` and zero attempts. The
document records `authority.source`: `host-pinned-module-and-caller-declared-grant` when
the host has pinned `FLATTEN_PR_PROVIDER_MODULE`, otherwise `caller-declared`. A declared
grant is a declaration; only host pinning and real server authorization make it a
permission, and the result never claims otherwise.

## 2. Re-verification, immediately before the first remote write

Nothing from the preparation document is taken on trust. Before any write the run:

1. re-reads every selected head and the root from the remote;
2. checks each prepared head still exists in task-owned storage, still contains its
   original head, and still contains its predecessor's prepared head;
3. pins each ref's expected old commit id and stops if a ref moved - a concurrent push is
   never overwritten, and an unselected ref that moved is reported, not fixed;
4. re-reads each selected pull request: state, head branch, head repository, and its own
   auto-merge request. A pull request that has been closed, retargeted at another branch,
   or had auto-merge enabled is a blocker, not a repair job.

## 3. Controls, then capability, then the write

Nothing is attempted until both of these are answered:

- **Controls that would widen the write set.** `push.followTags` and a non-`no`
  `push.recurseSubmodules` would push refs nobody authorized; an installed `pre-push` hook
  is a mandatory control this helper will not bypass and whose side effects it cannot
  prove. Any of these stops the run. They are never disabled, overridden, or suppressed
  here - the run reports them and stops.
- **Atomic ref transaction support.** `git push --atomic --dry-run` asks the remote with
  the real refspecs and sends nothing. If the remote cannot apply all-or-nothing, or does
  not answer, the run stops **before** the write. A sequential push could half-apply a
  stack, which is exactly the state this contract refuses to report as published.

The write itself is one `git push --atomic` carrying explicit
`refs/heads/prepared/<n>:refs/heads/<branch>` refspecs and one
`--force-with-lease=<ref>:<expected old sha>` per ref. No broad refspec, no `push --all`,
no tags, no root, no prune, no submodules, no unselected ref. Hooks, signing, and
configuration stay in force.

Branch writes and base writes are separate acknowledged operations, sequenced, never
atomic with each other. That is a limitation of the world, not of this implementation,
and the `publication` document keeps them in separate attempts.

## 4. Base retargeting

For each selected pull request, in dependency order, using the real head branch and the
real root branch name:

1. re-read the pull request immediately before the write;
2. skip it if it already has the intended base;
3. write only the base through the provider interface
   (`capabilities`, `readPullRequest`, `updatePullRequestBase`) - nothing else, on the
   selected pull requests only;
4. re-read immediately after, and confirm the base changed. Every other field -
   state, draft, head ref, head repository, title, body, labels, reviewers - must be
   unchanged; if one changed, that is reported as a failure, not repaired.

`github-provider.mjs` is the shipped GitHub implementation of that interface. Because
GitHub's REST API (`PATCH /repos/{owner}/{repo}/pulls/{n}`) does not offer a server-side
precondition check for base updates, the provider reports `compareAndSwap: false`. Base
updates are guarded by an immediate read-before-write check, and the publication result
explicitly records `baseWritesGuardedBy: "read-before-write"` with `residualMetadataRace: true`.
A read before a write is not atomic, and no document here may promise a guarantee the interface
cannot enforce.

No check run, queue membership, ruleset, or branch-protection state is read or gated on.
The one preflight fact read is the selected pull request's own auto-merge request, because
an active landing arrangement and a base rewrite are the same landing decision.

## 5. Acknowledgement, uncertainty, and recovery

Every attempt is journalled **before** it is made, at
`<runDirectory>/publication-journal.json`: kind, target, from, to, lease, outcome. A
network error, a timeout, or a process that dies after the server accepted a write may
have written - so an unknown acknowledgement is never retried blindly and never rolled
back automatically.

On resume, the run reconciles from fresh observations, not from the journal's optimism:

- a ref already at the prepared head is **not** pushed again;
- a base already at the intended branch is **not** written again;
- an unconfirmed write is re-read first; if it landed, it is recorded as confirmed;
- if the identity, root, head, or base changed since the journal was written, the resume
  is refused - that is a new plan, not a continuation.

Statuses follow the contract: `published` only when every intended write is confirmed;
`partial` when some landed and some did not; `no-op` when nothing needed writing;
`blocked` when nothing was written. `partial` is reported with `recovery`, listing what is
acknowledged and what is not.

## 6. After the last write

Re-read every selected head and every selected base and report the chain as observed. If
the root advanced after the plan was authorized, say so against the **pinned** snapshot:
the prepared chain integrates the pinned root, and the newer root work is not part of it.
If an unselected pull request depends on one of the retargeted branches, report that it
still points at the old base - a fact about the repository, not a decision to fix it.

Not claimed by publication, ever: that the code is correct, that checks pass, that the
pull requests are reviewable, or that a human agreed to any conflict decision. The result
that says `published` says exactly this: the selected heads and bases are where the
prepared plan put them, verified by re-reading the remote.
