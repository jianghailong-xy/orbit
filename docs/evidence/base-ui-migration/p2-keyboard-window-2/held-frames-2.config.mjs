import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

// The choices configuration (its dev server also serves the overlay fixture) on all eight projects, with this probe.
const results = process.env.KW2_RESULTS ?? fileURLToPath(new URL('../../../../src/web/.choices-results/p2-held-frames-2', import.meta.url));
export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'held-frames-2.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
