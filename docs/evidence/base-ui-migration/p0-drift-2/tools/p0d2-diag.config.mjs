import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// p0d2.config.mjs with the test match of the B1 state diagnosis (p2.3-b1/tools/b1.config.mjs): the
// unchanged P0 harness and scenarios, b1-state.diag.mjs recording the notification's geometry right
// after each notification screenshot, screenshots written to a scratch directory.
const { P0D2_SNAPSHOTS: snapshots, P0D2_OUTPUT: output, P0D2_APP: app } = process.env;
if (!snapshots || !output || !app) throw new Error('Set P0D2_SNAPSHOTS, P0D2_OUTPUT and P0D2_APP');
export default defineConfig({
  ...baseline,
  testMatch: 'b1-state.diag.mjs',
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  webServer: { ...baseline.webServer, cwd: app },
});
