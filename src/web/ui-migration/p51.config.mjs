import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P5.1 states (p51.browser.mjs) on the P0 production build, fixtures and environment. Screenshots go to P51_SNAPSHOTS:
// a run of the same-commit reference tree writes them (--update-snapshots=all), a delivery run writes its own set, and
// the two are compared afterwards (see docs/evidence/base-ui-migration/p5.1). P51_PORT lets two trees serve side by
// side. The P0 expected screenshots are not read here, so only the environment check runs before the tests.
const snapshots = process.env.P51_SNAPSHOTS;
const output = process.env.P51_OUTPUT;
const port = Number(process.env.P51_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P51_SNAPSHOTS and P51_OUTPUT');
export default defineConfig({
  ...baseline,
  testMatch: 'p51*.browser.mjs',
  testIgnore: [],
  // Each case walks the session workspace, the heaviest page, several times; on a loaded host the baseline's 90s per
  // case is not enough.
  timeout: 240_000,
  globalSetup: ['./environment.mjs'],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
