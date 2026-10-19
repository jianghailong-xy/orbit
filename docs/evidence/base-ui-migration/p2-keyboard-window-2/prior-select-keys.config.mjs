import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import prior from '../p2-select-keys/select-keys-burst.config.mjs';

// The Select fix's own burst probe (p2-select-keys, unchanged), with its results in KW2_RESULTS.
const results = process.env.KW2_RESULTS;
export default defineConfig({
  ...prior,
  testDir: fileURLToPath(new URL('../p2-select-keys', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
