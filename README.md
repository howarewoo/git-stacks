# Git Stacks

A local-first desktop workbench for Git branches and stacked pull requests.

Design rules live in [DESIGN.md](DESIGN.md). This file covers how to run the app
and how the large-repository work is measured.

## Commands

```sh
npm ci                 # install
npm run dev            # run the app
npm run build          # typecheck + production build
npm test               # the test suite
npm run format:check   # formatting gate
npm run bench:performance  # large-repository benchmarks
```

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
animation frames. The `interaction` measurement starts at an actual search input
event in that window and ends after the filtered branch result completes two
animation frames. The separate `diff-render-ssr` measurement is server-side
rendering cost for a 1,000-line diff preview; it is not an input-to-paint budget.
CI builds first and runs Electron under Xvfb. Local runs need a display server.
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

**A branch-analysis budget.** `SNAPSHOT_BRANCH_BUDGET` caps per-branch
merge-base and behind probes. A branch is counted once in snapshot limits even
if both probes were needed. Beyond the budget, recorded parents remain
available, but inferred parents or behind counts can be unknown.
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
