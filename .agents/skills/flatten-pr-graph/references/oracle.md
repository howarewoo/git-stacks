# flatten-pr-graph completion oracle

**Scope:** what has to be true before any status other than `blocked` may be claimed, and
which check backs each claim. This reference is a _conditional_ companion to
`references/contract.md` §2 and §6.1; it does not restate the contract's meanings.

**Design the oracle before the edit instructions.** Claim success only from evidence the
oracle can produce without trusting the report under test. Every check below reads
Git, the provider, or the recorded action log - never a field the result asserts about
itself.

---

## 1. Automatable invariants

| Invariant                       | What the check reads                                                                       | Passes when                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `selection.complete`            | the explicitly selected identities, against the plan's order                               | every selected canonical identity appears exactly once                                       |
| `selection.no-expansion`        | the same two sets                                                                          | no unselected identity appears in the chain                                                  |
| `topology.chain`                | each selected pull request's observed base, against its predecessor's observed head        | bases form `root <- PR1 <- ... <- PRn`                                                       |
| `topology.dependencies`         | edges derived from the **pre-run** evidence, not from the plan's own edge list             | every pre-run hard edge is declared, and every declared edge is ordered before its dependent |
| `preservation.root`             | the root ref's OID before and after                                                        | unchanged                                                                                    |
| `preservation.unselected-refs`  | every ref outside the authorized write set, before and after                               | unchanged, and no new ref outside the set appeared                                           |
| `preservation.original-commits` | reachability from each published head back to its original head commit                     | every original head commit is still reachable                                                |
| `preservation.cumulative`       | real ancestry between adjacent published heads                                             | each successor's prepared state contains its predecessor's prepared state                    |
| `preservation.user-worktree`    | the user's HEAD, status, staged diff, working-tree digest, stash list, and local config    | all unchanged                                                                                |
| `integrity.clean`               | unmerged index entries, in-progress operations, and conflict markers in each prepared tree | none                                                                                         |
| `remote.claims-match`           | each claimed remote head/base, re-read from the provider                                   | the claim equals the re-read at the stated time                                              |
| `remote.actions-permitted`      | the provider's own action log, against the permitted vocabulary                            | every recorded action is permitted, and no prohibited action occurred                        |
| `status.legality`               | the observed state, against the declared status                                            | the declared status is the one the evidence supports                                         |

Three of these deserve their own note.

**Hard edges come from the evidence, never from the report.** An edge that pre-run
evidence proves must be declared and respected in a planned result just as it must be in
a published one. A plan that quietly omits an observed edge has failed the same way a
published chain does; "it only planned" is not an exemption.

**The user-workspace check is a content check, not a status check.** A run that
rewrites a dirty file without changing `git status` still differs, so the staged diff,
the working-tree content digest, the stash list, and the local configuration are all
part of the fingerprint.

**A denied permission is a blocker.** It is never a successful preview and never a
published result.

## 2. Status legality

| Status      | Legal only when                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `planned`   | snapshot and plan exist, with no preparation and no publication                                          |
| `prepared`  | preparation exists and its integrity state is clean; no publication                                      |
| `published` | every proposed write is confirmed and every remote claim is observed                                     |
| `no-op`     | the chain is already correct: zero attempted writes, and every plan write is `change: none`              |
| `blocked`   | no write was confirmed; reasons and evidence are recorded                                                |
| `partial`   | at least one write is confirmed and at least one is unconfirmed or denied; a recovery record is required |

The result schema encodes these combinations, so an incomplete success claim is
rejected **structurally**, before any judgment.

Branch updates and PR base updates are separate acknowledged operations. No result may
describe them as one transaction; only an acknowledgement from the provider backs a
confirmed write.

## 3. Inspect the final difference

Structural invariants can all pass while the result is still wrong. Before claiming
success, read the final diffs and answer, from the evidence:

- does each successor actually contain its predecessor's **prepared** state, not a
  snapshot of it from before the run?
- is every justified original commit still reachable from the published head?
- does the cumulative prepared state contain anything the plan never proposed?
- were unrelated paths touched, dropped, or silently reverted?

A run that finds an unexplained removal reports it. It does not publish past it.

## 4. Not automatable

Whether a resolution keeps **both** sides' intended changes, whether it is the change
the work actually asked for, whether an unrelated bug was fixed or review feedback
implemented, whether unclear product intent was guessed, whether a justified original
commit was silently dropped, and whether the result claims more than its evidence
supports are human-review questions. `contract.md` §10.2 is the rubric.

Absent human review, the semantic dimension is `unautomated`. It is never `pass`.

## 5. Where the oracle is checked

The invariant list above is not a claim about a program that does not exist yet. The
authoring-time oracle in `tests/skills/flatten-pr-graph/support/oracle.ts` judges real
disposable Git state and a fake provider double against exactly these invariants, and
the mutation fixtures prove each one fails when the state is broken.

That oracle is authoring-time machinery. It is never invoked by a flattening run, and
its passing tells you nothing about the correctness of any application.
