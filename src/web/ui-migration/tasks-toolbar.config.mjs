import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

// The tasks toolbar's height against the bulk bar's (tasks-toolbar.browser.mjs) on the P0 production build, fixtures and
// environment, desktop viewports only: WebKit, whose 8px ::-webkit-scrollbar takes room, and Chromium, whose headless
// scrollbars take none. No screenshots, so only the environment check runs before the tests. TASKS_TOOLBAR_OUTPUT
// moves the results and TASKS_TOOLBAR_PORT the server, so two trees can run side by side; TASKS_TOOLBAR_RUNS (see the
// spec) sets how many fresh pages each case gets. See docs/evidence/base-ui-migration/tasks-toolbar-height.
const output = process.env.TASKS_TOOLBAR_OUTPUT || fileURLToPath(new URL('../.ui-migration-results/tasks-toolbar', import.meta.url));
const port = Number(process.env.TASKS_TOOLBAR_PORT || 4173);
export default defineConfig({
  ...baseline,
  testMatch: 'tasks-toolbar.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  projects: baseline.projects.filter((project) => project.name.endsWith('-desktop')),
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
