import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../../src/web/ui-migration/choices.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'select-keys-repeat.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../../src/web/.choices-results/r8-select-keys-repeat',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../../src/web/.choices-results/r8-select-keys-repeat/report.json', import.meta.url)) }]],
});
