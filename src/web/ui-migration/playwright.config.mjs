import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  testDir: '.',
  // Deliberately outside Vitest's *.test.* / *.spec.* discovery.
  testMatch: '*.browser.mjs',
  // The development-only foundation fixture has its own server/configuration.
  testIgnore: ['foundation*.browser.mjs', 'controls*.browser.mjs', 'overlays*.browser.mjs', 'toasts*.browser.mjs'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0 } },
  updateSnapshots: 'none',
  snapshotPathTemplate: `${root}/docs/evidence/base-ui-migration/p0.2/screenshots/{projectName}/{arg}{ext}`,
  outputDir: '../.ui-migration-results',
  reporter: [['list'], ['json', { outputFile: `${root}/src/web/.ui-migration-results/report.json` }]],
  globalSetup: './environment.mjs',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'en-US', timezoneId: 'UTC',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: ['chromium', 'webkit'].flatMap((browserName) =>
    ['light', 'dark'].flatMap((colorScheme) =>
      ['desktop', 'phone'].map((size) => ({
        name: `${browserName}-${colorScheme}-${size}`,
        use: { browserName, colorScheme, viewport: size === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
          isMobile: size === 'phone', hasTouch: size === 'phone' },
      })))),
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
