import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../../src/web/ui-migration/toasts.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'entry-original.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../../src/web/.r7-entry-diagnostics',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../../src/web/.r7-entry-diagnostics/report.json', import.meta.url)) }]],
  use: { ...baseline.use, trace: 'on' },
});
