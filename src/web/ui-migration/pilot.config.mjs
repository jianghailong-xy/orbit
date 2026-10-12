import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P3.2 pilot states (pilot.browser.mjs) on the P0 production build, fixtures and environment.
// Screenshots go to P32_SNAPSHOTS: a run of the same-commit reference tree writes them
// (--update-snapshots=all), a delivery run writes its own set, and the two are compared afterwards
// (see docs/evidence/base-ui-migration/p3.2). P32_PORT lets two trees serve side by side.
const snapshots = process.env.P32_SNAPSHOTS;
const output = process.env.P32_OUTPUT;
const port = Number(process.env.P32_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P32_SNAPSHOTS and P32_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'pilot*.browser.mjs',
  testIgnore: [],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
