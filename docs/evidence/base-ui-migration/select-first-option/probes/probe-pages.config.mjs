import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// The page probe (probe-pages.browser.mjs, copied into src/web/ui-migration of the tree under test with this file; not
// part of the delivery) on the P0 production build, fixtures and environment, as p43a.config.mjs runs P4.3a's cases.
const output = process.env.PROBE_OUTPUT;
const port = Number(process.env.PROBE_PORT || 4531);
export default defineConfig({
  ...baseline,
  testMatch: 'probe-pages.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
