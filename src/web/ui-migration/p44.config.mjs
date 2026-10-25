import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P4.4 states (p44.browser.mjs) on the P0 production build, fixtures and environment. Screenshots go
// to P44_SNAPSHOTS: a run of the same-commit reference tree writes them (--update-snapshots=all), a
// delivery run writes its own set, and the two are compared afterwards (see
// docs/evidence/base-ui-migration/p4.4). P44_PORT lets two trees serve side by side. The P0 expected
// screenshots are not read here, so only the environment check runs before the tests.
const snapshots = process.env.P44_SNAPSHOTS;
const output = process.env.P44_OUTPUT;
const port = Number(process.env.P44_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P44_SNAPSHOTS and P44_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p44*.browser.mjs',
  testIgnore: [],
  // Each case walks several pages (the watches case a task, its editor and the session workspace); on a loaded host
  // the baseline's 90s per case is not always enough.
  timeout: 180_000,
  globalSetup: ['./environment.mjs'],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
