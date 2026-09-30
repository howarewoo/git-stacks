---
name: Git Stacks
description: A quiet and precise local-first desktop workbench for Git branches and stacked pull requests.
colors:
  canvas: '#e8ecf3'
  surface: '#ffffff'
  surface-inset: '#f2f4f8'
  surface-hover: '#e1e6ef'
  ink: '#171c24'
  ink-hover: '#2a3340'
  ink-pressed: '#11151b'
  text-secondary: '#536176'
  border: '#d7dde7'
  border-essential: '#7c879a'
  selection: '#edf2fc'
  selection-strong: '#3155a6'
  focus: '#355bc5'
  info-surface: '#dfe8fc'
  info-text: '#3155a6'
  success-surface: '#dceee3'
  success-text: '#276449'
  warning-surface: '#f4e3b9'
  warning-text: '#865b13'
  error-surface: '#f9dfdf'
  error-text: '#9d3d43'
  merged-surface: '#e4dff5'
  merged-text: '#635097'
  diff-add: '#276449'
  diff-add-surface: '#dceee3'
  diff-remove: '#9d3d43'
  diff-remove-surface: '#f9dfdf'
  diff-hunk: '#3155a6'
typography:
  heading:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '20px'
    lineHeight: 1.25
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '14px'
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '13px'
    lineHeight: 1.35
  metadata:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: '12px'
    lineHeight: 1.4
rounded:
  control: '12px'
  item: '16px'
  workbench: '24px'
  pill: '999px'
spacing:
  '1': '4px'
  '2': '8px'
  '3': '12px'
  '4': '16px'
  '5': '20px'
  '6': '24px'
  '8': '32px'
  '10': '40px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.surface}'
    padding: '0 12px'
    height: '36px'
  button-primary-hover:
    backgroundColor: '{colors.ink-hover}'
    textColor: '{colors.surface}'
  button-primary-active:
    backgroundColor: '{colors.ink-pressed}'
    textColor: '{colors.surface}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    padding: '0 12px'
    height: '36px'
  button-ghost:
    textColor: '{colors.text-secondary}'
    padding: '0 12px'
  button-subtle:
    backgroundColor: '{colors.surface-inset}'
    textColor: '{colors.text-secondary}'
    padding: '0 12px'
  button-accent:
    backgroundColor: '{colors.selection-strong}'
    textColor: '{colors.surface}'
    padding: '0 12px'
  button-danger:
    backgroundColor: '{colors.error-surface}'
    textColor: '{colors.error-text}'
    padding: '0 12px'
  button-link:
    textColor: '{colors.selection-strong}'
  field:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    padding: '8px 12px'
    height: '36px'
  badge-neutral:
    backgroundColor: '{colors.surface-inset}'
    textColor: '{colors.text-secondary}'
    rounded: '{rounded.pill}'
    padding: '2px 8px'
  badge-success:
    backgroundColor: '{colors.success-surface}'
    textColor: '{colors.success-text}'
    rounded: '{rounded.pill}'
    padding: '2px 8px'
  badge-info:
    backgroundColor: '{colors.info-surface}'
    textColor: '{colors.info-text}'
    rounded: '{rounded.pill}'
    padding: '2px 8px'
  row-selected:
    backgroundColor: '{colors.selection}'
    textColor: '{colors.ink}'
  dialog-overlay:
    backgroundColor: 'rgba(20, 24, 32, 0.34)'
---

# Design System: Git Stacks

## Overview

**Creative North Star: "The Quiet Workbench"**

Git Stacks is a quiet, precise desktop workbench for navigating branches, stacks, pull requests, changes, history, and stashes. The system adapts the cool-gray canvas, rounded white work surfaces, ink-colored primary actions, and restrained blue selection of the [Journey CRM Dashboard reference by Jack R. / RonDesignLab](https://dribbble.com/shots/24659454-Customer-Journey-CRM-Dashboard) into a local-first Git and GitHub product. Journey is a visual and material reference only: Git Stacks does not introduce CRM stages, analytics cards, or a web client.

The visual language is intentionally restrained. Workbench Ink makes primary actions and navigation feel decisive; Repository Blue keeps links, selection, focus, checked-out state, and stack edges legible without turning the whole interface into a status field. Rounded surfaces and quiet tonal layers organize dense repository information while preserving the desktop workbench hierarchy.

**Key Characteristics:**

- Cool-gray workspace canvas with white content surfaces and inset grouping surfaces.
- Workbench Ink primary actions and navigation with Repository Blue selection and links.
- Independent, text-labelled Git states for selection, checked-out state, pull-request lifecycle, checks, review, restacks, and diffs.
- Compact information density for branch, pull-request, stash, history, and diff rows.
- Local-first, keyboard-accessible, operation-safe behavior with no external font or network dependency.

## Colors

The palette is a cool-gray workbench with quiet semantic feedback. Workbench Ink and Repository Blue are the two named anchor colors; status colors remain independent and always appear with a text label or icon.

### Primary

- **Workbench Ink** (`semantic.action.primary`): primary text, primary actions, navigation, and high-emphasis surfaces. Hover uses `semantic.action.primary-hover`; pressed uses `semantic.action.primary-pressed`.
- **Repository Blue** (`semantic.selection.text`): links, selection text and borders, focus-adjacent identity, checked-out state, and meaningful blue graphics. It is not a replacement for Workbench Ink primary actions.

### Secondary

- **Muted Slate** (`semantic.text.secondary`): secondary readable text and metadata. It remains readable on the canvas and work surfaces rather than being treated as disabled text.
- **Repository Blue** (`semantic.action.link`): the semantic link and selection accent, distinct from primary action ink.

### Tertiary

- **Restack Amber** (`semantic.feedback.warning-text` on `semantic.feedback.warning-surface`): requires-restack and warning text/surface pairs.
- **Error Garnet** (`semantic.feedback.error-text` on `semantic.feedback.error-surface`): error and closed-state text/surface pairs.

### Neutral

- **Cool Gray Canvas** (`semantic.surface.canvas`): workspace backdrop.
- **Work Surface** (`semantic.surface.content`): content, controls, and dialog surfaces.
- **Inset Surface** (`semantic.surface.inset`): grouped content and secondary controls.
- **Row Hover** (`semantic.surface.hover`): quiet hover state.
- **Decorative Divider** (`semantic.border.decorative`): separators that do not carry essential control meaning.
- **Essential Border** (`semantic.border.essential`): field and control boundaries that must remain visible.

### Feedback and Git states

- **Info Blue**: `semantic.feedback.info-surface` with `semantic.feedback.info-text`.
- **Success Green**: `semantic.feedback.success-surface` with `semantic.feedback.success-text`.
- **Warning Amber**: `semantic.feedback.warning-surface` with `semantic.feedback.warning-text`.
- **Error Garnet**: `semantic.feedback.error-surface` with `semantic.feedback.error-text`.
- **Merged Violet**: `semantic.feedback.merged-surface` with `semantic.feedback.merged-text`, a Git Stacks adaptation of the Journey violet role.
- **Diff roles**: addition `semantic.diff.add-text` on `semantic.diff.add-surface`, deletion `semantic.diff.remove-text` on `semantic.diff.remove-surface`, and hunk `semantic.diff.hunk-text`.

**The Meaning Before Color Rule.** Every selection, checked-out branch, pull-request lifecycle, checks state, review decision, restack requirement, and diff role has an explicit text or icon meaning. Unknown or unavailable GitHub data uses the neutral unknown role and an explicit unavailable label; it is never represented as none, zero, or passing.

**The Essential Boundary Rule.** `semantic.border.decorative` is for decorative dividers only. Inputs, controls, and meaningful graphics that need a non-text boundary use `semantic.border.essential` or `semantic.focus.ring`.

## Typography

**Display Font:** Inter when locally available, with `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI` fallbacks.
**Body Font:** Inter when locally available, with the same system sans fallbacks.
**Label/Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, and `Consolas` for code, paths, refs, and OIDs.

**Character:** The system sans keeps the workbench familiar and readable when Inter is absent. Monospace is reserved for identities and code-like values, so data remains scannable without turning the interface into a code editor.

### Hierarchy

- **Heading** (20px / 1.25): section and work-surface titles.
- **Body** (14px / 1.5): standard interface copy and form content.
- **Label** (13px / 1.35): control labels and concise row labels.
- **Metadata** (12px / 1.4): timestamps, counts, paths, refs, and supporting status details.

**The Code Is Monospace Rule.** Use the system monospace stack for code, paths, refs, and OIDs; use the system sans stack for interface copy. No external font is loaded and no font files are copied from chat artifacts.

## Layout

Git Stacks is a desktop workbench, not a mobile or web client. The existing shell uses a three-pane composition: repository navigation, primary work area, and details. Dense branch, pull-request, stash, history, and diff rows use the compact rhythm; forms and primary work surfaces use standard density. Controls are 36px compact or 44px standard, and rows are 44px compact or 56px standard, with content allowed to grow when necessary.

The spacing system follows a 4px rhythm with 4, 8, 12, 16, 20, 24, 32, and 40px steps. The foundation radius scale reserves 12px for controls, 16px for nested items, and 24px for work surfaces and dialogs, while pills use 999px. These are target roles, not a claim that every existing component already consumes them. The existing renderer breakpoints at 1040px and 1199px adapt the shell to narrower desktop renderer widths; the native product remains centered on the 1000×700 minimum and 1440×940 default window sizes.
Motion uses 120ms fast, 180ms standard, and 240ms deliberate transitions with `cubic-bezier(0.2, 0, 0, 1)` easing. The generated reduced-motion rule maps each duration to `0.01ms`; status text and operation locks remain when animation is removed.

Overlay content is layered above the shell through the named z-index scale: base `0`, content `1`, floating `10`, overlay `60`, and popover `70`. Overlay surfaces do not compete with arbitrary per-view z-index values.

## Elevation & Depth

Depth is primarily tonal: the cool-gray canvas, white work surfaces, and inset surfaces separate regions without making every row a card. Shadows are reserved for transient or elevated layers.

### Shadow Vocabulary

- **Small** (`semantic.elevation.small`): low-elevation detail.
- **Medium** (`semantic.elevation.medium`): floating cards, hover cards, and tooltips.
- **Large** (`semantic.elevation.large`): dialog surfaces and other high-elevation overlays.

**The Flat-By-Default Rule.** Surfaces are flat at rest. Use a shadow only when a component is floating, transient, or deliberately elevated; do not use decorative shadows to imply Git state.

## Shapes

The foundation radius scale targets 12px for controls, 16px for nested items, and 24px for work surfaces and dialogs, with 999px pills. Shared controls now bind directly to those semantic radius tokens; borders are quiet and structural: essential controls use the stronger border, while decorative dividers remain low contrast. Clipping and overflow behavior follow the work surface rather than arbitrary view-specific decoration.

## Components

The renderer builds on the repository's existing [shadcn/ui](https://ui.shadcn.com/) setup. `components.json` uses the New York style with CSS variables and the configured `components`, `ui`, `utils`, `lib`, and `hooks` aliases. The existing button is CVA-based (`class-variance-authority`) and composes variants through the shared `cn()` helper (`clsx` + `tailwind-merge`). Tailwind CSS v4, Radix primitives (`radix-ui`), and Lucide icons (`lucide-react`) remain the implementation stack. Shadcn is copied source and configuration, not a required runtime dependency; no shadcn CLI application dependency is introduced here.

### Buttons

- **Shape:** Shared `Button`, `Input`, `Select`, and `Textarea` use the 12px semantic control radius. `IconButton` uses 16px or 20px Lucide icons and the compact/standard target sizes.
- **Primary (`default`):** Workbench Ink background with white text; hover uses ink-hover and active uses ink-pressed.
- **Secondary:** White background, essential border, Workbench Ink text, and inset hover background.
- **Ghost:** Secondary text with inset hover and primary text on hover.
- **Subtle:** Inset background with secondary text, shifting to row-hover and primary text on hover.
- **Accent:** Repository Blue background with white text and selection-border hover.
- **Danger:** Error surface, error text, and an essential error-colored border.
- **Link:** Repository Blue underlined text with a selection-colored underline.
- **Sizes:** `sm` is 36px high, `default` and `lg` are 44px high, and `icon` / `icon-sm` are 44px / 36px square controls. Coarse pointers receive a 44px minimum target through the renderer's pointer media query.
- **States:** `focus-visible` uses a 2px Repository Blue focus ring with a surface-colored offset; `loading` sets `aria-busy` and prevents another dispatch; disabled controls remain non-interactive while their wrapper stays keyboard-discoverable.

### Badges

- **Neutral (`secondary`):** Inset background, essential border, and secondary text.
- **Outline:** Transparent background with essential border and secondary text.
- **Accent:** Selection background, selection border, and selection text.
- **Info / Success / Warning / Danger / Merged:** Their named feedback background/text pairs. Every badge includes a text label; color is not the state itself.
- **Default:** Neutral inset background and secondary text; the legacy `default` name is retained as a neutral badge alias rather than inheriting primary-action ink.

### Inputs / Fields

- **Style:** White background, essential border, Workbench Ink text, secondary placeholder text, and semantic 36px compact or 44px standard control heights.
- **Composition:** `Field` associates visible labels, required state, helper text, and error text with native `Input`, `Select`, and `Textarea` controls. `Checkbox` exposes checked and indeterminate states without nesting interactive labels.
- **Focus:** Repository Blue border plus a 2px Repository Blue ring.
- **Disabled:** Inset background with reduced opacity and a not-allowed cursor.

### Navigation

- **Style:** The shell uses quiet text and count metadata with a selected state separate from checked-out state. Active navigation uses the selection role, while primary action emphasis remains Workbench Ink.
- **Keyboard:** Global `:focus-visible` treatment is available for keyboard navigation and controls. Disabled or unavailable actions retain a text or tooltip explanation.

### Cards / Containers

- **Corner Style:** Workbench surfaces use the 24px token scale; existing specimen and shared utility surfaces retain their current utility-specific radius.
- **Background:** White content surfaces and inset grouping surfaces.
- **Shadow Strategy:** Tonal separation at rest; medium or large shadow only for floating and dialog layers.
- **Internal Padding:** Use the 4px spacing rhythm, with 16px and 24px steps for work-surface and section rhythm.

### Dialogs

- **Overlay:** Fixed inset overlay at the `component.overlay` z-index with the dedicated overlay scrim role.
- **Content:** White surface, essential border, 24px workbench radius, 20px padding, and large elevation shadow at the overlay token's z-index. Height is viewport-constrained and scrollable so footer actions remain reachable when zoomed.
- **Compositions:** `WorkflowFrame`, `OperationContext`, and `WorkflowActions` give ordinary forms, reviewed operations, and destructive confirmations shared spacing and action roles. `Field` and `TypedConfirmation` retain domain-specific validation.
- **Close and focus:** The Radix focus trap returns focus to the initiating control. Reviewed and destructive workflow dialogs start on Cancel. Escape/backdrop cannot discard entered work or interrupt an active mutation; explicit Cancel is distinct from aborting Git. In the conflict resolver, a whole-file draft cannot silently be replaced by a later region choice: switching back requires an explicit discard, while implicit dismissal preserves unstaged choices and drafts. An external merge-tool handoff likewise requires explicit draft discard; a failed action stays visible inside the modal without removing the draft. External staging or abort does not unmount an edited resolver: keep the draft available to copy, block stale mutations, and offer an explicit discard-and-close decision. A failed initial load has a dismissing Close control, not an implicit retry.
- **State:** `PhaseStatus` presents loading, ready, blocked, submitting, rejected, partial, success, and failure from existing operation data. Important errors remain inline; successful notices are polite and dismissible. Rejected previews require a successful reload before another dispatch. Inspector diffs and oversized stage text are bounded while read, and stage panes cap rendered characters so even a long single line remains visible with an explicit preview label. Side selection and worktree staging preserve complete bytes rather than applying preview text. A binary stage remains binary even when its first preview bytes contain no NUL.
- **Recovery:** The persistent operation banner remains outside workspace-specific views. Continue respects conflict blockers; Skip and Abort retain their explicit loss warnings and existing Git actions. Progress uses actual completed and remaining branches. Aborting a stack surgery restores this repository only, and its report names every pull request base change, close, and native stack membership that already reached GitHub and therefore stands; the recovery surface never implies that a remote change was undone.
- **Specimen:** `#/design-system-dialog-specimen` renders the shared compositions, recovery states, and guarded action fixtures without changing normal navigation.
- **Recovery specimen isolation:** `#/design-system-recovery-specimen` injects its stack preview and progress fixture API into the real dialog without installing or mutating `window.desktop`. Mismatched preview, unavailable preview, and non-retryable failure modes must work both without preload and with the frozen production context bridge, without reaching repository IPC.
- **Submit Stack:** The publication dialog previews layers in bottom-to-top order, one section per branch, naming the pull request each layer opens or retargets. Base changes and the consent to replace remote history are separate, explicit approvals per layer; the force consent is only shown when the preview contains rewritten branches. Progress lists the real steps of the submission and updates while it runs, so the person watches the work they started rather than a finished state. A submission that stopped part-way is recovered from its journal: the saved per-layer title, description, readiness, and base approvals are shown read-only, the saved force consent is shown as fixed text rather than a control, and changing any of it requires dismissing the submission and taking a fresh preview. A control that looks editable while the journalled value is what actually runs is never shown.
- **Stack surgery:** The insert, move, and remove dialogs are one reviewed composition that names the branch the surgery is anchored on, the resulting order, and the resulting parent of every affected layer. Each layer carries its action, the tip it is replayed from, the pull request base that changes, and the push it needs, as text and badge together; a reparent that moves no commit is labelled differently from a replay. A blocked layer blocks the whole surgery in place rather than dropping out of the plan. Removing a layer is a destructive composition; inserting or moving is a reviewed one. The consent to replace remote history appears only when the preview contains a rewritten branch, and a local-only surgery says that nothing will be pushed instead of showing a push it cannot make. A layer the surgery inserts is published on the remote as a new branch whenever a pull request has to hang from it, named beside the retarget it enables, because a base branch that does not exist is not a base GitHub accepts; that publication is never a force push and never replaces an existing branch. An insert that cannot be published is blocked in the preview rather than planned. The remote half of a surgery is part of the same recovery composition as the replay: a step already in its reviewed result is reported as done instead of repeated, and a step whose pull request head, base, state, or native stack membership drifted is named and stops the run before it writes.
- **Saved submission identity:** Recovery always names the branches, bases, pull request numbers, choices, and steps from the persisted submission, never from a fresh preview of a changed stack. A failed fresh read does not hide saved approvals or recovery guidance. Resume remains available only for retryable failures; a non-retryable failure disables Resume in the dialog and rejects backend retry without changing the journal. Dismiss stays available, with guidance to fix the rejected chain and take a fresh preview.

### Command Palette and Shortcuts

- **Command Palette:** Fixed workbench overlay at `component.overlay` elevation, combobox with listbox semantics, full keyboard navigation in the same order as visually grouped results (arrows, home/end, Enter, Escape), and screen-reader status announcements. Empty search groups commands by workspace area; active search preserves relevance order. Local branches, pull requests, open GitHub issues, and recent repositories are searchable alongside actions.
- **Search Separation:** In-view search/filter fields retain distinct focused shortcuts (`/` default) and are not conflated with the global command palette (`Mod+K` default). Printable symbols match their character on keyboard layouts that require Shift; shifted letters remain distinct. Bare printable palette remaps never intercept typing in editable fields, including palette search; modified openers remain available there. A keystroke a focused control has already handled never triggers a global shortcut, so the open palette keeps the keys it consumes.
- **Remappable Shortcuts:** Configurable keybindings for palette opening, view navigation, and stack commands with collision detection before assignment; each displayed shortcut names the action it dispatches. A literal plus key is recorded as `Plus` so separators cannot consume it. The platform's non-primary Command/Control modifier is unsupported: recording shows a reason instead of silently assigning a different shortcut. Holding an opener only toggles once. The opener cannot take an unmodified Enter, arrow, Home, End, or Escape: those keys stay with the open palette, and recording names the palette role instead of assigning the key. Named keys resolve to one canonical spelling, so `Home` and `home` (or `F5` and `f5`) are the same keystroke for assignment, collision, reservation, and dispatch; a rehydrated map never leaves two actions on one key. The `kbd` label keeps the platform's drawn glyphs, while `aria-keyshortcuts` carries the standardized `Meta`/`Control`/`Alt`/`Shift` key tokens for the platform the chord dispatches on.
- **Safe Execution:** Selection does not mutate the working tree. Destructive actions require two distinct Enter presses, not auto-repeat; IME candidate confirmation and composition navigation do not activate palette commands, and a composing Escape cancels the candidate instead of dismissing the palette. Other dialogs keep exclusive focus so the palette cannot replace edited workflows; after a palette-to-dialog handoff closes, focus returns to the original opener. Dirty-tree checkouts offer an explicit Git-protected carry attempt, stash, review and commit, or cancel. Recorded remote parent aliases resolve in both upward and downward stack navigation, and an explicitly qualified alias such as `origin/main` resolves to the local branch tracking that ref.

### Hover Cards and Tooltips

- **Hover card:** White overlay, 12px utility radius, medium elevation, 16px padding, and popover z-index 70.
- **Delayed opening:** A repository hover card opens only while its trigger is hovered or contains focus. A pending timer must not reopen it after navigation or a dialog has taken the interaction.
- **Tooltip:** Workbench Ink background, white text, 6px utility radius, 8px/12px padding, and medium elevation at popover z-index 70.

### Git and Diff States

Checked-out, selected, pull-request lifecycle, checks, review, requires-restack, unknown, and diff states use the semantic/component roles in `tokens.json`. The state is represented by text/icon/color together; unknown and unavailable remain explicit. Diff addition, deletion, and hunk excerpts use their separate text and surface roles.

### Repository compatibility

Diagnostics names each detected repository shape and labels its support as supported, limited, or unsupported. A restricted action remains visible but disabled with the same specific reason at its trigger and confirmation gate; a disabled control's explanation remains keyboard-discoverable. Bare repositories allow reading refs, fetching, and branch-owned pushing, but not worktree or branch mutations; detached HEAD allows local file work and commits but not operations that require an owning branch. Linked worktrees share repository metadata and must not take over a branch checked out elsewhere. Submodule rows show the recorded commit; discard and in-app conflict resolution are disabled because the app never rewrites submodule contents. Sparse paths outside the working set are not treated as deleted, and Git LFS pointers are identified without claiming to transfer LFS objects independently. Files-backed refs support safe stash removal; reftable and unknown storage permit stash Apply but disable Pop and Drop because those operations require direct ref-file manipulation. Never silently convert repository formats or rewrite configuration to enable an operation.

When an LFS pointer is visible in the file inspector, show its object ID and size alongside an explicit distinction between pointer metadata and object content; do not imply that local object availability was checked. Git LFS's own client and hooks, not the inspector or push-status text, own object transfer.

### Renderer integration and safety

Preserve the local-first Electron sandbox, context isolation, typed preload/IPC boundary, and production Content-Security-Policy. Visual migrations must not change Git semantics, preview/confirmation/busy locks, typed confirmations, or navigation behavior.

### GitHub transport

All GitHub access runs in the main process through one typed transport (`src/main/github-transport.ts`) that owns the API version, authentication, pagination, rate-limit metadata, timeouts, and cancellation, and reports failures as typed kinds rather than parsed CLI text. The default transport speaks REST and GraphQL over HTTPS and is selected whenever `GIT_STACKS_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN` is available; `gh` remains an optional fallback and diagnostic path used only when no token is present or `GIT_STACKS_GITHUB_TRANSPORT=gh` is set, so removing `gh` from `PATH` never disables GitHub features. The renderer keeps its narrow preload surface: it receives pull-request data only, never a token, raw HTTP, or transport control.

GitHub-native stacks use the preview REST stack resource as the source of submitted membership, position, and PR base; the Stacks workspace labels native positions explicitly. The app validates same-repository PR heads and bottom-to-top base/head continuity before creation, then reloads membership from GitHub rather than PR body links or local parent configuration. Every create, extend, and idempotent no-write publication re-reads its pull requests from GitHub at the mutation boundary, so a concurrent retarget, force-push, state change, or head-repository change fails explicitly instead of stacking against a stale base; an already-registered stack is only a success when it is open, valid, holds the published pull requests in the published order, and records each of them at the head commit the re-read observed, and a re-read that reports a different stack's membership stays a duplicate rejection while a re-read that reports no membership at all fails as a missing registration, because GitHub drops the `stack` object only once the pull request has left the stack. A stack member's recorded base is the position base GitHub derived for the stack rather than the pull request's own base, so only the captured and re-read pull request bases are compared; a restack that retargets a member onto a new trunk is legitimate. A change made after that final read is outside the publication's reach and surfaces on the next read, so no rule here claims an atomic GitHub read-modify-write. A locally restacked branch may retain its recorded parent as a recovery hint until the remote PR base catches up. When the preview endpoint is unavailable, show that limitation and retain the chained-PR/local view instead of implying a native stack exists; closed and invalid stacks remain distinguishable from an empty list. Only a confirmed missing preview endpoint is a capability fallback: authentication, rate-limit, timeout, and server failures propagate as actionable errors, and a read-only snapshot reports them as an unconfirmed native-stack state.
Extending a partially registered stack revalidates already-registered published pull requests against their captured head commit, base, repository, state, and stack membership before appending missing members; checking only the new pull requests cannot detect a concurrently changed predecessor. A resumed extension stays bound to the saved native stack number: that stack must remain open and retain its captured submitted members. Moving those members into another valid listed stack is not approval to extend or report success for the replacement, even when no append is needed.

Submission recovery preserves the approval's identity: a recorded PR number cannot be replaced by another PR on the same branch, and a retarget may proceed only from its reviewed original base or finish idempotently at its intended base. Before a retarget PATCH, the recorded PR identity, repository, head OID, and local and remote tips are revalidated against the saved approval. Matching PRs or native stacks are recoverable as this submission's own work only after a create request was initiated with an uncertain outcome; planning creation or a definitive rejection grants no ownership. HTTP client rejections clear the respective create intent, while timeouts and server/transport failures retain lost-response recovery.

Before a new PR creation POST, both the local branch and its remote tip must still equal the captured publication OID, including on retries that skip an already-completed push. A ready or draft PR must not be created for a moved branch and rejected only at later stack registration. Recovering an already-accepted creation does not repeat the POST: before persisting adoption or advancing later layers, its PR head OID and both branch tips must match the journalled commit. GitHub owner/repository identity is compared case-insensitively, without relaxing branch, PR number, state, or OID checks.

A successful PR creation response also requires head-OID and local/remote-tip proof on readback before its step completes or later layers run; the returned PR number remains journalled if that proof fails, so recovery cannot duplicate it. An idempotent push whose remote already holds the reviewed commit still installs origin tracking through the locked push path, without issuing another remote push.

### Reconciliation

GitHub owns submitted membership and order. `src/main/reconciliation.ts` derives one deterministic state per stack by comparing that authority with local parent hints, pull-request head/base refs and SHAs, origin tracking refs, and real Git ancestry. The states are `matching`, `local-only`, `remote-native`, `reordered`, `stale`, `diverged`, `missing-branch`, `retargeted`, `merged`, `externally-unstacked`, and `ambiguous`; `ambiguous` blocks instead of guessing and never offers a repair. Every other state lists explicit repairs with the evidence each one would act on. Reporting and refresh only read: they never rewrite a branch, a parent hint, or a pull-request base. Repairs execute from a captured preview whose plan is re-validated against the origin URL, submitted membership, pull-request head SHAs and bases, and every recorded parent immediately before the first mutation, so a concurrent change fails as a stale preview instead of being overwritten. Repairs that move a branch or retarget a pull request require explicit confirmation, back the branch up under `refs/git-stacks/reconciliation/`, and append their recovery evidence to the report.

The Stacks reconciliation panel has its own keyboard-scrollable, bounded region, so native and local-only reports remain reachable without hiding the existing branch workspace. Repair choices are keyed to individual preview operations rather than repair kinds: selecting one of several branches with the same repair kind mutates only the selected branch. A checked-out branch cannot be silently moved to a submitted or remote tip; a destructive repair must leave its prior ref and recovery journal available.

A missing submitted or recorded parent is an ambiguity blocker, never inferred as matching ancestry; the native report follows local parent links transitively so multiple unstacked descendants remain visible with their own explicit repairs. A failed repair presents the backend's actionable refusal inside the focused dialog, not only in the global banner behind it.

An unfetched submitted head is likewise ambiguous; a known submitted head strictly ahead of the local branch is stale even when its origin tracking ref lags, and moving the branch requires an explicit backed-up repair. Local-only reports include one-member roots and all sibling descendants without treating separate branches based on the default branch as one stack. After GitHub revalidation, each parent-hint write checks the captured branch tip and hint again at the mutation boundary so a concurrent local edit cannot be overwritten.

Selected branch restorations and tip moves settle before parent-hint adoption; when no valid recorded ownership boundary exists, an inferred boundary is measured against the resulting parent and child refs, not a stale origin tracking ref. A member moved to another native stack remains visible in its former stack's report, but only the destination stack offers repairs to that member's parent hint; the former stack cannot clear a valid descendant hint. When merged predecessors are re-rooted onto their old base, adoption considers the immediately submitted predecessor, never an earlier merged member merely named by a stale local hint. It preserves the recorded replay boundary only when it equals that predecessor's submitted head, its canonical merge commit is reachable from the base, and the boundary remains an ancestor of the child. A newer boundary may include unmerged commits, so any unproven boundary withholds the repair for explicit inspection instead of replaying or dropping work.
Selecting only some parent-order repairs is checked against the resulting local parent graph before any write; a subset that would create a cycle is rejected without consuming the preview, so the dependent order repairs can be selected together.
An ordinary reordered member keeps its valid recorded replay boundary even when its new parent is already ahead of the child; replacing that boundary with the new parent's merge-base would change commit ownership during restack. A missing or invalid boundary with an existing recorded parent withholds adoption, and selected ref moves recheck that the retained boundary still belongs to the child before writing metadata.
For submitted native members, reconciliation binds the canonical pull request by the stack's PR number, not by the branch head: another open PR can share that head. If that numbered PR now identifies a different head or repository, the native stack is ambiguous and offers no repair; closed or merged members missing from the open-PR query retain their submitted stack identity.
Adopt-order previews capture the exact resolved parent ref and commit used for the replay boundary. A changed, removed, or differently resolved parent invalidates the preview before any write; the selected parent is checked again at the mutation boundary, accounting for selected ref moves. Restoring a missing branch refuses to update a symbolic HEAD in the current or another worktree.

### Git runtime diagnostics

The advanced Git runtime choice uses a labeled two-way control: **Bundled runtime** and **System Git**. Keep the selected choice visible even if that executable cannot start; pair the failure message with a recovery path so users can reverse the choice without guessing.

Display the active source, version, executable path, minimum-version result, and capability labels as text rather than color alone. If resolution fails, say that the runtime is unavailable instead of showing stale details.

Both runtime choices use the same Git operation guards. Custom `files:` reference-storage paths are decoded as native absolute file paths, including Windows drive letters; a remote host, credentials, query, fragment, malformed escape, or NUL is refused instead of treated as a local lock path. Passing local runtime tests does not establish that a signed Windows or macOS release artifact was produced; signing and shipment remain release-workflow gates.

## Do's and Don'ts

Concrete guardrails for the existing system and the user-confirmed Quiet Workbench direction:

### Do:

- **Do** use Workbench Ink for primary actions and navigation, with Repository Blue reserved for links, selection, focus, and meaningful identity accents.
- **Do** keep selection, checked-out state, pull-request lifecycle, checks, review, restacks, and diff additions/deletions/hunks independent and explicitly labelled.
- **Do** use the 4px spacing rhythm, 36/44px controls, 44/56px rows, and the defined 12/16/24/999px radius scale where the current component architecture consumes them.
- **Do** use `semantic.border.essential` for essential boundaries, `semantic.focus.ring` for keyboard focus, and text/icon descriptions alongside every Git status.
- **Do** define primitive, semantic, and component tokens in `src/renderer/src/design-system/tokens.json`; treat `tokens.css` as generated output, never a second manually maintained palette.
- **Do** keep the renderer local-first, preserve the sandbox/preload/IPC/CSP boundary, and retain busy-state text when reduced motion removes animation.

### Don't:

- **Don't** globally replace `--accent` with ink; selection, links, checked-out state, and stack graphics remain Repository Blue, while merged pull requests remain violet.
- **Don't** use color alone for status, lifecycle, review, checks, unknown/unavailable data, or diff meaning.
- **Don't** use decorative `semantic.border.decorative` dividers as a substitute for essential control boundaries or meaningful graphics.
- **Don't** add external font loading, font files from chat artifacts, a second manually maintained palette, CRM runtime behavior, or new Git/IPC/navigation semantics.
- **Don't** claim that every existing component consumes all density or radius tokens; migrate each consumer as its owning issue changes it.
- **Don't** use shadows to imply Git state; reserve depth for floating, transient, or elevated surfaces.

## Styling constraints and exceptions

Legacy aliases may remain only for the existing consumers listed below and must resolve to the generated semantic palette. New consumers must use semantic/component names directly. Do not introduce a parallel palette or expand legacy alias usage.

| Alias                            | Exact consumers in `src/renderer/src/styles.css` (unless noted)                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--surface`                      | `.branch-icon`, `.sync-stat-grid > div`, `.pr-detail`                                                                                                                                                                                                                                                                                                                                                             |
| `--surface-muted`                | `.branch-row:hover`                                                                                                                                                                                                                                                                                                                                                                                               |
| `--ink`                          | `.sidebar-info-value-right`, `.list-title-group h1`, `.branch-row`, `.branch-pr-link:hover`, `.branch-name-line strong`, `.detail-section h3`, `.sync-stat-grid strong`, `.pr-detail-heading`, `.onboarding-content h1`, `.stack-member-name`                                                                                                                                                                     |
| `--ink-soft`                     | `.sidebar-info-row`, `.detail-grid strong`, `.onboarding-content > p`, `.onboarding-recents-heading`, `.delete-branch-note`, `.workflow-note`, `.workflow-loading`, `.workflow-facts dt`, `.stack-preview-list span`, `.stack-preview-list p`, `.stack-workspace-header label`, `.stack-workspace-header p`, `.stack-member-meta`                                                                                 |
| `--ink-muted`                    | `.sidebar-empty`, `.sidebar-loading`, `.list-subtitle`, `.branch-tree-trunk`, `.branch-tree-elbow`, `.branch-icon`, `.branch-subject`, `.metric-muted`, `.branch-updated`, `.branch-chevron`, `.details-placeholder`, `.detail-grid span`, `.sync-stat-grid span`, `.pr-detail-meta`, `.detail-section-muted p`, `.detail-section-muted small`, `.detail-actions .action-hint`, `.onboarding-recents-heading svg` |
| `--line`                         | `.list-toolbar`, `.branch-icon`, `.sync-stat-grid > div`, `.pr-detail`, `.onboarding-recents`, `.onboarding-recent:hover`, `.pr-lifecycle`, `.stack-preview-list li`, `.stack-workspace-header`, `.stack-github-note`, `.stack-member`                                                                                                                                                                            |
| `--accent`                       | `.sync-stat-grid svg`, `.pr-detail-heading svg`, `.stack-preview-list li > svg`, `.stack-member-name svg`                                                                                                                                                                                                                                                                                                         |
| `--accent-strong`                | `.branch-pr-link`, `.branch-icon-current`, `.onboarding-icon`, `.stack-member-name:hover`                                                                                                                                                                                                                                                                                                                         |
| `--accent-line`                  | `.branch-row-selected`, `.branch-icon-current`, `.details-placeholder svg`, `.onboarding-icon`                                                                                                                                                                                                                                                                                                                    |
| `--accent-wash`                  | `.branch-row-selected`, `.branch-row-selected:hover`, `.branch-icon-current`, `.onboarding-icon`                                                                                                                                                                                                                                                                                                                  |
| `--ring`                         | `.stack-member-name:focus-visible`; `App.tsx` code-region Tailwind focus utility                                                                                                                                                                                                                                                                                                                                  |
| `--success`                      | `.metric-positive`, `.workflow-complete`; `App.tsx` success-notice icon                                                                                                                                                                                                                                                                                                                                           |
| `--success-wash`                 | `.workflow-complete`                                                                                                                                                                                                                                                                                                                                                                                              |
| `--warning`                      | `.detail-missing`, `.restack-notice`, `.desktop-notice`, `.browser-disclaimer`, `.workflow-warning`                                                                                                                                                                                                                                                                                                               |
| `--warning-line`                 | `.restack-notice`, `.desktop-notice`, `.browser-disclaimer`                                                                                                                                                                                                                                                                                                                                                       |
| `--warning-wash`                 | `.restack-notice`, `.desktop-notice`, `.browser-disclaimer`, `.workflow-warning`                                                                                                                                                                                                                                                                                                                                  |
| `--danger`                       | `.metric-negative`, `.workflow-blockers`                                                                                                                                                                                                                                                                                                                                                                          |
| `--danger-line`, `--danger-wash` | `.workflow-blockers`                                                                                                                                                                                                                                                                                                                                                                                              |

The only permitted literal renderer colors outside generated tokens are the decorative `::-webkit-scrollbar-thumb` (`#c7cbd3`) and its hover state (`#abb1bd`). Do not use these exceptions for text, essential control boundaries, or status indicators. Palette-looking text displayed in a source diff is content, not a visual style.

Fixed numeric sizes in `styles.css` are permitted for branch connector lanes/offsets, dense list metadata, icon geometry, workbench breakpoints, and pane constraints. Preserve their desktop layout roles rather than converting every number to a token.
