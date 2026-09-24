# Git Stacks design contract

Git Stacks uses a quiet, cool-gray desktop workbench: white work surfaces carry repository
information while ink-colored actions and restrained blue selection keep navigation and focus
predictable. The visual direction is adapted from the [Journey CRM Dashboard reference by
Jack R. / RonDesignLab](https://dribbble.com/shots/24659454-Customer-Journey-CRM-Dashboard).
Journey is a reference for material, contrast, and hierarchy only; Git Stacks remains a local-first
Git and GitHub workbench. It does not introduce CRM stages, analytics cards, or a web client.

## Source of truth

`src/renderer/src/design-system/tokens.json` is the only editable palette and token source. The
Node script `src/renderer/src/design-system/generate-tokens.mjs` resolves every reference, fails on
missing references or cycles, and writes `tokens.css` deterministically. Run:

```sh
npm run tokens:generate
npm run tokens:check
```

`tokens.css` is generated output and is imported by the renderer stylesheet. Do not edit it by hand.
The source has four layers:

- **Primitive:** raw colors, type families, spacing, radii, shadows, motion, density, and z-index values.
- **Semantic:** product meanings such as canvas, primary action, selection, focus, feedback, and diff.
- **Component:** stable meanings for buttons, fields, badges, selected rows, Git roles, and overlays.
- **Legacy:** temporary aliases consumed by views while they migrate to semantic/component variables.

## Baseline tokens

| Role                           | Value                 | Notes                                           |
| ------------------------------ | --------------------- | ----------------------------------------------- |
| Workspace canvas               | `#e8ecf3`             | Cool-gray application backdrop                  |
| Content / inset surface        | `#ffffff` / `#f2f4f8` | Rounded work surfaces and quiet grouping        |
| Primary text / action          | `#171c24`             | Primary action, navigation, and emphasis        |
| Primary action hover / pressed | `#2a3340` / `#11151b` | Separate interaction states                     |
| Secondary readable text        | `#536176`             | Muted metadata remains readable                 |
| Decorative / essential border  | `#d7dde7` / `#7c879a` | Essential boundaries use the stronger value     |
| Selection background / border  | `#edf2fc` / `#3155a6` | Selection is independent from checked-out state |
| Focus ring                     | `#355bc5`             | Keyboard focus is always visible                |
| Info                           | `#dfe8fc` / `#3155a6` | Background / text                               |
| Success                        | `#dceee3` / `#276449` | Background / text                               |
| Warning                        | `#f4e3b9` / `#865b13` | Background / text                               |
| Error                          | `#f9dfdf` / `#9d3d43` | Background / text                               |
| Merged PR                      | `#e4dff5` / `#635097` | Git Stacks adaptation of Journey violet         |

The editable source also defines the 14px body, 13px label, 12px metadata scale; 4px spacing
rhythm; 12px controls, 16px nested items, 24px work surfaces, and pill radii; 36/44px compact and
standard controls; 44/56px compact and comfortable rows; 120/180/240ms motion; and named shell,
content, floating, overlay, and popover z-index layers. System sans and monospace stacks are used,
with local `Inter` preferred only when installed. No external font is loaded.

## Role and state rules

Consumers must use the role that describes the meaning, not a raw palette value. Primary actions use
`semantic.action.primary` (ink); links, selection, and current-branch badges use the blue selection
roles. Merged pull requests use the violet merged role. `--accent` is a migration-only alias and is
not a global ink replacement.

Git states are intentionally independent and always require a text label or icon description:

| State                               | Role contract                      | Required presentation                                |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| Checked out                         | `component.git.checked-out-*`      | Branch identity plus “Current” label/icon            |
| Selected row                        | `component.row.selected-*`         | Selection background/border plus selected label      |
| PR open / merged / closed           | `component.git.pr-*-text`          | Lifecycle text, icon, and optional metadata          |
| Checks passing / failing / unknown  | `component.git.checks-*-text`      | Text label and status icon; unknown is not passing   |
| Review approved / changes / unknown | `component.git.review-*-text`      | Decision text and icon; unavailable stays unknown    |
| Requires restack                    | `component.git.requires-restack-*` | Warning surface and explicit “Restack required” text |
| Diff addition / deletion / hunk     | `component.diff.*`                 | Prefix, text, and surface; never color alone         |

Unknown or unavailable GitHub data uses the neutral unknown roles and an explicit unavailable label.
It must not be represented as zero, none, or successful.

## Contrast evidence

Contrast ratios were calculated from the sRGB values in `tokens.json` using the WCAG relative
luminance formula. Normal text uses a 4.5:1 target; essential control boundaries and meaningful
graphics use 3:1. Decorative dividers are documented separately and are not a substitute for an
essential boundary.

| Pair                                              | Ratio / target      | Result                                  |
| ------------------------------------------------- | ------------------- | --------------------------------------- |
| Primary `#171c24` on content `#ffffff`            | 17.10:1 / 4.5       | Pass                                    |
| Primary `#171c24` on inset `#f2f4f8`              | 15.53:1 / 4.5       | Pass                                    |
| Secondary `#536176` on content `#ffffff`          | 6.29:1 / 4.5        | Pass                                    |
| Secondary `#536176` on canvas `#e8ecf3`           | 5.31:1 / 4.5        | Pass                                    |
| Link / selection `#3155a6` on content             | 7.05:1 / 4.5        | Pass                                    |
| Link / selection `#3155a6` on selection `#edf2fc` | 6.28:1 / 4.5        | Pass                                    |
| Info `#3155a6` on info `#dfe8fc`                  | 5.73:1 / 4.5        | Pass                                    |
| Success `#276449` on success `#dceee3`            | 5.78:1 / 4.5        | Pass                                    |
| Warning `#865b13` on warning `#f4e3b9`            | 4.70:1 / 4.5        | Pass                                    |
| Error `#9d3d43` on error `#f9dfdf`                | 5.23:1 / 4.5        | Pass                                    |
| Merged PR `#635097` on merged `#e4dff5`           | 5.18:1 / 4.5        | Pass                                    |
| Essential border `#7c879a` on content             | 3.63:1 / 3          | Pass                                    |
| Essential border `#7c879a` on canvas              | 3.06:1 / 3          | Pass                                    |
| Focus `#355bc5` on content / selection            | 6.08:1 / 5.42:1 / 3 | Pass                                    |
| Primary hover `#2a3340` with white text           | 12.76:1 / 4.5       | Pass                                    |
| Primary pressed `#11151b` with white text         | 18.31:1 / 4.5       | Pass                                    |
| Diff hunk `#3155a6` on inset `#f2f4f8`            | 6.40:1 / 4.5        | Pass                                    |
| Primary `#171c24` on row hover `#e1e6ef`          | 13.65:1 / 4.5       | Pass                                    |
| Secondary `#536176` on row hover `#e1e6ef`        | 5.02:1 / 4.5        | Pass                                    |
| Decorative divider `#d7dde7` on content           | 1.36:1 / decorative | Allowed only for non-essential dividers |

## Motion and density

Use motion tokens for small state transitions; motion is never the only feedback. The generated
reduced-motion media query maps fast, standard, and deliberate motion to the reduced token. Busy
states retain their status text, busy lock, and progress icon when animation is removed. Compact
density is appropriate for dense branch, PR, stash, history, and diff rows; standard density is the
default for forms and primary work surfaces.

## Legacy migration map

The generated legacy aliases are temporary and are intentionally limited to the existing variable
names. The removal owner is the migration issue that updates each consumer:

| Legacy alias                                                    | Temporary semantic target                     | Removal owner                                   |
| --------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `--canvas`, `--surface`, `--surface-muted`, `--surface-hover`   | `semantic.surface.*`                          | Issue #5 shell/navigation migration             |
| `--ink`, `--ink-soft`, `--ink-muted`                            | `semantic.text.*`                             | Issue #4 shared controls and #5 shell migration |
| `--line`, `--line-strong`                                       | `semantic.border.*`                           | Issue #4 shared controls                        |
| `--accent`, `--accent-strong`, `--accent-line`, `--accent-wash` | selection/link roles, then Git role           | Issue #6 branch/stack migration                 |
| `--ring`, `--ring-soft`                                         | `semantic.focus.*`                            | Issue #4 shared controls                        |
| status aliases                                                  | `semantic.feedback.*` and component Git roles | Issues #6–#8 by consumer                        |

Consumers should move from legacy aliases to the component role as their surface is migrated. The
mapping rule is deliberately not a global `--accent` to ink replacement: links and selection remain
blue, current branch and PR lifecycle remain independent, and merged PRs remain violet.

## Tailwind and renderer specimen

The generated `@theme inline` block exposes semantic color, font, type, radius, spacing, and shadow
utilities to the installed Tailwind v4 build. Existing components can therefore consume
`var(--gs-component-*)` or the equivalent semantic utility without importing a second palette.
`src/renderer/src/design-system/FoundationsSpecimen.tsx` is an opt-in real-renderer route
(`#/design-system-specimen`) showing a primary action, field, badges, selected row, and diff excerpt.
It uses semantic/component CSS variables, has a keyboard-focusable action and field, and renders
without desktop IPC or network access. The route does not alter the normal six-view navigation.
