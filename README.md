# Git Stacks

A local-first desktop workbench for Git branches and stacked pull requests.

Design rules live in [DESIGN.md](DESIGN.md). This guide covers how to run the app,
how the large-repository work is measured, and how development and verification
are performed; record run-specific evidence and outstanding acceptance checks in
the associated pull request.

## Commands

```sh
npm ci                 # install
npm run dev            # run the app
npm run build          # typecheck + production build
npm test               # the test suite
npm run format:check   # formatting gate
npm run bench:performance  # large-repository benchmarks
```

When changing `GitAction`, update the renderer fixture's action messages in
`tests/renderer/fixtures/control.ts` and affected test payloads. `npm run build`
typechecks these test consumers as well as the application.

Stale-preview publishing tests assert rejection and unchanged local and remote
refs. Diagnostic wording is not part of that behavioral contract.

Renderer checks distinguish the `/` in-view filter from the `Mod+K` command
palette. The safety suite advances pending hover timers after opening a
destructive dialog to verify that contextual cards cannot cover its warning.

## Performance budgets

Git Stacks is used on repositories far larger than the ones it was built
against. The budgets below are exported from
[`src/shared/performance.ts`](src/shared/performance.ts) and are the single
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
| `DIFF_PAGE_SIZE`         | 1000 lines    | `DiffView`                                 |
| `MAX_STATUS_BYTES`       | 8 MiB         | `listStatus`, cut on NUL record boundaries |
| `MAX_HISTORY_BYTES`      | 1 MiB         | `getHistory`, cut on NUL record boundaries |
| `MAX_DIFF_BYTES`         | 4 MiB         | `getCommitDiff`, `changedDiff`             |
| `MAX_FILE_BYTES`         | 2 MiB         | working-tree file preview                  |
| `GIT_CONCURRENCY`        | 8             | `mapWithConcurrency`                       |
| `SNAPSHOT_BRANCH_BUDGET` | 1500 branches | per-branch analysis in `getSnapshot`       |

### Benchmarks

```sh
npm run build
npm run bench:performance
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
fixture. It starts before process launch and ends after the automation clicks
the pre-seeded recent repository and its first 200 branch rows complete two
animation frames. The `interaction` measurement starts at an actual input event
in the “Filter current view branches, files, and pull requests” field, not the
command palette, and ends after the filtered branch result completes two
animation frames. The separate `diff-render-ssr` measurement is server-side
rendering cost for a 1,000-line diff preview; it is not an input-to-paint budget.
CI installs `xvfb` and `xauth` on the self-hosted Linux ARM64 runner, builds the
app, and runs Electron under Xvfb. The runner needs passwordless `sudo` and
Debian-compatible `apt-get`. Local runs need a display server.
Compare trend results on the same runner class and Git/Node versions, since
filesystem and process startup costs vary by machine.

It writes `benchmarks/latest.json` and appends one line per run to
`benchmarks/trend.jsonl` (capped at the last 200 runs). The `Performance budgets`
workflow runs the harness on every push and pull request, uploads `benchmarks/`
as an artifact, and fails the job when any measurement exceeds its budget.

### What the hot paths no longer do

**One config read instead of two per branch.** `getSnapshot` issued
`git config --get branch.<name>.parent` and `branch.<name>.parentTip` for every
local branch. It now reads them all in a single
`git config --null --get-regexp` pass, using the same idiom the GitHub
integration already used for tracked pull request numbers.

**A concurrency ceiling instead of one process per branch.** Parent inference
probes distinct tips in batches; direct descendants of the default branch need
no individual merge-base process, while deeper histories use the existing
merge-base fallback. Behind-counts run through `mapWithConcurrency` at
`GIT_CONCURRENCY`, rather than forking one process per branch at once.

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

### Documented limits

These are the extreme cases the app states rather than hanging or crashing on.

- **A changed-file listing past 8 MiB.** The listing is cut on a record boundary
  and `limits.filesTruncated` is set. The Working changes view says how many
  files it is showing and disables bulk stage, bulk unstage, and stash, because
  acting on a partial listing would silently skip files. Inspect individual
  files, or use an editor or the command line for the rest.
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
- **Pull request enumeration follows `gh`.** The renderer reveals pull requests
  incrementally; the main process still asks the `gh` CLI for the origin's open
  and tracked pull requests in one paginated call.

## Renderer verification

These fixtures exercise Git Stacks, not the Journey prototype. Production React components, tokens, and the real `App` are imported by a separate Vite entry point under `tests/renderer`; the packaged renderer does not expose a fixture route or install a fake desktop API.

### Fresh checkout

Use Node 24 and the committed `package-lock.json`:

```sh
npm ci
npx playwright install chromium
npm run gallery
```

Open the loopback URL printed by Vite. No GitHub credentials, Electron preload, personal repository, external font, or chat artifact is required. The deterministic `DesktopAPI` double records requests in memory; it never executes Git, authenticates, or opens external URLs. Treat its action history as evidence of renderer dispatch only, not proof that a Git operation succeeds. The packaged smoke covers real local Git separately.

Append `#/index` for the scenario directory. App scenarios use `/?scenario=shell-connected#/app`; the gallery activates the real App's Open local repository control to load the deterministic snapshot. `shell-no-repository` and `shell-loading` intentionally stay on the no-repository/loading surface. Component routes retain `#/design-system-controls`, `#/design-system-shell-specimen`, `#/design-system-data-specimen`, and `#/design-system-dialog-specimen` in this separate gallery only.

The typed control surface is `window.fixture`: `actions` and `externalUrls` record dispatch; `calls` records reads and writes; `hold(method)` and `release(method)` control in-flight requests; `failNext(method, message)` rejects one request; `setScenario(name)` remounts the App against another deterministic snapshot. This API exists only in the gallery. `manifest.ts` lists all scenario names; `scenarios.ts` owns their typed data.

The conflict fixture implements `conflictView` with index stages and a captured fingerprint. The safety scenario verifies that choosing incoming content edits only the draft, then `resolveConflict` sends that content and fingerprint when the user explicitly stages it.
History recovery coverage holds a commit diff while a repository refresh changes
HEAD and fails the replacement history read; the branch picker and reload control
must remain usable, and retrying must restore the commit list.

| Area      | Gallery scenarios / exercised controls                                                                                                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell     | `shell-no-repository`, `shell-loading`, `shell-connected`, `shell-long-content`, `shell-offline`; the real Hide details pane control                                                                                                                                                                                                                                 |
| Ancestry  | `ancestry-linear`, `ancestry-branching`, `ancestry-deep`, `ancestry-remote-consolidated`, `ancestry-missing-parent`, `ancestry-cycle`, `ancestry-requires-restack`                                                                                                                                                                                                   |
| Changes   | `files-clean`, `files-staged`, `files-unstaged`, `files-renamed`, `files-untracked`, `files-conflicts`, `files-truncated`, `files-long-content`                                                                                                                                                                                                                      |
| History   | `history-loading` (`release('history')` to finish), `history-error`                                                                                                                                                                                                                                                                                                  |
| PRs       | `pull-requests-lifecycle`, `pull-requests-checks`, `pull-requests-empty`, `pull-requests-unavailable`, `pull-requests-issue-links` (a closing-keyword link and a local contextual link on one PR)                                                                                                                                                                    |
| Stashes   | `stash-stable-oid`, `stash-empty`, `stash-index-shift`                                                                                                                                                                                                                                                                                                               |
| Workflows | `workflow-preview-ready`, `workflow-preview-loading` (`release('stackPreview')`), `workflow-preview-blocked`, `workflow-preview-stale`, `workflow-action-error`, `workflow-partial-restack`, `workflow-conflict-recovery`, `workflow-operation-recovery`, `workflow-external-operation`; form validation, typed confirmation, and `hold('runAction')` for busy state |

```sh
npm test
npm run build
npm run tokens:check
npm run test:ui
npm run test:visual
npm run test:controls
npm run format:check
```

The gallery can also be built with `npm run build:gallery`. Its output is `out/renderer-fixtures`, outside the production renderer entry point. `test:controls` loads that output in an isolated Electron window.

Run `npx playwright test` locally for one combined visual/behavioral HTML report (separate invocations replace the previous report). Axe attachments retain violations and incomplete checks; rendered contrast measurements are report annotations. Renderer checks do not run in GitHub Actions. Baselines use macOS 26.5.2 (25F84), arm64, with pinned Playwright Chromium; patch-level system-font drift is a reviewed failure, not masked.

The visual suite covers the six destinations and three dialog compositions at minimum/default/wide sizes, shared-control variants, and a small set of long/error/recovery layouts. Other fixture states remain available in the gallery without separate screenshots or label-only assertions. Behavioral tests focus on keyboard access, asynchronous transitions, contrast, zoom/reduced motion, and mutation guards.

### Packaged desktop smoke

```sh
npm run package
npm run test:desktop
```

The smoke launches `release/mac-arm64/Git Stacks.app` by default on macOS and `release/linux-unpacked/git-stacks` on Linux; Windows is unsupported until its process-tree cleanup can be verified. `node scripts/packaged-desktop-smoke.mjs --help` lists the explicit app-path option. It creates a disposable repository and local bare remote, isolates user-data/configuration, strips inherited Git/GitHub and credential-shaped environment variables, and cleans the temporary workspace. Reports and failure screenshots remain under `out/packaged-smoke/<timestamp>/`.

The packaged executable, preload bridge, CSP, window lifecycle, real 200% page zoom, external-link policy, and local Git workflows are exercised rather than inferred from a dev server. No GitHub mutation or personal repository is used. Native window-state API checks are not physical title-bar-button or VoiceOver verification; record those manual boundaries separately.

### Updating visual baselines

Use the pinned Playwright Chromium, OS/architecture, viewport, locale, timezone, device scale, and system fonts recorded in the verification report. Baselines are platform-specific: a passing macOS image is not Linux or Windows evidence. Do not update images solely to silence failures.

1. Run `npm run test:visual` and inspect the expected/actual/difference images in `test-results` or `playwright-report`.
2. Diagnose whether the change is intentional. Inspect the actual production surface, keyboard behavior, and accessible state before accepting it.
3. Run `npm run test:visual:update` in the documented environment.
4. Review every changed image, then run `npm run test:visual` without update mode. Commit reviewed images with the component change.

Screenshot tests wait for fonts and stable fixture state, use fixed data/timestamps, and control motion. Do not mask meaningful status text, selection, operation feedback, or destructive confirmation. Narrow-window coverage represents desktop pane adaptation; it does not define a mobile product.

### Changing tokens and components

After editing `src/renderer/src/design-system/tokens.json`, run `npm run tokens:generate` and `npm run tokens:check`. Follow [DESIGN.md](DESIGN.md) for token roles and component rules.

When adding a variant or migrating a view:

- Update the production component and its existing typed fixture, not a copied HTML specimen.
- Add a deterministic scenario for the consumer-visible boundary: loading, empty, unavailable, blocked, submitting, rejected/stale, partial completion, or conflict recovery.
- Exercise keyboard entry, visible focus, dismissal/focus return, disabled explanations, zoom, and separate row-selection/action targets.
- For mutations, assert the action produced by a real UI interaction: cancellation, duplicate prevention, confirmation gating, filtered scope, and captured preview tokens/OIDs/fingerprints. Do not replace these with tests of the double itself.
- Add screenshots only for a distinct visual state; update the fixture matrix and evidence with the migration PR.

### Manual assistive-technology sign-off

Automated axe and contrast checks supplement, not replace, human keyboard and assistive-technology review. Final migration sign-off requires an explicitly recorded manual pass; missing evidence is a blocker, not an implied pass.

Use the packaged build and only disposable fixture repositories. `npm run test:desktop -- --keep` retains its disposable workspace and prints the path for a reviewer. Open only that fixture repository in the packaged app; remove the retained workspace after review.

1. Record reviewer, date, exact macOS/build, Electron/app revision, VoiceOver version/settings, display scaling, and keyboard navigation settings.
2. Navigate all six destinations, search, segmented filters, branch/file/commit selection, and separate PR links without a mouse. Record spoken names, roles, selected/current state, reading order, and visible focus.
3. Open form, reviewed-operation, and destructive dialogs. Verify initial focus, labels/errors, trapped modal focus, typed confirmation, disabled explanations, explicit cancellation, and focus return.
4. Read/scroll the diff at 200% zoom and reduced motion; verify no content or action becomes unreachable. Verify native close/minimize/full-screen controls, including returning from full screen.
5. Exercise unavailable GitHub metadata, history errors, stale preview reload, busy state, partial completion, and conflict Continue/Abort. Record whether announcements are timely without duplicating or hiding important state.
6. Record findings and platform limits in the pull request. Sign off only after blocking keyboard, contrast, state-truthfulness, and safety-dispatch findings are resolved.

Real GitHub mutations require a separately designated test repository and explicit authorization; none is included in routine fixtures or CI.

## Changes workspace

Select a file row to inspect its staged and working-tree diffs. The separate file checkbox stages or unstages the whole file; its mixed state means the file has changes on both sides of the index. File-row selection alone never stages anything. If Git rejects a file action, the index is unchanged and the mixed checkbox still reflects the partially staged file after refresh.

For a text file, use the per-hunk **Stage hunk** or **Unstage hunk** button to move just that hunk between the working tree and index. Toggle changed lines within a hunk to include or exclude them, then apply the hunk; toggling a line alone does not write to Git. With focus on a hunk, Up/Down/Home/End move among hunks, and Enter or S applies the focused hunk. Keyboard activation of an individual line button only changes its selection.

Only staged changes enter the next commit. Each hunk action checks the selected file's index and working-tree identity again, then takes Git's index lock before copying the complete current index. Another file staged while the diff was loading is preserved; a Git writer that encounters the owned lock must retry. If the selected file changed, refresh the inspector and review the diff. Renames and copies, new or deleted files, binary/untracked/conflicted files, unsupported text diffs, and oversized diffs require whole-file handling or conflict resolution rather than partial patching. Selected text patches retain adjacent replacement order, exact repeated-line positions, zero-context insertion anchors, CRLF, no-newline markers, and quoted Unicode paths where Git can safely apply them.

When a tracked text file also changes executable mode, staging a text hunk does not stage the mode change; the mode remains separately available through whole-file staging. A mode-only change has no text hunk to select.

## Stack synchronization and recovery

Sync Stack (`Mod+Shift+S`, or the `Sync stack…` command in the command palette) fetches and prunes remotes, discovers the native stack trunk, compares local vs. remote trunk tips, and plans a safe bottom-up restack of the entire stack.

### Trunk and layer classification

Before executing any mutation, the preview compares local and remote branch tips and classifies each layer:

- **Trunk drift**: Evaluates whether the trunk is up to date, behind, ahead, or diverged. If the remote trunk was force-pushed or rewritten upstream (`diverged`), syncing is blocked until the local trunk is reconciled to avoid replaying onto an inconsistent upstream history.
- **Merged layers**: Detects whether a lower layer's PR was merged (via merge commit, squash, or rebase). Merged layers are dropped from the replay cascade. Descendant layers are automatically retargeted onto the updated trunk or the highest surviving predecessor.
- **Rebase boundaries**: For squash- or rebase-merged predecessors, the replay boundary is derived from the immutable head recorded at merge time (`isProvenMergeHead`). If a safe boundary cannot be proven from Git history or the merge journal, syncing is refused to prevent replaying duplicate commits or dropping unmerged work.
- **Layer states**: Each branch is classified as `up-to-date`, `needs-rebase`, `retargeted`, `needs-push`, `needs-force`, `merged`, or `blocked`.

### Force-with-lease safety

Sync Stack never rewrites published remote history without explicit confirmation:

- When any layer requires a force push (because local history was rebased and replaced the published commit), the preview identifies the exact remote OID captured during fetch.
- Pushes use `--force-with-lease` specifying the captured remote tip. If another writer moved the remote branch while the local rebase was running, Git rejects the lease and halts execution immediately.
- The user must explicitly check the lease-approval box and type the target branch name before the sync action can be submitted.

### Conflict recovery

If Git encounters conflicts during the rebase cascade:

1. The operation pauses and writes a recovery journal entry (`kind: 'sync'`) under `.git/git-stacks/journal/`, saving the active rebase state and backup refs for all replayed branches (`refs/git-stacks/backups/<id>/<branch>`).
2. Conflicted files appear in the Changes view and conflict resolver.
3. Once conflicts are resolved, use **Continue** to adopt the rebased commit and resume the cascade for the remaining branches.
4. Alternatively, use **Abort** to restore all branches and their metadata to their exact pre-sync backup refs and return to the original clean checkout.

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
- **Native stack membership** is GitHub's to own. Reordering submitted layers unstack
  the native stack and registers the pull requests again in the new order; layers that
  are not part of a native stack, and a repository that cannot use native stacks, plan a
  local-only surgery and say so in the preview.

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
