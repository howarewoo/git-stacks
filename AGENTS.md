# Repository instructions

This project follows woostack. At the start of work, use `using-woostack` to load the
project rules and route `/woostack-*` requests to the matching woostack skill.

Follow this file first when it conflicts with generic agent defaults.

Read [PRODUCT.md](PRODUCT.md) before changing product scope or workflows. Use
[README.md](README.md) for development, verification, and release procedures.

## Design documentation

- Keep all design rules in the root `DESIGN.md`; read it before changing the UI or design system and update it when those rules change.
- `DESIGN.md` must contain design rules only, not setup commands, testing instructions, test results, or execution records. Put development and testing instructions in the root `README.md`, and run-specific evidence in the associated pull request.
- Do not recreate a `docs/` directory or separate design guides.

## Development and verification

Run commands from the repository root. Use Node 24, npm, and the committed
`package-lock.json`, as the README and CI do.

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `npm ci`               | Install dependencies                   |
| `npm run dev`          | Run the Electron app                   |
| `npm run typecheck`    | Check application and test types       |
| `npm run build`        | Typecheck and build the production app |
| `npm test`             | Run the root TypeScript test suite     |
| `npm run format:check` | Check formatting                       |

Development, builds, and `npm test` compile the native clone-promotion helper;
provide a C compiler or set `CC`. `npm test` also provisions the pinned Git runtime
and may download it when absent.

- For renderer changes, follow [Renderer verification](README.md#renderer-verification):
  exercise the real components in the separate gallery and run the relevant
  `npm run test:ui` checks. Visual baselines are macOS-specific; review differences
  before updating them. Gallery dispatch proves renderer intent, not Git success.
- For preload, CSP, packaging, or local Git integration, use the
  [packaged desktop smoke](README.md#packaged-desktop-smoke); its Windows path is
  not supported. Keep manual assistive-technology evidence separate from automation.
- For performance changes, use [Performance budgets](README.md#performance-budgets)
  and `npm run bench:performance` after a build. Budget values belong in
  `src/shared/performance.ts`, not duplicated constants.

## Implementation boundaries

- Keep Git, filesystem, credentials, and GitHub transport in `src/main`.
  The React renderer uses the typed `DesktopAPI` in `src/shared/types.ts` through
  `src/preload/index.ts`; preserve sender validation, sandboxing, context
  isolation, and CSP.
- When changing `GitAction`, update the renderer fixture action messages in
  `tests/renderer/fixtures/control.ts` and affected payloads. The build typechecks
  these consumers. Keep fixture APIs out of the production renderer.
- Edit `src/renderer/src/design-system/tokens.json`, not generated `tokens.css`;
  run `npm run tokens:generate` and `npm run tokens:check` after token changes.
  Reuse the shared controls and token roles defined in `DESIGN.md`.
- Preserve captured-preview validation, confirmation gates, force-with-lease
  checks, and recovery journals when changing Git workflows. Use disposable
  repositories and the existing fixtures for verification, not personal
  repositories or live GitHub mutations.
