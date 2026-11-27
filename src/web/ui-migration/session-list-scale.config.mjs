import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

// The windowed session column (session-list-scale.browser.mjs) on the P0 production build, fixtures and
// environment, in Chromium at the desktop and phone sizes (docs/session-list-scale-design.md §4). It takes no
// screenshots and compares no pixels, so the font and browser baseline check is not run before it.
// SESSION_LIST_SCALE_OUTPUT moves the results and
// SESSION_LIST_SCALE_PORT the server, so two trees can run side by side.
const output = process.env.SESSION_LIST_SCALE_OUTPUT || fileURLToPath(new URL('../.ui-migration-results/session-list-scale', import.meta.url));
const port = Number(process.env.SESSION_LIST_SCALE_PORT || 4173);
export default defineConfig({
  ...baseline,
  testMatch: 'session-list-scale.browser.mjs',
  testIgnore: [],
  timeout: 180_000,
  globalSetup: [],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  projects: baseline.projects.filter((project) => project.name.startsWith('chromium-light-')),
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
