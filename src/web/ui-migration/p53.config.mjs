import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P5.3 states (p53.browser.mjs) on the P0 production build, fixtures and environment. Screenshots go to P53_SNAPSHOTS:
// a run of the same-commit reference tree writes them (--update-snapshots=all), a delivery run writes its own set, and
// the two are compared afterwards (see docs/evidence/base-ui-migration/p5.3). P53_PORT lets two trees serve side by
// side. The P0 expected screenshots are not read here, so only the environment check runs before the tests.
const snapshots = process.env.P53_SNAPSHOTS;
const output = process.env.P53_OUTPUT;
const port = Number(process.env.P53_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P53_SNAPSHOTS and P53_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p53*.browser.mjs',
  testIgnore: [],
  // A case walks the session workspace's menus and dialogs a dozen times, waiting out each one's motion; on a loaded host
  // the baseline's 90s per case is not enough.
  timeout: 240_000,
  globalSetup: ['./environment.mjs'],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
