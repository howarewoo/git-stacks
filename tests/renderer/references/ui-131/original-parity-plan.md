# Git Stacks — UI migration and feature-parity checklist

Review baseline: `main` at `650aa8dc800523cf2ddd061e8667003ed957e4f5` (merge of PR #130).

## Status and purpose

This is a proposed migration checklist, not a completion or test report. It maps observed source-level workflows and public desktop contracts to a graph-first UI. No repository code, issues, branches, or PRs were changed during this review. The packaged app, live GitHub workflows, and performance suite were not run. Host/platform capability checks remain authoritative; an exposed contract does not prove every host or OS supports an operation.

The visual reference is the final large-repository HTML prototype from this conversation, not the earlier CRM, team, or named-stack prototypes. The final prototype is a discovery experiment: its non-Stacks workspace controls are disabled and its data and Git/GitHub work are simulated. It is not a feature-complete client.

## Recommendation

Adopt the latest demo’s repository-first outline + focused dependency graph + inspector as the Stacks workspace. Retain dedicated Working changes, Review, History, Stashes, Branches, PR Inbox, Notifications, Settings, and diagnostics capabilities. Preserve the current Git/GitHub execution engine, gh-owned authentication, native host capability checks, and recovery contracts.

PR List can become another presentation of the same repository PR index; Review remains a wide contextual workspace. Preserve existing destinations, keyboard commands, and return navigation during migration. Do not delete routes merely to simplify the initial screenshot.

No stack names, stack owners, teams, shared application service, or new authoritative database are introduced. A saved view may have a user-defined name; a linear PR chain does not gain one.

## How to use this checklist

For each item, record the old entry point, replacement entry point, action/read handler, automated fixture, and manual evidence where needed. Mark an item complete only after the replacement is integrated and its real behavior—not just its visual presence—has been verified. A disabled prototype control does not count as coverage.

## Repository setup and runtime

**Proposed home:** Repository picker, onboarding, and Settings.

**Source touchpoints:** [`PRODUCT.md`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/PRODUCT.md); [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`src/renderer/src/components/onboarding.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/onboarding.tsx); [`src/renderer/src/components/settings-dialog.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/settings-dialog.tsx).

- [ ] P001 — Open an existing local repository and reopen a recent repository.
- [ ] P002 — Add an existing repository by path or dropped folder without converting it.
- [ ] P003 — Search accessible GitHub repositories with pagination and cancellation.
- [ ] P004 — Choose HTTPS/SSH clone input and destination; preview clone commands; preserve collision refusal and cancellation behavior.
- [ ] P005 — Report Git identity, credential-helper, SSH, and Git runtime availability without silently configuring the user’s tools.
- [ ] P006 — Preserve bundled/system Git selection, GitHub host configuration, and observed per-host capability reporting.
- [ ] P007 — Preserve required gh authentication and its read-only status surface; do not introduce a new primary login, account-switch, or token flow.
- [ ] P008 — Keep local Git usable when GitHub or gh is unavailable.

## Branch navigation and maintenance

**Proposed home:** Branches and contextual local-ref inspector.

**Source touchpoints:** [`src/renderer/src/lib/branches.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/lib/branches.ts); [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`README.md`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/README.md).

- [ ] P009 — Keep All/Local/Remote/With PRs navigation, qualified branch identity, and existing local/remote consolidation.
- [ ] P010 — Distinguish visual selection, checked-out branch, and multi-selection for deletion.
- [ ] P011 — Create a local branch from a selected parent; guard switching with uncommitted work.
- [ ] P012 — Rename a local branch and edit its tracking upstream without confusing upstream with stack parent.
- [ ] P013 — Preserve single and batch local deletion, expected-tip validation, unmerged opt-in, current/default/worktree protections, and configuration-cleanup outcomes.
- [ ] P014 — Preserve single and batch remote deletion, same-remote batch validation, captured leases, atomic multi-ref push, and unknown-outcome reporting.
- [ ] P015 — Preserve the existing “Select all visible” batch contract rather than silently changing it to “all filtered records”.
- [ ] P016 — Preserve missing-parent and cycle warnings, ahead/behind values, and explicit unknown local comparisons.

## Local Git and working changes

**Proposed home:** Working changes; current-checkout controls.

**Source touchpoints:** [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`src/renderer/src/components/data-views.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/data-views.tsx); [`src/renderer/src/components/hunk-diff.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/hunk-diff.tsx); [`src/renderer/src/components/conflict-resolver.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/conflict-resolver.tsx).

- [ ] P017 — Fetch without implying a working-tree change; distinguish Git fetch from refreshing GitHub metadata.
- [ ] P018 — Preserve pull strategies, non-force push, and separately previewed force-with-lease push.
- [ ] P019 — Inspect staged, unstaged, untracked, renamed, and conflicted files, including partial/truncated listings.
- [ ] P020 — Stage and unstage individual files and the existing filtered bulk scope, including rename-path handling.
- [ ] P021 — Stage/unstage hunks and selected lines with the captured hunk and file identity.
- [ ] P022 — Commit staged changes and review amend behavior with captured HEAD/ref and existing protections.
- [ ] P023 — Discard file edits only through the existing fingerprint-bound confirmation path.
- [ ] P024 — Resolve supported conflicts manually or through current/incoming/both/delete choices, preserving operation-specific labels.
- [ ] P025 — Use configured external editors and merge tools through their validated main-process boundaries.
- [ ] P026 — Preserve binary, large-file/diff, submodule, sparse-checkout, and LFS capability states instead of presenting unsupported edits as available.
- [ ] P027 — Preserve merge/rebase/cherry-pick/revert Continue/Skip/Abort behavior and persistent recovery visibility.

## History and stashes

**Proposed home:** Dedicated History and Stashes workspaces.

**Source touchpoints:** [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`src/renderer/src/components/repository-views.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/repository-views.tsx); [`src/renderer/src/components/data-views.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/data-views.tsx).

- [ ] P028 — Browse branch/ref history with paging, selection, commit identities, and bounded diff previews.
- [ ] P029 — Cherry-pick or revert onto the explicit current branch, preserving clean-tree and mainline requirements.
- [ ] P030 — Create stashes with message and include-untracked choice.
- [ ] P031 — Apply a stash while retaining it; pop it through the existing successful operation; separately confirm dropping it.
- [ ] P032 — Preserve captured stash OIDs across shifting stash indices, conflicts, and failed operations.

## Dependent changes and publication

**Proposed home:** Stacks graph/outline plus reviewed operation surface.

**Source touchpoints:** [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`src/renderer/src/components/repository-views.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/repository-views.tsx); [`src/renderer/src/components/workflow-dialog.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/workflow-dialog.tsx).

- [ ] P033 — Show actual branch names and PR identities; do not create stack names or owners.
- [ ] P034 — Preserve locally recorded parent intent and its provenance separately from GitHub PR target edges and native membership.
- [ ] P035 — Preview local restack, and retain Continue/Abort plus interrupted-restack recovery.
- [ ] P036 — Preserve stack Sync as its own reviewed operation, including trunk state, merged-layer handling, rewrites, push kinds, and force consent.
- [ ] P037 — Publish/submit with per-layer title/body/draft/base-change choices and captured push identities.
- [ ] P038 — Preserve publication progress, partial failures, retry, dismissal, and immutable approvals during recovery.
- [ ] P039 — Preserve insert/move/remove layer surgery, including exact replay, remote creation, retarget, PR-close, and native-membership effects.
- [ ] P040 — Preserve native stack list/create/extend/unstack boundaries where the host supports them; a graph fork does not imply native stack mutation support.
- [ ] P041 — Preserve reconciliation reporting, explicit repair previews, blockers, and recoverable evidence.
- [ ] P042 — Preserve local-only and remote-only discovery; a branch without a PR stays a branch.
- [ ] P043 — Never use the visible or filtered graph as the authoritative mutation scope; the backend preview resolves the real affected objects.

## PR management and landing

**Proposed home:** PR inspector, full Review workspace, operation surface.

**Source touchpoints:** [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`src/renderer/src/components/workflow-dialog.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/workflow-dialog.tsx); [`src/renderer/src/components/check-details.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/check-details.tsx); [`README.md`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/README.md).

- [ ] P044 — Create a PR and edit title/body/draft state; preserve close and reopen actions.
- [ ] P045 — Inspect actual PR head/base, lifecycle, checks, review decision, and native membership independently.
- [ ] P046 — Link or unlink contextual and closing issues using the existing preview/body-validation contract.
- [ ] P047 — Inspect detailed checks and rerun an eligible Actions run with current permissions and identity validation.
- [ ] P048 — Preserve merge previews for the actual reviewed downstack run rather than changing the operation to the selected visible card alone.
- [ ] P049 — Preserve repository-default, direct-merge, and merge-queue choices; present merge method only where applicable.
- [ ] P050 — Retain accepted/pending/enqueued/confirmed-merged/failed/dropped/unconfirmed outcomes and durable recovery evidence.
- [ ] P051 — Keep validated external GitHub links and host boundaries; do not replace in-app review with browser-only actions.

## Full in-app review

**Proposed home:** Wide Review workspace reached from any PR entry point.

**Source touchpoints:** [`src/renderer/src/components/review-view.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/review-view.tsx); [`src/renderer/src/components/review-conversation.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/review-conversation.tsx); [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts).

- [ ] P052 — Keep all five panes: code, about, checks, commits, and conversation.
- [ ] P053 — Keep stack-layer navigation, file navigation, and existing remappable review commands.
- [ ] P054 — Keep unified/split diffs, whitespace handling, file-tree search/collapse, and unsupported/truncated file representations.
- [ ] P055 — Keep viewed-file records tied to the reviewed head.
- [ ] P056 — Keep observed review snapshots and comparison against an earlier observed head; preserve hide-unchanged behavior.
- [ ] P057 — Keep pending inline/multiline draft composition and local journal persistence across navigation.
- [ ] P058 — Preserve review submission, replies, and resolve/unresolve operations with actual permissions.
- [ ] P059 — Preserve draft-anchor revalidation and refusal of stale comparisons rather than silently moving a comment to unseen code.
- [ ] P060 — Keep unsent text when reads fail; preserve account/repository separation when authority changes.
- [ ] P061 — Return to the prior graph/list view with its filters, selection, camera, and scroll context intact.

## PR Inbox and Notifications

**Proposed home:** Distinct app-level destinations; no invented team model.

**Source touchpoints:** [`src/shared/pr-inbox.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/pr-inbox.ts); [`src/renderer/src/components/workspace-navigation.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/workspace-navigation.tsx); [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`README.md`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/README.md).

- [ ] P062 — Keep PR Inbox available across registered repositories, including when no repository is currently open.
- [ ] P063 — Preserve Review requested, Needs my response, My PRs waiting, My PRs approved, Drafts, and Recently merged group rules.
- [ ] P064 — Preserve saved Inbox filters and per-item author/direct-review-request/metadata-completeness information.
- [ ] P065 — Reuse these facts for repository graph views without making “All open PRs” depend on the narrower Inbox queue membership.
- [ ] P066 — Keep optional GitHub Notifications separate from PR Inbox and from primary gh authentication.
- [ ] P067 — Preserve Notifications consent, host/account isolation, enablement/policy states, and credential removal.
- [ ] P068 — Preserve notification Open, Mark read, Mark all read, Done, Ignore, and Unsubscribe as distinct actions.
- [ ] P069 — Preserve polling floors, stale lists, accepted-but-unconfirmed writes, and no automatic replay of uncertain mutations.

## Settings and cross-cutting behavior

**Proposed home:** Settings, diagnostics, shared shell, and operation status.

**Source touchpoints:** [`src/renderer/src/components/settings-dialog.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/settings-dialog.tsx); [`src/shared/settings.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/settings.ts); [`src/shared/types.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts); [`README.md`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/README.md).

- [ ] P070 — Keep all nine Settings sections: GitHub CLI, GitHub, Notifications, Git, Appearance, Updates, Shortcuts, Privacy, and Diagnostics.
- [ ] P071 — Keep system/light/dark appearance and reduced motion; the light-only demo does not supersede existing theme support.
- [ ] P072 — Keep editor/merge-tool choices, default pull/merge strategies, and refresh interval settings.
- [ ] P073 — Keep remappable shortcuts, command palette, separate in-view filter, and keyboard-safe list/graph navigation.
- [ ] P074 — Keep settings policy locks, validation, recovery, reset, and authoritative persistence behavior.
- [ ] P075 — Keep diagnostics, redacted support-bundle preview/export, and local-path privacy choice.
- [ ] P076 — Keep signed-update channel/check/download/cancel/install behavior only where the current platform supports it.
- [ ] P077 — Keep remote freshness, local watcher updates, rate-limit/backoff, and account-generation invalidation.
- [ ] P078 — Keep native window controls, drag/no-drag regions, validated IPC, CSP, and external-link policy.
- [ ] P079 — Keep operation status visible across destinations; closing a preview is not aborting an operation.
- [ ] P080 — Keep selection/form state separate from query results and never automatically replay mutations.
- [ ] P081 — Keep 1000×700 and 1440×940 desktop usability, larger windows, real 200% zoom, keyboard focus, and assistive-technology verification.

## New graph/view work, not existing feature claims

**Proposed home:** Repository Stacks discovery workspace.

**Source touchpoints:** [`src/renderer/src/components/repository-views.tsx`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/renderer/src/components/repository-views.tsx); [`src/shared/pr-inbox.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/pr-inbox.ts); [`src/main/github.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/main/github.ts); [`src/shared/performance.ts`](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/performance.ts).

- [ ] P082 — Add an explicit PR/ref dependency projection with qualified identities, source provenance, unresolved targets, and native-membership annotations.
- [ ] P083 — Add repository-scoped My PRs, Review requested, Current branch, and All open PRs views, with exact documented rules.
- [ ] P084 — Add local saved graph preferences scoped by host, repository, and account; do not copy demo localStorage directly into production persistence.
- [ ] P085 — Add context-preserving author/text/status filters, collapsed linear runs, true fork attachments, and matches/context/unresolved distinctions.
- [ ] P086 — Add bounded outline virtualization and focused graph layout with searchable dependent-path expansion.
- [ ] P087 — Add staged PR-index publication and on-demand selected-item detail without replacing the existing scheduler or host-aware transport.
- [ ] P088 — Keep existing numeric budgets; add measured graph/filter/layout/memory/request budgets using the production renderer.
- [ ] P089 — Add 250/1000/5000-PR fixtures with 50 author identities, mixed authors, deep paths, wide forks, incomplete pages, unavailable capabilities, and external retargets.
- [ ] P090 — Ensure graph expand/collapse, refresh, and filtering dispatch no mutation.
- [ ] P091 — Keep active mutation blockers and draft-staleness warnings live even if layout/reordering waits for “Apply updates”.

## Implementation sequence

1. Freeze this baseline and approve a visual reference set covering the graph, full review, working changes/conflicts, operation previews/recovery, onboarding, inbox/notifications, and settings in both themes.
2. Add a pure, typed PR/ref graph projection and reuse existing Inbox signal/permission/freshness data. Keep execution planning independent of this projection.
3. Add the React Stacks outline/graph/inspector, using current Base UI/CVA/Tailwind tokens and TanStack Query/Form conventions. Migrate one vertical slice before refactoring unrelated workspaces.
4. Connect existing local/ref/PR/stack actions and dedicated workspaces. Preserve scope, identity, confirmation, stale-data, and account-switch behavior; expand production-component fixtures alongside each slice.
5. Extend progressive loading and bounded rendering, measure on current performance fixtures plus realistic PR graphs, and only then retire duplicate legacy presentation.

## Verification gate

Use the repository’s declared commands and documented prerequisites, not the prototype’s timing readouts. Relevant commands include `npm run build`, `npm test`, `npm run tokens:check`, `npm run format:check`, `npm run test:ui`, `npm run test:visual`, `npm run bench:performance`, and the appropriate controlled/live-local and packaged desktop suites. Record environment, scope, results, and skipped coverage. Formatting is Biome; the existing app is not the earlier Radix/Prettier implementation.

Compare all ten current workspace destinations, all five Review panes, and all nine Settings sections. Add checks for a graph-selected non-current PR during local changes, hidden descendants during operation previews, unsent review text during host/account changes, stale same-head checks, and incomplete dependency enumeration.

Existing production budgets at this SHA include 250 ms branch interaction, 4 s snapshot, 10 s launch-to-first-branch-page, Git concurrency 8, branch-analysis budget 1500, list page size 200, and review-stack metadata batch size 32. These are current policy constants, not measurements performed by this review. Proposed graph targets must be separately agreed and measured.

## Evidence sources

- [Pinned repository tree](https://github.com/howarewoo/git-stacks/tree/650aa8dc800523cf2ddd061e8667003ed957e4f5/)
- [Product boundaries](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/PRODUCT.md)
- [Design contract](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/DESIGN.md)
- [Runtime, recovery, persistence, and verification documentation](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/README.md)
- [Typed desktop operations](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/types.ts)
- [Current package/tooling](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/package.json)
- [Performance budgets](https://github.com/howarewoo/git-stacks/blob/650aa8dc800523cf2ddd061e8667003ed957e4f5/src/shared/performance.ts)

Agent skills in `.agents/skills/` are optional repository tooling rather than missing desktop screens. GitLab remains future product direction, not a feature the UI migration should invent.
