import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expectedScreenshots } from './expected-screenshots.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export default defineConfig({
  testDir: '.',
  // Deliberately outside Vitest's *.test.* / *.spec.* discovery.
  testMatch: '*.browser.mjs',
  // The development-only foundation fixture has its own server/configuration.
  testIgnore: ['foundation*.browser.mjs', 'controls*.browser.mjs', 'overlays*.browser.mjs', 'choices*.browser.mjs', 'toasts*.browser.mjs', 'composer*.browser.mjs', 'pilot*.browser.mjs', 'p41*.browser.mjs', 'p42*.browser.mjs', 'p43a*.browser.mjs', 'p43b*.browser.mjs'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0 } },
  updateSnapshots: 'none',
  // P0.2 originals, or their registered main drift reference: see expected-screenshots.mjs.
  snapshotPathTemplate: `${expectedScreenshots}{projectName}/{arg}{ext}`,
  outputDir: '../.ui-migration-results',
  reporter: [['list'], ['json', { outputFile: `${root}/src/web/.ui-migration-results/report.json` }]],
  globalSetup: ['./environment.mjs', './expected-screenshots.mjs'],
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
