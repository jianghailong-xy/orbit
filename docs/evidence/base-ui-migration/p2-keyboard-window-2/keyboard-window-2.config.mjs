import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

// The choices configuration (its dev server also serves the overlay fixture), with this probe and its own results.
const results = process.env.KW2_RESULTS ?? fileURLToPath(new URL('../../../../src/web/.choices-results/p2-keyboard-window-2', import.meta.url));
export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'keyboard-window-2.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
