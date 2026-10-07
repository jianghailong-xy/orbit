import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './entry-diagnostic.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'entry-synchronized.browser.mjs',
  grep: /legacy AntApp confirmation/,
  outputDir: '../../../../../src/web/.r7-entry-synchronized',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../../src/web/.r7-entry-synchronized/report.json', import.meta.url)) }]],
});
