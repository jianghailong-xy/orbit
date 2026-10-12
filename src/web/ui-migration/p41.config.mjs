import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P4.1 states (p41.browser.mjs) on the P0 production build, fixtures and environment. Screenshots go
// to P41_SNAPSHOTS: a run of the same-commit reference tree writes them (--update-snapshots=all), a
// delivery run writes its own set, and the two are compared afterwards (see
// docs/evidence/base-ui-migration/p4.1). P41_PORT lets two trees serve side by side.
const snapshots = process.env.P41_SNAPSHOTS;
const output = process.env.P41_OUTPUT;
const port = Number(process.env.P41_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P41_SNAPSHOTS and P41_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p41*.browser.mjs',
  testIgnore: [],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
