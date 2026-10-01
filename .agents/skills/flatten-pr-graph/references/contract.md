# flatten-pr-graph conditional contract

**Contract version:** `flatten-pr-graph/1`
**Status:** the conditional contract plus two later increments. `#85` added the portable
core (`../SKILL.md`), `#86` added the ordering reference (`ordering.md`) and three
deterministic helpers under `../scripts/`. There is still no publisher and no harness
adapter, so phases 4-6 of the core are unavailable to a harness that lacks the
capability and report an honest `planned` or `blocked` result.
**Parent scope:** issue #83. This file implements issue #84 and remains authoritative for
what every later increment must agree on.

This is a _conditional_ reference. Read it when the requested work touches PR-graph
flattening; it is not standing repository instruction and it does not run anything by
itself. The compact portable core in `#85` is the only place that states activation and
sequencing for a harness; this file fixes the meanings the rest of the implementation
issues must agree on.

Everything here is conditional and evidence-relative. A clause marked **Condition** holds
only while the stated observation is true; when the observation cannot be made the clause
resolves to a blocker, never to a permission.

---

## 1. Conditional routing

| If the request or state contains                                         | Read              | Because                                                     |
| ------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------- |
| any selected pull request, any base/head discussion                      | this file in full | the whole contract is one conditional unit                  |
| "preview", "plan", "dry run", "what would happen"                        | §3, §5, §6.2      | preview is a distinct intent, not different wording         |
| "execute", "do it", "flatten", "linearize"                               | §3–§10            | execution adds §7–§9 obligations                            |
| a fork, closed/merged PR, duplicate head branch, or permission question  | §5                | unsupported and blocked inputs are decided before any write |
| auto-merge already enabled on a selected PR, "it merged while we worked" | §5.4              | that pull request carries its own active auto-merge request |
| "make it green", "wait for CI", "rerun the checks"                       | §8                | check-independent execution is non-negotiable               |
| any success claim                                                        | §10               | status claims require named evidence                        |

- **Empty resolution.** `selection.requested` and `selection.resolved` may both be empty in a
  snapshot, but only when the result carries the `missing-selection` blocker. The oracle
  enforces that pairing; the schema only enforces the shape.

---

## 2. Outcome and evidence before edits

A run is successful only when, for the explicitly selected set, every selected PR identity
occurs exactly once in the result chain, the chain is `root <- PR1 <- ... <- PRn` with each
successor's base equal to its predecessor's head, hard dependencies are respected, each
successor incorporated its predecessor's **newly prepared** state, every justified original
commit is still reachable, the root and every unselected ref are unchanged, no unresolved
index entry or in-progress Git operation remains, and every claimed remote head/base matches
a re-read of the provider at the stated time. A valid existing chain returns `no-op`.

Absence of conflict markers is not application correctness. Green checks are neither
required nor permitted. `prepared` is not `published`. A prediction is not a resolution.

## 3. Intent

Two intents are distinct, and every document records which one it belongs to.

| Intent    | Authorizes                                                                           | Never authorizes                                                                          |
| --------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `preview` | reads; evidence gathered in task-owned scratch storage                               | any change to an existing ref, the user's checkout/index/stash/config, or remote metadata |
| `execute` | the exact writes named in `plan.proposedWrites`, still subject to harness permission | anything outside `proposedWrites`, and every activity in §8                               |

`preview` and `execute` produce different document sets, not the same document with
different prose: a `preview` result never contains `preparation` or `publication`.

## 4. Inputs, normalization, and root

- **Selection.** An explicit, non-empty, unordered set of positive PR numbers, `#number`, or
  canonical pull-request URLs. Nothing is inferred: a missing selection never means "all open
  pull requests".
- **Resolution.** Bare numbers resolve against the _verified_ repository. Every accepted
  spelling collapses to one canonical identity; the collapsed inputs are recorded, not
  discarded. A single selected PR is a valid selection.
- **Repository.** Exactly one GitHub repository per run, resolved and verified before any
  evidence is attributed to it. `origin` and `main` are never assumed.
- **Root.** Discovered when omitted and recorded with its `source`
  (`explicit` | `repository-default` | `declared-prerequisite`). The root must be verified
  and must not be a selected head. When it cannot be discovered, the run is `blocked`.

## 5. Support envelope

Every input is classified as **supported**, **unsupported**, or **blocked** _before_ any
remote mutation. The classification is a field of the result, never an inference from the
absence of an error.

### 5.1 Initially supported

- one GitHub repository;
- open pull requests, drafts included;
- distinct writable head branches in that repository;
- a verified root that is not a selected head;
- complete reachable history for every ref the run must reason about;
- single selected PR.

### 5.2 Initially unsupported (explicit unsupported result, no retry loop)

- cross-repository or fork heads, including a head whose repository is not verified writable;
- closed or merged inputs;
- two selected PRs that share one head branch;
- published-history rewriting (the initial policy is history-preserving);
- a base or root outside the verified repository.

### 5.3 Blocked (evidence exists but the run may not proceed)

- missing permissions for an intended write, or a write denied mid-run;
- missing external prerequisite, missing history, shallow or incomplete ancestry;
- contradictory graph evidence: a dependency cycle, or a declared prerequisite that
  contradicts observed ancestry.

Multiple incoming hard prerequisites are **not** a contradiction. Several selected pull
requests may all feed one head; the contract linearizes them and every observed dependency
edge survives into the plan and into the prepared states. Only evidence that cannot all be
true at once - a cycle, or a prerequisite that disagrees with observed ancestry - blocks.

- ambiguous ownership of a ref or of a conflicting change's intent;
- stale snapshot: any observed ref, base, or head differing from the captured snapshot at the
  moment it would be used;
- conflicting mandatory environment controls, including an unresolved recovery.

Unsupported input is never silently dropped, cloned into a replacement PR, or expanded. The
selection is exactly what the user selected or the run is `blocked`.

### 5.4 Preflight: an auto-merge request on a selected pull request

A selected pull request that carries **its own active auto-merge request** is **blocked**,
not merely risky. The preflight reads that one fact per selected pull request.

Only that fact blocks. Specifically:

- a repository that _offers_ auto-merge, or any plugin, extension, or GraphQL feature that
  could enable it, is not a selected pull request's enabled request and does not block;
- the run does not inspect merge queues, required merge methods, branch protection, rulesets,
  or check eligibility, and an unreadable protection or required-check set is not a blocker;
- this contract resolves integration conflicts and ignores checks (§8), so check state is
  never an input.

Reason: once a head push lands, an already-armed auto-merge can merge and close that pull
request before its base is retargeted, which destroys the identity the run is manipulating and
cannot be undone by a later write.

The run must **not** disable auto-merge, leave or join a queue, change protection or a
ruleset, or re-create the pull request. It stops before the first push and reports the
observed request as the blocker, with `nextSafeAction` naming the human decision.

## 6. Preservation

### 6.1 Structural invariants (automatable — oracle ids in §9.1)

| Invariant                       | Meaning                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `selection.complete`            | every selected canonical identity appears exactly once                                     |
| `selection.no-expansion`        | no unselected PR appears in the chain                                                      |
| `topology.chain`                | bases form `root <- PR1 <- ... <- PRn`                                                     |
| `topology.dependencies`         | every hard dependency precedes its dependent                                               |
| `preservation.root`             | the root ref's OID is unchanged                                                            |
| `preservation.unselected-refs`  | every ref outside the authorized write set is unchanged                                    |
| `preservation.original-commits` | every original head commit is still reachable from the published head                      |
| `preservation.cumulative`       | each successor's prepared state contains its predecessor's prepared state                  |
| `preservation.user-worktree`    | the user's checkout, index, stash, and config are unchanged                                |
| `integrity.clean`               | no unmerged index entry, no in-progress operation, no conflict marker in the prepared tree |
| `remote.claims-match`           | every claimed remote head/base equals a re-read of the provider                            |
| `remote.actions-permitted`      | every recorded provider action is inside the permitted action set                          |
| `status.legality`               | the declared status is legal for the observed evidence                                     |

Structural preservation is _not_ semantic correctness. See §10.2.

### 6.2 Preview-specific preservation

Preview may read anything it needs and may write only inside task-owned scratch storage:
task-owned temporary refs, a task-owned worktree or clone under a temporary root, and
task-owned files. Scratch evidence is named as scratch in the result. Writing scratch under
an existing user ref, in the user's working tree or index, or in the user's Git configuration
makes the preview a violation, not a preview.

## 7. Planning, preparation, publication

### 7.1 Stage documents

Each stage has a machine-readable schema under `schemas/` and worked examples under
`examples/`.

| Stage       | Document                                       | Carries                                                                                                                                                                    |
| ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snapshot    | `schemas/contract.schema.json#/$defs/snapshot` | verified repository, root + source, resolved selection, full observed ref set, user-workspace fingerprint, history completeness, landing arrangements                      |
| plan        | `#/$defs/plan`                                 | ordered chain, hard dependencies with their evidence source, ambiguities, objective + search qualification, proposed writes, prohibited activities confirmed not performed |
| preparation | `#/$defs/preparation`                          | task-owned workspace, prepared vs original head per PR, retained and lost original commits, cumulative integration evidence, conflict decisions, unresolved index state    |
| publication | `#/$defs/publication`                          | per-attempt outcome, lease used, acknowledged vs unconfirmed, denials, observed remote claims, interruption and concurrency state                                          |
| result      | `#/$defs/result`                               | status + the four stage documents it is legal to carry + ignored-checks statement + uncertainty + next safe action + recovery                                              |

The `result` schema encodes the legal (status, document) combinations, so an incomplete
success claim — `published` without confirmed publication, `no-op` with attempted writes,
`partial` without a recovery record — is rejected structurally, before any judgment.

### 7.2 Preparation

- Preparation happens in isolated task-owned workspaces. Each successor integrates its
  predecessor's **new prepared state**, never the predecessor's original snapshot.
- The initial policy is history-preserving: original commits are retained, never rewritten or
  squashed away. A run that cannot preserve an original commit reports it under
  `preparation.lostOriginalCommits` and is `blocked`; it does not proceed and hide it.
- Conflict resolution uses both sides' changes and the stated intent of the work. `ours` /
  `theirs` on sight, unrelated bug fixes, review-feedback implementation, and guessed product
  decisions are all out of scope. An unresolved conflict leaves `status: blocked` with the
  path recorded; a fabricated resolution is worse than a blocker.

## 8. Prohibited during a run

Never performed by the skill runtime, in either intent:

- running, polling, waiting for, rerunning, repairing, or gating/ordering on CI, tests, lint,
  type checks, builds, approvals, or merge queues;
- weakening, suppressing, or disabling checks, protections, rulesets, or workflows;
- awaiting or suppressing automatically triggered remote checks (they are left alone);
- merge, close, or reopen of any pull request; branch deletion; pushing the root;
- bypassing protection; disabling auto-merge; leaving or joining a merge queue;
- modifying workflow, action, or repository configuration; editing the user's checkout, index,
  stash, or Git configuration;
- dropping, cloning, or re-creating a selected PR; expanding the selection;
- disabling or bypassing a mandatory environment control.

Enforcement is the harness's, not this text's. A conflicting requirement is a blocker, never
permission to disable the control. Authoring-time evaluation (§11) is a separate activity and
is never invoked by a live flattening run.

## 9. Objective, qualification, statuses

### 9.1 Objective and search qualification

Hard dependencies are decided first and are never traded for a better objective value. The
ordered objective is:

1. estimated conflict-resolution work;
2. unnecessary disruption to history and PR relationships;
3. stable tie-breaking (deterministic, declared in `plan.objective`).

Estimates are honest about their kind. An unknown estimate is `null`, never `0`. Pairwise
probes estimate one merge; they do not prove a cumulative minimum across a chain.

| Label                          | Requires                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `exact-for-declared-objective` | the declared objective is fully computable and the search covered its whole space              |
| `best-found`                   | a search with a declared budget ran, and the budget was exhausted or pruned by a declared rule |
| `heuristic`                    | ordering came from a rule, with no search claim                                                |

Algorithm and budget selection belong to `ordering.md` (`#86`); this reference fixes only
the objective, the labels, and the honesty rules. The completion oracle's invariant list
and the check behind each one live in `oracle.md`.

### 9.2 Statuses and legal transitions

`planned` -> `prepared` -> `published`, with `no-op`, `blocked`, and `partial` as terminal
alternative results.

| Status      | Legal when                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `planned`   | snapshot + plan, no preparation, no publication                                                          |
| `prepared`  | preparation exists and its integrity state is clean; no publication                                      |
| `published` | every proposed write is confirmed and every remote claim is observed                                     |
| `no-op`     | the chain is already correct: zero attempted writes, every plan write `change: none`                     |
| `blocked`   | no write was confirmed; reasons and evidence are recorded                                                |
| `partial`   | at least one write is confirmed and at least one is unconfirmed or denied; a recovery record is required |

A denied permission is `blocked` or `partial`. It is never a successful preview and never a
published result. Branch updates and PR base updates are **not** one atomic transaction; they
are separate acknowledged operations, and no result may describe them as one.

### 9.3 Recovery records

A recovery record distinguishes _acknowledged changes_ (the provider confirmed them) from
_unconfirmed attempts_ (the request may or may not have landed). Recovery never overwrites
concurrent work and never retries blind; `nextSafeAction` names the safe read that resolves the
uncertainty first.

## 10. Result obligations

1. Snapshots of the selected PRs and the root, at capture time.
2. Order and dependency rationale, with the evidence source per dependency.
3. Objective and search qualification, with estimate kinds and unknowns left unknown.
4. Proposed versus actual writes, item by item.
5. Conflict paths and decisions.
6. Integrity observations from Git and PR verification.
7. The ignored-checks statement (§8), explicitly, every time.
8. Residual uncertainty.
9. The next safe recovery action.

Never equate conflict-free with application-correct.

### 10.2 Semantic intent rubric (human review; not automatable)

These questions are reviewed by a human against the recorded evidence. No automated oracle
decides them, and no fixture pretends to.

| #   | Question                                                    | Evidence a reviewer reads                 |
| --- | ----------------------------------------------------------- | ----------------------------------------- |
| S1  | Does each resolution keep _both_ sides' intended changes?   | the conflict diff and the stated intent   |
| S2  | Is a resolved change the change the PR actually asked for?  | PR description vs resolved content        |
| S3  | Was an unrelated bug fixed, or review feedback implemented? | files touched outside the PR's scope      |
| S4  | Was unclear product intent guessed?                         | new behaviour with no stated intent       |
| S5  | Was a justified original commit silently dropped or folded? | `lostOriginalCommits`, reachable-set diff |
| S6  | Does the result claim more than the evidence supports?      | status vs verification records            |

A reviewer records pass/fail per row with the evidence they read. Absent human review, the
semantic dimension is `unautomated` in `semanticReview`, never `pass`.

## 11. Authoring-time evaluation boundary

Fixtures, the oracle, and the runner under `tests/skills/flatten-pr-graph/` are authoring-time
machinery. They seed disposable local Git repositories and a fake GitHub boundary, execute
nothing on the real provider, and are never invoked by a flattening run.

Fixture code that manufactures repository and provider state is scaffolding, not integration
policy: it seeds the state the oracle inspects and deliberately implements none of §7.2.

## 12. Increment boundaries

This reference is the contract, and it stays authoritative. The increments that consume
it each own one thing: `#85` the portable core at `../SKILL.md`, `#86` `ordering.md` and
the helpers under `../scripts/`, `#87` cumulative integration, `#88` publication and
recovery, `#89` harness adapters, `#90` the complete-skill evaluation. No increment owns
a root `docs/`, an application feature or runtime dependency, a live pull request graph,
or a permission grant. Development instructions live in the root `README.md`; run-specific
evidence lives in the pull request.
