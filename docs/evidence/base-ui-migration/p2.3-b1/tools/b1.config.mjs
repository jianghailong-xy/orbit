import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P2.3 B1 diagnosis: the unchanged P0 configuration, harness and scenarios of the project tip,
// screenshots written to a scratch directory, preview server started in the tree under test.
const { B1_SNAPSHOTS: snapshots, B1_OUTPUT: output, B1_APP: app, B1_MATCH: match } = process.env;
if (!snapshots || !output || !app) throw new Error('Set B1_SNAPSHOTS, B1_OUTPUT and B1_APP');
export default defineConfig({
  ...baseline,
  testMatch: match || '*.browser.mjs',
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  webServer: { ...baseline.webServer, cwd: app },
});
