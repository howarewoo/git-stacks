# Repository instructions

This project follows woostack. If `using-woostack` is available, use it at the
start of work to load the project rules. Route `/woostack-*` requests to the
matching woostack skill when available.

Follow this file first when it conflicts with generic agent defaults.

Read [PRODUCT.md](PRODUCT.md) before changing product scope or workflows. Use
[README.md](README.md) for development, verification, and release procedures.

## Design documentation

- Keep all design rules in the root `DESIGN.md`; read it before changing the UI or design system and update it when those rules change.
- `DESIGN.md` must contain design rules only, not setup commands, testing instructions, test results, or execution records. Put development and testing instructions in the root `README.md`, and run-specific evidence in the associated pull request.
- Do not recreate a `docs/` directory or separate design guides.

## Development and verification

Run commands from the repository root. Use Node 24, pnpm, and the committed
`pnpm-lock.yaml`, as the README and CI do.

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `pnpm install --frozen-lockfile`               | Install dependencies                   |
| `pnpm run dev`          | Run the Electron app                   |
| `pnpm run typecheck`    | Check application and test types       |
| `pnpm run build`        | Typecheck and build the production app |
| `pnpm test`             | Run the root TypeScript test suite     |
| `pnpm run format:check` | Check formatting                       |

Development, builds, and `pnpm test` compile the native clone-promotion helper;
provide a C compiler or set `CC`. `pnpm test` also provisions the pinned Git runtime
and may download it when absent.

- Renderer verification is suggested, not mandatory. Consider exercising the real
  components in the separate gallery and running relevant `pnpm run test:ui` checks
  as described in [Renderer verification](README.md#renderer-verification).
  Visual baselines are macOS-specific. Gallery dispatch proves renderer intent,
  not Git success.
- For preload, CSP, IPC sender validation, packaging, or local Git integration, use
  the [packaged desktop smoke](README.md#packaged-desktop-smoke); its Windows path
  is not supported. Keep manual assistive-technology evidence separate from automation.
- For performance changes, use [Performance budgets](README.md#performance-budgets)
  and `pnpm run bench:performance` after a build. Budget values belong in
  `packages/shared/src/performance.ts`, not duplicated constants.

## Implementation boundaries

- Keep Git, filesystem, credentials, and GitHub transport in `apps/desktop/src/main`.
  The React renderer uses the typed `DesktopAPI` in `@git-stacks/shared/types` through
  `apps/desktop/src/preload/index.ts`; preserve sender validation, sandboxing, context
  isolation, and CSP.
- GitHub collaboration requires provider-owned authentication through `gh`.
  Reuse the typed main-process transport; keep credentials out of the renderer,
  logs, and application state. Do not add app-owned GitHub App/device-flow
  authentication or disturb the separately authorized Notifications store.
  Follow [README's current-runtime guidance](README.md#current-runtime) until
  the #11 cutover lands.
- GitLab/`glab` is future direction only; do not add it to this cutover.
- When changing `GitAction`, update the renderer fixture action messages in
  `apps/desktop/tests/renderer/fixtures/control.ts` and affected payloads. The build typechecks
  these consumers. Keep fixture APIs out of the production renderer.
- Edit `apps/desktop/src/renderer/src/design-system/tokens.json`, not generated `tokens.css`;
  run `pnpm run tokens:generate` and `pnpm run tokens:check` after token changes.
  Reuse the shared controls and token roles defined in `DESIGN.md`.
- Preserve captured-preview validation, confirmation gates, force-with-lease
  checks, and recovery journals when changing Git workflows. Use disposable
  repositories and the existing fixtures for verification, not personal
  repositories or live GitHub mutations.
