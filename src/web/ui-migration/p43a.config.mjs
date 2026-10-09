import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P4.3a states (p43a.browser.mjs) on the P0 production build, fixtures and environment. Screenshots go
// to P43A_SNAPSHOTS: a run of the same-commit reference tree writes them (--update-snapshots=all), a
// delivery run writes its own set, and the two are compared afterwards (see
// docs/evidence/base-ui-migration/p4.3a). P43A_PORT lets two trees serve side by side. The P0 expected
// screenshots are not read here, so only the environment check runs before the tests.
const snapshots = process.env.P43A_SNAPSHOTS;
const output = process.env.P43A_OUTPUT;
const port = Number(process.env.P43A_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P43A_SNAPSHOTS and P43A_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p43a*.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
