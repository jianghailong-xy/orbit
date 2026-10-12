import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'menu-held-frames.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: '../../../../src/web/.choices-results/p2-menu-held-frames',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../../../src/web/.choices-results/p2-menu-held-frames/report.json', import.meta.url)) }]],
});
