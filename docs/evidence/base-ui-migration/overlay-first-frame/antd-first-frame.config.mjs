import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../../src/web/ui-migration/choices.config.mjs';

// The choices configuration, eight projects, with this probe and its own results (FIRST_FRAME_RESULTS).
const results = process.env.FIRST_FRAME_RESULTS ?? fileURLToPath(new URL('../../../../src/web/.choices-results/antd-first-frame', import.meta.url));
export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: 'antd-first-frame.browser.mjs',
  globalSetup: fileURLToPath(new URL('../../../../src/web/ui-migration/environment.mjs', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
