# Git Stacks

An open-source, local-first desktop alternative to Graphite's pull-request
management, without requiring a new stack-management CLI.

Current product scope lives in [PRODUCT.md](PRODUCT.md); design rules live in
[DESIGN.md](DESIGN.md). This guide covers how to run the app, how the
large-repository work is measured, how development and verification are performed,
and how a release is published and updated; record run-specific evidence and
outstanding acceptance checks in the associated pull request.

## License and contributions

Git Stacks project code is licensed under the [MIT License](LICENSE).
Dependencies, bundled Git, and other third-party material retain their own
licenses; the project license does not replace their attribution or
redistribution requirements.

Upstream pull requests are maintainer-only. This repository does not accept
external pull requests; bug reports and feature requests can be filed in
[GitHub issues](https://github.com/howarewoo/git-stacks/issues). The public source
may still be cloned, forked, modified, and redistributed under its license.

For security vulnerabilities, use **Report a vulnerability** on the repository's
[security advisories page](https://github.com/howarewoo/git-stacks/security/advisories)
when private vulnerability reporting is enabled. Do not put credentials,
private repository data, or exploit details in public issues.

### Repository administration

Keep **Settings → General → Pull requests → Collaborators only** selected and
the owner as the sole collaborator. Inviting another collaborator grants that
account permission to create upstream pull requests. Review installed GitHub
Apps separately: collaborator restrictions are not a substitute for limiting
an app's write permissions or who can trigger its automations.

Before changing visibility, review the hosted branches and tags, their history,
issues and pull requests, releases, and Actions logs and artifacts for sensitive
material. Ignore rules do not remove files already committed, and making the
repository private again does not retract copies or forks. Land the preparation
changes before making the repository public, then enable private vulnerability
reporting under **Settings → Advanced Security**.

All workflows use standard GitHub-hosted runners. Standard runner execution is
free for public repositories; private-repository minutes, paid larger runners,
storage, and model-provider usage have their own billing rules. After the hosted
workflows pass, retire idle self-hosted runner registrations and stop their local
services; do not interrupt jobs or delete retained runner data during the cutover.

## Install the agent skills

The repository's `.agents/skills/` directory contains three standalone skills:
`flatten-pr-graph` arranges GitHub PRs into a dependency-respecting stack,
`split-pr` breaks one large PR into a reviewable stack without changing its final code,
and `submit-stack-for-review` submits an existing full stack for review, strictly bottom-up.
Install them with the [Skills CLI](https://github.com/vercel-labs/skills) using
Node.js and `npx`; cloning this repository, installing pnpm dependencies, or
building the desktop app is not required.

Discover the available skills from any directory:

```sh
npx skills add howarewoo/git-stacks --list
```

For a project install, run the command **in the target repository**, not in this
source repository. `howarewoo/git-stacks` identifies the skill source; the current
directory determines the project receiving the skills:

```sh
cd /path/to/your/repository
npx skills add howarewoo/git-stacks
```

The CLI prompts for skills and host agents. To select all three skills and a specific
host non-interactively (Codex in this example):

```sh
npx skills add howarewoo/git-stacks --skill flatten-pr-graph split-pr submit-stack-for-review --agent codex --yes
```

Replace `codex` with your host's Skills CLI agent identifier, or omit both `--agent`
and `--yes` to choose interactively. For a user-wide install available across
projects, add `--global`; this writes to the selected agent's user-level skill
location rather than the current project:

```sh
npx skills add howarewoo/git-stacks --skill flatten-pr-graph split-pr submit-stack-for-review --agent codex --global --yes
```

Each skill is a self-contained `SKILL.md`. Using these GitHub workflows requires
Git and an authorized GitHub integration (such as authenticated `gh`), plus the
target repository's own verification tools when the workflow calls for them.
Installation alone does not authorize PR mutations.

When changing skill packaging or these commands, verify discovery and actual
project/global installation from outside this repository with the current Skills
CLI. Use disposable project directories and an isolated `HOME` and XDG directories
for the global check; compare all three installed `SKILL.md` files byte-for-byte with
source and confirm only the current three skills are discovered and installed.
For an unpushed candidate, substitute the absolute local checkout path for
`howarewoo/git-stacks`; this proves local packaging, not remote availability.
Record CLI version, exact commands, outcomes, source hashes, and limits in the PR.
Desktop builds/tests do not exercise skill installation; Biome does not format Markdown.

## Commands

Use Node 24, pnpm 12.11.2 (pinned in `packageManager`), and the committed `pnpm-lock.yaml`. A local source build
does not need GitHub credentials. See [GitHub sign-in](#github-sign-in) for
the required-`gh` policy and current-runtime instructions.

Install the pinned package manager with `corepack enable && corepack install` if
Corepack is available, or `npm install --global pnpm@12.11.2` to bootstrap pnpm.
All project commands below use pnpm.

```sh
pnpm install --frozen-lockfile                 # install
pnpm run dev            # run the app
pnpm run build          # typecheck + production build
pnpm test               # the test suite
pnpm run test:live       # the disposable GitHub end-to-end suite (no credentials)
pnpm run format         # apply Biome formatting
pnpm run format:check   # check Biome formatting without writing
pnpm run bench:performance  # large-repository benchmarks
pnpm run build:promotion-helper  # build the atomic no-replace rename helper
```

`pnpm-workspace.yaml` declares the workspaces and permits dependency install scripts
only for the pinned electron-winstaller and esbuild versions. The root `postinstall`
hook runs `pnpm --filter git-stacks exec install-electron` to download the pinned
Electron runtime when absent, before electron-vite starts. To provision it after an
install with scripts disabled, run `pnpm run postinstall`.

For release security updates, check current registry advisories and the dependency
parents' supported ranges first. Prefer a compatible lockfile refresh for transitive
patches over overrides or unrelated parent upgrades; keep direct Electron and Vite
pins aligned with the patched versions. Commit the regenerated lockfile and verify
it with `pnpm install --frozen-lockfile` and `pnpm audit --audit-level high`.
The release audit and Trivy high/critical gates still apply to the resulting package.

`pnpm run dev`, `pnpm run build`, `pnpm test`, `pnpm run package`, and `pnpm run
dist` all build the clone promotion helper first, so a C compiler must be
available on the build machine (`cc`, `gcc`, `clang`, or `cl`; set `CC` to
choose). The helper is compiled from source at build time and copied into the
packaged app as `resources/promote`; nothing is compiled at runtime, and a build
that cannot compile it fails instead of shipping a build that would fall back to
an unsafe rename. `pnpm run package` and `pnpm run dist` finish by running the
helper from inside the packaged app, so a build that left it out fails there.

### Monorepo architecture and Turborepo

The repository is structured as a pnpm workspace monorepo managed by Turborepo (`turbo.json`):

- **`apps/desktop`**: The Electron application (main process, React renderer, preload bridge, native clone-promotion helper, packaging scripts, and integration smoke tests).
- **`packages/shared`**: Pure TypeScript shared domain types, capabilities, guards, settings, and performance constants. Consumed by other workspaces via subpath exports (e.g. `@git-stacks/shared/types`, `@git-stacks/shared/guards`) and bundled directly into application builds.

Root `pnpm` commands orchestrate tasks across workspaces with Turborepo (`turbo run <task> --`):

- **Node 24 / pnpm lock policy**: Node `>=24.0.0` and pnpm with `pnpm-lock.yaml` committed. Installs use `pnpm install --frozen-lockfile` to preserve pinned dependencies across workspaces.
- **Task dependencies and prerequisites**: Task ordering is defined in `turbo.json`. Build prerequisites (`build:promotion-helper`, `typecheck`, `provision:git-runtime`) execute in topological order without duplicate invocations.
- **Caching and invalidation**: Build and typecheck tasks (`build`, `build:gallery`, `typecheck`, `tokens:check`) are cached in `.turbo/cache`. `build:gallery` depends on `^typecheck` so shared package edits invalidate the gallery cache. Both `build` and `build:gallery` hash `NODE_ENV`. Host- and environment-dependent tests (`test`, `test:live`, `test:desktop`, `test:update-flow`) have caching disabled (`cache: false`). Sensitive secrets are scoped strictly to the uncached tasks that need them (`test:live`, `package`, `dist`).
- **Terminal UI**: `turbo.json` sets `"ui": "tui"`, so interactive runs render the task list with per-task output panes (arrow keys select a task, `/` searches, `s` streams all logs). Non-TTY stdout (for example, piped output or typical CI output) falls back to streaming logs automatically and still exits with the task result. For one streaming run without changing the config: `pnpm exec turbo run <task> --ui=stream` (place Turbo flags before `--`; anything after `--` forwards to the underlying task script).
- **Workspace targeting**: Run a task across all workspaces from the root, or target a specific package using Turbo filters:
  ```sh
  pnpm exec turbo run build --filter=git-stacks              # build desktop only (runs prerequisites)
  pnpm exec turbo run typecheck --filter=@git-stacks/shared  # typecheck shared only
  ```
  Raw pnpm workspace scripts (e.g. `pnpm --filter git-stacks run build`) are low-level bundle-only commands that skip task prerequisites such as `typecheck`, `build:promotion-helper`, and `provision:git-runtime`; use Turbo-filtered invocations so dependency graphs run in topological order.
- **Argument forwarding**: pnpm forwards arguments after the script name directly; do not add npm's extra `--` separator (the root script already supplies Turbo's separator):
  ```sh
  pnpm run test:live --help                         # forward --help to live test CLI
  ```
  To run a focused Node test by name pattern (after prerequisites `typecheck` and `build:promotion-helper` have run):
  ```sh
  pnpm --filter git-stacks exec tsx --test --test-name-pattern="clone" --import tests/setup/owned-cli-boundary.cjs tests/*.test.ts
  ```
The signed release workflow compiles on a runner for each target platform and
puts the Visual Studio toolchain on `PATH` for its Windows runner, which does
not have `cl` by default.

When changing `GitAction`, update the renderer fixture's action messages in
`apps/desktop/tests/renderer/fixtures/control.ts` and affected test payloads. `pnpm run build`
typechecks these test consumers as well as the application.

Stale-preview publishing tests assert rejection and unchanged local and remote
refs. Diagnostic wording is not part of that behavioral contract.

The guarded commit transaction compares both the captured branch/HEAD identity
and its expected old object ID. Some Git runtimes include `HEAD` alongside its
symbolic branch in the prepared transaction: that companion is accepted only
when its old and new IDs match the captured target's update in the same
transaction. A standalone or mismatched `HEAD`, another namespaced ref update,
or a stale captured target cannot authorize the commit. Detached `HEAD` remains
the target itself. Native hooks and signing still run; compatibility does not
disable them or change repository configuration.

Runtime fixtures must isolate only their own configuration and restore process
environment overrides. In particular, clean/smudge fixtures use an owned empty
system/global configuration so installed Git LFS filters cannot replace the
fixture's real filters. A repository with an explicit `extensions.refStorage=files`
must be exercised with the provisioned runtime that supports that extension
(Git 2.45 or newer), not made readable by deleting its configuration or skipping
the recovery assertions. Clone cancellation fixtures distinguish SSH capability
probes from a completed upload-pack transfer and attach rejection handling before
requesting cancellation.

Watcher tests use real filesystem events. Advancing a fake clock starts a
coordinator refresh but does not complete its filesystem reads; await the
emitted snapshot before asserting it. Observe watch readiness through events,
not a fixed sleep: a newly registered macOS watch can miss its first write.
Debouncing coalesces delivered filesystem bursts, not entire Git commands;
do not pin a terminal commit to an exact watcher event count.

Destination-focus checks activate the named navigation control with Enter and
verify heading focus and the live announcement, independently of shortcut bindings.

### Formatting

[Biome](https://biomejs.dev/) owns repository formatting through `biome.json`.
Use `pnpm run format` to apply changes and `pnpm run format:check` for a read-only
check. The configuration preserves two-space indentation, a 100-column line
width, single-quoted JavaScript strings, omitted semicolons where safe, and
trailing commas. Linting and assist actions (including import sorting) are
disabled; this replaces the formatter without introducing new code-quality rules.

Unspecified options use the pinned Biome defaults. Keep `expand: "auto"` explicit
to preserve compact `package.json` arrays and objects, and keep the HTML formatter
explicitly enabled for HTML/SVG formatting.

Biome formats JavaScript, TypeScript, JSX/TSX, JSON, and CSS here. Tailwind CSS
directives are enabled; HTML and SVG formatting use Biome's experimental full
support. It honors `.gitignore` and excludes `.impeccable/`
and generated `packages/ui/src/tokens/tokens.css`. Validate the latter
with `pnpm run tokens:check`; edit `tokens.json` and regenerate rather than
formatting the generated CSS.

[Markdown and YAML are not supported by Biome](https://biomejs.dev/introduction/language-support/).
Review their formatting manually; `format:check` does not validate Markdown
documentation, agent skills, or YAML workflows. No second formatter is retained.
Use the Biome editor extension for on-save formatting with the same configuration.

### Shared persistence and IPC boundaries

Main-process handlers register through the local `ipcMain` wrapper in
`apps/desktop/src/main/index.ts`. It validates the sender before invoking a handler and keeps
untrusted requests out of the failure log. Register new handlers through that
wrapper, not directly through Electron's `ipcMain`. Verify changes to this
boundary with the [packaged desktop smoke](#packaged-desktop-smoke).

`apps/desktop/src/main/review-journal.ts` owns common-directory journal paths, versioned reads,
and owner-only, synced atomic writes for review drafts, snapshots, and viewed
files. Feature modules retain entry validation, retention limits, and locking;
drafts must not evict unsent words to make room for another record.

### Renderer server state

TanStack Query owns renderer-side desktop read results and ordinary mutation
lifecycles. Both the production renderer and fixture gallery use
`createRendererQueryClient` from `apps/desktop/src/renderer/src/lib/query-client.ts`. UI
selection and unsent form edits stay local; Git, filesystem, credentials, and
GitHub transport remain behind the typed `DesktopAPI` in main.

Desktop IPC runs even when Chromium reports offline. Queries and mutations do
not retry, refetch on focus/reconnect, or replay writes. Existing main-process
freshness coordination and explicitly owned view polling retain their cadence.
Inactive queries are discarded; snapshot responses retain their new object
identity so file-content changes not represented by summary fields still reload
the selected file. Scope read keys to their repository, host/CLI authority,
pull request, ref, and comparison as applicable. Retire superseded reads before
adopting pushed or confirmed results.
Repository identity transitions carry the admitted snapshot as the new observer's
initial data, so zero-lifetime inactive cache collection cannot erase a local
open before React renders. A retired GitHub authority seeds only local facts
with remote-derived state removed; it never restores the retired credential.

Review line selections retire when any part of the displayed comparison changes.
Review journals are qualified by the provider host, repository, account, and PR.
A full-set draft save carries the observed saved version (or an observed absence);
main compares it under the journal lock and returns the actual accepted record.
Accepted versions advance monotonically, including empty sets: an explicit clear
or confirmed delivery cannot be undone by an older full-set save. Conflicts keep
the latest local words and their original comparison visible; they never retry,
rebaseline, or submit automatically. Explicitly discard those edits to adopt
newer saved work.
While one autosave is actually running, repeated edits replace the latest
same-comparison paused successor in the existing mutation lifecycle rather than
enqueueing another complete authored array for each edit. Its accepted-version
chain remains FIFO; successful and obsolete snapshots are retired.

An unanswered draft read is not an observed absence: new composition waits for
that qualified journal baseline. A failed conversation refresh in the same
proven qualified scope keeps the owner's existing local words readable and
editable; local saves retain the same qualified FIFO and advance only from the
accepted version of their own predecessor. Existing saved-comment edits also
remain available when live files cannot be read, retaining the original record
comparison rather than re-anchoring onto another diff. Neither retained owner
provenance nor a failed read authorizes provider actions from an older conversation
answer. Retained historical hunks name their actual comparison endpoint, with a
visible warning when newly observed head or base facts differ.
If the selected PR's headline read failed, explicitly choosing that PR again
restarts the existing scoped Review read; fresh list metadata alone does not
authorize provider actions or adopt another owner's local drafts.

New saves, viewed marks, and review intents revalidate their captured owner after
lock admission. Review dispatch also rechecks the original head, base OID, and
base ref immediately before the provider write. Confirmed delivery retires only
the exact submitted authored fields at that same original comparison. A receipt
for an already-dispatched operation remains with its captured owner even if the
active account or read signal retires; it is never returned to the replacement
account or used to dispatch again.
Final permission and comparison validation and the provider mutation share one
main-only pinned CLI credential; account replacement cannot change the sender
between them. Cross-process reservations reject concurrent overlapping authored
versions under the journal lock. Replies also reread their comment boundary at
reservation admission, so a delayed duplicate preflight cannot outlive confirmed
reply cleanup; a fresh explicit reply can use the newly observed boundary.
Recovered review delivery must also match the receipt's original draft ID,
unmodified body (including meaningful indentation), references, and creation
time; current edited words are not certified by an older delivered version.
Historical qualified receipts without that original evidence hold overlapping
drafts rather than clearing them or posting them again. Reply recovery likewise
compares exact authored words, not whitespace-normalized text. New settlement
acknowledgements and history clears require live captured-owner proof under the
journal lock; the UI explains when that proof is still pending or unavailable.

Unqualified older draft and uncertainty files remain byte-for-byte untouched.
They cannot certify viewed marks, anchors, receipts, or account identity. The
explicit unattributed local-text recovery disclosure can show their original
text without restoring anchors, adopting drafts, changing records, or sending
anything.

Shared settings writes reconcile through the authoritative settings read rather
than publishing full reply snapshots. Main's settings and updater queues can
commit concurrently admitted writes in a different order.

Cached display data never authorizes a Git or GitHub mutation: captured
previews, live preflight checks, confirmation gates, same-event locks, and
unknown-outcome reporting still apply. Notification credential handoff stays
ephemeral and outside query keys, payloads, and mutation variables.

## Agent skills

Repository-owned agent skills live in `.agents/skills/`. They are optional agent
workflows, not desktop features or a required stack-management CLI.

Use [submit-stack-for-review](.agents/skills/submit-stack-for-review/SKILL.md) for an
explicit request to submit the full existing stack containing one canonical PR URL.
Invocation syntax depends on the agent host. For example:

```text
Submit the stack containing <canonical PR URL> using submit-stack-for-review.
```

Every pass is strictly bottom-up (the PR based on target trunk first). Each parent
completes rebasing, scoped fixes, publication, exact-current-head CI verification,
and confirmed readiness before its child begins. Each layer is rebased onto its
freshly fetched published parent; conflicts precede failing checks and published-head
changes are draft-gated. Submission means confirmed
readiness with applicable PR CI checks on the exact published head, not waiting for
human or automated review completion. These are the jobs configured by repository
workflows for that PR, discovered from workflow definitions and current-head check
runs/statuses, not branch-protection requirements, rulesets, approvals, or merge
eligibility. All applicable checks must pass; a conditional skip is valid only when
its workflow condition does not apply. External head/base drift stops processing;
resume only after independently reconciling it, preserving external work and proving
old own-layer boundaries. Recovery is bounded and always bottom-up, never
top-to-bottom. A final fresh whole-stack ancestry/base/diff/CI/readiness snapshot
must prove completion.
Unchanged ready PRs remain unchanged. Ambiguous scope, unsafe writes, enabled or
unknown auto-merge, pending, failing, or missing expected CI evidence, and continuing
external drift block truthful completion. Denied mutations stop the workflow; a
denied read blocks only when necessary evidence has no other authorized source.
Protection/ruleset reads are not prerequisites, and their absence or read errors
do not block established workflow/current-head CI evidence. The skill never merges,
queues, changes auto-merge/protections, or handles review threads.

Unlike [flatten-pr-graph](.agents/skills/flatten-pr-graph/SKILL.md), which orders PRs
and deliberately skips checks, this skill verifies every changed layer. For
Markdown-only changes, simplify and review the instructions, then exercise the
actual authored skill with an agent on disposable Git fixtures and independent
state oracles: prove bottom-middle-top execution and lower rewrite propagation onto
freshly published, completed parents, own-commit/diff and unrelated branch preservation,
external drift recovery bottom-up or a bounded blocker, unchanged ready PR behavior,
and final ancestry/base/current-head CI/readiness. Include
policy-read denial with valid workflow/current-head CI, old-head/pending/failing/
missing expected CI, valid and invalid conditional skips, denied mutations, and
essential denied reads without alternate evidence. Keep evaluation scripts/evidence
outside the production repository. Provider simulation
does not prove live GitHub draft/check/readiness integration; record that limit and
any unavailable native agent evaluation. Do not mutate live PRs merely to test a skill.
Application tests and Biome do not validate Markdown or agent workflow behavior.

## Live local and remote freshness

The open repository updates itself. Local Git work done in a terminal — a
commit, a branch switch, a fetch that moves refs — is picked up by a debounced
filesystem watch, as is a deleted or moved repository, its return, and a
directory replaced at the same path: the watch follows the directory's identity,
so it re-arms on the replacement rather than on the tree that moved away. Reads
for one repository run concurrently while mutations serialize behind them.

No watch is subscribed on the Git directories until the watches are armed, so a
repository replaced during that window delivers no event at all. The directory's
identity is therefore rechecked after the Git directories are resolved, and a
resolution whose identity no longer holds is discarded and looked up again
rather than watched: the worktree, the parent, and the Git directories are all
armed from the same tree the identity names, so they cannot disagree about which
tree they describe. The retries are bounded, and a root still being rewritten
when they run out keeps no Git directory watch at all instead of one belonging
to a tree that is gone; the worktree and parent watches follow the path either
way, and the periodic sweep settles the target on a later turn.

On a platform that cannot watch a directory tree recursively, the periodic
sweep fingerprints the worktree and ref content instead, so a nested file or a
loose ref below `refs/heads/feature/` still schedules a refresh. A mutation
starts only after the reads its arrival cancelled have settled.

GitHub is read on a focus-aware cadence: a short interval while the window is
focused and visible, a slow inbox and repository refresh otherwise. A manual
refresh overlaps the automatic read already running, and only the newest of the
two publishes: the older one never overwrites fresher data, backoff, or the
credentials state with its own. Responses are read conditionally where GitHub
supports it, and failures back off exponentially. A secondary rate limit parks
the nonessential tier, a low remaining budget parks it too, and rejected
credentials stop polling until the person refreshes.

The same order also decides what a local-only refresh reuses. Reads claim their
place when they start, so an older read that answers after a newer one cannot
become the repository's confirmed payload: the next filesystem refresh shows the
newer pull requests and issues, not the answer that merely arrived last.

The inbox is read separately from the pull requests, so a successful issue
refresh never reports the pull requests on screen as freshly checked. When the
issue read fails, the last confirmed issues stay listed and the reason they are
unconfirmed is shown, instead of an empty inbox that looks current.

Remote facts in the workbench and inspector retain their observed freshness and
unknown/unavailable states; navigation does not authorize a refresh or mutation.
Cached responses are display only. Native capability checks, review submission,
publication and force-with-lease execution revalidate captured authority live.
An accepted high-impact effect whose answer was lost is never replayed on reconnect.

Renderer checks distinguish `/` in-view filtering from `Mod+K` global search,
exercise modal/menu focus containment and return, and reject unintended mutations.
The retired graph hover-card/timer presentation is not a production path.

### Deleting branches

In **Branches & worktrees**, check the exact rows or the mounted-page checkbox,
then choose **Preview selected local branch deletion…** or
**Preview selected remote branch deletion…**. The preview captures repository,
qualified refs, tips and the explicitly chosen execution directory. Mixed or
ineligible targets are refused rather than silently replaced with another scope.

Checked rows are page-local: paging, search/status/ref/worktree filters, folds
and repository changes clear the batch. **Clear selection** clears checked rows
without changing the inspected branch. Selecting or inspecting a row never
deletes or checks out anything.

The confirmation lists each selected local ref and captured tip. Confirm with
the delete button; typing a branch name is not required, including when
**Delete even if not merged** is checked. Without that opt-in, any unmerged member
blocks the whole batch. Current/default branches and branches used by another
worktree remain protected even with the opt-in. If any captured tip changed,
refresh and make a fresh selection instead of deleting unseen work.

All selected refs are deleted together in one Git reference transaction.
Remote branches, pull requests, and child-branch parent records are unchanged.
The child warning counts local branches whose recorded parent resolves to a
selected ref; remote child branches are not included.
Branch configuration is removed after deletion; if that cleanup fails, the error
explicitly reports that the branches were already deleted.

For remote deletion, the confirmation lists each captured remote-tracking ref and
tip, with no name field or unmerged checkbox. The inspector and command palette
open the same confirmation for a single remote branch. Local branches and their
configuration remain; open pull requests may close, and collaborators will need
to prune their fetched refs. Remote-only commits may become unreachable, and
the app cannot undo deletion.

A remote batch must belong to one configured remote. Git deletes all selected
remote branches in one atomic push to that remote's configured push URL, with an
explicit captured-tip lease for every branch. A mixed-remote selection, protected
default/remote HEAD, changed tip, unsupported atomic push, or server rejection
blocks deletion without removing other selected branches. There is no non-atomic
fallback for a multi-branch deletion. Single-ref deletion does not need the server's
atomic-push capability. Fetch and refresh to capture fresh tips after a stale-tip rejection.
If transport fails after the push may have reached the server, the existing
unknown-outcome notice remains; reconnect never replays deletion.

### Merging a pull request

Merging uses GitHub's asynchronous merge API for a pull request that belongs
to a stack, and the operation is worth knowing about from the outside:

- The dialog previews the contiguous unmerged run below the selected pull
  request, and asks how GitHub should land it: the repository default, a direct
  merge, or the merge queue. The queue is offered when GitHub reports a queue for
  that base ref, so it is available on the first merge rather than after this
  repository has enqueued something. A direct merge also asks for the method,
  because a queued merge runs the repository's own settings instead.
- The submitted stack is re-checked at the moment of the request. If a pull
  request joined or left the stack, or a head moved, since the preview, nothing
  is sent and the dialog says what changed.
- A merge GitHub is still running does not finish: the dialog shows it as
  running and keeps the request. While that run is in flight the dialog follows
  it; the moment it returns, what GitHub reports is what the dialog shows, because
  a read is newer than the progress the run pushed. **Refresh what GitHub reports**
  asks again at any time, including after the run has finished, and a read that
  fails keeps the last result GitHub published instead of blanking it.
- Every accepted request is written down before it is read, together with the
  pull request state a read confirmed, so a crash, a restart, an expired result,
  or a refresh that cannot reach GitHub still reports what was confirmed — merged,
  enqueued, or failed with GitHub's reason.
- The asynchronous merge API's terminal `enqueued` result does not track later
  queue membership, so Git Stacks asks GitHub about the pull request's own
  membership: a pull request the queue holds is reported as queued, with the
  place GitHub names, and one it no longer holds — ejected, or closed without
  merging — is reported as dropped. Merged and closed pull requests outrank the
  entry, and a read whose answer is for a different head or base confirms
  nothing about the reviewed request.
- That read is host-bound and never inferred. A schema without the queue
  fields, a refused credential, an answer this build cannot read, and a dropped
  connection all leave membership unknown: the last membership a read confirmed
  is kept and labelled as not re-read, never turned into a removal. An accepted
  enqueue is retained as evidence that its base ref has a queue. A failed
  refresh preserves the last confirmed outcome without claiming fresh data.
- A terminal result is written down even when GitHub returns no request UUID,
  which is what the immediate `200` for a pull request that is already merged or
  already in a queue carries. Nothing is polled for an identity GitHub never
  issued, and the accepted enqueue still proves the queue for that base ref.
- A merge GitHub refused stays a failure on every later read, with GitHub's own
  reason, instead of being summarised as an operation that changed nothing.
- GitHub owns what happens to a merged pull request. Git Stacks never deletes
  or retargets a local branch for you, and any base GitHub moved is reported
  for you to restack and publish.

One test is deliberately platform-scoped. The release producer's own reader
shells out to `gh`, and the job that publishes runs on `ubuntu-24.04`, so that
reader is exercised on POSIX with a stand-in for `gh` on the search path rather
than with the network: every decision the producer makes about a channel's
history — the sequence, the version, an unreadable feed, a signature with no
manifest, a manifest with no signature — is tested on all three platforms by
handing the helper the bytes a release would have published, because that is the
only part of the read that talks to anything.

## Many-worktree inventory contract

`@git-stacks/shared/worktree-inventory` defines the main-owned inventory used by
`DesktopAPI.worktreeInventory`, `onWorktreeInventory`, `cancelInventory`, and
`adoptWorktrees`. The renderer's `useWorktreeInventory` consumes those typed
methods; it has no filesystem, Git command, provider credential, or polling access.
Subscribe before requesting a read. Publications have a monotonic revision
independent of local read cancellation, so a delayed reply cannot restore
credential-retired metadata. A newly mounted observer waits for main before
exposing cached credential-owned facts.

Local/common-directory, administrative worktree, full local/remote ref, logical
remote host/repository, and PR identities are separate opaque IDs. Do not parse
them or replace them with display names. Independent clones remain distinct local
authorities even when provider knowledge is shared. Qualified fork-head refs join
their own host/repository and published OID, separately from the PR's base repository
and a local branch's current OID/upstream comparison. Ref records retain all
explicit worktree associations; PR-only and branch-without-worktree records remain.

Discovery and inspection use read-only Git commands. Adoption revalidates captured
path, administrative/common-directory authority and availability, then only writes
the application's repository registrations. It does not switch checkout or
selection, clone, edit Git configuration, recreate directories, or register sessions.
Filesystem directory incarnation metadata must be available; an unsupported
identity read fails explicitly rather than inventing a path-based authority.

Status summaries use `WORKTREE_READ_CONCURRENCY` and capped status/ref output from
`packages/shared/src/performance.ts`. Selected and visible contexts have priority;
completed unchanged summaries are reused. Common metadata is watched once per
local authority, with per-worktree watches and the existing bounded sparse-event
sweep. Inactive windows retire automatic watches/detail batches and revalidate on
resume; explicit discovery, inspection and adoption remain available. Partial
counts are lower bounds; failed counts are unavailable, not zero. Bare/missing,
detached/prunable and administrative lock states are explicit. A clean tree, lock
or observation timestamp is not external-tool liveness, a lease or mutation permission.

Provider selection reuses confirmed host/repository/credential-qualified knowledge
or shares an initial request across clones. Cancelling a selection promptly detaches
its scheduler wait without aborting the independently credential-fenced shared
provider work. Explicit refresh and mutation preflight still request live provider
data. Closed tracked-PR augmentation remains local-context
qualified. Provider failure/retirement does not block local discovery or invent fresh
remote facts; remote freshness remains separate from local observation.

The deterministic `#/inventory-consumer` gallery route mounts the production hook,
including partial/failed/offline, held replies, credential retirement, cached-context
revisit and 120-row scenarios. Run its behavior checks with
`GALLERY_PORT=5276 pnpm --filter git-stacks exec playwright test tests/renderer/worktree-inventory.spec.ts --grep-invert @visual`.
Real Git authority/sparse-watch coverage is in `tests/worktree-inventory.test.ts`;
provider clone reuse is in `tests/remote-payload.test.ts` under the desktop package.
Gallery dispatch does not prove native IPC or adoption: use the packaged desktop
smoke for the trusted preload/sender boundary and real registration. The production
v5 shell projects this inventory without changing checkout.

## Collaboration surfaces and desktop entry

**Pull requests** is a dedicated provider-qualified list, not another branch graph.
Lifecycle and draft state remain independent. Author, fork/head/base, checks,
review decision, native membership and published revision state are shown only
when observed. The provider listing is bounded to 50 rows per cursor page; search
and filters describe the observed page, not an unobserved repository-wide result.
Listing a page does not establish complete readiness for that repository.

Open full **Review** from Pull requests, a published branch inspector or global
Attention, including a PR with no local branch or worktree. This reads the captured
provider source without checkout, cloning or creating a worktree. Code, description,
checks, commits and conversation reuse the existing review engine. Diff, viewed
files and authored anchors are comparison-bound, including same-head base movement.
Inline text, overall review decisions/summaries and per-thread replies share the
existing host/repository/account-owned private draft journal and versioned full-set
write queue. Each overall summary/decision version has a minted durable composition
identity. Confirmed receipts retire only that original version; recovered earlier
inline reviews leave a newer summary/decision visibly unsent. A zero-inline review
reconciles its original provider boundary, author, head, event and exact body, not
an arbitrary similar historical review. Missing review identity or an unexpected
provider decision leaves the outcome unknown, with text and its guard retained.
Reply editors open only after the owned journal is admitted. Saved replies remain
copyable, editable and explicitly discardable under their original thread,
comparison and account even when the thread is absent, truncated or unreadable.
Such absence disables sending rather than hiding text or moving its anchor.
Incomplete conversation reads never establish an empty conversation.
Native-member navigation outside the bounded inventory performs a captured exact
provider read after confirming current submitted membership, then adopts qualified
facts and routes without checkout. Retired actor/origin reads cannot adopt or route.
Failed exact reads name the captured-source refusal rather than remaining in a
loading state; later facts from a different remote namespace cannot satisfy that
pending route. The canonical `review-uncached-native-layer` gallery scenario
declares complete 201-member source order and a 200-PR inventory.

PR management captures its original source and operation authority. Provider edit
permission is read from that source rather than inferred from a cached local
snapshot. Title/body/draft and close/reopen use their real validators and confirmed
readback. Body saves carry the original expected body; a changed published body is
compared in-app while authored input stays intact. Related issue links are local
context, separate from provider-body closing keywords, which require a confirmed
default branch and permission. Each contextual config mutation rechecks the captured
directory/ref/origin after awaits. Unlink removes only the selected issue value in
one atomic config mutation; cancellation and refusal propagate rather than being
treated as an already-unset success.

**Needs attention** works across registered repositories with none selected.
One qualified provider PR counts once even with several reasons; clone-local
conflicts, interrupted Git operations and restack obligations retain their own
directory/ref identity. Requests/response rules reuse the existing viewer-aware
Inbox model; team requests do not become direct requests. New-head reasons require
an actual last-confirmed-review receipt, not a runtime baseline. Incomplete reads,
unknown viewers or unavailable journals mean incomplete counts, never zero work.
Existing settings own saved filters. Attention reuses the existing bounded,
cancelled, account-retired Inbox reader while visible/focused; no second poller,
authentication flow or queue database exists. Browsing never acknowledges
Notifications or dismisses a Git safety blocker.
Saved provider repository criteria retain the Inbox model's case-insensitive
matching for both `owner/repository` and `host/owner/repository` identities.

**Activity** retains bounded observed transitions and confirmed app outcomes in
the current app session. The first observation is a baseline, not historic activity;
older cached observations cannot rewind it. Rows distinguish actual event time
when known from observation time. Unobserved past activity and external-agent
liveness are unavailable. Private provider observations retire on principal/host
replacement without retiring another account's authored recovery evidence.

**Add repository** accepts an existing path, native folder picker or recent entry;
folder drop uses the same main-process registration boundary. Missing/moved paths,
cancellation and failures remain explicit, with input retained. Local entry does
not require GitHub or convert a directory/write Git configuration. Find and clone
remains secondary and uses the existing GitHub discovery/clone preview, destination,
collision and cancellation machinery.

Settings remain authoritative for Git/runtime/host/tools, workflow defaults,
refresh, appearance, reduced motion, shared display density and shortcut remaps,
including policy locks, validation, concurrent writes and reset recovery. Per-repo
view memory stores navigation, not settings. Supported privacy/redacted support
preview/export and platform-specific signed-update controls remain available.
Graph-only/demo/Design/reset-scenario controls are not production destinations;
the obsolete duplicate PR Inbox presentation is removed, not its source rules.
Optional Notifications opens from the top-bar **Notifications** button, including
at narrow/zoomed viewport sizes. It remains a secondary entry with separate consent,
host, credential and removal policy; it never borrows the primary `gh` session.

For focused source checks, run `pnpm run typecheck` and
`pnpm --filter git-stacks exec tsx --test tests/collaboration.test.ts`.
The storage cases in `tests/review.test.ts` cover composer reopening, receipt-owned
retirement, newer edits, account/base separation and corrupt-journal preservation.
Use the production `#/app` gallery consumer for navigation/form intent, not as proof
of Git/provider/native success. Native IPC/titlebar/drag, manual assistive technology,
live-provider and performance acceptance require their documented dedicated checks;
a fixture roundtrip is not their substitute.

## GitHub sign-in

GitHub collaboration requires the GitHub CLI (`gh`). Install it from
[cli.github.com](https://cli.github.com/) and authenticate for the host you
intend to use:

```sh
gh --version
gh auth status --json hosts
gh auth login --hostname github.com --web
```

Check status before logging in if you already authenticated. `gh` owns sign-in,
credential storage, refresh, account switching, and sign-out; Git Stacks reports
what it found and changes nothing about that session. Local Git remains available
when the CLI is missing, signed out, rejected, or offline.
Repositories without a GitHub origin also open while the initial CLI status is
settling or the CLI account changes; those local reads carry no GitHub answer to
retire. Reads that contact GitHub still reject answers from a replaced credential.

Any current `gh` release that reports `gh auth status --json hosts` works. The
version shown in this repository's fixtures is a fixture version, not a minimum:
a version probe establishes no account, no host, and no permission.

### Which account is asked about

A host this app is pointed at another provider answers under that provider's
name, not the name that was selected: requests for the public host are made
against the configured destination, so the account serving this app is the one
signed in there. The status is asked for the host those requests actually reach,
and the child it starts is scoped to that host's credential alone. The status
still belongs to the host that was selected — the account it names is the one
that will serve it. A run signed into its destination while signed out of the
public host is therefore authenticated here, which is what it is; a run signed
into neither reports the public host as signed out.

### Current runtime

The GitHub CLI is the only primary authentication path. There is no transport
preference to choose, no alternate direct-API credential, and no environment
variable that selects or supplies one; the app asks the CLI for the host it is
pointed at and reports the sanitized answer.

GitHub's own documented environment variables remain what they are, and they are
the provider CLI's business: `GH_TOKEN` and `GITHUB_TOKEN` serve github.com and
`*.ghe.com`, while `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` serve
GitHub Enterprise Server. The app configures no authentication mode of its own,
logs nobody in, and persists no credential: the main process resolves whichever
authority the CLI itself reports for the host — its stored profile or the native
environment — and pins that one authority privately to that host's requests. No
app-level override selects, stores, or logs a token, and a token reaches no
command line, log, renderer file, or remote URL.

Ordinary GraphQL reads and current-viewer proofs use the same transport request
and response validation. The proof also receives the opaque authority of the
credential that request carried; both paths attribute quota and refusal reports
to that credential and the destination host.

App installation-token accounts use GitHub's actual `name[bot]` login form.
An active CLI account reported as `error` is not assumed rejected: the bounded
viewer proof distinguishes a refused credential, insufficient permissions, and
an unreachable host. An inactive failed check establishes no active credential
and is reported as unavailable; raw CLI diagnostics are never published.

Private clones authenticate as ordinary private Git operations, separately from
this CLI session.

Legacy primary-record retirement verifies the claimed state file before removing
its owned vault entry and restores the record when removal is refused or fails.
Vault reads share the mutation queue; Notifications references and foreign vault
metadata are preserved.
If any Notifications credential-state file is malformed or unreadable, or its
directory cannot be enumerated, retirement is skipped without aborting startup.
An unknown protected reference is never treated as an empty protection list.

GitHub CLI can fall back to plaintext token storage when its secure store is
unavailable; [its login documentation](https://cli.github.com/manual/gh_auth_login)
describes that behavior. Plaintext storage is not secure storage. Use a working
secure credential store, do not select `--insecure-storage`, and never include
credentials or credential paths in a support bundle. Requiring `gh` does not
establish secure storage by itself.

[GitLab through `glab`](PRODUCT.md#future-provider-direction) is future direction
and is outside this cutover.

## GitHub Notifications

The GitHub Notifications inbox is a separate, optional module, not part of the
pull request inbox. It is off by default and nothing about sign-in, pull
requests, stacks, or reviews changes when it is off, held off by policy, or
stripped of its credential.

The Notifications API requires a separately authorized token with the
`notifications` scope. The module does not borrow the CLI session, and the
cutover preserves its credential protection without widening core account
permissions. Its consent flow remains:

1. **Settings › Notifications** explains what authorizing adds — the credential
   kind, the `notifications` scope, how it is protected, and the fact
   that removing it affects nothing else — before the switch is touched.
2. **GitHub Notifications › Authorize notifications** opens a dialog that repeats
   the boundary, names the host and the account the token belongs to, and
   requires the acknowledgement before anything is stored. The host shown is the
   one the dialog acknowledged; if the selected host changes while the dialog is
   open, the submission is refused rather than sealing a token for a host the
   person is no longer pointed at.
3. The token is entered as a masked password field, so it is on screen in this
   window before it is submitted — that is unavoidable, and it is the only moment
   it is here. It crosses the preload bridge once and is never handed back to the
   window after that. At rest it is sealed with a key this computer's operating
   system protects and stored as ciphertext in this app's own notification
   credential file; ordinary application state holds only an opaque reference to
   it, and the token itself never reaches a log, status object, diagnostic report,
   support bundle, or screenshot.

The module polls conditionally. It sends GitHub's own `Last-Modified` value back
as `If-Modified-Since`, honours `X-Poll-Interval` as a floor, and never asks for
more than one page of 50. A 304 replays the whole list rather than replacing it
with the page that answered. That floor applies to a person pressing Refresh
too: an early refresh returns what is already known and sends nothing.

Marking one thread read is `PATCH /notifications/threads/{id}` and marking the
whole inbox read is the `PUT /notifications` GitHub documents for it. Both are
sent once and never replayed, because a second attempt could repeat a change
GitHub already applied, and a change that did not reach GitHub is reported on the
inbox rather than silently retried. When the host cannot be reached, the last
list GitHub confirmed stays on screen marked stale with the reason, rather than
being shown as current or discarded; an inbox nobody can confirm any more is
stale for the same reason even when it is empty.

`Done` is a separate control from Ignore and Unsubscribe because it is a
separate change on GitHub: it is `DELETE /notifications/threads/{id}`, marking
the thread itself done, not changing its subscription. The subscription controls
stay available whatever the thread is, and only Open is withheld when a subject
has no page this host is known to serve.

Marking the whole inbox read is a bulk operation GitHub answers by accepting it
rather than by confirming it. When that acceptance is not yet confirmed, the
inbox says so plainly, keeps the last confirmed state of each thread, and will
not send the bulk request again — the next read that GitHub permits is what
settles it. A write whose answer never arrives is reported as unknown, not as
failed and not as applied, and is not silently retried.

Only the API routes whose web page is actually known are turned into links: a
pull request, an issue, and a commit. A subject GitHub reports by some other
route — a check suite, say — is shown as itself with Open withheld, rather than
guessed at.

Whether a thread can be opened is a question about its address, not about what
this build calls it. A `reason` or subject `type` GitHub invents after this build
was written is kept and shown as unknown, and on its own withholds nothing: a
pull request, an issue, or a commit reached by an unfamiliar reason is still
opened, and Mark read, Done, Ignore, and Unsubscribe stay available for it
whatever its kind or reason. Open is withheld only when there is no address this
build can validate into a page on the host that sent it.

A notification's `subject.url` is an API address, not a page. It is resolved onto
the web origin of the host that sent it before Open is offered, so the link
leaves for a page on that host; a subject from any other origin, or one that is
not a repository, is offered no link at all rather than a guessed one.

Each host keeps its own credential reference and cached list, and each credential
belongs to one host and one account: a host change, an account change, or a
replacement credential ends any read, write, or authorization still in flight, so
no list is ever published or written under another host's or account's name.

Every GitHub response is metered against the host that served it and the
credential it carried, and against the order its request left in — never against a
clock, because two answers from one account are the ordinary case of it and a
millisecond cannot order them. An answer whose request left before a newer one
describes an account that has since been replaced, and it is not allowed to become
that host's current rate-limit state, the process-wide report, or anything a
listener is told. Each host's line only moves forward: an account's late answer may
still say what that account has left, and it cannot lower the line the account that
replaced it stands behind. A secondary rate limit is the exception:
it is the host refusing everyone at once, so its wait still applies to whoever asks
next. A primary rate limit is the other way round: its window belongs to the one
account it was measured against, so it is kept against that account's allowance and
never becomes a wait the whole host serves — an account replaced by one with plenty
left is admitted, and the account that spent the window waits out its own
`Retry-After`.

A read can also be overtaken while it is still being built rather than before it
starts, and the window between those two is covered the same way. The answer a
read already took cannot be recalled once its account is replaced, so a read that
asked GitHub is refused rather than handed over. A read that asked nothing — a
local refresh after a commit, or a refresh after the network — is answered again by
asking nothing at all: it consults no confirmed payload, and reads the local Git
work once, so the branches, the parent each one names in its own history, how far it
is behind that parent and whether it needs a restack are all measured locally and
none of the replaced account's pull requests, issues, branches or reconciliation
come along with them. A read's rate limit or last answer does not become the
replaced account's answer either — those describe requests the replaced account
made. And an answer this build cannot use — a conditional response with nothing
stored to replay, a page that is not a page — or a request that never got an answer
at all is not this host's current state either: it changes nothing another host or
another account last reported, and leaves no wait behind for whoever asks next.

Filesystem-triggered reuse-only snapshots remain local reads during credential
retirement; their existing generation checks rebuild from local Git when needed.
In the renderer, retirement also clears submitted reconciliation, its repair
preview, and ancestry learned from pull requests or native stacks. A repository
open remains locked until main settles, then adopts the completed repository's
local identity even if the remote part of its answer was retired.

This module seals its token in its own store. Removing it leaves the CLI account
intact. Retiring app-owned primary account records must preserve Notifications
credentials, CLI credentials, and unrelated operating-system keys. A replacement
Notifications credential commits before the superseded credential is retired.

Changing the selected GitHub host retires the previous host's center where the
change happens, rather than at the next notification request: the window is
handed the newly selected host's inbox, so the previous host's threads do not
remain on screen under the new host's name.

### Verifying the notification center

```sh
pnpm --filter git-stacks exec tsx --test tests/notifications.test.ts
GIT_STACKS_NOTIFICATION_EVIDENCE="$PWD/test-results/notifications" node apps/desktop/tests/notifications.e2e.cjs
```

`apps/desktop/tests/notifications.test.ts` drives the module over a real TLS socket with a
certificate generated for the run and pinned in the transport it is given, so
verification is on; one test proves it by presenting a second, untrusted
certificate for the same address and observing the refusal.

`apps/desktop/tests/notifications.e2e.cjs` launches the built Electron app against that same
kind of controlled host, trusts only that run's certificate, and drives the real
window: it opens a recent repository, turns the module on in Settings,
authorizes through the consent dialog, and then reads the requests the host
actually served. It writes its screenshots to `GIT_STACKS_NOTIFICATION_EVIDENCE`
when that is set, and cleans up its own processes, profile, and repository
otherwise. It is complementary to the [packaged desktop smoke](#packaged-desktop-smoke),
not a substitute for it.

The interactive test-owned window has background throttling disabled so dialog
teardown can receive animation frames even when another window occludes the run.
This does not change production window scheduling.

A control in that window is pressed at a real point, and the press counts only
once the window reports that exact control receiving the click. A window that
re-lays-out between measuring a control and pressing it has the press aimed
again, up to four times, when the press reached nothing; a press that reached a
different control, or that the window cannot account for at all, is reported
rather than repeated.

Both launches — the initial one and the restarted process — start through the
isolated desktop fixture, `apps/desktop/tests/fixtures/isolated-desktop.cjs`, which runs as
the Electron main entry instead of the production main file. The fixture
replaces every `safeStorage` entry point the compiled product uses with a
synthetic AES-256-GCM sealing key confined to the run's own fixture root, forces
Chromium onto `--use-mock-keychain`/`--password-store=basic`, proves no native
method is reachable, and only then imports the production main: if that proof
fails it exits before the production module loads. The same fixture root is
reused across the restart, so the synthetic key persists and the sealed
credential file stays readable across it. This run therefore never reads or
writes the operating system's real credential store, and it is not acceptance
of that store: no run here claims the real OS keychain, and the real-OS-store
acceptance remains a separate manual gate.

Three things in that run are worth stating as mechanisms rather than as results,
because each is a place where a weaker check would pass and a wrong claim would
follow from it.

**Waiting for the app, not for the socket.** An answer arriving at the
controlled host says nothing about whether the app has finished acting on it,
so both halves are waited for separately: the request as the host recorded it,
and then the record the producer writes back for that host, which moves only
when it has republished the confirmed list and the validator it belongs to. Each
of those waits fails the run when it times out; none of them falls through to
the next step having waited for nothing.

**The poll floor is GitHub's, and the module keeps it.** After a host applies a
write whose answer is lost, the window is showing a read state it could not
learn. Reconciling that needs a read the host's own interval permits, and the
run waits past that interval for the read to happen rather than pressing
Refresh to force one: once the floor has passed the module reconciles on its own
timer, so a press would be a person asking for something the floor may refuse.
The count of what the host has been asked is taken before the write that changed
its list, which is well before the wait, because a read the app sends by itself
is exactly the one a baseline measured from too late would miss.

**The isolated smoke observes the required GitHub CLI's reported status.** It
strips App registration and app-owned credential values, then reads the CLI
status surface: which host it is pointed at, whether that host is authenticated,
as which account, and which CLI version was detected. Those four are reported
separately, so a version on screen is never read as an account. It does not
establish a working CLI login, a secure credential store, or native-store
behavior; those need the manual procedures a person runs.

The renderer surface is also exercised in the [gallery](#renderer-verification):
`notifications-awaiting-credential`, `notifications-ready`,
`notifications-stale`, `notifications-rejected`,
`notifications-policy-disabled`, and `notifications-other-host` cover the states a
person meets before, during, and after authorization, and what a selected-host
change does to an inbox the window is already showing.

**What the zoomed screenshots are, and what they are not.**
`webContents.setZoomFactor(2)` is the real zoom; more screenshot pixels would only
be the same layout at a higher density. The run proves the factor took effect by
the halved CSS viewport it produces, not by the size of the image. The zoomed
shots capture the viewport rather than the whole document, because a capture
grown past the viewport repaints a fixed dialog at the position it held in the
shorter viewport it was opened in, which shows an overlaid surface as clipped
when it is not.

At 200% zoom a 1024px window leaves a 512px CSS viewport, in which the
navigation rail and the workspace content stack and the inbox rows fall below the
fold. A capture of that viewport is 1024 physical pixels wide, and it shows the
toolbar and the rail rather than the notification rows — a cropped toolbar edge
in one of these images is what the page is scrolled to at that moment, not a
control that has been lost. Nothing here claims every control is visible at once
at this zoom. What the run does instead is reveal each control in turn by
scrolling it into view, confirm it is the thing actually under the pointer's
point with a hit test, act on it there, and capture that. A claim about a row's
position or reachability at this zoom rests on those measurements and on the
gallery at a 512px viewport — not on an image that does not contain the rows.

The one place a person has to type is the consent dialog, and it is reached
without a pointer at this zoom: from the focus the dialog itself puts on
opening, by `Tab` to the token field, `Tab` to the acknowledgement and `Space` to
give it, then `Tab` to the submit and `Space` to send, with the focus checked at
every step. Nothing in the run moves the caret into the field itself, because a
field it had to aim at would prove nothing about the one a person finds. `Space`
rather than `Enter` is the activating key throughout, since `Enter` is this app's
own command key and never reaches the focused control. This is a claim about
this window's own focus order and its own key handling; it is not a claim about
what the operating system's keyboard navigation or any assistive technology
does with this app, which the run neither drives nor measures.

**Baseline images and visual diffs.** When baseline screenshots are updated,
each image is compared with the previous baseline before it is accepted, and
only images affected by intentional layout changes are updated. A visual change
is bounded to the component that changed, leaving unchanged surfaces pixel-identical.

## GitHub hosts

Git Stacks addresses one GitHub host at a time. `github.com` is the default, and
until a different host is chosen nothing changes: a github.com repository is
still answered by github.com. A GitHub Enterprise Server host is not a separate
mode. It is a host like any other, reached over HTTPS by its own host name.

### Choosing a host

Settings carries the GitHub host name. The field takes a bare host name such as
`ghe.example.com`. A pasted `https://` URL is normalized down to that host name;
anything else aimed elsewhere — a path, a query, another scheme, or embedded
credentials — is refused and the previous value stands.

A repository is answered by the host that owns it. A repository whose origin
remote is on one host is never answered by another host, and there is no
fallback to `github.com` or to any other service. A host that does not answer
is reported as unanswered, not quietly served by the default host.

### What is host-aware

Sign-in, repository discovery, clone URLs in both HTTPS and SSH form,
pull-request reads and writes, native stacks, and diagnostics all address the
host that owns the repository or the host that is configured. github.com is not
a separate code path; it is the same path with a different name.

### Links opened outside the app

Every **open in browser** control and every pull request, issue, stack, and check
link cross the same main-process host boundary. A link is opened
only when it is HTTPS, carries no credentials, and names `github.com`, the
configured host, or the host owning an open repository's origin. Public GitHub
links remain available when an enterprise host is selected. The host is compared whole, so its port is
part of it: an enterprise host configured as `ghe.example.com:8443` opens links
on that port, while the same name on another port, a look-alike that merely ends
in a trusted name such as `github.com.evil.example`, and any other host are all
refused. A refused link never reaches the operating system.

### Authentication

Each host needs its own authenticated CLI account. An authenticated github.com
session does not authenticate an enterprise host:

```sh
gh auth login --hostname ghe.example.com --web
gh auth status --hostname ghe.example.com
```

Use the actual configured host instead of the example. Git Stacks must select
the repository's host explicitly for CLI authentication and API operations,
and must never retry a failed enterprise request against github.com.
GitHub Enterprise still needs its own capability probes; a successful CLI
login is not proof of native-stack or merge-queue support.
See [GitHub sign-in](#github-sign-in) for the CLI the app reads through.

### Capability matrix

This build reports the same five capabilities for every host, each from what
that host actually answered:

| Capability                   | What the host is asked                                                 |
| ---------------------------- | ---------------------------------------------------------------------- |
| REST API                     | Whether the host serves REST requests for this repository              |
| GraphQL API                  | Whether the host serves GraphQL queries                                |
| Native stacked pull requests | Whether the host serves the resource that groups stacked pull requests |
| Repository discovery         | Whether the host can be asked which repositories are reachable         |
| GitHub CLI authentication    | Whether the required CLI is installed and authenticated for this host  |

That row is the single `cli-authentication` capability, and its availability label
follows the state the CLI reported for this host: unauthenticated when the CLI
holds no account, not configured when the CLI itself could not be run. Host-side
capabilities such as native stacks and merge queues are never inferred from a
successful login; each is probed on its own.

Every host has its own endpoints: a GitHub Enterprise Server host serves REST
from `/api/v3` and GraphQL from `/api/graphql` on its own name, while
`github.com` answers from `api.github.com`. Neither is derived from the other,
and a request is never retried against a different path or a different host.

| State             | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `supported`       | The host answered and offers the capability.                                                       |
| `unsupported`     | The host answered and does not offer the capability.                                               |
| `unauthenticated` | The host answered, but no credential for that host is available.                                   |
| `unreachable`     | The host did not answer.                                                                           |
| `not-configured`  | A prerequisite is missing, such as the required GitHub CLI not being installed.                    |
| `unknown`         | The capability has not been established, or the host answered something this build could not read. |

Repository discovery is reported from an actual discovery run, not from the
API answering at all: a host that serves its API root and refuses a repository
collection reports discovery as it is. A capability this build never asks about
is never reported as either.

`unsupported` is only ever reported when the host answered. A host that does
not answer is `unreachable`, never `unsupported`; a timeout is not evidence
that a capability is missing.

### Native stacks

On a host whose stacks resource answered, stacks behave as they do on
`github.com`. On a host that does not serve that resource, the local stack view
and ordinary chained pull requests — each pull request based on the branch
below it — keep working, and the app never labels such a stack a GitHub stack.
Nothing in that state claims GitHub grouped those pull requests: the grouping
is the local one, and the app says which of the two it is showing.

### Rulesets, merge queue, and version-dependent behaviour

This build does not infer ruleset or merge-queue support from a host name or a
version number. GitHub Enterprise Server versions differ from one another and
from github.com, so the app reports what a host answered and never maps a version
to a feature. Merge-queue delivery is offered for a base ref only when GitHub
reports a queue for it, or this repository has already had an enqueue accepted
for it; whether a given instance offers a queue depends on that instance's
version and its configuration, not on anything this build knows in advance.

Per-host and per-repository capability state is visible in Settings and in
Diagnostics.

## Settings

Settings is reachable from the sidebar footer and its confirmed keyboard shortcut. Preferences are
stored in `settings.json` under the app's user-data directory, which main owns
and validates; the renderer never chooses or writes that path.

| Setting                              | Effect                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git to run                           | Chooses the bundled runtime or the system `git` for every Git operation.                                                                                                                                                        |
| GitHub host                          | The host for CLI authentication, discovery, and API requests: `github.com` or an enterprise host name (an optional port). Each repository's own remote decides the host in use.                                                 |
| Editor                               | Program used by **Open in editor** in the file inspector. Empty means the platform default.                                                                                                                                     |
| Merge tool                           | Program Git runs to resolve a conflict. Takes precedence over `GIT_MERGE_TOOL` and `merge.tool`. Empty means Git's own configuration.                                                                                           |
| Default pull strategy / merge method | Seeds the workflow dialog; still changeable per operation.                                                                                                                                                                      |
| Background refresh                   | Seconds between automatic refreshes of an open repository. `Off` refreshes only on request.                                                                                                                                     |
| Theme                                | `Match system`, `Light`, or `Dark`.                                                                                                                                                                                             |
| Reduce motion                        | Removes non-essential transitions regardless of the system setting.                                                                                                                                                             |
| Include local paths                  | Lets a support bundle name the Git executable path. Nothing else widens.                                                                                                                                                        |
| Shortcuts                            | Chord editing with conflict detection.                                                                                                                                                                                          |
| Update channel                       | The channel **Settings → Updates** follows: `stable` for signed releases for everyone, `beta` for the pre-release channel, which moves faster and changes more often. It defaults to `stable` and persists until it is changed. |
| Automatic update checks             | Checks for signed updates in the background on startup and every 24 hours. Defaults to enabled (`true`). Disabling stops background checks while keeping manual checks available. |

The GitHub host accepts a bare host name (a pasted `https://` URL is normalized
down to its host) and refuses a path, a query, a non-HTTPS scheme, or embedded
credentials. Changing it retires old-host reads and identity; the current App
implementation also retires its old account. A host change must not log out
the external CLI or delete its credentials.

A value is validated before use. Editors and merge tools are restricted to a supported program allowlist (`code`, `cursor`, `vim`, `nvim`, `kdiff3`, etc.); arbitrary shell interpreters or commands with arguments are refused. Editor launching enforces repository containment following symlinks. An unreadable field falls back to its default and is reported on the Settings surface; the rest of the file still applies. A file that is not valid JSON is replaced by defaults on the next save. All settings reads and modifications are serialized through an atomic transactional queue.

**Merge tool names are mapped to the tool Git runs.** A program name is not
always a `git mergetool --tool=` id: `bcompare` is launched by Git's `bc3`
backend. Each supported program therefore resolves to the backend Git ships, and
the conflict view names the program you chose while the action runs that id. A
program Git ships no backend for — an editor such as `code` — becomes usable
only once your own Git configuration defines a command for it:

```sh
git config mergetool.code.trustExitCode true
git config mergetool.code.cmd 'code --wait "$MERGED"'
```

`mergetool.<name>.cmd` is the whole requirement. `mergetool.<name>.path` alone
does not define a custom tool — it only replaces the executable of a tool Git
already knows how to invoke, and `git mergetool` stops at
`mergetool.<name>.cmd not set`. Until the command exists the conflict view
reports the tool as unavailable and names that reason, rather than offering a
tool that fails on the first conflict. A tool named by `merge.tool` or
`GIT_MERGE_TOOL` is already a Git tool id and is passed through unchanged.

**The one-time shortcut import.** The build before this one kept shortcuts in
web storage. Those bindings are offered for import once, at startup, as an
intent rather than an assignment: main commits the import only if the settings
file still holds the untouched state the offer was decided from — the migration
marker unset and the stored chords still the defaults. A reset or a shortcut
edit that reaches the file first therefore wins, and the pending import is
declined rather than restoring old bindings over a newer choice. Either outcome
drops the stored copy: a committed import cannot run twice, and a declined one
is a decision, not a retry. The session's write count is what tells a reset
apart from an untouched file, because a reset restores exactly the defaults the
import is qualified against.

**Handled failures are recorded, redacted.** Every main-process request is
registered through one place, so a failure it handles leaves a bounded in-memory
record of the scope that failed and the message the window was about to show —
first line only, capped, and passed through the bundle's secret redaction before
it is ever written. Nothing else is kept: no repository, ref, file, command, or
token. A request from outside the app is refused rather than failed, and a
cancelled operation is the answer the user asked for, so neither is recorded.
This build collects nothing and sends nothing: there is no telemetry endpoint
and no crash upload, and no setting enables one. The only artifact is the
support bundle you create yourself.

### Settings policy

`GIT_STACKS_SETTINGS_POLICY` names a JSON file whose `locks` object fixes
settings for a managed computer:

```json
{ "locks": { "git.useSystemGit": "Managed machines use the system Git" } }
```

A locked setting is disabled in the surface and cannot be written, including
through a direct file edit. Re-saving the value the lock already fixes is
allowed, so an unrelated edit is never blocked. A policy file that cannot be
read or that names a setting this build does not know holds **every** managed
setting at its current value and reports the reason, rather than reading as
"nothing is locked".

Restoring the defaults is a change like any other, so it keeps a locked
setting's value too: a machine whose policy fixes `updates.channel` to `beta`
resets every other preference and stays on the beta channel, both in the stored
settings and in the updater this run follows.

```sh
GIT_STACKS_SETTINGS_POLICY=/etc/git-stacks-policy.json pnpm run dev
```

### Support bundle

**Create support bundle** previews first: every section is listed with whether it
is included and why. The bundle is assembled from named fields and never
contains access tokens, source contents, diffs, branch or pull-request text, or
raw GitHub API bodies — not even when local paths are included. Diagnostic probes
use fixed, non-destructive read commands with sanitized outputs and error codes.
The export binds to the preview snapshot and verifies live settings immediately
before writing: if path consent is revoked while the save dialog is open, local paths
remain withheld in the saved bundle.

The saved file is owner-only (`0600`) whether it is created or replaced. A
mode given to a write applies only when the write creates the file, so
exporting over an existing world-readable `git-stacks-support.txt` would
otherwise leave it readable by everyone while its contents were replaced. The
file is truncated first and its mode set before any content is written, so new
content is never readable under the permissions the file arrived with.

Recent failures is included only when something was recorded. It carries the
main-process failure summaries described under **Handled failures** above, and
they pass through the same secret and path redaction as every other field.

### GitHub CLI diagnostics

**Settings → Diagnostics** reports what was measured about the required GitHub
CLI and never infers it. There is no adapter preference to choose and no
alternate path in use.

Detection runs `gh --version` through the Git-probe allowlist with a byte cap,
deadline, and credential-free environment. It makes no account or host query
and reports no credential or executable path. Recognized output is reduced to
the semantic version; unrecognized output is labelled as such. A missing CLI,
timeout, or non-zero exit reports _unavailable_. This probe does not establish
authentication: the detected version is a property of the program, while
authentication and the account actually used are read separately from the CLI's
own authentication status for that host.

[#30](https://github.com/howarewoo/git-stacks/issues/30) covers host-authentication
status and packaged executable discovery; a missing CLI or missing authentication
blocks GitHub work only, never local Git.

## Signed updates

A release is a signed manifest plus the artifacts that manifest names. The app
authenticates the manifest with a release public key compiled into the build
before it fetches anything the manifest names, and then checks the downloaded
artifact against that same manifest before it installs anything. No repository is
read or written on any path through this.

Checking for an update sends nothing about the person or their machine. It reads
a published file from this project's release location, and there is no telemetry
or crash upload behind it.

### What a release reads before it publishes

The next manifest in a channel is minted from the manifest that channel already
publishes, and that one is read as a signed fact or not at all: the producer
downloads the manifest _and_ its detached signature and verifies the signature
over the exact bytes against the release keys it trusts. An unsigned asset, a
signature from another key, or a manifest that does not match its signature
stops the release. It is not treated as an empty channel, because a sequence
minted from a rewritten feed can sit below the high-water mark installations
have already seen, and those installations could then never update again.

A published manifest that has since expired is still read for its sequence and
version. Expiry says a feed should be refreshed; it does not say the sequence it
used never happened. Only the absence of the whole pair — a channel with no
manifest and no signature — means the channel is new.

A release that cannot read its channel does not publish. A network failure, an
expired token, or a rate limit is not evidence that a channel is empty, and
restarting a sequence at one would be a replay the app is right to refuse.

### How a release is published

Every successful push to `main`, including documentation-only pushes, runs the
full `Accessibility checks` workloads and the complete root `pnpm test` suite.
Only after `selection`, `automated`, `design`, `budgets`, and `root-suite` succeed
does it explicitly call
[`.github/workflows/release-desktop.yml`](.github/workflows/release-desktop.yml)
with the tested final SHA and the `beta` channel. A PR retains selective checks
and cannot enter the release job or receive its signing secrets. Manual CI
dispatch verifies without publishing.

The reusable release workflow reserves an annotated `v<core>-beta.N` tag bound
to that exact source SHA, generates GitHub release notes once, then creates a
**draft prerelease** carrying those notes and a stable SHA/version ownership
marker. Notes compare against the most recently published release by publication
time, including prior betas and legacy previews even when their source history
diverges. Drafts, the current tag, and moving `updates-stable`/`updates-beta`
feeds are not comparison baselines. Only a first release with no published
predecessor leaves GitHub to generate notes without an explicit baseline.
Reruns preserve existing notes, including operator edits, while refusing
missing or conflicting ownership markers. Allocation reads
all version tags, releases (including drafts), and every verified stable/beta
manifest in the immutable feed history. With the committed `0.1.0` core and no
newer history, the first version is `0.1.1-beta.1`; numeric counters advance
through `beta.9`, `beta.10`, and beyond. A newer stable core starts its next
patch series; a newer prerelease series is continued or advanced rather than
reset. Failed reservations can leave gaps. A rerun reuses its source's reservation,
never takes someone else's tag, and never commits version bumps back to `main`.
The reserved version is applied to all workspace package manifests only inside
the build checkout, so the packaged application, installer names, and signed
manifest describe the same version.

Human publication remains available through GitHub's `release.published` event:
publish `v<version>` at a commit whose desktop package has that exact version,
as a full release for `stable` or a prerelease for `beta`. It uses the same
packaging, verification and feed implementation. Automatic runs are always
prereleases, always `make_latest: false`, never read the rollback override,
and cannot move `updates-stable`. A release created with `GITHUB_TOKEN` does not
trigger another workflow; the CI call above is intentional, not an event cascade.

Every target retains the existing release gates. The packaging job requires
all signing prerequisites, runs the committed checkout's tests before injecting
keys, and packages macOS arm64/x64, Windows x64 and Linux x64. The macOS build
must pass `codesign --verify` with a `Developer ID Application` authority, a
`stapler`-validated notarisation ticket, and the expected team identifier; the
disk image itself is also signed, notarised, stapled and assessed. Windows
installers require a `Valid` Authenticode signature. Linux remains a best-effort
AppImage, authenticated by provenance and the signed manifest, not an in-place
updater. Provenance is attested for the files, and dependency audit/Trivy gates
and dependency inventories remain required. The dependency-tree inventory is
uploaded once by the SBOM action and retained with the workflow run for 30 days.

After those gates, the workflow banks one attested `signed-release-payload.tar`
on the draft before uploading individual installers. It contains the exact signed
installers, descriptors and public key sets. Every upload is immutable and read
back: existing identical bytes are reused; different bytes fail closed. A rerun,
including a failed-job-only rerun, rediscovers and verifies that payload against
the repository, source SHA and packaging workflow, then restores the original
signed bytes instead of rebuilding signatures under an already-spent version.
Missing recovery payloads with existing assets require operator recovery of the
original run artifacts, not asset deletion or a blind overwrite.

The publishing job compares every packaged key set, mints/signs/verifies the
channel manifest, re-hashes every installer and verifies source-bound provenance.
Only then does it publish the versioned prerelease with installers; only after
that does it move and publish the beta feed. Packaging, scan or signature failure
leaves the automatic release in draft. A feed failure can leave the versioned
prerelease public, but fails the run and retains banked verified history for
recovery. Full signed multi-platform publication, hosted concurrency and native
installation require a suitably credentialed disposable GitHub repository and
real signing identities; local allocator/feed fixtures do not establish that
hosted acceptance, and the Windows packaged desktop smoke is unsupported.

To install a published beta, open [GitHub Releases](https://github.com/howarewoo/git-stacks/releases),
choose the versioned prerelease, and expand **Assets**. Download the Apple Silicon
or Intel `.dmg` for your Mac, the Windows x64 `.exe`, or the Linux x64 `.AppImage`.
Use the installer assets, not GitHub's source-code archives or the moving channel
feed files. A failed run's draft is not a downloadable release; wait for the
signed publication gates to finish. Automatic betas do not become GitHub's
“Latest” stable release, so `/releases/latest` is not the beta download page.

The moving channel release locations remain:

| Channel  | Moving release tag | Manifest             | Detached signature       |
| -------- | ------------------ | -------------------- | ------------------------ |
| `stable` | `updates-stable`   | `update-stable.json` | `update-stable.json.sig` |
| `beta`   | `updates-beta`     | `update-beta.json`   | `update-beta.json.sig`   |

Every sequence a channel issues is also written once under a name of its own —
`history-stable-000000000007.json` and `history-stable-000000000007.json.sig` on
`updates-stable` — which nothing ever rewrites. A release reads its history from
those names as well as from the two fixed names above, so an interrupted
publication cannot leave a channel looking empty.

A prerelease on GitHub publishes the `beta` channel; a full release publishes
`stable`. The moving tag only ever moves forward along this repository's history,
and a tag that has been moved elsewhere stops the release instead of being
overwritten. Before any of it is published, the manifest and its signature are
read back from disk, the signature is verified again with the key this release
injected, every installer is re-hashed, each packaged build's own key set is
compared with the one being signed with, and each artifact's provenance is
verified.

Those two names are the only place on the moving release where a publication
overwrites what was there, and an upload that is interrupted between them leaves
a manifest with no signature, a signature with no manifest, or the two
describing different releases. So publication is ordered, and
`apps/desktop/scripts/release-update-publish.ts` is the only thing that performs it:

1. **Bank the sequence.** The manifest and its signature are uploaded once more
   under names derived from that sequence — `history-stable-000000000007.json`
   and `.sig` — which nothing ever rewrites. A pair already banked at that
   sequence with these exact bytes is this same publication re-run and is left
   alone; a different pair means the sequence was spent by a publication that
   did not complete, which no release may republish.
2. **Publish the installers**, each under the name the manifest publishes it
   as. Those names carry the version they were built from, and an installer
   published under a name the live manifest already binds to different bytes is
   refused rather than replaced, because a name is a URL an installation has
   already fetched.
3. **Move the two fixed names** onto this release: the installers are in place,
   then the manifest that names them, then the signature that proves it.
4. **Read both back** off the release and verify the signature over the bytes
   that are actually there. An upload that cannot be confirmed is an upload that
   may or may not have happened, so the only honest answer is to read the bytes
   a client will fetch.

Nothing is deleted, and nothing a client needs is only ever reachable after it
exists somewhere immutable. A release that dies at any point leaves the previous
release readable from its banked copy, and the next release reads that copy: a
channel whose two fixed names are both missing, or whose pair does not verify,
is not an empty channel, and the sequence it issues is one past the highest a
trusted key signed anywhere on the tag. A sequence is never reused and a bank is
never rewritten, so a cancelled publication costs a sequence, not the channel's
history. Re-run the release to put the live pair back; the operator floor
(`--sequence`) exists for a channel whose history is being repaired by hand, and
it can only ever move the counter up.

One channel releases at a time. The reusable workflow, not its CI caller or a
nested publishing job, holds `signed-desktop-release-<channel>` from reservation
through final feed verification. Manual and automatic beta publication share
that lock; stable uses a separate lock. With `cancel-in-progress: false` and
[`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
GitHub allows up to 100 pending runs. Queue order is arrival at the lock, **not
commit order**; overflow runs are cancelled. This is not a lossless unbounded
queue. A newer SHA arriving first can make an older queued SHA fail visibly:
reservation/feed ancestry checks refuse stale history, and every publication
rechecks that the source is still on `main` and the moving feed tag is its
ancestor. Force pushes and divergent tags require human reconciliation; no
backwards overwrite is attempted. For a capacity cancellation, rerun the original
CI run once capacity is available, in source ancestry order before newer releases
advance. A stale older SHA cannot be recovered after its descendant has advanced
the feed without changing the forward-only policy; leave that failure visible.
For interrupted uploads, rerun the original failed release jobs (or the whole
original CI run): the reservation and durable signed payload are reused, and a
new manifest sequence may be issued from verified banked history. Do not delete
reservations, recovery payloads or history to make a retry appear new.

A manifest is issued, never edited in place. Its signing key is the
`UPDATE_SIGNING_KEY` repository secret, and the packaging job injects that key's
public half into the app it builds, so a released build is the only build that
carries one. Nothing in the workflow generates a key, and every step that needs
one fails closed without it: a key this repository made up would verify against
nothing an installed build trusts, and a manifest signed by a key no build
carries could be installed by no one. The repository itself holds no key
material — `apps/desktop/resources/update-trusted-keys.json` is committed empty, because a
public key committed here would be trusted by every packaged build built from
it. Each channel's sequence is read back from the manifest that channel already
publishes, so it only ever rises, and each installer is published under a plain
asset name with no spaces, because the URL the manifest names has to end in
exactly the file name it describes.

Every field is required: `schema`, `channel`, `version`, `sequence`, `issuedAt`,
`expiresAt`, `notes`, `rollbackOf`, and `artifacts`, where each artifact carries
its `platform`, `arch`, `kind`, `fileName`, `url`, `sha256`, and `size`. A
manifest carrying a field this build does not know is refused rather than
parsed, because a field the code does not check is a field a forger could use.

### What the app does with a release

The order is the point, and it belongs to the app rather than to the feed:

1. Nothing is fetched until the build has a key to verify with. A packaged build
   takes its keys only from the key set compiled into its own bundle, and a
   packaged build with no such key — every one not put together by the release
   job — reports updates as not configured and never opens a socket.
2. The manifest and its detached signature are read, and the signature is
   verified against the manifest bytes exactly as they arrived. Only bytes a
   trusted key actually signed are ever parsed, so a URL, a file name, or a
   version taken from an unsigned manifest is not read.
3. The rules the signature does not cover are applied: the manifest publishes the
   channel this build follows, it is inside its 30-day lifetime, it is not older
   than the newest release sequence already offered here, it names a build for
   this platform and architecture, its version is newer than the running build or
   is an authorised rollback, and every URL it names is HTTPS on this project's
   release location and under the channel's release path, ending in the file name
   the manifest describes.
4. The offered artifact is downloaded, and the download is discarded unless its
   byte count and SHA-256 match what the signed manifest recorded. The file is
   written under a temporary name and only moved into place once both match, so
   nothing downstream can read a partial or substituted file. A redirect is
   followed only to this project's own release location or to the one release
   asset host GitHub serves the file from, so a signed manifest cannot send the
   download somewhere the manifest itself could not have been fetched from.
5. The download is proved once more, and the build handed to the platform
   installer is copied into owner-private handoff storage: a directory in this
   app's own state entered by its owner alone on a POSIX system, and a file
   created exclusively, so an existing destination is refused rather than
   written through. That reduces interference with the download between the
   digest check and the install, and it catches a file that changed on disk in
   that window. It is not a lock, it does not bind the check to an immutable
   object, and it says nothing about a process running as this same user — a
   backup or sync agent commonly is one.
6. Before anything is run, the download must carry the platform's own signature
   and the identity of the app that is already installed. An installer signed by
   anybody else is refused even when its digest matches the manifest exactly.
   The programs that answer those questions are named by absolute path —
   `/usr/bin/codesign`, `/usr/sbin/spctl`, `/usr/bin/plutil`, `/usr/bin/hdiutil`,
   `/usr/bin/ditto`, and on Windows the interpreter under the system directory
   Windows itself reports — because a program named on its own is found through
   `PATH`, and on Windows through the current directory too, which is the
   repository the app was started in. Nothing on the install path needs Xcode or
   any other developer tool: the architecture is read out of the Mach-O header
   rather than asked of `lipo`, and the notarisation ticket is left to
   Gatekeeper's own assessment rather than to `xcrun stapler`, which is a
   developer tool. On
   macOS the disk image is opened read-only and nothing is mounted until the
   image itself has proved that it is this app's — a valid signature carrying
   this app's team, and a passing Gatekeeper assessment of the image — and then
   the application inside it has to prove the same thing again with more:
   same bundle identifier, same version, a stapled notarisation ticket, and its
   own Gatekeeper assessment. The copied bundle is checked a third time before it
   replaces the running one. Nothing here is optional: an image this app cannot
   attribute to its own team is not opened at all. An installer that cannot be started is a refusal, not an
   install: this app stays open rather than closing with nothing to finish the
   work. On macOS the installed bundle is moved aside rather than overwritten in
   place, so a failure part-way through leaves a working app to go back to;
   where the platform installer has to replace files this process is running
   from, the app closes and the installer finishes on its own.

The Windows installer retains its prepared copy after dispatch. An elevated
install may continue in a different process, so the originally spawned PID
exiting does not prove the executable is free.

Before dispatch, the app writes a random 32-character ASCII token beside the
copy, with no prefix or newline. `build/installer.nsh`, included by
electron-builder at its default `nsis.include` path, echoes it after the install
work with the actual installer's PID as `token=...` and `pid=...` CRLF lines.
On a later launch, cleanup requires that exact token, a complete response inside
the owned handoff directory, and `ESRCH` when probing the reported installer PID.
Missing, malformed, foreign, still-running, or unprobeable evidence retains the
copy. The app's version is not completion evidence. A refused launch or a stop
before dispatch still removes the directory that attempt created.

Once the platform installer owns the files, the update cannot be stopped: a
cancel or a channel change at that point is reported as too late rather than
pretending to have taken effect.

### Installation admission and draft preservation

Installing an update cannot race repository mutations or lose unsent authored review text:

1. **Synchronous app-wide admission fence.** Before any asynchronous operation begins, the install request atomically verifies that no repository mutations, background scheduler lanes, foreground operations, or clones are active or queued across any repository. If any mutation is queued or running, the install is refused immediately. Once admitted, the fence prevents any new repository mutations or clones from starting until safe cutover or release. Long background reads and external tool activity do not block admission, and external activity is never inferred from a clean tree.
2. **Renderer draft readiness coordination.** Before native handoff, the main process coordinates with the active application window to ensure authored content is safe:
   - Existing pending and queued FIFO review draft saves are awaited until they completely persist to disk.
   - Any unsaved, failed, conflicted, or context-retired retained review comments block native installation dispatch without replaying, rebasing, submitting, or discarding them. Unsaved drafts must be resolved in their original repository and account context.
   - Review draft composition is frozen against racing edits during readiness.
   - The renderer window's lifecycle is bound to the attempt: if the window is closed, destroyed, reloaded, or crashes before native cutover, readiness fails closed and installation is cancelled.
3. **Safe refusal and candidate retention.** If admission is refused or if pre-dispatch fails before native cutover, the fence is released and editor usability is restored immediately. The verified downloaded update and `downloaded` phase are preserved, enabling safe retry without re-downloading.
4. **Authoritative native cutover boundary.** The fence transitions to installing and remains permanently held only when the native cutover step is actually dispatched (macOS live bundle replacement or Windows detached NSIS installer launch). The final readiness revalidation runs immediately before live bundle replacement or installer spawn with no intervening await.

One thing happens at a time. A check, a download, an install, and a channel
change are each a single operation, and the second of them waits for the first
to finish and clean up rather than running beside it. A stop is asked for
through the operation's own signal and does not take the boundary away from it:
the operation releases it, in its own cleanup, before the next one starts. That
is why a result from a cancelled or superseded attempt can never land beside a
newer one, and why a stopped download removes only the file it staged rather
than whatever is in the staging directory at the time.

A release becomes offerable only after the history that records having seen it
is written and flushed to the disk: a temporary file of its own, flushed
through its own handle, and then moved into place, with the directory entry
flushed as well on macOS and Linux. Windows has no way to flush a directory
entry from Node's standard library — `FlushFileBuffers` requires a handle
opened for `GENERIC_WRITE`, and a writable directory handle needs
`FILE_FLAG_BACKUP_SEMANTICS` — so there the file's own flush and the atomic
replacement are what this code performs, and the durability of the name across a
power loss is left to the platform rather than claimed here. A write or a
replacement that fails is a failure: the check offers nothing. A check that cannot record what it saw
offers nothing, revokes a build already downloaded for the same release, and
stops every later download and install, because the replay guard is the thing
that keeps an older release from being offered as a new one. A cancelled
attempt leaves the release it authenticated standing, but the next download is
a fresh decision made by a fresh check, so nothing is ever downloaded on the
strength of a run that did not finish.

A channel change is committed with the setting that records it. The updater
takes the channel, the settings file is written while the change is still
undecided, and only then is the new channel published; a write that fails puts
the previous channel back, and an install in flight refuses the change
outright. A stored channel and the channel this process is following cannot
disagree.

The updater writes only to the app's own user-data directory, and on macOS to a
staged and a moved-aside copy of the bundle beside the installed one, both
carrying this app's own prefix. It never reads or writes a repository.

### Automatic discovery and Linux updates

Signed updates are checked automatically in the background shortly after startup
and every 24 hours while the application is running. Resuming from system sleep
runs at most one overdue check without catch-up queuing. When an update check,
download, install, or channel switch is already in progress, background checks
skip rather than queue. Disabling `updates.automaticChecks` in Settings or by
administrative policy prevents scheduled background checks while leaving manual
checks, downloads, and installations fully functional. A packaged build with no
trusted release keys configured never issues a background update request.

Check attempt and authenticated success timestamps are recorded per channel in
`updates.json`. These advisory timestamps are isolated from the monotonic replay
guard sequences; corrupt or missing timestamps fall back gracefully and never
invalidate replay defense or make the updater state unusable.

On Linux, automatic in-place replacement is not supported for AppImage bundles.
When a signed Linux update is downloaded and verified against the release
manifest and signature, the application offers **Show downloaded file** to reveal
the verified AppImage in the desktop file manager without executing it, accompanied
by clear manual replacement instructions.

**What a fixture cannot prove.** The test suite stages an installer and runs the
real code over it, which proves the digests, the manifest, the channel, the
sequencing and the refusals. It cannot prove a native install: `codesign`,
`spctl`, `hdiutil`, `Get-AuthenticodeSignature` and the NSIS installer are not
run in a test process on any platform, so a path that asks the operating system
about a signature is only ever exercised as far as the operating system answers. Installing a real signed release is the
acceptance step, and it is written out under Platform support below. The
handoff's directory and file modes describe POSIX protection; the equivalent
Windows isolation is a documented limit, not something the tests establish.
The lifecycle fixture uses two real processes: the process started by the app
is not the process reporting completion. It checks retention before completion
and while that process is running, removal after a matching answer and process
exit, preservation of foreign siblings, and refusal of malformed evidence. The
stand-in reads the raw request without prefix stripping and writes the same
CRLF response fields as `build/installer.nsh`.

Compile the installer hook through electron-builder's NSIS include chain to
check its `customHeader` and `customInstall` integration. Compilation and the
two-process fixture do not execute the Windows installer; installation of a
real signed release on Windows remains the platform acceptance step below.

### Channels

`stable` follows signed releases for everyone. `beta` follows the pre-release
channel, which moves faster and changes more often. The channel is chosen in
**Settings → Updates** and stored as `updates.channel` in `settings.json`. It
defaults to `stable` and only the person changes it, so a build keeps following
the channel it was set to rather than drifting to whatever was published last;
moving to `beta` is an explicit choice, not something a prerelease makes on your
behalf. The newest release sequence offered on each channel is remembered
separately, so returning to a channel cannot walk back to a manifest older than
one this computer has already been offered there. Changing the channel starts a
different feed with its own sequence history, and the previous offer is dropped
rather than kept.

### Rollback

A rollback is a new signed release, not a reissued old one. It needs all three of:
a release sequence higher than the newest this computer has been offered on that
channel, a version lower than the release it replaces, and `rollbackOf` naming
that newer release. The app then presents it as an authorised rollback of that
version rather than as an ordinary upgrade. It is never a silent downgrade: a
manifest whose version is not newer than the running build is refused as
`not-newer` unless it carries exactly that authorisation, and a manifest older
than the newest release sequence already offered on that channel is refused as
`replayed` even when every other field matches. A manifest at the same sequence
is offered again, so an offer that was never taken survives a restart and still
cannot be replayed backwards. A rollback replaces the installed application and
nothing else: it does not touch a user's repositories, working trees, branches,
or uncommitted work.

On the publishing side, a rollback is a release of an older version that names
the version it replaces through the `UPDATE_ROLLBACK_OF` repository variable. A
release of an older version without that variable is refused by the release job
rather than published as a quiet downgrade, and the sequence still rises, so the
rollback reaches the installations that have already seen what it withdraws.

The release job enforces the same rule from its side: a version lower than the
one that channel already publishes is refused unless `UPDATE_ROLLBACK_OF` names
exactly that version, and a `rollbackOf` on a release that is not a downgrade is
refused too. A downgrade can therefore never be published by accident, only
chosen.

### Platform support

| Platform | Package                                              | Signing                                                                                              | Updated in place                                                                                                                                                                                                                                             |
| -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | `dmg`                                                | Developer ID Application for the app and for the image, notarised and stapled                        | Yes. The download is checked against the installed app's own signing identity, team, bundle identifier, version, and architecture, staged beside the running bundle and proved again there, then moved into the bundle's place and the app restarts into it. |
| Windows  | NSIS installer                                       | Authenticode, verified before it runs                                                                | Yes. The installer's Authenticode identity is compared with the installed app's own; the installer is then started, this app closes, and the update finishes on its own.                                                                                     |
| Linux    | AppImage, also covered by the packaged desktop smoke | No platform signature exists to check; the release's own manifest signature is what authenticates it | No. An AppImage is a single file the person runs from wherever they put it, with no installed copy to replace and no signature to check before running it, so in-place updates are unsupported there and a download is offered to run instead.               |

The release states the Linux policy in its own log on every Linux build — "linux:
best-effort artifact — built, published and signed, never updated in place by the
app" — and the step that prints it runs the shipped code to make it true: it
asks the installer what it supports on Linux, hands it a staged update anyway,
and requires a refusal that writes nothing, starts nothing and restarts
nothing. A Linux installer that appeared would make the app answer differently
and fail that step, which is the moment the policy line has to be rewritten with
it.

Signing needs a code-signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`), and
macOS notarisation needs an Apple developer account (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Maintainers have to configure
those as repository secrets; the release job fails closed when any of them is
missing, stopping before packaging rather than publishing an unsigned artifact
under a release name. Installing a real signed release is the acceptance step,
run on a machine that holds the real credentials, before a signed release counts
as delivered:

1. Publish a release and let the workflow run to completion. Every job must be
   green; a failed attestation, signature, or provenance step is not a release.
2. On macOS, confirm the shipped image and the application inside it are signed
   by the expected team, that `xcrun stapler validate` accepts the ticket, and
   that `spctl --assess --type open` accepts the image, on a machine that has
   never seen the download.
3. On Windows, confirm `Get-AuthenticodeSignature` reports `Valid` and the
   signer's subject matches the installed app's own.
4. Install the published release on a clean machine, then publish the next
   pre-release and let an installed build take it: the digest re-check, the
   native signature checks, the handoff, the replacement, and the relaunch all
   run only there.
5. Confirm the channel lock behaved: two releases published at once must leave
   one sequence per channel, and the second must have read the first's history.

Signing the disk image as well as the application inside it needs the private key
a second time, after the packager has already deleted the keychain it imported
the certificate into. The release job does that in a keychain that exists only
for the step: created with a password generated at that moment, unlocked only
there, given the partition list `codesign` needs, made the only keychain in the
search path so the identity cannot come from anywhere else, and deleted by a trap
however the step ends, with the earlier search path restored. The certificate is
written to a file the step owns, masked in the log, and removed. The signing
identity is the single distribution certificate in that keychain for the team the
release claims — matched by name and team rather than by a bare team selector,
because a selector is a search term — and none or several is a refusal rather
than a guess.

### An unsigned build is not a release

`pnpm run dist` run locally packages the app without a certificate, so the output
is a development package, not a release: it is not signed, not notarised, not
attested, and not offered to anyone else. It also refuses to install updates. A
packaged build takes its trusted keys from its own bundle and nowhere else, and a
local package carries none because only the release job injects one, so it
reports updates as not configured, and the app will not fetch a manifest or
install anything. An unpackaged `pnpm run dev` build may instead take one key
from `GIT_STACKS_UPDATE_KEY_ID` and `GIT_STACKS_UPDATE_PUBLIC_KEY` for fixtures,
and **Settings → Updates** says so when it is running on such a key; that path
does not exist in a packaged build, because whoever starts a process decides its
environment.

### Keeping the release key trusted

A released build's trusted public key is compiled into the main bundle during
packaging, so nothing on a user's machine can add, drop, or change it after
installation. Rotating it is therefore a shipped change with an overlap window,
not a switch someone can throw on an installed app, and it takes three releases
in this order:

1. **The new public key is committed** to `apps/desktop/resources/update-history-keys.json`
   and injected into this release through `UPDATE_SIGNING_ADDITIONAL_KEY_ID`,
   `UPDATE_SIGNING_ADDITIONAL_PUBLIC_KEY`, `UPDATE_SIGNING_ADDITIONAL_VALID_FROM`
   and `UPDATE_SIGNING_ADDITIONAL_VALID_UNTIL` — all four or none, or the
   release is refused. This release's manifest is still signed with the old key,
   so every installed build can verify it and installs the build that learned
   the new key.
2. **The next release signs with the new key.** The overlap carries the old key
   with an end date far enough out that no artifact it signed can still be
   offered — a manifest stops being offered 30 days after it was issued — so
   every build that installed step 1 can verify this one.
3. **The release after that retires the old key** by not declaring it. Builds
   from step 2 stop consulting it when its `validUntil` passes, and a key outside
   its validity window is never consulted at all, so the old key stops verifying
   then rather than whenever someone notices.

`apps/desktop/resources/update-history-keys.json` is what makes step 3 possible. A build only
carries the keys that are current, so once the old key is retired nothing in the
app can authenticate the manifests it signed — and the release that retired it
could not read the history it was replacing, which would stop the channel
outright. That file is the durable record of every public key that may sign a
channel manifest, so a release can still prove what it published last month. A
release refuses to publish a build carrying a key the file does not declare, and
the key is committed there _before_ it signs anything, in the same change that
introduces it. It holds public keys only, which every packaged build already
carries in its own bundle; a private key is never compiled into a build, never
committed to this repository, and never written to a CI log. The release job
signs with a secret held by the repository owner.

The other half of the same discipline is the publication order above: a sequence
is banked under a name of its own before the two fixed names move, so
interrupting a publication costs a sequence rather than the channel's history,
and a bank is never rewritten.

## Untrusted text

Text that arrives from outside this app is text, and it is shown as text. The
values a person reads but did not write are a pull request title and branch
name, a repository description, and a commit subject and author. They are
rendered as React children — `branch-workbench.tsx`, `collaboration-views.tsx`,
`review-view.tsx`, `onboarding.tsx` — so an author's angle brackets are
characters on the screen and never markup. There is no Markdown renderer in
this app and no sanitiser standing in for one: nothing parses a value into
elements, and nothing writes one with `innerHTML`.

`apps/desktop/scripts/update-flow-smoke.mjs` proves that in the real window rather than
asserting it about the source. It commits a subject that is
`<img src=x onerror="…"> <script>…</script> <b>bold</b>`, opens the repository
in the running app — where the branch card shows that subject as its commit
preview — and then reads the rendered document: the characters are present, the
deepest element containing them has no element children at all, nothing in the
window carries an inline `on*` handler, no `img`, `object`, `embed`, or `iframe`
appeared, and nothing the payload says ran. The commit list in **History** uses
the same React child for the same value; that view is not exercised by this
run, and the proof is of the surface in the screenshot. Release notes and refusal messages
arriving over a release signature are held to the same rule, in
`apps/desktop/tests/release-boundary.test.ts`.

## Onboarding

With no repository open, the window offers three ways in, and all of them end
with an ordinary Git working tree:

- **Search GitHub** lists the repositories the signed-in credential can reach,
  paged through the REST API. Selecting one opens a clone form with a
  destination folder, HTTPS or SSH, and an optional shallow clone. Before
  anything is written, the dialog shows the exact `git clone` and
  `gh repo clone` commands and copies either one to the clipboard.
  Copy confirmation resets when the displayed command changes. If the clipboard
  refuses the write, the command remains selectable and the copy control shows
  recovery guidance instead of silently failing.
- **Add local repository** opens the folder picker and adopts whatever is
  there. It is read, never written: adding a repository never rewrites its
  config, refs, or files.
- **Drop a folder** on the window. Drops are ignored while a repository is
  already open so a stray drag cannot switch workspaces.

The clone is built in an isolated staging folder (`.git-stacks-clone-${token}`)
beside the destination, in the same filesystem, and is promoted into place only
after it reads as a finished clone. Promotion is the single commit point, and it
is one atomic rename that refuses to replace anything already there:

- Darwin: `renamex_np(RENAME_EXCL)`
- Linux: `renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE)`
- Windows: `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`

Node exposes none of these, so they are reached through a small helper,
[`apps/desktop/native/promote-repository.c`](apps/desktop/native/promote-repository.c), compiled for the
host by `pnpm run build:promotion-helper` and shipped beside the Git runtime as
`resources/promote` in the packaged app. It does one syscall and then exits; it
never looks at the destination before renaming, so there is no window between
the check and the move. A destination that is already there — an empty
directory, a populated one, a file, a symlink — makes the rename fail and is
left exactly as it was, and the clone is refused as a collision rather than
clobbered, merged into, or emptied.

There is no fallback path. A kernel or filesystem without a no-replace rename,
a build whose helper is missing, and a destination on another volume are each
reported as refusals that name what happened, because the alternative —
checking whether the destination is free and then renaming over it — would
destroy a directory another program owns in the window between the two steps.
Nothing is written in any of those cases, and the staging folder this clone
minted is the only thing removed.

Cancellation is honoured up to the commit point and no further. A cancel that
arrives while the Git transfer runs, after the Git process exits, or during the
post-clone checks discards only the staging folder this clone created — its
name carries a random token minted for that clone — and registers nothing. Past
the commit point the clone is a finished repository in the folder the person
chose, so the switch that opens it and writes it to recents runs to the end: a
cancel that lands there completes the switch and reports the clone as finished.
Nothing removes a promoted folder afterwards, which is why recents and the
active repository can never name a folder that was deleted under them. An
activation that fails after the commit point is reported with the path left in
place rather than removing a repository the person asked for.

The onboarding pane also reports what this machine can already do with Git: the
commit identity, the default branch, whether a credential helper is configured
for HTTPS, and whether an `ssh` client is on `PATH`. Those are read-only facts.
Git Stacks never sets a Git credential helper, `user.name`, `user.email`, or
`init.defaultBranch`; a private HTTPS clone needs a credential helper the user
already has, and the dialog says so rather than configuring one.

Repository discovery lists accessible repositories with pagination, bounded by
GitHub's hard limit of 1,000 search results (10 pages of 100 items). Searches
returning `incomplete_results` (due to GitHub query timeouts) or exceeding the
1,000-result cap surface clear inline warnings prompting the user to refine
their search. Small non-empty repositories whose size rounds down to 0 KB are
accurately distinguished from unborn or unpushed empty repositories.
Neither endpoint reports a repository the credential cannot read, and a
response that omits the optional `permissions` object is a hit, not a refusal:
it is listed, with its push access treated as unproven and the row marked read
only. Only a malformed entry — one that names no clonable `owner/name` — is
dropped.
Discovery sends one `Authorization` header to the selected host's API base (`api.github.com` for github.com) and nothing
else. Access tokens never reach a command line, a log, the renderer, or a
remote URL: the app-signed transport is used directly from the main process.

## Performance budgets

Git Stacks is used on repositories far larger than the ones it was built
against. The budgets below are exported from
[`packages/shared/src/performance.ts`](packages/shared/src/performance.ts) and are the single
value used by the main process, the renderer, the tests, and the benchmark
harness. There is no second copy of a budget anywhere.

| Budget                   | Value         | Enforced by                                |
| ------------------------ | ------------- | ------------------------------------------ |
| `STARTUP_BUDGET_MS`      | 10000 ms      | `bench:performance` → `startup`            |
| `SNAPSHOT_BUDGET_MS`     | 4000 ms       | `bench:performance` → `snapshot`, `status` |
| `HISTORY_BUDGET_MS`      | 2000 ms       | `bench:performance` → `history`            |
| `COMMIT_DIFF_BUDGET_MS`  | 3000 ms       | `bench:performance` → `commit-diff`        |
| `INTERACTION_BUDGET_MS`  | 250 ms        | `bench:performance` → `interaction`        |
| `LIST_PAGE_SIZE`         | 200 rows      | every repository-sized list                |
| `REVIEW_STACK_METADATA_LIMIT` | 32 members | one cancellable Review headline metadata batch |
| `DIFF_PAGE_SIZE`         | 1000 lines    | `DiffView`                                 |
| `MAX_STATUS_BYTES`       | 8 MiB         | `listStatus`, cut on NUL record boundaries |
| `MAX_HISTORY_BYTES`      | 1 MiB         | `getHistory`, cut on NUL record boundaries |
| `MAX_DIFF_BYTES`         | 4 MiB         | `getCommitDiff`, `changedDiff`             |
| `MAX_FILE_BYTES`         | 2 MiB         | working-tree file preview                  |
| `GIT_CONCURRENCY`        | 8             | `mapWithConcurrency`                       |
| `SNAPSHOT_BRANCH_BUDGET` | 1500 branches | per-branch analysis in `getSnapshot`       |
| `WORKTREE_READ_CONCURRENCY` | 2 reads | inventory status and watcher fallback |
| `WORKTREE_REFRESH_SETTLE_MS` | 400 ms | topology refresh coalescing |
| `LANE_ROW_PAGE_SIZE` | 64 rows | mounted bottom-up lanes |
| `LANE_RELATIONSHIP_PAGE_SIZE` | 32 rows | inspector children plus selected/parent |
| `LANE_CONTINUATION_PAGE_SIZE` | 20 continuations | off-page parent navigation |
| `SELECTED_DETAIL_CACHE_LIMIT` | 4 entries | main-owned selected PR detail cache |
| `LANE_INPUT_PAINT_BUDGET_MS` | 250 ms | actual warm lane input-to-settled-paint p95 |
| `LANE_PROJECTION_LAYOUT_BUDGET_MS` | 100 ms | lane projection plus measured DOM relationship layout p95 |
| `LANE_SCALE_HEAP_BUDGET_BYTES` | 32 MiB | post-GC 5000-object growth over identically warmed 250-object process |
| `LANE_NAVIGATION_HEAP_BUDGET_BYTES` | 8 MiB | post-GC growth after 30 navigation/read-refresh cycles |
| `LANE_WARM_SAMPLE_COUNT` | 20 samples | warm input/layout envelope |
| `LANE_NAVIGATION_CYCLE_COUNT` | 30 cycles | navigation/read-refresh envelope |

The retired `GRAPH_OUTLINE_ROW_LIMIT`, `GRAPH_DETAIL_NODE_LIMIT`,
`GRAPH_PATH_PAGE_SIZE` and `GRAPH_SELECTED_CACHE_LIMIT` map respectively to
lane rows, inspector relationships, off-page continuations and selected detail
cache. Their numerical values remain 64/32/20/4; all graph time/heap/sample limits
retain their values under the `LANE_*` names above. No compatibility aliases or
graph-camera/card callers remain. Complete inventory authority is independent of
mounted pages; the ordinary list budget remains 200, not a relaxed lane limit.

### Benchmarks

```sh
pnpm run build
pnpm run bench:performance
```

The harness builds its own fixtures with the local `git` binary — a working tree
of 100,000 files, 3,000 branches with distinct non-default tips (including
450 recorded stack members), a 5,000-commit history, and a commit touching
5,000 files. The snapshot benchmark exercises actual parent comparisons rather
than sharing the default tip across the fixture's branches. No clone, token, or
private repository is involved. Compare runs on the same runner class and
benchmark version; older measurements with different definitions are not
carried into the current trend.

The `startup` measurement runs the built Electron app against the 3,000-ref
fixture. It starts before process launch and ends after the Workbench inventory
reports all 3,001 local branches and its first 64 lane rows complete two animation
frames. The seeded repository opens directly; no onboarding activation is needed.
The `interaction` measurement starts at an actual input event in the
“Filter branches by branch, PR, or path” field and ends after the single matching
branch result completes two animation frames. Benchmark version 3 uses this
Workbench measurement contract, rather than the retired onboarding/list shell.
The separate `diff-render-ssr` measurement is server-side
rendering cost for a 1,000-line diff preview; it is not an input-to-paint budget.
CI installs `xvfb` and `xauth` on GitHub's standard `ubuntu-24.04-arm` hosted
runner, builds the app, materializes the pinned Electron distribution with
`pnpm --filter git-stacks exec install-electron`, and configures its
`chrome-sandbox` helper with root ownership and mode `4755` before running
Electron under Xvfb. Local runs need a display server and a supported sandbox.
Compare trend results on the same runner class and Git/Node versions,
since filesystem and process startup costs vary by machine. Hosted-runner
measurements start a new comparison series; the old self-hosted timings are not
a directly comparable baseline. The existing performance budgets still apply.

Desktop benchmarks retain Electron's OS sandbox. Linux runs need the official
pinned Electron sandbox helper installed with its supported ownership and mode,
or an environment that supports Chromium's namespace sandbox. A helper setup
failure is an unmet runtime prerequisite, not permission to use `--no-sandbox`
or `ELECTRON_DISABLE_SANDBOX` to report passing startup/interaction budgets.

The dedicated lane envelope uses the actual built, sandboxed Electron consumer.
It creates 250/1000/5000-object deep/wide/disconnected fixtures with 120 real
worktrees each, records 20 trusted-input warm samples and 30 navigation/read-refresh
cycles, and writes `apps/desktop/benchmarks/lane-envelope.json` by default:

```sh
pnpm run build
pnpm --filter git-stacks exec tsx scripts/perf/run-benchmarks.ts --lanes-only
```

`--lanes` adds this envelope after the ordinary benchmark fixtures instead.
Each packet records actual source hashes, hardware/runtime, viewport/motion,
mounted row/node/relationship counts, trusted main IPC and validated inspection
operation counts, p95 input/layout times, and explicit post-GC heap. Scale growth
compares identically warmed fresh processes against the 250-object baseline;
navigation growth compares before/after 30 cycles in the same process. Timings
end after the matching committed DOM and two frames, not merely after dispatch.
Counters contain fixed transport names only, never arguments, paths or credentials.
Owned benchmark processes strip inherited Git/GitHub session variables and isolate
Git/gh configuration. Only these runs enable ephemeral loopback main/renderer
inspectors; no test API or counter API is exposed to the production renderer.
Do not compare older graph/card/camera definitions or other runner classes as if
they were the same series. Do not fabricate an unrun packet or relax a budget.

It writes `benchmarks/latest.json` and appends one line per run to
`benchmarks/trend.jsonl` (capped at the last 200 runs). The `budgets` job in the
`Accessibility checks` workflow runs the general benchmark harness on main pushes
and manual dispatches, and on PRs affecting desktop production code or shared
dependencies. It uploads `benchmarks/` as an artifact and fails when any measurement
exceeds its budget. That command does not include the native lane envelope.

Manual dispatch additionally runs the independent `native-lane-envelope` job on
Ubuntu 24.04 x64 with a 30-minute job limit. It builds the production desktop,
explicitly provisions and verifies the pinned Git runtime, configures the supported
Electron sandbox helper, then runs the existing `--lanes-only` command under Xvfb.
The `native-lane-envelope` artifact retains `benchmarks/lanes/lane-envelope.json`
when produced, including source and hardware provenance and any exceeded budgets.
Missing or failed runs are not lane-envelope acceptance. See
[Selective CI](#selective-ci) for the conservative selection policy.

### What the hot paths no longer do

**One config read instead of two per branch.** `getSnapshot` issued
`git config --get branch.<name>.parent` and `branch.<name>.parentTip` for every
local branch. It now reads them all in a single
`git config --null --get-regexp` pass, using the same idiom the GitHub
integration already used for tracked pull request numbers.

**A concurrency ceiling instead of one process per branch.** Parent inference
probes distinct tips in batches; direct descendants of the default branch need
no individual merge-base process, while deeper histories use the existing
merge-base fallback. The same batched parent list answers the behind-count:
a branch whose recorded parent commit is one of its tip's parents already
contains that commit's whole history, so it reports zero commits behind with no
`rev-list` process at all. Every other branch still measures its behind-count
through `mapWithConcurrency` at `GIT_CONCURRENCY`, rather than forking one
process per branch at once.

**Behind counts answered from the parent edges already read.** The same batched
`log --no-walk` pass that infers a parent records each tip's direct parents, so
a base a branch already contains — a stack one commit down, or a whole recorded
stack — is behind by exactly zero and needs no `rev-list` of its own. A base
those edges do not prove is still counted by Git, one process per branch under
`mapWithConcurrency`, so the number a branch reports is always the number
`git rev-list --count <branch>..<base>` returns.
**A branch-analysis budget.** `SNAPSHOT_BRANCH_BUDGET` caps per-branch
merge-base and behind probes. A branch consumes one budget slot across both
phases: admission for parent inference also reserves its behind comparison.
Beyond the budget, recorded parents remain available, but inferred parents or
behind counts can be unknown.
`snapshot.limits.branchesSkipped` counts branches with incomplete analysis;
the Branches view states this limit rather than claiming an exact comparison.

**One index and HEAD-tree read instead of one process per batch of paths.** To
mark submodules and sparse-excluded paths, `getSnapshot` asked `getIndexEntries`
and `getHeadGitlinks` about every changed path. Each of those split the path
list into batches of at most 1024 pathspecs and forked one process per batch,
sequentially, so a working tree with 100,000 changed files forked ~200
processes that mostly returned nothing: the paths were untracked, and the
benchmark fixture has no commit, so `HEAD` had no tree to read at all. Both now
read the whole repository once in a single process and filter in memory:
`git ls-files -v --stage -z` for the index, and `git ls-tree -r -d -z HEAD`,
which recurses only into directories and so reports gitlinks without listing
every blob. The two reads are independent, so `getSnapshot` runs them together
and settles both before a rejection escapes. The batched pathspec read is still
used when it answers in a single process, so a caller that asks about one file —
a diff preview, a staging guard — does not read a large repository's whole
index. Both whole-repository reads stay capped at `MAX_STATUS_BYTES`. A cap that
truncates one falls back to the batched pathspec read, asking again about every
requested path rather than only the ones still unresolved. An unmerged path
occupies one `ls-files` record per stage, so a cap landing on a NUL boundary can
leave the straddling path half-read — and a half-read path is one the "still
unresolved" filter would have kept, reporting a gitlink as an ordinary file. The
fallback is rare (it needs a listing past the cap) and reuses the batched reads
this path used before. An unborn `HEAD` is a complete answer rather than a
truncated one, and is not retried.

**Streaming reads instead of buffer-then-copy.** `executeCapped` retains at most
its byte cap while the child process runs. Cancellation sends TERM, escalates
when necessary, and waits for the process to close before releasing the read
queue. Record-shaped output (status, history) is cut on NUL boundaries; history
accepts only rows with all five terminated fields.

**Incremental lists.** Branch, changed-file, pull request, stash, and
stack-member lists mount 200 rows initially, expand to 400 on the first reveal,
then slide a bounded two-page window on deeper navigation. Previous controls
return to earlier rows rather than accumulating the entire traversed prefix.
History holds one fetched page of at most 50 commits and navigates older/newer
pages. Diff regions expand from 1,000 to at most 2,000 mounted lines, then slide.
Branch-tree connectors and cycle/missing-parent warnings use each branch's
position in the complete list even after the two-page window slides.

Arrow keys address the mounted rows in mounted-window coordinates, so a move made
after the window has slid lands on the neighbouring mounted row rather than
re-basing onto the whole list. Only Home and End name the whole list, and they
slide the window to mount the row they land on.

### Stale results and cancellation

`RequestGate` (renderer) and `RequestRegistry` (main) together guarantee that a
result computed for a repository, ref, or commit the window has already left is
never applied to the one it now shows:

- `openRepository` resets the gate before awaiting, retiring every in-flight
  refresh, and the main process aborts old reads before waiting for the
  repository-switch operation to enter its queue.
- `readRepository` re-checks the active repository after the read completes, not
  only before it starts.
- A newer history page or commit diff claims the same request id, which aborts
  the previous one. Cancelled reads reject with `CommandCancelled`; the renderer
  drops them instead of showing an error.
- A read cancelled while still queued in `RepositoryOperations` never starts.
- Cancelling a file view also stops its fingerprint scan and waits for both
  diff commands and the fingerprint task to settle before the next repository
  operation starts; mutation preflight reads remain non-cancelable.
- A mutation is refused only while another mutation or a repository switch is
  pending, or once the repository it was asked for is no longer the one the
  window shows — a switch can complete while the action is still waiting for
  the background reads it ends. It is never refused because a read is still
  being answered. Reads and writes share one queue, so a mutation submitted
  during a read runs after it, and no other write or switch can interleave with
  it; what the action then checks is that action's own business, unchanged by
  the wait. A repository switch refuses mutations for as long as it is pending,
  so an action asked for against the repository being left cannot land on the
  one the window opens next.

An expected cancellation is transported as an answer, never as a failure. Main
resolves a cancelled command with the internal token `{ commandCancellation:
true }` — exact and one-field, so no genuine result collides with it — and
records no failure, prints no Electron handler error stack and publishes no
success. The shipped preload decodes that token back into the plain rejection
`{ name: 'CommandCancelled', message: 'The request was cancelled.', cancelled:
true }` before any `DesktopAPI` promise exists: a native `Error` crossing
`contextBridge` keeps only its message, so the answer has to be plain data to
stay recognizable. No `DesktopAPI` caller receives the token as a value, and
genuine failures keep the whole error path — record, console and renderer —
unchanged.

### Documented limits

These are the extreme cases the app states rather than hanging or crashing on.

- **A changed-file listing past 8 MiB.** The listing is cut on a record boundary
  and `limits.filesTruncated` is set. The selected directory's read-only Changes
  panel labels the listed files as a lower bound. No partial listing authorizes
  staging, committing, discarding or stashing; develop in an editor or terminal.
- **More branches than `SNAPSHOT_BRANCH_BUDGET`.** Reported through
  `limits.branchesSkipped`, as described above.
- **A diff past `MAX_DIFF_BYTES` or a file past `MAX_FILE_BYTES`.** The
  backend retains only the bounded preview. The desktop diff view separately
  limits rendering to the first 512 KiB of text and mounts at most 2,000 lines
  after reveal. Truncated previews are labelled; inspect the complete change
  in an editor.
- **History is paged, not accumulated.** A repository with a million commits is
  navigable one page at a time without retaining previous pages.
- **An individual history entry over 1 MiB.** The reader reports a preview
  limit error instead of presenting a partial entry as the end of history.
- **Pull request enumeration is collected before display.** The renderer reveals
  pull requests incrementally; the main process collects the origin's open pull
  requests through paginated GraphQL reads on the host's typed transport, then
  reads any locally tracked pull requests missing from that listing individually.
  Follow the [GitHub sign-in](#github-sign-in) instructions, and configure the run
  to authorize the CLI for the targets and provider state it is configured to use
  and for nothing else; a controlled suite brings its own profile, and an automated
  check is never pointed at a personal or default session. The live end-to-end
  suite stays a deferred development gate whose evidence is the owner's manual run;
  it is not an authentication-policy waiver.

## Selective CI

The `Accessibility checks` workflow uses one selection job for the stable
`automated`, `design`, and `budgets` checks. Pull requests select affected workloads;
every `main` push and `workflow_dispatch` runs the full existing nonvisual renderer,
catalog behavior, typecheck, keyboard/component unit, and performance workloads.
Visual baselines remain separate host-specific checks: desktop on macOS, catalog
on its documented macOS arm64 or Linux x64 baseline host.

Every `main` push and manual dispatch also runs the independent `root-suite` job
on native Ubuntu 24.04 x64 with Node 24 and the pinned Playwright Chromium. It
installs frozen dependencies and executes the normal root `pnpm test`, including
the complete desktop unit suite and design manifest/nonvisual browser tests, under a
30-minute job limit. On main pushes it is a required dependency of the explicit
signed beta release call alongside all existing checks, even for docs-only
pushes. PR selection is unchanged; PRs and manual CI dispatch do not publish.

The separate dispatch-only `native-lane-envelope` job measures the real production
Electron application at 250, 1000 and 5000 objects with 120 concurrent worktrees.
It retains the existing first-page, input, layout, mounted-window, request and heap
limits; the general `budgets` job remains independent and unchanged.

`scripts/ci/select-checks.mjs` is the single dependency-free Node 24/Git policy.
The workflow runs its permanent regression suite once before dependency installation,
browser/display setup, or builds; `pnpm test` also runs those regressions.
The PR comparison is `merge-base(event base SHA, event head SHA)..event head SHA`,
not the merge checkout's parent diff. Selection fetches complete checkout history
and explicitly requests both event commits. Checks test the normal Actions checkout
(usually GitHub's PR merge revision); the job summary records that checkout and
the PR head used for selection. Missing history/commits, unknown paths, and common
workspace/build/test tooling conservatively select all relevant checks.
NUL-delimited Git status parsing includes both rename/copy paths and deleted paths;
a selected spec absent from the tested checkout expands to the full renderer.

Node bootstrap explicitly disables `setup-node`'s automatic package-manager cache:
the selector and skip-validation jobs need Node before pnpm is installed.
Enabled workloads install the pinned pnpm afterward; no package-manager or
dependency setup runs solely to validate an intentional skip.

- Root documentation and `.agents/skills/` standalone skills skip expensive checks.
- `apps/design/` selects catalog validation, tokens, build and tests plus the
  design workspace typecheck, without desktop browser/performance work.
- `packages/ui/` and `packages/shared/` select both consumers, desktop performance,
  full typechecking and the existing keyboard/component units. Contracts including
  `types.ts` are intentionally broad.
- Audited renderer boundaries are Notification Center (including Settings, CLI and
  form consumers), inventory query hook, review conversation/diff (including sibling
  workspace/navigation/snapshot consumers and conversation's CLI surface), and PR
  Inbox (including Review entry).
  They select existing feature specs plus accessibility, keyboard, safety and
  motion/zoom suites. The maps follow bounded production imports and cross-feature
  behavior; changing their consumers requires reviewing these maps.
- Shell/global styles, shared controls, unknown renderer modules and common
  fixture/helper infrastructure select the full nonvisual renderer. Changed/new
  nonvisual specs select themselves; visual/other fixture paths expand broadly.
- All desktop production code and shared dependencies retain performance coverage:
  the benchmark measures actual startup/interaction and imports renderer diff/list
  code. Runtime/main/preload/native/build/performance tooling is never excluded.
  Desktop source/config/test changes independently retain desktop typechecking;
  `build:gallery` alone does not typecheck desktop. Renderer and shared UI changes
  conservatively retain both existing tree-navigation and component unit suites.

Mixed changes form a union; broad rules override narrow files. Plans distinguish
`skip`, `files`, and `full`, with reasons shown in logs and summaries. Stable jobs
fail on failed/cancelled/missing selection, malformed/inconsistent outputs or any
selected step failure; only a validated intentional skip succeeds. File arguments
are passed directly to Playwright (escaped as native file expressions, never shell
interpolation), with `@visual` excluded and the root Turbo gallery prerequisite
preserved. Discovery and a nonempty execution reporter reject zero runnable tests
or a selected file that unexpectedly executes none, including runtime skips of
tests that were runnable at discovery. Intentional static skips remain excluded.
Existing timeouts, assertions, retry policy, Electron sandbox and failure/budget
artifacts are unchanged.

Reproduce selection and checks from the repository root:

```sh
node --test scripts/ci/select-checks.test.mjs
CI_BASE_SHA=<base-commit> CI_HEAD_SHA=<head-commit> node scripts/ci/select-checks.mjs
# Inspect the JSON plan, then pass that JSON as CHECK_PLAN:
SELECTION_RESULT=success CHECK_PLAN='<plan-json>' node scripts/ci/run-checks.mjs typecheck
SELECTION_RESULT=success CHECK_PLAN='<plan-json>' node scripts/ci/run-checks.mjs unit
GALLERY_PORT=5327 SELECTION_RESULT=success CHECK_PLAN='<plan-json>' node scripts/ci/run-checks.mjs desktop
SELECTION_RESULT=success CHECK_PLAN='<plan-json>' node scripts/ci/run-checks.mjs catalog
pnpm run build
# With a supported display and Electron sandbox, for selected performance:
pnpm run bench:performance
```

The selector regressions run before the root `pnpm test` workspace suites. Pure
policy/parser/file-expression checks and disposable Git/CLI checks are portable;
Git fixtures use Windows-valid filenames while pure parsing retains newline cases.
Only the runner's extensionless shebang stand-in is skipped on Windows, where
direct executable lookup cannot run that POSIX fixture. Disposable CLI environments
clear inherited Actions event/output variables; a separate payload regression proves
that real PR payload commits take precedence over explicit fallback SHAs.

Selective coverage does not establish that full suites fit runner deadlines.
Linux x64 local evidence is not proof for the Ubuntu ARM Actions worker; actual
hosted-runner completion remains a separate gate. Do not raise timeouts, add
retries, drop assertions or disable the sandbox to conceal stalls.

## Renderer verification

These fixtures exercise Git Stacks, not the Journey prototype. Production React components, tokens, and the real `App` are imported by a separate Vite entry point under `apps/desktop/tests/renderer`; the packaged renderer does not expose a fixture route or install a fake desktop API.

### Integrated v5 cutover and matched visual evidence

The current visual/product contract is [#243](https://github.com/howarewoo/git-stacks/issues/243)
and root [DESIGN.md](DESIGN.md#layout), not historical graph parity. The immutable
[`git-stacks-workbench-v5.html`](apps/desktop/tests/renderer/references/ui-243/git-stacks-workbench-v5.html)
is the unmodified approved reference from retained commit
`40ade209a2855c68a2834e3d49d96814432c5f3a`, SHA-256
`e46de09e3502ac917589b4fb1c2f3cb0419f2f9cadb899709bed5a5adc3e3db2`.
The linked original ZIP's SHA-256 is
`8b0d48f11e774a365f621b0b8f8496380b8f1efddcb808f2f804bc533f1e5a44`.
Biome excludes this reference rather than rewriting its bytes.

The production `App` mounts `BranchWorkbench` from
`apps/desktop/src/renderer/src/components/branch-workbench.tsx`, not a Foundation
specimen or prototype route. Its readonly presentation facts come from main-owned
inventory and captured inspection, with qualified repository/ref/worktree/PR
selection. Missing facts stay unknown; readiness does not grant mutation authority.
The shipped entry has no fixture API, hash-based specimen router or development UI.

Count fields are nullable complete source totals, not mounted-row counts.
Partial/unavailable totals display Unknown. Compact and standard density retain
the reference hierarchy; unpublished local commits, published heads, native
membership and worktree status remain separate facts.

Only the separate gallery imports fixtures and specimens. `#/app` consumes the
actual production App through the typed desktop double. `cutover-reference` feeds
approved source facts through the genuine inventory/inspection dispatcher;
`cutover-250`, `cutover-1000` and `cutover-5000` include 120 directory contexts and
an independent clone. `cutover-inspection` supplies selected-directory dual edits,
rename preimages, Unicode untracked bytes and a 2400-line bounded preview.
The standalone `#/workbench-v5` is a composition specimen, not production cutover
or native evidence. Fixture intent logs never establish Git/provider success.

After the normal type/build prerequisites, from the repository root:

```sh
GALLERY_PORT=5264 pnpm --filter git-stacks exec playwright test tests/renderer/cutover.spec.ts tests/renderer/cutover-integration.spec.ts tests/renderer/workbench-v5.visual.spec.ts tests/renderer/destinations.visual.spec.ts tests/renderer/dialogs.visual.spec.ts
```

The matched suite captures the unchanged reference and actual App at 1536×1000,
1440×940, 1000×700, 1180×820 and 1920×1080 in both themes, with matched compact
density, registry selection and initial scroll. It attaches reference/consumer/
side-by-side/50% overlay images and actual source fingerprints beneath
`apps/desktop/test-results/renderer`. Current surface/dialog/state suites attach
candidate captures; they do not re-pin historical macOS baselines or mark parity
accepted. Review differences explicitly, including narrow shared Sheet adaptation,
native title-bar space and accessibility targets. Hierarchy, bottom-up edges,
pane proportions and scope may not be dismissed as equivalent functionality.
Browser evidence is not native zoom, manual assistive technology or provider writes.

`WorkbenchPane` is exported by `@git-stacks/ui`: persistent `header` and optional
`footer` slots surround independently scrolling children; `bodyClassName` styles
the owned scroll region. It uses existing surface/radius tokens and is exercised
by the catalog's bounded Git composition as well as the actual desktop consumer.
Branch relationship layout remains desktop-owned.

### Historical ui-131 references

These references are retained history, not current v5 baselines or obligations to
reintroduce development destinations. Do not overwrite or delete their bytes.

The immutable #131 Stacks reference is
[`approved-stacks-demo.html`](apps/desktop/tests/renderer/references/ui-131/approved-stacks-demo.html),
downloaded from the [approved original demo](https://github.com/user-attachments/files/33138100/Git-Stacks-Large-Repo-Demo.html).
Its SHA-256 is `972d767ffb2607ea0dc91288255adb4160dd393116da6cab4cc807cbd4d13f7d`.
The [original parity plan](apps/desktop/tests/renderer/references/ui-131/original-parity-plan.md)
has SHA-256 `6fbd6fe294b3cffbd897d229ee8f30030e7bc0ea88cd2a1d56a69c5df8383c88`.
The demo is a visual reference only; its simulated or disabled controls are not
feature-parity evidence and its runtime is not imported by production.

The frozen production captures preserve Review panes, working changes/conflicts,
operation preview/recovery, onboarding, PR Inbox, independent Notifications, and
all nine Settings sections in both themes at 1000×700, 1440×940, and 1920×1080.
The repository-owned images live beside the approved demo. Ordinary renderer
tests must not overwrite these approved references. Updating them requires an
intentional visual review of the changed composition against the frozen reference
in both themes and all three sizes, with the reason and replacement evidence
recorded in the associated pull request. The one-time capture collector was
removed after the reference freeze.
These fixture captures prove renderer composition, not native Git success,
OS window behavior, VoiceOver, actual browser zoom, signed updates, or final
integrated graph parity. Existing packaged smoke and manual gates remain required.

### Production Workbench context and inspection

The production `App` mounts the shared v5 `BranchWorkbench` composition. The
sidebar owns pinned repositories, global search, cross-repository Attention and
Activity, and repository Branches/Pull requests. Review uses the existing wide
`ReviewView`, including original durable drafts. Settings, onboarding, optional
Notifications and explicit operation/recovery dialogs remain secondary consumers.
Stacks, standalone Changes/History/Stashes, graph camera/cards and top repository
tabs are retired. Historical references and Git domain/recovery readers remain;
obsolete graph-preference files are left untouched on disk, not replayed or deleted.
Live shortcut IDs are `view.attention` and `view.settings`, not retired Inbox/
Diagnostics routes. A one-way settings reader/explicit legacy-storage import
preserves authored chords, gives canonical choices precedence, and never rewrites
the stored file merely to read it; no live action aliases remain.

`projectWorkbenchInventory` joins genuine main-owned qualified repository/ref/
worktree/PR identities. A local branch pairs with its configured tracking upstream
into a single row while keeping physical ref identities, tips, and delete capabilities
distinct. Standalone remote rows remain only for unrepresented remotes. Local clones
remain separate even when their remotes match. Main resolves `Branch.parentRef`;
renderer display names and tracking upstreams never establish parentage, and feature
branches tracking a remote default branch do not become trunk. Published head/base
and native stack membership are independent facts. Branch commit count measures
parent-relative commits (`parentOID..branchOID`) against a fenced main-resolved parent
endpoint. Paired rows explicitly label the local branch count; standalone remote rows
count their own qualified remote tip. Neither upstream-ahead counts nor published PR
bases substitute for that dependency. Dependency fields and their semantic revision
travel together in the inventory; unchanged observation timestamps do not trigger
live provider snapshots, and retained inspector detail cannot supply an old no-parent
decision. The selected count revalidates relationship and consumed provider authority
before and after reading Git. Local directory facts remain available while inspecting
ref-only remote history; detached HEAD history retains its exact worktree authority.
Count provenance is visible in status/navigation labels as well as accessible names;
unavailable, partial, stale and not-applicable observations remain distinct, never
passing checks, a clean directory, or a fabricated zero. Cache-only operation observers
use `skipToken` to mount under zero-lifetime cache without missing query warnings.

Snapshot status disables optional Git index writes per command, so a clean-index refresh
cannot invalidate its own watched inventory collection. Bounded PR pages, layers and
inbox reads update the same confirmed provider payload consumed by dependency resolution.
Their generation/read ordering is checked at admission and again after the caller's final
await before inventory publication, including across independent clones. Bounded metadata
does not refresh full-list timestamps or issue coverage, and a replacement published head
cannot inherit unobserved checks or review certification from the previous head.

`projectBranchLanes` is deterministic iterative postorder: children above actual
parents, shared ancestors once, invalid/cyclic/foreign endpoints without edges.
The authoritative model is separate from the unchanged `LANE_ROW_PAGE_SIZE`
mounted page. Off-page parent continuation controls page independently and locate
real relationships; filters retain labelled ancestors without inventing edges.
Bulk selection includes only eligible matching local branch IDs on the current
page, never trunk, context rows or unmounted matches; it resets as view scope changes.

`workbench-context.ts` stores versioned view-only per-repository memory: exact
selection, surface, inspector tab/directory, filters, folds, density, page and scroll.
It is not a settings store, remote cache or authored-draft/operation journal.
Account retirement cancels captured reads and retires PR targets without deleting
original authored text. Attention/Review return restores the originating surface.
Global search is independent of local lane filters and includes full path/ref-kind
context, debounce, bounded pages, keyboard selection and explicit read errors.
Branch-only selection resets the directory and tab atomically; worktree selection
retains only the exact chosen directory. Pending Attention→Review navigation and
delayed explicit folder registration activation are fenced by newer inspection
navigation; registration itself still completes and must be confirmed by inventory.
Same-owner pending repository reads keep their prior qualified inspection answer;
API or provider-owner replacement cannot reuse it. Qualified Review stays mounted
across sidebar destinations, retaining Code scroll, selected lines and original
unsent composition. Explicit narrow inspector dismissal survives readonly updates.
The single shortcut dispatcher observes the existing confirmed settings query,
including live remaps.

Returning from Review restores focus to the original qualified branch or source
entry as well as its controlled filters, page and scroll. If the selected branch
is outside that unchanged mounted window, focus returns to its initiating
inspector control rather than silently paging/scrolling. Qualified PR/Attention
entry keys survive title/fact updates. A newer repository, surface, selection or
primary account retires pending focus; no old private entry transfers to a
replacement principal. Branch search accepts bare and `#`-prefixed PR numbers.

`DesktopAPI.inspect(context, operation, args, requestId)` is the typed captured-read
boundary. Main validates sender and the fixed operation table, resolves registered
repository authority, freshly discovers and verifies worktree administrative/path
identity, and validates qualified ref/PR associations before dispatch and again
before publishing a completed result. The captured common/worktree identity, ref/
HEAD and raw/resolved origin must remain unchanged; cancellation is checked at
completion. Provider origin getters reject another origin, and provider/editor
dispatches revalidate after preceding awaits. Remote inventory adoption occurs only
after that completion fence. Cancellation retires only that captured boundary
request, not a running mutation. The renderer `inspectionAPI` facade never falls
back to the active root or exposes Git actions.
`worktreeStatus` is available only on this captured facade: a bounded local status
read with no remote/graph/stash/history collection or recovery replay.
Snapshot and captured conflict inspections skip automatic journal/lock recovery.
Captured historical comparison never fetches missing Git objects: it uses local
objects, a validated provider endpoint comparison, or an explicit unavailable
result. Existing explicit operational recovery and object-fetch behavior is retained.

The actual App fixture dispatcher keeps mutable per-directory snapshot sources,
admits refresh/status answers when the request starts, and projects watcher
snapshots into the genuine inventory subscription. Explicitly supplied typed
inventory remains authoritative. Held reads cannot adopt a newer snapshot on
release; linked-directory HEAD/index/file facts remain exact to that directory.

Overview, Changes, Checks and Discussion belong to the exact selected context.
Multiple associated directories require an explicit choice. Changes shows staged
HEAD→index and unstaged index→directory independently, including dual edits,
untracked/rename/conflict stages and binary/LFS/submodule/sparse/truncation facts.
Files, histories and diff lines use shared canonical page/byte budgets. No local
editing, staging, commit, discard or stash lives in the inspector. Explicit named
management actions open separate captured previews from its footer, row menus and
command palette; they are not implied by selection. A PR without a directory opens
published committed Review, not a local working diff. Copy and configured editor
handoff use the exact chosen path, with explicit multi-worktree choice and useful
no-choice/missing refusal. Main revalidates before launch; missing directories
are not substituted. Overview shows readable directory/revision/observation facts,
not opaque authority IDs or index fingerprints; full local OID is explicitly disclosed.

### Captured safe operations

`DesktopAPI.captureOperation(context)` requires an explicit discovered worktree.
Its single-use `OperationCapture` names the common-local repository, worktree,
physical directory/common/admin incarnations, HEAD, paused commit, complete refs,
index/status/content/dependency fingerprint and original public provider authority.
`executeOperation(token, action)` spends that authority before entering the common
repository mutation lane. Main revalidates it under the participating journal lock;
inspection, selection and the ambient open repository never authorize a write.
Independent clones remain separate local domains even when their remotes match.
These locks exclude participating app operations, not external tools or agents.

Nominating a target registers with the repository, not with the window: an
explicitly qualified operation may address the registered common repository's own
root or one of its currently discovered worktrees the window is not showing, and
the approval is minted for that exact directory. Everything else still answers
only through the inspected or active authority, and registration is the only
fence this relaxation makes — physical-directory incarnation, origin, provider,
host-generation and captured-approval validation run unchanged across the
capture, safety, execute, records, inspection and management callers.

Prepared reads carry `InspectionContext.operationToken`, binding preview dispatch
and publication to the original provider and physical authority across intervening
awaits. Restack, Sync, publication, surgery, reviewed merge, native registration and
worktree lifecycle use the real existing main engines and typed preload boundary.
Hidden/unloaded dependency members participate base-first; incomplete full-scope
facts refuse the operation instead of shrinking it to visible rows. Branch hints,
tracking, published PR bases and provider-owned native membership remain distinct.
Every Git/ref/config effect finishes its evolved target and ordinary capture/discovery
preflight before the original-owner dispatch fence. The main provider validator brackets
its final private credential await with Git's effective configuration (including conditional
includes, worktree config and URL rewrites); its final bounded Git configuration read is
synchronous and refuses any drift before synchronous Gitfile/admin/common binding and
physical incarnation checks. No later application preflight await occurs; the engine's
own HEAD/index checkpoints may evolve. This fence does not replace remote leases.
`operationSafety(token, preview)` is read-only: it validates the existing original
approval and retained stack/native/lifecycle plan, never mints a replacement or consumes
the token. Open forms inspect this original owner on live inventory/provider changes,
focus and a five-second cadence; drift latches the approval retired while authored
titles, bodies and selected targets remain unchanged. A fresh preview is explicit.
Safety-retired stack/surgery offers expose **Reload preview** for the same original
physical/provider owner. Authored names, titles and bodies survive; original preview
identities remain retired, and force, typed confirmation, close and base-write consent
must be given again. Text for a layer leaving the offer or becoming an existing PR
stays separately disclosed as an original authored draft, not claimed as current PR
metadata or sent outside the fresh offered scope. Provider-owner retirement cannot
silently move that draft to a replacement principal. Fresh PR metadata forms use only
their own provider snapshot/generation, never an unrelated spent local Git approval.
Captured progress reads and events use the minted `OperationCapture.scope` through
its original qualified inspection API, not a UI cache identity or ambient journal
reader. The persistent Workbench shell owns publication/merge subscriptions, initial
reads and query observers while a modal is hidden. Dialog teardown cannot remove
those outcomes; an unavailable later read keeps the last confirmed result visible.
Foreign scope events cannot replace immutable saved choices, and status inspection
never dispatches Resume automatically. Attention full-list saved-filter writes wait
for the current store reread, even when an older successful answer is cached, and
remain single-flight so a stale list cannot erase independently authored filters.
Publication review discloses full local/base/remote-lease OIDs, push effects and original
native membership/resulting order. Reviewed merge discloses its full base-first
downstack and the membership included in the selected request.
Local replay switches only the explicitly disclosed execution directory and refuses
to overwrite ignored contents. A branch without a directory requires an explicit
eligible existing execution choice; there is no implicit primary activation,
checkout, stash, reset or creation of an isolated contribution workspace.

**Operations and recovery** and Activity retain main-owned records independently of
a modal or current repository. Synced owner-only records live in the common
directory's `git-stacks-operations`; original captures, actions and previews remain
immutable. Stable recovery IDs prevent historical approvals from borrowing a newer
journal at the same path. Continue, current-commit Skip, Abort, publication retry
and dismissal require the original physical/provider authority and original force,
close and publication choices. Later explicit completion, abort or dismissal is
projected without rewriting the original approval. Unknown dispatched pushes,
retargets, closes, merges and native requests are not blindly replayed. Readback may
adopt only source-confirmed effects; an unchanged pre-state does not prove a
dispatched write failed. Hiding a running operation does not abort it; independent
inspection and its durable status remain available.
Strict merge authorization distinguishes missing secondary history from malformed or
unreadable history and also consults retained original durable merge intents. A bad
history is neither empty nor repaired by inspection and cannot authorize another write.
Worktree creation qualifies an absent normalized destination and an explicit local
branch or new branch from a captured base. It never switches an existing checkout
or falsely adopts a failed/partial creation. Cleanup preflights the exact whole
subset and excludes primary/bare, locked, detached/unborn, missing/uncertain,
dirty/untracked/**ignored**, active/interrupted, unmerged and unpublished contexts.
Ignored files are unpublished local data: Git itself deletes them without force.
Cleanup requires an observed source-qualified `origin/HEAD` landing ref and OID;
display-name fallbacks and `init.defaultBranch` do not prove a tip landed. Assume-unchanged
entries and materialized skip-worktree contents are excluded without changing index
flags; genuinely absent sparse entries remain distinguishable. Incarnation-qualified
unresolved operation owners are retained for recovery, with unreadable history refusing
the whole batch. Validated later terminal recovery excludes immutable historical paused
records, but live retained progress still blocks. Original lifecycle previews also retain
each target's physical/common/admin authority separately from the execution owner:
an unconfirmed removal of B from A protects B's same incarnation against fresh-token
replay; unknown target authority fails closed, while confirmed and proven not-run peers
do not become permanent blockers. A postdispatch child interruption remains unconfirmed,
retains known partial effects and stops successors, not reported as a no-effect failure.
Every directory is revalidated before removal; completed/failed/not-run/uncertain
partial effects are retained, never called a rollback. Removing a worktree retains
its branch and PR; registration-only removal and protected local/remote branch
deletion are separately named captured operations. Local batches use a ref
transaction; multi-remote-ref deletion requires atomic push and exact leases, with
no non-atomic fallback.

Reviewed merge captures actual source-confirmed downstack membership and live
head/base/rules/check/review/permission/default/direct/queue evidence, including PRs
without local branches. Accepted, pending, enqueued, confirmed, failed, dropped and
unconfirmed outcomes remain distinct. It never implicitly restacks, fetches,
checks out, deletes or cleans up local contexts. Native create/extend/unstack
separately captures complete membership and canonical heads/bases; unknown prior
native dispatches cannot be turned into repeat writes by preparing another token.
Native create/extend independently read the written resource and prove exact order/head
membership before completion or legacy-navigation retirement. Unstack independently
proves captured unmerged members absent; dissolution requires an independently successful
complete collection read as well as resource absence. Unknown readback retains the intent.
Create PR always requires an exact-ref explicit execution chooser before capturing
publication authority. Local and remote deletion have separate qualified palette entries,
in addition to their separate destructive confirmations and backend protections.

Focused disposable regression coverage:

```sh
pnpm --filter git-stacks exec tsx --test --import ./tests/setup/owned-cli-boundary.cjs tests/operation-authority.test.ts tests/worktree-lifecycle-dispatch.test.ts tests/sync-stack.test.ts tests/merge-runtime.test.ts tests/stack-surgery-github.test.ts tests/native-stacks.test.ts
```

Gallery action history proves renderer intent, not Git, IPC or live provider
success. Packaged native, manual assistive-technology, live provider and performance
acceptance remain separate verification procedures.

Useful focused checks:

```sh
pnpm run typecheck
pnpm --filter git-stacks exec tsx --test tests/workbench-model.test.ts
pnpm --filter git-stacks exec tsx --test --test-name-pattern="read-only conflict inspection|object-only fetch" --import ./tests/setup/owned-cli-boundary.cjs tests/conflict-resolver.test.ts tests/review-snapshots.test.ts
pnpm --filter git-stacks gallery --host 127.0.0.1 --port 4317
```

The gallery's default `#/app` mounts actual production source with a test-only
desktop double. The cutover harness records bounded rows/relationships, actual
read/write intent, watcher bursts, independent context restoration, late-read
retirement and read-only local comparison. Qualified durable draft/review suites
remain separate; local/provider authority and recovery regressions use disposable
real repositories. Native/manual/assistive-technology/provider acceptance and final
Electron timing/heap certification for #243/#255 remain **USER-DEFERRED**. Neither
compilation nor browser/model evidence passes those gates or permits sandbox changes.

CLI refresh has its own pending read generation and configured-host fence. A
status event retires only the configured-host read, and a late completion cannot
replace the current account or unlock a newer refresh. Local repository opening
uses the real registration dialog's independent single-flight lock through
inventory confirmation, not only through the native picker.

Optional Notifications retains separate inbox/credential errors and host-scoped
read/write admission. Consent submission enables the separately authorized module,
saves its credential and reads its inbox in that order, checking the original
host/generation between steps. Host changes retire old answers/errors and pending
credential UI; primary `gh` account changes do not erase this independent inbox.

### Integrated cutover coverage and manual-ready delivery

The five-member #243 implementation stack partitions code ownership as follows;
this is implementation coverage, not ticket closure or acceptance:

| Layer | Issues | Delivered production scope |
| --- | --- | --- |
| [Foundation #257](https://github.com/howarewoo/git-stacks/pull/257) | #244, #245 | Shared v5 composition, tokens, component placement and immutable references |
| [Workbench #258](https://github.com/howarewoo/git-stacks/pull/258) | #246, #247, #248 | Main-owned qualified inventory, shell/context/lanes and read-only inspection |
| [Collaboration #260](https://github.com/howarewoo/git-stacks/pull/260) | #249, #250, #254 | Provider-qualified lists/full Review, Attention and observed Activity |
| [Safe operations #262](https://github.com/howarewoo/git-stacks/pull/262) | #251, #252, #253 | Worktree lifecycle, captured/local/provider authority, scoped workflows and durable recovery |
| [Integrated cutover #255](https://github.com/howarewoo/git-stacks/issues/255) | #255 | Cumulative reconciliation, legacy retirement, exact budget mapping, actual-consumer harness and final-source manual package |

The delivery PR records exact final head/base/revisions, full native bottom-to-top
membership, exercised checks, source fingerprints, package paths/checksums and
retained resources. A draft PR, native stack resource or package is not a ready
state, CI pass, signed-release proof or permission to merge.

Residual #39 implementation and acceptance remain separately observable:

| Area | Current source/contract and useful regression entry | User acceptance still deferred |
| --- | --- | --- |
| #11 provider-owned authentication | `main/github-cli.ts`, `github-primary-record.ts`, `github-transport.ts`; `tests/github-cli.test.ts` | Installed provider CLI, host/account replacement and native integration |
| #18 review threads and original durable drafts | `ReviewView`, captured inspection and main review transport/journals; qualified renderer draft/conversation suites | Owned live provider review, native editing/AT and retained-owner recovery |
| #19 checks and rerun | `check-details.tsx`, typed captured check/rerun transport; `tests/pull-request-checks.test.ts` | Live owned provider rules/check observations and explicit rerun |
| #27 repository discovery/clone | Actual discovery dialog, `main/clone-repository.ts`; `tests/repository-clone.test.ts` | Owned clone destination, pinned Git/native promotion and manual error handling |
| #33 verified updates | Settings update state machine and `scripts/release-update-*`; `tests/update-security.test.ts`, `update-lifecycle.test.ts` | Signed release/channel/OS update installation and rollback |
| #34 controlled/provider acceptance | Owned CLI/API and disposable Git fixtures, packaged smoke and qualified operation regressions | Explicitly authorized disposable live targets/profile only; never default live writes |
| #38 GitHub hosts | Typed main host/capability transport; `tests/github-host.test.ts`, `github-host-server.test.ts` | Actual GHES/provider capabilities, permissions and unavailable/partial responses |

For a final-source manual run, use Node 24, the committed frozen lockfile, then
`pnpm run package` in the retained final allocation. Launch the freshly produced
unpacked executable, not a previous parent/Foundation artifact: Linux
`apps/desktop/release/linux-unpacked/git-stacks`, macOS
`apps/desktop/release/mac-arm64/Git Stacks.app/Contents/MacOS/Git Stacks` (or the
architecture-matching `release/mac` variant). The associated delivery PR identifies
the actual generated path and resource hashes. Windows packaged smoke is unsupported.
Use owned disposable repositories and isolated app/Git/gh state as described in
the packaged/manual procedures below; never personal repositories or inherited
provider credentials for acceptance. Keep source/package identity with every result.

Native sandbox/display prerequisites, manual assistive technology, real native
window/zoom/lifecycle, signed updates, live provider outcomes and final Electron
performance budgets remain **USER-DEFERRED** until the user runs them. An unsupported
sandbox environment is not permission to disable isolation, change helper privileges
or substitute browser intent for native proof. Implementation/draft delivery does
not wait on these external gates, and their absence is never recorded as passed.

### Fresh checkout

Use Node 24 and the committed `pnpm-lock.yaml`:

```sh
pnpm install --frozen-lockfile
pnpm --filter git-stacks exec playwright install chromium
pnpm run gallery
```

Open the loopback URL printed by Vite. No GitHub credentials, Electron preload, personal repository, external font, or chat artifact is required. The deterministic `DesktopAPI` double records requests in memory; it never executes Git, authenticates, or opens external URLs. Treat its action history as evidence of renderer dispatch only, not proof that a Git operation succeeds. The packaged smoke covers real local Git separately.

Append `#/index` for the scenario directory. Actual App scenarios use `/?scenario=cutover-reference#/app` and the test-only typed inventory/inspection double; no production fixture route exists. Canonical secondary specimens are `#/design-system-specimen`, `#/design-system-dialog-specimen`, `#/workflow-recovery`, `#/inventory-consumer` and `#/workbench-v5`; retired controls/shell/data aliases are not current routes.

For workspace refinements, exercise actual `#/app` at minimum/default/wide and
720×470 zoom-equivalent sizes. Test global search independently of the local lane
filter, full qualified names on the narrow rail, windowed keyboard focus,
per-repository selection/filter/fold/scroll restoration, and captured menus.
Inspection/navigation never dispatches Git. Current cutover captures remain review
candidates; do not replace historical macOS baselines to conceal mismatches.

For a broad pass, inspect Branches/worktrees, Pull requests, full Review, global
Needs attention and Activity. Settings, optional Notifications, discovery/clone,
captured operations, history, native management and recovery are secondary dialogs,
not replacement development destinations. Cover all Settings sections and Review
panes, unified/split Code, submitted threads/replies and original durable drafts.
Use both themes and minimum/default/wide/zoom-equivalent viewports; native chrome,
real Electron zoom and manual assistive technology remain separate user acceptance.

Include confirmed, empty, loading, stale, and refused reads, not only populated
lists. Check computed type roles, content insets, disabled gates, keyboard focus,
and local scrolling to lower controls. At the minimum window, scroll the sidebar
itself to reach its lower destinations; do not confuse its fixed footer with
page overflow. Long native-stack disclosures must fully reveal the selected
layer and retain keyboard navigation without reducing the collapsed Code
viewport's row budget.

Also exercise `ancestry-requires-restack` with the inspector shown and hidden
and tall `shell-no-repository` content at the minimum window. Branch identities
must remain readable beside state badges, onboarding must start within its
local scroll region, and Settings must leave the selected controls reachable.
`apps/desktop/tests/renderer/onboarding.spec.ts` covers clipboard refusal and retiring copy
confirmation when the command changes. Review intentional visual differences
before updating macOS baselines; keep run-specific screenshots and results out
of `DESIGN.md`.

The typed control surface is `window.fixture`: `actions` and `externalUrls` record dispatch; `calls` records reads and writes; `hold(method)` and `release(method, occurrence?)` control in-flight requests, oldest first (or targeted by `'oldest'` or `'newest'`); `failNext(method, message)` rejects one request; `answerNext(method, value)` answers one request with a value the producer itself would return, so a spec can put a read that ended on the wire; and `setScenario(name)` installs another scenario's answers into the double that is already installed, without remounting the App — the window keeps its destination, its state, and its reads in flight, and subsequent reads answer from the newly selected scenario's own repository (or refuse when it has none), while the repository already displayed is preserved until the user or application opens another repository or refreshes. That is what makes an in-place transition provable: a remount is indistinguishable from a first load, and every in-place transition — a read that ends, a read that is replaced, a read that names no account — would only ever be provable by reloading the page.

`pull-requests-checks-detail` and `pull-requests-checks-stale` are the checks
drill-down: the panel behind the row badge lists every check GitHub reported for
the pull request head with its source (check run, commit status, workflow run,
or expected), its own state, and whether the repository requires it, in separate
Required / Informational / Unproven groups. It also states its own currency, so a
report last read before a refused or rate-limited refresh reads as stale with the
reason rather than as the current state. `Refresh checks` forces a re-read,
`Watch checks` re-reads on an interval while the panel is open, and `Rerun`
appears only where the read proves the account may run workflows. The fixture
records `pullRequestChecks` and `rerunPullRequestCheck` in `window.fixture.calls`.

Review layout and navigation coverage lives in `review-workspace.spec.ts` and
`review-navigation.spec.ts`, alongside the existing diff, conversation, and
snapshot suites. Exercise `review-stacked`, `pr-inbox-queue`,
`pr-inbox-same-number`, and `pull-requests-checks-detail` in the real gallery.
For layout evidence use a long text diff, collapsed secondary context, unified
and split modes at 1000×700, 1440×940, 1920×1080, and the 720×470 CSS viewport
equivalent of 200% zoom. Count complete code rows inside the local diff viewport:
minimum eight and default fifteen, not merely a nonzero region height. Hold or
refuse reads to verify selection retirement and explicit unknown metadata.
For account-switch recovery with a moved PR head, publish the changed snapshot
after restoring the original CLI owner and preserve it through repository refresh.
Verify that saving the retained text does not re-enable submission at the old comparison.
Set a unique `GALLERY_PORT` and cap Playwright workers on loaded hosts:

```sh
GALLERY_PORT=5237 pnpm run test:ui tests/renderer/review-workspace.spec.ts tests/renderer/review-navigation.spec.ts tests/renderer/review-diff.spec.ts tests/renderer/review-conversation.spec.ts tests/renderer/review-snapshots.spec.ts --workers=1
```

Ordinary scenarios keep the row's check state when its drill-down is opened or
refreshed. A `none` state produces an empty report, not a synthetic passing run.

Workflow reruns require an explicit association with the selected pull request,
not merely a matching commit. Push-only CI remains visible without a rerun action.
Actions check runs join workflows by their check-suite IDs, never details URLs.
Effective required-workflow rules leave requirements unknown when their policy
cannot be represented by status-check contexts.

The conflict fixture implements `conflictView` with index stages and a captured fingerprint. The safety scenario verifies that choosing incoming content edits only the draft, then `resolveConflict` sends that content and fingerprint when the user explicitly stages it.
History recovery coverage holds a commit diff while a repository refresh changes
HEAD and fails the replacement history read; the branch picker and reload control
must remain usable, and retrying must restore the commit list.

| Area      | Gallery scenarios / exercised controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell | Actual `#/app`: pinned repositories, global/local search, context restore; no top tabs or old Details toolbar |
| Ancestry  | `ancestry-linear`, `ancestry-branching`, `ancestry-deep`, `ancestry-remote-consolidated`, `ancestry-missing-parent`, `ancestry-cycle`, `ancestry-requires-restack`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Read-only local inspection | `cutover-inspection`: HEAD→index / index→directory dual edits, rename preimage, Unicode untracked bytes, 2400-line preview; existing conflict/binary/LFS/submodule/sparse/truncated fixtures remain source inputs |
| History | Explicit selected committed-history dialog; no standalone development/history route or cherry-pick/revert controls |
| PRs       | `pull-requests-lifecycle`, `pull-requests-checks`, `pull-requests-checks-detail` (required failure, optional failure, running workflow, required context not yet reported), `pull-requests-checks-stale` (visibly stale report with rerun unavailable), `pull-requests-empty`, `pull-requests-unavailable`, `pull-requests-issue-links` (a closing-keyword link and a local contextual link on one PR)                                                                                                                                                                                                                                                                                                                            |
| Review    | `review-stacked`, plus `answerNext('reviewFiles', …)` for a deleted text file and a 1,200-line generated file: the deleted file is read, addressed, and commented on entirely through its base lines, and the generated file's window stays two pages wide while each reveal, including the one that slides it, keeps every mounted row on the line its gutter names; the file tree's rows are reached and opened with arrow keys and Enter without dispatching anything                                                                                                                                                                                                                                                          |
| Attention/Activity | Qualified inventory reasons, provider-PR deduplication, clone-local conflicts, unavailable facts, observed transitions; first snapshots are not historical events |
| Workflows | `workflow-preview-ready`, `workflow-preview-loading` (`release('stackPreview')`), `workflow-preview-blocked`, `workflow-preview-stale`, `workflow-action-error`, `workflow-partial-restack`, `workflow-conflict-recovery`, `workflow-operation-recovery`, `workflow-external-operation`; form validation, typed confirmation, and `hold('runAction')` for busy state                                                                                                                                                                                                                                                                                                                                                              |

```sh
pnpm test
pnpm run build
pnpm run tokens:check
pnpm run test:ui
pnpm run test:visual
pnpm run test:controls
pnpm run format:check
```

The gallery can also be built with `pnpm run build:gallery`; output is `out/renderer-fixtures`, outside the production entry. `test:controls` uses the pinned Playwright browser against this separate gallery, not an unsandboxed Electron specimen launcher.

Run `pnpm run test:ui` locally (or `pnpm --filter git-stacks exec playwright test` from root, or `pnpm exec playwright test` inside `apps/desktop`) for one combined visual/behavioral HTML report (separate invocations replace the previous report). Axe attachments retain violations and incomplete checks; rendered contrast measurements are report annotations. The `Accessibility checks` workflow runs the behavioural renderer suite (axe, contrast, keyboard, focus, 200% zoom, reduced motion) plus the shared keyboard/state-label unit tests on every push and pull request. Pixel baselines are macOS-only and stay a local gate. The committed images come from more than one macOS point release, so the exact platform, architecture, and pinned Playwright Chromium an image was recorded under are stated per run rather than asserted here for all of them; patch-level system-font drift is expected and tested through the programmatic design-system tokens check.

Baselines are committed images, and the pull request records the exact platform, architecture, and verification run evidence each image came from rather than maintaining transient author-only capture notes here.

Current visual harnesses capture actual production surfaces and scoped dialogs at five matched desktop viewports in both themes, alongside unchanged v5 comparisons. Candidate images carry source/context/call evidence and remain unaccepted until user review; historical images are retained, never relabelled as current passes.

### Packaged desktop smoke

```sh
pnpm run package
pnpm run test:desktop
```

On Linux, the unpacked Electron package needs its official `chrome-sandbox`
helper installed with root ownership and mode `4755`. After the frozen install,
run `pnpm --filter git-stacks exec install-electron` to materialize the pinned
official Electron reference distribution without launching the application.
Before an authorized
privileged installation, verify that the generated helper is a regular,
non-symlink file inside the workspace and matches
`apps/desktop/node_modules/electron/dist/chrome-sandbox` byte-for-byte; record its original
ownership and mode. Configure only that generated helper using existing
administrative permission, then run the smoke script directly against the same
package so repackaging does not overwrite the setup. Restore the original
ownership and mode after a temporary development verification. Do not disable
sandboxing, change privilege policy, or repair unrelated host services to make
this check pass. If the required installation cannot be performed, report the
packaged native checks as blocked rather than replacing them with renderer tests.

The smoke launches `release/mac-arm64/Git Stacks.app` by default on macOS and `release/linux-unpacked/git-stacks` on Linux; Windows is unsupported until its process-tree cleanup can be verified. `node apps/desktop/scripts/packaged-desktop-smoke.mjs --help` lists the explicit app-path option. It creates a disposable repository and local bare remote, isolates the Chromium user data, the temporary directory, the Git configuration and the gh configuration inside the workspace, strips inherited Git/GitHub and credential-shaped environment variables, and cleans the temporary workspace. On macOS the app inherits the host home directory, because the system only spawns the app's sandboxed helper processes against the home the password database reports: with a synthetic `HOME` the browser process never brings those helpers up and stops answering on its own DevTools endpoint, so the smoke can never reach the renderer. Nothing the app, git or gh reads comes from that home — user data is the redirected `--user-data-dir`, and `GIT_CONFIG_NOSYSTEM=1` with an empty `GIT_CONFIG_GLOBAL` and a disposable `GH_CONFIG_DIR` keep the machine's own Git identity, credential helpers and GitHub login out of the fixture. A `browserType.connectOverCDP` timeout on the first `/json/version` request is that dead endpoint, not a slow start. Reports and failure screenshots remain under `out/packaged-smoke/<timestamp>/`.

The packaged executable, preload bridge, CSP, window lifecycle, real 200% page zoom, external-link policy, and local Git workflows are exercised rather than inferred from a dev server. No GitHub mutation or personal repository is used. Native window-state API checks (minimize/restore document visibility and bounds, maximize/unmaximize) are not physical title-bar-button or VoiceOver verification; record those manual boundaries separately. The shared isolated desktop fixture is installed before the production main loads (an early Node-inspector pause, `--use-mock-keychain` and `--password-store=basic` on the launch), so this proof covers the actual shipped bundle and CSP under synthetic credential sealing: it is not a proof of the native OS secret store, and it is not proof of a signed release.

Current local Git probes use explicit captured authority: fixture-only Fetch,
new linked-worktree creation preserving the primary HEAD/index, exact
read-only Unicode status/file inspection, an explicit capture on a linked
worktree the window is not showing, and operation records that keep enumerating
the non-active primary journal entry after a second repository registers. A
later probe dispatches a genuinely provider-backed read against that second
repository on the gh-hosted origin interaction name, suspends it on this run's
own API hold before dispatch, cancels it from the page world and asserts the
plaintext cancellation fields with no new handler error line, while a genuine
failure keeps its error stack. For that read the second repository's origin is
pointed at this run's own provider route (the primary keeps its disposable
local origin), and both the origin and the controlled CLI the credential check
retires are restored afterwards. These probes do not stage, commit, stash,
switch another checkout or use the retired development UI. Native owned/unowned
recovery and final effect fences also have disposable integration regressions;
run them separately from manual native window/assistive-technology evidence.

### IPC sender validation

The same packaged smoke proves the `validateSender` boundary in `apps/desktop/src/main/index.ts` through the real Electron IPC path, never a renderer double or an exported guard. The authorized main frame calls read-only bridge methods first and is expected to be answered, then:

- a second hidden window the smoke itself creates, in the same shipped main process, with the shipped preload and the shipped `webPreferences`, loading the same `app://` document, sends the same calls and must be refused as an untrusted request while the authorized frame keeps answering and `repositories.json`/`settings.json` stay byte-identical;
- a `data:` document loaded with `webContents.loadURL` into the shipped window's own main frame — a capability no renderer holds, since the smoke's navigation check proves the renderer's own attempts to leave the origin are refused — must be refused as an untrusted origin from the very sender and frame the app trusts.

Both refusals are checked against the handler's own precondition (`repository:refresh` needs an open repository), so a guard that stopped answering would be caught rather than mistaken for a refusal. The frame clause of the guard has no live case to reject: `frame-src 'none'`, the `will-frame-navigate` and `will-attach-webview` guards, and `nodeIntegrationInSubFrames: false` mean no child frame of the shipped window ever holds an `ipcRenderer`. The smoke attempts three named subframes and then reads each child frame from the main process — a renderer can only read a frame it is same-origin with — asking the frame itself what it holds. To pass, each attempted frame must have exactly one matching main-process observation reporting `typeof window.desktop === 'undefined'`; missing frames or failed inspections fail the check rather than count as bridge absence. A frame whose navigation the CSP refused may hold a `chrome-error://` document rather than the requested app document; the report records the document actually observed. This measures that the frame clause is unreachable; it is not a live rejection proof for it.

### Integrated navigation and Attention smoke

The old PR Inbox/graph-camera Electron presentation harnesses are retired with
their routes. Use the real-App `cutover.spec.ts`, `cutover-integration.spec.ts`,
and accessibility harness for context, local/global search, read-only inspection,
windowed keyboard focus, and mutation-free navigation. These dispatch fixtures
are not native IPC, Git, provider, assistive-technology or performance acceptance.
Use the current-source packaged desktop smoke for the native boundaries above;
manual/provider/AT/performance acceptance remains user-deferred for this cutover.

### Update flow smoke

```sh
pnpm run build
pnpm run test:update-flow
```

`apps/desktop/scripts/update-flow-smoke.mjs` launches the built app — real main process, real preload, real renderer — through the shared [isolated desktop fixture](#isolated-desktop-fixture), which is the Electron main entry rather than `apps/desktop/out/main/index.js`: it installs a synthetic AES-256-GCM sealing backend, proves no native `safeStorage` method is still reachable, and only then imports the production main with `--use-mock-keychain` and `--password-store=basic`, so if that proof fails the production module is never loaded at all. One disposable temporary root holds the repository the app opens, the Chromium profile, the Git and gh configuration, the fixture's sealing key and this run's generated TLS material; it is removed on every way out of the run — success, refusal or failure.

macOS has the app inherit the host home, as the other desktop runs do, because its sandboxed helper processes only come up against the home the password database reports — so `HOME` is the one path this run does not own, and the paths git and gh read are held to the run's own files instead. The app reports what its Git environment can already do by running `git config` from that home, which a home that is itself a Git repository would answer from its own local configuration. **That arrangement is unsupported and refused**: before the app starts, the run asks git whether it discovers a repository at that directory — including worktrees, bare repositories, and Git directories — without querying any configuration value, and stops with a prerequisite error if it does. Only Git's expected non-repository result permits launch; other probe failures stop the run. The run never queries that repository's configuration and never acts on it; on such a machine it does not run.

The run then reads the launched process's own environment back out of the app's main process and asserts that none of those shapes arrived from outside, that the fixture marker and its 0600 sealing key are on disk before the app is driven, and that the commit carries this run's own identity. The window is driven over the DevTools protocol — real mouse events, real typing, screenshots — against a release server this script owns with a certificate generated for the run: the manifest is signed, offered, downloaded and proved against the recorded digest, and an installer changed on disk after the download is refused without anything being run. That is dev-main evidence; it is not acceptance of the real OS key store, a signed release, or the packaged app, and a real OS key-store acceptance remains a separate manual gate.

### Isolated desktop fixture

`apps/desktop/tests/fixtures/isolated-desktop.cjs` launches the real production main, preload, and renderer (`apps/desktop/out/main/index.js`), with the Electron main entry replaced by the fixture itself:

```sh
apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  apps/desktop/tests/fixtures/isolated-desktop.cjs \
  --use-mock-keychain --password-store=basic \
  --user-data-dir=<owned-temp-root>/user-data \
  --fixture-root <owned-temp-root> \
  --main apps/desktop/out/main/index.js
```

Keep the fixture file first and Chromium startup switches before any `--` separator. The fixture patches the shared native `safeStorage` object in place, preserving Electron's non-configurable export getter and existing import aliases; it never calls the original methods. Keep sandboxing enabled.

Before the production main module is imported, the fixture replaces every `safeStorage` entry point the compiled product uses with a local AES-256-GCM implementation keyed by `<fixture-root>/synthetic-key.bin` (mode 0600), so sealed credentials never touch the operating system's store and a wrong key fails to open them. The key persists only inside the caller-owned fixture root across fixture restarts; it is never printed, and neither is any plaintext. Chromium's own key store is forced to `--use-mock-keychain` and `--password-store=basic` before the app is imported. If any of that cannot be proven, the fixture exits before the production main is loaded. A launch is under the fixture when `<fixture-root>/fixture.json` is present. Passive: it exists only because the fixture created it. The fixture changes no production source, adds no production env switch, and is never referenced by packaged code; accepting the real OS key store remains a separate, external gate, and packaged-desktop acceptance stays with `pnpm run test:desktop`.

`apps/desktop/scripts/packaged-desktop-smoke.mjs` exercises the same synthetic backend in the shipped (unsigned development) package: it pauses the main entry at `--inspect-brk`, installs the helper's fixture before the first production statement, then resumes. That run is synthetic-store evidence only; it never claims the real OS keychain or a signed install.

### Updating visual baselines

Use the pinned Playwright Chromium, OS/architecture, viewport, locale, timezone, device scale, and system fonts recorded in the verification report. Baselines are platform-specific: a passing macOS image is not Linux or Windows evidence. Do not update images solely to silence failures.

1. Run `pnpm run test:visual` and inspect the expected/actual/difference images in `test-results` or `playwright-report`.
2. Diagnose whether the change is intentional. Inspect the actual production surface, keyboard behavior, and accessible state before accepting it.
3. Run `pnpm run test:visual:update` in the documented environment.
4. Review every changed image, then run `pnpm run test:visual` without update mode. Commit reviewed images with the component change.

Screenshot tests wait for fonts and stable fixture state, use fixed data/timestamps, and control motion. Do not mask meaningful status text, selection, operation feedback, or destructive confirmation. Narrow-window coverage represents desktop pane adaptation; it does not define a mobile product.

### Changing tokens and components

After editing `packages/ui/src/tokens/tokens.json`, run `pnpm run tokens:generate` and `pnpm run tokens:check`. Follow [DESIGN.md](DESIGN.md) for token roles and component rules.

For contrast changes, inspect both light and dark themes in the production
renderer gallery and catalog. Measure relationship strokes after opacity against
content, context/hover and selection backgrounds; check field values and
placeholders inside raised overlays as well as normal panels. Exercise selected
segments and filled/line tabs with the keyboard, including forced-colors and
reduced-motion modes. Inspect dialog/scrim separation and nested popup dismissal
at the normal desktop size and the 720×470 zoom-equivalent viewport. Automated
text-contrast scans do not establish visible layer separation.

`packages/ui` owns the browser-safe shadcn `base-nova` library, backed by `@base-ui/react`. Both desktop and design import `@git-stacks/ui/components/<name>` and `@git-stacks/ui/lib/utils`. Existing desktop import paths are thin re-exports, not duplicate implementations. Keep token-based styling, CVA variants and `cn()`; all three `components.json` files direct reusable additions to the shared workspace (`rsc: false`, Lucide, neutral base).

For UI work in either app, inspect the [shared exports](packages/ui/src/index.ts) and [catalog manifest](apps/design/src/manifest.ts) first. Import controls from `@git-stacks/ui/components/<name>` and compose their supported APIs; use `@git-stacks/ui/styles.css` for shared foundations. This applies to the design app's own shell and controls as well as its examples. Keep application-specific layout and domain behavior local, but extend reusable controls in `packages/ui` instead of copying their markup or interaction logic. [DESIGN.md's reuse rules](DESIGN.md#design-system-reuse) define the boundary.

Use the component entry points in desktop runtime code rather than the
`@git-stacks/ui` barrel. Vite serves workspace source as native modules during
development: importing the barrel loads every re-exported control and its
dependencies, including unused charts and calendars, before the app can render.
To verify development startup changes, compare cold renderer loads with separate
Vite caches and disposable `GIT_STACKS_USER_DATA` profiles; inspect first-contentful
paint and requested modules in the actual Electron window. The built-app
benchmarks do not measure Vite's cold dependency optimization.

For a shared component change, update its existing catalog specimen and manifest when the documented API or states change. Verify the affected application interface as well as the specimen: search, navigation, focus, disabled states, and popup behavior must work where the component is actually used. Use the catalog commands below and the [renderer verification guidance](#renderer-verification) for relevant desktop consumers; catalog interaction does not prove Git or IPC success.

The CI component checks render shared controls through `tsx` outside Vite. Keep a runtime React import in JSX components reached by those checks, including `Spinner`; a type-only React reference does not provide the classic JSX runtime.

### Standalone design catalog

```sh
pnpm --filter design dev
pnpm --filter design build
pnpm --filter design preview
pnpm --filter design typecheck
pnpm --filter design check:manifest
pnpm --filter design test:catalog
CATALOG_PORT=5397 pnpm --filter design test:visual # supported baseline host only
```

`test:catalog` runs every portable behavioral case, excluding only `@visual`
screenshot comparisons. Root `pnpm test` and selected catalog CI use that same
command; native release jobs retain the complete functional root suite before
release-key injection. `test:visual` explicitly runs the existing representative
light/dark screenshots on a matching baseline host. Windows has no catalog image
baseline; do not generate one merely to make native packaging pass.

The catalog uses port 5299 and produces `apps/design/dist`, independently of Electron, the native helper, Git provisioning, repositories and `gh` authentication. A root install still installs desktop dependencies. `VITE_BASE=/catalog/ pnpm --filter design build` selects a hosting subpath; preview that build with `VITE_BASE=/catalog/ pnpm --filter design preview` and open `http://localhost:5299/catalog/`. Keep the same base when previewing so asset requests resolve; no deployment is implied. Output remains fixed at `dist` so Turbo can restore the actual static assets.

Canonical ownership is `packages/ui/src/components/ui`, `packages/ui/src/lib`, and `packages/ui/src/tokens`. Shared foundation CSS is `packages/ui/src/styles/foundations.css`; desktop shell CSS stays in desktop. Run shadcn additions from the shared package and retain Base UI `base-nova` configuration. Change the shared token/component, update its specimen and applicable states in `apps/design/src`, and run affected design and desktop checks in the same PR. Catalog fixtures never import desktop private source or use `window.desktop`; desktop integration fixtures remain separate and are not replaced.

The catalog shell uses the shared `SidebarProvider`, off-canvas `Sidebar`, and `SidebarTrigger` for desktop collapse and the built-in sheet below 768px; it does not maintain a parallel catalog open/close state. Shared search and appearance controls stay above the independently scrolling index. Category disclosure follows the shadcn Base UI composition: `SidebarGroupLabel render={<CollapsibleTrigger />}` with `CollapsibleContent` around `SidebarGroupContent`. Search exposes matching categories; choosing a component opens its category, closes the narrow sheet, scrolls to the destination, and transfers focus. The current anchor is marked after Back/Forward. Command navigation includes Foundations and Git compositions. Empty search results offer Clear search.

The current-section marker follows scrolling independently of the hash: scrolling
does not add history entries or move focus. Query changes align the results
heading while retaining search focus, including short and empty result sets.
Clearing restores the previous section's viewport position; choosing a result
navigates to that destination instead. Filtering rebuilds tracking around the
mounted entries; empty results have no current marker. Verify position, focus,
and the marker after filtering, refinement, clearing, resizing, Back/Forward,
and intentional anchor navigation.

Start with the interaction links existing specimens for inspection, value
selection, captured-scope confirmation, and status/recovery. Every manifest entry
has required `usage` guidance visible above its specimen; anatomy, keyboard and
token details remain optional disclosures. Verify recipe links by pointer and
keyboard, including destination focus and narrow-sidebar closure.

The Button specimen includes a draft toolbar, supporting dialog actions, and
an exactly-one-selected view example to distinguish task actions from persistent
choices. Button, Field/Input, Select, Dialog, and Alert Dialog disclosures include
live adoption examples and copyable source. Their source is imported from the same
typed TSX files in `apps/design/src/examples` that render the previews, so catalog
typechecking covers the displayed compositions. Copy reports success or refusal
inline and leaves the code selectable. Use the shared UI styles and the existing
Tailwind source configuration when adopting a composition; production forms and
Git operations still follow the shared contracts and captured-preview gates below.

Foundations displays neutral, action, selection, feedback, and diff color pairs
using generated semantic CSS variables, plus actual boundary and focus controls.
Inspect both themes and narrow reflow when changing those specimens; no palette
values belong in the catalog.

Tokens, Typography, Typeset, and Iconography are adjacent Foundations entries in content and
navigation; the original component anchors remain supported. The sidebar brand
header links to the introduction at the genuine page top, and the command entry
does the same; both clear search, transfer focus, and close narrow navigation.
Explicit navigation wins over pre-search viewport restoration, including
Back/Forward.
Each category derives its count and links from one destination list. Foundations
prepends the always-available Tokens destination, even while filtering. The brand
title underlines on hover and retains keyboard focus treatment.

Iconography uses the existing `lucide-react` dependency and the
[Lucide icon catalog](https://lucide.dev/icons/), with direct static named
imports rather than an Icon wrapper, registry or shared re-export:

```tsx
import { GitBranch, RefreshCw } from 'lucide-react'
import { Button, IconButton } from '@git-stacks/ui'

<Button variant="secondary" size="sm" onClick={browseBranches}>
  <GitBranch size={16} aria-hidden="true" /> Browse branches
</Button>
<IconButton label="Refresh repository" variant="ghost" onClick={refreshRepository}>
  <RefreshCw size={20} aria-hidden="true" />
</IconButton>
```

Keep ambiguous actions visibly labelled. Follow [Iconography](DESIGN.md#iconography)
for semantic colors, inline status sizes and accessibility. The catalog actions
only update local feedback: verify Foundations navigation, search for Lucide,
the Iconography command result and `/#iconography`, then Tab/Enter/Space through
the examples. Inspect 16px glyphs in 36px compact buttons, 20px glyphs in 44px
standard buttons, and 44px icon-only targets. Check that the labelled status grid
reflows with its available width and retains each icon beside its text in light/dark,
390px narrow browsing and 640×450 reflow. Run `pnpm run typecheck`,
`pnpm --filter design check:manifest`, `pnpm --filter design build` and
`pnpm --filter design test:catalog`; the manifest checks Lucide's genuine
documentation only for this owned foundation while retaining shadcn provenance
for the existing entries.

Typeset is owned browser-safe CSS adapted from the MIT shadcn/typeset
[distribution](https://github.com/shadcn-ui/ui/blob/main/apps/v4/app/%28app%29/%28typeset%29/typeset.css)
and its [contract](https://ui.shadcn.com/docs/typeset), not a runtime package.
`@git-stacks/ui/styles.css` includes it; `@git-stacks/ui/typeset.css` exposes the
standalone stylesheet for consumers with their own token setup. Wrap semantic
HTML or already-rendered markdown in `typeset typeset-docs` (15px, 1.75 leading,
1.25em flow) or `typeset typeset-compact` (14px, 1.6 leading, 1em flow).
The three rhythm variables and body/heading/mono font variables are overridable;
fonts, colors and radius use existing shared roles. Layout owns reading measure.
`typeset-scroll` wraps wide tables; `not-typeset` and `data-not-typeset` exclude
the entire subtree, even nested activation. Components-layer rules and low
specificity element selectors let utility overrides win. New blocks own their
start spacing and new cells own separators, preserving existing block styles
during appends. No markdown parser is needed for the catalog's semantic specimen.
Opted-out component subtrees own their layout spacing; the specimen uses a 20px
outer gap and an 8px inner gap without stretching the shared control. Captured
branch and base identities use semantic inline code.
The upstream reconciliation disclosure uses Typeset as actual reading content;
catalog controls and desktop Git workflows are not globally restyled.

The dated `apps/design/src/manifest.ts` records all 63 components plus Typography, Typeset and the owned Iconography foundation, the exact upstream inventory reconciliation, and owned API adaptations. CI checks this local inventory, canonical token references and the displayed imports against package exports, without a live scrape. Browser tests cover renderability, navigation, forms, calendar keyboard selection, table sorting, menus, focus return, theme overrides, rendered density dimensions, local Git simulations, supported attachment/bubble states, sidebar collapse and active/reduced-motion loading. Narrow browsing uses 390×844; 200% zoom-equivalent reflow uses a 640×450 CSS viewport (half of a 1280×900 window), checks reachable actions and dialogs, and is not a claim of browser-chrome zoom testing.
 
Representative light/dark screenshots have separate committed Linux x64 and reviewed macOS Darwin arm64 baseline families. Use the pinned Playwright Chromium for the recorded platform, 1280×1600, device scale 1, en-US, UTC, system fonts and reduced motion. The taller viewport contains the Git composition and Button specimens, avoiding Chromium's beyond-viewport capture and its transient 1×1 responsive reflow. Each whole capture target is temporarily aligned to the nearest device-pixel origin; existing transformed targets are refused, internal layout is unchanged, and the prior inline transform is restored even if capture fails. Behavioral tests retain 1280×900 unless a scenario explicitly exercises another size. Accessibility cases select each theme through the catalog control and enter keyboard modality before focus probes; each theme retains full-page and open-dialog Axe scans. Capture intentional changes with `pnpm --filter design test:visual --update-snapshots`, inspect every image, then run `pnpm --filter design test:visual` without update mode. Record the actual browser version/executable, OS/architecture, fonts and run settings with each baseline family. Neither family's result establishes pixel identity on another platform or Windows coverage. Automated tests are not certification: manual screen-reader, physical touch, native browser zoom, OS high-contrast and cross-platform font checks remain explicit sign-off gaps when those environments are unavailable.

When verifying the Card specimen, inspect both cards against the catalog canvas
in light and dark themes, then follow Inspect composition to the local Git
simulation. Check that each checkout action stays aligned with its branch content
at wide and narrow widths and that checkout does not change the inspected PR.

The Button specimen pairs variants with selection guidance. Start Fetch example,
check that the visible busy marker replaces the content without resizing the
button, then Finish simulation to return to idle. The original accessible name
stays intact and dispatch is disabled while busy. Exercise reduced motion as well
as the active spinner. Foundations pair canonical space, radius, and elevation
values with visual samples and intended-use labels.

In Git compositions, inspect one PR and check out another; verify the row-local
Checked out label stays independent of the inspected highlight. The scoped
deletion simulation repeats both captured branch names and their relationship
inside its Cancel-first confirmation, excludes PR #43, and never calls Git or a
remote transport. Verify long identities and footer actions at 640×450 reflow.

Dialog, Alert Dialog, Sheet, and Drawer use `component.overlay.scrim`, independent
of theme-dependent text. Inspect the backdrop in both themes and in the desktop
command palette, not only the catalog. The simple Alert Dialog deletion example
names `feature/quiet-graph`, starts on Cancel, and uses a danger action; cancellation
leaves its state unchanged and confirmation affects only its local simulation.

Theme checks must wait for computed styles to settle after the theme attribute changes; reduced motion shortens CSS transitions but does not make them synchronous.

Use `CATALOG_PORT=<unused-port>` for isolated catalog test allocations; its runner starts the actual catalog on that port. Desktop renderer tests already support `GALLERY_PORT=<unused-port>`. Keep visual baseline updates limited to the host platform.

Turbo tracks shared source as an input of both consumers. Design-specific tasks override native prerequisites. Desktop declares the bundled UI workspace as a development dependency: Vite embeds the production controls it uses, while electron-builder does not copy the shared recipe source and unused recipe dependency graph into its production Node modules. Catalog fixtures stay outside the desktop output allowlist.

### Shared component contracts

- Compose Base UI triggers with `render`, not Radix `asChild`. `DialogContent` accepts Base UI `initialFocus` and `finalFocus`; guarded roots refuse implicit dismissal through `onOpenChange`'s `details.cancel()`.
- `Button loading` preserves its children in layout and the accessibility tree while showing a decorative busy marker; keep the caller's label/icon stable and do not supply an additional loading spinner. Busy controls expose `aria-busy` and block dispatch. When `Button` renders an anchor, pass `nativeButton={false}` and retain its real `href`; the result remains a link, not an emulated native button.
- `Select` accepts `options` and a string-valued `onValueChange`; `''` can be a real option, not a missing value. Field selects fill their container; use `className="w-auto"` for content-sized inline toolbar selects.
- `Tabs` forwards horizontal/vertical orientation to Base UI for matching keyboard navigation and layout. `TabsList` accepts `controlSize="compact"` or `"standard"` (default) and `variant="default"` or `"line"`; trigger typography stays at the label role. Sidebar items, tabs, and command rows retain 44px minimum coarse-pointer targets.
- `Checkbox` reports booleans through `onCheckedChange` and exposes mixed state through `indeterminate`. Use `RadioGroup` for form choices and `SegmentedControl` for an exactly-one-selected control with nonempty option keys.
- Pass `disabled` explicitly to composite controls inside locked fieldsets. Portaled options must not remain usable during an operation.
- Use TanStack Form's `useForm`, `form.Field`, `handleChange`, `handleBlur`, and `useSelector` for local form drafts. Native form submission prevents default and stops propagation before `form.handleSubmit`; await asynchronous transports and retain synchronous dispatch locks.
- Keep hydrated `defaultValues` consistent with values passed to `form.reset`, including fields mounted only in another section. Do not duplicate repository previews, recovery state, editor documents, or persistent review drafts in form state. Clear credential fields before transport dispatch and on dismissal; never log them.

`pnpm run test:controls` exercises shared controls and TanStack forms in the separate browser gallery. It does not exercise production preload or native sandbox/IPC; those belong to the packaged desktop smoke. Focused renderer coverage includes:

```sh
pnpm run test:ui tests/renderer/base-ui.spec.ts tests/renderer/tanstack-forms.spec.ts tests/renderer/cutover-integration.spec.ts
```

When adding a variant or migrating a view:

- Update the production component and its existing typed fixture, not a copied HTML specimen.
- Add a deterministic scenario for the consumer-visible boundary: loading, empty, unavailable, blocked, submitting, rejected/stale, partial completion, or conflict recovery.
- Exercise keyboard entry, visible focus, dismissal/focus return, disabled explanations, zoom, and separate row-selection/action targets.
- For mutations, assert the action produced by a real UI interaction: cancellation, duplicate prevention, confirmation gating, filtered scope, and captured preview tokens/OIDs/fingerprints. Do not replace these with tests of the double itself.
- Add screenshots only for a distinct visual state; update the fixture matrix and evidence with the migration PR.

### Manual assistive-technology sign-off

Automated axe and contrast checks supplement, not replace, human keyboard and assistive-technology review. Final migration sign-off requires an explicitly recorded manual pass; missing evidence is a blocker, not an implied pass. The `Accessibility checks` workflow automates what a machine can judge; the script below is the part it cannot.

**Two platforms, two records.** The target readers are VoiceOver on macOS and Narrator or NVDA on Windows; the `Accessibility checks` workflow runs headless Chromium on Linux and is evidence for no reader. One record per platform, each naming the reviewer, the date, the OS version and build, the app revision under test (`git rev-parse HEAD`), the reader with its version and settings, display scaling, the keyboard input modes in force (Sticky, Filter, and Slow Keys on Windows; keyboard menu navigation on macOS), and whether the chords are the shipped defaults or the ones set in Settings → Keyboard shortcuts. A macOS record does not answer the Windows one, an unrun platform is recorded as not run, and the evidence belongs in the pull request.

**What to launch.** `pnpm install --frozen-lockfile`, then `pnpm run package`, then the unpacked application from `release/`: macOS `release/mac-arm64/Git Stacks.app/Contents/MacOS/Git Stacks` (or `release/mac/Git Stacks.app/Contents/MacOS/Git Stacks`), Linux `release/linux-unpacked/git-stacks`, Windows `release/win-unpacked/Git Stacks.exe`. `pnpm run test:desktop` is the automated packaged smoke: it supports macOS and Linux and refuses Windows ("Packaged desktop smoke supports macOS and Linux only; Windows process-tree cleanup is not implemented"), so the Windows pass is manual, and on the platforms it supports `--keep` retains its disposable workspace and prints the path. That smoke runs an unsigned, locally built artifact against fixtures: it is not evidence of a signed release, of the operating system's native credential store, or of any manual acceptance pass.

**An owned, credential-free run.** Everything the pass touches lives in one directory this pass creates, and the app is launched from a shell that carries none of the machine's Git, GitHub, or credential state. A fresh `--user-data-dir` is part of that, not all of it: it holds `settings.json`, `repositories.json`, and the notification state, while the CLI session comes from the CLI itself. `GH_CONFIG_DIR` is the one GitHub variable this run points somewhere: it names a directory, so it points at the empty one this run created, which is how the CLI finds no stored session to authenticate with. The four token variables are not directories and are not pointed anywhere — `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` must be **unset**, because the CLI reads any one of them as a credential in preference to its own configuration, and the run would then authenticate as whoever owns that token. With them gone the CLI reports itself signed out and the run reaches no real account. On macOS leave `HOME` as it is: the app brings its sandboxed helpers up only against the home the password database reports.

```sh
# macOS: an empty environment plus this run's own variables
root=$(mktemp -d -t git-stacks-a11y)
cd "$root"
: > gitconfig
mkdir gh
env -i \
  PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
  root="$root" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$root/gitconfig" \
  GH_CONFIG_DIR="$root/gh" GIT_TERMINAL_PROMPT=0 \
  sh
```

```powershell
# Windows PowerShell: a GUID root, then strip the ambient variables in place
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("git-stacks-a11y-" + [guid]::NewGuid())
New-Item -ItemType Directory $root | Out-Null
New-Item -ItemType File (Join-Path $root 'gitconfig') | Out-Null
New-Item -ItemType Directory (Join-Path $root 'gh') | Out-Null
Set-Location $root
Get-ChildItem Env: | Where-Object { $_.Name -match '^(GIT_|GH_|GITHUB_|GIT_STACKS_|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_TLS|NODE_EXTRA|ELECTRON_)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
Get-ChildItem Env: | Where-Object { $_.Name -match '^(GIT_|GH_|GITHUB_|GIT_STACKS_|SSH_AUTH_SOCK|NODE_OPTIONS|NODE_TLS|NODE_EXTRA|ELECTRON_)|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|API_?KEY' } | Select-Object -ExpandProperty Name
$env:GIT_CONFIG_NOSYSTEM = '1'; $env:GIT_CONFIG_GLOBAL = Join-Path $root 'gitconfig'
$env:GH_CONFIG_DIR = Join-Path $root 'gh'; $env:GIT_TERMINAL_PROMPT = '0'
```

The shell that block opens is where the rest of the run happens: the fixture block below, and the packaged app itself with `--user-data-dir="$root/user-data"`. `exit` leaves it. `env -i` is what makes the run credential-free — nothing from the outer shell survives, so no `GITHUB_TOKEN`, `GH_TOKEN`, or host-scoped token, no `GIT_DIR`, `GIT_WORK_TREE`, or counted `GIT_CONFIG_*` pair, no `SSH_AUTH_SOCK`, `NODE_OPTIONS`, or Electron override reaches it — and `root` is passed into it explicitly, because an empty environment has nothing else to expand. The PowerShell block is one session rather than a subshell: it sets `$root`, moves into it with `Set-Location`, strips the ambient variables, and then runs the same fixture block and the same app launch, where the argument is `--user-data-dir=$root\user-data`; its query must print nothing, and anything it lists is unset before continuing. `GIT_CONFIG_NOSYSTEM` with an empty `GIT_CONFIG_GLOBAL` means Git reads no system or global configuration at all — no credential helper, `include`, signing, or hook path — and the empty `gh` directory means no `gh` login. Every Git the app starts inherits the launching environment, so the app is launched from that same session.

**The fixture.** Both setups have moved into the run root, so this block's relative paths land inside it. Every line is a `git` call or a directory step that both shells spell the same way, and the tree starts empty, so nothing depends on how a shell would encode a file it wrote:

```sh
mkdir a11y-fixture
cd a11y-fixture
git init --quiet --initial-branch=main .
git config user.name "Accessibility Review"
git config user.email "a11y@example.invalid"
git config commit.gpgsign false
git commit --quiet --allow-empty -m "Seed commit"
git init --quiet --bare --initial-branch=main ../a11y-fixture-origin.git
git remote add origin ../a11y-fixture-origin.git
git push --quiet --set-upstream origin main
git checkout --quiet -b feature/one
git commit --quiet --allow-empty -m "Feature one"
git config --local branch.feature/one.parent main
git checkout --quiet -b feature/two
git commit --quiet --allow-empty -m "Feature two"
git config --local branch.feature/two.parent feature/one
```

Add a file of your own when a step needs a working change; what the app reads is Git, not how the file was written.

A dependency parent is recorded as `branch.<name>.parent`. Build an owned fixture past 64 branch rows (`LANE_ROW_PAGE_SIZE`) for cross-page lane focus and past 32 relationships (`LANE_RELATIONSHIP_PAGE_SIZE`) for inspector paging; ordinary lists retain their separate 200-row budget. Use the package's **Add repository** folder picker, never a personal repository, and delete only the disposable fixture root after the manual run.

**Readers.** `Mod` is `Cmd` on macOS and `Ctrl` on Windows/Linux. Confirm the reader does not intercept the configured chords. Run lane, Review-member and dialog keyboard checks in the reader's interaction/focus mode; record browse/scan-mode announcements separately. Automation is not reader acceptance.

1. Record platform, exact package/source SHA, reader and reader mode. Tab to **Add repository**, record the native folder picker and the registered repository name/path announcements.
2. **Navigation.** Tab through Branches, Pull requests, Needs attention and Activity; open Review from an actual qualified PR row. Verify heading/focus announcements, Settings, optional Notifications and explicit recovery dialogs. Use `Mod+K` from non-editable focus for global search; local lane search must remain independent. Inspect configured shortcuts rather than expecting retired Stacks/Changes/History/Stashes/Inbox destinations.
3. **Branch lanes.** Up/Down/Home/End must traverse the whole filtered projection across 64-row pages, move visible focus, and not change selection or a checkout. Enter changes inspection. Confirm qualified branch/PR/worktree identity, parent evidence, off-page continuation endpoints, unknown/conflicted/missing data, bulk-selection exclusions and a visible focus ring. Filtered ancestors remain context, never eligible bulk matches.
4. **Read-only inspection and Review.** Verify shared narrow Sheet focus containment, Escape/dismissal and return focus; inspector tabs, file selection and 1000-line diff paging must be keyboard reachable without Stage/Commit/Stash controls. In Review, verify member navigation, unsent draft preservation, comparison/viewer replacement warnings and readonly history access without replay.
5. **Text entry.** Type `7/k` into local/global search and draft inputs. Plain letters and IME composition must not trigger navigation. Explicit cancel restores initiating focus; errors stay associated with their controls, and unsent work is retained according to the current dialog contract.
6. **Zoom and motion.** Exercise all current surfaces at real 200% Electron zoom and at the 1000×700 minimum separately, including the narrow inspector Sheet. Check horizontal overflow, clipped actions, focus restoration and reduced-motion status truthfulness. Record native limits independently from browser geometry.
7. **State without colour.** Inspect lanes, Attention, Review, CLI/Diagnostics Settings and recovery under high contrast/monochrome. Lifecycle, checks, authorization and unknown/unavailable observations must remain readable as words.
8. **Errors and recovery.** Use owned unavailable-metadata, history-read, stale-preview, busy and paused/conflicted cases. Confirm original qualified authority remains explicit and opening/dismissing recovery never replays or retargets a journal. Continue/Skip/Abort require an explicit supported captured decision, not browsing or navigation.
9. **Native window controls.** With the reader and no pointer, reach the window's own controls and confirm each is announced by the name of its action — minimize, zoom, and close on macOS; minimize, maximize or restore, and close on Windows — that activating each does what its name says, and that returning from full screen leaves the same names in the same order. A control announced by its icon, its position, or an untranslated name is a finding.
10. Record findings and platform limits in the pull request. Sign off only after blocking keyboard, contrast, state-truthfulness, and safety-dispatch findings are resolved.

Real GitHub mutations require a separately designated test repository and explicit authorization; none is included in routine fixtures or CI.

## Disposable GitHub end-to-end suite

`apps/desktop/tests/live` is the suite that runs against a real GitHub instead of a double in
process: real Git, a real HTTPS transport, and a repository that exists for the
length of one run. It exists for the behaviour mocks cannot prove — a native
stack created twice, a merge requested twice, a review written against a
comparison that moved, a check the host reports differently than we expect.

```sh
pnpm run test:live                  # the controlled target: no credentials, no network
pnpm --filter git-stacks exec tsx tests/live/cli.ts --list   # every scenario, its title, and what it needs
```

### The controlled target

`--controlled` stands the API double and Git's smart HTTP protocol up on one
real TLS socket with a certificate generated for the run, and points the
production transport at it. The clone's `origin` is a real HTTPS URL the
application resolves a host and a repository from, so its fetches, pushes, and
API reads all cross the same boundary they cross against github.com. The
certificate is verified rather than trusted blindly, and nothing in the run
names `github.com`, so the run cannot reach the real service even by accident.

The run's own host answers on a `127.0.0.1` authority, so the URLs a scenario
asks for are that host's and not the apparent `github.com` spelling — and the
transport rule is told which they are rather than left to guess from the shape
of an address. Each repository this run creates is registered as it is created,
and a remote is answered only on an exact match against one of those URLs. A
sibling path on the same host, any other authority, and a URL registered by
nobody are all refused, because a rule that let through anything matching
`https` — or anything under the directory this host serves — would be a rule
that answers a request for github.com itself.

The Git boundary refuses the same way. Git applies successive `-C` options in
order and a separate `--git-dir` names a repository outright, so a command
carrying more than one directory selector is refused rather than resolved: the
last selector is where the command actually runs, and measuring the claim
against the first is how a command reaches a checkout this run never created.
That holds for a command the fixture answers and for one it forwards to the
real `git`, because both are checked before either runs.

This is the target that needs no authorization, and it is the one CI runs. It is
not a mock: the scenarios exercise the production services, the production
transport, and real `git`, and the only thing stood in for GitHub is GitHub.

### What the run takes away from the environment

A live run is the one place in this repository where a real credential is in the
environment, so it replaces that environment rather than inheriting it. Every
Git the run starts — the ones it starts itself, the ones an external clone
starts, and the ones the application's own services start — reads an empty home
and template directory, no system or global configuration, hooks pointed at a
directory the run created and left empty, signing off, helpers cleared, and
tracing off; the run's own credential rides in a header scoped to the disposable
repository rather than in the remote URL. It also removes what a machine can
carry that would widen where that credential goes: `GIT_DIR` and its relatives,
the counted `GIT_CONFIG_*` pairs, an ambient token, and an ambient API base.

`NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS` are retired with them,
and the two are not the same kind of thing. The application's API calls are
`fetch` in this process, and Node reads the first of them when it opens the
connection: with it set to `0`, a request carrying this run's bearer completes
its handshake against a certificate nothing vouches for. Retiring
`GIT_SSL_NO_VERIFY` secures the Git children and changes nothing about that
request, so the retirement happens in the same install, before the first
authenticated request rather than with the Git commands later. The recovery
command retires it too, and for the same reason: it deletes repositories, and a
certificate bypass still in place when its first connection opens would be a
credential sent to whatever answered.

The second is read once, when the process starts. Deleting it stops this run's
Git children from inheriting an extra authority; it does not unload authorities
this process already loaded. Which authorities a Node process trusts from its
first instruction is settled by how it was launched, and a run that starts
already trusting a certificate is not made safe by any environment it installs
afterwards — so the suite claims no certificate pinning it does not perform, and
the boundary it does enforce is the one it can: no credential leaves on a
connection whose certificate this process has not accepted.

When the run finishes — succeeded, failed, or refused — the process environment
is restored exactly as it was found, on the refusal path and the failure path as
well as the successful one. A process left holding a bypass it did not start with
is not a thing this suite produces.

### The authorized target

`--github` runs the same scenarios against a repository it creates on a real
host and deletes afterwards. There is no default: a run with no owner, no
token, and no run id is refused, and the refusal names the variables to set. A
credential is never inherited from an ambient `gh` session and never read from a
variable the application itself uses — the suite spends a credential somebody
gave it for a disposable repository, or it does not run.

Authorized API calls serialize across both actors, with at least one second
between mutations. The pagination scenario's 100 filler reviews therefore take
at least 99 seconds; controlled runs do not wait. A real primary or secondary
rate-limit refusal parks subsequent scenarios and cleanup for the host's
`Retry-After` or exhausted-budget reset, with a one-minute fallback when no
deadline is supplied. The refused request is reported, never automatically
replayed, including when its mutation outcome is uncertain.

| Variable                                   | Meaning                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GIT_STACKS_LIVE_GITHUB_OWNER`             | The account the disposable repository is created under. Required.                                                           |
| `GIT_STACKS_LIVE_GITHUB_TOKEN`             | That account's token. Required; never defaulted.                                                                            |
| `GIT_STACKS_LIVE_GITHUB_REVIEWER_TOKEN`    | A second account that can approve and reply. Optional; without it the scenarios that need a reviewer fail rather than skip. |
| `GIT_STACKS_LIVE_GITHUB_REPOSITORY_PREFIX` | Prefix of the disposable repository. Defaults to `git-stacks-live-e2e`.                                                     |
| `GIT_STACKS_LIVE_GITHUB_RUN_ID`            | Id stamped on everything the run creates. Defaults to a per-run digest.                                                     |
| `GIT_STACKS_LIVE_GITHUB_RECEIPT`           | Where the cleanup receipt is written.                                                                                       |

The account needs permission to create and delete a repository, to administer
its rule sets, and to merge. Anything the host cannot do is discovered by
probing, not assumed: the native stack surface is asked through the product's
own detector, review threads are asked about a real pull request, a merge queue
is configured and read back off the rule set that declares it, and a credential
is answered by sending a write and seeing whether the host takes it. What could
not be observed becomes a note in the report, and a scenario whose capability is
missing is a **failure**, not a skip — a suite that quietly stops covering merge
queues would report green while the thing it exists to catch goes uncaught.

### The rule sets it configures

A rule set is created through `POST /repos/{owner}/{repo}/rulesets`, and the body is
the one the endpoint documents: the seven required `merge_queue` parameters
(`merge_method`, `min_entries_to_merge`, `min_entries_to_merge_wait_minutes`,
`max_entries_to_merge`, `max_entries_to_build`, `check_response_timeout_minutes`,
`grouping_strategy`) and nothing else, a required check named by `context` with
`integration_id` omitted rather than set to `null`, the refs it protects stated in
full, and the review-thread-resolution policy stated as `false`. Both omissions are
the point: the endpoint refuses a parameter its contract does not have, and refuses
an `integration_id` that is not an integration's integer id, so a body carrying
`queue_type`, `merge_commit_message`, `merge_commit_title` or `integration_id: null`
is a 422 on a real repository — a capability probe that sends one learns nothing
about the account it asked, and the scenario that needed the queue or the check
fails rather than reporting what it could not have configured. The controlled host
holds the same line: it refuses those bodies with the same 422 rather than storing
them, so a harness that regresses fails there before anyone spends a credential on a
request github.com would refuse.

### Which branch a run works on

The trunk is whatever the host says it is. The repository's default branch is
read out of the answer to the create request — that endpoint takes no such
parameter, so nothing is passed and nothing is assumed — and every layer base,
pull request base, native-chain expectation, queue ref and schema-probe parent
in the suite reads that value rather than the word `main`. A host that creates a
repository without naming one is refused before anything is seeded: a guess at
that point means committing to a branch the repository has no evidence of
having, and then asking the host questions about it.

The controlled target takes the name it is stood up with, so an account whose
repositories default to `trunk` is something this suite can cover rather than
something it quietly assumes away. No environment variable was added for it: the
live run reads the branch from the host, and a host that will not name one is
refused.

### Who may push

A host that served every push would prove nothing about authorization, because a
public repository answers everybody. The controlled host answers the question
GitHub answers: it identifies the credential behind the request, looks up the
role that account holds on the repository that was named, and refuses a push
whose principal it does not recognise or whose role does not permit writing. The
same boundary covers the foreign repository a reviewer is given, whose access is
granted and read back before it is used, and a credential authorized for the
disposable repository authorizes nothing else on the same host: it rides in a
header scoped to that one repository's URL.

On the authorized target the run claims the real `git` over the directory it
created, and releases that claim when it finishes. It never claims `gh`, never
invokes it, and never reads a credential from it, so a suite that is supposed to
spend a credential somebody handed it cannot spend an ambient session instead.

### What it covers

`--list` is the authoritative catalogue. In outline: native stack create, extend,
unstack, invalid chains, fork heads, and cross-repository numbers; single-line,
multi-line, and reply review threads, resolve and unresolve, a review against a
moved comparison, and a second account approving what the author cannot; check
and status rollup, rerun refusal, and a spent rate limit; required-check and
required-approval rule sets; direct and queued asynchronous merges; external
mutation between preview and submit (force-push, retarget, merge, branch deletion,
stack membership); network, rate-limit, and credential faults at the adapter
boundary; and a schema-drift check against the committed fixture.

Faults are injected at the transport boundary rather than in a server, which is
what makes them usable against a real host. A lost response is the one fault a
fixture cannot stage honestly and a live host must not be asked to produce: the
request really is sent, GitHub really does apply it, and only the answer is
discarded — the exact state a person is in when a merge may or may not have been
requested, and the only way to prove a retry does not create a second merge,
stack, or pull request. A refused write is the opposite: the host never sees it.
The fault decorator reads `destinationHost` and `credentialAuthority()` from the
wrapped transport on demand, preserving host provenance and credential rotation.

### Cleanup and receipts

Every resource the run creates carries the marker `git-stacks-live-e2e:<run id>`
in its own description. Cleanup reads the marker back off the repository before
it deletes anything, and refuses every resource — reporting what is still
standing — when the marker cannot be proven. A name collision, a hand-made
repository, or a previous run's leftover is never removed on a guess. Cleanup
runs in a `finally` that covers workspace setup, the capability probe, the
scenarios, and schema generation, so a startup failure and a scenario failure
both clean up; a run that left anything behind exits non-zero.

The account that spends the credential and the account the repository belongs to
are two different answers, and the receipt keeps them apart. A run pointed at an
organization creates the repository as a user acting for it, so every entry names
the login that actually authenticated, and recovery asks for the accounts the
receipt names rather than for the owner alone — demanding the organization
itself would refuse the exact run that most needs recovering. A reviewer
credential that turns out to be the same account as the primary is refused before
anything is deleted rather than after.

The receipt is also written _before_ the request that creates the resource, and
flushed to disk before that request is sent, which is what makes a lost answer
recoverable: the exact owner, name and marker are on the disk before the host has
been asked. When the host names the object it created, that same entry is
completed with the host's own id rather than a second entry being appended —
two entries for one repository would leave one of them unsettleable and
outstanding for ever.

Recovery removes a repository only after the host confirms the id the receipt
records _and_ the marker it stamped, in that order, and settles nothing else: a
resource inside a repository that was removed is reported as gone with it, a
refusal stays outstanding with its reason, and a read that could not be answered
at all is reported as unknown rather than as removed or absent, because
reporting a dropped connection as a deleted repository is the one answer a person
cannot act on. Recovery installs no global transport, so a credential it was
given for one deletion is never reachable by the rest of the process, and the
same is true of the certificate bypass it retires first.

The receipt is updated after every change, so a run that dies between creating
something and deleting it still leaves the list of what to clean up by hand. It
holds handles, timestamps, and refusal reasons — never a request body, a diff,
or a credential. Progress lines, failure messages, stack traces, and request
summaries are all rendered through the redactor first: configured credential
literals (longest first, so a secret containing another is removed whole), the
credential shapes the application already knows, any `user:password@` in a URL,
and local paths.

Exit codes are `0` passed, `1` a scenario or cleanup failed, `2` the run was
refused before it started.

`pnpm --filter git-stacks exec tsx tests/live/cli.ts --recover <receipt>` is what a run that was killed
before its own cleanup needs. It reads that run's receipt, asks the host to
confirm the id and the marker for everything the receipt names, and removes only
those; a receipt naming something the host does not confirm is reported and left
alone.

### The committed schema fixture

`apps/desktop/tests/fixtures/live-github-observed-schema.json` is the contract the mock
fixtures are held to. It records the shape the host was observed to answer —
paths and JSON types only, no values, no repository name, no identifier — and
`schema/observed-responses-match-the-committed-fixture` fails when a field the
parsers depend on is missing or has changed type. Regenerate it deliberately
with `--write-schema`, which prepares a real subject (a diff, a submitted review
with a comment, a two-layer stack, a check run, and a commit status) before
observing, because a probe over an empty pull request observes no fields at all.

**Controlled provenance is not github.com acceptance.** The fixture's `source`
field identifies its generating target. A controlled fixture describes the API
double, not the real host. Compare it against an authorized live run and record
the resulting evidence outside this README before making real-host claims.

### The workflow

`.github/workflows/live-github-e2e.yml` runs both targets, and it can only be
started by hand (`workflow_dispatch`) with no inputs. There is no
`pull_request`, `pull_request_target`, `push`, or `schedule` trigger, because
every automatic trigger is a way for a branch somebody else controls to spend
the disposable account's credential. Both jobs check out
`github.event.repository.default_branch` explicitly — not the ref the dispatch
happened from — with `persist-credentials: false`, pinned action SHAs,
`contents: read` and no write scope, and one run at a time on the account so two
runs cannot clean up each other's repositories.

The `live` job reads its owner from an environment variable and its two tokens
from secrets on the `live-github-e2e` environment, and refuses to install or run
anything when any of them is unset — a repository that has not been configured
says so and exits non-zero rather than starting with a guess. **Naming the
environment in the workflow does not configure its protection.** A repository
owner has to create the environment and, separately, require reviewers, set a
wait timer, restrict it to the default branch, and add the two tokens as
environment secrets; until they do, no protection exists and only the
fail-closed gate stands between a dispatch and a run. The only file taken off
the runner is the receipt; the credential is passed to one command and never
written, echoed, or uploaded.

An ordinary failure or a failing scenario cleans up in process. A job killed at
its `timeout-minutes` cannot, and no in-process handler can: there is nothing to
run one once the process is gone. So recovery is a third job in the same
workflow, which runs when the live job did not succeed. It takes the receipt that
job published as an artifact — the artifact, because each job runs on its own
fresh machine, so a path on one runner says nothing about the next one — and
removes only what that receipt names, after the host confirms both the id the
run created and the marker it stamped. With no receipt published it says so
and fails rather than searching for repositories whose names merely resemble
what the run would have used. The run id in the log identifies any repository a
recovery could not remove, since every resource carries the marker.

### Acceptance boundary

The controlled target uses disposable repositories, a generated TLS authority, and
the production services. Run it with the commands above and record measured results
outside this README. It does not establish real github.com behavior, authentication,
or desktop acceptance; those require separately authorized verification.

Automated live GitHub E2E is deferred as a development gate; howarewoo owns
manual live acceptance recorded against a tested revision
([#34](https://github.com/howarewoo/git-stacks/issues/34), [#39](https://github.com/howarewoo/git-stacks/issues/39)).
A live run is authorized per target rather than by default: it may only be
pointed at a disposable target the person authorizing it named in advance,
using a CLI profile this suite owns for that run, created for the run and
removed with it. It never borrows an ambient personal CLI session, never falls
back to the account that happens to be signed in on this machine, and never
uses a personal default repository. Signing and human accessibility acceptance
are unchanged.

Recovery is a narrower claim than that, and it is stated as the mechanism rather
than as a result. The command opens its own connection: a private agent, no
keep-alive, a fresh verified handshake for every request, destroyed when the
command ends. It does not reuse this process's pooled `fetch`, so no socket opened
earlier — under a bypass, or against a different authority — can carry a deletion
credential on a trust decision this run did not make. A caller that stands a host
up can supply the authority that host's certificate chains to, which widens what
the connection will believe and does not narrow it, and the process's own
certificate switches are retired before the first request and restored afterwards.

Which handles it is willing to delete is decided by the id and the marker the
receipt records, so a look-alike repository is left alone, and a resource whose
repository is still standing is reported rather than counted as removed.

`runRecoveryAgainstControlledHost` in `apps/desktop/tests/live/cli.ts` creates a controlled TLS
host, a marked repository, and a receipt naming its id, then invokes the actual
`--recover` command. Its regression checks the command outcome and reads the
repository back from the host. Run the recovery regression alongside the controlled
suite; neither substitutes for authorized recovery verification against github.com.

Two things this suite depends on are configuration outside the repository
rather than code in it: the protected environment and its required reviewers,
and the environment secrets. Until a repository owner sets them, the
fail-closed gate is the only thing standing between a dispatch and a run, and
the section above says so rather than implying the protection exists. The
desktop application is a separate matter from all of
this: a packaged, signed install is verified on its own terms and none of the
evidence here says anything about it.

## Retained file-operation domain contracts

The main-process file/index and partial-patch engines remain domain contracts; the retired development workspace and its staging controls are not production destinations. The current inspector reads HEAD→index and index→directory without mutation. Use an external editor or terminal for development and staging.

Whole-file and partial-text domain operations remain guarded by exact file/index identities. A mixed status means a path has changes on both sides of the index, not that any inspected lines have been staged.

Only staged changes enter the next commit. Each hunk action checks the selected file's index and working-tree identity again, then takes Git's index lock before copying the complete current index. Another file staged while the diff was loading is preserved; a Git writer that encounters the owned lock must retry. If the selected file changed, refresh the inspector and review the diff. Renames and copies, new or deleted files, binary/untracked/conflicted files, unsupported text diffs, and oversized diffs require whole-file handling or conflict resolution rather than partial patching. Selected text patches retain adjacent replacement order, exact repeated-line positions, zero-context insertion anchors, CRLF, no-newline markers, and quoted Unicode paths where Git can safely apply them.

When a tracked text file also changes executable mode, staging a text hunk does not stage the mode change; the mode remains separately available through whole-file staging. A mode-only change has no text hunk to select.

## Stack synchronization and recovery

Sync Stack (`Mod+Shift+S`, or the `Sync stack…` command in the command palette) inspects existing fetched refs without fetching or pruning, discovers the native stack trunk, compares local vs. remote trunk tips, and plans a safe bottom-up restack of the entire captured stack. Use the separate **Fetch Git refs…** action when fetched authority needs updating, then prepare a fresh Sync preview.

### Trunk and layer classification

Before executing any mutation, the preview compares local and remote branch tips and classifies each layer:

- **Trunk drift**: Evaluates whether the trunk is up to date, behind, ahead, or diverged. If the remote trunk was force-pushed or rewritten upstream (`diverged`), syncing is blocked until the local trunk is reconciled to avoid replaying onto an inconsistent upstream history.
- **Merged layers**: Detects whether a lower layer's PR was merged (via merge commit, squash, or rebase). Merged layers are dropped from the replay cascade. Descendant layers are automatically retargeted onto the updated trunk or the highest surviving predecessor.
- **Rebase boundaries**: For squash- or rebase-merged predecessors, the replay boundary is derived from the immutable head recorded at merge time (`isProvenMergeHead`). If a safe boundary cannot be proven from Git history or the merge journal, syncing is refused to prevent replaying duplicate commits or dropping unmerged work.
- **Merged layers Git Stacks did not merge**: Branch config and the merge journal
  take precedence when proving a merged head. Without a recorded head, a two-parent
  merge commit can prove it through its second parent. Sync leaves the merged layer
  untouched and replays only the descendant's own commits onto the merge, preserving
  the surviving pull request's base GitHub already retargeted. Before mutation, the
  same proof is resolved again using a live GitHub read shared with the pull request
  checks. Changed or unreadable proof refuses the run. Squash and rebase landings
  have no second parent and still require a recorded merge-time head.
- **Layer states**: Each branch is classified as `up-to-date`, `needs-rebase`, `retargeted`, `needs-push`, `needs-force`, `merged`, or `blocked`.
- **A stack that is already current**: When every layer is published and matches the
  trunk and its predecessor, every layer is classified `up-to-date`, no lease is
  requested, and running the sync changes nothing — no branch is replayed, no remote
  branch is pushed, no ref is rewritten, and no pull request or native stack is
  written. The result reports the stack as already in sync with the remote it compared.

### Force-with-lease safety

Sync Stack never rewrites published remote history without explicit confirmation:

- When any layer requires a force push (because local history was rebased and replaced the published commit), the preview identifies the exact remote OID captured during fetch.
- Pushes use `--force-with-lease` specifying the captured remote tip. If another writer moved the remote branch while the local rebase was running, Git rejects the lease and halts execution immediately.
- The user must explicitly check the lease-approval box and type the target branch name before the sync action can be submitted.

### Conflict recovery

If Git encounters conflicts during the rebase cascade:

1. The operation pauses in `git-stacks-stack.json` in the selected worktree's Git administrative directory, saving its stable recovery identity, active replay proof and backup refs under `refs/git-stacks/backups/<id>/<hex-encoded-branch>`.
2. Inspect conflicted paths in the exact selected directory's read-only Changes inspector; no other directory is borrowed.
3. Resolve and stage conflicts in an external editor or terminal, then use **Continue** in the captured recovery workflow to resume the original owned replay. **Skip…** separately confirms dropping only the exact current paused commit; later commits and conflicts still follow the original journal.
4. **Abort** restores recorded local tips and metadata only where their current identities remain proven. External changes block rollback; already published remote or provider effects are not undone. Recovery retains the original force consent and leases.

## Linked issues

A pull request inspector and the pull request workflow dialog both list the issues
linked to that pull request, with each issue's current state and whether the
relationship is **closes on merge** or **related**.

**Search.** The dialog searches the origin repository's issues by number or
title. The typed text is a literal search: qualifier tokens such as `repo:` are
stripped, and results from any other repository are rejected, so a number that
exists in several repositories can only ever link the one this remote owns. A
closed issue can be selected — GitHub will not close it again, and the link stays
readable. When the transport fails or the machine is offline, the section reports
that issues are unavailable and the rest of the pull request workflow still works.

**Two kinds of link, deliberately separate.**

- _Related_ is app-owned local metadata (`gitstacks.pr.<number>.relatedissue` in local
  `git config`). It never changes anything on GitHub and is never claimed to be a
  relationship GitHub can interpret.
- _Closes on merge_ writes a real closing keyword (`Closes #12`) into the pull
  request description, which is the only form GitHub acts on. Detection and
  insertion follow GitHub's documented grammar: the keyword may be followed by a
  colon, and every issue needs its own full keyword, so `Closes #10, #12` closes
  only #10 and Git Stacks will still insert a complete clause for #12. Insertion
  is idempotent: an existing recognised clause is never duplicated.

**Preview, confirmation, and removal.** Both directions that touch the pull
request description are previewed first: the dialog asks the main process for the
resulting description and shows it, with the exact keyword that will be inserted
or removed, and only then dispatches. Removal deletes the exact clause that was
detected — a foreign `other/repo#12`, an unrelated `#123`, and every other word of
the author's description survive untouched. Removing a _related_ link needs no
confirmation because it only edits local metadata.

**External edits.** Every description mutation carries the body that was previewed.
The main process re-reads the pull request immediately before writing and refuses
the write if the body changed in the meantime, leaving the newer text intact.
GitHub's pull request update endpoint offers no conditional (ETag/`If-Match`)
request, so a change landing between that read and the write can still be lost;
this is a property of the API, not something the app can close. A refresh that
follows a link change never overwrites description text the user typed while the
refresh was in flight.

## Stack surgery

Stack surgery inserts a layer, moves a layer up or down, and removes a layer from a
linear stack. Each operation is planned, previewed, and applied bottom-up with the same
replay and recovery machinery as Sync Stack, so a conflict stops at the layer that caused
it and the original tips stay recoverable.

### What a surgery changes

- **Insert a layer** creates a branch at the tip of the layer you anchor on, reparents
  the layer that sat above it, and replays the layers above that. The new branch is
  created with no commits of its own; the preview names the exact tip it starts at.
- **Move a layer down** places it on the layer below, so the layer that used to sit
  there follows it and everything above that is replayed. **Move a layer up** swaps it
  with the layer above it: the passed layer drops onto the moved layer's parent, keeps
  its own subtree, and both layers are replayed in that order. Moving a layer under a
  layer it already contains is refused, because the result would be a cycle rather than
  an ordered chain.
- **Remove a layer** deletes the local branch and clears its recorded parent. A layer
  that has work above it is not deleted with its work: the layer above is replayed onto
  the removed layer's parent first. A merged pull request is never removed, because its
  pull request cannot leave the stack; Sync Stack drops merged layers instead.
- **A merged layer stays where GitHub merged it.** It is not moved, and no surgery may
  reparent it: GitHub will not retarget a pull request that already merged, so inserting
  a layer below one, or reordering the layers around one so its parent changes, is
  refused in the preview before a single ref moves. Inserting above a merged layer is
  allowed, because nothing GitHub merged is retargeted; the merged pull requests keep
  their branches, their bases, and their place in the native stack GitHub does not
  unstack them from.
- **Native stack membership** is GitHub's to own. Reordering submitted layers unstack
  the native stack and registers the pull requests again in the new order; layers that
  are not part of a native stack, and a repository that cannot use native stacks, plan a
  local-only surgery and say so in the preview. An inserted layer has no pull request of
  its own, so a stack whose members no longer form one chain from the trunk is unstacked
  rather than left registered in an order GitHub cannot hold.
- **An inserted layer that a pull request hangs from** is published to the remote before
  the retarget, because GitHub refuses a pull request whose base branch does not exist.
  The preview names that creation next to the retarget, and the push refuses to replace
  a branch somebody else created. Without a GitHub origin to push to, an insert below a
  submitted layer is blocked instead of planned.

### Preview and safety

- The preview lists every affected layer with its recorded parent, its new parent, the
  exact commit it is replayed from, the pull request base that changes, and the force
  push the run will need. A layer that only changes its recorded parent is shown as
  reparented rather than replayed, because no commit moves.
- A surgery is refused when a layer's replay boundary cannot be proven from Git: the
  recorded parent tip must exist and still be an ancestor of the layer tip. Git Stacks
  never guesses a fork point.
- Any change between the preview and the run — a moved branch tip, a rewritten parent, a
  changed upstream, or a different origin — invalidates the plan before a single ref
  moves. Preview tokens are single use.
- Force pushes need explicit consent and carry the remote tip captured during the
  preview, so another writer's push is rejected rather than overwritten.
- A run that stops part-way leaves the journal the recovery banner reads, including the
  branch it created and the branch it removed. Continue resumes from the journal without
  repeating completed layers; Abort restores every tip, the created branch, and the
  removed branch.
  A removed branch stays in place until every replay and remote step has
  finished, so an Abort that arrives earlier finds it already restored at the tip the
  preview captured.
- The remote half of a run - the pull request retargets and closes, and the native stack
  unstack and re-registration - is part of the same journal. Continue resumes supported
  remaining steps after a resolved conflict or confirmed readback of a lost response.
  Every step reads what GitHub actually holds, in full, before it writes: a step whose result is already there
  is recognised and completed instead of repeated, including a push whose ref already
  moved, a retarget that landed, an unstack that dissolved the stack, and a stack
  creation that was registered before the response was lost. A step whose pull request
  head, base, or state, or whose native stack membership, differs from both the reviewed
  pre-state and the reviewed result stops the run instead of overwriting it.
  A dispatched retarget, close or push still at its pre-state is unconfirmed, not
  proof of rejection, and is refused rather than dispatched again.

## Review workspace

Open a qualified **Pull requests** row, **Needs attention** item, lane PR link,
inspector review action or global-search PR result to reach the same selected
**Review** workspace. No branch is checked out. Management remains an explicit
secondary captured operation; the read-only workbench has no standalone staging,
commit, stash or graph-camera destinations.

Return navigation restores the repository-qualified lane query, selected ref/PR,
inspector state and mounted-page focus without borrowing another checkout.
Review retains its reading and composition state independently. Repository,
origin, host/account and credential replacement retire incompatible ephemeral
reads and navigation; authored drafts and journals remain stored under their
original owner. Navigation never checks out a branch or dispatches a mutation.

Review read results remain Query-owned, while selection and unsent form values
remain local. While a structured repository mutation is busy, a refreshed file
set waits to replace the displayed comparison. Observed head/base changes still
warn and block submission immediately; presentation deferral never defers safety.

Viewed-file aids are stored in a host/repository/viewer-qualified local namespace,
bound to the full head/base/base-ref comparison. Older unqualified viewed marks
are left untouched but cannot certify this account's reading. New draft, observed
history, and uncertain-write owners include the host as well as repository and
viewer. Captured review/thread/history-clear owners are revalidated in main before
writes; submissions and replies are checked again after acquiring the journal lock.
Unsent comments retain their original full comparison when saved or submitted.
New drafts and uncertainty records use `git-stacks-review-drafts-qualified.json`
and `git-stacks-review-uncertain-qualified.json` in the repository Git directory.
The original journal files are read-only recovery material, never normalized or
migrated by a new save or delivered-draft cleanup. **PR actions →
Recover unattributed local text** is an explicit local recovery dialog: it first
lists original recorded identities without bodies, and shows text only after
**Show original text for manual recovery**. That text is not attached to the
current hosted account/PR; it contains no recovered anchors, cannot be edited or
submitted there, and opening/closing recovery does not change the journal.
Uncertain legacy attempts cannot be adopted or replayed against another host.

**Code** owns the body by default. **Description & reviewers**, **Checks**,
**Commits**, and **Conversation** open the existing context surfaces beside code
at wide widths and switch the body at constrained widths. **Code** reopens the
diff with its selected file, layout, whitespace choice, comparison, line range,
scroll, and unsent draft text preserved. Each reading region scrolls locally,
including at 200% desktop zoom. The diff renders a two-hundred row window and
labels how many rows are mounted; **Show 200 more diff rows** grows that window.

The headline arrives before files, commits, threads, and detailed checks. Each
read has its own loading/failure state and belongs to the selected repository,
host, credential authority, PR, and revision. Late answers from retired
selections cannot populate a replacement workspace. Reviewer requests and
latest reviews are bounded to the first 100 of each; partial or unavailable
metadata is labelled. Earlier-head reviews are not current-head approvals.
Description is rendered as plain text. **Comparison** discloses observed
snapshots; historical mode always explains the submission freeze even when
that disclosure is closed.

The file tree groups changed files by directory, shows each file's status, size,
and generated/binary/too-large state, and searches both the new path and the path
a rename came from. Arrow keys move between rows and Enter or Space opens one; the
rows are plain buttons, so nothing here depends on a custom widget role.

Remote patch headers preserve spaces, quoted characters, and non-ASCII paths,
including a renamed file's old path. A missing patch with zero added and removed
lines is **no text diff**, not evidence of binary content: pure renames, mode-only
changes, empty files, and binaries can all have that shape.

GitHub's pull-request commits endpoint returns at most 250 entries. The commit
list carries the reported total and marks incomplete results explicitly. At the
cap with no reported total, it says the list may be incomplete; a confirmed total
of exactly 250 is complete. Open the pull request on GitHub for its full history.

The diff has unified and split layouts and a **Hide whitespace** toggle. The
toggle is a filter over the text GitHub already sent — the pull request files API
has no whitespace option — and it hides only a removed/added pair that is
identical once spaces and tabs are removed, reporting the hidden count against
Git's own hunk header. Line endings are left alone so a CRLF conversion stays
visible. Both layouts render through the same paged window, so a large diff stays
bounded and the rows keep the same identity across pages.

**Next/previous file** and **next/previous layer** are remappable in Shortcut
settings and dispatched by the app shell through a ref the view publishes, so the
view never registers a competing key listener. Layer navigation reads the native
stack only: choosing an adjacent or nonadjacent layer changes what is being read
and never dispatches a checkout or remote mutation.

The collapsed stack summary names the viewed layer and the reported stack size.
Opening it reveals all returned native members in submitted order, initially
scrolled to the viewed layer. All returned member rows stay mounted inside the
local scroller, without repository-list paging state. The member list has one Tab
stop, initialized to that layer; unmodified arrows and Home/End move focus within
the list, and Enter/Space opens the focused PR. Full titles, lifecycle, draft,
checks, and review facts reflow inside the bounded disclosure. The PR headline
also discloses its full title without growing the default code header.

Native membership is independent of optional layer metadata. One bounded,
cancellable main-process GraphQL batch reads at most 32 members, including the
viewed layer, without dropping any submitted members. Unloaded or malformed
checks/review facts remain unknown; a head disagreement with known native
membership or the viewed PR is stale. Native lifecycle and draft facts remain
visible when optional enrichment omits those fields. Partial membership reports
its loaded count; adjacent shortcuts never skip an omitted native position.
Unavailable membership is not presented as an empty stack.

**Blockers & relationship sources** shows actual local parent comparisons and
reconciliation evidence, not a restack inference from failing checks or a merged
label. In Stacks, submitted native order is disclosed separately from local
children-above-parents order, including repositories with no local feature
branches. Local rows keep branch and parent provenance behind details.
Inspection does not prepare or execute Restack, Publish, repair, or Merge; those
actions retain their existing captured previews and confirmation gates.

Opening a file records it as viewed locally, bound to the whole comparison it was
read at: the head commit, the base commit, and the base branch name. A force-push
or a push to the base branch changes the diff, and a retarget changes what the
files are relative to even when both commits are untouched, so the marks are
dropped rather than carried onto a diff nobody looked at. Nothing is written to
GitHub.
The file toolbar also offers **Mark file as unviewed** and **Mark file as viewed**.
These update that same comparison-bound local record, not an independent display
flag; removing one mark leaves the other files' marks intact.

### Line identity contract

`ReviewLine` in `packages/shared/src/review.ts` is the contract other review work anchors
to. A line carries its `side` (`base`, `head`, or `null` for a marker), its number
on that side, an `anchor` (the file path plus the line's text with its diff marker
removed), and a `context` (the anchor plus up to two neighbouring lines of the
same hunk each side). A hunk reuses the local staging surface's `hunkId` scheme.

A line number is an address, not an identity. `resolveReviewAnchor` in
`apps/desktop/src/main/review.ts` re-resolves a stored `ReviewLineRef` against a freshly read
file set: **exact** when a unique same-side anchor and its neighbourhood are intact,
**moved** when the line's own text survives once but its neighbourhood changed (the
reason says where it went), and **unresolved** with a reason a reviewer can act on
for edited text, a duplicated line, a file the pull request no longer touches, or
a diff that is not available as text.
A duplicate remains unresolved even if only one copy retained the old context.

Resolution never crosses a side. A comment on a removed line is not re-anchored
onto an added line that happens to carry the same text — that would read as a
comment on the replacement. When the text survives only on the other side, the
result is unresolved and the reason names the side the line moved to.

### Reading a pull request at one revision

The file and commit reads are pinned to a single comparison. The comparison's
identity is read before the pages and again after them, and both objects count:
GitHub diffs the head against the merge base of the base and head, so a push to
the base branch changes the diff with the head object unchanged. If either moved,
or the head could not be read, the read fails with a message asking for a reload
rather than returning a set labelled with an oid the pages never came from. This
matters because viewed-file marks and any later review comment are recorded
against that oid.

The headline is read first, so a force-push between the two reads can leave its
oid out of date. The workspace says the head is _as of the headline_ in that case
instead of presenting it as the revision on screen.

### Leaving a review

The conversation pane carries the whole review loop: what has been said on
GitHub, what is still unsent, and the one decision that submits it.

A line number in the diff is the control that starts a comment, so a draft is
created by choosing the lines rather than by typing a path and a number. Holding
shift extends the range to a multi-line comment, which becomes GitHub's
`start_line`/`side` pair.
Code stays open while endpoints are selected. Open **Conversation** to add the
selection as a pending comment; opening the composer is explicit so it cannot
hide the second endpoint at constrained widths.

Drafts are local. They are journalled to the repository's own storage under the
app's data directory — GitHub has no "pending comments" resource to hold them —
and are re-read when the workspace opens, so navigating away to another pull
request and back does not lose them. That file is shared by every window and
every worktree of the repository, so each update of it is taken under a lock
another process can see: two windows saving different pull requests at once
cannot read the same journal and publish over each other. The lock is a file
beside the journal created with an atomic link, so exactly one process takes the
name and the winner owns it until it removes it.

A lock is only ever released by the window that took it, never taken from it.
That is not caution, it is the only correct choice: unlinking or renaming the
name frees it, a second process takes it and is inside the journal in the
meantime, and nothing done afterwards can un-enter it. An open file descriptor
pins the inode a lock was made from, which is how two locks are told apart; it
does not hold the name and it is not ownership. So there is no automatic
reclamation of a lock whose holder has gone.

It fails closed instead. A lock held by a process that is still running is
waited for, because that is a window mid-write and it will let go. A lock whose
holder is gone, or one this build cannot read as its own, refuses the write at
once and names the file and the condition under which removing it is safe:
close every Git Stacks window for the repository, confirm none is open, then
remove that one file, and the next write takes the lock itself. That step
belongs to a person because whether somebody still has a window open is not a
fact on disk.

Only one thing is worth trying again, and it is the one case that is not a
refusal: a lock that is no longer there when the contender reads it was simply
released, so the next attempt takes the name. Every other failure to read it —
a lock this account may not open, or a path that is not a file — says nothing
about the holder at all, and no waiting helps, so the write refuses immediately
with the reason it could not be read and the same instruction about that one
file. Retrying it would spin on a lock that never goes away while a window sits
on a save that will not finish. Records are never dropped to keep the file small
— unsent words and unresolved-write guards both leave it only when they have been
sent, cleared, or settled.

A draft record carries the whole comparison
it was written at, plus the repository and the signed-in account it belongs to:
the journal is shared by every worktree of a repository, so the record rather
than the file is the boundary, and drafts written for another repository or by
another account are never offered for submission. A draft from a superseded
revision is shown as stale instead of being re-anchored onto a diff nobody was
looking at. A draft is drawn with a dashed rule and a "pending" label, and never
looks like something already sent.

Submitting writes every pending draft as **one** review: GitHub's
`POST /pulls/{number}/reviews` takes a single `comments` array, so several
separate inline comments become one Comment, Approve, or Request changes event
rather than N events. Approving your own pull request is refused locally, because
GitHub refuses it and a failed submit after several comments were already written
is a worse experience than never offering it. The viewer permission gate comes
from GitHub and GitHub stays authoritative: a permission the app believes is
missing is still a mutation the server can refuse, and its refusal is reported
as it came back.

Anchors are revalidated in the main process immediately before the write, not
from what the renderer happened to be holding. A force-push since the draft was
written produces **zero** mutation rather than a best guess: the drafts that can
no longer be placed are reported individually with the reason, and nothing is
posted to a line or a revision the reviewer did not name. One stale draft holds
the whole review rather than being left out of it, so a submit never succeeds
with a comment quietly dropped.

The comparison the diff was rendered from travels with the submission and is
checked against a fresh read before the anchors are resolved. A comment whose
text still matches after a force-push has usually just moved, and adopting that
would approve a revision nobody opened, so a changed head, base, or base branch
refuses the review outright and names the commit to look at instead.

There is no blind replay. A submission whose response was lost is not retried
automatically, because a duplicate review is a comment the reviewer never wrote —
and an error message is not enough to prevent one, since it vanishes on reload
and hands the same words back to a live button. The attempt is journalled
**before** the request leaves, so a crash between the POST and its response is
covered rather than being the one case with no record. It records the whole
payload: every comment's body and anchor, the decision, and the newest review
the pull request already held when the attempt began.

An unresolved attempt is never dropped to keep the journal short, however many
accumulate. It is the only proof that a request went out: if it did land and the
record is gone, reopening that draft and submitting again posts a second review
instead of reconciling the first. A record leaves only once GitHub's own state
settles it, or once a later submission's payload no longer carries its comments.
A submission that cannot record its attempt is refused rather than sent without
one.

The journal is not a dead end. Pressing Submit asks GitHub what it actually
holds, and every part of the attempt is checked — the review is newer than the
recorded boundary, is this account's, is on this revision, records the decision
GitHub stored for it, and carries the same comments. A matching summary on its own
proves nothing and is not what is matched on. Those two reads come from REST:
`PullRequestReviewComment` has no `side` or `startSide` in GitHub's schema, so
GraphQL cannot answer them and a query naming them is refused outright. REST
reports them as `LEFT`/`RIGHT`, converted once to the diff's `base`/`head` for both
ends of a range — without which a comment on a deleted line is recorded as a head
comment and can never be recognised as its own attempt.

If the review is there, the attempt did land. Those comments are left out of what
is sent, so a recovery posts only what never arrived, and every comment the
operation confirms is named back — the adopted ones and the newly posted ones
alike — so the view drops exactly those and the drafts that were never sent stay
pending.

Checking a review on this revision is not enough on its own. A reviewer can send
a comment on a line, then write the same words on the same line of the same head
while approving instead of commenting, and every field the check compares — the
line, the words, the account, the revision — reads identically for the two. So a
pending comment is named by an identity minted where it is composed, not by the
line it is on, and a recovery only looks at records that name this payload's
comments.

That identity is generated, not counted. A count is only unique if one process
owns it, and the journal is read by every window of the repository: two windows
that opened the same record and counted from the same number would mint one name
for the same line, and a settled record naming it would then answer for the other
window's comment — clearing words it never sent and reporting a decision GitHub
never received. Nothing has to be allocated, persisted, or reclaimed for a
generated name to stay unique, so the record keeps the words and nothing else,
and a record whose drafts are all sent is dropped rather than kept as a counter.
Identities minted before this — the range alone, or the range and a small whole
number — are opaque strings too, so every stored draft still reads and submits,
and none of them can be minted again.

That name is recorded per comment, so a review is only ever evidence about the
comments it was made of. Two comments sent together that land and go
unacknowledged, followed by a payload carrying one of them unchanged and a fresh
one written on the same line with the same words, deliver the first and send the
second — the review posted a different comment that happened to read the same,
and the decision made afterwards is still a decision to send. A comment reworded
after it was composed sends the new words rather than being taken for the old.

A settled write is kept rather than tidied away. The evidence that GitHub holds a
comment is the only thing between a retry and a duplicate, and the submission that
found it can still fail, or be killed before the view drops the draft. What retires
the record is a later payload that no longer carries those comments: the view keeps
a draft in its payload exactly while it has not been told it was delivered. That
makes a resumed submission idempotent without waiting on a callback the view may
never send, and GitHub losing the ability to re-derive the answer — because the
review was edited on the web — cannot hold the write for good.

The search is not limited to recent history. An attempt outlives any window, so
the reviews are walked newest first until the recorded boundary is reached, and
running out of pages before then is a hold rather than a "not there" — the search
gave up, which is not the same as concluding. Both collections are paged in full:
a review may carry 200 inline comments and a page holds 100, and a review whose
tail was never read cannot be compared whole. If GitHub does not hold the review
once the search is exhaustive, the guard stands: the record says only that the app
never heard back, which is also true of a request that never arrived, so absence is
never taken as licence to post again automatically.

The guard covers an unresolved _comment_, not an attempt. Changing the decision
or adding one more pending draft changes the attempt but not the comments, so
every attempt touching any line this payload writes is reconciled first — and what
is journalled is what is sent, so a recovery cannot re-post a comment it just
adopted.

Replies reconcile against the thread's own comments by the same rules, with the
comment ids the thread held when the attempt began as their boundary and this
account as their author — an older identical reply, this account's own or a
collaborator's, is not this attempt. Each record is scoped by repository and by
pull request, and by account, so one account's or one repository's unresolved
write never blocks another's review.

The search is not limited to recent history. An attempt outlives any window, so
the reviews are walked newest first until the recorded boundary is reached, and
running out of pages before then is a hold rather than a "not there" — the search
gave up, which is not the same as concluding. Both collections are paged in full:
a review may carry 200 inline comments and a page holds 100, and a review whose
tail was never read cannot be compared whole. GitHub lists reviews in
chronological order, so the boundary is read off the last page and not the first —
on a busy pull request the greatest id on page one is nowhere near the newest, and
a review that already existed would sit above that line and be taken for a write
that never arrived. A boundary walk that cannot reach the end records none rather
than a low one, because a wrong boundary is worse than an absent one: it errs
toward adopting somebody else's review. If GitHub does not hold the review once
the search is exhaustive, the guard stands: the record says only that the app
never heard back, which is also true of a request that never arrived, so absence is
never taken as licence to post again automatically.

The guard is bound to the revision it was written against. A record about a
different commit is not this submission's recovery: it is neither delivered nor a
hold, and it is retired. A settled record proves GitHub took that write, and it
proves it about that commit — reviewing H1 says nothing about H2, and the same
line carrying the same words on the new head is a new comment about a new commit.
Without that, approving the same line again after a push would clear the draft,
send nothing, and report an approval GitHub never received.

Exhausting a thread's comment pages is reported rather than presented as the whole
conversation. Resolved and outdated are independent facts and both appear. Files
and threads are read separately, so their revisions are compared before a thread is
allowed to jump to a line or compose a comment; a mismatch is shown with a reload
rather than resolved by guessing.

### Review update snapshots and historical comparison

GitHub pull requests do not retain complete version history for arbitrary force-pushes. The review workspace approximates PR versions from observed head SHAs without claiming a complete history the app never saw:

- **Observed head snapshots**: Persists observed head SHAs, timestamps, observation counts, and confirmed review associations in a journal beside the repository Git directory (`git-stacks-review-snapshots.json`). Identical heads deduplicate rather than append; a force-push or rebase creates a new snapshot entry.
- **Changes since reviewed shortcut**: One-click comparison between the newest head the current user confirmed/settled a review for and the current pull request head.
- **Arbitrary snapshot comparison**: Compares any observed historical snapshot to the current head using GitHub's two-endpoint compare API.
- **Hide unchanged files**: In comparison mode, files whose contents did not change between the two compared endpoints can be hidden to focus exclusively on updates since the last review.
- **Explicit history gaps**: When opening a pull request for the first time that already has multiple commits on GitHub, the workspace displays an informational gap banner explaining that earlier heads were not observed by the app and comparisons from them are unavailable.
- **Missing commits and merge-base loss**: If a historical commit was garbage-collected after a force-push or its remote branch was deleted, or if an external rebase caused merge-base loss (unrelated histories), the workspace renders an explicit unavailable alert naming the exact cause, never a fabricated fallback diff.
- **Bounded pruning**: Snapshot records are capped (maximum 40 entries) while strictly retaining user-visible reviewed anchors.
- **Zero GitHub mutation**: Snapshot metadata contains no source text, diffs, or comment bodies, and clearing local history wipes only the local journal.
- **Review after clearing**: A subsequently confirmed or adopted review records its reviewed head again, even if that head was absent from local history. Previously cleared observations remain cleared.
- **Selection isolation**: History reads, clears, and comparisons cannot replace another selection's history. A pending comparison clears the previous file list and counts.

Run snapshot unit and integration tests with:

```sh
pnpm --filter git-stacks exec tsx --test tests/review-snapshots.test.ts
pnpm run test:ui tests/renderer/review-snapshots.spec.ts
```

## Historical PR Inbox domain rules

The duplicate PR Inbox destination and `Mod+9` route are retired. Its provider
read/grouping rules and independently authored records remain historical domain
contracts; current triage lives in repository-qualified Needs attention and
Pull requests, with Review reached without ambient `openRepository` activation.
The retained `pr-inbox-*` data fixtures are source inputs, not a promised route.

### Group semantics

Group membership is a pure function of GitHub-reported facts. The signed-in viewer is the login the host reported for the read; logins are compared case-insensitive. A read that names no viewer places a pull request in no viewer-relative group — authorship and a request to the viewer are undecided rather than false — and the repository is reported as read without knowing whose queue this is, so the rows that stop being listed stop for a stated reason. A host that refuses the review, comment, and check fields answers a degraded read: the row is marked as read without that metadata, its check badge reads "unknown" rather than reporting a result the host never gave, and it is placed only in the groups those facts support. Drafts and recently merged do not depend on the account, so those rows keep their groups either way.

| Group                 | Rule                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Review requested**  | Open, not a draft, directly review-requested from you, and not authored by you. A pull request you opened yourself is your work, not a review you owe, so asking yourself for review never lands here. |
| **Needs my response** | Open, not a draft, authored by you, and either changes were requested or the last review or comment is somebody else's. A pull request nobody has spoken on is not waiting on you.                     |
| **My PRs — waiting**  | Open, authored by you, not a draft, not waiting on your reply, and not approved.                                                                                                                       |
| **My PRs — approved** | Open, authored by you, not a draft, and GitHub's review decision is approved.                                                                                                                          |
| **Drafts**            | Open and a draft, whoever opened it. Drafts are never in a review group.                                                                                                                               |
| **Recently merged**   | Merged within the recent window (30 days by default), measured from the read's own clock.                                                                                                              |

Only one overlap is intentional: **My PRs — approved** and **Needs my response**. The two answer different questions — what the reviewers decided, and who owes the next turn — so a pull request that was approved and then commented on is genuinely both. Every other pair is disjoint; `inboxGroupOverlapsAllowed` names the one allowed pair and `apps/desktop/tests/pr-inbox.test.ts` holds the rest closed across the full cross-product of state, draft, author, request, decision, last turn, and merge instant.

### Rows, search, and saved filters

Rows are compact and keyboard-navigable: the list is one composite widget with a single Tab stop, arrow keys, `Home`, and `End`, and `Enter` opens the row into its repository's Review without dispatching a Git action. Titles wrap; identity, author/repository and branches sit beside aligned update time, changed lines (additions + deletions), native-stack position and unresolved review-thread counts. Lifecycle, checks and review states remain independent. A confirmed count of zero is displayed as zero; unavailable counts explicitly say **unknown**, **unsupported** or **stale**. Unresolved-thread reads stop at 100 threads per PR, and a count from an incomplete connection is displayed as a lower bound with **truncated**. Counts travel in the existing budgeted GraphQL pages, not one request per row. A host that refuses optional count fields is retried without them while retaining the existing group-membership metadata.

Changed-line counts are confirmed only when additions, deletions and their sum are nonnegative safe integers. Malformed thread nodes or missing pagination leave the thread count unknown.

Search matches title, `#number`, repository, head branch, base branch and author; every whitespace-separated term must match. `/` focuses the queue's own search. Structured criteria select multiple registered repositories, authors, directly requested reviewers, lifecycle/draft states, review decisions, checks and minimum/maximum changed lines. Fields combine with **AND**, multiple values within a field with **OR**, and absent fields do not constrain. Login and repository comparisons are case-insensitive and exact. A PR whose required fact is unavailable is excluded rather than treated as zero, no review or passing; the visible exclusion count explains those unevaluable rows. Criteria and counts remain visible when the detailed controls collapse. **Clear filters** restores the default group, no criteria, no search and recently updated sort without changing any built-in membership rule.

Saved views retain the name, full criteria and chosen sort: **Recently updated**, **Largest change** or **Smallest change**. Unavailable sort values are always last; host, repository and PR number break ties consistently. Legacy disk filters containing a single repository migrate to a one-value repository criterion with the same ID, name and matching membership. Runtime callers use only the structured contract. Views are stored in `pull-request-inbox.json` beside settings, written atomically at owner-only permissions, one write at a time, and reloaded on launch. Malformed drafts refuse the whole write. Listing and saving join the same initialization; returned lists deep-copy their criteria, and late loads cannot overwrite a completed save. The renderer holds a synchronous save lock and generation gate and keeps persistence controls locked until readiness completes, so overlapping load/save transitions cannot clobber other views.

### Refresh states

Empty, filtered-empty, stale/offline, auth-required, and partial-permission are five different answers, and the queue never reports an unanswered read as an empty one. A read that was **ended** is a sixth, separate from all of them:

- **empty** — GitHub confirmed the read and the group genuinely holds nothing.
- **filtered-empty** — GitHub confirmed the read; this group, search and structured criteria select none of the rows.
- **unconfirmed** — the read did not answer. The last confirmed rows stay on screen behind the reason, and if there are none the queue says it is unconfirmed rather than showing an empty list.
- **partial** — some repositories answered and some could not. The rows below are the ones GitHub confirmed, and the unread repositories are named individually (`not visible to this credential`, `sign-in rejected`, `GitHub unreachable`, `origin is not on a GitHub host`, …).
- **degraded** — the host answered without the review, comment, and check fields its schema does not carry. The rows are real and stay on screen, their check state is explicitly unknown rather than reported as no checks, and the read is never counted as complete.
- **membership unknown** — the host read the rows and named no account for them, so whose queue they are could not be established. Every viewer-relative group is left undecided rather than decided against a person the read could not name, the rows that do not depend on an account keep their groups, the repository is named as _read without knowing whose queue this is_, and the read is never counted as complete. It is stated ahead of a narrowed read, because the reason those rows are not being shown as work is the missing account, not the missing metadata.
- **failed** — the request was made and the host answered with something this build cannot read as a verdict, such as a server error. It is never reported as a repository that was not attempted: the repository keeps the reason the host gave, and a queue that read nothing because every repository failed names that reason per repository rather than reducing them all to one line.
- **skipped** — a repository outside the refresh's request budget, or on a host whose credential was already rejected in this refresh, is reported as _not attempted_, never as an empty repository.
- **retired** — the read was ended before it confirmed anything, because the identity it was reading for is no longer the one asking. It carries no rows, no repositories, and no login, and it says so without claiming a sign-out, a lost connection, or a queue that was never read. Keeping the last confirmed rows is for a read that could not answer under the identity that confirmed them, so this state deliberately empties the queue instead of inheriting it.

The refresh is budgeted twice, and both halves count what actually happened. It refuses to start while GitHub's remaining budget is below the 250-request reserve the repository sync already keeps, and it stops mid-refresh once the 24-request per-refresh cap is spent, naming the repositories it did not attempt. Every round trip is charged before it is made — a refused field and the narrower query that follows it, each page of the pull-request listings, the native-stack capability probe, and each page of the stack collection — so a repository that fails part-way cannot spend the allowance while contributing nothing to it. Admission reads the allowance the host itself reported, in the window that report belongs to: a count from a window that has already closed is set aside however recently it arrived and however much more it allows, and where another report for that host and credential still describes an open window, that one is what admission reads. GitHub counts each window separately, so a spent window never refuses a later one. A refusal is believed on GitHub's terms rather than the read's: whatever wait it names — a `Retry-After`, or the moment the primary window resets when it names no counter at all — runs from the answer that carried it. That wait is shared by ordinary repository reads and Inbox reads, rather than belonging only to the read that met it, with credential-scoped primary limits and host-wide secondary waits distinguished below.

Primary allowance observations also belong to the credential that made the request, not just the host. Ordinary repository reads and Inbox reads share that credential's allowance; replacing the credential on the same host does not carry the previous account's spent primary window into the replacement account's queue. A primary-limit refusal stays with that credential: it names that account's window, not the host's, so no primary refusal establishes a wait the whole host serves. A secondary-limit refusal does, and its wait applies to whoever asks next. A late answer from the previous credential cannot lower the replacement's primary allowance, nor the line the replacement stands behind. A late answer from the previous credential cannot lower the replacement's primary allowance. Replacing one host's credential leaves other hosts' observations intact, and installing or clearing a stored account does not discard a primary reserve for an unchanged environment credential that overrides it.

A primary window lasts as long as the later of the two moments that refusal named: a counter that resets in ten minutes does not shorten an account that was told to come back in an hour, and a retry named past the reset does not shorten the window the counter opens. It is that one account's window either way. A window with nothing left in it is not spendable at any reserve — a reserve of zero says there is no headroom to protect, not that an empty window can be asked. A secondary refusal spends nothing and invents no window of its own: it is the shared wait every account on that host is held to for as long as it names, and the positive count it carried is still true of each account until then. A replacement credential is admitted inside it, and is admitted because it has spent nothing; an account that signs in again after being replaced waits out its own window until that window has passed, with nothing asked of the host meanwhile. A primary refusal that names neither a reset nor a retry duration stops that principal's remaining repositories in the current refresh, but does not invent a deadline for the next refresh or stop another principal.

Rows belong to one identity. The account, its credential, and the selected host decide whose queue is on screen: signing out, switching accounts, or changing host ends the read still running for the previous identity, refuses its late answer, and drops its rows rather than showing them until a refresh can answer for the new one. Which host that is comes from one decision, in one order, because a host read from the wrong place names the wrong credential. The host serving a configured non-public API base decides first, and decides even when a host was named as well, because the CLI is sent to that URL and authenticates as whoever serves it; then the host that was named; then `GH_HOST` from the merged environment, canonicalised; and only then the public host. A base equal to the public default is the public host by fallback rather than by anyone's decision, so it resolves nothing a host name does not and cannot outvote a host that was named. The same host names the requests, the credential asked of the CLI, the environment the CLI's process runs with, and the allowance the answers are credited to, so all four can never disagree. Registered clones and worktrees of one remote are one GitHub repository, so they are read once, counted once, and opened through one deterministic local path.

Leaving the destination cancels the read it started. The queue reads on open and on a 60-second cadence only while its destination is visible, and each read claims the `inbox-refresh` request id, so a superseded read and the one abandoned by navigating away both stop in the main process rather than spending the budget of a window nobody is looking at.

Run the Inbox tests with:

```sh
pnpm --filter git-stacks exec tsx --test tests/pr-inbox.test.ts tests/pr-inbox-views.test.ts tests/pr-inbox-service.test.ts
```

Historical Inbox filter/read contracts remain available for persisted data and domain regression coverage; the standalone Inbox presentation is retired. Current user triage is qualified Needs attention, and full Review opens through repository Pull requests or Attention without borrowing a checkout.

## Repository PR/ref discovery contract

`DesktopAPI.prIndex()` returns the first lightweight open-PR page without waiting for later pages, native-stack probes, or review detail. `onPrIndex` publishes later pages and terminal states; subscribe before requesting the index and use the returned value as the initial state. Each result names the active repository, host, viewer (or `null` when not reported), page count, last checked/confirmed instants, and explicit `loading`, `partial`, `complete`, `stale`, or `error` status. Only `complete: true` establishes that open PR enumeration ended. Failed or cancelled pages retain previously observed topology; a replaced account or repository clears it. A selected PR can request `prIndexDetail(number)`, which reads its body and canonical current fields on demand and retains at most four completed details. `cancel('pr-index')` ends the page run. Ordinary local repository opening does not wait for complete GitHub enumeration; the existing sync coordinator refreshes the full snapshot afterward.

Selected detail is bound to the current source head/ref and base target, not just the PR number: a changed head or a same-head retarget retires retained detail, and a read overtaken by refreshed source facts is refused. Complete snapshot adoption does not establish a viewer; if it overtakes the first lightweight page, the next index read still obtains the viewer from GitHub rather than guessing from authors.

Selected reads capture their repository generation before the initial authority check. Retirement during that check rejects the admitted request before its detail reader runs, even if a replacement repository has already loaded.

Focused model and transport checks: `pnpm --filter git-stacks exec tsx --test --import ./tests/setup/owned-cli-boundary.cjs tests/workbench-model.test.ts tests/pr-index.test.ts tests/github.test.ts`.
