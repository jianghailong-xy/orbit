import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P4.3b decision cards (p43b-cards.browser.mjs) on their own page, p43b-cards.html, which only the
// development server serves (it is not part of the production build). Same browsers, fonts and
// environment check as the P0 regression; screenshots go to P43B_SNAPSHOTS, so the same-commit
// reference tree writes one set and the delivery another, compared afterwards (see
// docs/evidence/base-ui-migration/p4.3b). P43B_PORT lets two trees serve side by side.
const snapshots = process.env.P43B_SNAPSHOTS;
const output = process.env.P43B_OUTPUT;
const port = Number(process.env.P43B_PORT || 4177);
if (!snapshots || !output) throw new Error('Set P43B_SNAPSHOTS and P43B_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p43b-cards.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, timeout: 60_000 },
});
