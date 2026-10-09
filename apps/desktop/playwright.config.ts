import { defineConfig, devices } from '@playwright/test'

// Overridable so parallel worktrees never share (or fight over) one gallery
// server: `GALLERY_PORT=5236 npx playwright test`. `TEST_PORT` is what the
// repository's own tooling sets, and `PLAYWRIGHT_PORT` lets a second browser
// run coexist with an already-running server.
const PORT = Number(
  process.env.GALLERY_PORT ?? process.env.TEST_PORT ?? process.env.PLAYWRIGHT_PORT ?? 5224,
)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'tests/renderer',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/renderer',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      maxDiffPixels: 0,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Determinism: fixed locale/timezone so relative dates and number formatting
    // in the real components cannot drift between runs.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    // Animations are disabled for stable pixels; the reduced-motion behaviour
    // itself is asserted explicitly in `motion-and-zoom.spec.ts`.
    reducedMotion: 'reduce',
    launchOptions: {
      args: [
        '--font-render-hinting=none',
        '--disable-lcd-text',
        '--force-color-profile=srgb',
        '--disable-partial-raster',
        '--disable-skia-runtime-opts',
      ],
    },
  },
  projects: [{ name: 'chromium-darwin', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite --config tests/renderer/vite.config.ts --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
