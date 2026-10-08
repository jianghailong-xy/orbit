import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P3.1 same-commit comparison: the P0 page matrix, with its screenshots read from (or, for the
// reference tree only, written to) P31_SNAPSHOTS instead of the immutable P0.2 baseline. Copy into
// src/web/ui-migration/ of the tree under test; everything else is the P0 configuration.
const snapshots = process.env.P31_SNAPSHOTS;
const output = process.env.P31_OUTPUT;
if (!snapshots || !output) throw new Error('Set P31_SNAPSHOTS and P31_OUTPUT');
export default defineConfig({
  ...baseline,
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
});
