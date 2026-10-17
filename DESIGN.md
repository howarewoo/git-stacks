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
    backgroundColor: '{colors.surface-inset}'
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
    backgroundColor: '{colors.selection}'
    textColor: '{colors.selection-strong}'
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

Git Stacks is a quiet, precise desktop workbench for many branches, worktrees and pull requests across repositories. Development stays in external tools. The approved immutable v5 branch/worktree composition replaces the unreleased graph-first shell; earlier ui-131 references and ten-destination parity requirements are historical, not current design authority. Keep the Quiet Workbench's neutral canvas, solid surfaces, compact information hierarchy, fonts, radii and light/dark themes. Clarity wins over decoration.

Workbench Ink anchors primary actions and readable text. Repository Blue supports links, focus, selection, checked-out state, and meaningful graph edges; independent labelled semantic colors communicate Git states. Large rounded cards group complete existing domain objects. Sparing broad, diffuse, low-opacity shadows and small offsets on secondary cards support spatial hierarchy and interactivity without turning operational lists, diffs, forms, or safety dialogs into decoration. No gradients or glass are introduced.

**Key Characteristics:**

- Cool-gray workspace canvas with white content surfaces and inset grouping surfaces.
- Neutral ink primary actions, with pastel microaccents for small meaningful selection, indicators, and labelled status details.
- Independent, text-labelled Git states for selection, checked-out state, pull-request lifecycle, checks, review, restacks, and diffs.
- Compact information density for branch/worktree, pull-request, history and diff rows.
- Local-first, keyboard-accessible, operation-safe behavior with no external font or network dependency.

## Colors

The palette is a restrained cool-gray and white workbench with near-black primary type and actions. Pastel surface accents carry small meaningful states with contrast-correct text.

### Primary

- **Workbench Ink** (`semantic.action.primary` and `semantic.text.primary`): neutral primary action fill and readable primary type, with the theme's contrast-correct `semantic.action.primary-foreground`. Hover and pressed use the existing ink roles in both themes.
- **Repository Blue** (`semantic.action.link` and selection roles): links, focus, subtle selection, checked-out state, and meaningful graphics, not a large saturated action fill.

### Secondary

- **Muted Slate** (`semantic.text.secondary`): secondary readable text and metadata. It remains readable on the canvas and work surfaces rather than being treated as disabled text.
- **Repository Blue** (`semantic.action.link`): a restrained link and meaningful-selection accent, not a second primary action hierarchy.

### Tertiary

- **Restack Amber** (`semantic.feedback.warning-text` on `semantic.feedback.warning-surface`): requires-restack and warning text/surface pairs.
- **Error Garnet** (`semantic.feedback.error-text` on `semantic.feedback.error-surface`): error and closed-state text/surface pairs.

### Neutral

- **Cool Gray Canvas** (`semantic.surface.canvas`): workspace backdrop.
- **Work Surface** (`semantic.surface.content`): content, controls, and dialog surfaces.
- **Inset Surface** (`semantic.surface.inset`): grouped content and secondary controls.
- **Row Hover** (`semantic.surface.hover`): quiet hover state.
- **Decorative Divider** (`semantic.border.decorative`): a last-resort separator only when spacing and solid tonal contrast cannot make a grouping clear; never a default panel outline.
- **Essential Border** (`semantic.border.essential`): field and control boundaries that must remain visible.

### Feedback and Git states

- **Info Blue**: `semantic.feedback.info-surface` with `semantic.feedback.info-text`.
- **Success Green**: `semantic.feedback.success-surface` with `semantic.feedback.success-text`.
- **Warning Amber**: `semantic.feedback.warning-surface` with `semantic.feedback.warning-text`.
- **Error Garnet**: `semantic.feedback.error-surface` with `semantic.feedback.error-text`.
- **Merged Violet**: `semantic.feedback.merged-surface` with `semantic.feedback.merged-text`, reserved for the labelled merged Git state.
- **Diff roles**: addition `semantic.diff.add-text` on `semantic.diff.add-surface`, deletion `semantic.diff.remove-text` on `semantic.diff.remove-surface`, and hunk `semantic.diff.hunk-text`.

**The Meaning Before Color Rule.** Every selection, checked-out branch, pull-request lifecycle, checks state, review decision, restack requirement, and diff role has an explicit text or icon meaning. Unknown or unavailable GitHub data uses the neutral unknown role and an explicit unavailable label; it is never represented as none, zero, or passing.

**The Essential Boundary Rule.** Separate UI groups with spacing and solid tonal surface differences first. Borders are a last resort for separation: surfaces, cards, rows, section headers, and status badges do not receive decorative outlines by default. Inputs, editable controls, keyboard focus, meaningful graph/diff lines, and deliberately connected controls retain a visible boundary where discoverability requires it, using `semantic.border.essential` or `semantic.focus.ring`. Keep border tokens meaningful; do not hide every border with a global override. Use sparse diffuse card shadows only where they serve layering or interactivity, never gradients or glass.

## Typography

**Display Font:** Inter when locally available, with `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI` fallbacks.
**Body Font:** Inter when locally available, with the same system sans fallbacks.
**Label/Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, and `Consolas` for code, paths, refs, and OIDs.

**Character:** The system sans keeps the workbench familiar and readable when Inter is absent. Monospace is reserved for identities and code-like values, so data remains scannable without turning the interface into a code editor.

### Hierarchy

- **Heading** (20px / 1.25): work-surface and dialog titles.
- **Body** (14px / 1.5): substantive explanations, comment bodies, and form content.
- **Label** (13px / 1.35): subsection and empty-state titles, control labels, and concise row labels.
- **Metadata** (12px / 1.4): timestamps, counts, paths, refs, and supporting status details.

Subsection and empty-state titles use semibold weight. Compact and standard controls share the label role; density changes height and padding, not font size. Field help and measured facts use metadata, while complete safety and ownership explanations use body. The renderer's `text-sm` and `text-xs` utilities map to the body and metadata roles; a custom size class must carry its matching line-height token rather than inheriting another role's line height.

Diff text retains its compact 12px / 1.6 code rhythm. Single-letter file-status glyphs retain 10px inside their fixed icon-sized cells; they are not a general-purpose interface text size.

**The Code Is Monospace Rule.** Use the system monospace stack for code, paths, refs, and OIDs; use the system sans stack for interface copy. No external font is loaded and no font files are copied from chat artifacts.

## Layout

The reference is `git-stacks-workbench-v5.html` at retained commit `40ade209a2855c68a2834e3d49d96814432c5f3a`. Its branch/worktree hierarchy, bottom-up lanes, selected registry branch and inspector are a composition contract, not loose inspiration. Never embed the prototype or copy its simulated state/mutation engine. Exact reference artifacts remain immutable; ui-131 artifacts remain historical.

### Persistent shell geometry

- The window is a full-height flex column: 64px top bar, flexible shell, 32px status bar. Canvas insets are 12px horizontally; sidebar/main/inspector gutters are 12px. At 1536×1000: sidebar 224px, main 888px, inspector 376px. At 1440×940: sidebar 224px, main 792px, inspector 376px. All panes begin at y=64 and end 32px above the bottom.
- Top bar: brand aligns with the rail; global search begins after the brand plus 24px gap, is 36px tall and caps at 440px. Global utilities align right. Native window controls may consume native title-bar space, not create repository tabs.
- Sidebar is the only repository switcher: 24px surface radius, 20px top inset, 12px side/bottom insets; workspace identity, cross-repository Needs attention and Activity, repository Branches and Pull requests, pinned repositories, aggregate readiness, footer utilities. Nav rows are at least 40px, repo rows attach worktree counts and attention facts. There is no Agents, Stacks, Working changes, Stashes, or independent development destination.
- Main header has 24px top / 20px side / 16px bottom padding. Repository-qualified breadcrumb precedes the 20px title; subtitle follows with an 8px gap. Primary Discover worktrees aligns right; secondary creation stays in the scoped action menu. Four status filters (All branches, Needs you, Unpublished, Ready to merge) include separate counts beneath the header (20px side inset, 16px bottom gap), then local search/worktree availability/Display (36px targets, 12px bottom gap). No graph/list toggle.
- Main and inspector are solid content surfaces with 24px radius and independent scroll regions. Headers and footer actions remain reachable. Main scroll has 12px side/bottom insets; sticky labels stay above rows, not above overlays.
- Inspector is 376px wide with 20px insets: repository-qualified branch context, monospace ref, 20px/1.35 title, independent PR/lifecycle facts, then Overview/Changes/Checks/Discussion line tabs. Scroll content follows with 16px top inset. Working directory, PR status and bottom-up relationships are separate sections, 24px apart. Footer has the primary review/publication/history action, Copy worktree path and the shared scoped-action menu; restack/sync/publish/lifecycle actions do not become a competing footer toolbar.

### Bottom-up Branches lanes

- One row per qualified branch, with attached worktree facts. Local-only, remote-only, branch-without-worktree and PR-without-local-branch identities remain inspectable; exceptional worktree associations require an explicit selector, not duplicated branch rows.
- Descendants appear above their actual parents; trunk appears below dependents. Chains share a track; forks branch from the actual parent, never the visually nearest row. A root has no fabricated edge. Distinguish recorded intent, GitHub PR base, inferred ancestry and native membership; unresolved/conflicting/cyclic relationships remain stated.
- Default compact branch rows are at least 76px; trunk is 64px. Standard density uses 92px and 76px respectively. Content may grow. The relationship gutter is `28px + maxLane × 20px`, with a minimum two tracks. Columns are selection 18px, relationship gutter, flexible branch/PR identity (minimum 180px), working directory 148px, PR status 124px, row actions 24px, with 8px gaps.
- Branch identity uses 13px/1.35 monospace; title/PR context, worktree name and local facts, review and checks each use 12px/1.4 supporting text. Ref, PR title and worktree directory remain separate. Local changes/unpushed commits are not PR readiness. Rows truncate long refs with full accessible names; paths wrap in inspection.
- Edges are 1.5px essential-boundary strokes at subdued emphasis; selected ancestry uses Repository Blue at 1.8px. Nodes are content-filled outlined circles; selected node is blue with an info-surface halo. Selection uses the selection surface, independently of checkout/lifecycle. Hover uses inset/hover tones. Ancestor context uses inset fill and an explicit Context label.
- Filter, fold and page projections retain real ancestors and stable track positions; never reconnect to a different parent or hide disagreements. Context and protected trunk cannot enter bulk selection. Select page includes only visible matching eligible rows, never hidden or unloaded data. Fold controls state exact descendant count and preserve the parent's scroll anchor when children expand above it.
- Mounted lane, inspector relationship and off-page continuation pages are distinct bounded projections of complete qualified authority. Continuation controls name both endpoints, never draw across missing rows, and must reach every actual parent. Page-relative bulk selection cannot silently include other pages.
- Arrow/Home/End row navigation crosses windowed pages without changing inspection or dispatching an action. Preserve the exact focused qualified identity through mounting; modified/IME chords belong to the global dispatcher and nested controls keep their own semantics.

### Collaboration and secondary desktop surfaces

- Pull requests uses a qualified list and full Review, never duplicate lanes. Keep
  lifecycle, draft, checks, review, native membership and published revision
  independent; missing source data remains named unknown. Host/repository and
  fork/head/base identity remain visible in review and management context.
- Attention is global even with no pinned repository selected. Group reasons,
  count a provider PR once, and retain clone-local safety problems separately.
  Unknown/incomplete source and observation time remain visible, not decorative
  success badges or zero counts. Activity shows observed transitions, never an
  initial snapshot presented as historical events or external-agent liveness.
- Return routes restore the originating repository, view, filters, folds and
  scroll. Open forms retain their original source; authored review, reply and PR
  body text is not relocated or discarded by navigation or source refresh.
- Overall summary/decision versions retain durable composition identity. A recovered
  earlier receipt never clears newer unsent words. Missing or unusable provider
  confirmation holds text and replay guards, never displays a sent state.
- Retained reply recovery remains reachable independently of the live thread list,
  including unreadable, missing or truncated threads. Show original owner/thread/
  comparison, copy/edit and explicit qualified discard; absence disables send.
- Native rail members outside the bounded list show their requested qualified
  pending destination while an exact source-confirmed captured read completes.
  Actor/origin retirement never adopts or redirects to those stale results.
- Settings, local entry, clone and optional Notifications remain compact shared
  focus-managed secondary surfaces, with bounded scrolling, reachable actions,
  errors, cancellation and nested focus return. Local entry and primary provider
  session status are separate from optional Notifications consent/credentials.
- Display density and reduced motion follow authoritative appearance settings,
  not per-repository navigation memory. Density changes spacing, not typography.

### Collaboration and secondary desktop surfaces

- Pull requests uses a qualified list and full Review, never duplicate lanes. Keep
  lifecycle, draft, checks, review, native membership and published revision
  independent; missing source data remains named unknown. Host/repository and
  fork/head/base identity remain visible in review and management context.
- Attention is global even with no pinned repository selected. Group reasons,
  count a provider PR once, and retain clone-local safety problems separately.
  Unknown/incomplete source and observation time remain visible, not decorative
  success badges or zero counts. Activity shows observed transitions, never an
  initial snapshot presented as historical events or external-agent liveness.
- Return routes restore the originating repository, view, filters, folds and
  scroll. Open forms retain their original source; authored review, reply and PR
  body text is not relocated or discarded by navigation or source refresh.
- Overall summary/decision versions retain durable composition identity. A recovered
  earlier receipt never clears newer unsent words. Missing or unusable provider
  confirmation holds text and replay guards, never displays a sent state.
- Retained reply recovery remains reachable independently of the live thread list,
  including unreadable, missing or truncated threads. Show original owner/thread/
  comparison, copy/edit and explicit qualified discard; absence disables send.
- Native rail members outside the bounded list show their requested qualified
  pending destination while an exact source-confirmed captured read completes.
  Actor/origin retirement never adopts or redirects to those stale results.
- Settings, local entry, clone and optional Notifications remain compact shared
  focus-managed secondary surfaces, with bounded scrolling, reachable actions,
  errors, cancellation and nested focus return. Local entry and primary provider
  session status are separate from optional Notifications consent/credentials.
- Display density and reduced motion follow authoritative appearance settings,
  not per-repository navigation memory. Density changes spacing, not typography.

### Responsive layout and density

- At widths ≤1350px sidebar/inspector become 204/348px; ≤1199px they become 188/324px with 8px canvas/gutters and 16px pane insets. At ≥1680px use 236/408px and retain flexible main width.
- The lane pane owns its container breakpoints. Below 790px use 126px directory and 112px PR columns. Below 700px move working-directory facts beneath branch identity, remove only that column, and grow compact rows to at least 88px. Below 570px tracks are 16px, identity minimum 120px, PR 100px; hide secondary lane guidance and wrap the toolbar. Below 440px search occupies its own toolbar line. Do not hide unknown or blocking facts to save space.
- Below 1040px inspector becomes a dismissible right-side overlay (376px maximum, top 64px, bottom 40px). Use shared focus-managed Sheet behavior when it is modal; Escape and Close return focus to inspection trigger. Closing restores main width without changing checkout or selection. Below 760px the rail may reduce to icons with accessible names; this is desktop zoom/reflow, not a new mobile product.
- Native minimum is 1000×700; default 1440×940; reference 1536×1000. At 200% native zoom all content/actions remain reachable through reflow and owned scrolling, never fixed-height clipping or page-level horizontal overflow.

### Shared rhythm and layers

- v5's compact identity details retain a 16px brand label and 9px brand/repository marks; context/trunk tags use 5px utility corners and relationship rows use 10px corners. These pinned utility geometries are not new general-purpose radius or typography tokens.

Keep the 4px rhythm (4/8/12/16/20/24/32/40), 12px control, 16px item, 24px workbench and supported pill radii. Related controls/help are 8px apart, facts/fields 12px apart, major sections 16–24px apart. Compact/standard controls retain 36/44px targets; shared icon controls and coarse pointers retain 44px. Accessibility target-size differences from prototype chrome must not change the overall pane composition.

Motion uses 120/180/240ms with `cubic-bezier(0.2, 0, 0, 1)`; reduced motion maps durations to `0.01ms`, retaining status, focus and locks. Named layers are base 0, content 1, floating 10, overlay 60 and popover 70. Menus/dialogs use shared focus/portal ownership, not arbitrary z-index competition. Styling uses generated semantic/component tokens, never a second palette.

## Elevation & Depth

Depth starts with whitespace, grouping, and neutral background contrast. Complete content cards are independently understandable; broad, diffuse, low-opacity shadows are used sparingly for purposeful card and floating layers, not every row.

### Shadow Vocabulary

- **Small** (`semantic.elevation.small`): `0 8px 32px rgba(23, 28, 36, 0.06)` for complete shared cards and secondary synchronization facts.
- **Medium** (`semantic.elevation.medium`): `0 12px 40px rgba(23, 28, 36, 0.08)` for actual floating menus, hover cards, and tooltips.
- **Large** (`semantic.elevation.large`): `0 16px 56px rgba(23, 28, 36, 0.10)` for dialog layers.

**The Purposeful Layering Rule.** Use diffuse depth sparingly to clarify a real card or floating layer. Secondary cards may use a 4px spatial offset with disciplined internal alignment: the catalog inspection/checkout composition and real synchronization facts demonstrate this. Do not rotate operational Git rows, diffs, forms, or safety dialogs, obscure actions, or imply Git state through shadow. Never introduce sharp or dramatic shadows, glass, or decorative gradients.

## Shapes

Retain the generous rounded identity: 12px text controls, 16px items, 24px work surfaces/dialogs and complete cards, with supported 999px pill badges and segmented controls. Icon buttons are circular with generous 44px targets; existing utility-specific corners and genuine circles remain valid. Use the canvas, content, and inset tones with explicit spacing to distinguish panels and sections in both themes. Essential editable controls keep visible 1px boundaries; generic surfaces, section headers, rows, and feedback badges do not. Clipping follows the owning work surface.

## Iconography

Use the existing [Lucide icon catalog](https://lucide.dev/icons/) through direct
static named imports from `lucide-react`. No generic Icon wrapper, runtime registry, duplicate SVG collection
or shared re-export is needed. Icons are supporting meaning, not decoration.

- Use 16px glyphs beside compact control labels and Git-object metadata; use 20px
  glyphs for standard control compositions. Existing small inline status contexts,
  such as remote freshness, may use 12px beside explicit text. Glyph size never
  determines the action target: icon-only controls retain a 44px target.
- Preserve Lucide's consistent default 2px outline stroke; do not mix filled and
  outline treatments or vary stroke weight to imply state.
- Inherit `currentColor` from the surrounding semantic foreground. Use primary or
  secondary text for objects and neutral unknown/unavailable states, and labelled
  success/warning foreground roles for those states. Never hard-code theme colors
  or use color alone as the status.
- Center glyphs with adjacent labels, prevent flex shrinking and use the existing
  8px related-control gap. Keep icons and text together during reflow.
- Decorative icons beside text or inside a named control use `aria-hidden="true"`.
  A meaningful standalone icon has an accessible name (for example `role="img"`
  with `aria-label`). `IconButton` requires an actionable `label`; its tooltip
  supplements that name. Ambiguous actions require visible labels.
- Keep explicit success, warning, unavailable and unknown text. Preserve the shared
  loading `Button` / `Spinner` contract, action name and disabled dispatch rather
  than spinning an action glyph. Respect existing reduced-motion behavior.

## Components

The shared [shadcn/ui](https://ui.shadcn.com/)-style component library lives in `packages/ui/src/components/ui` and is consumed through `@git-stacks/ui` by desktop and the design catalog. `packages/ui/components.json` selects `base-nova` with CSS variables and the configured aliases. Base UI (`@base-ui/react`) supplies accessible interaction primitives; the shared wrappers supply the workbench's token roles and composition contracts. Buttons remain CVA-based (`class-variance-authority`) and compose variants through `cn()` (`clsx` + `tailwind-merge`), with Tailwind CSS v4 and Lucide icons (`lucide-react`). Shadcn is owned source and configuration, not a runtime or CLI application dependency.

### Design-system reuse

- Both applications use shared components in their actual interfaces, including catalog chrome and navigation, not only in specimens. Compose the existing component when it covers the interaction; do not recreate its appearance or behavior with app-local markup and CSS.
- App-specific layout and domain compositions remain with their application. Semantic HTML is appropriate for document structure and content; shared components own supported controls and interaction patterns.
- When a reusable capability is missing, extend the shared component or add it to `@git-stacks/ui` rather than creating an app-local counterpart. Keep browser-safe foundations shared and Git, filesystem, credentials, and transport out of the component library.
- Catalog specimens exercise the same implementation used by application interfaces. A specimen is not permission to add a new desktop workflow.

`WorkbenchPane` owns bounded pane chrome: persistent header/footer slots, a
min-height-zero independently scrolling body, content surface and workbench
radius. Desktop owns branch relationships and domain selection; catalog uses
the same shared pane implementation rather than duplicating its scroll behavior.

### Buttons

- **Shape:** Text `Button`, `Input`, `Select`, and `Textarea` retain the 12px semantic control radius. `IconButton` is circular, uses simple 16px or 20px Lucide icons, and has a 44px target.
- **Primary (`default`):** Solid neutral Workbench Ink with the theme's contrast-correct inverse foreground and existing ink hover/pressed roles. Use for the main task's completion action, not every available action.
- **Secondary:** Solid inset background and Workbench Ink text, with row-hover fill on hover; no default outline. Use for supporting actions and Cancel beside the primary action. Explicit `outline` variants remain available when a boundary is necessary for discoverability.
- **Ghost:** Secondary text with inset hover and primary text on hover. Use for repeated row or toolbar actions that should not compete with the main task.
- **Subtle:** Inset background with secondary text, shifting to row-hover and primary text on hover. Use for optional help and utilities that need a visible resting surface, not as another name for a supporting task action.
- **Accent:** A restrained pastel selection surface with contrast-correct selection text; keep saturated color out of large action blocks and avoid competing primary actions. Accent does not supply selection behavior: use `SegmentedControl`, `RadioGroup`, or another shared selection control for a persistent choice.
- **Danger:** Solid error surface and error text without a redundant error-colored outline. Use for destructive actions after their scope and consequences have been stated; the final confirmation retains this role.
- **Link:** Repository Blue underlined text with a selection-colored underline. Navigation retains an anchor's real destination and browser behavior.
- **Sizes:** Text `sm` is 36px high; text `default` and `lg` are 44px high. All icon sizes provide a circular 44px target. Coarse pointers retain a 44px minimum target through the renderer's pointer media query.
- **States:** `focus-visible` uses a 2px Repository Blue focus ring with a surface-colored offset. `loading` overlays a decorative busy indicator while retaining the original content's footprint and accessible name, sets `aria-busy`, and prevents another dispatch. Keep caller labels and icons stable across the transition; do not add a second spinner. Reduced motion retains a static visible busy marker. Disabled controls remain non-interactive while their tooltip wrapper stays keyboard-discoverable.
- **Semantics:** Use `nativeButton={false}` when rendering an anchor through `Button`; retain its real `href` and link behavior. Use `danger` for destructive actions, including their final confirmation, rather than making a destructive action look like a routine primary action.

### Badges

- **Neutral (`secondary`):** Solid inset background and secondary text, without a default border.
- **Outline:** Transparent background with essential border and secondary text.
- **Accent:** Solid selection background and selection text, without a redundant outline.
- **Info / Success / Warning / Danger / Merged:** Their named feedback background/text pairs. Every badge includes a text label; color is not the state itself.
- **Default:** Neutral inset background and secondary text; the legacy `default` name is retained as a neutral badge alias rather than inheriting primary-action ink.

### Inputs / Fields

- **Style:** White background, essential border, Workbench Ink text, secondary placeholder text, and semantic 36px compact or 44px standard control heights.
- **Composition:** `Field` associates visible labels, required state, helper text, and error text with shared `Input`, `Select`, and `Textarea` controls. `Select` is a button-based combobox with a portaled option list; an empty-string option remains a real choice when the workflow defines one. `Checkbox` exposes checked and mixed states without nesting interactive labels. `RadioGroup` names mutually exclusive form choices; `SegmentedControl` keeps exactly one nonempty-keyed choice selected and supports roving keyboard focus.
- **Focus:** Repository Blue border plus a 2px Repository Blue ring.
- **Disabled:** Inset background with reduced opacity and a not-allowed cursor. Composite controls receive the operation's disabled state explicitly, including controls whose popups leave a native fieldset.
- **Draft ownership:** TanStack Form owns local form values, validation, and submission state. Hydrated saved values and defaults stay aligned across conditional sections. Repository snapshots, captured previews, recovery journals, editor buffers, and durable review documents remain domain-owned rather than copied into parallel form state.

### Navigation

- **Style:** The shell uses quiet text and count metadata with a selected state separate from checked-out state. Active navigation uses the subtle selection role; primary actions use neutral Workbench Ink.
- **Keyboard:** Global `:focus-visible` treatment is available for keyboard navigation and controls. Disabled or unavailable actions retain a text or tooltip explanation. Disabled menu items may receive arrow-key focus so their reason remains discoverable, but cannot activate.
- **Grouping:** Needs attention and Activity span repositories; Branches and Pull requests belong to selected repository context. Pinned repositories live only in the sidebar. Optional Notifications remains separate and consent-bound; settings/diagnostics and reachable operation recovery are utilities, not development destinations.
- **Search placement:** Global search lives in the top bar; local branch/PR/path filtering lives below the main header and status filters. Do not duplicate repository tabs or a checked-out-branch toolbar.
- **Repository context:** Switching changes focus only and restores that repository's view, qualified selection, filters, folds and scroll. Global work retains source repository identity; neither inspection nor review requires checkout or worktree creation.
- **Inspector hierarchy:** Selected ref and title precede worktree context, separate PR status and relationship facts. Local changes/conflicts are read-only; validated external-tool/path handoff does not imply tool liveness. Scoped publication, restack, dependency, sync, merge and lifecycle actions enter captured previews with confirmation and recovery.
- **Shared navigation controls:** Sidebar items and tabs use the label type role, compact/standard density, control radius, and token motion. Selection is flat, with the named selection surface and primary text; hover uses the surface-hover role, never an opacity-derived palette. `TabsList` supports `controlSize="compact"` or `"standard"` independently of horizontal/vertical orientation. Line tabs mark selection with a blue underline or vertical edge instead of a shadow.
- **Catalog navigation:** Use `SidebarProvider`, the built-in off-canvas `Sidebar`, and `SidebarTrigger` for whole-sidebar collapse; do not maintain a second catalog open/close state. Search and appearance controls sit above the independently scrolling index. Below the shared 768px sidebar breakpoint, Browse components opens its sheet. Choosing an anchor closes the sheet, marks the destination, and transfers focus. Visible-section tracking updates the current marker and exposes its category during scrolling without changing the hash, history, or focus; filtering and resizing rebuild that tracking. Category disclosure composes `SidebarGroupLabel` with `CollapsibleTrigger`; search exposes matching categories, and navigation opens the active component's category. Command navigation includes Foundations and Git compositions as well as components. Inline specimens must not move the page before interaction.
- **Catalog guidance:** Keep the full searchable inventory, with a visible usage sentence explaining the intended interaction and relevant alternatives on every entry. Pair control variants with concise intended-use guidance and canonical spacing, radius, and elevation values with visual examples. A compact task-to-recipe guide links inspection, value selection, captured-scope confirmation, and status/recovery to existing specimens; it is optional navigation, not a tour or a new product workflow. Its shared link controls retain link semantics and destination focus. Git examples use compact, aligned rows in one rounded group; ancestry connectors support explicit parent labels, and checked-out identity stays labelled independently of inspection.
- **Catalog adoption examples:** Keep copyable source identical to the typed component shown beside it. Include state ownership, labels, help/error relationships, loading outcomes, and cancellation boundaries rather than imports alone. Keep consequential examples explicitly local; they do not substitute for production captured previews or mutation gates.
- **Catalog search context:** Query changes align the result heading without transferring focus from search. Short and empty results retain enough reading area for the same alignment. Clearing restores the pre-search section's viewport position; explicitly choosing a destination takes precedence over restoration.
- **Grouped foundations and Home:** Keep tokens, Typography, and Typeset adjacent in catalog content and grouped in its navigation. Preserve component anchors and the full searchable inventory. The sidebar brand header links to the introduction at the genuine page top, with no standalone Home button; it clears search without restoring its previous viewport, transfers focus, and closes the narrow sheet. Back/Forward retains the destination and current marker. Category labels stay uppercase metadata-weight triggers with counts and chevrons above indented sentence-case items, without boxes or borders.
- **Prose Typeset:** Apply shared `.typeset` only to reading content, never global controls or desktop Git workflows. `.typeset-docs` and `.typeset-compact` use local font roles and theme tokens; size, leading and flow determine rhythm independently of compact Typography APIs. Layout owns measure. Semantic headings, lists, quotes, code, tables and media retain their native meaning. Components-layer, low-specificity element styles permit utility overrides. `.not-typeset` and `[data-not-typeset]` exclude their entire subtree, including nested activation; `.typeset-scroll` owns horizontal overflow for wide tables. Spacing flows from block starts and table separators belong to newly appended cells; appending content must not restyle preceding blocks.
- **Foundation palette examples:** Show foreground/background pairs for neutral surfaces, actions, selection, labelled feedback, and diffs through the generated theme roles. Essential-boundary and keyboard-focus examples use actual shared controls. Token identities remain readable at narrow catalog widths.

### Keyboard and screen-reader contract

- **Keyboard-first, never keyboard-only:** every primary action is reachable and operable with Tab, arrows, Enter, Space, and Escape alone. A pointer-only affordance is a defect, not an enhancement gap.
- **Focus clearance:** Shared buttons and focusable disabled-reason targets reserve a 4px scroll margin. Native keyboard scrolling must reveal the control with room for its focus ring, not stop with the control's lower edge clipped by a zoomed viewport.
- **Composite rows:** Branch lanes and PR lists provide roving row focus with Up/Down, Home/End and Enter to inspect. Checkbox selection is independent of inspection; a nested control's handled key is never consumed again. Paging/folding controls remain keyboard reachable and Home/End reach the complete filtered outline.
- **Role model:** Lane rows expose qualified identity, actual parent and explicit context/state in accessible text. SVG connectors are decorative; they are not a substitute for spoken parentage. Do not impose commit-tree semantics on branch dependencies or claim that missing parents are independent.
- **Focus follows navigation:** switching workspace destination moves focus to that destination's heading and announces the change in a polite live region, so focus is never left on the control that was pressed. Dialogs keep the Base UI modal focus trap and return focus to their trigger. A newly raised error takes focus unless a modal already owns it and shows its own inline error; an error that is already on screen never takes focus back, so closing a dialog still hands focus to its trigger.
- **State is named, not tinted:** a row's accessible name spells out the states the pixels also mark — current, remote, parent cycle, parent missing, requires restack, pull-request number, checks, and ahead/behind against the configured upstream. Unreported checks stay explicitly unknown rather than reading as passing, and a metric drawn as arrows and numbers is decoration whose meaning lives in the row's name.
- **Announcements:** success notices, rejected previews, and workspace changes are polite; errors and blockers are assertive. A live region states an outcome once, and never replaces the visible control it describes.
- **Zoom and motion:** the workbench reflows to a 720×470 CSS-pixel viewport, equivalent to 200% zoom on the standard window, without horizontal scrolling or unreachable actions. A control row's height is a minimum, never a fixed basis: at the zoom a person set, or in a narrow window, its controls wrap onto further lines and must push what follows them down rather than overlap it. `prefers-reduced-motion: reduce` suppresses transitions while status text, focus rings, and operation locks remain.

### Cards / Containers

- **Corner Style:** Workbench surfaces retain the 24px token; items use 16px and controls use 12px, with incumbent utility-specific corners preserved.
- **Shadow Strategy:** Whitespace and neutral background separation first; sparing broad, diffuse, low-opacity shadows for independently understandable cards and floating layers, never sharp outlines or dramatic elevation.

- **Internal Padding:** Use the 4px spacing rhythm, with 16px and 24px steps for work-surface and section rhythm.

### Dialogs

- **Overlay:** Fixed inset overlay at the `component.overlay` z-index with `component.overlay.scrim` (`semantic.surface.scrim`): neutral-dark `rgba(20, 24, 32, 0.34)` in both themes. Dialog, Alert Dialog, Sheet, and Drawer share this role; never derive a backdrop from theme-dependent text color.
- **Content:** Solid neutral card surface, no structural outline, retained 24px workbench radius, 20px padding, and diffuse low-opacity elevation at the overlay token's z-index. Height is viewport-constrained and scrollable so footer actions remain reachable when zoomed.
- **Compositions:** `WorkflowFrame`, `OperationContext`, and `WorkflowActions` give ordinary forms, reviewed operations, and destructive confirmations shared spacing and action roles. `Field` and `TypedConfirmation` retain domain-specific validation.
- **Confirmation identity:** Keep captured branch names, relationships, and excluded scope inside the confirmation surface, not only behind its overlay. Long identities wrap; the modal scrolls within the viewport. Catalog simulations retain their explicit no-Git/no-remote-operation boundary.
- **Close and focus:** Base UI focus management returns focus to the initiating control. Reviewed/destructive dialogs start on Cancel. Escape/backdrop never discards authored review work or interrupts active mutations; Cancel is distinct from Abort. Nested popups consume Escape first. Local conflicts are read-only; validated external-tool/path handoff preserves recovery context. Historical unsent text/recovery evidence remains available rather than silently erased by removal of the development editor. Failed initial loads offer Close, not implicit retry.
- **State:** Operation surfaces present loading, ready, blocked, submitting, rejected, partial, confirmed success and failure from real operation data. Important errors stay inline; successful notices are polite and dismissible. Rejected previews need a successful reload before dispatch. Local and PR diff previews are bounded, explicitly labelled when truncated, and never become editable replacements for complete bytes.
- **Recovery:** The persistent operation banner remains outside workspace-specific views. Continue respects conflict blockers; Skip and Abort retain their explicit loss warnings and existing Git actions. Progress uses actual completed and remaining branches. Aborting a stack surgery restores this repository only, and its report names every pull request base change, close, and native stack membership that already reached GitHub and therefore stands; the recovery surface never implies that a remote change was undone.
- **Submit Stack:** The publication dialog previews layers in bottom-to-top order, one section per branch, naming the pull request each layer opens or retargets. Base changes and the consent to replace remote history are separate, explicit approvals per layer; the force consent is only shown when the preview contains rewritten branches. Progress lists the real steps of the submission and updates while it runs, so the person watches the work they started rather than a finished state. A submission that stopped part-way is recovered from its journal: the saved per-layer title, description, readiness, and base approvals are shown read-only, the saved force consent is shown as fixed text rather than a control, and changing any of it requires dismissing the submission and taking a fresh preview. A control that looks editable while the journalled value is what actually runs is never shown.
- **Stack surgery:** The insert, move, and remove dialogs are one reviewed composition that names the branch the surgery is anchored on, the resulting order, and the resulting parent of every affected layer. Each layer carries its action, the tip it is replayed from, the pull request base that changes, and the push it needs, as text and badge together; a reparent that moves no commit is labelled differently from a replay. A blocked layer blocks the whole surgery in place rather than dropping out of the plan. Removing a layer is a destructive composition; inserting or moving is a reviewed one. The consent to replace remote history appears only when the preview contains a rewritten branch, and a local-only surgery says that nothing will be pushed instead of showing a push it cannot make. A layer the surgery inserts is published on the remote as a new branch whenever a pull request has to hang from it, named beside the retarget it enables, because a base branch that does not exist is not a base GitHub accepts; that publication is never a force push and never replaces an existing branch. An insert that cannot be published is blocked in the preview rather than planned. The remote half of a surgery is part of the same recovery composition as the replay: a step already in its reviewed result is reported as done instead of repeated, and a step whose pull request head, base, state, or native stack membership drifted is named and stops the run before it writes.
- **Saved submission identity:** Recovery always names the branches, bases, pull request numbers, choices, and steps from the persisted submission, never from a fresh preview of a changed stack. A failed fresh read does not hide saved approvals or recovery guidance. Resume remains available only for retryable failures; a non-retryable failure disables Resume in the dialog and rejects backend retry without changing the journal. Dismiss stays available, with guidance to fix the rejected chain and take a fresh preview.

### Branch deletion

- **Selection:** Bulk lifecycle selection is independent of inspection. Select page includes only visible matching eligible branch identities, excluding protected trunk and ancestor context. Filter/fold/repository changes retire hidden bulk selections. Backend-resolved scope, not checked row count, determines the exact preview; local/remote/ref/worktree target types remain explicit.
- **Eligibility:** Default, unknown-tip and worktree-associated refs remain protected according to main-owned lifecycle policy. Removing a worktree and deleting a branch are separate actions; safe directory cleanup preserves refs/PRs unless separately previewed. Busy state, administrative locks, missing paths and compatibility limits are explicit blockers, not proof of external inactivity.
- **Local confirmation:** Single and bulk local deletion share a Cancel-first destructive dialog naming every captured local ref and tip. No typed branch name is required. Merged-only deletion is the default; deleting unmerged work requires an explicit checkbox beside the unreachable-commits warning. Remote branches and pull requests remain untouched, and child branches are not retargeted.
- **Local safety:** A stale, protected, or unmerged member rejects the whole batch before any ref is removed. The deletion transaction checks every captured tip and locks all selected refs together. Configuration cleanup happens after deletion; a cleanup failure states that the refs were deleted rather than implying rollback.
- **Remote confirmation:** Single and bulk remote deletion use the same Cancel-first destructive dialog as local deletion, naming every captured remote-tracking ref and tip. No typed name or unmerged opt-in appears. The inspector and palette open this confirmation, never bypass it. The warning states that local branches remain, open pull requests may close, collaborators need to prune, and remote-only commits may become unreachable with no app undo.
- **Remote safety:** Unknown tips, remote symbolic HEAD, and default branches are not selectable. Main-process validation also checks the configured remote's actual HEAD and push destination. Each batch belongs to one configured remote and uses an atomic push with per-ref captured-tip leases. Mixed remotes, stale tips, unsupported atomic push, or server rejection cannot partially delete the selected branches. Transport uncertainty is shown as an unknown outcome, never reported as rollback or retried automatically.


### Onboarding

- **Entry:** With no repository open, the onboarding pane offers exactly three ways in — search GitHub, add a local repository, and drop a folder — with the drop hint stated as text rather than implied. Search is the accent action; adding a local repository is secondary. Recent repositories, the machine's Git facts, and the standard-Git explanation share the pane, and the explanation of what a clone produces precedes the controls that produce it.
- **Scroll-safe centering:** Center onboarding content only while it fits. A taller entry surface begins inside the pane's top padding and scrolls locally; the icon, heading, and repository actions must never sit above the reachable scroll origin.
- **Standard Git promise:** The pane states that a repository remains ordinary Git and keeps working in a terminal, an editor, and GitHub Desktop. Never present the app as the owner of the repository, a conversion step, or a proprietary format; the recents, the environment facts, and the clone result all name real filesystem paths.
- **Discovery results:** Each reachable repository is one row naming its full name, its badges, and its default branch. A private, empty, archived, or fork repository is labelled from the data, and a repository whose push access the response does not prove is marked read only. Neither endpoint reports a repository the credential cannot reach, and a hit that carries no permission object is a row rather than a refusal, because unproven push access is not inaccessibility; a malformed entry naming no clonable `owner/name` is never rendered, and an organization that requires single sign-on is named as such instead of appearing as an empty list.
- **Search bounds and partial results:** Search queries are bounded by GitHub's 1,000-result API limit. When a query exceeds the cap or when GitHub returns partial results due to a query timeout (`incomplete_results`), the dialog renders an inline warning banner explaining that partial results are shown and prompting the user to refine their query. An empty repository is labelled only when it has no default branch or has no commits pushed, distinguishing it from small non-empty repositories whose size rounds to 0 KB.
- **Clone form:** Destination folder, folder name, HTTPS/SSH, and shallow clone are one section. The folder is chosen with the platform picker; the renderer never composes a filesystem path. Selecting a repository proposes its name as the folder name, which stays editable.
- **Command equivalence:** Before anything is written, the exact `git clone` and `gh repo clone` commands are shown as copyable monospace text on the inset surface, each with its own label and copy control that confirms in place. The text is produced by the main process, so the copy is the command a clone runs, not a parallel construction. The commands are not a second way to clone; the primary button remains the only dispatch.
- **Clipboard feedback:** Copy confirmation belongs to the exact command displayed. A changed command is not marked copied; a refused clipboard write shows a visible explanation and leaves the command selectable for manual copying.
- **Refusals and commit point:** The single commit point of a clone is its promotion, one atomic rename that refuses to replace an existing destination; everything before it is reversible and nothing after it is undone, and no step anywhere in the app renames over, replaces, or removes a destination another program owns. A single-sign-on denial, a signed-out credential, an unauthenticated search, an occupied destination (an empty or populated folder, a file, a symlink), an unreachable remote, a system with no no-replace rename, and a cancellation before the commit point each name what happened and the next step in the surface where the action was taken; a system or filesystem that cannot offer that atomicity is refused rather than served with a check-then-rename. A cancellation or failure before the commit point leaves no registered repository and no folder: only the staging folder carrying that clone's random token is discarded, and the dialog never reports a repository it did not finish. A cancellation after the commit point completes the registration and reports the finished clone instead, so recents and the active repository never name a folder the request removed.
- **Escape and interruption:** Escape and a backdrop click cannot abandon a running clone. The dialog offers an explicit Cancel that aborts the request, matching the rule that explicit Cancel is distinct from aborting Git. Changing a field never discards a running clone.
- **Environment facts:** Commit identity, default branch, HTTPS credential helper, and `ssh` availability are read-only `OperationFacts`. A missing identity, a missing credential helper, and a missing `ssh` client are each named explicitly. The app never offers to configure them, because onboarding must not write a Git setting the user did not choose.
- **Dropped folders:** A dropped folder is added only while no repository is open and no operation is running. A drop is never silent: it adopts the repository exactly as the picker would, and the person can switch back through the recents.

### Command Palette and Shortcuts

- **Command Palette:** Fixed workbench overlay at `component.overlay` elevation, combobox with listbox semantics, full keyboard navigation in the same order as visually grouped results (arrows, home/end, Enter, Escape), and screen-reader status announcements. Empty search groups commands by workspace area; active search preserves relevance order. Local branches, pull requests, open GitHub issues, and recent repositories are searchable alongside actions.
- **Unavailable commands:** Keep the command name and its reason readable at normal contrast. The reason wraps below the command instead of competing with its identity on one clipped line; arrow-key selection remains visible without enabling the action.
- **Search Separation:** In-view search/filter fields retain distinct focused shortcuts (`/` default) and are not conflated with the global command palette (`Mod+K` default). Printable symbols match their character on keyboard layouts that require Shift; shifted letters remain distinct. Bare printable palette remaps never intercept typing in editable fields, including palette search; modified openers remain available there. A keystroke a focused control has already handled never triggers a global shortcut, so the open palette keeps the keys it consumes.
- **Remappable Shortcuts:** Configurable keybindings for palette opening, view navigation, and stack commands with collision detection before assignment; each displayed shortcut names the action it dispatches. A literal plus key is recorded as `Plus` so separators cannot consume it. The platform's non-primary Command/Control modifier is unsupported: recording shows a reason instead of silently assigning a different shortcut. Holding an opener only toggles once. The opener cannot take an unmodified Enter, arrow, Home, End, or Escape: those keys stay with the open palette, and recording names the palette role instead of assigning the key. Named keys resolve to one canonical spelling, so `Home` and `home` (or `F5` and `f5`) are the same keystroke for assignment, collision, reservation, and dispatch; a rehydrated map never leaves two actions on one key. The `kbd` label keeps the platform's drawn glyphs, while `aria-keyshortcuts` carries the standardized `Meta`/`Control`/`Alt`/`Shift` key tokens for the platform the chord dispatches on.
- **Safe Execution:** Selection never mutates or checks out. Destructive actions require distinct intentional confirmation, not auto-repeat; IME confirmation/navigation never activates palette commands. Dialogs keep exclusive focus and preserve authored drafts. Palette-to-dialog close returns to the original opener. Qualified identities and main-owned captured previews decide scope; display names, readiness badges and repository focus do not grant mutation authority. No implicit stash or checkout.

### Hover Cards and Tooltips

- **Hover card:** Solid overlay, retained item radius, modest transient elevation, 16px padding, and popover z-index 70.
- **Delayed opening:** A repository hover card opens only while its trigger is hovered or contains focus. A pending timer must not reopen it after navigation or a dialog has taken the interaction.
- **Tooltip:** Neutral inverse surface and text, retained control radius, 8px/12px padding, and modest transient elevation at popover z-index 70. Open content has the tooltip role and is associated with its trigger through `aria-describedby`; Escape dismisses it without moving focus. Essential labels and error text never depend on a tooltip.

### Git and Diff States

Checked-out, selected, pull-request lifecycle, checks, review, requires-restack, unknown, and diff states use the semantic/component roles in `tokens.json`. The state is represented by text/icon/color together; unknown and unavailable remain explicit. Diff addition, deletion, and hunk excerpts use their separate text and surface roles.

Every status, lifecycle, checks, review, restack, capability, and diff state carries a text label in addition to its colour and icon. Colour never carries meaning by itself, and an unavailable or unreported value is stated as such.

### Repository compatibility

Diagnostics labels each repository shape supported, limited or unsupported. Restricted actions retain specific readable reasons at their trigger and confirmation gate. Bare and detached worktrees allow truthful read-only inspection without inventing an owning branch. Linked worktrees share metadata without taking over another directory's branch. Submodule rows show the recorded commit; sparse paths outside the working set are not deleted. Identify Git LFS pointers without claiming independent object transfer. Development mutations and stash editing are outside the workbench; never silently convert storage or rewrite configuration to enable an operation.

When an LFS pointer is visible in the file inspector, show its object ID and size alongside an explicit distinction between pointer metadata and object content; do not imply that local object availability was checked. Git LFS's own client and hooks, not the inspector or push-status text, own object transfer.

### Renderer integration and safety

Preserve the local-first Electron sandbox, context isolation, typed preload/IPC boundary, and production Content-Security-Policy. Visual migrations must not change Git semantics, preview/confirmation/busy locks, typed confirmations, or navigation behavior.

### GitHub transport

All GitHub access runs in the main process through one typed transport (`apps/desktop/src/main/github-transport.ts`) that owns the API version, pagination, rate-limit metadata, timeouts, and cancellation, and reports typed failures instead of raw CLI text. Use its CLI adapter under the [Provider CLI authentication](#provider-cli-authentication) rules. The renderer receives domain data and sanitized authentication status, never a token, raw HTTP, or arbitrary command capability.

GitHub-native stacks use the preview REST stack resource as submitted membership/order/base authority, shown as source-qualified relationship facts in Branches and inspection. Validate same-repository heads and bottom-to-top base/head continuity before submission, then reload membership from GitHub rather than PR body links or local parent configuration. Every create, extend and no-write publication revalidates PR identity, head OID, base, state and membership at the mutation boundary. Registration is confirmed only for an open valid stack with the published members/order/head commits. A concurrent change fails explicitly; no UI claims atomic GitHub read-modify-write. Preserve recorded local intent as a recovery hint while remote base catches up. Confirmed absence of a preview endpoint is a capability limitation, not an empty native stack; auth, rate-limit, timeout and server failures remain unconfirmed actionable states.
Extending a partially registered stack revalidates already-registered published pull requests against their captured head commit, base, repository, state, and stack membership before appending missing members; checking only the new pull requests cannot detect a concurrently changed predecessor. A resumed extension stays bound to the saved native stack number: that stack must remain open and retain its captured submitted members. Moving those members into another valid listed stack is not approval to extend or report success for the replacement, even when no append is needed.

Submission recovery preserves the approval's identity: a recorded PR number cannot be replaced by another PR on the same branch, and a retarget may proceed only from its reviewed original base or finish idempotently at its intended base. Before a retarget PATCH, the recorded PR identity, repository, head OID, and local and remote tips are revalidated against the saved approval. Matching PRs or native stacks are recoverable as this submission's own work only after a create request was initiated with an uncertain outcome; planning creation or a definitive rejection grants no ownership. HTTP client rejections clear the respective create intent, while timeouts and server/transport failures retain lost-response recovery.

Before a new PR creation POST, both the local branch and its remote tip must still equal the captured publication OID, including on retries that skip an already-completed push. A ready or draft PR must not be created for a moved branch and rejected only at later stack registration. Recovering an already-accepted creation does not repeat the POST: before persisting adoption or advancing later layers, its PR head OID and both branch tips must match the journalled commit. GitHub owner/repository identity is compared case-insensitively, without relaxing branch, PR number, state, or OID checks.

A successful PR creation response also requires head-OID and local/remote-tip proof on readback before its step completes or later layers run; the returned PR number remains journalled if that proof fails, so recovery cannot duplicate it. An idempotent push whose remote already holds the reviewed commit still installs origin tracking through the locked push path, without issuing another remote push.

Merging a pull request uses GitHub's asynchronous merge API, `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async`, which is the documented endpoint for stacked pull requests; the synchronous merge endpoint is never used for one. The request carries the reviewed head as `sha` plus a `merge_action` (`default`, `direct_merge`, or `merge_queue`), and `merge_method` only for a direct merge, because a queued merge runs the repository's own settings. A `202` answers `pending` with `details.uuid`, which is polled at `GET .../merge-async/{uuid}` until the documented terminal state (`merged` with its merge commit OID, `enqueued`, or `failed` with GitHub's message). A `409` returns the UUID and options of the request GitHub already holds; it is adopted only when it is the reviewed head and the chosen action, and never duplicated. Ruleset, required-review, and check failures are reported from that message rather than guessed at. Every layer's head OID is re-read at the mutation boundary and sent as `sha`, so a head pushed since the review cancels the request instead of landing commits nobody saw.

One merge action covers the contiguous unmerged run at and below the selected pull request, and the preview names exactly those layers. A GitHub-native stack is landed by a single request for its top pull request, so every downstack layer is part of that request's outcome; a locally chained stack has nothing linking its pull requests, so each layer is merged from its own request, bottom-to-top, and a request's outcome is reported only for the layers that request actually carried. Submitted membership is re-read at the mutation boundary in both directions, never taken from the preview: a pull request inserted below the selection would otherwise be landed by GitHub unreviewed, a removed one would leave the reviewed downstack unmerged, and a locally reviewed pull request attached to a native stack would silently switch to stack semantics and land whatever joined it, so a stack whose number, base, open state, or downstack membership moved — or that a locally reviewed pull request has joined — is refused with the difference named. After the run, origin tracking refs are fetched and the remaining pull requests are re-read: bases GitHub retargeted are reported, and no local branch is deleted, retargeted, or checked out. Every layer a request was accepted for is read back afterwards, whatever the aggregate result was, so a group GitHub partly landed before failing is reported as partly merged.

A terminal `enqueued` result records acceptance, not current queue membership. Journal accepted requests against their base ref, with the UUID when provided or the terminal result alone when omitted. Membership itself is read from GitHub's own answer for that pull request — `isMergeQueueEnabled` for the base ref's capability, `isInMergeQueue`, and `mergeQueueEntry { position state enqueuedAt }` — in one narrow host-bound GraphQL query, so a request never borrows another host's schema or a field this build guessed. A pull request the queue holds is reported as queued, with the place and state GitHub names; one it no longer holds is reported as dropped, whether it was ejected or closed without merging. Merged and closed outrank membership, and an answer for a different head or base is fenced off rather than applied, because it describes another request. Never label an open pull request as still queued on the strength of its earlier enqueue, and never label it dropped because a read failed: a schema without those fields, a denied credential, an unreadable payload, and a dropped connection are all membership unknown, so the last membership a read confirmed is kept and labelled as not re-read. Offer queue delivery for a base ref when GitHub reports a queue for it — which makes it available on the first merge, before this repository has enqueued anything — or when an accepted enqueue supplies that evidence; otherwise offer direct merge or repository default. Retain UUID-less terminal outcomes and their base refs without inventing or polling a request identity.

Polling a request is bounded, so a merge GitHub is still running does not end as a finished run. The request itself is a journalled state machine, not a message: the moment GitHub accepts a request, every pull request it covers records the request's identity — the UUID and the pull request whose endpoint serves that result — with outcome `pending`, before the first read of it. A transport error, a crash, or a restart during polling therefore still leaves the request readable, and one result is read once, from the endpoint that owns it, and applied to every layer it covered. Terminal outcomes replace that pending state in the journal, so a reopened dialog reports what GitHub said (`merged`, `enqueued`, or `failed` with its message) even after the result has expired from the 24-hour endpoint. An accepted enqueue is journalled separately from the request outcome, because that enqueue is the only evidence a base ref has a merge queue; a direct merge that merely exceeds the polling bound is not, and offers no queue delivery. A layer the run never asked for is reported as `not-requested` rather than `not-merged`.

Journal the pull-request lifecycle confirmed by each read, together with the queue membership confirmed for that same head and base. Those confirmations outrank the earlier request result: a refresh that cannot reach GitHub preserves the last confirmed outcome and labels it as unconfirmed by the current read. Build one effective observation per layer from the request result, enqueue evidence, confirmed lifecycle, and confirmed membership, and use that same observation for persistence and presentation.

`getMergeStatus` is the read-only half of all of this: it reads the journal, the pull requests, and any pending request's own endpoint, reconciles what GitHub published, and never submits a merge. The dialog reads it when it opens, whenever a run reports progress, and whenever a run returns — a read is newer than the progress that run pushed, so the run's own panel is what a person sees while it is in flight and the read-back is what they see afterwards. The read control lives outside the form fieldset for the same reason: a finished run locks everything that dispatches, and asking GitHub what it did is not a dispatch. A read that fails keeps the last result GitHub published and says the read failed, because a transport error is not evidence that the request or the queue changed. A refusal GitHub already reported is read back as a failed operation carrying its reason, never as an unmerged layer or as a run that changed nothing, so a reopened dialog cannot present a ruleset or required-review refusal as a finished merge. The running merge's own progress arrives through the narrow progress channel the publish flow uses, because a merge waits on GitHub's background result and a read would queue behind the action itself.

### Live local and remote freshness

Many worktrees remain observable simultaneously. Common metadata and per-worktree changes schedule bounded, debounced local reads, prioritizing visible and selected contexts while retaining background observations. Report moved, replaced, missing, locked and unreadable directories explicitly, and retire late reads by qualified authority. Filesystem observations never establish external-tool liveness.

Selection and repository navigation retire obsolete view reads, not active operations. Mutations use main-owned common-directory/ref/worktree authority and revalidate captured state; independent clones and unrelated worktrees retain separate authority. In-flight operations and journals remain reachable after switching inspection context. Shared-metadata mutation restrictions never become a global checked-out-repository toolbar.

`apps/desktop/src/main/sync-coordinator.ts` owns cadence. A filesystem event reads local Git immediately and spends a GitHub request only when the remote read is due, so commits, branch switches, and ref updates from a terminal appear without a manual refresh. Focused and visible windows read on a short interval; hidden or unfocused windows fall back to a slow inbox and repository refresh. Failures back off exponentially, a secondary rate limit parks only the nonessential tier until a retry window passes, low remaining budget parks it too, and rejected credentials stop polling until the person refreshes. A person's own refresh overlaps the automatic read already running, so only the newest refresh publishes: an older answer that settles later never overwrites fresher data.

An issue read is a second answer with its own outcome. A pull-request answer never confirms the inbox, so a failed issue read keeps the last confirmed issues and states why they are unconfirmed instead of showing an apparently empty inbox. Only a confirmed pull-request refresh reports that data fresh: recovering the inbox lifts a rate-limit park without claiming the pull requests on screen were checked.

Responses are read conditionally where GitHub supports it: the transport stores the ETag or Last-Modified validator with the body and replays the stored body on a 304. Only a display read opts in — the native stacks capability the snapshot asks GitHub about on every interval, which is a question about the repository rather than one request's identity — and the GraphQL polls carry no validator because the GraphQL endpoint offers none. Cached data is presentation only — mutation identity checks (review submission, publish, force-push) always read GitHub live. A high-impact mutation whose answer was lost is never replayed on reconnect: it is listed with the reason, stays until dismissed, and every refresh path is read-only. Offline keeps local Git fully usable and states the last confirmed remote data and its age in words as well as colour.

### Pull request checks

The row badge and the inspector badge stay compact aggregates: GitHub's own `statusCheckRollup` read through the shared state vocabulary in `packages/shared/src/pull-request-checks.ts`, never a second stored value. The inspector drill-down behind that badge is the authority. `getPullRequestChecks` reads check runs, the combined commit status, and Actions workflow runs for the pull request's own head, each read only when the repository can answer it, and merges an Actions run GitHub also reported as a check run into one check so a failing job is not listed twice. A required context GitHub has not reported is listed as a real expected check in `waiting` rather than as an absent check. Requirement comes from branch protection's required contexts and the repository's required workflows; it is not inferred from passing checks alone.

Freshness is part of the report, never implied. A report GitHub confirmed in this read reads as current; one served from the last good read is labelled cached or stale with its age, the reason the refresh failed, and the next attempt time, and a stale report is never presented as the current state of the head. A moved head discards the remembered report rather than showing the previous head's checks. Any call that will read from GitHub proves the pull request's current head and base for itself, because the values the renderer carries are what its list showed a moment ago; the caller's head and base are used only where nothing is read, and those results are already labelled a cache or a wait. A second read inside the minimum interval reuses the last report unless the caller forces a refresh; a forced read still backs off when GitHub refuses or rate-limits, keeping the last good report stale rather than clearing it. Watch is the same conditional read on an interval while the panel is open, and the main process still decides whether a read is due.

Rerun is offered only where the read proves it is allowed: Actions must be enabled and the authenticated account must have a write role on the repository. `rerunPullRequestCheck` re-reads the head, refuses a run that no longer belongs to it, posts the rerun, and returns the re-read report so the panel never shows a state it did not just read. Details links are opened only for plain `https://github.com` URLs; an unvetted link from a third-party app is dropped rather than offered.

Identity, not payload, authorises a mutation. A rerun first re-reads the pull request itself and compares GitHub's current head with the head the button was drawn for; a head that moved since is refused with nothing posted, because the user acted on a different commit than the one GitHub holds. A read that could not confirm which head the pull request has may still show the last good report, but reports it stale and offers no rerun: an unproved head cannot authorise a write.

Policy is re-read on every path, including the path where every payload answers 304. Required checks come from branch protection and from the effective rules GitHub reports for the exact base branch, which is how repository and organisation rulesets are read without reimplementing GitHub's branch-pattern matching. Every applicable required check is its own `(context, app)` constraint rather than one requirement per name: GitHub enforces all applicable rules and the most restrictive wins, so a context required by two integrations is two requirements, and a requirement that names no app does not loosen one that does. A required set GitHub will not fully disclose - an unreadable ruleset read, a branch whose protection this account cannot read - leaves every requirement `unknown` and says so, because a check no readable API mentions may still gate the merge; that unknown answer stands even when no check has reported at all, since a head whose required checks are still silent is exactly when it matters. A 404 from branch protection is only an answer for a viewer GitHub reports as an administrator, because that status means both an unprotected branch and a protection the token may not read. A retargeted base or a withdrawn role therefore changes the report even when not one check result moved.

List reads are complete within a bound, and each page carries its own validator. A resource is followed page by page until GitHub returns a short page; a head with more pages than the bound follows reports truncation and the panel says the list is not the whole, on every path that ends at a full page at the bound, including a page GitHub confirmed, while a list whose last page is short is complete however many pages it took. A page's 304 speaks only for that page, because page two can gain a failing check while page one's validator is unchanged, so a collection counts as confirmed only when every page asked about confirmed itself. A validator is kept only while its page's body is cached, and a page GitHub confirms whose body is gone is re-read rather than dropped from a live report.

Every request a call makes is subject to the same rules, the read that proves which head the pull request has included: when GitHub refuses that read the call stops there instead of going on to ask for the commit's checks, keeps the last good report with the rerun held back, and records the same deadline it would for any other refusal. Rate limits are the server's to set. A refused or rate-limited read waits at least as long as GitHub's own `Retry-After` or primary-limit reset, never only for the local backoff, and that deadline is kept even when the read never produced a report to cache, so the next refresh and every watch tick after it respect it. A read the caller abandons stops instead of finishing work nobody is waiting for.

### Pull requests and cross-repository attention

Pull requests is a separate repository list and full review surface, not another lane graph or a development destination. Needs attention aggregates source-backed PR/Git work across registered repositories; Activity reports observed events. Existing queue grouping/filtering logic may supply these views without requiring a separate PR Inbox destination or a second navigation rail. Rows preserve repository-qualified identity, unknown account/membership state and independent lifecycle/check/review facts.

A row puts title and repository-qualified pull-request identity first, then author and branch context. Updated time, changed-line count, native-stack position and unresolved-thread count use compact, aligned fields; lifecycle, checks and review remain independently labelled states rather than a single readiness badge. Long titles wrap, and narrow desktop layouts reflow metadata beneath the identity without horizontal scrolling. Confirmed zero is a count, not an absence. Unknown, unsupported and stale counts name their reason; a truncated unresolved-thread count states that it is a lower bound, never a complete count. Optional count fields must not remove the facts that establish the six built-in groups when a host refuses those fields.

Opening a row lands in that row's own repository's Review workspace for that pull request, without checking anything out or changing branches. While one repository is opening, no row is activatable, so a selection somebody just made is never replaced by an earlier asynchronous open landing after it.

The rows are one composite widget with a single Tab stop, roving `tabindex`, arrows that stop at both ends, Home and End, and Enter to open. Search is a labelled text field where every whitespace-separated term must match text the row already shows. Structured criteria are deliberately bounded: exact repositories, authors, directly requested reviewers, lifecycle/draft, review decisions, check rollups and changed-line bounds combine with AND across fields and OR within a field; absent fields do not constrain. Criteria controls may collapse, but the selected criteria, matching count, unavailable-fact exclusions and Clear filters action stay visible. An unavailable fact cannot satisfy a requested condition, including a zero bound. Updated-time and change-size sorts put unavailable facts last and break ties by host, repository and PR number.

A saved view retains its name, identity, complete criteria and chosen sort. Restoring it restores the same question, and clearing returns to the unchanged built-in group semantics. Legacy single-repository views retain their names, IDs and exact membership when migrated. The save row's label names the name input itself, not the wrapper it shares with Save; persistence controls remain locked until the current stored-list read has completed, including a reread with an older cached answer, and while a replacement is pending. On narrow windows the group rail is bounded and independently scrollable so groups and saved views cannot displace the work queue.

The queue keeps "nothing to do" and "no answer" apart. Empty, filtered-empty, unconfirmed, retired, partial, degraded, membership-unknown, failed, skipped, auth-required, rate-limited, and offline are different states, each with its own notice, and the notice's own heading is what the destination shows so no two states read alike; a read that read nothing says which failure it was and names the repositories it applies to rather than collapsing every failure into one generic notice. A read that answered with less than it asked for is never counted as a complete one, whether what is missing is the review and check metadata or the account the rows belong to: a membership-unknown read places a pull request in no viewer-relative group, because authorship and a request to the viewer are undecided rather than false, and it says which repository it could not name an account for rather than quietly listing less work. A read that was attempted and answered with something no verdict can be read from is a failure with the host's own reason attached, never a repository that was not attempted. A notice never blames the person for a read that ended: it says what happened to the read, and never claims a sign-out, a lost connection, or a queue that was never read.

Rows belong to one identity. The account, its credential, and the selected host decide whose queue is on screen, and a change at that boundary ends the read still running for the previous identity and drops its rows rather than showing them until a refresh can answer for the new one. Keeping the last confirmed rows is for a read that could not answer under the identity that confirmed them, so a read that was ended is not one of those: it carries no rows, no repositories, and no login at all, and it is reported as a queue rather than raised as a failure, because a failure the destination would answer by keeping its rows is exactly wrong here. An ended read cannot reach past its own identity: rows a newer read has already confirmed under the credential that replaced it stay on screen. Registered clones and worktrees of one remote are one repository in the queue: read once, counted once, and opened through one deterministic local path.

### Reconciliation

GitHub owns submitted membership and order. `apps/desktop/src/main/reconciliation.ts` derives one deterministic state per stack by comparing that authority with local parent hints, pull-request head/base refs and SHAs, origin tracking refs, and real Git ancestry. The states are `matching`, `local-only`, `remote-native`, `reordered`, `stale`, `diverged`, `missing-branch`, `retargeted`, `merged`, `externally-unstacked`, and `ambiguous`; `ambiguous` blocks instead of guessing and never offers a repair. Every other state lists explicit repairs with the evidence each one would act on. Reporting and refresh only read: they never rewrite a branch, a parent hint, or a pull-request base. Repairs execute from a captured preview whose plan is re-validated against the origin URL, submitted stack, local branch tips, and uncommitted edits at the mutation boundary; a changed base, head, or dirty tree aborts the write with no change applied.

Branches and inspection disclose reconciliation in a keyboard-scrollable, bounded region; native and local-only reports remain reachable through source-qualified facts and scoped workflows, not a standalone Stacks destination. Repair choices are keyed to individual preview operations rather than repair kinds: selecting one of several branches with the same repair kind mutates only the selected branch. A checked-out branch cannot be silently moved to a submitted or remote tip; a destructive repair must leave its prior ref and recovery journal available.

A missing submitted or recorded parent is an ambiguity blocker, never inferred as matching ancestry; the native report follows local parent links transitively so multiple unstacked descendants remain visible with their own explicit repairs. A failed repair presents the backend's actionable refusal inside the focused dialog, not only in the global banner behind it.

An unfetched submitted head is likewise ambiguous; a known submitted head strictly ahead of the local branch is stale even when its origin tracking ref lags, and moving the branch requires an explicit backed-up repair. Local-only reports include one-member roots and all sibling descendants without treating separate branches based on the default branch as one stack. After GitHub revalidation, each parent-hint write checks the captured branch tip and hint again at the mutation boundary so a concurrent local edit cannot be overwritten.

Selected branch restorations and tip moves settle before parent-hint adoption; when no valid recorded ownership boundary exists, an inferred boundary is measured against the resulting parent and child refs, not a stale origin tracking ref. A member moved to another native stack remains visible in its former stack's report, but only the destination stack offers repairs to that member's parent hint; the former stack cannot clear a valid descendant hint. When merged predecessors are re-rooted onto their old base, adoption considers the immediately submitted predecessor, never an earlier merged member merely named by a stale local hint. It preserves the recorded replay boundary only when it equals that predecessor's submitted head, its canonical merge commit is reachable from the base, and the boundary remains an ancestor of the child. A newer boundary may include unmerged commits, so any unproven boundary withholds the repair for explicit inspection instead of replaying or dropping work.
Selecting only some parent-order repairs is checked against the resulting local parent graph before any write; a subset that would create a cycle is rejected without consuming the preview, so the dependent order repairs can be selected together.
An ordinary reordered member keeps its valid recorded replay boundary even when its new parent is already ahead of the child; replacing that boundary with the new parent's merge-base would change commit ownership during restack. A missing or invalid boundary with an existing recorded parent withholds adoption, and selected ref moves recheck that the retained boundary still belongs to the child before writing metadata.
For submitted native members, reconciliation binds the canonical pull request by the stack's PR number, not by the branch head: another open PR can share that head. If that numbered PR now identifies a different head or repository, the native stack is ambiguous and offers no repair; closed or merged members missing from the open-PR query retain their submitted stack identity.
Adopt-order previews capture the exact resolved parent ref and commit used for the replay boundary. A changed, removed, or differently resolved parent invalidates the preview before any write; the selected parent is checked again at the mutation boundary, accounting for selected ref moves. Restoring a missing branch refuses to update a symbolic HEAD in the current or another worktree.

### Review workspace

Review is the single read destination for repository PR rows, Inbox rows, stack PR links, inspector Review actions, and palette navigation. Management is explicit and secondary. Reading never checks out a branch or dispatches a Git or remote mutation; captured previews and confirmation gates remain separate actions.

Code owns the body by default. Description and readonly reviewer/readiness context, complete check details, commits, and conversation are keyboard-reachable contextual panes. Wide workspaces show selected context beside code; constrained workspaces switch the body rather than divide its height into thin strips. Context stays mounted so toggling it preserves file, layout, whitespace, comparison, line range, local scroll position, and unsent text. Returning to Code is always an explicit visible control.

Review entry captures a qualified return destination, not a second inspector. The origin's actual identity, filter/query, folds/path, local scroll, and meaningful focus survive readonly navigation; the qualified Review composition remains mounted independently across sidebar destinations. Same-owner pending reads do not erase the current pane, selected line or original composition. Host/origin/credential/account replacement retires incompatible ephemeral state rather than restoring another authority's selection. Structured-operation busy states may defer file presentation changes, never live head/base warnings or submission freezes.

Unsent words keep their original comparison. A saved-version conflict preserves the latest local text and blocks submission; it never silently adopts newer saved work or retries a full-set save. The explicit discard control names that it will replace these local edits with saved drafts. Accepted empty sets remain authoritative deletion barriers. Confirmation removes only the exact submitted authored version at its original comparison, never newer words, references, or comparison context.

An account or origin boundary hides private text without deleting its owner's journal or unresolved local edit. A confirmed outcome from an already-dispatched operation stays with its captured owner even after that boundary; a replacement account sees neither its private body nor its history. Older unqualified draft and uncertainty records are visibly unattributed, explicit read-only text recovery only: showing words restores no anchors, account identity, submission receipt, or send action.


Use one compact PR headline with a keyboard-accessible full-title disclosure, a collapsed full-stack disclosure, and a collapsed comparison disclosure whose summary names the actual current or historical endpoint. Retained historical hunks must not acquire a newly observed endpoint's label or unchanged files before that comparison arrives. Historical submission warnings remain outside the disclosure and visible in every pane. Review quiets persistent local-Git controls while preserving the palette and local-work destinations. At desktop zoom, the shell, navigation, and reading regions stay bounded with local scrolling; expanding context never makes code a one-line strip.
In short viewports, the workbench itself scrolls locally to expose the reading
area without shrinking it to a strip. Its header and contextual controls remain
reachable by scrolling or keyboard focus; the document does not grow.

All displayed data and actions belong to the repository, host, credential authority, PR, and comparison being viewed. Changing that identity retires in-flight reads and removes the old answers before replacements arrive. Missing or partial checks/reviewers remain explicitly unknown or incomplete. A review on a prior or unknown head is labelled as such, never presented as current-head approval. Description is plain sanitized text, never interpreted as HTML.

Pull-request files, commits, and the stack are separate reads that each claim their own request id, so moving to another pull request cancels the read that is now obsolete instead of letting it answer for a pull request nobody is looking at. The headline answers first, then files and commits; a stage that has not arrived renders a loading state and never an empty state that reads as "nothing to review".

A paginated read is pinned to one comparison. The identity of the comparison is read before the pages and again after them, and it covers **both** objects: GitHub diffs the head against the merge base of the base and head, so a push to the base branch changes the diff as surely as a force-push to the head does, with the head object unchanged. If either moved, or if the head could not be read at all, the read fails instead of returning. Half-old, half-new pages labelled with either oid would assert a revision the diff never came from, and viewed marks and any comment written afterwards would inherit the false claim. The commit list is pinned the same way, because a moved head mid-read otherwise leaves a silently short list presented as the pull request's commits. The headline is read first, so its oid can be the out-of-date one; when it disagrees with the pinned file set, the headline says the head is as of the headline rather than presenting it as the revision on screen.

The commit count distinguishes the loaded entries from the pull request's reported total. An incomplete result displays that state next to the list and directs the reviewer to GitHub for the full history. At GitHub's 250-entry cap without a known total, the list says it may be incomplete; an exact confirmed total is not presented as truncation.

Each file has exactly one state when it has no text to show: **binary** only when independently identified, **no text diff** when GitHub supplies no patch and counts no changed text lines, **too large to inline**, or **unreadable** with the reason. Missing text is not evidence of binary content: a pure rename, mode-only change, or empty file can have the same shape. A renamed file's message names the rename. "Generated" is a local path heuristic offered as a reading aid; it never changes what is rendered and is never presented as something GitHub reported.

The file tree groups by directory and keeps a renamed file's preimage path searchable, so a search for the old name still finds the file it became. A collapsed directory keeps its file count, because a row must not change what it claims to hold. Files with no text diff are selectable so their state is readable; they never present an empty patch.

Unified and split are two presentations of one set of lines. The whitespace toggle is a filter over text GitHub already sent, not a second fetch: it hides only a removed/added pair that is identical once spaces and tabs are removed, reports the hidden count against Git's own hunk header so a reader can check it, and leaves line endings alone because a CRLF conversion is a change worth seeing. Split pairs a changed run by position, so a run with more removals than additions leaves the extra removals on their own rows instead of shifting content against the wrong line. A run of only removals or only additions has no counterpart to pair against and is a complete change on its own, so it is presented whole, one row per line: a pure addition file of any length is the review, and truncating it to its first line would present a hundred added lines as one. Every hunk header introduces the lines of its own hunk, so the second and later headers of a multi-hunk file appear directly above their lines rather than being collected at the top of the file. Both layouts render through the same paged window, so a large diff stays bounded and every page keeps the same line identity.

**Diff line identity.** Every line of a remote diff carries four things: its `side` (`base`, `head`, or none for a marker), its number on that side, an `anchor` that is the file path plus the line's text with its diff marker removed, and a `context` that is the anchor plus up to two neighbouring lines of the same hunk on each side. A number is an address, not an identity: a force-push that inserts a line above moves every line below it. A hunk reuses the same `hunkId` scheme as the local staging surface, so one scheme covers a remote review and a local stage. A line is identified only against the side it is addressed on. A removed line and an added line carrying the same text are two different facts, and matching across the side would re-anchor a comment on a deletion onto the line that replaced it, reading as though the reviewer had commented on the replacement. Identical text found only on the other side is reported as the change it is — the file no longer holds this line on that side, and the same text now appears on the other — and never resolved. A stored reference is re-resolved by anchor first: intact anchor and context is **exact**, a single intact anchor with a changed neighbourhood is **moved** and says where it went, and edited text, a duplicated line, a file the pull request no longer touches, or a diff that is not available as text is **unresolved** with a reason a reviewer can act on. Anything that cannot be named exactly is never written as if it were.

Duplicate same-side anchors always remain unresolved, even when only one copy retains the old neighbourhood. Context distinguishes exact from moved only after uniqueness is established.

The rail states the viewed pull request's position and exposes every returned native member in submitted order, with connected rows, direct readonly selection, and retained adjacent-layer commands. Its bounded disclosure opens at the viewed member, which is the initial single Tab stop; unmodified arrows and Home/End move focus and reveal rows, and Enter/Space opens that PR. Long titles and independent lifecycle, draft, checks, and review facts reflow locally. Known native lifecycle and draft values survive missing optional enrichment fields.

Membership and metadata are separate claims. A partial membership names its loaded count against the reported stack size; bounded metadata never truncates the submitted order. Missing or unpinned readiness remains unknown, and metadata whose head disagrees with either known native membership or the viewed PR is stale. Stack endpoints are boundaries, not missing data. No membership, unavailable membership, local-only relationships, and stale or unavailable metadata have distinct explanations.

Blocker disclosure identifies actual local parent comparisons and reconciliation evidence. Red checks, merged labels, inferred ancestry, and unavailable comparisons do not establish a restack requirement. Branches, inspection and scoped review workflows keep repository-wide submitted membership reachable without local feature branches, distinct from local children-above-parents order. Compact local rows disclose full branch names, parent provenance, and landing details; Restack, Publish, repair, and Merge continue through their existing captured previews.

Viewed files are a local reading aid bound to the **whole comparison** they were recorded at: the head object, the base object, and the base branch name. A force-push changes the head and a push to the base branch changes the base, so either drops the marks rather than carrying them onto a diff nobody looked at. A retarget is a third case: it can leave both object ids untouched, so the branch name is carried too, and a rename reads the same way. Retargeting is a routine action, not a rare race, and a mark carried across it would claim review of changes nobody opened; the cost is re-opening a few files. GitHub is not asked to store them, and the app never claims to have synced a state GitHub does not expose.

The current-file toolbar exposes explicit viewed/unviewed actions against that
same qualified comparison record. Unviewing changes only the chosen path; it does
not clear other files or certify a replacement head, base, or repository.

**Leaving a review.** The conversation pane holds GitHub's submitted threads,
unsent comments, and the single decision that sends them together. It remains
mounted while another contextual pane is selected, so hiding it never discards
the reviewer's words. A line number is the affordance that
starts a comment: the reviewer points at the lines they mean, and a held
modifier extends the range to a multi-line comment. Nothing asks for a path and
a number that the reviewer would have to read off the screen.
Code stays available while both range endpoints are selected. Opening
Conversation to compose is explicit; selection alone never hides code.

Pending comments are local by necessity, not by preference: GitHub has no
pending-comment resource, so they are journalled in the app's own storage and
restored when the workspace reopens. They are drawn to be visibly unsent — a
pending rule, a pending label, never the styling of something already on GitHub
— and a draft recorded against a comparison that is no longer on screen is shown
as stale rather than re-placed. Restoring them on reopen is the whole point:
navigating to another pull request and back must not cost a reviewer their
unfinished sentence.

One decision submits every pending comment. GitHub's review endpoint takes all
of a review's inline comments in one request, so several comments become one
Comment, Approve, or Request changes event; the alternative, one event per
comment, would be several events the reviewer never chose. The app cannot approve
the viewer's own pull request, and it does not offer the choice it knows GitHub
will refuse. Every other permission is read from GitHub and GitHub stays the
authority: a local permission decision is a preflight, never a substitute for
the server's answer.

An anchor is revalidated in the main process immediately before the write. A
force-push since the draft was taken means some anchors name a revision that no
longer exists, and the result is **no mutation at all** plus a per-draft reason —
never a comment that landed on a neighbouring line or on a different revision
than the one reviewed. Silence about a dropped comment is indistinguishable from
success; an explicit stale report is the only safe outcome.

A surviving anchor is not evidence that the reviewer agreed to a new revision. A
comment's text often still matches after a force-push, having merely moved to a
different line, and adopting that silently would approve a commit nobody opened.
The comparison the diff was rendered from therefore travels with the submission
and is checked against a fresh read **before** the anchors are resolved; a
mismatch on the head, the base, or the base branch name refuses the whole review
and names the revision to look at. Approving is the case this protects most, but
the refusal applies to every decision.

A write whose response is lost is not replayed automatically, because the replay's
most likely outcome is a duplicate review carrying a comment the reviewer never
wrote twice. An error message alone does not enforce that: it disappears on
reload and hands the same words back to a live button. So the attempt itself is
journalled **before** the request leaves — a crash between the POST and its
response is precisely the case with no failure to write a record on, so a record
written only after a failure would be missing for the one case the guard exists
for. The attempt records the whole payload — every comment's body and anchor, and
the decision — because the comments _are_ the write, and any one of them alone
is shared with a review that has nothing to do with this one.

The record is not a dead end. Before refusing, the next attempt asks GitHub what
it actually holds, and every part of the attempt is checked: the review must be
**newer than the boundary the attempt recorded** (the newest review the pull
request held when it began), **this account's**, **on this revision**, recording
**the decision that was asked for**, and carrying **the same comments** compared
as a set on body and anchor. A matching summary proves nothing, so it is not
what is matched on. The state compared is the one GitHub recorded, not the one
that was asked for, so a comment review never adopts an approval.

Those two reads come from REST, not from GraphQL. `PullRequestReviewComment` has
no `side` and no `startSide` in GitHub's schema — the side of a comment is known
only to the thread and to the REST comment — and a query naming a field that does
not exist is refused before it runs, which would make every submission fail at the
first reconciliation. The review list and the pull request's review comments are
therefore read from `pulls/{n}/reviews` and `pulls/{n}/comments`, whose `side`
and `start_side` are `LEFT`/`RIGHT` and are converted to the diff's `base`/`head`
in one place for both ends of a range. A comment left unconverted would be recorded
as a head comment, and a deletion comment could then never be recognised as its
own attempt.

A settled write is recorded, not deleted. The evidence that GitHub holds a
comment is the only thing standing between a retry and a duplicate, and the
submission that recognised the write is still free to fail afterwards, or to be
interrupted before the view drops the draft. The record therefore keeps what was
recognised, and it is a later _payload_ that retires it: the view keeps a draft in
its payload precisely while it has not been told the draft was delivered, so a
record whose comments are absent from a later submission are comments the view has
finished with. That makes resuming after a crash idempotent without depending on a
callback the view may never send, and it means GitHub no longer being able to
re-derive the answer — because the review was edited on the web, say — cannot hold
a write for good.

The boundary is what makes the search honest rather than recent, and it is a
number. REST review ids increase, so the boundary is the greatest id the pull
request held when the attempt began, and a reconciliation walks reviews newest
first and stops at the boundary: everything at or below it pre-existed. The list
of reviews is **chronological**, so that number has to be read off the last page
and not the first: on a pull request with more than a hundred reviews, the
greatest id on page one is the hundredth review ever written, and a review that
already existed — matching the attempt in every field — would sit above that line
and be adopted as a write that never arrived. Both collections are paged in full,
because a review may carry up to 200 inline comments while a page holds 100, and
a review whose tail was never read cannot be compared whole — comparing part of
it would claim a match that was not made. A boundary walk that cannot reach the
end of the list records **no** boundary rather than a low one, and a null boundary
holds: a wrong boundary is worse than an absent one, because it errs in exactly
the direction that adopts somebody else's review. Running out of pages is a hold
rather than a "not there". If GitHub does not hold the review once the search is
exhaustive, the guard stands: the record says only that the app never heard back,
which is also true of a request that never arrived, so absence is never taken as
licence to post again automatically.

The guard is bound to the revision it was written against. A record carries the
head its attempt named, and a record about a different commit is not this
submission's recovery: it is neither delivered nor a hold, and it is retired. A
settled record proves GitHub took that write, and it proves it about that commit.
Review H1 says nothing about H2, and the same line carrying the same words on the
new head is a new comment about a new commit — so adopting across that boundary
would clear the reviewer's unsent work and return a decision they asked for
without ever sending it, silently suppressing an approval of the revision in
front of them. An uncertain record about an older head is left alone for the same
reason: a question GitHub may never answer is a question about that head, and it
must not lock a reviewer out of a new revision.

A draft is named by a minted identity, not by where it sits. The revision guard
above separates a comment about a new head from one about the old, but a
revision does not move for everything: the reviewer can read a line, write a
comment, send it, and write the same words on the same line of the _same_ head
while approving instead of commenting. Nothing about that second comment is
distinguishable from the first except that it is later, and both would be
matched by every field the settlement compares — anchor, words, decision, head.
Adopting the first would clear the second without sending it, and the workspace
would report an approval that GitHub never received. So each draft carries an
identity generated where the draft is composed, and the settlement only looks at
records that name this payload's drafts.

Generated, not counted, and the distinction is the whole rule. A counter is
unique only while one process owns it, and the journal that would hold it is read
by every window of the repository: two windows that opened the same record would
count from the same number, mint one identity for the same line, and then a
settled record naming that identity would answer for the other window's comment —
clearing words it never sent and reporting a decision GitHub never received. So a
draft's identity may not depend on the state any other window last read. It also
may not depend on the record outliving it. An accepted empty record retains only
the saved-version barrier, never an identity counter to read, rewind, or trust.
Identities minted under earlier rules —
the range alone, or the range and a small whole number — remain opaque strings
compared only with each other. A qualified record retains those identities;
an unqualified legacy record remains readable only as unattributed local recovery
text, never as a submission anchor. None of those names can be minted again.

The guard covers an unresolved _comment_, not an attempt id. Changing the
decision, or adding one more pending draft, produces a different attempt over
the same comments, and matching on the whole payload would let those comments be
posted a second time. So every attempt touching any line this payload writes is
reconciled first, whatever decision or batch size is being sent now. What is
journalled is what is sent: the comments GitHub never took, and no more. Sending
the whole payload while recording only the remainder would post the adopted
comment again — the exact duplicate the guard exists to prevent — and leave a
record describing something other than the write. When the write does go out, every
comment it confirms is named back, the adopted ones and the newly posted ones
alike, so the view drops exactly those and keeps the drafts that were never sent.

What a landed review delivers is exactly the comments it posted, each by the
identity it was composed under — and the identity is recorded per comment, not
only per attempt, because a review is only ever evidence about the comments it
was made of. A batch of two that lands unacknowledged and is followed by a
payload carrying one of those comments unchanged and a fresh one written on the
same line with the same words is the case this decides: the first is delivered
because GitHub holds it under that identity, the second is not, because the
review posted a different comment that happened to read identically, and the
record of it is a record about a payload the reviewer has since replaced.
Adopting it would report the whole payload delivered, post nothing, and lose a
decision the reviewer made after the review they had already sent. Delivery is
therefore matched on identity _and_ on what the comment says and where, so a
draft reworded after it was composed sends the new words rather than being
taken for the old ones, and a comment no composition can be named for is
evidence about nothing.

Replies reconcile against the thread's own comments by the same rules, with the
comment ids the thread held when the attempt began as their boundary and this
account as their author. Body equality alone is not enough in either direction:
an older identical reply — this account's own or a collaborator's — is not this
attempt, and adopting it would report a success that never happened.

That record holds the reviewer's own words, so it is scoped by repository and by
account as well as by pull request: the journal lives in a Git common directory
that every origin and worktree shares, a pull request number is only unique
inside one repository, and an attempt id is not unique across accounts. Without
all three, one account's record can block an unrelated review — or be cleared by
one, leaving a duplicate waiting to happen.

Thread topology, replies, and resolved and outdated state come from GraphQL,
which is the only place that knows them; REST review comments are flat and cannot
report a resolved thread. Resolved threads stay visible and marked rather than
disappearing, because a reviewer coming back to a thread needs to see it was
resolved rather than assume it was deleted. Resolved and outdated are independent
facts and both are shown: a later push can produce a thread that is both, and
collapsing them to one word would hide a conversation nobody has answered.

A thread's comments are a connection **inside** the thread, so exhausting the
outer page of threads says nothing about whether a long conversation was read
whole. Each thread's later comment pages are followed, bounded like every other
read, and a thread that runs past the bound says so instead of presenting a
partial reply history as the whole one. That matters beyond display: a
lost-write reconciliation looks for the posted reply in exactly these pages, so
reading only the first is what makes a successful reply look lost.

Files and threads are read independently, and each is pinned to its own
comparison. Both can succeed while describing different revisions, so the two are
compared before a thread is allowed to steer anything: a thread's line number is
an address in the diff it was read at, and following it into a newer diff would
compose a comment onto whatever now sits at that number. A mismatch is shown with
a reload, not resolved by picking a side.

Pending drafts are journalled in the repository's Git directory, so they follow
the repository across worktrees and workspaces. That makes the file a shared
resource and not a boundary: the **record** carries the host-qualified repository
and signed-in viewer, and lookup, replacement, and clearing are scoped by them.
A pull request number is only unique inside one hosted repository; a viewer
login on another host does not establish the same person's identity. The main
process compares a captured owner's host/repository/viewer with live Git and
GitHub authority before accepting drafts or any submission, reply, resolution,
or history clear. Submissions and replies recheck after the journal-lock await,
before transport dispatch. A retained draft identity keeps its original comparison;
neither saving nor submission may replace that comparison with the currently shown diff.
The provider endpoint continues to use its ordinary owner/name, not this local
namespace. Legacy records without a host stay byte-for-byte intact and are never
adopted automatically. Explicit recovery lists original recorded identities
without bodies and reveals text only upon a separate local request; it never
recovers anchors, line positions, selection, uncertain retry, edit, or submission.
Unqualified viewed marks and history cannot certify a qualified current account,
and uncertain legacy writes cannot be attributed or replayed across hosts.
New authored records use separate `git-stacks-review-drafts-qualified.json` and
`git-stacks-review-uncertain-qualified.json` files. Legacy files are read-only;
even unsupported anchors and unknown metadata keep every byte through new saves
and cleanup. Recovery extracts text without validating or adopting those anchors.

Sharing the file makes it a resource more than one process writes, and a
read/modify/write over a shared file is a claim on something no single process
owns: two windows of one app, two worktrees, or two machines on one repository
can read the same bytes and each publish its own change over them. The last
write wins, and the loser's record is not merged away — it is gone, silently,
and it was unsent words.

So a journal update is taken whole, by one writer at a time, across every
process that shares the repository. Where a window cannot take its turn, it
**refuses** the write and says so, and it writes nothing: a journal that cannot
be updated in order has exactly one honest outcome, and the record already on
disk stays readable and unchanged. An in-process queue is not a substitute — it
would serialize two callers in one window and leave the second window exactly as
unprotected, which is the case the journal exists for.

That refusal must be bounded and it must distinguish _why_ the lock could not be
used. Exactly one read failure means the holder is gone: the lock was not there
when the contender looked, so the next attempt takes the name. Every other
failure — a lock this account may not open, a path that is not a file — leaves a
holder whose existence is unknown and cannot become known by waiting, so it
refuses at once, names the file and the reason it could not be read, and writes
nothing. Retrying it is not caution: it spins on a lock that never clears while
the window holds a save that will never finish and reports nothing.

Records are not evicted to keep either file small. A draft record is one pull
request's unsent words and an unresolved write is the sole durable proof that a
request went out; evicting the oldest to make room discards exactly the evidence
that stops a retry from posting a second review, which is worse than a file that
grew. A record leaves only when its owner sends or clears it, when a payload that
no longer carries its comments retires it, or when GitHub's own state settles it.

The renderer treats its own journal read as the older fact it is. Lines can be
selected and commented on as soon as the diff renders, which can be before the
journal read answers, so a draft edit is journalled optimistically and counted;
a read that began before an edit is dropped rather than allowed to replace words
just typed with the snapshot it read, which would then be written back on the
next edit.

The permissions query asks for `viewer` at the query root. GitHub's schema has no
`Repository.viewer`, and a selection that nests it there fails the whole query
with `undefinedField` before any review is written — which is exactly the kind of
error a fixture double accepts happily and a live server rejects. Query shapes
are therefore checked against the live schema, not only against fixtures.

The four review commands — next file, previous file, next layer, previous layer — are remappable like every other command and are dispatched by the shell through a ref the view publishes. The view registers no key listener of its own, so two surfaces never compete for the same keystroke.

### Review update snapshots and historical comparison

A pull request's versions on GitHub are not a complete version control history: GitHub does not maintain permanent version objects for arbitrary force-pushes, and an app that was not running cannot know what commits previously occupied a pull request branch. The review workspace therefore persists observed PR head snapshots with timestamps, observation counts, and review associations, without claiming a complete version history the app never saw.

A snapshot record is scoped strictly by host-qualified repository identity (`host/owner/name`), pull request number, and authenticated viewer login. One account's review must never become another account's anchor. Identical heads observed across repeated reads deduplicate into a single snapshot entry, updating the observation count and last-seen timestamp rather than appending duplicate entries. A force-push or rebase moves the head SHA and creates a new snapshot entry.

When the workspace first opens a pull request that already has multiple commits, it detects that earlier updates occurred before the app ever saw the branch and presents an explicit gap banner stating that earlier revisions were never observed and cannot be compared.

Any observed historical snapshot can be compared against the current pull request head. The "Changes since reviewed" shortcut selects the most recent head the current user actually reviewed or had an adopted review settled for. The comparison faithfully uses GitHub's two-endpoint compare API. When in historical comparison mode, the workspace offers a "Hide unchanged files" filter that excludes files whose contents did not change between the historical snapshot and the current head, allowing reviewers to focus exclusively on what changed since their last review.

Missing historical commits (garbage-collected after force-push or deleted remote branches) and lost merge bases (unrelated histories after an external rebase) produce an explicit unavailable state naming the exact failure reason, with no fabricated fallback diff. In historical comparison mode, draft commenting and review submission are disabled with an explanatory banner, preventing accidental comments on historical revisions.

Snapshot metadata contains strictly object IDs, branch names, timestamps, counts, and review confirmation IDs — zero source code, diffs, or comments. Clearing local history wipes the journal beside the repository with zero GitHub mutations.

A subsequent confirmed or adopted review is a new observation and recreates its anchor after clearing history. Async history reads and clear responses belong to their originating selection; a new comparison clears previous files and totals while it loads.

### Git runtime diagnostics

The advanced Git runtime choice uses a labeled two-way control: **Bundled runtime** and **System Git**. Keep the selected choice visible even if that executable cannot start; pair the failure message with a recovery path so users can reverse the choice without guessing.

Display the active source, version, executable path, minimum-version result, and capability labels as text rather than color alone. If resolution fails, say that the runtime is unavailable instead of showing stale details.

Both runtime choices use the same Git operation guards. Custom `files:` reference-storage paths are decoded as native absolute file paths, including Windows drive letters; a remote host, credentials, query, fragment, malformed escape, or NUL is refused instead of treated as a local lock path. Passing local runtime tests does not establish that a signed Windows or macOS release artifact was produced; signing and shipment remain release-workflow gates.

### Updates

The Updates section states what this build is before it offers anything to do: the installed version, the channel it follows, which key the updater verifies with, and whether this platform is updated in place. A refused build is a stated condition, not a failure to recover from, so it is presented the way the main process reported it.

- **Facts before controls:** The installed version, the channel in use, the key the updater verifies with, and whether this platform is updated in place are read from the update status and are shown before the first control, never below it and never only after a check has run. They hold in every phase, including the phases where nothing can be done, and a control that changes one of them is additional to the fact rather than a substitute for it.
- **Only the possible step:** Each step appears only when it is the step that can actually happen, so a build with no compiled release key, a platform with no install path, and a build with no authenticated offer present nothing to click. A control that is present but unreachable is a dead end with a reason attached; the step is withheld instead.
- **The main process's own reason:** A refusal is shown as the reason main gave, in its terms, rather than softened into a suggestion to retry, refresh, or check the connection. `not-configured`, `unsupported`, `not-newer`, `replayed`, and `bad-signature` are different answers and are never merged into one failure message, and a phase with no outcome is not dressed as success.
- **Progress is progress:** A download in progress reports how far it has got against the size the signed manifest recorded, and stays cancellable while it does. A control that is merely disabled, or a spinner with no state behind it, is not a progress state.

- **Workbench awareness without interruption:** Background discovery surfaces available or downloaded updates via a quiet, nonmodal status indicator and utility action on the workbench rather than intrusive modal prompts. Navigating through the notification opens Settings directly to Updates.
- **Linux verified handoff:** On platforms where in-place replacement is unsupported (Linux AppImage), the UI presents a "Show downloaded file" action and clear manual update instructions instead of an in-place install button, honoring the platform's execution model without executing unverified code.
### Settings, theming, and privacy

Settings is a sectioned dialog: a left rail names the sections (Account, Git, Appearance, Shortcuts, Privacy, Diagnostics) and the right pane shows one at a time. Every control is a two-way control, a single-value field, or a text input; there are no controls that store a value nothing reads.
At renderer widths of 760px or less, section navigation becomes a wrapping row above the selected section so preference controls retain the dialog's full usable width. Saving locks shortcut editing as well as ordinary fields; a policy or save lock ends shortcut recording rather than retaining an active key listener.

Every setting carries a sentence saying what it changes and who reads it. A setting that names an external program (editor, merge tool) shows whether that program exists on this computer at the point it is typed, so a missing tool is a fact on screen rather than a failure at use. A tool value is one program name: a value carrying a space, a quote, a path separator, or a control character is refused, because such a value would reach a process launcher as more than one argument. Only supported editor and merge tool identities are accepted; arbitrary interpreters (e.g. shells, script hosts) are refused by validation and cannot be launched. Launching an editor is constrained to canonical paths verified inside the repository root; symlinks escaping the repository are rejected before execution.
A setting that names the GitHub host is a host name, not a URL. A pasted `https://` URL is normalized down to the host name it names; a path, a query, a non-HTTPS scheme, or embedded credentials is refused and the previous value stands. The refused input is shown with the reason beside the field, the way an unaccepted program name is. The field names what is affected: CLI authentication status, repository discovery, and every request it makes. Changing the host retires in-flight reads and cached identity for the previous host; it does not log the user out of that host's provider CLI or delete its credentials.

A port is part of a host only when it is that kind of port: a web port is kept in requests, an SSH port never is, and the default HTTPS port is not written at all, because one host named two ways is two hosts. A host whose capability could not be established holds the work that depended on it rather than assuming the answer. A repository's own origin decides which host answers for it; nothing falls back to the default host. CLI authentication and account selection are host-specific, so one host's credential is never shown or sent to another. Changing the host abandons work already in flight against the old one instead of letting its answer land.

A link is handed to the operating system only when it is HTTPS, free of credentials, and served by `github.com`, the configured host, or the host owning an open repository's origin. Public GitHub links remain available when an enterprise host is selected. The comparison is the whole host, port included; look-alike suffixes, unconfigured ports, and other hosts are refused. Trust is never inferred from the link itself.

The host capability matrix names the host, the API base it answered on, the version it reported, and one line per capability. A capability the host answered about and does not serve reads as unsupported; a capability this build could not ask about — a missing CLI, missing or rejected authentication, an unreachable host, or an unanswered probe — reads as a distinct unanswered state carrying the reason. A working CLI login is not proof of native-stack or merge-queue support. A capability this build never probes on any host is `not applicable`. A host that has never been probed never borrows the default host's answers.

A control fixed by this computer's policy is disabled and shows the policy's reason beside it. A policy file that cannot be read or understood holds **every** managed setting at its current value and says why, rather than reading as "nothing is locked". Never present an unavailable setting as editable-but-ignored.

Theming is a token-level concern, never per-component styling. `tokens.css` emits a light block, a dark block, and a `system` block that follows the operating system in a media query, so `data-gs-theme` on the document root is the only place a theme is expressed. A theme token that no palette supplies must not be offered as a choice. Reduce motion has the same shape: the operating-system media query and the stored `data-motion` attribute are siblings, so a stored choice holds on a machine that did not ask for reduced motion.

The capability report states what was measured and what was not. Every line carries a status — confirmed, unavailable, or not applicable — and a line the app could not establish is shown as unavailable rather than filled in from what this build usually finds. A capability served by a network call is `not applicable` here, not `confirmed`.
Diagnostics reports the required CLI's own measured state and nothing inferred from it: there is no adapter preference to report, and no credential is read to infer one. CLI version detection uses one fixed, bounded local read, with no account, credential, host, or path query; unrecognized output is reported as unrecognized. A version probe establishes neither authentication nor access, and authentication with the account actually used is reported separately from it. The status surface reports the host-specific prerequisites and recovery guidance required by [Provider CLI authentication](#provider-cli-authentication), while local Git remains available.

A support bundle is assembled from named fields, never from a log that was filtered afterwards. The bundle preview shows each section, whether it is included, and why. Text that names a location on this machine is withheld until the user opts in, and the opt-in widens that one category only: access tokens, source contents, diffs, branch and pull-request text, and raw GitHub bodies are never collected, so no opt-in can reveal them. The support bundle export binds to the inspected preview and enforces live path consent immediately prior to writing: revoking path inclusion withholds local paths in the exported file even if consent was active when the export dialog opened.
Telemetry and crash reporting are stated as facts about the build, not as toggles. This build has no endpoint and sends nothing; presenting a checkbox for a setting with no effect would be an inert control. Privacy controls govern what the user chooses to write on this computer.

## Do's and Don'ts

Concrete guardrails for the existing system and the user-confirmed Quiet Workbench direction:

### Do:

- **Do** use neutral Workbench Ink for primary actions and text, with pastel microaccents and contrast-correct labelled semantic colors for small meaningful states.
- **Do** keep selection, checked-out state, pull-request lifecycle, checks, review, restacks, and diff additions/deletions/hunks independent and explicitly labelled.
- **Do** use the 4px spacing rhythm, 36/44px controls and generic 44/56px list rows, with the user-retained rounded 12/16/24px geometry and supported 999px pills. The v5 Branches composition uses its specific branch/trunk minimums: compact 76/64px and standard 92/76px; generic list-row sizes do not override those lane rules.
- **Do** use `semantic.border.essential` for essential boundaries, `semantic.focus.ring` for keyboard focus, and text/icon descriptions alongside every Git status.
- **Do** define primitive, semantic, and component tokens in `packages/ui/src/tokens/tokens.json`; treat `tokens.css` as generated output, never a second manually maintained palette.
- **Do** keep the renderer local-first, preserve the sandbox/preload/IPC/CSP boundary, and retain busy-state text when reduced motion removes animation.
- **Do** share production controls, typography and foundations through `@git-stacks/ui`; catalog specimens demonstrate this implementation rather than defining a second visual policy. Keep larger content typography distinct from compact application roles.
- **Do** keep essential boundaries at ≥3:1 against their adjacent surface in both themes; the dark essential-border primitive is `#657185` so shared editable controls retain this distinction.
- **Do** keep normal text and placeholders at ≥4.5:1 and large text at ≥3:1; use weights 400/500/600, left-aligned readable copy, and the compact 14px/1.5 body role.
- **Do** use simple Lucide icons consistently, add labels for ambiguous actions, place feedback near its field, and use progressive disclosure rather than repeated guidance or metadata.
- **Do** prioritize spacing and solid tonal contrast over borders for grouping; preserve essential editing, focus, and meaningful graphic boundaries instead of applying blanket border suppression.

### Don't:

- **Don't** globally replace `--accent` with ink; selection, links, checked-out state, and stack graphics remain Repository Blue, while merged pull requests remain violet.
- **Don't** use color alone for status, lifecycle, review, checks, unknown/unavailable data, or diff meaning.
- **Don't** use decorative `semantic.border.decorative` dividers as a substitute for essential control boundaries or meaningful graphics.
- **Don't** add external font loading, font files from chat artifacts, a second manually maintained palette, CRM runtime behavior, or new Git/IPC/navigation semantics.
- **Don't** add arbitrary shape overrides, excessive pills, decorative gradients, glass, sharp dramatic shadows, or gratuitous nested boxes. Preserve generous rounded cards and circular icon controls.
- **Don't** use ornamental scale, bounce, parallax, or excessive motion; purposeful state transitions use 100–250ms and preserve meaning with reduced motion.
- **Don't** use shadows or card offsets to imply Git state, invent metrics, or obscure operational controls. Purposeful secondary layering must preserve focus, scrolling, and action reachability.

## Styling constraints and exceptions

Legacy aliases may remain only for the existing consumers listed below and must resolve to the generated semantic palette. New consumers must use semantic/component names directly. Do not introduce a parallel palette or expand legacy alias usage.

| Alias                            | Exact consumers in `apps/desktop/src/renderer/src/styles.css` (unless noted)                                                                                                                                                                                                                                                                                                                                     |
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

### Provider CLI authentication

GitHub collaboration requires an installed and authenticated `gh`. The provider CLI owns login, credential storage, refresh, account switching, and logout. The desktop reports these prerequisites and their recovery instructions; it does not create a GitHub App registration, run its own device flow, persist provider credentials, or silently choose another authentication method.

Account and onboarding surfaces distinguish a missing executable, missing authentication, rejected credentials, insufficient permissions or organization authorization, an unreachable host, and an authenticated account. A version probe alone establishes no account or access. Status names the selected host and the account actually used, and remains sanitized: tokens, raw CLI output, credential-file contents, and personal credential paths never cross the preload boundary or enter diagnostics, logs, or support bundles.

A control that manages an external CLI account states that ownership and its effect on other programs. Merely closing a dialog, changing hosts, resetting settings, or removing a repository never logs the user out or modifies the provider's credential store. The app must not present an app-local Sign out as proof that the CLI session was revoked.

Provider commands are fixed, argument-based, host-scoped main-process operations with bounded output, deadlines, cancellation, and sender validation. No renderer input becomes shell text or arbitrary command execution. Installation and authentication are user actions, never an implicit subprocess launched by a metadata read.

Identity, host, and credential changes invalidate reads and caches from the previous authority before publishing new data. A late rejection belongs only to the credential that authenticated its request; it cannot invalidate a replacement account. A stale answer never lands under another account or host, and a refused or unanswered request never becomes an empty authenticated result.

Credential retirement drops submitted reconciliation reports and ancestry learned
from pull requests or native stacks; recorded and locally inferred parent hints
remain local facts. A repository open keeps its operation lock until main settles:
the window adopts the completed local repository identity even when its remote
answer was retired, so displayed and mutation-target repositories cannot diverge.

The separately authorized Notifications module retains its consent, credential isolation, and operating-system-backed encryption. Nothing this app does to its own authentication state deletes a Notifications credential, a provider CLI credential, or an unrelated operating-system key. Notifications never silently expands the permissions of the core CLI account.

Authentication checks stay outside the repository mutation gate. Missing CLI, signed-out accounts and stalled GitHub endpoints block only the remote action that needs them; local inspection, dependency management and operational recovery remain available.

#### Inbox metadata and identity boundaries

A read states which of its recent facts the host actually gave it. A host that
refuses the review, comment, and check fields answers a _degraded_ read, and a
degraded read may only place a pull request in the groups its own facts support:
review-requested, drafts, and recently merged. It may not claim a row is waiting,
approved, or needs a response, because those are decided from fields the host
never sent. The row says what it does not know — the check badge reads "unknown",
not "pending" and not "no checks" — rather than rendering an absence as a result.

A read that names no account at all is the same boundary from the other side. A
host can return pull requests without ever saying whose they are, and then
authorship and a request to the viewer are undecided rather than false: the
viewer-relative groups stay empty rather than being decided against a person the
read could not name, drafts and recently merged keep their rows, and the
repository is reported as read without knowing whose queue this is so the work
that stopped being listed has a stated reason. The missing account is stated
ahead of missing metadata, because it is the reason the rows are not being shown
as work.

Viewer-relative groups are decided against one viewer, and a read never mixes
two. One host is one credential: if a host reports two different logins across
its repositories, the read is retired rather than published. Two hosts are two
accounts, so their repositories aggregate normally, each repository report names
the login its rows were decided as, and the queue-level viewer is stated only
when every host agrees on it.

The rows on screen belong to one identity: the host this window reads for, the
account behind it, and the authority that host would authenticate with. Any one
of them changing retires the read in flight and drops what it produced, so a
refresh that fails afterwards keeps nothing from the credential it replaced.
That authority is whichever one the CLI itself resolves for the host — the
stored profile in its configuration or the CLI-native environment variable that
overrides it — and the app never chooses between them: asking which one is in
effect is exactly what the CLI's own status answers. It is reduced to an opaque
per-host nonce minted for that resolution, which holds across equivalent
re-reads and changes when the host, the account, or the authority behind them is
replaced. The nonce is a generation counter and nothing else: no credential
material is read into it, none is held even in the making, and no account or
authority name reaches the renderer, a log, or a file. Resolving the authority
and pinning it to that host's own requests happens privately in the main
process, behind this boundary. The host is part of that identity on its own, so
switching it retires the queue whether or not an account status has arrived to
say so.

One host names the requests, the credential asked of the CLI, the environment
the CLI's process runs with, and the allowance the answers are credited to, so
none of those four can disagree about which host this is. A host read from the
wrong place names the wrong credential, so that one host is decided once and the
four are never resolved apart from each other.

That host is the one the requests reach, which is not always the one that was
selected. A public host an operator has pointed at a provider of their own is
served by that provider's account and answered under that provider's name, so the
four are resolved for the destination and the selection is kept as the identity
the status belongs to: the window says which host it is reading for while the
account it names is the one whose requests those reads make. Asking the CLI
about the selected name instead would report a public session that serves none of
these requests — signed out, or signed in as somebody else — and would scope the
child to a credential those requests never carry.

Retirement also covers a read that is overtaken after it has taken its answer. The
answer cannot be recalled once its account is replaced, so a read that confirmed a
payload and lost that payload's account while it measured local work is discarded
and answered from local Git alone, which is everything the app can show without
the account; being overtaken again cancels the read rather than repeating it.

The registered repositories are part of it too. A repository added or removed
while a read is resolving its origins retires that read rather than letting it
answer against the list it started from.

Every response a host serves is recorded once, and that record names the host and
the credential the request carried, stamped with the moment the request left: a
response that arrives after a newer one describes an account that has left, and is
held back from the host's report, that account's record, the process-wide report,
and the listeners all at once. Nothing is recorded without those names, because a
record that names no host is process-wide by construction and cannot be held back
afterwards. That holds for every way this build can refuse an answer a host did
serve — a refusal carried in a status, a 304 with nothing stored to replay, a page
that is not a page — and for every way a request can end without an answer at all:
a child that dies, a deadline that passes, a caller that walks away. None of them is
evidence about what a host offers, and none of them records anything. A failure
names no host, has no credential and no moment of departure, so it cannot be
attributed and cannot be held back; that is why raising one is not a report at all,
and why the only place a report is written is where the response is read.

Which request an answer belongs to is the order requests left in, counted as each
one leaves — never a comparison of clocks, because a wall clock cannot order two
answers that landed inside the same millisecond, and two answers from one account
are exactly the ordinary case of it. Each host keeps the newest request whose
answer it has accepted, and that number only ever moves forward. An answer from
the account that is still current may always say what that account has left, and it
cannot lower the line: a replayed answer from that same account would otherwise
re-admit every answer the host has already given after it, including the one from
the account that replaced it. The one thing a late answer still fixes is a secondary
limit's wait: that refusal is the host refusing everyone at once, so it binds
whoever asks next, including the credential that replaced the one it arrived
under. A primary window is never a host-wide wait: it was measured against one
authenticated principal, so it is kept against that principal's allowance, and the
account that replaced it is admitted as it always was — while the account that hit
it still waits out its own `Retry-After`. An answer this build cannot use is not a
refusal at all, so it leaves no wait behind.

Each GitHub host meters and refuses on its own, so a host's queue is admitted
against what that host's own responses last reported. One host's remaining
allowance is never evidence about another, and a count is evidence only about
the window it belongs to: a report whose reset has passed is set aside however
recently it arrived and however much more it allows, and where another report
for that host still describes an open window, that one is what admission reads.
When two live reports describe the same instant, the one that admits less is
honoured. A host that answers "not now" is left alone until the moment it named —
a `Retry-After`, or the primary window's reset when the answer names no counter
at all — measured from the answer that carried it rather than from the start of
the read that met it, and kept even by a refresh that kept no rows. One account's
window lasts as long as the later of the two moments it named, because the shorter
one does not shorten the other; and a window with nothing left in it is not
spendable at all, whatever reserve this queue keeps, since a reserve of zero is an
absence of headroom rather than unlimited allowance. A secondary refusal is the one
refusal that spends nothing: it is the shared wait every account on that host
serves for as long as it names, and the count it carried is still each account's
own until then. The wait
belongs to the host, so a refusal an ordinary repository read met delays the
next refresh exactly as a refusal the queue met does; another host's wait is
never its own.

### Optional notification center

The optional Notifications inbox needs the `notifications` scope and remains a separately authorized module. It uses its own consent, sealed credential, host-pinned transport, and conditional cache; core CLI authentication is not implicit consent to access Notifications.

- **Nothing here widens core authentication.** With Notifications disabled the `gh` credential and its scopes are unchanged. No ambient CLI credential can silently serve this module. Removing the Notifications credential affects only that module, not the CLI account or pull request, stack, and review workflows.
- **Consent is stated before a token exists.** The surface that asks for a token names the credential kind, the scope, the host, and what leaving it behind means, and a value that arrives without that acknowledgement is refused rather than stored. The token crosses the bridge once, in the request, and is never returned to a listener, written to a file, logged, or included in a support bundle.
- **The host's poll interval is a floor, not a preference.** `Last-Modified` is stored and sent back verbatim, a 304 replays the whole list rather than the page the transport recorded, pages are followed only on the API origin this host owns, and no read — automatic or asked for by a person — runs before the interval GitHub named. A failure backs off from that same interval.
- **A stale list says so.** An unanswered question is never presented as a fresh one: the last confirmed list stays on screen with the reason it is no longer current, and a module that is off, held by policy, or without its credential reports no list at all.
- **A boundary moves on.** Replacing, removing, or forgetting a credential ends everything in flight and opens a new generation, and work started under the previous one publishes nothing, writes nothing, and never reaches the network. A stored list belongs to the host and account it was read for and is checked against both before it is shown.
- **A write is sent once.** Marking read and the subscription controls address only the endpoints GitHub documents, and an answer that never arrives is not resent: a second attempt could repeat a change GitHub already applied, so a failure leaves the list as it was and names what it could not do.

## Workbench source and operation contract

- Production compositions consume main-owned typed inventory snapshots, using stable repository/common-directory, worktree, qualified ref and host/repository/PR identities. Display names and paths are not join keys. Independent clones never share mutation authority merely because their remote matches.
- Fixture data belongs only to the separate renderer gallery/tests. The actual React consumer is reused there, not a static screenshot replica or second production route. Empty, partial, stale, failed, offline and capability-unavailable states preserve known facts and state what is not known. Unknown is never clean, passing, zero, safe, or permission to execute.
- Local and GitHub freshness remain independently observable. Common metadata and per-worktree updates are bounded and identity-fenced; selecting an item prioritizes reads without switching checkout. Late answers from retired repository/worktree/ref/host/account generations cannot replace current facts.
- Needs attention aggregates source-backed review feedback, failed checks, recovery and dependency blockers across repositories. Activity reports observed Git/PR events, not claimed agent liveness. Pull requests remains a separate list and full review surface with durable drafts; no-worktree review remains possible.
- Preview every mutation against exact directories, qualified refs/OIDs, published PR heads and complete backend-resolved affected scope. Revalidate at execution, preserve host permissions/rulesets, leases and recovery journals. UI readiness summaries never authorize bypassing those gates.
- Clean worktrees, timestamps, filesystem events and administrative worktree locks do not prove external inactivity. No implicit stash, checkout, repair, agent process surveillance or automatic replay of uncertain writes. Closing a dialog is not Abort; operations and recovery remain reachable after navigation.
- Review text and recovery evidence survive the replacement. Obsolete graph shell/routes/styles/listeners and superseded development UI are removed as their replacements land; no legacy-shell toggle, dual production route or migration wizard.
