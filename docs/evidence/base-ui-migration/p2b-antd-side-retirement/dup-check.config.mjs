import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

// The choices configuration (its dev server on 4177 and baseURL), with this probe and its own results.
const results = process.env.DUP_RESULTS ?? fileURLToPath(new URL('../../../../src/web/.choices-results/p2b-dup-check', import.meta.url));
export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'dup-check.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
