import { defineConfig } from '@playwright/test';

// Probes beside this file, on the choices configuration of the tree under test (TREE): its eight projects and its
// dev server; results in RESULTS. Exploration only.
const tree = process.env.TREE;
const results = process.env.RESULTS;
const { default: config } = await import(`${tree}/src/web/ui-migration/choices.config.mjs`);
export default defineConfig({
  ...config,
  testDir: '.',
  testMatch: process.env.PROBE_MATCH,
  testIgnore: [],
  globalSetup: `${tree}/src/web/ui-migration/environment.mjs`,
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
