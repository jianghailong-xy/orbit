import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P0 drift registration (batch 5): the unchanged P0 configuration, harness and scenarios of the runner's
// commit, screenshots written to a scratch directory, preview server started in the tree under test.
// Same as p0-drift-3/tools/p0d3.config.mjs.
const { P0D8_SNAPSHOTS: snapshots, P0D8_OUTPUT: output, P0D8_APP: app } = process.env;
if (!snapshots || !output || !app) throw new Error('Set P0D8_SNAPSHOTS, P0D8_OUTPUT and P0D8_APP');
export default defineConfig({
  ...baseline,
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  webServer: { ...baseline.webServer, cwd: app },
});
