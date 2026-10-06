import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../../src/web/ui-migration/toasts.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'attention-link.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../../src/web/.toasts-results/r8-attention-link',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../../src/web/.toasts-results/r8-attention-link/report.json', import.meta.url)) }]],
});
