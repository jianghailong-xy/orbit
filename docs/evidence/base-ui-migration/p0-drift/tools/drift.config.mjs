import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P0 drift attribution: the unchanged P0.2 configuration and tests, with screenshots written to a
// scratch directory and the preview server started in the tree under test (DRIFT_APP = its src/web).
const { DRIFT_SNAPSHOTS: snapshots, DRIFT_OUTPUT: output, DRIFT_APP: app } = process.env;
if (!snapshots || !output || !app) throw new Error('Set DRIFT_SNAPSHOTS, DRIFT_OUTPUT and DRIFT_APP');
export default defineConfig({
  ...baseline,
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  webServer: { ...baseline.webServer, cwd: app },
});
