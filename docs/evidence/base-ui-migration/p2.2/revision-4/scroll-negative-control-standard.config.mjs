import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import choices from '../../../../../src/web/ui-migration/choices.config.mjs';
export default defineConfig({
  ...choices,
  testDir: '.',
  testMatch: 'scroll-negative-control-standard.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: fileURLToPath(new URL('../../../../../src/web/.choices-results', import.meta.url)),
});
