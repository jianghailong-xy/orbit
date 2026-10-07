import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// Flake runs: the P0 configuration with screenshots written to a scratch directory (so only
// locators, fixtures and page errors can fail) and the preview server started in DRIFT_APP.
const { DRIFT_SNAPSHOTS: snapshots, DRIFT_OUTPUT: output, DRIFT_APP: app } = process.env;
if (!snapshots || !output || !app) throw new Error('Set DRIFT_SNAPSHOTS, DRIFT_OUTPUT and DRIFT_APP');
export default defineConfig({
  ...baseline,
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['dot'], ['json', { outputFile: `${output}/report.json` }]],
  webServer: { ...baseline.webServer, cwd: app },
});
