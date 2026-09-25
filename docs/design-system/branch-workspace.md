# Design system — branch tree, stack workspace, branch inspector

Route: `#/design-system-branch-specimen` in the real renderer (production
`BranchTree`, `BranchInspector`, and `StackView` components; no repository, IPC, or
network needed).

## Fixtures

`src/renderer/src/design-system/branch-fixtures.ts` covers every accepted shape:

| Shape               | Fixture                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| Linear stack        | `feature/linear-base` → `feature/linear-child` (checked out)                  |
| Multiple children   | `feature/fan-base` → `feature/fan-a`, `feature/fan-b`                         |
| Deep nesting        | `main` → `deep-1` → `deep-2` → `deep-3` → `deep-4`, each level with a sibling |
| Missing parent      | `feature/orphan` → `feature/deleted-base` (absent)                            |
| Cycle               | `feature/cycle-a` ↔ `feature/cycle-b`                                         |
| Long names          | `feature/deliberately-long-branch-name-…` with a 91-character PR title        |
| Requires restack    | `feature/restack` (`needsRestack` and `parentBehind`)                         |
| Tracked remote      | `feature/tracked` with `upstream`/`upstreamRef` → one row                     |
| Untracked remote    | `feature/untracked` with no upstream config → one row                         |
| Same-name ambiguity | `feature/ambiguous` vs `upstream/feature/ambiguous`                           |
| Remote-only         | `origin/feature/remote-only`, `origin/main`                                   |
| Closed lifecycle    | PR #48 `CLOSED` with pending checks and no review decision                    |

## Evidence

| File                                                 | What it shows                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `branch-workspace-after-1440x940.png`                | Desktop branch tree, 23 rows, four connector lanes, inspector on `feature/linear-child`                                    |
| `branch-workspace-after-select-restack-1440x940.png` | Selecting `feature/restack` moves selection + inspector while the checked-out row keeps its `Current` badge                |
| `branch-workspace-after-remote-filter-1440x940.png`  | `Remote` filter lists all six remote refs, including the two represented by a local branch; the inspector keeps its branch |
| `branch-stacks-after-1440x940.png`                   | Stack workspace: root select, restack guidance, provenance, `Preview merge`, `Restack…`/`Publish stack…`                   |
| `branch-workspace-after-1000x700.png`                | Narrow window: two-line rows, full branch names, complete status lines, no horizontal overflow                             |

### Connector geometry

A connector lane is one continuous vertical line through the block of rows that draw
it, so a segment opens only at the top of a block and closes only at the parent node.
Adjacency is tested between neighbouring rows rather than subtree contiguity, because
the row order is an updated-time sort. Strokes and the node they point at share one
vertical reference (`--branch-anchor`), which moves to the first line of a row when
the narrow layout wraps it, so a two-line row cannot desynchronise them.

Measured in the rendered DOM at both 1440x940 and 1000x700, against the 23-row
fixture: 36 connector segments, 0 of which fail to reach a row edge, a worst-case
elbow-to-node-centre offset of 1px, and no horizontal document overflow.

## Preserved semantics

Selecting a row only selects it — checkout is the separate, disabled-while-current
`Switch to this branch` control in the inspector. `Remote` browsing stays complete and
complete-from-nothing stays local, so a represented remote row is browsable yet still
inspects its local branch. Ancestry is published as text (`aria-describedby`) so a
clipped or filtered parent stays announced. Provenance is labelled per member, so
inferred ancestry never reads as a confirmed link. `none` checks render as
"no checks reported" and an absent review decision renders as "no review decision
reported" in the inspector — neither borrows a passing or approving state.
