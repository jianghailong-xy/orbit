import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../../src/web/ui-migration/choices.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'select-keys.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../../src/web/.choices-results/r8-select-keys',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../../src/web/.choices-results/r8-select-keys/report.json', import.meta.url)) }]],
});
