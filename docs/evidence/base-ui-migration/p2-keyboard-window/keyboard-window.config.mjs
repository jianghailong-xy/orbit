import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'keyboard-window.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../src/web/.choices-results/p2-keyboard-window',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../src/web/.choices-results/p2-keyboard-window/report.json', import.meta.url)) }]],
});
